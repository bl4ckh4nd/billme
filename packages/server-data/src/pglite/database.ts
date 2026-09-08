import { AsyncLocalStorage } from 'node:async_hooks';
import {
  PGlite,
  type PGliteOptions,
  type QueryOptions,
} from '@electric-sql/pglite';
import { assertDrizzleSchemaCurrent, runDrizzleMigrations } from '../postgres/migrations.js';
import { createPgliteDrizzle } from '../postgres/drizzle.js';
import type {
  ServerDatabase,
  ServerDatabaseSession,
  ServerQueryResult,
  ServerTransactionOptions,
} from '../database.js';

interface PgliteTransaction {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
    options?: QueryOptions,
  ): Promise<ServerQueryResult<Row>>;
  exec?(query: string, options?: unknown): Promise<unknown>;
}

// PGlite 0.5 keeps this type internal although it is part of the public
// dumpDataDir signature. Keep the adapter compatible with the installed API.
type DumpTarCompression = 'none' | 'gzip' | 'auto';

const createSession = (target: PgliteTransaction): ServerDatabaseSession => {
  const session = {
    drizzle: () => createPgliteDrizzle(target as PGlite),
    query: async <Row = Record<string, unknown>>(
      text: string,
      values?: readonly unknown[],
      driverOptions?: unknown,
    ) => (await target.query<Row>(
      text,
      values ? [...values] : undefined,
      driverOptions as QueryOptions | undefined,
    )) as ServerQueryResult<Row>,
  } as ServerDatabaseSession & { exec?: PgliteTransaction['exec'] };
  if (target.exec) {
    session.exec = target.exec.bind(target);
  }
  return session;
};

/**
 * Direct, single-instance PGlite adapter for the embedded server runtime.
 *
 * PGlite is deliberately not exposed through its socket protocol here. Every
 * operation enters one FIFO, while queries issued from the active transaction
 * context reuse that transaction and therefore cannot deadlock behind itself.
 */
export class PgliteServerDatabase implements ServerDatabase {
  readonly engine = 'pglite' as const;

  private readonly transactionContext = new AsyncLocalStorage<PgliteTransaction>();
  private operationQueue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(readonly client: PGlite) {}

  static async open(dataDir?: string, options?: PGliteOptions): Promise<PgliteServerDatabase> {
    const client = new PGlite(dataDir, options);
    await client.waitReady;
    return new PgliteServerDatabase(client);
  }

  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
    driverOptions?: unknown,
  ): Promise<ServerQueryResult<Row>> {
    const transaction = this.transactionContext.getStore();
    if (transaction) return createSession(transaction).query<Row>(text, values, driverOptions);

    this.assertOpen();
    return this.enqueue(() => this.client.query<Row>(
      text,
      values ? [...values] : undefined,
      driverOptions as QueryOptions | undefined,
    ));
  }

  drizzle(): unknown {
    const activeTransaction = this.transactionContext.getStore();
    return activeTransaction
      ? createSession(activeTransaction).drizzle()
      : createPgliteDrizzle(this.client);
  }

  transaction<T>(
    options: ServerTransactionOptions,
    work: (session: ServerDatabaseSession) => Promise<T>,
  ): Promise<T> {
    const activeTransaction = this.transactionContext.getStore();
    if (activeTransaction) {
      // PGlite does not expose nested savepoints through its transaction
      // callback. Reuse the active transaction instead of queueing behind it.
      return work(createSession(activeTransaction));
    }

    this.assertOpen();
    return this.enqueue(() =>
      this.client.transaction(async (transaction) => {
        const session = createSession(transaction);
        return this.transactionContext.run(transaction, async () => {
          if (options.isolation === 'serializable') {
            await session.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
          }
          return work(session);
        });
      }),
    );
  }

  migrate(): Promise<void> {
    this.assertLifecycleOperationAllowed();
    return this.enqueue(async () => {
      await runDrizzleMigrations(this.client);
    });
  }

  assertCurrent(): Promise<void> {
    this.assertLifecycleOperationAllowed();
    return this.enqueue(async () => {
      await assertDrizzleSchemaCurrent(this.client);
    });
  }

  dumpDataDir(compression: DumpTarCompression = 'none'): Promise<Blob | File> {
    this.assertLifecycleOperationAllowed();
    return this.enqueue(() => this.client.dumpDataDir(compression));
  }

  close(): Promise<void> {
    if (this.transactionContext.getStore()) {
      return Promise.reject(new Error('Cannot close PGlite while a transaction is active'));
    }
    if (this.closePromise) return this.closePromise;

    this.closed = true;
    this.closePromise = this.enqueueRaw(async () => {
      await this.client.close();
    });
    return this.closePromise;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    this.assertOpen();
    return this.enqueueRaw(operation);
  }

  private enqueueRaw<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(async () => {
      await this.client.waitReady;
      return operation();
    });
    this.operationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private assertOpen(): void {
    if (this.closed || this.client.closed) {
      throw new Error('PGlite database is closed');
    }
  }

  private assertLifecycleOperationAllowed(): void {
    this.assertOpen();
    if (this.transactionContext.getStore()) {
      throw new Error('Cannot run a database lifecycle operation inside a transaction');
    }
  }
}

export const createPgliteServerDatabase = async (
  dataDir?: string,
  options?: PGliteOptions,
): Promise<PgliteServerDatabase> => PgliteServerDatabase.open(dataDir, options);
