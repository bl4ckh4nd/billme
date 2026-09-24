import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BillmeApi } from '@billme/desktop-contracts/api';
import type { BillmeApi as ProBillmeApi } from '@billme/desktop-contracts-pro/api';
import type { RendererRuntime } from './runtime-api';
import '../../../apps/desktop/index.css';

export type DesktopRendererRuntime = RendererRuntime & {
  shell?: 'desktop' | 'web';
  product?: 'lite' | 'pro';
  navigation?: string[];
  onLogout?: () => void;
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

// Mounts on one page supersede each other: StrictMode runs the host effect
// twice, and a new session token remounts the app. Only the latest mount may
// render or clear the shared globals; an older one clearing billmeApi would drop
// the renderer onto the mock fallback while the newer app is still showing.
let latestMountId = 0;

export type RendererMountOptions = { api?: BillmeApi | ProBillmeApi; runtime?: DesktopRendererRuntime };

type RendererAppModule = { default: React.ComponentType };

export const mountRendererApp = async (
  rootElement: HTMLElement,
  loadApp: () => Promise<RendererAppModule>,
  options?: RendererMountOptions,
): Promise<() => void> => {
  const mountId = ++latestMountId;
  const runtime = globalThis as {
    billmeApi?: BillmeApi | ProBillmeApi;
    billmeRuntime?: DesktopRendererRuntime;
  };

  if (options?.api) {
    runtime.billmeApi = options.api;
  }
  if (options?.runtime) {
    runtime.billmeRuntime = options.runtime;
  }

  const { default: App } = await loadApp();
  if (mountId !== latestMountId) {
    return () => {};
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
    if (mountId !== latestMountId) return;
    if (options?.api && runtime.billmeApi === options.api) {
      delete runtime.billmeApi;
    }
    if (options?.runtime && runtime.billmeRuntime === options.runtime) {
      delete runtime.billmeRuntime;
    }
  };
};
