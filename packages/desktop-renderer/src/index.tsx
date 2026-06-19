import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BillmeApi as LiteBillmeApi } from '@billme/desktop-contracts/api';
import type { BillmeApi as ProBillmeApi } from '@billme/desktop-contracts-pro/api';

export type DesktopRendererApi = LiteBillmeApi | ProBillmeApi;

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

type DesktopAppModule = {
  default: React.ComponentType;
};

type ViteImportMeta = ImportMeta & {
  glob: (pattern: string) => Record<string, () => Promise<unknown>>;
};

// import.meta.glob is only resolved by Vite when this file is within the consuming
// app's root. When bundled into apps/web (whose root is apps/web/), the glob
// transform does not apply and import.meta.glob is undefined at runtime. Guard
// against this so the module initialises safely; callers can pass AppComponent
// directly to BrowserRendererHost instead.
const _viteGlob = (import.meta as ViteImportMeta).glob;
const safeGlob = typeof _viteGlob === 'function'
  ? (pattern: string) => _viteGlob(pattern)
  : (_pattern: string) => ({} as Record<string, () => Promise<unknown>>);

const productAppModules = safeGlob('../../../apps/{desktop,pro-desktop}/App.tsx');
const productStyleModules = safeGlob('../../../apps/{desktop,pro-desktop}/index.css');

const productAppPath = (product: 'lite' | 'pro') =>
  product === 'pro'
    ? '../../../apps/pro-desktop/App.tsx'
    : '../../../apps/desktop/App.tsx';

const productStylePath = (product: 'lite' | 'pro') =>
  product === 'pro'
    ? '../../../apps/pro-desktop/index.css'
    : '../../../apps/desktop/index.css';

const loadProductStyles = async (product: 'lite' | 'pro'): Promise<void> => {
  await productStyleModules[productStylePath(product)]?.();
};

const loadProductApp = async (product: 'lite' | 'pro'): Promise<DesktopAppModule> => {
  const load = productAppModules[productAppPath(product)];
  if (!load) {
    throw new Error(`Billme ${product} renderer app could not be loaded.`);
  }
  return load() as Promise<DesktopAppModule>;
};

export const mountDesktopRendererApp = async (
  rootElement: HTMLElement,
  options?: { api?: DesktopRendererApi; runtime?: DesktopRendererRuntime; AppComponent?: React.ComponentType },
): Promise<() => void> => {
  const runtime = globalThis as RendererGlobals;
  const resolvedRuntime = resolveRuntime(options?.runtime);
  const cleanupShims = installBrowserPlatformShims(resolvedRuntime);
  const product = resolvedRuntime?.product ?? 'lite';

  if (options?.api) {
    runtime.billmeApi = options.api;
  }
  if (resolvedRuntime) {
    runtime.billmeRuntime = resolvedRuntime;
  }

  let App: React.ComponentType;
  if (options?.AppComponent) {
    App = options.AppComponent;
  } else {
    await loadProductStyles(product);
    const module = await loadProductApp(product);
    App = module.default;
  }
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

    void mountDesktopRendererApp(hostRef.current, { api, runtime, AppComponent })
      .then((cleanup) => {
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
  }, [api, runtime]);

  if (mountError) {
    return <>{children ? children(mountError) : mountError}</>;
  }

  return <div ref={hostRef} className={className} />;
};

export * from './browserShell.js';
