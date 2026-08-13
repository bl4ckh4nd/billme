import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import Database from 'better-sqlite3';
import { createSingleTenantScope } from '@billme/server-core';
import { EUR_SOURCE_VERSION_2025, getCatalogForYear } from '@billme/desktop-services/eurCatalog';
import { createPostgresAuditLogPort, sha256Hex, stableStringify } from './audit.js';
import { createPostgresPool } from './connection.js';
import { runPostgresMigrations } from './migrations.js';
import { createPostgresProAccountingRepository } from './proAccountingRepository.js';
import { saveServerAccountMappingHgb, saveServerReportAccountMapping } from './proAccounting.js';
import { tenantCoreRowCountTables } from './billing.js';
import {
  desktopSqliteIgnoredTables,
  desktopSqliteImportedTables,
  detectUnsupportedSqliteTables,
  assertNoCrossTenantIdentityCollisions,
  importDesktopSqliteToPostgres,
  loadAccountMappingsHgb,
  loadLegacyAccountMappingsHgb,
  maxAuditHead,
  validateCanonicalEurLines,
} from './importDesktop.js';
import type { ServerEurLineRecord, ServerReportAccountMappingRecord } from './proAccounting.js';

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
  new URL('../../drizzle/0009_server_data_datev_export_bytes.sql', import.meta.url),
  new URL('../../drizzle/0010_server_data_invoice_accounting_posted_at.sql', import.meta.url),
  new URL('../../drizzle/0011_server_data_tax_case_mapping_tenancy.sql', import.meta.url),
  new URL('../../drizzle/0012_server_data_asset_ownership_guard.sql', import.meta.url),
  new URL('../../drizzle/0013_server_data_asset_ownership_hardening.sql', import.meta.url),
  new URL('../../drizzle/0014_server_data_datev_tax_evidence.sql', import.meta.url),
  new URL('../../drizzle/0015_server_data_reporting_tax_submissions.sql', import.meta.url),
  new URL('../../drizzle/0016_server_data_eur_native.sql', import.meta.url),
  new URL('../../drizzle/0017_server_data_eur_catalog.sql', import.meta.url),
  new URL('../../drizzle/0018_server_data_canonical_catalog.sql', import.meta.url),
  new URL('../../drizzle/0019_server_data_audit_tenant_hash.sql', import.meta.url),
  new URL('../../drizzle/0021_server_data_eur_facts.sql', import.meta.url),
  new URL('../../drizzle/0022_server_data_accounting_source_runs.sql', import.meta.url),
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

test('SQLite audit head selection uses the maximum sequence independent of row order', () => {
  assert.deepEqual(maxAuditHead([{ sequence: 2, hash: 'hash-2' }, { sequence: 1, hash: 'hash-1' }]), { sequence: 2, hash: 'hash-2' });
});

test('SQLite import rejects tenant-owned mutations of the global EÜR catalog', () => {
  const rows = getCatalogForYear(2025).map((line, sortOrder): ServerEurLineRecord => ({
    id: line.id,
    taxYear: line.year,
    kennziffer: line.kennziffer,
    providerPath: line.providerPath,
    label: line.label,
    kind: line.kind,
    exportable: line.exportable,
    sortOrder,
    computedFromJson: JSON.stringify(line.computedFromIds ?? []),
    computedTermsJson: JSON.stringify(line.computedTerms ?? []),
    sourceVersion: EUR_SOURCE_VERSION_2025,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
  }));
  validateCanonicalEurLines(rows);
  rows[0].label = 'tampered';
  assert.throws(() => validateCanonicalEurLines(rows), /does not match canonical 2025 catalog/);
});

