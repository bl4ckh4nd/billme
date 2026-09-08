import assert from 'node:assert/strict';
import test from 'node:test';
import { tryCreateDrizzle } from './drizzle.js';

test('the persistence adapter owns dialect selection', () => {
  const dialect = { marker: 'adapter-owned' };
  const target = {
    query: async () => ({ rows: [] }),
    drizzle: () => dialect,
  };

  assert.strictEqual(tryCreateDrizzle(target), dialect);
});
