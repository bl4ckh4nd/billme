import pkg from 'electron-updater';
const { autoUpdater } = pkg;
type UpdateInfo = pkg.UpdateInfo;
import { BrowserWindow } from 'electron';
import { logger } from '../utils/logger';

export const UPDATE_STATUS_CHANNEL = 'updater:status-changed';

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateStatusPayload {
  status: UpdateStatus;
  version?: string;
  error?: string;
  progress?: number;
}

let currentStatus: UpdateStatusPayload = { status: 'idle' };

const emitStatus = (payload: UpdateStatusPayload) => {
  currentStatus = payload;
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed()) {
    win.webContents.send(UPDATE_STATUS_CHANNEL, payload);
  }
};

export const getCurrentUpdateStatus = (): UpdateStatusPayload => currentStatus;

export const initAutoUpdater = () => {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => {
    logger.info('Updater', 'Checking for update...');
    emitStatus({ status: 'checking' });
  });

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    logger.info('Updater', `Update available: ${info.version}`);
    emitStatus({ status: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    logger.info('Updater', 'No update available');
    emitStatus({ status: 'idle' });
  });

  autoUpdater.on('download-progress', (progress) => {
    emitStatus({
      status: 'downloading',
      progress: Math.round(progress.percent),
    });
  });

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    logger.info('Updater', `Update downloaded: ${info.version}`);
    emitStatus({ status: 'downloaded', version: info.version });
  });

  autoUpdater.on('error', (err: Error) => {
    logger.error('Updater', 'Update error', err);
    emitStatus({ status: 'error', error: err.message });
    // Revert to idle after 30s so the button disappears
    setTimeout(() => emitStatus({ status: 'idle' }), 30_000);
  });

  // Initial check after a short delay (let the app fully load)
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      logger.warn('Updater', 'Initial check failed', { error: String(err) });
    });
  }, 10_000);

  // Periodic checks every 4 hours
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err: unknown) => {
      logger.warn('Updater', 'Periodic check failed', { error: String(err) });
    });
  }, 4 * 60 * 60 * 1000);
};

export const checkForUpdate = async () => {
  await autoUpdater.checkForUpdates();
};

export const downloadUpdate = async () => {
  await autoUpdater.downloadUpdate();
};

export const quitAndInstall = () => {
  autoUpdater.quitAndInstall(false, true);
};
