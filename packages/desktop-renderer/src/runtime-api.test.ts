import { afterEach, expect, it } from 'vitest';
import { createRendererApiProxy } from './runtime-api';

afterEach(() => { delete (globalThis as any).billmeApi; });
it('resolves the current session when a previously imported client is used', () => {
  const lite = createRendererApiProxy('lite');
  const pro = createRendererApiProxy('pro');
  (globalThis as any).billmeApi = { invoices: { session: 'first' } };
  expect(lite.invoices).toEqual({ session: 'first' });
  (globalThis as any).billmeApi = { invoices: { session: 'second' } };
  expect(lite.invoices).toEqual({ session: 'second' });
  expect(pro.invoices).toEqual({ session: 'second' });
});
