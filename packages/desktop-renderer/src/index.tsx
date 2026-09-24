import { mountRendererApp, type RendererMountOptions } from './mount';

export * from './mount';

export const mountDesktopRendererApp = (rootElement: HTMLElement, options?: RendererMountOptions) =>
  mountRendererApp(rootElement, () => import('../../../apps/desktop/App'), options);
