import { BrowserWindow } from 'electron';
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

const waitForPdfReady = async (win: BrowserWindow, timeoutMs: number) => {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const ready = await win.webContents.executeJavaScript('Boolean(globalThis.__PDF_READY__ === true)', true);
    if (ready) return;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for PDF render readiness');
    await new Promise((r) => setTimeout(r, 75));
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

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(appDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) {
    const url = new URL(devServerUrl);
    url.searchParams.set('__print', '1');
    url.searchParams.set('kind', params.kind);
    url.searchParams.set('id', params.id);
    await win.loadURL(url.toString());
  } else {
    await win.loadFile(path.join(appDir, '../renderer/index.html'), {
      query: { __print: '1', kind: params.kind, id: params.id },
    });
  }

  await waitForPdfReady(win, 15_000);

  const buffer = await win.webContents.printToPDF({
    pageSize: 'A4',
    landscape: false,
    printBackground: true,
    marginsType: 0,
  });

  const bytes = new Uint8Array(buffer);
  fs.writeFileSync(destPath, bytes);

  try {
    win.destroy();
  } catch {
    // ignore
  }

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

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 1200,
    backgroundColor: '#ffffff',
    webPreferences: {
      preload: path.join(appDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  const query: Record<string, string> = {
    __print: '1',
    kind: 'eur',
    taxYear: String(params.taxYear),
  };
  if (params.from) query.from = params.from;
  if (params.to) query.to = params.to;

  const devServerUrl = process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) {
    const url = new URL(devServerUrl);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    await win.loadURL(url.toString());
  } else {
    await win.loadFile(path.join(appDir, '../renderer/index.html'), { query });
  }

  await waitForPdfReady(win, 20_000);

  const buffer = await win.webContents.printToPDF({
    pageSize: 'A4',
    landscape: false,
    printBackground: true,
    marginsType: 0,
  });

  fs.writeFileSync(destPath, new Uint8Array(buffer));

  try {
    win.destroy();
  } catch {
    // ignore
  }

  return { path: destPath };
};
