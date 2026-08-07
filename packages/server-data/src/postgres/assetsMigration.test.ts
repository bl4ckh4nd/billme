import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const rootUrl = new URL('../../../../', import.meta.url);
const sqliteBootstrapUrl = new URL('apps/pro-desktop/db/bootstrap.ts', rootUrl);
const postgresMigrationUrl = new URL('../../drizzle/0002_server_data_assets.sql', import.meta.url);

const columns = (sql: string, table: string): string[] => {
  const body = sql.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\);`))?.[1];
  assert.ok(body, `Missing ${table}`);
  return body
    .split('\n')
    .map((line) => line.trim().match(/^([a-z_]+)\s/)?.[1])
    .filter((name): name is string => Boolean(name))
    .sort();
};

test('SQLite and Postgres asset table columns stay mirrored', async () => {
  const sqlite = await readFile(sqliteBootstrapUrl, 'utf8');
  const postgres = await readFile(postgresMigrationUrl, 'utf8');

  for (const table of ['assets', 'asset_depreciation_schedule', 'asset_movements']) {
    assert.deepEqual(columns(sqlite, table), columns(postgres, table), table);
  }
});
