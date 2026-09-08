import { AsyncLocalStorage } from 'node:async_hooks';
import type { Pool } from 'pg';
import {
  withPostgresTransaction,
  withSerializablePostgresTransaction,
  type PostgresQueryable,
  type PostgresTransactionClient,
} from './connection.js';
import { createDrizzle } from './drizzle.js';
import { assertDrizzleSchemaCurrent, runDrizzleMigrations } from './migrations.js';
import type {
  ServerDatabase,
  ServerDatabaseSession,
  ServerQueryResult,
  ServerTransactionOptions,
} from '../database.js';

const createSession = (target: PostgresQueryable): ServerDatabaseSession => ({
  drizzle: () => createDrizzle(target as Parameters<typeof createDrizzle>[0]),
  query: async <Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) =>
    (await target.query(text, values ? [...values] : undefined)) as unknown as ServerQueryResult<Row>,
});

/** PostgreSQL adapter for the shared server persistence seam. */
export class PostgresServerDatabase implements ServerDatabase {
  readonly engine = 'postgres' as const;
  private readonly transactionContext = new AsyncLocalStorage<ServerDatabaseSession>();

  constructor(readonly pool: Pool) {}

  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
    _driverOptions?: unknown,
  ): Promise<ServerQueryResult<Row>> {
    return createSession(this.pool).query<Row>(text, values);
  }

  drizzle(): unknown {
    const activeSession = this.transactionContext.getStore();
    return activeSession?.drizzle() ?? createDrizzle(this.pool);
  }

  transaction<T>(
    options: ServerTransactionOptions,
    work: (session: ServerDatabaseSession) => Promise<T>,
  ): Promise<T> {
    const activeSession = this.transactionContext.getStore();
    if (activeSession) return work(activeSession);

    const run = (client: PostgresTransactionClient): Promise<T> => {
      const session = createSession(client);
      return this.transactionContext.run(session, () => work(session));
    };
    return options.isolation === 'serializable'
      ? withSerializablePostgresTransaction(this.pool, run)
      : withPostgresTransaction(this.pool, run);
  }

  migrate(): Promise<void> {
    return runDrizzleMigrations(this.pool);
  }

  assertCurrent(): Promise<void> {
    return assertDrizzleSchemaCurrent(this.pool);
  }

  close(): Promise<void> {
    return this.pool.end();
  }
}

export const createPostgresServerDatabase = (pool: Pool): PostgresServerDatabase =>
  new PostgresServerDatabase(pool);
