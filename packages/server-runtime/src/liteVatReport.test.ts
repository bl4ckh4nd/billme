import assert from 'node:assert/strict';
import test from 'node:test';
import { PgliteServerDatabase, createPostgresBillingDependencies } from '@billme/server-data';
import { createSingleTenantScope, type InvoiceTaxMode } from '@billme/server-core';
import { DEFAULT_SETTINGS } from '@billme/desktop-services/mockData';
import { buildServerApi } from './app.js';

// Risks: lifetime payment caps, refunds, mixed rates, duplicate receipt VAT,
// wrong Soll/Ist periods, lost cancelled originals and incomplete exports.
test('Lite VAT preparation uses signed lifetime payments, all outgoing modes and receipt-based input VAT', async (t) => {
  const database = await PgliteServerDatabase.open();
  const tenantId = 'lite-vat-test';
  const scope = createSingleTenantScope(tenantId, 'lite');
  const app = await buildServerApi({ database, runtime: 'embedded', product: 'lite', logger: false, sessionSecret: 'lite-vat-regression-session-secret',
    localAuth: { accessToken: 'lite-vat-token', tenantId, userId: 'vat-owner', email: 'vat@example.test', fullName: 'VAT Owner' } });
  t.after(() => app.close());
  const stamp = new Date().toISOString();
  await database.query('INSERT INTO tenants (id,slug,display_name,product,created_at,updated_at) VALUES ($1,$1,$1,\'lite\',$2,$2)', [tenantId, stamp]);
  const settings = { ...DEFAULT_SETTINGS, legal: { ...DEFAULT_SETTINGS.legal, smallBusinessRule: false, taxAccountingMethod: 'ist' }, businessReportingProfile: { jurisdiction: 'DE', legalForm: 'sole_proprietor', profitDetermination: 'eur', fiscalYearStart: '01-01', vatMethod: 'ist' } };
  await database.query('INSERT INTO server_settings (tenant_id,settings_json,created_at,updated_at) VALUES ($1,$2,$3,$3)', [tenantId, JSON.stringify(settings), stamp]);
  const repositories = createPostgresBillingDependencies(database);
  const headers = { 'x-billme-local-token': 'lite-vat-token' };
  const get = async (from: string, to: string) => {
    const response = await app.inject({ method: 'GET', url: `/api/v1/lite/reports/vat?from=${from}&to=${to}`, headers });
    assert.equal(response.statusCode, 200, response.body); return response.json();
  };
  const modes: Array<[InvoiceTaxMode, string]> = [['small_business_19_ustg', '48'], ['reverse_charge_13b', '60'], ['intra_eu_supply_6a', '41'], ['intra_eu_service_reverse_charge', '21'], ['export_third_country', '43'], ['vat_exempt_4_ustg', '48'], ['non_taxable_outside_scope', '45']];
  for (const [mode] of modes) await repositories.invoiceRepo.save(scope, {
    kind: 'invoice', tenantId, id: mode, number: mode, client: 'Buyer', clientEmail: 'buyer@example.test', date: '2026-10-03', dueDate: '2026-10-17', servicePeriod: '2026-10-01', amount: 100, status: 'open', history: [], payments: [], items: [], taxMode: mode,
    taxMeta: { buyerVatId: 'DE123456789', exemptionReasonOverride: 'Reviewed tax treatment' },
    taxSnapshot: { vatRateApplied: 0, netAmount: 100, vatAmount: 0, grossAmount: 100, einvoiceCategoryCode: 'E', taxRuleConfirmed: true },
  });
  await repositories.invoiceRepo.save(scope, { kind: 'invoice', tenantId, id: 'mixed', number: 'MIXED', client: 'Buyer', clientEmail: 'buyer@example.test', date: '2026-09-01', dueDate: '2026-10-17', servicePeriod: '2026-09-01', amount: 226, status: 'open', history: [], items: [], taxMode: 'standard_vat',
    payments: [{ id: 'first', date: '2026-09-30', amount: 113, method: 'Bank' }, { id: 'second', date: '2026-10-03', amount: 123, method: 'Bank' }, { id: 'overpay-refund', date: '2026-11-01', amount: -10, method: 'Refund' }, { id: 'refund', date: '2026-11-02', amount: -56.5, method: 'Refund' }],
    taxSnapshot: { vatRateApplied: 19, netAmount: 200, vatAmount: 26, grossAmount: 226, einvoiceCategoryCode: 'S', vatBreakdown: [{ rate: 19, netAmount: 100, vatAmount: 19 }, { rate: 7, netAmount: 100, vatAmount: 7 }] },
  });
  const september = await get('2026-09-01', '2026-09-30');
  const october = await get('2026-10-01', '2026-10-31');
  const november = await get('2026-11-01', '2026-11-30');
  assert.equal(september.outputVatCents, 1300); assert.equal(october.outputVatCents, 1300); assert.equal(november.outputVatCents, -650);
  for (const [, code] of modes) assert.ok(october.positions.some((position: { code: string; basisCents: number }) => position.code === code && position.basisCents >= 10000), `missing ${code}`);
  assert.equal(october.positions.find((position: { code: string }) => position.code === '48').basisCents, 20000);
  assert.equal(october.submissionReady, false);
  assert.ok(october.issues.some((issue: { code: string }) => issue.code === 'PAYMENT_RESIDUAL'));
  const csv = await app.inject({ method: 'GET', url: '/api/v1/lite/reports/vat/export/csv?from=2026-10-01&to=2026-10-31', headers });
  assert.equal(csv.statusCode, 200, csv.body); assert.match(Buffer.from(csv.json().contentBase64, 'base64').toString('utf8'), /Vorbereitung/);
  const pdf = await app.inject({ method: 'GET', url: '/api/v1/lite/reports/vat/export/pdf?from=2026-10-01&to=2026-10-31', headers });
  assert.equal(pdf.statusCode, 200, pdf.body); assert.equal(Buffer.from(pdf.json().contentBase64, 'base64').subarray(0, 5).toString(), '%PDF-');
  settings.legal.taxAccountingMethod = 'soll'; settings.businessReportingProfile.vatMethod = 'soll';
  await database.query('UPDATE server_settings SET settings_json=$2 WHERE tenant_id=$1', [tenantId, JSON.stringify(settings)]);
  assert.equal((await get('2026-09-01', '2026-09-30')).outputVatCents, 2600, 'Soll recognizes performance rather than each cash receipt');
  assert.equal((await get('2026-10-01', '2026-10-31')).outputVatCents, 0);
});

