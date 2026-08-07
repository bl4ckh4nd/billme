import assert from 'node:assert/strict';
import test from 'node:test';
import { createSingleTenantScope, type Invoice, type Offer } from '@billme/server-core';
import {
  createPostgresInvoiceRepository,
  createPostgresOfferRepository,
  createPostgresTenantRepository,
} from './billing.js';
import { createPostgresPool } from './connection.js';
import { runDrizzleMigrations } from './migrations.js';

const scope = createSingleTenantScope('tenant-tax', 'lite');

const invoice: Invoice = {
  kind: 'invoice',
  tenantId: scope.tenantId,
  id: 'invoice-tax-1',
  number: 'RE-2026-001',
  client: 'Alpen GmbH',
  clientEmail: 'billing@alpen.example',
  clientAddress: 'Ringstraße 1, 1010 Wien, AT',
  date: '2026-08-06',
  dueDate: '2026-08-20',
  amount: 100,
  status: 'draft',
  dunningLevel: 0,
  items: [{ description: 'Beratung', quantity: 1, price: 100, total: 100 }],
  payments: [],
  history: [],
  taxMode: 'intra_eu_service_reverse_charge',
  taxMeta: { sellerCountryCode: 'DE', buyerCountryCode: 'AT', buyerVatId: 'ATU12345678', taxRuleConfirmed: true },
  taxSnapshot: { netAmount: 100, vatAmount: 0, grossAmount: 100, vatRateApplied: 0, einvoiceCategoryCode: 'AE', label: 'EU-Leistung Reverse Charge', taxNotice: 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)' },
};

const offer: Offer = {
  kind: 'offer',
  tenantId: scope.tenantId,
  id: 'offer-tax-1',
  number: 'AN-2026-001',
  client: 'Swiss AG',
  clientEmail: 'billing@swiss.example',
  date: '2026-08-06',
  validUntil: '2026-08-20',
  amount: 100,
  status: 'draft',
  items: [{ description: 'Export', quantity: 1, price: 100, total: 100 }],
  history: [],
  taxMode: 'export_third_country',
  taxMeta: { sellerCountryCode: 'DE', buyerCountryCode: 'CH', taxRuleConfirmed: true },
  taxSnapshot: { netAmount: 100, vatAmount: 0, grossAmount: 100, vatRateApplied: 0, einvoiceCategoryCode: 'G', label: 'Drittlandsausfuhr', taxNotice: 'Steuerfreie Ausfuhrlieferung' },
};

test('Postgres billing repositories save and refetch invoice/offer tax fields', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const db = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  await runDrizzleMigrations(db);
  const tenantRepo = createPostgresTenantRepository(db);
  const now = new Date().toISOString();
  await tenantRepo.save({
    id: scope.tenantId,
    slug: scope.tenantId,
    displayName: 'Billing tax integration test',
    product: 'lite',
    deploymentMode: 'single-tenant',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  const invoiceRepo = createPostgresInvoiceRepository(db);
  const offerRepo = createPostgresOfferRepository(db);

  await invoiceRepo.save(scope, invoice);
  await offerRepo.save(scope, offer);

  assert.deepEqual((await invoiceRepo.getById(scope, invoice.id))?.taxMeta, invoice.taxMeta);
  assert.deepEqual((await invoiceRepo.getById(scope, invoice.id))?.taxSnapshot, invoice.taxSnapshot);
  assert.equal((await invoiceRepo.getById(scope, invoice.id))?.taxMode, invoice.taxMode);
  assert.deepEqual((await offerRepo.getById(scope, offer.id))?.taxMeta, offer.taxMeta);
  assert.deepEqual((await offerRepo.getById(scope, offer.id))?.taxSnapshot, offer.taxSnapshot);
  assert.equal((await offerRepo.getById(scope, offer.id))?.taxMode, offer.taxMode);
  await db.query('DELETE FROM invoices WHERE id = $1', [invoice.id]);
  await db.query('DELETE FROM offers WHERE id = $1', [offer.id]);
  await db.query('DELETE FROM tenants WHERE id = $1', [scope.tenantId]);
  await db.end();
});
