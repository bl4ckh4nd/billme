import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { tenantCoreRowCountTables } from './billing.js';
import {
  desktopSqliteIgnoredTables,
  desktopSqliteImportedTables,
  detectUnsupportedSqliteTables,
} from './importDesktop.js';

const rootUrl = new URL('../../../../', import.meta.url);
const liteDesktopSchemaUrl = new URL('apps/desktop/db/schema.ts', rootUrl);
const proDesktopSchemaUrl = new URL('apps/pro-desktop/db/schema.ts', rootUrl);
const postgresMigrationUrls = [
  new URL('../../drizzle/0000_server_data.sql', import.meta.url),
  new URL('../../drizzle/0001_server_data_pro_accounting.sql', import.meta.url),
  new URL('../../drizzle/0002_server_data_assets.sql', import.meta.url),
  new URL('../../drizzle/0003_server_data_offer_items.sql', import.meta.url),
  new URL('../../drizzle/0004_server_data_tax_rules.sql', import.meta.url),
];

const extractSqliteTableNames = async (schemaUrl: URL): Promise<string[]> => {
  const schema = await readFile(schemaUrl, 'utf8');
  return [...schema.matchAll(/sqliteTable\(\s*'([a-z_]+)'/g)].map((match) => match[1]);
};

const extractTenantScopedPostgresTables = async (migrationUrls: URL[]): Promise<string[]> => {
  const tables = new Set<string>();
  for (const migrationUrl of migrationUrls) {
    const sql = await readFile(migrationUrl, 'utf8');
    for (const match of sql.matchAll(/CREATE TABLE IF NOT EXISTS ([a-z_]+) \(([\s\S]*?)\);/g)) {
      if (/\btenant_id\b/.test(match[2])) {
        tables.add(match[1]);
      }
    }
  }
  return [...tables].sort();
};

test('detectUnsupportedSqliteTables ignores newly supported populated tables', () => {
  const counts = new Map<string, number>([
    ['clients', 3],
    ['ledger_accounts', 5],
    ['templates', 2],
    ['articles', 7],
    ['account_suggestion_rules', 4],
    ['eur_lines', 9],
    ['sqlite_sequence', 1],
    ['migration_log', 10],
  ]);

  const result = detectUnsupportedSqliteTables([...counts.keys()], (table) => counts.get(table) ?? 0);

  assert.deepEqual(result, []);
});

test('detectUnsupportedSqliteTables still reports unknown populated tables only', () => {
  const counts = new Map<string, number>([
    ['clients', 3],
    ['custom_side_table', 2],
    ['sqlite_sequence', 1],
  ]);

  const result = detectUnsupportedSqliteTables([...counts.keys()], (table) => counts.get(table) ?? 0);

  assert.deepEqual(result, [{ table: 'custom_side_table', rowCount: 2 }]);
});

test('desktop sqlite onboarding schemas stay mapped to import coverage', async () => {
  const liteTables = await extractSqliteTableNames(liteDesktopSchemaUrl);
  const proTables = await extractSqliteTableNames(proDesktopSchemaUrl);

  const expected = [...new Set([
    ...liteTables,
    ...proTables,
    ...desktopSqliteIgnoredTables,
  ])].sort();
  const actual = [...new Set([
    ...desktopSqliteImportedTables,
    ...desktopSqliteIgnoredTables,
  ])].sort();

  assert.deepEqual(actual, expected);
});

test('desktop sqlite onboarding only ignores explicit safe metadata tables', () => {
  assert.deepEqual([...desktopSqliteIgnoredTables], ['migration_log']);
});

test('tenant-scoped postgres tables stay covered by import overwrite guards', async () => {
  const tenantScopedTables = await extractTenantScopedPostgresTables(postgresMigrationUrls);
  const excludedTables = new Set(['tenant_memberships', 'sqlite_import_runs']);
  const expected = tenantScopedTables.filter((table) => !excludedTables.has(table)).sort();

  assert.deepEqual([...tenantCoreRowCountTables].sort(), expected);
});

test('Drizzle migration journal contains incremental migrations', async () => {
  const journal = JSON.parse(await readFile(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as { entries: Array<{ tag: string }> };
  assert.deepEqual(journal.entries.map((entry) => entry.tag), [
    '0000_server_data', '0001_server_data_pro_accounting', '0002_server_data_assets',
    '0003_server_data_offer_items', '0004_server_data_tax_rules', '0005_server_data_audit_heads',
  ]);
});

test('tax columns are present in both incremental migration files', async () => {
  const sql = await readFile(new URL('../../drizzle/0004_server_data_tax_rules.sql', import.meta.url), 'utf8');
  for (const table of ['clients', 'invoices', 'offers', 'recurring_profiles']) {
    assert.match(sql, new RegExp(`ALTER TABLE ${table} ADD COLUMN`), table);
  }
  assert.match(sql, /tax_profile_json/);
  assert.match(sql, /tax_mode/);
  assert.match(sql, /tax_meta_json/);
  assert.match(sql, /tax_snapshot_json/);
});
