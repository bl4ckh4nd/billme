import assert from 'node:assert/strict';
import test from 'node:test';
import { createSingleTenantScope } from '@billme/server-core';
import { createPostgresRecurringProfileRepository } from './billing.js';

test('recurring profile claim query locks the tenant row', async () => {
  const lockModes: string[] = [];
  const builder = {
    select: () => builder,
    from: () => builder,
    where: () => builder,
    limit: () => builder,
    for: (mode: string) => {
      lockModes.push(mode);
      return Promise.resolve([]);
    },
  };
  const repository = createPostgresRecurringProfileRepository({
    query: async () => ({ rows: [] }),
    drizzle: () => builder,
  } as never);

  await repository.getByIdForUpdate?.(
    createSingleTenantScope('recurring-lock-tenant', 'lite'),
    'recurring-lock-profile',
  );

  assert.deepEqual(lockModes, ['update']);
});
