/// <reference types="vite/client" />
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './index.css';
import { installFatalErrorOverlay } from '@billme/desktop-renderer/fatal-error-overlay';

installFatalErrorOverlay({ dev: import.meta.env.DEV });

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Could not find root element to mount to');
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const boot = async () => {
  if (import.meta.env.DEV && !(globalThis as { billmeApi?: unknown }).billmeApi) {
    (await import('@billme/desktop-renderer/dev-mock')).installDevMockApi('pro');
  }
  // Same as mountRendererApp in the shells: the shared renderer reads the product from here.
  (globalThis as { billmeRuntime?: { shell: 'desktop'; product: 'pro' } }).billmeRuntime = { shell: 'desktop', product: 'pro' };
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </React.StrictMode>,
  );
};

void boot();
