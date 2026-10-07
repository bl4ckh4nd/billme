import { chromium } from 'playwright-core';
import { createDocumentExportPreparer } from '@billme/desktop-services/documentExport';
import type { BuildServerApiOptions } from '@billme/server-runtime';

type PdfRenderer = NonNullable<BuildServerApiOptions['renderDocumentPdf']>;

// Must match `sessionStorageKey` / `apiUrlStorageKey` in apps/web/src/App.tsx and apps/web-pro/src/App.tsx.
const SHELL_STORAGE = {
  lite: { session: 'billme.web.lite.session.v1', apiUrl: 'billme.web.lite.api-url.v1' },
  pro: { session: 'billme.web-pro.session.v1', apiUrl: 'billme.web-pro.api-url.v1' },
} as const;

const RENDER_TIMEOUT_MS = 20_000;

/**
 * PDFs for the hosted server. A document is laid out by the web app, so the
 * server prints it the way the desktop does: a headless Chromium opens the web
 * app's print view (`?__print=1`) as the requesting user and prints the page.
 * Invoices with e-invoicing enabled get the same ZUGFeRD attachment as on desktop.
 *
 * Returns undefined when no web app URL is configured; the route then answers 501.
 */
export const createPdfRenderer = (env: NodeJS.ProcessEnv): PdfRenderer | undefined => {
  const webUrls = {
    lite: env.BILLME_PRINT_WEB_URL?.trim() || env.BILLME_PUBLIC_WEB_URL?.trim(),
    pro: env.BILLME_PRINT_WEB_PRO_URL?.trim() || env.BILLME_PUBLIC_WEB_PRO_URL?.trim(),
  };
  if (!webUrls.lite && !webUrls.pro) return undefined;
  // The browser runs next to this process, so it reaches the API on loopback unless told otherwise.
  const apiUrl = (env.BILLME_PRINT_API_URL?.trim() || `http://127.0.0.1:${env.PORT ?? 3100}`).replace(/\/+$/, '');

  const render: PdfRenderer = async ({ product, print, token, user }) => {
    const webUrl = webUrls[product]?.replace(/\/+$/, '');
    if (!webUrl) throw new Error(`No web app URL is configured for ${product} PDFs.`);

    // Same file name and e-invoice step as the desktop export; the EÜR form has neither.
    const prepared = print.kind === 'eur'
      ? { suggestedName: `anlage-euer-${print.taxYear}`, finalize: undefined }
      : await createDocumentExportPreparer({
        product,
        auth: 'bearer',
        resolveConnection: () => ({ baseUrl: apiUrl, token }),
      })(print.kind, print.id, print.level);

    const browser = await chromium.launch({
      executablePath: env.BILLME_CHROMIUM_PATH?.trim() || undefined,
      // Chromium's own sandbox needs privileges a container usually lacks; the image opts out explicitly.
      args: env.BILLME_CHROMIUM_NO_SANDBOX === '1' ? ['--no-sandbox'] : [],
    });
    try {
      const page = await browser.newPage();
      // The document may reference a logo by URL. Only the web app and the API are fetched, so a
      // crafted document cannot make the server request internal addresses.
      const allowedOrigins = new Set([new URL(webUrl).origin, new URL(apiUrl).origin]);
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return url.protocol === 'data:' || url.protocol === 'blob:' || allowedOrigins.has(url.origin)
          ? route.continue()
          : route.abort();
      });
      await page.addInitScript(({ keys, session, api }) => {
        localStorage.setItem(keys.apiUrl, api);
        localStorage.setItem(keys.session, JSON.stringify(session));
        // The print view calls print() once it is ready; here the page is printed from outside.
        (globalThis as { print?: () => void }).print = () => undefined;
      }, { keys: SHELL_STORAGE[product], session: { token, user, apiUrl }, api: apiUrl });

      const query = new URLSearchParams({ __print: '1' });
      for (const [key, value] of Object.entries(print)) {
        if (value !== undefined) query.set(key, String(value));
      }
      await page.goto(`${webUrl}/?${query}`);
      await page.waitForFunction(
        () => (globalThis as { __PDF_READY__?: boolean }).__PDF_READY__ === true
          || typeof (globalThis as { __PDF_ERROR__?: unknown }).__PDF_ERROR__ === 'string',
        undefined,
        { timeout: RENDER_TIMEOUT_MS },
      );
      const error = await page.evaluate(() => (globalThis as { __PDF_ERROR__?: string }).__PDF_ERROR__);
      if (error) throw new Error(error);

      const printed = new Uint8Array(await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true }));
      return {
        bytes: prepared.finalize ? await prepared.finalize(printed) : printed,
        fileName: `${prepared.suggestedName.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')}.pdf`,
      };
    } finally {
      await browser.close();
    }
  };

  // ponytail: one browser per PDF, one PDF at a time. Keep a browser warm and add a pool if PDF volume grows.
  let queue: Promise<unknown> = Promise.resolve();
  return (args) => {
    const result = queue.then(() => render(args));
    queue = result.catch(() => undefined);
    return result;
  };
};
