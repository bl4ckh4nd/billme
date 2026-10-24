import { app, BrowserWindow, ipcMain, nativeTheme, type IpcMain } from 'electron';
import { enableCompileCache } from 'node:module';
import path from 'path';
import type { EmbeddedConnectionResult } from '@billme/desktop-contracts/embeddedConnection';
import { initAutoUpdater } from './updater';
import { initNotificationPush } from './notifications';
import { logger } from '../utils/logger';
import { registerEmbeddedConnectionHandler } from './embeddedConnection';
import { isPdfPrintWebContents } from './pdfExport';
import { createDesktopIntegration, startEmbeddedAutomationTicker } from './embeddedAutomation';
import { secrets } from './secrets';

type DesktopIntegration = ReturnType<typeof createDesktopIntegration>;
type PrepareDocumentExport = Parameters<typeof createDesktopIntegration>[0]['prepareDocumentExport'];

export interface DesktopBackend {
  readonly embeddedConnection: () => EmbeddedConnectionResult;
  readonly dumpDataDir: () => Promise<Blob | File>;
  readonly restoreDataDir: (archivePath: string) => Promise<unknown>;
  readonly close: () => Promise<void>;
}

export interface DesktopMainNativeDependencies {
  readonly getUserDataPath: () => string;
  readonly getBackupPrefix: () => string;
  readonly dumpDataDir: () => Promise<Blob | File>;
  readonly restoreDataDir: (archivePath: string) => Promise<unknown>;
  readonly relaunch: () => void;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly isTrustedSender: (sender: Electron.WebContents) => boolean;
  readonly resolveEmbeddedConnection: () => EmbeddedConnectionResult;
}

export interface DesktopMainOptions<TBackend extends DesktopBackend> {
  readonly product: 'lite' | 'pro';
  readonly profile: { readonly appName: string; readonly backupPrefix: string };
  /** Directory of the built main bundle; preload and renderer are resolved next to it. */
  readonly appDir: string;
  readonly minWindowSize?: { readonly width: number; readonly height: number };
  readonly registerNativeIpcHandlers: (ipcMain: IpcMain, deps: DesktopMainNativeDependencies) => void;
  readonly createBackend: (options: { userDataPath: string; desktopIntegration: DesktopIntegration }) => Promise<TBackend>;
  readonly createDocumentExportPreparer: (options: {
    product: 'lite' | 'pro';
    resolveConnection: () => EmbeddedConnectionResult;
  }) => PrepareDocumentExport;
}

/** Electron main process shared by Lite and Pro; the product only supplies its backend and native IPC. */
export const startDesktopMain = <TBackend extends DesktopBackend>(options: DesktopMainOptions<TBackend>): void => {
  const { product, profile, appDir } = options;
  const isDev = Boolean(process.env.VITE_DEV_SERVER_URL || process.env.ELECTRON_RENDERER_URL);

  app.setName(profile.appName);
  // Keeps V8 bytecode of the lazily imported backend chunk (~4 MB) between starts; saves ~60 ms each start.
  enableCompileCache?.();

  let userDataPath: string | null = null;
  let mainWindow: BrowserWindow | null = null;
  let localBackend: TBackend | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let shutdownComplete = false;

  const requireBackend = (): TBackend => {
    if (!localBackend) throw new Error('Lokales PGlite-Backend ist noch nicht initialisiert.');
    return localBackend;
  };

  initNotificationPush(() => mainWindow);

  const createWindow = async () => {
    const win = new BrowserWindow({
      width: 1280,
      height: 800,
      ...(options.minWindowSize ? { minWidth: options.minWindowSize.width, minHeight: options.minWindowSize.height } : {}),
      frame: false,
      // Matches --color-background; the renderer refines it via window:setTheme once loaded.
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#0d0e11' : '#ffffff',
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

  let stopAutomation: (() => Promise<void>) | undefined;

  // The renderer asks for the connection while PGlite is still booting. The preload caches the first
  // answer for the whole session, so the handshake waits for the backend instead of answering `null`.
  let resolveBackendReady!: (backend: TBackend) => void;
  const backendReady = new Promise<TBackend>((resolve) => { resolveBackendReady = resolve; });

  const unregisterEmbeddedConnection = registerEmbeddedConnectionHandler(ipcMain, {
    resolveConnection: () => backendReady.then((backend) => backend.embeddedConnection()),
    isTrustedSender: (sender) => mainWindow?.webContents === sender || isPdfPrintWebContents(sender),
  });

  options.registerNativeIpcHandlers(ipcMain, {
    getUserDataPath: () => {
      if (!userDataPath) throw new Error('userDataPath not initialized');
      return userDataPath;
    },
    getBackupPrefix: () => profile.backupPrefix,
    dumpDataDir: () => requireBackend().dumpDataDir(),
    restoreDataDir: (archivePath) => requireBackend().restoreDataDir(archivePath),
    relaunch: () => {
      app.relaunch();
      app.exit(0);
    },
    getMainWindow: () => mainWindow,
    isTrustedSender: (sender) => mainWindow?.webContents === sender,
    resolveEmbeddedConnection: () => localBackend?.embeddedConnection() ?? null,
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
      const devBase = path.join(app.getPath('temp'), `${profile.backupPrefix}-dev`);
      app.setPath('userData', devBase);
      app.setPath('cache', path.join(devBase, 'cache'));
    }

    userDataPath = app.getPath('userData');
    // Load the window before booting PGlite: both need the main thread, and PGlite blocks it for
    // hundreds of milliseconds (seconds on first start). This way the shell paints first.
    await createWindow();
    localBackend = await options.createBackend({
      userDataPath,
      desktopIntegration: createDesktopIntegration({
        secrets,
        getUserDataPath: () => app.getPath('userData'),
        prepareDocumentExport: options.createDocumentExportPreparer({
          product,
          resolveConnection: () => localBackend?.embeddedConnection() ?? null,
        }),
      }),
    });
    const backend = localBackend;
    resolveBackendReady(backend);
    stopAutomation = startEmbeddedAutomationTicker({
      product,
      connection: () => backend.embeddedConnection(),
      logger,
    });

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
    logger.error('Startup', 'Lokales PGlite-Backend konnte nicht gestartet werden', startupError);
    try {
      await localBackend?.close();
    } catch (closeError) {
      logger.error(
        'Startup',
        'Lokales PGlite-Backend konnte nach einem Startfehler nicht geschlossen werden',
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
      await stopAutomation?.();
      await localBackend?.close();
    })();

    void shutdownPromise.then(
      () => {
        shutdownComplete = true;
        app.quit();
      },
      (error) => {
        logger.error('Shutdown', 'Lokales PGlite-Backend konnte nicht geschlossen werden', error instanceof Error ? error : new Error(String(error)));
        shutdownComplete = true;
        app.exit(1);
      },
    );
  });
};
