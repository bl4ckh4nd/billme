import type { BillmeApi } from './api';

type WindowMaximizeState = {
  isMaximized: boolean;
};

declare global {
  interface Window {
    billmeApi?: BillmeApi;
    billmeWindow?: {
      onMaximizeChanged: (callback: (state: WindowMaximizeState) => void) => void;
      offMaximizeChanged: () => void;
    };
  }
}

export {};
