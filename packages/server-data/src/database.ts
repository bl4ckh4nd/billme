/** The engines that can back the shared server runtime. */
export type ServerDatabaseEngine = 'postgres' | 'pglite';

export interface ServerQueryField {
  readonly name: string;
  readonly dataTypeID?: number;
}

/** The small query result surface shared by PostgreSQL and PGlite. */
export interface ServerQueryResult<Row = Record<string, unknown>> {
  readonly rows: Row[];
  readonly command?: string;
  readonly rowCount?: number | null;
  readonly affectedRows?: number;
  readonly fields?: readonly ServerQueryField[];
}

export interface ServerDatabaseSession {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
    driverOptions?: unknown,
  ): Promise<ServerQueryResult<Row>>;

  /**
   * Dialect factory owned by the adapter. Transaction sessions use
   * this to keep Drizzle on the same connection instead of re-discovering a
   * driver from its shape.
   */
  readonly drizzle: () => unknown;
}

export interface ServerTransactionOptions {
  readonly isolation?: 'read-committed' | 'serializable';
}

/**
 * Shared persistence seam for the embedded and remote server runtimes.
 *
 * Implementations serialize lifecycle operations and guarantee that the
 * session passed to a transaction uses the same underlying transaction for
 * every query. Callers must not retain a transaction session after `work`
 * resolves or rejects.
 */
export interface ServerDatabase extends ServerDatabaseSession {
  readonly engine: ServerDatabaseEngine;

  /** Select the matching Drizzle dialect for this persistence adapter. */
  readonly drizzle: () => unknown;

  transaction<T>(
    options: ServerTransactionOptions,
    work: (session: ServerDatabaseSession) => Promise<T>,
  ): Promise<T>;

  migrate(): Promise<void>;
  assertCurrent(): Promise<void>;
  close(): Promise<void>;
}
