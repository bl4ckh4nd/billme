import type { BillmeApi } from './api';

type WindowMaximizeState = {
  isMaximized: boolean;
};

type UpdateStatusPayload = {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error';
  version?: string;
  error?: string;
  progress?: number;
};

declare global {
  interface Window {
    billmeApi?: BillmeApi;
    billmeWindow?: {
      onMaximizeChanged: (callback: (state: WindowMaximizeState) => void) => void;
      offMaximizeChanged: () => void;
      onUpdateStatusChanged: (callback: (payload: UpdateStatusPayload) => void) => void;
      offUpdateStatusChanged: () => void;
    };
  }
}

export {};
