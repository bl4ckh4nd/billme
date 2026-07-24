import type { BrowserWindow } from 'electron';

export type NotificationPayload = {
  type: 'dunning' | 'recurring' | 'portal' | 'email' | 'info';
  title: string;
  message: string;
};

const NOTIFICATION_CHANNEL = 'app:notification';

let getWindow: (() => BrowserWindow | null) | null = null;

export const initNotificationPush = (windowGetter: () => BrowserWindow | null): void => {
  getWindow = windowGetter;
};

export const pushNotification = (payload: NotificationPayload): void => {
  const win = getWindow?.();
  if (!win || win.isDestroyed()) return;
  win.webContents.send(NOTIFICATION_CHANNEL, payload);
};
