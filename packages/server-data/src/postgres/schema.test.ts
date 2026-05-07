import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const initialSchemaUrl = new URL('./sql/0000_server_data.sql', import.meta.url);
const releasedReservationMigrationUrl = new URL('./sql/0002_server_data_released_number_reservations.sql', import.meta.url);

const expectedPartialUniqueIndex = `CREATE UNIQUE INDEX IF NOT EXISTS number_reservations_tenant_id_kind_number_key
  ON number_reservations (tenant_id, kind, number)
  WHERE status <> 'released';`;

test('initial server schema only enforces number reservation uniqueness for unreleased rows', async () => {
  const sql = await readFile(initialSchemaUrl, 'utf8');

  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS number_reservations_tenant_id_kind_number_key/);
  assert.match(sql, /WHERE status <> 'released';/);
  assert.doesNotMatch(sql, /UNIQUE \(tenant_id, kind, number\)/);
});

test('released reservation migration replaces the old constraint with the partial unique index', async () => {
  const sql = await readFile(releasedReservationMigrationUrl, 'utf8');

  assert.match(sql, /DROP CONSTRAINT IF EXISTS number_reservations_tenant_id_kind_number_key/);
  assert.match(sql, /DROP INDEX IF EXISTS number_reservations_tenant_id_kind_number_key/);
  assert.match(sql, new RegExp(expectedPartialUniqueIndex.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\\s+')));
});
