import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createSingleTenantScope } from '@billme/server-core';
import { createPostgresPool } from './connection.js';
import { createPostgresProAccountingRepository } from './proAccountingRepository.js';
import { tenantCoreRowCountTables } from './billing.js';
import {
  desktopSqliteIgnoredTables,
  desktopSqliteImportedTables,
  detectUnsupportedSqliteTables,
  importDesktopSqliteToPostgres,
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
  new URL('../../drizzle/0005_server_data_audit_heads.sql', import.meta.url),
  new URL('../../drizzle/0006_server_data_opos.sql', import.meta.url),
  new URL('../../drizzle/0007_server_data_opos_hardening.sql', import.meta.url),
  new URL('../../drizzle/0008_server_data_asset_accounting.sql', import.meta.url),
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
  const excludedTables = new Set(['tenant_memberships', 'sqlite_import_runs', 'audit_heads']);
  const expected = tenantScopedTables.filter((table) => !excludedTables.has(table)).sort();

  assert.deepEqual([...tenantCoreRowCountTables].sort(), expected);
});

test('Drizzle migration journal contains incremental migrations', async () => {
  const journal = JSON.parse(await readFile(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as { entries: Array<{ tag: string }> };
  assert.deepEqual(journal.entries.map((entry) => entry.tag), [
    '0000_server_data', '0001_server_data_pro_accounting', '0002_server_data_assets',
    '0003_server_data_offer_items', '0004_server_data_tax_rules', '0005_server_data_audit_heads', '0006_server_data_opos', '0007_server_data_opos_hardening', '0008_server_data_asset_accounting', '0009_server_data_datev_export_bytes', '0010_server_data_invoice_accounting_posted_at', '0011_server_data_tax_case_mapping_tenancy',
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

test('SQLite import preserves posted outgoing/incoming accounting metadata and line ordering', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const pool = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const tenantId = `import-accounting-${randomUUID()}`;
  const outgoingId = `outgoing-${randomUUID()}`;
  const incomingId = `incoming-${randomUUID()}`;
  const vendorId = `vendor-${randomUUID()}`;
  const now = new Date().toISOString();
  const outgoingSnapshot = JSON.stringify({ sourceVersion: 'sqlite-outgoing-posted', grossAmount: 119 });
  const incomingSnapshot = JSON.stringify({ sourceVersion: 'sqlite-incoming-posted', grossAmount: 119 });
  const tempDir = await mkdtemp(path.join(tmpdir(), 'billme-import-'));
  const sqlitePath = path.join(tempDir, 'source.sqlite');
  const sqlite = new Database(sqlitePath);
  try {
    sqlite.exec(`
      CREATE TABLE invoices (id TEXT PRIMARY KEY, client_id TEXT, client_number TEXT, project_id TEXT, number TEXT, client TEXT, client_email TEXT, client_address TEXT, billing_address_json TEXT, shipping_address_json TEXT, tax_mode TEXT, tax_meta_json TEXT, tax_snapshot_json TEXT, accounting_status TEXT, accounting_snapshot_json TEXT, accounting_journal_entry_id TEXT, accounting_posted_at TEXT, date TEXT, due_date TEXT, service_period TEXT, amount REAL, status TEXT, dunning_level INTEGER, created_at TEXT, updated_at TEXT);
      CREATE TABLE invoice_items (invoice_id TEXT, position INTEGER, description TEXT, article_id TEXT, category TEXT, tax_rate REAL, quantity REAL, price REAL, total REAL, line_meta_json TEXT);
      CREATE TABLE invoice_payments (id TEXT, invoice_id TEXT, date TEXT, amount REAL, method TEXT);
      CREATE TABLE vendors (id TEXT PRIMARY KEY, tenant_id TEXT, vendor_number TEXT, name TEXT, email TEXT, address TEXT, vat_id TEXT, iban TEXT, default_expense_account TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE incoming_invoices (id TEXT PRIMARY KEY, tenant_id TEXT, vendor_id TEXT, number TEXT, invoice_date TEXT, due_date TEXT, service_period TEXT, net_amount REAL, tax_amount REAL, gross_amount REAL, status TEXT, tax_rate REAL, tax_case_key TEXT, notes TEXT, accounting_status TEXT, accounting_snapshot_json TEXT, accounting_journal_entry_id TEXT, accounting_posted_at TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE incoming_invoice_lines (id TEXT PRIMARY KEY, tenant_id TEXT, incoming_invoice_id TEXT, position INTEGER, description TEXT, quantity REAL, unit_price REAL, net_amount REAL, tax_rate REAL, tax_amount REAL, gross_amount REAL, account_number TEXT, asset_account_number TEXT);
    `);
    sqlite.prepare(`INSERT INTO invoices (id,number,client,client_email,tax_mode,accounting_status,accounting_snapshot_json,accounting_journal_entry_id,accounting_posted_at,date,due_date,amount,status,dunning_level,created_at,updated_at) VALUES (?,?,?,?,?,'posted',?,?,?,'2026-08-12','2026-08-31',119,'open',0,?,?)`).run(outgoingId, 'RE-IMPORT-OUT', 'Imported customer', 'customer@example.test', 'standard_vat', outgoingSnapshot, 'outgoing-journal', '2026-08-12T12:00:00.000Z', now, now);
    sqlite.prepare(`INSERT INTO invoice_items VALUES (?,?,?,?,?,?,?,?,?,?)`).run(outgoingId, 0, 'Service', null, null, 19, 1, 100, 119, null);
    sqlite.prepare(`INSERT INTO vendors VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(vendorId, 'source-tenant', 'V-IMPORT', 'Imported vendor', 'vendor@example.test', null, null, null, null, now, now);
    sqlite.prepare(`INSERT INTO incoming_invoices VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(incomingId, 'source-tenant', vendorId, 'ER-IMPORT-IN', '2026-08-12', '2026-08-31', null, 100, 19, 119, 'open', 19, null, null, 'posted', incomingSnapshot, 'incoming-journal', '2026-08-12T13:00:00.000Z', now, now);
    sqlite.prepare(`INSERT INTO incoming_invoice_lines VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('incoming-line-1', 'source-tenant', incomingId, 0, 'Service', 1, 100, 100, 19, 19, 119, '8400', null);
    sqlite.close();

    const result = await importDesktopSqliteToPostgres({ pool, sqlitePath, product: 'pro', tenant: { id: tenantId, slug: tenantId, displayName: 'Import accounting test' } });
    assert.equal(result.counts.invoices, 1);
    assert.equal(result.counts.incomingInvoices, 1);
    const outgoing = (await pool.query('SELECT accounting_status,accounting_snapshot_json,accounting_journal_entry_id,accounting_posted_at FROM invoices WHERE tenant_id=$1 AND id=$2', [tenantId, outgoingId])).rows[0];
    const incoming = (await pool.query('SELECT accounting_status,accounting_snapshot_json,accounting_journal_entry_id,accounting_posted_at FROM incoming_invoices WHERE tenant_id=$1 AND id=$2', [tenantId, incomingId])).rows[0];
    assert.deepEqual(outgoing, { accounting_status: 'posted', accounting_snapshot_json: outgoingSnapshot, accounting_journal_entry_id: 'outgoing-journal', accounting_posted_at: '2026-08-12T12:00:00.000Z' });
    assert.deepEqual(incoming, { accounting_status: 'posted', accounting_snapshot_json: incomingSnapshot, accounting_journal_entry_id: 'incoming-journal', accounting_posted_at: '2026-08-12T13:00:00.000Z' });
    assert.equal((await pool.query('SELECT COUNT(*)::int AS count FROM incoming_invoice_lines WHERE tenant_id=$1 AND incoming_invoice_id=$2', [tenantId, incomingId])).rows[0].count, 1);
    const repository = createPostgresProAccountingRepository(pool);
    const scope = createSingleTenantScope(tenantId, 'pro');
    assert.equal((await repository.postOutgoingInvoice(scope, outgoingId)).snapshot?.sourceVersion, 'sqlite-outgoing-posted');
    assert.equal((await repository.postIncomingInvoice(scope, incomingId)).snapshot?.sourceVersion, 'sqlite-incoming-posted');
  } finally {
    if (sqlite.open) sqlite.close();
    await pool.query('DELETE FROM tenants WHERE id=$1', [tenantId]).catch(() => undefined);
    await pool.end();
    await rm(tempDir, { recursive: true, force: true });
  }
});
