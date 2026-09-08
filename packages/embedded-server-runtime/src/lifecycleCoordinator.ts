import type { EmbeddedServerHandle } from './embedded-server.js';

export type EmbeddedLifecycleState = 'running' | 'restoring' | 'closing' | 'closed';

export class EmbeddedLifecycleError extends Error {
  constructor(message = 'Das eingebettete PGlite-Backend ist nicht verfügbar.') {
    super(message);
    this.name = 'EmbeddedLifecycleError';
  }
}

export interface EmbeddedRuntimeCoordinator<TResult = unknown> {
  readonly connection: () => { baseUrl: string; token: string } | null;
  readonly dumpDataDir: () => Promise<Blob | File>;
  readonly restoreDataDir: (archivePath: string) => Promise<TResult>;
  readonly close: () => Promise<void>;
  readonly state: () => EmbeddedLifecycleState;
}

export interface EmbeddedRuntimeCoordinatorOptions<TResult> {
  readonly start: () => Promise<EmbeddedServerHandle>;
  readonly restore: (archivePath: string) => Promise<TResult>;
}

type QueueTask<T> = () => Promise<T> | T;

/**
 * Owns the lifetime of one embedded server handle. Dumps, restores, and close
 * all use one FIFO. A failed restore restarts the server before rethrowing the
 * validation error, unless shutdown was requested while the restore ran.
 */
export const startEmbeddedRuntimeCoordinator = async <TResult>(
  options: EmbeddedRuntimeCoordinatorOptions<TResult>,
): Promise<EmbeddedRuntimeCoordinator<TResult>> => {
  let embedded: EmbeddedServerHandle | undefined = await options.start();
  let lifecycleState: EmbeddedLifecycleState = 'running';
  let closeRequested = false;
  let pendingRestores = 0;
  let queue: Promise<void> = Promise.resolve();
  let closePromise: Promise<void> | undefined;

  const enqueue = <T>(task: QueueTask<T>): Promise<T> => {
    const result = queue.then(task, task);
    queue = result.then((): void => undefined, (): void => undefined);
    return result;
  };

  const unavailable = (): Promise<never> => Promise.reject(new EmbeddedLifecycleError());

  const connection = (): { baseUrl: string; token: string } | null => {
    if (lifecycleState !== 'running' || pendingRestores > 0) return null;
    return embedded ? { baseUrl: embedded.baseUrl, token: embedded.accessToken } : null;
  };

  const dumpDataDir = (): Promise<Blob | File> => {
    if (lifecycleState !== 'running' || pendingRestores > 0 || !embedded) return unavailable();
    return enqueue(async () => {
      if (lifecycleState !== 'running' || !embedded) throw new EmbeddedLifecycleError();
      return embedded.dumpDataDir();
    });
  };

  const restoreDataDir = (archivePath: string): Promise<TResult> => {
    if (lifecycleState === 'closed' || lifecycleState === 'closing' || closeRequested) return unavailable();
    pendingRestores += 1;
    return enqueue(async () => {
      pendingRestores -= 1;
      if (lifecycleState === 'closed' || lifecycleState === 'closing' || closeRequested) {
        throw new EmbeddedLifecycleError('Die Wiederherstellung wurde durch das Herunterfahren abgebrochen.');
      }

      lifecycleState = 'restoring';
      const current = embedded;
      embedded = undefined;
      if (!current) throw new EmbeddedLifecycleError();
      let result: TResult;
      try {
        await current.close();
        if (closeRequested) {
          lifecycleState = 'closed';
          throw new EmbeddedLifecycleError('Die Wiederherstellung wurde durch das Herunterfahren abgebrochen.');
        }
        result = await options.restore(archivePath);
      } catch (error) {
        if (closeRequested) {
          lifecycleState = 'closed';
          throw error;
        }
        try {
          embedded = await options.start();
          lifecycleState = 'running';
        } catch {
          lifecycleState = 'closed';
        }
        throw error;
      }

      // The native restore route relaunches the process after the invoke
      // response. Keep the runtime stopped until that relaunch completes.
      lifecycleState = 'closed';
      return result;
    });
  };

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closeRequested = true;
    lifecycleState = 'closing';
    closePromise = enqueue(async () => {
      const current = embedded;
      embedded = undefined;
      lifecycleState = 'closed';
      if (current) await current.close();
    });
    return closePromise;
  };

  return { connection, dumpDataDir, restoreDataDir, close, state: () => lifecycleState };
};
