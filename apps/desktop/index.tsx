import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from './App';
import './index.css';

const ensureDebugOverlay = () => {
  const id = '__app_debug_overlay';
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('pre');
    el.id = id;
    el.style.position = 'fixed';
    el.style.bottom = '12px';
    el.style.right = '12px';
    el.style.maxWidth = '520px';
    el.style.maxHeight = '50vh';
    el.style.overflow = 'auto';
    el.style.padding = '12px 14px';
    el.style.borderRadius = '12px';
    el.style.background = 'rgba(0,0,0,0.85)';
    el.style.color = 'white';
    el.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';
    el.style.fontSize = '12px';
    el.style.lineHeight = '1.4';
    el.style.whiteSpace = 'pre-wrap';
    el.style.zIndex = '999999';
    el.style.pointerEvents = 'auto';
    document.body.appendChild(el);
  }
  return el;
};

const reportFatal = (label: string, err: unknown) => {
  const msg =
    err instanceof Error
      ? `${err.name}: ${err.message}\n${err.stack ?? ''}`
      : typeof err === 'string'
        ? err
        : JSON.stringify(err, null, 2);

  console.error(`[fatal:${label}]`, err);
  const overlay = ensureDebugOverlay();
  overlay.textContent = `[${new Date().toISOString()}] ${label}\n${msg}`;
};

window.addEventListener('error', (e) => {
  reportFatal('window.error', e.error ?? e.message);
});

window.addEventListener('unhandledrejection', (e) => {
  reportFatal('unhandledrejection', e.reason);
});

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

console.log('[renderer] boot', {
  href: window.location.href,
  userAgent: navigator.userAgent,
});

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

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>
);
