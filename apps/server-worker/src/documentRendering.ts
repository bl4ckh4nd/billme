import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import {
  attachRenderedDocument,
  claimQueuedDocumentDeliveries,
  updateDocumentDelivery,
  type DocumentDeliveryJob,
} from '@billme/server-data';
import type { Pool } from 'pg';

export type DocumentRenderEnvironment = {
  apiUrl: string;
  webUrl: string;
  webProUrl: string;
  renderSecret: string;
  storageRoot: string;
  chromiumPath?: string;
};

const createRenderSession = async (job: DocumentDeliveryJob, env: DocumentRenderEnvironment) => {
  const response = await fetch(`${env.apiUrl.replace(/\/+$/, '')}/api/v1/internal/render-session`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-billme-render-secret': env.renderSecret,
    },
    body: JSON.stringify({
      deliveryId: job.id,
      tenantId: job.tenantId,
      userId: job.userId,
      product: job.product,
      documentType: job.documentType,
      documentId: job.documentId,
    }),
  });
  const payload = await response.json().catch(() => null) as { token?: string; user?: unknown; message?: string } | null;
  if (!response.ok || !payload?.token || !payload.user) {
    throw new Error(payload?.message || `Render session failed with ${response.status}`);
  }
  return { token: payload.token, user: payload.user };
};

const renderDocument = async (job: DocumentDeliveryJob, env: DocumentRenderEnvironment): Promise<string> => {
  const session = await createRenderSession(job, env);
  const browser = await chromium.launch({
    headless: true,
    executablePath: env.chromiumPath,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const sessionKey = job.product === 'pro' ? 'billme.web-pro.session.v1' : 'billme.web.lite.session.v1';
    await page.addInitScript(({ key, storedSession, apiUrl }) => {
      const browserGlobal = globalThis as unknown as {
        localStorage: { setItem(name: string, value: string): void };
        billmeRuntimeConfig?: { serverApiUrl?: string };
      };
      browserGlobal.localStorage.setItem(key, JSON.stringify(storedSession));
      browserGlobal.billmeRuntimeConfig = {
        serverApiUrl: apiUrl,
      };
    }, { key: sessionKey, storedSession: session, apiUrl: env.apiUrl });
    const base = job.product === 'pro' ? env.webProUrl : env.webUrl;
    const url = new URL(base);
    url.searchParams.set('__print', '1');
    url.searchParams.set('__autoprint', '0');
    url.searchParams.set('kind', job.documentType);
    url.searchParams.set('id', job.documentId);
    await page.goto(url.toString(), { waitUntil: 'networkidle', timeout: 60_000 });
    await page.waitForFunction(() => (globalThis as { __PDF_READY__?: boolean }).__PDF_READY__ === true, undefined, {
      timeout: 30_000,
    });
    const pdf = await page.pdf({ format: 'A4', printBackground: true, preferCSSPageSize: true });
    const storageKey = join(job.tenantId, 'generated', `${job.id}.pdf`);
    await mkdir(join(env.storageRoot, job.tenantId, 'generated'), { recursive: true });
    await writeFile(join(env.storageRoot, storageKey), pdf);
    return storageKey;
  } finally {
    await browser.close();
  }
};

export const processDocumentRenderBatch = async (
  pool: Pool,
  env: DocumentRenderEnvironment,
  log: (message: string, details?: Record<string, unknown>) => void,
): Promise<{ rendered: number; failed: number }> => {
  const jobs = await claimQueuedDocumentDeliveries(pool, 3);
  let rendered = 0;
  let failed = 0;
  for (const job of jobs) {
    try {
      const storageKey = await renderDocument(job, env);
      await attachRenderedDocument(pool, job, storageKey);
      rendered += 1;
      log('Document render completed', { deliveryId: job.id, documentId: job.documentId, tenantId: job.tenantId });
    } catch (error) {
      failed += 1;
      const code = error instanceof Error ? error.message.slice(0, 160) : 'RENDER_FAILED';
      await updateDocumentDelivery(pool, job.tenantId, job.id, {
        status: job.attemptCount < 3 ? 'queued' : 'failed',
        errorCode: code,
      });
      log('Document render failed', { deliveryId: job.id, documentId: job.documentId, tenantId: job.tenantId, error: code });
    }
  }
  return { rendered, failed };
};
