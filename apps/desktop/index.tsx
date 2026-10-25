/// <reference types="vite/client" />
import { mountRendererApp } from '@billme/desktop-renderer';
// Static on purpose: a dynamic import would wait for the main process, which is busy booting PGlite.
import App from './App';
import { installFatalErrorOverlay } from '@billme/desktop-renderer/fatal-error-overlay';

installFatalErrorOverlay({ dev: import.meta.env.DEV });

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

console.log('[renderer] boot', {
  href: window.location.href,
  userAgent: navigator.userAgent,
});

const boot = async () => {
  if (import.meta.env.DEV && !(globalThis as { billmeApi?: unknown }).billmeApi) {
    (await import('@billme/desktop-renderer/dev-mock')).installDevMockApi('lite');
  }
  // Lite declares its product: the renderer's fallback follows the last getRendererApi(product) call,
  // which a double-entry profile on the dashboard switches to 'pro'.
  await mountRendererApp(rootElement, async () => ({ default: App }), { runtime: { shell: 'desktop', product: 'lite' } });
};

void boot();
