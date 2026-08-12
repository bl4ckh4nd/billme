import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { createPostgresPool } from './connection.js';
import { createDrizzle, schema } from './drizzle.js';
import { runDrizzleMigrations } from './migrations.js';

const rootUrl = new URL('../../../../', import.meta.url);
const sqliteBootstrapUrl = new URL('apps/pro-desktop/db/bootstrap.ts', rootUrl);
const postgresMigrationUrl = new URL('../../drizzle/0002_server_data_assets.sql', import.meta.url);
const postgresAssetAccountingMigrationUrl = new URL('../../drizzle/0008_server_data_asset_accounting.sql', import.meta.url);

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
  const postgres = [
    await readFile(postgresMigrationUrl, 'utf8'),
    await readFile(postgresAssetAccountingMigrationUrl, 'utf8'),
  ].join('\n');

  for (const table of ['assets', 'asset_depreciation_schedule', 'asset_movements']) {
    const postgresColumns = columns(postgres, table);
    for (const match of postgres.matchAll(new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ([a-z_]+)\\s`, 'g'))) {
      postgresColumns.push(match[1]);
    }
    assert.deepEqual([...new Set(postgresColumns)].sort(), columns(sqlite, table), table);
  }
});

test('legacy asset migration is additive and idempotent', async () => {
  const migration = await readFile(postgresAssetAccountingMigrationUrl, 'utf8');
  for (const column of [
    'acquisition_offset_account_number',
    'source_incoming_invoice_id',
    'activation_journal_entry_id',
    'accounting_repair_required',
    'accounting_repair_reason',
  ]) {
    assert.match(migration, new RegExp(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS ${column}\\s`));
  }
  for (const [table, column] of [
    ['asset_depreciation_schedule', 'source_type'],
    ['asset_depreciation_schedule', 'source_key'],
    ['asset_movements', 'journal_entry_id'],
    ['asset_movements', 'source_type'],
    ['asset_movements', 'source_key'],
  ]) {
    assert.match(migration, new RegExp(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column}\\s`));
  }
});

test('Postgres asset migration saves and refetches accounting provenance', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const db = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const tenantId = `asset-migration-${randomUUID()}`;
  const assetId = `asset-${randomUUID()}`;
  const now = new Date().toISOString();
  try {
    await runDrizzleMigrations(db);
    await db.query(
      `INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at)
       VALUES ($1, $2, $3, 'pro', $4, $4)`,
      [tenantId, tenantId, 'Asset migration test', now],
    );
    const database = createDrizzle(db);
    await database.insert(schema.assets).values({
      id: assetId,
      tenantId,
      assetNumber: 'A-MIGRATION-001',
      name: 'Legacy-compatible asset',
      assetClass: 'Betriebs- und Geschaeftsausstattung',
      status: 'aktiv',
      activationDate: '2026-01-15',
      acquisitionCost: '119.00',
      usefulLifeYears: 3,
      depreciationMethod: 'linear',
      costCenter: '100',
      location: 'Berlin',
      receiptLinked: true,
      supplier: 'Supplier GmbH',
      invoiceRef: 'INV-001',
      assetAccountNumber: '0480',
      acquisitionOffsetAccountNumber: '1600',
      sourceIncomingInvoiceId: 'incoming-001',
      activationJournalEntryId: 'journal-activation-001',
      accountingRepairRequired: true,
      accountingRepairReason: 'LEGACY_ACTIVATION_LINK_REQUIRED',
      createdAt: now,
      updatedAt: now,
    });
    const [row] = await database.select({
      acquisitionOffsetAccountNumber: schema.assets.acquisitionOffsetAccountNumber,
      sourceIncomingInvoiceId: schema.assets.sourceIncomingInvoiceId,
      activationJournalEntryId: schema.assets.activationJournalEntryId,
      accountingRepairRequired: schema.assets.accountingRepairRequired,
      accountingRepairReason: schema.assets.accountingRepairReason,
    }).from(schema.assets).where(eq(schema.assets.id, assetId));
    assert.deepEqual(row, {
      acquisitionOffsetAccountNumber: '1600',
      sourceIncomingInvoiceId: 'incoming-001',
      activationJournalEntryId: 'journal-activation-001',
      accountingRepairRequired: true,
      accountingRepairReason: 'LEGACY_ACTIVATION_LINK_REQUIRED',
    });
  } finally {
    await db.query('DELETE FROM tenants WHERE id = $1', [tenantId]).catch(() => undefined);
    await db.end();
  }
});
