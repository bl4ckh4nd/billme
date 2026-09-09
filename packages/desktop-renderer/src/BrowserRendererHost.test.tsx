// @vitest-environment happy-dom
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BrowserRendererHost,
  type DesktopRendererApi,
  type DesktopRendererRuntime,
} from './index';

const TestApp = () => <div>Pro renderer mounted</div>;

describe('BrowserRendererHost', () => {
  afterEach(() => {
    delete (globalThis as { billmeApi?: unknown }).billmeApi;
    delete (globalThis as { billmeRuntime?: unknown }).billmeRuntime;
    delete (globalThis as { billmeWindow?: unknown }).billmeWindow;
  });

  it('mounts only one nested renderer root under React StrictMode', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = {} as DesktopRendererApi;
    const runtime: DesktopRendererRuntime = { shell: 'web', product: 'pro' };

    const view = render(
      <React.StrictMode>
        <BrowserRendererHost api={api} runtime={runtime} AppComponent={TestApp} />
      </React.StrictMode>,
    );

    await screen.findByText('Pro renderer mounted');
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('already been passed to createRoot'),
    );

    view.unmount();
    await waitFor(() => expect((globalThis as { billmeApi?: unknown }).billmeApi).toBeUndefined());
    consoleError.mockRestore();
  });
});
