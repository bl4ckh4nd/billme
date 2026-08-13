import { Pool, type PoolClient, type PoolConfig } from 'pg';

export const readDatabaseUrl = (env: NodeJS.ProcessEnv = process.env): string | null => {
  const value = env.DATABASE_URL?.trim();
  return value && value.length > 0 ? value : null;
};

export const createPostgresPool = (config: string | PoolConfig): Pool => {
  if (typeof config === 'string') {
    return new Pool({ connectionString: config });
  }

  return new Pool(config);
};

export type PostgresQueryable = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;
export type PostgresTransactionClient = PoolClient;

/** Query-only adapters and PoolClients must not be mistaken for a Pool. */
export const isPostgresPool = (target: PostgresQueryable): target is Pool => {
  const candidate = target as Partial<Pick<Pool, 'connect'>> & Partial<Pick<PoolClient, 'release'>>;
  return typeof candidate.connect === 'function' && typeof candidate.release !== 'function';
};

const SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS = 5;
const SERIALIZABLE_TRANSACTION_RETRY_DELAY_MS = 25;
const SERIALIZABLE_TRANSACTION_MAX_RETRY_DELAY_MS = 250;
const SERIALIZABLE_TRANSACTION_RETRY_JITTER_MS = 25;
const MAX_POSTGRES_ERROR_CAUSE_DEPTH = 8;

const isRetryableSerializableTransactionError = (error: unknown): boolean => {
  const seen = new Set<object>();
  let current: unknown = error;

  for (let depth = 0; depth < MAX_POSTGRES_ERROR_CAUSE_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null || seen.has(current)) return false;
    seen.add(current);

    if ('code' in current && (current.code === '40001' || current.code === '40P01')) {
      return true;
    }

    current = 'cause' in current ? current.cause : undefined;
  }

  return false;
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const serializableTransactionRetryDelay = (attempt: number): number => {
  const exponential = Math.min(
    SERIALIZABLE_TRANSACTION_MAX_RETRY_DELAY_MS - SERIALIZABLE_TRANSACTION_RETRY_JITTER_MS,
    SERIALIZABLE_TRANSACTION_RETRY_DELAY_MS * 2 ** (attempt - 1),
  );
  return exponential + Math.floor(Math.random() * SERIALIZABLE_TRANSACTION_RETRY_JITTER_MS);
};

export const withPostgresTransaction = async <T>(
  pool: Pool,
  work: (client: PostgresTransactionClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors and rethrow original problem
    }
    throw error;
  } finally {
    client.release();
  }
};

export const withSerializablePostgresTransaction = async <T>(
  pool: Pool,
  work: (client: PostgresTransactionClient) => Promise<T>,
): Promise<T> => {
  for (let attempt = 1; attempt <= SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS; attempt += 1) {
    const client = await pool.connect();
    let retry = false;
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // ignore rollback errors and rethrow original problem
      }

      retry =
        attempt < SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS &&
        isRetryableSerializableTransactionError(error);
      if (!retry) throw error;
    } finally {
      client.release();
    }

    if (retry) await delay(serializableTransactionRetryDelay(attempt));
  }

  throw new Error('Serializable transaction exhausted retry attempts');
};
