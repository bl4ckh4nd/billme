import assert from 'node:assert/strict';
import test from 'node:test';
import type { Pool } from 'pg';
import { isPostgresPool, withSerializablePostgresTransaction, type PostgresQueryable } from './connection';

type FakeClient = {
  query: (sql: string) => Promise<void>;
  release: () => void;
  queries: string[];
  released: boolean;
};

const createClient = (query: FakeClient['query']): FakeClient => {
  const client = {
    query: async (sql: string) => {
      client.queries.push(sql);
      return query(sql);
    },
    release: () => {
      client.released = true;
    },
    queries: [] as string[],
    released: false,
  };
  return client;
};

const createPool = (clients: FakeClient[]): Pool => {
  let connectIndex = 0;
  return {
    connect: async () => clients[connectIndex++]!,
  } as unknown as Pool;
};

test('retries a serialization failure with a fresh client', async () => {
  const first = createClient(async (sql) => {
    if (sql === 'ROLLBACK') return;
  });
  const second = createClient(async () => undefined);
  const pool = createPool([first, second]);
  let workCalls = 0;

  const result = await withSerializablePostgresTransaction(pool, async (client) => {
    workCalls += 1;
    if (workCalls === 1) {
      throw new Error('query failed', {
        cause: Object.assign(new Error('serialization failure'), { code: '40001' }),
      });
    }
    return 'committed';
  });

  assert.equal(result, 'committed');
  assert.equal(workCalls, 2);
  assert.deepEqual(first.queries, ['BEGIN ISOLATION LEVEL SERIALIZABLE', 'ROLLBACK']);
  assert.deepEqual(second.queries, ['BEGIN ISOLATION LEVEL SERIALIZABLE', 'COMMIT']);
  assert.equal(first.released, true);
  assert.equal(second.released, true);
});

test('recognizes pg PoolClient even when it exposes connect', () => {
  const client = {
    connect: async () => { throw new Error('nested connect must not be called'); },
    query: async () => ({ rows: [] }),
    release: () => undefined,
  } as unknown as PostgresQueryable;
  const pool = { connect: async () => client, query: async () => ({ rows: [] }) } as unknown as PostgresQueryable;

  assert.equal(isPostgresPool(client), false);
  assert.equal(isPostgresPool(pool), true);
});

test('does not retry non-transaction errors', async () => {
  const client = createClient(async () => undefined);
  const pool = createPool([client]);
  const error = new Error('query failed', {
    cause: Object.assign(new Error('duplicate key'), { code: '23505' }),
  });
  let workCalls = 0;

  await assert.rejects(
    withSerializablePostgresTransaction(pool, async () => {
      workCalls += 1;
      throw error;
    }),
    (received) => received === error,
  );

  assert.equal(workCalls, 1);
  assert.deepEqual(client.queries, ['BEGIN ISOLATION LEVEL SERIALIZABLE', 'ROLLBACK']);
  assert.equal(client.released, true);
});

test('handles repeated serialization contention within the retry bound', async () => {
  const clients = Array.from({ length: 5 }, () => createClient(async () => undefined));
  const pool = createPool(clients);
  let workCalls = 0;

  const result = await withSerializablePostgresTransaction(pool, async () => {
    workCalls += 1;
    if (workCalls < clients.length) {
      throw Object.assign(new Error('serialization failure'), { code: '40001' });
    }
    return 'committed';
  });

  assert.equal(result, 'committed');
  assert.equal(workCalls, clients.length);
  for (const client of clients) {
    assert.equal(client.released, true);
  }
});
