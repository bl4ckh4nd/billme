import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { registerNativeIpcHandlers } from './nativeIpcHandlers';
import { initAutoUpdater } from './updater';
import { initNotificationPush } from './notifications';
import { logger } from '../utils/logger';
import { PRODUCT_PROFILE } from '../productProfile';
import { registerEmbeddedConnectionHandler } from '@billme/desktop-core/electron/embeddedConnection';
import { createLocalBackend, type LocalBackendHandle } from './localBackend';

const appDir = path.dirname(fileURLToPath(import.meta.url));
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL);

app.setName(PRODUCT_PROFILE.appName);

let userDataPath: string | null = null;
let mainWindow: BrowserWindow | null = null;
let localBackend: LocalBackendHandle | null = null;
let shutdownPromise: Promise<void> | null = null;
let shutdownComplete = false;

initNotificationPush(() => mainWindow);

const createWindow = async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1024,
    minHeight: 640,
    frame: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(appDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: !process.env.BILLME_E2E,
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
  const isAllowedNavigation = (targetUrl: string): boolean => {
    try {
      const parsed = new URL(targetUrl);
      if (devServerUrl) {
        const allowedOrigin = new URL(devServerUrl).origin;
        return parsed.origin === allowedOrigin;
      }
      return parsed.protocol === 'file:';
    } catch {
      return false;
    }
  };

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedNavigation(url)) {
      return { action: 'allow' };
    }
    logger.warn('Security', 'Blocked window.open navigation', { url });
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAllowedNavigation(url)) {
      return;
    }
    event.preventDefault();
    logger.warn('Security', 'Blocked unexpected navigation', { url });
  });

  if (devServerUrl) {
    console.log('Loading renderer from', devServerUrl);
    await win.loadURL(devServerUrl);
    if (!process.env.BILLME_E2E) {
      win.webContents.openDevTools({ mode: 'detach' });
    }
    win.webContents.once('did-finish-load', () => {
      console.log('Renderer did-finish-load', win.webContents.getURL());
    });
    return;
  }

  // Ensure the SPA boots at a known route in packaged (file://) mode.
  // Without this, the initial pathname can be ".../index.html", which misses app routes.
  await win.loadFile(path.join(appDir, '../renderer/index.html'), { hash: '/' });
};

const unregisterEmbeddedConnection = registerEmbeddedConnectionHandler(ipcMain, {
  resolveConnection: () => localBackend?.embeddedConnection() ?? null,
  isTrustedSender: (sender) => mainWindow?.webContents === sender,
});

registerNativeIpcHandlers(ipcMain, {
  getUserDataPath: () => {
    if (!userDataPath) throw new Error('userDataPath not initialized');
    return userDataPath;
  },
  getBackupPrefix: () => PRODUCT_PROFILE.backupPrefix,
  dumpDataDir: () => {
    if (!localBackend) throw new Error('Lokales PGlite-Backend ist noch nicht initialisiert.');
    return localBackend.dumpDataDir();
  },
  restoreDataDir: (archivePath) => {
    if (!localBackend) throw new Error('Lokales PGlite-Backend ist noch nicht initialisiert.');
    return localBackend.restoreDataDir(archivePath);
  },
  relaunch: () => {
    app.relaunch();
    app.exit(0);
  },
  getMainWindow: () => mainWindow,
  isTrustedSender: (sender) => mainWindow?.webContents === sender,
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
  // Attempt a graceful renderer reload; if the window is gone or the error is
  // unrecoverable the app will quit after a short delay.
  try {
    mainWindow?.webContents.reload();
  } catch {
    // window may already be destroyed
  }
  setTimeout(() => app.quit(), 3000);
});

app.whenReady().then(async () => {
  const e2eUserDataDir = process.env.BILLME_E2E_USER_DATA_DIR;
  if (e2eUserDataDir) {
    app.setPath('userData', e2eUserDataDir);
    app.setPath('cache', process.env.BILLME_E2E_CACHE_DIR ?? path.join(e2eUserDataDir, 'cache'));
  } else if (isDev) {
    // In some dev environments, the default userData/cache paths may be unwritable.
    const devBase = path.join(app.getPath('temp'), `${PRODUCT_PROFILE.backupPrefix}-dev`);
    app.setPath('userData', devBase);
    app.setPath('cache', path.join(devBase, 'cache'));
  }

  userDataPath = app.getPath('userData');
  localBackend = await createLocalBackend({
    userDataPath,
    profile: PRODUCT_PROFILE,
    isDev,
  });

  await createWindow();

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
}).catch(async (error: unknown) => {
  const startupError = error instanceof Error ? error : new Error(String(error));
  logger.error('Startup', 'Lokales Backend konnte nicht gestartet werden', startupError);
  try {
    await localBackend?.close();
  } catch (closeError) {
    logger.error(
      'Startup',
      'Lokales Backend konnte nach einem Startfehler nicht geschlossen werden',
      closeError instanceof Error ? closeError : new Error(String(closeError)),
    );
  }
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  shutdownPromise ??= (async () => {
    unregisterEmbeddedConnection();
    await localBackend?.close();
  })();

  void shutdownPromise.then(
    () => {
      shutdownComplete = true;
      app.quit();
    },
    (error) => {
      logger.error('Shutdown', 'Failed to close local backend', error instanceof Error ? error : new Error(String(error)));
      shutdownComplete = true;
      app.exit(1);
    },
  );
});