test('Desktop reporting mappings preserve effective-date history and legacy SQLite schemas', () => {
  const current = new Database(':memory:');
  current.exec(`CREATE TABLE account_mappings_hgb (id TEXT PRIMARY KEY, tenant_id TEXT, chart TEXT, account_number TEXT, statement_type TEXT, position_key TEXT, position_label TEXT, balance_side TEXT, valid_from TEXT, updated_at TEXT)`);
  const insert = current.prepare('INSERT INTO account_mappings_hgb VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insert.run('map-2025', 'desktop', 'SKR03', '8400', 'hgb-guv', 'revenue', 'Umsatz', null, '2025-01-01', '2025-01-01T00:00:00.000Z');
  insert.run('map-2026', 'desktop', 'SKR03', '8400', 'hgb-guv', 'material.services', 'Material', null, '2026-01-01', '2026-01-01T00:00:00.000Z');
  const first = loadAccountMappingsHgb(current, 'tenant-import');
  const second = loadAccountMappingsHgb(current, 'tenant-import');
  assert.deepEqual(first.map((row) => ({ validFrom: row.validFrom, positionKey: row.positionKey, version: row.version })), [
    { validFrom: '2025-01-01', positionKey: 'revenue', version: 20250101 },
    { validFrom: '2026-01-01', positionKey: 'material.services', version: 20260101 },
  ]);
  assert.deepEqual(first.map((row) => [row.id, row.sourceHash]), second.map((row) => [row.id, row.sourceHash]));
  const otherTenant = loadAccountMappingsHgb(current, 'other-tenant-import');
  assert.notEqual(first[0]?.id, otherTenant[0]?.id);
  assert.notEqual(first[0]?.sourceHash, otherTenant[0]?.sourceHash);
  current.close();

  const legacy = new Database(':memory:');
  legacy.exec(`CREATE TABLE account_mappings_hgb (id TEXT PRIMARY KEY, tenant_id TEXT, chart TEXT, account_number TEXT, statement_type TEXT, position_key TEXT, position_label TEXT, balance_side TEXT, updated_at TEXT)`);
  legacy.prepare('INSERT INTO account_mappings_hgb VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run('legacy', 'desktop', 'SKR03', '1200', 'guv', 'cash', 'Bank', 'asset', '2024-01-01T00:00:00.000Z');
  assert.deepEqual(loadAccountMappingsHgb(legacy, 'tenant-import'), []);
  const legacyRows = loadLegacyAccountMappingsHgb(legacy, 'tenant-import');
  assert.deepEqual(legacyRows[0], { id: 'legacy', tenantId: 'tenant-import', chart: 'SKR03', accountNumber: '1200', statementType: 'guv', positionKey: 'cash', positionLabel: 'Bank', balanceSide: 'asset', updatedAt: '2024-01-01T00:00:00.000Z' });
  legacy.close();
});

test('Desktop reporting mappings reject impossible and inverted effective dates', () => {
  const invalidDate = new Database(':memory:');
  invalidDate.exec(`CREATE TABLE account_mappings_hgb (id TEXT PRIMARY KEY, chart TEXT, account_number TEXT, statement_type TEXT, position_key TEXT, position_label TEXT, balance_side TEXT, valid_from TEXT, valid_to TEXT, updated_at TEXT)`);
  invalidDate.prepare('INSERT INTO account_mappings_hgb VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('invalid-date', 'SKR03', '8400', 'hgb-guv', 'revenue', 'Umsatz', null, '2026-02-31', null, '2026-01-01T00:00:00.000Z');
  assert.throws(() => loadAccountMappingsHgb(invalidDate, 'tenant-import'), /REPORT_MAPPING_DATE_INVALID/);
  invalidDate.close();

  const inverted = new Database(':memory:');
  inverted.exec(`CREATE TABLE account_mappings_hgb (id TEXT PRIMARY KEY, chart TEXT, account_number TEXT, statement_type TEXT, position_key TEXT, position_label TEXT, balance_side TEXT, valid_from TEXT, valid_to TEXT, updated_at TEXT)`);
  inverted.prepare('INSERT INTO account_mappings_hgb VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('inverted', 'SKR03', '8400', 'hgb-guv', 'revenue', 'Umsatz', null, '2026-12-31', '2026-01-01', '2026-01-01T00:00:00.000Z');
  assert.throws(() => loadAccountMappingsHgb(inverted, 'tenant-import'), /REPORT_MAPPING_INVALID_VALIDITY/);
  inverted.close();
});

test('Postgres report mapping persistence keeps 2025 and 2026 imported overrides idempotent', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const pool = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const suffix = randomUUID();
  const tenantId = `report-import-a-${suffix}`;
  const secondTenantId = `report-import-b-${suffix}`;
  let createdTable = false;
  try {
    createdTable = !(await pool.query(`SELECT to_regclass('public.report_account_mappings') AS name`)).rows[0]?.name;
    if (createdTable) await pool.query(`CREATE TABLE report_account_mappings (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, report_type TEXT NOT NULL, chart TEXT NOT NULL, account_number TEXT NOT NULL, position_key TEXT NOT NULL, position_label TEXT NOT NULL, valid_from TEXT, valid_to TEXT, version INTEGER NOT NULL, source TEXT NOT NULL, source_hash TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL)`);
    if (!createdTable) {
      await pool.query(`INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at) VALUES ($1,$1,'Report import A','pro','single-tenant','active',now()::text,now()::text),($2,$2,'Report import B','pro','single-tenant','active',now()::text,now()::text)`, [tenantId, secondTenantId]);
    }
    const rows: ServerReportAccountMappingRecord[] = [
      { id: `import-${tenantId}-2025`, tenantId, reportType: 'hgb-guv', chart: 'SKR03', accountNumber: '8400', positionKey: 'revenue', positionLabel: 'Umsatz', validFrom: '2025-01-01', version: 20250101, source: 'desktop-import', sourceHash: `hash-${suffix}-2025`, createdAt: '2025-01-01T00:00:00.000Z' },
      { id: `import-${tenantId}-2026`, tenantId, reportType: 'hgb-guv', chart: 'SKR03', accountNumber: '8400', positionKey: 'material.services', positionLabel: 'Material', validFrom: '2026-01-01', version: 20260101, source: 'desktop-import', sourceHash: `hash-${suffix}-2026`, createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    for (const row of rows) {
      await saveServerReportAccountMapping(pool, row);
      await saveServerReportAccountMapping(pool, row);
    }
    const secondTenantRows = rows.map((row) => ({ ...row, id: row.id.replace(tenantId, secondTenantId), tenantId: secondTenantId, sourceHash: row.sourceHash.replace(suffix, `${suffix}-second`) }));
    for (const row of secondTenantRows) await saveServerReportAccountMapping(pool, row);
    assert.notEqual(rows[0]?.id, secondTenantRows[0]?.id);
    const effective = async (date: string) => (await pool.query(`SELECT DISTINCT ON (account_number,report_type) position_key FROM report_account_mappings WHERE tenant_id=$1 AND chart='SKR03' AND report_type='hgb-guv' AND account_number='8400' AND valid_from <= $2 ORDER BY account_number,report_type,valid_from DESC,version DESC`, [tenantId, date])).rows[0]?.position_key;
    assert.equal(await effective('2025-12-31'), 'revenue');
    assert.equal(await effective('2026-12-31'), 'material.services');
    assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS count FROM report_account_mappings WHERE tenant_id=$1', [tenantId])).rows[0].count), 2);
    assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS count FROM report_account_mappings WHERE tenant_id=$1', [secondTenantId])).rows[0].count), 2);
  } finally {
    if (createdTable) await pool.query('DROP TABLE report_account_mappings').catch(() => undefined);
    else {
      await pool.query('DELETE FROM tenants WHERE id = ANY($1::text[])', [[tenantId, secondTenantId]]).catch(() => undefined);
    }
    await pool.end();
  }
});

test('tenant-scoped postgres tables stay covered by import overwrite guards', async () => {
  const tenantScopedTables = await extractTenantScopedPostgresTables(postgresMigrationUrls);
  const excludedTables = new Set([
    'tenant_memberships', 'sqlite_import_runs', 'audit_heads',
  ]);
  const expected = [...new Set([
    ...tenantScopedTables,
    // Added by ALTER TABLE in 0011 rather than a CREATE TABLE migration.
    'tax_case_account_mappings',
  ])].filter((table) => !excludedTables.has(table)).sort();

  assert.deepEqual([...tenantCoreRowCountTables].sort(), expected);
});

test('Drizzle migration journal contains incremental migrations', async () => {
  const journal = JSON.parse(await readFile(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as { entries: Array<{ tag: string }> };
  assert.deepEqual(journal.entries.map((entry) => entry.tag), [
    '0000_server_data', '0001_server_data_pro_accounting', '0002_server_data_assets',
    '0003_server_data_offer_items', '0004_server_data_tax_rules', '0005_server_data_audit_heads', '0006_server_data_opos', '0007_server_data_opos_hardening', '0008_server_data_asset_accounting', '0009_server_data_datev_export_bytes', '0010_server_data_invoice_accounting_posted_at', '0011_server_data_tax_case_mapping_tenancy', '0012_server_data_asset_ownership_guard', '0013_server_data_asset_ownership_hardening', '0014_server_data_datev_tax_evidence', '0015_server_data_reporting_tax_submissions', '0016_server_data_eur_native', '0017_server_data_eur_catalog', '0018_server_data_canonical_catalog', '0019_server_data_audit_tenant_hash', '0021_server_data_eur_facts', '0022_server_data_accounting_source_runs',
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

test('audit log sequence uses the bigint number mapping in the Drizzle schema', async () => {
  const source = await readFile(new URL('./schema.ts', import.meta.url), 'utf8');
  assert.match(source, /sequence: bigint\("sequence", \{ mode: "number" \}\)/);
});

test('SQLite import rejects a child-only cross-tenant offer reference and rolls back the target', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const pool = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const ownerTenantId = `import-ref-owner-${randomUUID()}`;
  const targetTenantId = `import-ref-target-${randomUUID()}`;
  const ownerClientId = `import-ref-client-${randomUUID()}`;
  const offerId = `import-ref-offer-${randomUUID()}`;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'billme-import-ref-'));
  const sqlitePath = path.join(tempDir, 'source.sqlite');
  const sqlite = new Database(sqlitePath);
  const now = new Date().toISOString();
  try {
    await runPostgresMigrations(pool);
    await pool.query(`INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at) VALUES ($1,$1,'Reference owner','pro','single-tenant','active',$2,$2)`, [ownerTenantId, now]);
    await pool.query(`INSERT INTO clients (id, tenant_id, company, contact_person, email, phone, address, status, tags_json, notes) VALUES ($1,$2,'Owner client','Owner','owner@example.test','','','active','[]','keep')`, [ownerClientId, ownerTenantId]);
    sqlite.exec(`CREATE TABLE offers (id TEXT PRIMARY KEY, client_id TEXT, client_number TEXT, project_id TEXT, number TEXT, client TEXT, client_email TEXT, client_address TEXT, billing_address_json TEXT, shipping_address_json TEXT, tax_mode TEXT, tax_meta_json TEXT, tax_snapshot_json TEXT, date TEXT, valid_until TEXT, amount REAL, status TEXT, share_token TEXT, share_published_at TEXT, accepted_at TEXT, accepted_by TEXT, accepted_email TEXT, accepted_user_agent TEXT, decision TEXT, decision_text_version TEXT, created_at TEXT, updated_at TEXT)`);
    sqlite.prepare(`INSERT INTO offers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(offerId, ownerClientId, null, null, 'OF-FOREIGN', 'Owner client', 'owner@example.test', null, null, null, 'standard_vat', null, null, '2026-08-13', '2026-08-31', 0, 'draft', null, null, null, null, null, null, null, null, now, now);
    sqlite.close();

    await assert.rejects(
      importDesktopSqliteToPostgres({ pool, sqlitePath, product: 'pro', tenant: { id: targetTenantId, slug: targetTenantId, displayName: 'Reference target' } }),
      /IMPORT_CROSS_TENANT_REFERENCE:offers\.client_id/,
    );
    assert.deepEqual((await pool.query('SELECT tenant_id, company, notes FROM clients WHERE id=$1', [ownerClientId])).rows[0], { tenant_id: ownerTenantId, company: 'Owner client', notes: 'keep' });
    assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS count FROM offers WHERE tenant_id=$1', [targetTenantId])).rows[0].count), 0);
    assert.equal((await pool.query('SELECT status FROM sqlite_import_runs WHERE tenant_id=$1', [targetTenantId])).rows[0]?.status, 'failed');
  } finally {
    if (sqlite.open) sqlite.close();
    await pool.query('DELETE FROM tenants WHERE id = ANY($1::text[])', [[ownerTenantId, targetTenantId]]).catch(() => undefined);
    await pool.end();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('SQLite import rejects a child-only cross-tenant customer reservation and rolls back the target', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const pool = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const ownerTenantId = `import-reservation-owner-${randomUUID()}`;
  const targetTenantId = `import-reservation-target-${randomUUID()}`;
  const ownerClientId = `import-reservation-client-${randomUUID()}`;
  const reservationId = `import-reservation-${randomUUID()}`;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'billme-import-reservation-'));
  const sqlitePath = path.join(tempDir, 'source.sqlite');
  const sqlite = new Database(sqlitePath);
  const now = new Date().toISOString();
  try {
    await runPostgresMigrations(pool);
    await pool.query(`INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at) VALUES ($1,$1,'Reservation owner','pro','single-tenant','active',$2,$2)`, [ownerTenantId, now]);
    await pool.query(`INSERT INTO clients (id, tenant_id, company, contact_person, email, phone, address, status, tags_json, notes) VALUES ($1,$2,'Owner client','Owner','owner@example.test','','','active','[]','keep')`, [ownerClientId, ownerTenantId]);
    sqlite.exec(`CREATE TABLE number_reservations (id TEXT PRIMARY KEY, kind TEXT, number TEXT, counter_value INTEGER, status TEXT, document_id TEXT, created_at TEXT, updated_at TEXT)`);
    sqlite.prepare(`INSERT INTO number_reservations VALUES (?,?,?,?,?,?,?,?)`).run(reservationId, 'customer', 'K-FOREIGN', 1, 'finalized', ownerClientId, now, now);
    sqlite.close();

    await assert.rejects(
      importDesktopSqliteToPostgres({ pool, sqlitePath, product: 'pro', tenant: { id: targetTenantId, slug: targetTenantId, displayName: 'Reservation target' } }),
      /IMPORT_CROSS_TENANT_REFERENCE:number_reservations\.document_id/,
    );
    assert.deepEqual((await pool.query('SELECT tenant_id, company, notes FROM clients WHERE id=$1', [ownerClientId])).rows[0], { tenant_id: ownerTenantId, company: 'Owner client', notes: 'keep' });
    assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS count FROM number_reservations WHERE tenant_id=$1', [targetTenantId])).rows[0].count), 0);
  } finally {
    if (sqlite.open) sqlite.close();
    await pool.query('DELETE FROM tenants WHERE id = ANY($1::text[])', [[ownerTenantId, targetTenantId]]).catch(() => undefined);
    await pool.end();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('SQLite import treats a tenant tax-case mapping as occupied target data', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const pool = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const tenantId = `import-tax-mapping-only-${randomUUID()}`;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'billme-import-tax-mapping-'));
  const sqlitePath = path.join(tempDir, 'source.sqlite');
  const sqlite = new Database(sqlitePath);
  try {
    await runPostgresMigrations(pool);
    sqlite.close();
    const now = new Date().toISOString();
    await pool.query(`INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at) VALUES ($1,$1,'Tax mapping target','pro','single-tenant','active',$2,$2)`, [tenantId, now]);
    await pool.query(`INSERT INTO tax_case_account_mappings (id, tenant_id, chart, tax_case_key, role, account_number, updated_at) VALUES ($1,$2,'SKR03','DE_STD_19','output_tax','1776',$3)`, [`mapping-${randomUUID()}`, tenantId, now]);

    await assert.rejects(
      importDesktopSqliteToPostgres({ pool, sqlitePath, product: 'pro', tenant: { id: tenantId, slug: tenantId, displayName: 'Tax mapping target' } }),
      /already contains server billing data/,
    );
    assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS count FROM tax_case_account_mappings WHERE tenant_id=$1', [tenantId])).rows[0].count), 1);
  } finally {
    if (sqlite.open) sqlite.close();
    await pool.query('DELETE FROM tenants WHERE id=$1', [tenantId]).catch(() => undefined);
    await pool.end();
    await rm(tempDir, { recursive: true, force: true });
  }
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
    assert.equal((await pool.query('SELECT status FROM sqlite_import_runs WHERE id=$1', [result.importRunId])).rows[0].status, 'completed');
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

test('SQLite import records a failed run when the target already contains billing data', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const pool = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const tenantId = `import-occupied-${randomUUID()}`;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'billme-import-occupied-'));
  const sqlitePath = path.join(tempDir, 'source.sqlite');
  const sqlite = new Database(sqlitePath);
  const tenant = { id: tenantId, slug: tenantId, displayName: 'Occupied import test' } as const;
  try {
    sqlite.close();
    await runPostgresMigrations(pool);
    await pool.query(`INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at) VALUES ($1,$2,$3,'pro','single-tenant','active',now()::text,now()::text)`, [tenantId, tenant.slug, tenant.displayName]);
    await pool.query(`INSERT INTO server_settings (tenant_id, settings_json, created_at, updated_at) VALUES ($1,'{}',now()::text,now()::text)`, [tenantId]);

    await assert.rejects(
      importDesktopSqliteToPostgres({ pool, sqlitePath, product: 'pro', tenant }),
      /already contains server billing data/,
    );
    const failedRun = (await pool.query('SELECT status, details_json FROM sqlite_import_runs WHERE tenant_id=$1', [tenantId])).rows[0];
    assert.equal(failedRun.status, 'failed');
    assert.match(failedRun.details_json, /already contains server billing data/);
  } finally {
    if (sqlite.open) sqlite.close();
    await pool.query('DELETE FROM tenants WHERE id=$1', [tenantId]).catch(() => undefined);
    await pool.end();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('SQLite import rejects a cross-tenant id collision without stealing the existing row', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const pool = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const ownerTenantId = `import-owner-${randomUUID()}`;
  const targetTenantId = `import-collision-${randomUUID()}`;
  const clientId = `collision-client-${randomUUID()}`;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'billme-import-collision-'));
  const sqlitePath = path.join(tempDir, 'source.sqlite');
  const sqlite = new Database(sqlitePath);
  try {
    await runPostgresMigrations(pool);
    const now = new Date().toISOString();
    await pool.query(`INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at) VALUES ($1,$2,$3,'pro','single-tenant','active',$4,$4)`, [ownerTenantId, ownerTenantId, 'Existing owner', now]);
    await pool.query(`INSERT INTO clients (id, tenant_id, company, contact_person, email, phone, address, status, tags_json, notes) VALUES ($1,$2,'Existing owner','Owner','owner@example.test','+49','Main Street','active','[]','keep')`, [clientId, ownerTenantId]);
    sqlite.exec(`CREATE TABLE clients (id TEXT PRIMARY KEY, customer_number TEXT, company TEXT, contact_person TEXT, email TEXT, phone TEXT, address TEXT, status TEXT, avatar TEXT, tags_json TEXT, notes TEXT)`);
    sqlite.prepare('INSERT INTO clients VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(clientId, null, 'Imported owner', 'Imported', 'import@example.test', '', '', 'active', null, '[]', 'must not overwrite');
    sqlite.close();

    await assert.rejects(
      importDesktopSqliteToPostgres({ pool, sqlitePath, product: 'pro', tenant: { id: targetTenantId, slug: targetTenantId, displayName: 'Collision target' } }),
      new RegExp(`IMPORT_ID_TENANT_COLLISION:clients:${clientId}`),
    );
    assert.deepEqual((await pool.query('SELECT tenant_id, company, notes FROM clients WHERE id=$1', [clientId])).rows[0], { tenant_id: ownerTenantId, company: 'Existing owner', notes: 'keep' });
    assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS count FROM clients WHERE tenant_id=$1', [targetTenantId])).rows[0].count), 0);
    const failedRun = (await pool.query('SELECT status, details_json FROM sqlite_import_runs WHERE tenant_id=$1', [targetTenantId])).rows[0];
    assert.equal(failedRun.status, 'failed');
    assert.match(failedRun.details_json, /IMPORT_ID_TENANT_COLLISION/);
  } finally {
    if (sqlite.open) sqlite.close();
    await pool.query('DELETE FROM tenants WHERE id IN ($1,$2)', [ownerTenantId, targetTenantId]).catch(() => undefined);
    await pool.end();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('SQLite import serializes cross-tenant identity checks under concurrent imports', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const pool = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const suffix = randomUUID();
  const firstTenantId = `import-concurrent-a-${suffix}`;
  const secondTenantId = `import-concurrent-b-${suffix}`;
  const clientId = `concurrent-client-${suffix}`;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'billme-import-concurrent-'));
  const sqlitePaths = [path.join(tempDir, 'first.sqlite'), path.join(tempDir, 'second.sqlite')];
  try {
    await runPostgresMigrations(pool);
    const now = new Date().toISOString();
    for (const [tenantId, displayName] of [[firstTenantId, 'Concurrent first'], [secondTenantId, 'Concurrent second']] as const) {
      await pool.query(`INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at) VALUES ($1,$2,$3,'pro','single-tenant','active',$4,$4)`, [tenantId, tenantId, displayName, now]);
    }
    for (const sqlitePath of sqlitePaths) {
      const sqlite = new Database(sqlitePath);
      sqlite.exec(`CREATE TABLE clients (id TEXT PRIMARY KEY, customer_number TEXT, company TEXT, contact_person TEXT, email TEXT, phone TEXT, address TEXT, status TEXT, avatar TEXT, tags_json TEXT, notes TEXT)`);
      sqlite.prepare('INSERT INTO clients VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(clientId, null, 'Concurrent source', 'Customer', 'concurrent@example.test', '', '', 'active', null, '[]', 'source');
      sqlite.close();
    }

    const results = await Promise.allSettled([
      importDesktopSqliteToPostgres({ pool, sqlitePath: sqlitePaths[0], product: 'pro', tenant: { id: firstTenantId, slug: firstTenantId, displayName: 'Concurrent first' } }),
      importDesktopSqliteToPostgres({ pool, sqlitePath: sqlitePaths[1], product: 'pro', tenant: { id: secondTenantId, slug: secondTenantId, displayName: 'Concurrent second' } }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    const winnerTenantId = results[0].status === 'fulfilled' ? firstTenantId : secondTenantId;
    const imported = (await pool.query('SELECT tenant_id, company FROM clients WHERE id=$1', [clientId])).rows;
    assert.equal(imported.length, 1);
    assert.deepEqual(imported[0], { tenant_id: winnerTenantId, company: 'Concurrent source' });
    const runs = (await pool.query('SELECT tenant_id, status FROM sqlite_import_runs WHERE tenant_id = ANY($1::text[]) ORDER BY tenant_id', [[firstTenantId, secondTenantId]])).rows;
    assert.deepEqual(runs, [{ tenant_id: firstTenantId, status: firstTenantId === winnerTenantId ? 'completed' : 'failed' }, { tenant_id: secondTenantId, status: secondTenantId === winnerTenantId ? 'completed' : 'failed' }]);
  } finally {
    await pool.query('DELETE FROM tenants WHERE id = ANY($1::text[])', [[firstTenantId, secondTenantId]]).catch(() => undefined);
    await pool.end();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('SQLite import serializes same-tenant imports before the empty-target check', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const pool = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const tenantId = `import-same-tenant-${randomUUID()}`;
  const clientId = `same-tenant-client-${randomUUID()}`;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'billme-import-same-tenant-'));
  const sqlitePaths = [path.join(tempDir, 'first.sqlite'), path.join(tempDir, 'second.sqlite')];
  try {
    for (const sqlitePath of sqlitePaths) {
      const sqlite = new Database(sqlitePath);
      sqlite.exec(`CREATE TABLE clients (id TEXT PRIMARY KEY, customer_number TEXT, company TEXT, contact_person TEXT, email TEXT, phone TEXT, address TEXT, status TEXT, avatar TEXT, tags_json TEXT, notes TEXT)`);
      sqlite.prepare('INSERT INTO clients VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(clientId, null, 'Same tenant source', 'Customer', 'same-tenant@example.test', '', '', 'active', null, '[]', 'source');
      sqlite.close();
    }

    const results = await Promise.allSettled([
      importDesktopSqliteToPostgres({ pool, sqlitePath: sqlitePaths[0], product: 'pro', tenant: { id: tenantId, slug: tenantId, displayName: 'Same tenant' } }),
      importDesktopSqliteToPostgres({ pool, sqlitePath: sqlitePaths[1], product: 'pro', tenant: { id: tenantId, slug: tenantId, displayName: 'Same tenant' } }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
    assert.deepEqual((await pool.query('SELECT tenant_id, company FROM clients WHERE id=$1', [clientId])).rows, [{ tenant_id: tenantId, company: 'Same tenant source' }]);
    assert.deepEqual((await pool.query('SELECT status FROM sqlite_import_runs WHERE tenant_id=$1', [tenantId])).rows.map((row) => row.status).sort(), ['completed', 'failed']);
  } finally {
    await pool.query('DELETE FROM tenants WHERE id=$1', [tenantId]).catch(() => undefined);
    await pool.end();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('SQLite import initializes per-tenant audit heads and scopes duplicate history hashes', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const pool = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const firstTenantId = `import-audit-a-${randomUUID()}`;
  const secondTenantId = `import-audit-b-${randomUUID()}`;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'billme-import-audit-'));
  const sqlitePath = path.join(tempDir, 'source.sqlite');
  const occurredAt = '2026-08-13T12:00:00.000Z';
  const afterJson = JSON.stringify({ status: 'open' });
  const payload = {
    sequence: 1,
    ts: occurredAt,
    entityType: 'client',
    entityId: 'client-1',
    action: 'create',
    reason: 'Imported history',
    before: null,
    after: { status: 'open' },
    prevHash: null,
    actor: 'local',
  };
  const hash = sha256Hex(`:${stableStringify(payload)}`);
  const sqlite = new Database(sqlitePath);
  try {
    sqlite.exec(`CREATE TABLE audit_log (sequence INTEGER, ts TEXT, entity_type TEXT, entity_id TEXT, action TEXT, reason TEXT, before_json TEXT, after_json TEXT, prev_hash TEXT, hash TEXT, actor TEXT)`);
    sqlite.prepare('INSERT INTO audit_log VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(1, occurredAt, 'client', 'client-1', 'create', 'Imported history', null, afterJson, null, hash, 'local');
    sqlite.close();

    await importDesktopSqliteToPostgres({ pool, sqlitePath, product: 'pro', tenant: { id: firstTenantId, slug: firstTenantId, displayName: 'Audit A' } });
    const importedHead = (await pool.query('SELECT sequence, hash FROM audit_heads WHERE tenant_id=$1', [firstTenantId])).rows[0];
    assert.equal(Number(importedHead?.sequence), 1);
    assert.equal(importedHead?.hash, hash);
    assert.match(String((await pool.query('SELECT id::text FROM audit_log WHERE tenant_id=$1', [firstTenantId])).rows[0]?.id), /^\d+$/);

    const appended = await createPostgresAuditLogPort(pool).append(createSingleTenantScope(firstTenantId, 'pro'), {
      occurredAt: '2026-08-13T12:01:00.000Z',
      action: 'import.test',
      reason: 'Continue imported history',
      actor: { type: 'system', displayName: 'local' },
      subject: { entityType: 'client', entityId: 'client-1', tenantId: firstTenantId },
      change: { before: { status: 'open' }, after: { status: 'closed' } },
    });
    assert.equal(appended.sequence, 2);
    assert.equal(appended.prevHash, hash);

    await importDesktopSqliteToPostgres({ pool, sqlitePath, product: 'pro', tenant: { id: secondTenantId, slug: secondTenantId, displayName: 'Audit B' } });
    assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS count FROM audit_log WHERE hash=$1', [hash])).rows[0].count), 2);
  } finally {
    if (sqlite.open) sqlite.close();
    await pool.query('DELETE FROM tenants WHERE id = ANY($1::text[])', [[firstTenantId, secondTenantId]]).catch(() => undefined);
    await pool.end();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('SQLite import identity checks use array parameters for large source tables', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const pool = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const tempDir = await mkdtemp(path.join(tmpdir(), 'billme-import-large-ids-'));
  const sqlitePath = path.join(tempDir, 'source.sqlite');
  const sqlite = new Database(sqlitePath);
  const client = await pool.connect();
  try {
    await runPostgresMigrations(pool);
    sqlite.exec('CREATE TABLE clients (id TEXT PRIMARY KEY)');
    const insert = sqlite.prepare('INSERT INTO clients (id) VALUES (?)');
    const transaction = sqlite.transaction(() => {
      for (let index = 0; index < 66_000; index += 1) insert.run(`large-client-${index}`);
    });
    transaction();
    await client.query('BEGIN');
    await assertNoCrossTenantIdentityCollisions(client, sqlite, `large-id-${randomUUID()}`);
    await client.query('ROLLBACK');
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    sqlite.close();
    await pool.end();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('SQLite import validates global accounting catalogs without mutating them', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const pool = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const suffix = randomUUID();
  const tenantId = `import-global-catalog-${suffix}`;
  const accountNumber = '1776';
  const taxCaseKey = 'DE_STD_19';
  const tempDir = await mkdtemp(path.join(tmpdir(), 'billme-import-global-catalog-'));
  const sqlitePath = path.join(tempDir, 'source.sqlite');
  const sqlite = new Database(sqlitePath);
  try {
    await runPostgresMigrations(pool);
    const now = new Date().toISOString();
    sqlite.exec(`
      CREATE TABLE ledger_accounts (id TEXT PRIMARY KEY, chart TEXT, account_number TEXT, name TEXT, source TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE tax_cases (key TEXT PRIMARY KEY, label TEXT, mechanism TEXT, default_rate REAL, requires_counterparty_vat_id INTEGER, requires_country INTEGER, requires_evidence INTEGER, active INTEGER, updated_at TEXT);
      CREATE TABLE tax_case_account_mappings (id TEXT PRIMARY KEY, chart TEXT, tax_case_key TEXT, role TEXT, account_number TEXT, datev_bu_key TEXT, valid_from TEXT, valid_to TEXT, updated_at TEXT);
    `);
    sqlite.prepare('INSERT INTO ledger_accounts VALUES (?,?,?,?,?,?,?)').run(`desktop-${accountNumber}`, 'SKR03', accountNumber, 'Umsatzsteuer 19 %', 'desktop', now, now);
    sqlite.prepare('INSERT INTO tax_cases VALUES (?,?,?,?,?,?,?,?,?)').run(taxCaseKey, 'Inland steuerpflichtig 19%', 'standard_vat', 19, 0, 0, 0, 1, now);
    sqlite.prepare('INSERT INTO tax_case_account_mappings VALUES (?,?,?,?,?,?,?,?,?)').run(`mapping-${suffix}`, 'SKR03', taxCaseKey, 'output_tax', accountNumber, 'BU19', null, null, now);
    sqlite.close();

    const result = await importDesktopSqliteToPostgres({ pool, sqlitePath, product: 'pro', tenant: { id: tenantId, slug: tenantId, displayName: 'Global catalog import' } });
    assert.equal(result.counts.ledgerAccounts, 0);
    assert.equal(result.counts.taxCases, 0);
    assert.equal((await pool.query('SELECT name FROM ledger_accounts WHERE chart=\'SKR03\' AND account_number=$1', [accountNumber])).rows[0]?.name, 'Umsatzsteuer 19 %');
    assert.deepEqual((await pool.query('SELECT key, label, default_rate FROM tax_cases WHERE key=$1', [taxCaseKey])).rows, [{ key: taxCaseKey, label: 'Inland steuerpflichtig 19%', default_rate: '19' }]);
    assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS count FROM tax_case_account_mappings WHERE tenant_id=$1', [tenantId])).rows[0].count), 1);
  } finally {
    if (sqlite.open) sqlite.close();
    await pool.query('DELETE FROM tenants WHERE id=$1', [tenantId]).catch(() => undefined);
    await pool.end();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('SQLite import rolls back rows and leaves a visible failed run after a mid-import validation error', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const pool = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const tenantId = `import-rollback-${randomUUID()}`;
  const clientId = `rollback-client-${randomUUID()}`;
  const tempDir = await mkdtemp(path.join(tmpdir(), 'billme-import-rollback-'));
  const sqlitePath = path.join(tempDir, 'source.sqlite');
  const sqlite = new Database(sqlitePath);
  try {
    sqlite.exec(`
      CREATE TABLE clients (id TEXT PRIMARY KEY, customer_number TEXT, company TEXT, contact_person TEXT, email TEXT, phone TEXT, address TEXT, status TEXT, avatar TEXT, tags_json TEXT, notes TEXT);
      CREATE TABLE eur_lines (id TEXT PRIMARY KEY, tax_year INTEGER, kennziffer TEXT, provider_path TEXT, label TEXT, kind TEXT, exportable INTEGER, sort_order INTEGER, computed_from_json TEXT, computed_terms_json TEXT, source_version TEXT, created_at TEXT, updated_at TEXT);
    `);
    sqlite.prepare('INSERT INTO clients VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(clientId, null, 'Rollback customer', 'Customer', 'rollback@example.test', '', '', 'active', null, '[]', 'will roll back');
    sqlite.prepare('INSERT INTO eur_lines VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run('bad-eur-line', 2025, null, 'main', 'tampered', 'line', 1, 0, '[]', '[]', EUR_SOURCE_VERSION_2025, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z');
    sqlite.close();

    await assert.rejects(
      importDesktopSqliteToPostgres({ pool, sqlitePath, product: 'pro', tenant: { id: tenantId, slug: tenantId, displayName: 'Rollback test' } }),
      /does not match canonical 2025 catalog/,
    );
    assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS count FROM clients WHERE tenant_id=$1', [tenantId])).rows[0].count), 0);
    assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS count FROM audit_log WHERE tenant_id=$1', [tenantId])).rows[0].count), 0);
    const failedRun = (await pool.query('SELECT status, details_json FROM sqlite_import_runs WHERE tenant_id=$1', [tenantId])).rows[0];
    assert.equal(failedRun.status, 'failed');
    assert.match(failedRun.details_json, /canonical 2025 catalog/);
    assert.match(failedRun.details_json, /"clients":1/);
  } finally {
    if (sqlite.open) sqlite.close();
    await pool.query('DELETE FROM tenants WHERE id=$1', [tenantId]).catch(() => undefined);
    await pool.end();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('SQLite import keeps effective-date and legacy mappings traceable and idempotent on retry', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const pool = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const tenantId = `import-mappings-${randomUUID()}`;
  const suffix = randomUUID();
  const tempDir = await mkdtemp(path.join(tmpdir(), 'billme-import-mappings-'));
  const sqlitePath = path.join(tempDir, 'source.sqlite');
  const sqlite = new Database(sqlitePath);
  try {
    sqlite.exec(`CREATE TABLE account_mappings_hgb (id TEXT PRIMARY KEY, chart TEXT, account_number TEXT, statement_type TEXT, position_key TEXT, position_label TEXT, balance_side TEXT, valid_from TEXT, valid_to TEXT, updated_at TEXT)`);
    const insert = sqlite.prepare('INSERT INTO account_mappings_hgb VALUES (?,?,?,?,?,?,?,?,?,?)');
    insert.run(`modern-2025-${suffix}`, 'SKR03', '8400', 'hgb-guv', 'revenue', 'Revenue', null, '2025-01-01', '2025-12-31', '2025-01-01T00:00:00.000Z');
    insert.run(`modern-2026-${suffix}`, 'SKR03', '8400', 'hgb-guv', 'material.services', 'Material', null, '2026-01-01', null, '2026-01-01T00:00:00.000Z');
    insert.run(`legacy-${suffix}`, 'SKR03', '1200', 'guv', 'cash', 'Bank', 'asset', null, null, '2024-01-01T00:00:00.000Z');
    const modernRows = loadAccountMappingsHgb(sqlite, tenantId);
    const legacyRows = loadLegacyAccountMappingsHgb(sqlite, tenantId);
    sqlite.close();

    const result = await importDesktopSqliteToPostgres({ pool, sqlitePath, product: 'pro', tenant: { id: tenantId, slug: tenantId, displayName: 'Mapping import' } });
    assert.equal(result.counts.accountMappingsHgb, 3);
    assert.deepEqual((await pool.query(`SELECT valid_from, position_key, version, source FROM report_account_mappings WHERE tenant_id=$1 ORDER BY valid_from`, [tenantId])).rows, [
      { valid_from: '2025-01-01', position_key: 'revenue', version: 20250101, source: 'desktop-import' },
      { valid_from: '2026-01-01', position_key: 'material.services', version: 20260101, source: 'desktop-import' },
    ]);
    assert.deepEqual((await pool.query(`SELECT id, statement_type, position_key, balance_side FROM account_mappings_hgb WHERE tenant_id=$1`, [tenantId])).rows, [{ id: legacyRows[0].id, statement_type: 'guv', position_key: 'cash', balance_side: 'asset' }]);

    await saveServerReportAccountMapping(pool, modernRows[0]);
    await saveServerAccountMappingHgb(pool, legacyRows[0]);
    assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS count FROM report_account_mappings WHERE tenant_id=$1', [tenantId])).rows[0].count), 2);
    assert.equal(Number((await pool.query('SELECT COUNT(*)::int AS count FROM account_mappings_hgb WHERE tenant_id=$1', [tenantId])).rows[0].count), 1);
  } finally {
    if (sqlite.open) sqlite.close();
    await pool.query('DELETE FROM tenants WHERE id=$1', [tenantId]).catch(() => undefined);
    await pool.end();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('rerunning a fully migrated Postgres database preserves reporting evidence, EÜR catalog, and migration journal', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const pool = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const tenantId = `migration-rerun-${randomUUID()}`;
  const snapshotId = `snapshot-${randomUUID()}`;
  const submissionId = `submission-${randomUUID()}`;
  try {
    await runPostgresMigrations(pool);
    const now = new Date().toISOString();
    await pool.query(`INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at) VALUES ($1,$2,'Migration rerun','pro','single-tenant','active',$3,$3)`, [tenantId, tenantId, now]);
    await pool.query(`INSERT INTO report_snapshots (id, tenant_id, report_type, args_json, payload_json, created_at, source_hash, from_date, to_date, as_of_date) VALUES ($1,$2,'guv','{}','{"total":119}',$3,'source-rerun','2026-01-01','2026-12-31','2026-12-31')`, [snapshotId, tenantId, now]);
    await pool.query(`INSERT INTO report_snapshot_positions (id, tenant_id, snapshot_id, position_key, position_label, amount, debit_amount, credit_amount, metadata_json, created_at) VALUES ($1,$2,$3,'revenue','Revenue',119,119,0,'{}',$4)`, [`position-${randomUUID()}`, tenantId, snapshotId, now]);
    await pool.query(`INSERT INTO report_catalog_refs (id, tenant_id, report_type, catalog_key, catalog_version, source_hash, payload_json, created_at) VALUES ($1,$2,'guv','catalog','2026','catalog-rerun','{}',$3)`, [`catalog-${randomUUID()}`, tenantId, now]);
    await pool.query(`INSERT INTO tax_submissions (id, tenant_id, submission_type, tax_year, period, status, payload_json, idempotency_key, created_by, created_at, updated_at) VALUES ($1,$2,'ustva',2026,'2026-12','draft','{}','rerun-submit','test',$3,$3)`, [submissionId, tenantId, now]);

    const before = {
      journal: (await pool.query('SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows,
      snapshot: (await pool.query('SELECT id, source_hash, from_date, to_date, as_of_date, payload_json FROM report_snapshots WHERE id=$1', [snapshotId])).rows,
      positions: (await pool.query('SELECT snapshot_id, position_key, amount FROM report_snapshot_positions WHERE tenant_id=$1', [tenantId])).rows,
      catalogRefs: (await pool.query('SELECT id, report_type, catalog_key, catalog_version, source_hash, payload_json FROM report_catalog_refs WHERE tenant_id=$1', [tenantId])).rows,
      submission: (await pool.query('SELECT id, idempotency_key, status, payload_json FROM tax_submissions WHERE id=$1', [submissionId])).rows,
      eur: (await pool.query(`SELECT COUNT(*)::int AS count, MIN(source_version) AS source_version, MAX(source_version) AS max_source_version FROM eur_lines WHERE tax_year=2025`)).rows,
    };

    await runPostgresMigrations(pool);

    assert.deepEqual((await pool.query('SELECT id, hash, created_at FROM drizzle.__drizzle_migrations ORDER BY id')).rows, before.journal);
    assert.deepEqual((await pool.query('SELECT id, source_hash, from_date, to_date, as_of_date, payload_json FROM report_snapshots WHERE id=$1', [snapshotId])).rows, before.snapshot);
    assert.deepEqual((await pool.query('SELECT snapshot_id, position_key, amount FROM report_snapshot_positions WHERE tenant_id=$1', [tenantId])).rows, before.positions);
    assert.deepEqual((await pool.query('SELECT id, report_type, catalog_key, catalog_version, source_hash, payload_json FROM report_catalog_refs WHERE tenant_id=$1', [tenantId])).rows, before.catalogRefs);
    assert.deepEqual((await pool.query('SELECT id, idempotency_key, status, payload_json FROM tax_submissions WHERE id=$1', [submissionId])).rows, before.submission);
    assert.deepEqual((await pool.query(`SELECT COUNT(*)::int AS count, MIN(source_version) AS source_version, MAX(source_version) AS max_source_version FROM eur_lines WHERE tax_year=2025`)).rows, before.eur);
    await assert.rejects(pool.query('UPDATE report_snapshots SET payload_json=$1 WHERE id=$2', ['{"tampered":true}', snapshotId]), /report_snapshots is immutable/);
  } finally {
    await pool.query('DELETE FROM tenants WHERE id=$1', [tenantId]).catch(() => undefined);
    await pool.end();
  }
});
