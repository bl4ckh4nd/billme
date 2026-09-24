import { BrowserWindow, type WebContents } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const appDir = path.dirname(fileURLToPath(import.meta.url));

const ensureDir = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
};

const sanitizeFilePart = (value: string) => {
  return value
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
};

// Hidden print windows render the document through the same embedded backend as the
// main window, so the embedded-connection handler must trust them while they exist.
const printWebContents = new Set<WebContents>();

export const isPdfPrintWebContents = (sender: unknown): boolean =>
  printWebContents.has(sender as WebContents);

const waitForPdfReady = async (win: BrowserWindow, timeoutMs: number) => {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const state = await win.webContents.executeJavaScript(
      '({ ready: globalThis.__PDF_READY__ === true, error: typeof globalThis.__PDF_ERROR__ === "string" ? globalThis.__PDF_ERROR__ : null })',
      true,
    );
    if (state.ready) return;
    if (state.error) throw new Error(state.error);
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for PDF render readiness');
    await new Promise((r) => setTimeout(r, 75));
  }
};

const renderPdf = async (query: Record<string, string>, timeoutMs: number): Promise<Uint8Array> => {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(appDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  const contents = win.webContents;
  printWebContents.add(contents);

  try {
    const devServerUrl = process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL;
    if (devServerUrl) {
      const url = new URL(devServerUrl);
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
      await win.loadURL(url.toString());
    } else {
      await win.loadFile(path.join(appDir, '../renderer/index.html'), { query });
    }

    await waitForPdfReady(win, timeoutMs);

    const buffer = await contents.printToPDF({
      pageSize: 'A4',
      landscape: false,
      printBackground: true,
      marginsType: 0,
    });
    return new Uint8Array(buffer);
  } finally {
    printWebContents.delete(contents);
    try {
      win.destroy();
    } catch {
      // ignore
    }
  }
};

export const exportPdf = async (params: {
  kind: 'invoice' | 'offer';
  id: string;
  suggestedName: string;
  userDataPath: string;
}): Promise<{ path: string; bytes: Uint8Array }> => {
  const exportsDir = path.join(params.userDataPath, 'exports');
  ensureDir(exportsDir);

  const fileName = `${sanitizeFilePart(params.suggestedName || `${params.kind}-${params.id}`)}.pdf`;
  const destPath = path.join(exportsDir, fileName);

  const bytes = await renderPdf({ __print: '1', kind: params.kind, id: params.id }, 15_000);
  fs.writeFileSync(destPath, bytes);

  return { path: destPath, bytes };
};

export const exportEurPdf = async (params: {
  taxYear: number;
  from?: string;
  to?: string;
  userDataPath: string;
}): Promise<{ path: string }> => {
  const exportsDir = path.join(params.userDataPath, 'exports');
  ensureDir(exportsDir);

  const fileName = `${sanitizeFilePart(`anlage-euer-${params.taxYear}`)}.pdf`;
  const destPath = path.join(exportsDir, fileName);

  const query: Record<string, string> = {
    __print: '1',
    kind: 'eur',
    taxYear: String(params.taxYear),
  };
  if (params.from) query.from = params.from;
  if (params.to) query.to = params.to;

  fs.writeFileSync(destPath, await renderPdf(query, 20_000));

  return { path: destPath };
};
