import assert from 'node:assert/strict';
import test from 'node:test';
import { PgliteServerDatabase } from '@billme/server-data';
import { buildServerApi } from './app.js';
import { getCatalogForYear } from '@billme/desktop-services/eurCatalog';

// Risks: duplicate input VAT for partial payments, stale updates, double-counted
// bank cash, cross-tenant references, altered originals and active XML entities.
test('Lite manual cash retains its identity, receipt and category through exact bank matching', async () => {
  const database = await PgliteServerDatabase.open();
  const tenantId = 'manual-cash-tenant';
  const app = await buildServerApi({ database, runtime: 'embedded', product: 'lite', logger: false,
    sessionSecret: 'manual-cash-session-secret-32-characters',
    localAuth: { accessToken: 'manual-cash-test-token', tenantId, userId: 'manual-owner', email: 'owner@example.test', fullName: 'Manual Owner' } });
  try {
    const stamp = new Date().toISOString();
    await database.query(`INSERT INTO tenants (id,slug,display_name,product,deployment_mode,status,created_at,updated_at) VALUES ($1,$1,'Manual','lite','single-tenant','active',$2,$2)`, [tenantId, stamp]);
    await database.query(`INSERT INTO server_settings (tenant_id,settings_json,created_at,updated_at) VALUES ($1,$2,$3,$3)`, [tenantId, JSON.stringify({ legal: { smallBusinessRule: false }, businessReportingProfile: { jurisdiction: 'DE', legalForm: 'sole_proprietor', profitDetermination: 'eur', fiscalYearStart: '01-01', vatMethod: 'ist' } }), stamp]);
    await database.query(`INSERT INTO accounts (id,tenant_id,name,iban,balance,type,color) VALUES ('manual-bank',$1,'Bank','',0,'bank','#000000')`, [tenantId]);
    await database.query(`INSERT INTO transactions (id,tenant_id,account_id,date,amount,type,counterparty,purpose,status) VALUES ('manual-tx',$1,'manual-bank','2026-10-03',-59.5,'expense','Vendor','Partial payment','booked')`, [tenantId]);
    const headers = { 'x-billme-local-token': 'manual-cash-test-token' };
    const post = async (url: string, payload: Record<string, unknown>, status = 200) => {
      const response = await app.inject({ method: 'POST', url: `/api/v1/lite${url}`, headers, payload });
      assert.equal(response.statusCode, status, response.body); return response.json();
    };
    const get = async (url: string) => { const response = await app.inject({ method: 'GET', url: `/api/v1/lite${url}`, headers }); assert.equal(response.statusCode, 200, response.body); return response.json(); };
    const receipt = { id: 'manual-receipt', number: 'VENDOR-1', counterparty: 'Vendor', documentDate: '2026-09-01', receivedDate: '2026-10-02', serviceDate: '2026-09-01', grossAmountCents: 11900, taxMode: 'domestic', deductiblePercent: 100, taxBreakdown: [{ rate: 19, netAmountCents: 10000, vatAmountCents: 1900 }], reviewed: true };
    await post('/cash/receipts', { receipt, reason: 'Checked original receipt' });
    const first = { id: 'manual-first', cashDate: '2026-09-30', amountCents: -5950, currency: 'EUR', flowType: 'expense', counterparty: 'Vendor', purpose: 'First instalment', receiptId: receipt.id };
    await post('/cash/entries', { entry: first, reason: 'First instalment' });
    await post('/cash/entries', { entry: { ...first, id: 'manual-second', cashDate: '2026-11-03' }, reason: 'Second instalment' });
    const lineId = getCatalogForYear(2026).find((line) => line.kennziffer === '183')!.id;
    const classification = await app.inject({ method: 'PUT', url: '/api/v1/lite/reports/eur/classifications', headers, payload: { sourceType: 'manual', sourceId: first.id, taxYear: 2026, eurLineId: lineId, vatMode: 'default', vatRate: 19, reason: 'Reviewed operating expense' } });
    assert.equal(classification.statusCode, 200, classification.body);
    await post('/cash/entries', { entry: { ...first, id: 'foreign-entry', receiptId: 'foreign-receipt' }, reason: 'Invalid receipt' }, 400);
    const xml = Buffer.from('<?xml version="1.0"?><Invoice><ID>VENDOR-1</ID></Invoice>');
    const file = await post('/cash/receipts/manual-receipt/files', { fileName: 'invoice.xml', mimeType: 'application/xml', contentBase64: xml.toString('base64'), reason: 'Archive original' });
    assert.equal((await get(`/cash/files/${file.id}`)).contentBase64, xml.toString('base64'));
    await post('/cash/receipts/manual-receipt/files', { fileName: 'unsafe.xml', mimeType: 'application/xml', contentBase64: Buffer.from('<!DOCTYPE Invoice [<!ENTITY x SYSTEM "file:///etc/passwd">]><Invoice>&x;</Invoice>').toString('base64'), reason: 'Unsafe XML' }, 400);
    await post('/cash/entries/manual-first/match', { transactionId: 'manual-tx', expectedCashDate: first.cashDate, reason: 'Exact amount checked; period changes to October' });
    const matched = (await get('/cash/entries')).find((entry: { id: string }) => entry.id === first.id);
    assert.equal(matched.cashDate, '2026-10-03'); assert.equal(matched.originalCashDate, first.cashDate);
    const items = await get('/reports/eur/items?taxYear=2026');
    assert.equal(items.length, 2); assert.equal(items.find((item: { sourceId: string }) => item.sourceId === first.id).amountGross, 59.5);
    assert.equal(items.find((item: { sourceId: string }) => item.sourceId === first.id).classification.eurLineId, lineId);
    const eur = await get('/reports/eur?taxYear=2026');
    assert.equal(eur.summary.expenseTotal, 59.5, 'net expense plus paid input VAT must reconcile to classified cash');
    assert.equal(items.filter((item: { sourceType: string }) => item.sourceType === 'transaction').length, 0);
    const octoberVat = await get('/reports/vat?from=2026-10-01&to=2026-10-31');
    assert.equal(octoberVat.inputVatCents, 1900, 'input VAT belongs to the receipt, not each partial payment');
    assert.equal((await get('/reports/vat?from=2026-11-01&to=2026-11-30')).inputVatCents, 0);
    await post('/cash/entries/manual-first/unmatch', { reason: 'Undo wrong statement selection' });
    assert.equal((await get('/reports/eur/items?taxYear=2026')).length, 3);
    assert.equal((await get(`/cash/files/${file.id}`)).contentBase64, xml.toString('base64'));
  } finally { await app.close(); }
});
