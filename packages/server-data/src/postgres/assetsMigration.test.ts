import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { eq } from 'drizzle-orm';
import { createPostgresPool } from './connection.js';
import { createDrizzle, schema } from './drizzle.js';
import { runDrizzleMigrations } from './migrations.js';

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
