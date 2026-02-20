import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import type {
  Invoice,
  InvoiceElement,
} from '../types';
import { initDb } from '../db/connection';
import { upsertInvoice } from '../db/invoicesRepo';
import {
  MOCK_ACCOUNTS,
  MOCK_ARTICLES,
  MOCK_CLIENTS,
  MOCK_INVOICES,
  MOCK_RECURRING_PROFILES,
  MOCK_SETTINGS,
} from '../data/mockData';
import { upsertClient } from '../db/clientsRepo';
import { upsertArticle } from '../db/articlesRepo';
import { upsertAccount } from '../db/accountsRepo';
import { upsertRecurringProfile } from '../db/recurringRepo';
import { setSettings } from '../db/settingsRepo';
import {
  getActiveTemplate,
  listTemplates,
  setActiveTemplateId,
  upsertTemplate,
} from '../db/templatesRepo';
import { INITIAL_INVOICE_TEMPLATE, INITIAL_OFFER_TEMPLATE } from '../constants';
import { registerIpcHandlers } from './ipcHandlers';
import { startPortalDecisionPolling } from './portalDecisionPolling';
import { startDunningScheduler, stopDunningScheduler } from './dunningScheduler';
import { startRecurringScheduler, stopRecurringScheduler } from './recurringScheduler';
import { initAutoUpdater } from './updater';
import { logger } from '../utils/logger';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL);

let userDataPath: string | null = null;
let portalSyncStop: (() => void) | null = null;
let mainWindow: BrowserWindow | null = null;

const createWindow = async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(appDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;

  const emitWindowState = () => {
    if (!win.isDestroyed()) {
      win.webContents.send('window:maximize-changed', { isMaximized: win.isMaximized() });
    }
  };
  win.on('maximize', emitWindowState);
  win.on('unmaximize', emitWindowState);
  win.webContents.on('did-finish-load', emitWindowState);
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });

  const devServerUrl = process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl) {
    console.log('Loading renderer from', devServerUrl);
    await win.loadURL(devServerUrl);
    win.webContents.openDevTools({ mode: 'detach' });
    win.webContents.once('did-finish-load', () => {
      console.log('Renderer did-finish-load', win.webContents.getURL());
    });
    return;
  }

  // Ensure the SPA boots at a known route in packaged (file://) mode.
  // Without this, the initial pathname can be ".../index.html", which misses app routes.
  await win.loadFile(path.join(appDir, '../renderer/index.html'), { hash: '/' });
};

const requireDb = () => {
  if (!userDataPath) throw new Error('userDataPath not initialized');
  return initDb(userDataPath);
};

registerIpcHandlers(ipcMain, {
  requireDb,
  getUserDataPath: () => {
    if (!userDataPath) throw new Error('userDataPath not initialized');
    return userDataPath;
  },
  getMainWindow: () => mainWindow,
});

// Global error handlers
process.on('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
  logger.error('UnhandledRejection', 'Unhandled promise rejection',
    reason instanceof Error ? reason : new Error(String(reason)),
    { promise: promise.toString() }
  );
});

process.on('uncaughtException', (error: Error) => {
  logger.error('UncaughtException', 'Uncaught exception', error);
  // Don't exit - let app handle it gracefully
});

