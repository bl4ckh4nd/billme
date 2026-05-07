import assert from 'node:assert/strict';
import test from 'node:test';
import { getServerSettings } from './billing.js';
import type { PostgresQueryable } from './connection.js';

test('getServerSettings can lock the settings row for reservation flows', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params: params ?? [] });
      return {
        rows: [
          {
            tenant_id: 'tenant-1',
            settings_json: '{"numbers":{"nextInvoiceNumber":1}}',
            created_at: '2026-05-07T00:00:00.000Z',
            updated_at: '2026-05-07T00:00:00.000Z',
          },
        ],
      };
    },
  } as unknown as PostgresQueryable;

  const result = await getServerSettings(db, 'tenant-1', { forUpdate: true });

  assert.equal(result?.tenantId, 'tenant-1');
  assert.match(queries[0]?.sql ?? '', /FROM server_settings/);
  assert.match(queries[0]?.sql ?? '', /FOR UPDATE/);
  assert.deepEqual(queries[0]?.params, ['tenant-1']);
});
