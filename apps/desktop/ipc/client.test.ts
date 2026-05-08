import { afterEach, describe, expect, it, vi } from 'vitest';
import { ipc } from './client';

describe('ipc client', () => {
  afterEach(() => {
    delete (globalThis as typeof globalThis & { billmeApi?: unknown }).billmeApi;
  });

  it('resolves the external api lazily', async () => {
    const clientsList = vi.fn().mockResolvedValue(['live-clients']);
    (globalThis as typeof globalThis & { billmeApi?: unknown }).billmeApi = {
      clients: {
        list: clientsList,
      },
    };

    await expect(ipc.clients.list()).resolves.toEqual(['live-clients']);
    expect(clientsList).toHaveBeenCalledTimes(1);
  });
});