test('incoming VAT uses statutory periods, separate tax positions and linked correction events', async (t) => {
  const database = await PgliteServerDatabase.open();
  const tenantId = 'incoming-vat-periods';
  const app = await buildServerApi({ database, runtime: 'embedded', product: 'lite', logger: false, sessionSecret: 'incoming-vat-test-secret-32-chars', localAuth: { accessToken: 'incoming-vat-token', tenantId, userId: 'owner', email: 'owner@example.test', fullName: 'Owner' } });
  t.after(() => app.close());
  const stamp = new Date().toISOString();
  const settings = { ...DEFAULT_SETTINGS, legal: { ...DEFAULT_SETTINGS.legal, smallBusinessRule: false, taxAccountingMethod: 'ist' } };
  await database.query("INSERT INTO tenants (id,slug,display_name,product,created_at,updated_at) VALUES ($1,$1,$1,'lite',$2,$2)", [tenantId, stamp]);
  await database.query('INSERT INTO server_settings (tenant_id,settings_json,created_at,updated_at) VALUES ($1,$2,$3,$3)', [tenantId, JSON.stringify(settings), stamp]);
  const headers = { 'x-billme-local-token': 'incoming-vat-token' };
  const post = async (url: string, payload: Record<string, unknown>) => { const response = await app.inject({ method: 'POST', url, headers, payload }); assert.equal(response.statusCode, 200, response.body); return response.json(); };
  const get = async (month: string) => { const response = await app.inject({ method: 'GET', url: `/api/v1/lite/reports/vat?from=2026-${month}-01&to=2026-${month}-${month === '09' || month === '11' ? '30' : '31'}`, headers }); assert.equal(response.statusCode, 200, response.body); return response.json(); };
  const receipt = async (id: string, taxMode: string, extra: Record<string, unknown> = {}) => {
    await post('/api/v1/lite/cash/receipts', { receipt: { id, number: id, counterparty: 'Supplier', documentDate: '2026-09-15', receivedDate: '2026-11-03', serviceDate: '2026-09-01', grossAmountCents: ['eu_service', 'reverse_charge', 'intra_eu_acquisition'].includes(taxMode) ? 10000 : 11900, taxMode, deductiblePercent: 50, reviewed: true, taxBreakdown: [{ rate: 19, netAmountCents: 10000, vatAmountCents: 1900 }], ...extra }, reason: 'Independently checked tax timing' });
    await post(`/api/v1/lite/cash/receipts/${id}/files`, { fileName: `${id}.xml`, mimeType: 'application/xml', contentBase64: Buffer.from(`<Receipt><ID>${id}</ID></Receipt>`).toString('base64'), reason: 'Archive original' });
  };
  await receipt('eu', 'eu_service');
  await receipt('other-rc', 'reverse_charge', { documentDate: '2026-11-01' });
  await receipt('acquisition', 'intra_eu_acquisition', { documentDate: '2026-08-15' });
  await receipt('import', 'import', { importTaxDate: '2026-09-20' });
  await receipt('domestic', 'domestic', { receivedDate: '2026-08-01', serviceDate: '2026-10-01', advancePayment: true, deductiblePercent: 100 });
  await post('/api/v1/lite/cash/entries', { entry: { id: 'advance', cashDate: '2026-09-01', amountCents: -5950, currency: 'EUR', flowType: 'expense', counterparty: 'Supplier', purpose: 'Advance', receiptId: 'domestic' }, reason: 'Advance payment checked' });
  const september = await get('09');
  assert.equal(september.outputVatCents, 3800, 'EU service and acquired goods belong to September despite later receipt');
  assert.equal(september.inputVatCents, 3800, 'Half of EU/IGL/import VAT plus half domestic advance');
  assert.equal(september.positions.find((row: { code: string }) => row.code === '46').taxCode, '47');
  const october = await get('10');
  assert.equal(october.outputVatCents, 1900, 'Other §13b capped at end of month after performance');
  assert.equal(october.inputVatCents, 1900, 'Half other RC plus remaining domestic input VAT');
  assert.equal(october.positions.find((row: { code: string }) => row.code === '84').taxCode, '85');
  assert.equal((await get('11')).outputVatCents, 0);
  await receipt('correction', 'domestic', { documentDate: '2026-11-01', receivedDate: '2026-11-01', serviceDate: '2026-09-01', grossAmountCents: -2380, taxBreakdown: [{ rate: 19, netAmountCents: -2000, vatAmountCents: -380 }], correctionOfReceiptId: 'domestic', adjustmentDate: '2026-11-01', correctionReason: 'Price reduced', deductiblePercent: 100 });
  assert.equal((await get('11')).inputVatCents, -380, 'Correction belongs to adjustment event, not original performance');
  await database.query('UPDATE server_settings SET settings_json=$2 WHERE tenant_id=$1', [tenantId, JSON.stringify({ ...settings, legal: { ...settings.legal, smallBusinessRule: true } })]);
  const kuSeptember = await get('09');
  assert.equal(kuSeptember.outputVatCents, 3800, 'KU still owes self-assessed tax');
  assert.equal(kuSeptember.inputVatCents, 0);
  await receipt('bad-ku-income', 'domestic', { documentDate: '2026-10-01', receivedDate: '2026-10-01', serviceDate: '2026-10-01', deductiblePercent: 0 });
  await post('/api/v1/lite/cash/entries', { entry: { id: 'ku-income', cashDate: '2026-10-01', amountCents: 11900, currency: 'EUR', flowType: 'income', counterparty: 'Buyer', purpose: 'Cash sale', receiptId: 'bad-ku-income' }, reason: 'Retain inconsistent source for review' });
  const kuOctober = await get('10');
  assert.ok(kuOctober.issues.some((row: { code: string }) => row.code === 'KU_INCOME_VAT_REVIEW'));
  assert.equal(kuOctober.preparationComplete, false);
  const missingImportDate = await receipt('import-missing-date', 'import');
  void missingImportDate;
  assert.ok((await get('11')).issues.some((row: { code: string }) => row.code === 'IMPORT_TAX_DATE_REQUIRED'));
});
