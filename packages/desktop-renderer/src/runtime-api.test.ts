import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BillmeApi as ProBillmeApi } from '@billme/desktop-contracts-pro/api';
import { createRendererApiProxy } from './runtime-api';

describe('createRendererApiProxy', () => {
  afterEach(() => {
    delete (globalThis as { billmeApi?: unknown }).billmeApi;
  });

  it('resolves the mounted browser API after module initialization', async () => {
    const mountedList = vi.fn(async () => []);
    const ipc = createRendererApiProxy('pro');

    (globalThis as { billmeApi?: ProBillmeApi }).billmeApi = {
      pro: { getAccountingPolicy: mountedList },
    } as unknown as ProBillmeApi;

    await ipc.pro.getAccountingPolicy();

    expect(mountedList).toHaveBeenCalledOnce();
  });
});
