import { mountRendererApp, type RendererMountOptions } from './mount';

export type { DesktopRendererRuntime } from './mount';

// Separate entry from index.tsx: importing both apps into one program makes their
// TanStack router `Register` declarations collide.
export const mountProDesktopRendererApp = (rootElement: HTMLElement, options?: RendererMountOptions) =>
  mountRendererApp(rootElement, () => import('../../../apps/pro-desktop/App'), options);
