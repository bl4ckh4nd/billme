import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { BillmeApi } from '@billme/desktop-contracts/api';
import { mountDesktopRendererApp } from './index';

describe('mountDesktopRendererApp', () => {
  it('keeps the host api when a superseded mount (StrictMode double effect) cleans up late', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const api = {} as BillmeApi;
    const globals = globalThis as { billmeApi?: BillmeApi };
    // The stub api makes the real app hit its error boundary; only the mount bookkeeping matters here.
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // The host effect starts a mount, is cleaned up before it resolves, and starts again.
      const first = mountDesktopRendererApp(host, { api });
      const second = mountDesktopRendererApp(host, { api });
      const [cleanupFirst, cleanupSecond] = await act(async () => Promise.all([first, second]));

      act(() => cleanupFirst());
      expect(globals.billmeApi).toBe(api);
      expect(consoleError.mock.calls.some((call) => String(call[0]).includes('already been passed to createRoot'))).toBe(false);

      act(() => cleanupSecond());
      expect(globals.billmeApi).toBeUndefined();
    } finally {
      consoleError.mockRestore();
      host.remove();
    }
    // Mounting imports the whole desktop app, which is slow on a loaded machine.
  }, 30_000);
});
