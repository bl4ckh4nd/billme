import { createBillmeApi as createLiteBillmeApi } from '@billme/desktop-contracts/api';
import { createBillmeApi as createProBillmeApi } from '@billme/desktop-contracts-pro/api';
import { createLiteMockInvoke, createProMockInvoke } from '@billme/desktop-services/mockEngine';
import type { RendererProduct } from './runtime-api';

// Only for `pnpm dev:renderer` (plain Vite without the Electron preload). App entries import this
// behind `import.meta.env.DEV`, so production bundles never contain the mock engine.
export const installDevMockApi = (product: RendererProduct): void => {
  (globalThis as { billmeApi?: unknown }).billmeApi = product === 'pro'
    ? createProBillmeApi(createProMockInvoke())
    : createLiteBillmeApi(createLiteMockInvoke());
};
