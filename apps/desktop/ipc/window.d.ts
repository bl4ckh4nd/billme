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

declare global {
  interface Window {
    billmeApi?: BillmeApi;
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
