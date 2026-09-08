import { describe, expect, it, vi } from 'vitest';
import { createEmbeddedConnectionResolver } from './embeddedConnection';
import { registerEmbeddedConnectionHandler } from './embeddedConnection';

describe('embedded connection preload resolver', () => {
  it('validates and caches the private handshake after the first resolution', async () => {
    const invoke = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:43123',
      token: 'local-token',
    }));
    const resolve = createEmbeddedConnectionResolver(invoke);

    await expect(Promise.all([resolve(), resolve()])).resolves.toEqual([
      { baseUrl: 'http://127.0.0.1:43123', token: 'local-token' },
      { baseUrl: 'http://127.0.0.1:43123', token: 'local-token' },
    ]);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid private handshake payload', async () => {
    const resolve = createEmbeddedConnectionResolver(async () => ({
      baseUrl: 'not-a-url',
      token: '',
    }));

    await expect(resolve()).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('rejects untrusted webContents before resolving the private connection', async () => {
    let handler: ((event: { sender: unknown }) => Promise<unknown>) | undefined;
    const resolveConnection = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:43123',
      token: 'local-token',
    }));
    registerEmbeddedConnectionHandler(
      {
        handle: (_channel, next) => {
          handler = next;
        },
      },
      {
        resolveConnection,
        isTrustedSender: (sender) => sender === 'trusted-window',
      },
    );

    await expect(handler?.({ sender: 'untrusted-window' })).rejects.toThrow(/Nicht vertrauenswürdig/);
    expect(resolveConnection).not.toHaveBeenCalled();
    await expect(handler?.({ sender: 'trusted-window' })).resolves.toEqual({
      baseUrl: 'http://127.0.0.1:43123',
      token: 'local-token',
    });
  });
});
