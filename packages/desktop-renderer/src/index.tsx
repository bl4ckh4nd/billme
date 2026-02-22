import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BillmeApi } from '../../../apps/desktop/ipc/api';
import '../../../apps/desktop/index.css';

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
  options?: { api?: BillmeApi },
): Promise<void> => {
  if (options?.api) {
    (globalThis as { billmeApi?: BillmeApi }).billmeApi = options.api;
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
};
