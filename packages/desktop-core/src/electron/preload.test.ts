import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const exposed = new Map<string, unknown>();
  const contextBridge = {
    exposeInMainWorld: vi.fn((name: string, value: unknown) => exposed.set(name, value)),
  };
  const ipcRenderer = {
    invoke: vi.fn(async () => null),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  };
  return { exposed, contextBridge, ipcRenderer };
});

vi.mock('electron', () => ({ contextBridge: mocks.contextBridge, ipcRenderer: mocks.ipcRenderer }));

import { installDesktopPreload } from './preload';

describe('desktop preload installation', () => {
  beforeEach(() => {
    mocks.exposed.clear();
    mocks.contextBridge.exposeInMainWorld.mockClear();
    mocks.ipcRenderer.invoke.mockClear();
  });

  it('keeps the private embedded resolver outside the exposed business API', async () => {
    const businessApi = { settings: { get: vi.fn() } };
    let internal: { embeddedConnectionResolver?: () => Promise<unknown> } | undefined;

    installDesktopPreload({
      routes: {},
      embeddedConnectionChannel: 'embedded:connection',
      createApi: (_invoke, context) => {
        internal = context;
        return businessApi;
      },
    });

    expect(mocks.exposed.get('billmeApi')).toBe(businessApi);
    expect(mocks.exposed.get('billmeApi')).not.toHaveProperty('baseUrl');
    expect(mocks.exposed.get('billmeApi')).not.toHaveProperty('token');
    expect(mocks.exposed.get('billmeApi')).not.toHaveProperty('embeddedConnectionResolver');
    expect(internal?.embeddedConnectionResolver).toBeTypeOf('function');
    await expect(internal?.embeddedConnectionResolver?.()).resolves.toBeNull();
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('embedded:connection');
  });
});
