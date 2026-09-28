import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserDocumentShell } from './BrowserDocumentShell';

const { client } = vi.hoisted(() => ({ client: {
  getBootstrapStatusFor: vi.fn(async () => ({ bootstrapped: true })),
  loginFor: vi.fn(), bootstrapFor: vi.fn(),
} }));
vi.mock('@billme/server-core', async (original) => ({ ...await original<object>(), createServerApiClient: () => client }));
vi.mock('@billme/ui', () => ({
  AuthScreen: (props: any) => <div>
    <span>{props.mode}</span>
    <button onClick={() => props.onSubmit({ email: 'a@b.de', password: 'secret', fullName: 'A' })}>Login</button>
    <button onClick={() => props.onServerUrlChange('http://server-b')}>Server wechseln</button>
  </div>,
  ErrorState: ({ description }: any) => <div>{description}</div>,
}));
const user = { id: 'u', email: 'a@b.de', fullName: 'A' };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };
afterEach(() => { cleanup(); localStorage.clear(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe.each(['lite', 'pro'] as const)('%s browser lifecycle', (product) => {
  const options = { product, defaultApiUrl: 'http://server-a', sessionStorageKey: `${product}.session`, apiUrlStorageKey: `${product}.url` };
  it('discards a login completion after changing server', async () => {
    const pending = deferred<any>();
    client.loginFor.mockReturnValueOnce(pending.promise);
    const mount = vi.fn(async () => () => {});
    render(<BrowserDocumentShell {...options} mount={mount} />);
    await screen.findByText('login');
    fireEvent.click(screen.getByText('Login'));
    fireEvent.click(screen.getByText('Server wechseln'));
    await waitFor(() => expect(localStorage.getItem(options.apiUrlStorageKey)).toBe('http://server-b'));
    await act(async () => pending.resolve({ token: 'old-token', user }));
    expect(mount).not.toHaveBeenCalled();
    expect(localStorage.getItem(options.sessionStorageKey)).toBeNull();
  });
  it('aborts a pending mount on logout and disposes its late result', async () => {
    client.loginFor.mockResolvedValueOnce({ token: 'token', user });
    const pending = deferred<() => void>();
    const dispose = vi.fn();
    const mount = vi.fn(() => pending.promise);
    render(<BrowserDocumentShell {...options} mount={mount} />);
    await screen.findByText('login');
    fireEvent.click(screen.getByText('Login'));
    await waitFor(() => expect(mount).toHaveBeenCalledOnce());
    const context = mount.mock.calls[0][1] as any;
    act(() => context.onLogout());
    expect(context.signal.aborted).toBe(true);
    await act(async () => pending.resolve(dispose));
    expect(dispose).toHaveBeenCalledOnce();
    expect(localStorage.getItem(options.sessionStorageKey)).toBeNull();
  });
});
