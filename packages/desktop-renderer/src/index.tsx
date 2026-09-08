import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BillmeApi } from '@billme/desktop-contracts/api';
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

export const mountDesktopRendererApp = async (
  rootElement: HTMLElement,
  options?: { api?: BillmeApi; runtime?: DesktopRendererRuntime },
): Promise<() => void> => {
  const runtime = globalThis as {
    billmeApi?: BillmeApi;
    billmeRuntime?: DesktopRendererRuntime;
  };

  if (options?.api) {
    runtime.billmeApi = options.api;
  }
  if (options?.runtime) {
    runtime.billmeRuntime = options.runtime;
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
    if (options?.runtime && runtime.billmeRuntime === options.runtime) {
      delete runtime.billmeRuntime;
    }
  };
};
