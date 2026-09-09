import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BillmeApi as LiteBillmeApi } from '@billme/desktop-contracts/api';
import type { BillmeApi as ProBillmeApi } from '@billme/desktop-contracts-pro/api';
import type { VatValidationResult } from '@billme/server-core';

export type DesktopRendererApi = LiteBillmeApi | ProBillmeApi;

export type DesktopRendererRuntime = {
  shell?: 'desktop' | 'web';
  product?: 'lite' | 'pro';
  navigation?: string[];
  onLogout?: () => void;
  validateVatId?: (args: { countryCode: string; vatNumber: string }) => Promise<VatValidationResult>;
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
  billmeApi?: DesktopRendererApi;
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
  options?: { api?: DesktopRendererApi; runtime?: DesktopRendererRuntime; AppComponent?: React.ComponentType },
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

  let App: React.ComponentType;
  let root: ReactDOM.Root | undefined;
  const queryClient = createRendererQueryClient();
  try {
    if (!options?.AppComponent) {
      throw new Error('Der Renderer muss von seiner Composition Root explizit bereitgestellt werden.');
    }
    App = options.AppComponent;
    root = ReactDOM.createRoot(rootElement);
  } catch (error) {
    queryClient.clear();
    if (options?.api && runtime.billmeApi === options.api) delete runtime.billmeApi;
    if (resolvedRuntime && runtime.billmeRuntime === resolvedRuntime) delete runtime.billmeRuntime;
    cleanupShims?.();
    throw error;
  }
  root.render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </React.StrictMode>,
  );

  return () => {
    root.unmount();
    queryClient.clear();
    if (options?.api && runtime.billmeApi === options.api) {
      delete runtime.billmeApi;
    }
    if (resolvedRuntime && runtime.billmeRuntime === resolvedRuntime) {
      delete runtime.billmeRuntime;
    }
    cleanupShims?.();
  };
};

export const BrowserRendererHost = <TApi extends DesktopRendererApi>({
  api,
  runtime,
  AppComponent,
  className = 'min-h-screen',
  children,
}: {
  api: TApi;
  runtime: DesktopRendererRuntime;
  AppComponent?: React.ComponentType;
  className?: string;
  children?: (mountError: string) => React.ReactNode;
}): React.ReactElement => {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const [mountError, setMountError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!hostRef.current) {
      return undefined;
    }

    let cancelled = false;
    let dispose: undefined | (() => void);

    const hostElement = hostRef.current;
    void Promise.resolve()
      .then(() => {
        if (cancelled) return undefined;
        return mountDesktopRendererApp(hostElement, { api, runtime, AppComponent });
      })
      .then((cleanup) => {
        if (!cleanup) return;
        if (cancelled) {
          cleanup();
          return;
        }
        dispose = cleanup;
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setMountError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [api, runtime, AppComponent]);

  if (mountError) {
    return <>{children ? children(mountError) : mountError}</>;
  }

  return <div ref={hostRef} className={className} />;
};

export * from './browserShell.js';
