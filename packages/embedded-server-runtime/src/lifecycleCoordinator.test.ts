import { describe, expect, it, vi } from 'vitest';
import {
  startEmbeddedRuntimeCoordinator,
  type EmbeddedServerHandle,
} from '@billme/embedded-server-runtime';

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createHandle = (id: string, events: string[]): EmbeddedServerHandle => ({
  baseUrl: `http://127.0.0.1:${id === 'initial' ? 41001 : 41002}`,
  accessToken: `${id}-token`,
  dumpDataDir: vi.fn(async () => {
    events.push(`${id}:dump`);
    return new Blob([id]);
  }),
  close: vi.fn(async () => {
    events.push(`${id}:close`);
  }),
});

describe('startEmbeddedRuntimeCoordinator', () => {
  it('serializes a dump before close and hides the connection once shutdown is requested', async () => {
    const events: string[] = [];
    const dumpStarted = deferred();
    const releaseDump = deferred();
    const handle = createHandle('initial', events);
    vi.mocked(handle.dumpDataDir).mockImplementation(async () => {
      events.push('initial:dump-start');
      dumpStarted.resolve();
      await releaseDump.promise;
      events.push('initial:dump-end');
      return new Blob(['dump']);
    });
    const coordinator = await startEmbeddedRuntimeCoordinator({
      start: async () => handle,
      restore: async () => ({ ok: true }),
    });

    const dump = coordinator.dumpDataDir();
    await dumpStarted.promise;
    const close = coordinator.close();
    expect(coordinator.state()).toBe('closing');
    expect(coordinator.connection()).toBeNull();
    releaseDump.resolve();
    await Promise.all([dump, close]);

    expect(events).toEqual(['initial:dump-start', 'initial:dump-end', 'initial:close']);
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(coordinator.state()).toBe('closed');
  });

  it('serializes restore after an active dump and leaves the runtime stopped for relaunch', async () => {
    const events: string[] = [];
    const dumpStarted = deferred();
    const releaseDump = deferred();
    const handle = createHandle('initial', events);
    vi.mocked(handle.dumpDataDir).mockImplementation(async () => {
      events.push('initial:dump-start');
      dumpStarted.resolve();
      await releaseDump.promise;
      events.push('initial:dump-end');
      return new Blob(['dump']);
    });
    const restore = vi.fn(async () => {
      events.push('restore');
      return { ok: true as const };
    });
    const coordinator = await startEmbeddedRuntimeCoordinator({
      start: async () => handle,
      restore,
    });

    const dump = coordinator.dumpDataDir();
    await dumpStarted.promise;
    const restored = coordinator.restoreDataDir('/tmp/archive.pglite.tar');
    expect(coordinator.connection()).toBeNull();
    releaseDump.resolve();

    await expect(dump).resolves.toBeInstanceOf(Blob);
    await expect(restored).resolves.toEqual({ ok: true });
    expect(events).toEqual(['initial:dump-start', 'initial:dump-end', 'initial:close', 'restore']);
    expect(restore).toHaveBeenCalledWith('/tmp/archive.pglite.tar');
    expect(coordinator.connection()).toBeNull();
    expect(coordinator.state()).toBe('closed');
  });

  it('restarts a valid server after a failed restore', async () => {
    const events: string[] = [];
    const initial = createHandle('initial', events);
    const restarted = createHandle('restarted', events);
    const start = vi.fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(restarted);
    const restore = vi.fn(async () => {
      throw new Error('Restore-Archiv enthält eine ungültige Audit-Kette.');
    });
    const coordinator = await startEmbeddedRuntimeCoordinator({ start, restore });

    await expect(coordinator.restoreDataDir('/tmp/invalid.pglite.tar'))
      .rejects.toThrow('ungültige Audit-Kette');
    expect(initial.close).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(2);
    expect(coordinator.connection()).toEqual({ baseUrl: restarted.baseUrl, token: restarted.accessToken });
    expect(coordinator.state()).toBe('running');
    await coordinator.close();
    expect(restarted.close).toHaveBeenCalledTimes(1);
  });

  it('lets shutdown win over a failed restore without restarting the server', async () => {
    const events: string[] = [];
    const initial = createHandle('initial', events);
    const restoreStarted = deferred();
    const failRestore = deferred<never>();
    const start = vi.fn(async () => initial);
    const restore = vi.fn(async () => {
      restoreStarted.resolve();
      return failRestore.promise;
    });
    const coordinator = await startEmbeddedRuntimeCoordinator({ start, restore });

    const restoring = coordinator.restoreDataDir('/tmp/invalid.pglite.tar');
    await restoreStarted.promise;
    const closing = coordinator.close();
    failRestore.reject(new Error('restore failed'));

    await expect(restoring).rejects.toThrow('restore failed');
    await expect(closing).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledTimes(1);
    expect(coordinator.connection()).toBeNull();
    expect(coordinator.state()).toBe('closed');
  });
});
