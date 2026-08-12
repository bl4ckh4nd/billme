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

const SERIALIZABLE_TRANSACTION_MAX_ATTEMPTS = 3;
const SERIALIZABLE_TRANSACTION_RETRY_DELAY_MS = 5;

const isRetryableSerializableTransactionError = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }

  return error.code === '40001' || error.code === '40P01';
};

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

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

    if (retry) await delay(SERIALIZABLE_TRANSACTION_RETRY_DELAY_MS);
  }

  throw new Error('Serializable transaction exhausted retry attempts');
};
