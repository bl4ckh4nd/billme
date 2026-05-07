import type { BillmeApi } from '@billme/desktop-contracts/api';

type WindowMaximizeState = {
  isMaximized: boolean;
};

type UpdateStatusPayload = {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';
  version?: string;
  error?: string;
  progress?: number;
};

type NotificationPayload = {
  type: string;
  title: string;
  message: string;
};

type BillmeRuntimeConfig = {
  serverApiUrl?: string;
};

declare global {
  interface Window {
    billmeApi?: BillmeApi;
    billmeRuntimeConfig?: BillmeRuntimeConfig;
    billmeWindow?: {
      onMaximizeChanged: (callback: (state: WindowMaximizeState) => void) => void;
      offMaximizeChanged: () => void;
      onUpdateStatusChanged: (callback: (payload: UpdateStatusPayload) => void) => void;
      offUpdateStatusChanged: () => void;
      onNotification: (callback: (payload: NotificationPayload) => void) => void;
      offNotification: () => void;
    };
  }
}

export {};