app.whenReady().then(async () => {
  if (isDev) {
    // In some dev environments, the default userData/cache paths may be unwritable.
    const devBase = path.join(app.getPath('temp'), 'billme-dev');
    app.setPath('userData', devBase);
    app.setPath('cache', path.join(devBase, 'cache'));
  }

  userDataPath = app.getPath('userData');
  const db = initDb(userDataPath);

  // Dev convenience: seed initial data if DB is empty.
  const invoiceCountRow = db.prepare('SELECT COUNT(*) as c FROM invoices').get() as { c: number };
  if (invoiceCountRow.c === 0) {
    for (const inv of MOCK_INVOICES) {
      try {
        upsertInvoice(db, inv, 'seed');
      } catch (error) {
        logger.debug('Seed', 'Failed to seed invoice', { invoiceId: inv.id, error: String(error) });
      }
    }
  }

  const offerCountRow = db.prepare('SELECT COUNT(*) as c FROM offers').get() as { c: number };
  if (offerCountRow.c === 0) {
    // seed offers: none for now
  }

  const clientCountRow = db.prepare('SELECT COUNT(*) as c FROM clients').get() as { c: number };
  if (clientCountRow.c === 0) {
    for (const c of MOCK_CLIENTS) {
      try {
        upsertClient(db, c);
      } catch (error) {
        logger.debug('Seed', 'Failed to seed client', { clientId: c.id, error: String(error) });
      }
    }
  }

  const articleCountRow = db.prepare('SELECT COUNT(*) as c FROM articles').get() as { c: number };
  if (articleCountRow.c === 0) {
    for (const a of MOCK_ARTICLES) {
      try {
        upsertArticle(db, a);
      } catch (error) {
        logger.debug('Seed', 'Failed to seed article', { articleId: a.id, error: String(error) });
      }
    }
  }

  const accountCountRow = db.prepare('SELECT COUNT(*) as c FROM accounts').get() as { c: number };
  if (accountCountRow.c === 0) {
    for (const acc of MOCK_ACCOUNTS) {
      try {
        upsertAccount(db, acc);
      } catch (error) {
        logger.debug('Seed', 'Failed to seed account', { accountId: acc.id, error: String(error) });
      }
    }
  }

  const recurringCountRow = db.prepare('SELECT COUNT(*) as c FROM recurring_profiles').get() as {
    c: number;
  };
  if (recurringCountRow.c === 0) {
    for (const p of MOCK_RECURRING_PROFILES) {
      try {
        upsertRecurringProfile(db, p);
      } catch (error) {
        logger.debug('Seed', 'Failed to seed recurring profile', { profileId: p.id, error: String(error) });
      }
    }
  }

  const settingsRow = db.prepare('SELECT 1 FROM settings WHERE id = 1').get() as { 1: 1 } | undefined;
  if (!settingsRow) {
    try {
      setSettings(db, MOCK_SETTINGS);
    } catch (error) {
      logger.debug('Seed', 'Failed to seed settings', { error: String(error) });
    }
  }

  const templateCountRow = db.prepare('SELECT COUNT(*) as c FROM templates').get() as { c: number };
  if (templateCountRow.c === 0) {
    try {
      const invoiceTemplate = upsertTemplate(db, {
        id: 'default-invoice',
        kind: 'invoice',
        name: 'Standard Rechnung',
        elements: INITIAL_INVOICE_TEMPLATE as unknown as InvoiceElement[],
      });
      const offerTemplate = upsertTemplate(db, {
        id: 'default-offer',
        kind: 'offer',
        name: 'Standard Angebot',
        elements: INITIAL_OFFER_TEMPLATE as unknown as InvoiceElement[],
      });
      setActiveTemplateId(db, 'invoice', invoiceTemplate.id);
      setActiveTemplateId(db, 'offer', offerTemplate.id);
    } catch (error) {
      logger.debug('Seed', 'Failed to seed templates', { error: String(error) });
    }
  }

  await createWindow();

  // Background portal decision sync (polling).
  // First decision wins; desktop remains source-of-truth and logs audit entries on sync.
  try {
    const poller = startPortalDecisionPolling({
      requireDb,
      intervalMs: 60_000,
      logger: console,
    });
    portalSyncStop = poller.stop;
  } catch (e) {
    logger.warn('Startup', 'Portal sync failed to start', { error: String(e) });
  }

  // Start dunning scheduler for automatic reminder emails
  try {
    startDunningScheduler();
    logger.info('Startup', 'Dunning scheduler started');
  } catch (e) {
    logger.warn('Startup', 'Dunning scheduler failed to start', { error: String(e) });
  }

  // Start recurring invoice scheduler
  try {
    startRecurringScheduler();
    logger.info('Startup', 'Recurring invoice scheduler started');
  } catch (e) {
    logger.warn('Startup', 'Recurring scheduler failed to start', { error: String(e) });
  }

  // Auto-updater (only in packaged builds)
  if (!isDev) {
    try {
      initAutoUpdater();
      logger.info('Startup', 'Auto-updater initialized');
    } catch (e) {
      logger.warn('Startup', 'Auto-updater failed to start', { error: String(e) });
    }
  }

  const [win] = BrowserWindow.getAllWindows();
  if (win) {
    win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL) => {
      logger.error('Renderer', 'Failed to load', undefined, { errorCode, errorDescription, validatedURL });
    });

    win.webContents.on('render-process-gone', (_e, details) => {
      logger.error('Renderer', 'Render process gone', undefined, details);
    });

    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      // Keep console.log for renderer messages as they're already formatted
      console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
    });
  }

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try {
    portalSyncStop?.();
  } catch (error) {
    logger.warn('Shutdown', 'Failed to stop portal sync', { error: String(error) });
  }
  try {
    stopDunningScheduler();
  } catch (error) {
    logger.warn('Shutdown', 'Failed to stop dunning scheduler', { error: String(error) });
  }
  try {
    stopRecurringScheduler();
  } catch (error) {
    logger.warn('Shutdown', 'Failed to stop recurring scheduler', { error: String(error) });
  }
});
