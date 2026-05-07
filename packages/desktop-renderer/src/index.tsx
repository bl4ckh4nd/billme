import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BillmeApi } from '@billme/desktop-contracts/api';
import '../../../apps/desktop/index.css';

export type DesktopRendererRuntime = {
  shell?: 'desktop' | 'web';
  product?: 'lite' | 'pro';
  navigation?: string[];
  onLogout?: () => void;
};

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

type BillmeWindowShim = {
  onMaximizeChanged: (callback: (state: WindowMaximizeState) => void) => void;
  offMaximizeChanged: () => void;
  onUpdateStatusChanged: (callback: (payload: UpdateStatusPayload) => void) => void;
  offUpdateStatusChanged: () => void;
  onNotification: (callback: (payload: NotificationPayload) => void) => void;
  offNotification: () => void;
};

type RendererGlobals = typeof globalThis & {
  billmeApi?: BillmeApi;
  billmeRuntime?: DesktopRendererRuntime;
  billmeWindow?: BillmeWindowShim;
};

const DEFAULT_UPDATE_STATUS: UpdateStatusPayload = {
  status: 'idle',
};

const resolveRuntime = (runtime?: DesktopRendererRuntime): DesktopRendererRuntime | undefined => {
  if (typeof window === 'undefined') {
    return runtime;
  }

  if ((globalThis as RendererGlobals).billmeWindow) {
    return runtime;
  }

  return {
    ...runtime,
    shell: 'web',
  };
};

const createBrowserBillmeWindowShim = (): BillmeWindowShim => {
  const maximizeListeners = new Set<(state: WindowMaximizeState) => void>();
  const updateStatusListeners = new Set<(payload: UpdateStatusPayload) => void>();
  const notificationListeners = new Set<(payload: NotificationPayload) => void>();

  return {
    onMaximizeChanged: (callback) => {
      maximizeListeners.add(callback);
      callback({ isMaximized: false });
    },
    offMaximizeChanged: () => {
      maximizeListeners.clear();
    },
    onUpdateStatusChanged: (callback) => {
      updateStatusListeners.add(callback);
      callback(DEFAULT_UPDATE_STATUS);
    },
    offUpdateStatusChanged: () => {
      updateStatusListeners.clear();
    },
    onNotification: (callback) => {
      notificationListeners.add(callback);
    },
    offNotification: () => {
      notificationListeners.clear();
    },
  };
};

const installBrowserPlatformShims = (runtime?: DesktopRendererRuntime): (() => void) | undefined => {
  if (typeof window === 'undefined') {
    return undefined;
  }

  const globals = globalThis as RendererGlobals;
  if (runtime?.shell !== 'web' || globals.billmeWindow) {
    return undefined;
  }

  const shim = createBrowserBillmeWindowShim();
  globals.billmeWindow = shim;

  return () => {
    if (globals.billmeWindow === shim) {
      delete globals.billmeWindow;
    }
  };
};

export const createRendererQueryClient = (): QueryClient =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 10_000,
        gcTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });

export const mountDesktopRendererApp = async (
  rootElement: HTMLElement,
  options?: { api?: BillmeApi; runtime?: DesktopRendererRuntime },
): Promise<() => void> => {
  const runtime = globalThis as RendererGlobals;
  const resolvedRuntime = resolveRuntime(options?.runtime);
  const cleanupShims = installBrowserPlatformShims(resolvedRuntime);

  if (options?.api) {
    runtime.billmeApi = options.api;
  }
  if (resolvedRuntime) {
    runtime.billmeRuntime = resolvedRuntime;
  }

  const { default: App } = await import('../../../apps/desktop/App');
  const queryClient = createRendererQueryClient();
  const root = ReactDOM.createRoot(rootElement);
  root.render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </React.StrictMode>,
  );

  return () => {
    root.unmount();
    if (options?.api && runtime.billmeApi === options.api) {
      delete runtime.billmeApi;
    }
    if (resolvedRuntime && runtime.billmeRuntime === resolvedRuntime) {
      delete runtime.billmeRuntime;
    }
    cleanupShims?.();
  };
};
