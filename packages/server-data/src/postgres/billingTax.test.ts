import assert from 'node:assert/strict';
import test from 'node:test';
import { createSingleTenantScope, type Invoice, type Offer } from '@billme/server-core';
import type { PostgresQueryable } from './connection.js';
import { createPostgresInvoiceRepository, createPostgresOfferRepository } from './billing.js';

const scope = createSingleTenantScope('tenant-tax', 'lite');

const createRoundtripDb = (): PostgresQueryable => {
  const invoices = new Map<string, Record<string, unknown>>();
  const offers = new Map<string, Record<string, unknown>>();
  const db = {
    async query(sql: string, values: unknown[] = []) {
      if (/INSERT INTO invoices/.test(sql)) {
        invoices.set(String(values[0]), {
          id: values[0], tenant_id: values[1], client_id: values[2], client_number: values[3], project_id: values[4], number: values[5], client: values[6], client_email: values[7], client_address: values[8], billing_address_json: values[9], shipping_address_json: values[10], date: values[11], due_date: values[12], service_period: values[13], amount: values[14], status: values[15], dunning_level: values[16], items_json: values[17], payments_json: values[18], history_json: values[19], tax_mode: values[20], tax_meta_json: values[21], tax_snapshot_json: values[22], created_at: values[23], updated_at: values[24],
        });
        return { rowCount: 1, rows: [] };
      }
      if (/INSERT INTO offers/.test(sql)) {
        offers.set(String(values[0]), {
          id: values[0], tenant_id: values[1], client_id: values[2], client_number: values[3], project_id: values[4], number: values[5], client: values[6], client_email: values[7], client_address: values[8], billing_address_json: values[9], shipping_address_json: values[10], date: values[11], valid_until: values[12], amount: values[13], status: values[14], share_json: values[15], history_json: values[16], items_json: values[17], tax_mode: values[18], tax_meta_json: values[19], tax_snapshot_json: values[20], created_at: values[21], updated_at: values[22],
        });
        return { rowCount: 1, rows: [] };
      }
      if (/SELECT \* FROM invoices/.test(sql)) return { rowCount: invoices.size ? 1 : 0, rows: [...invoices.values()] };
      if (/SELECT \* FROM offers/.test(sql)) return { rowCount: offers.size ? 1 : 0, rows: [...offers.values()] };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  return db as unknown as PostgresQueryable;
};

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

test('Postgres billing repositories save and refetch invoice/offer tax fields', async () => {
  const db = createRoundtripDb();
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
});
