import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PgliteServerDatabase, createPostgresInvoiceRepository } from '@billme/server-data';
import { buildServerApi } from './app.js';

test('Lite import, payment allocation and unlink conserve cash independently of Pro posting', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'billme-lite-cash-'));
  const database = await PgliteServerDatabase.open(join(dir, 'db'));
  const token = 'lite-cash-local-test-token';
  const tenantId = 'lite-cash-tenant';
  const app = await buildServerApi({ database, runtime: 'embedded', product: 'lite', logger: false,
    sessionSecret: 'lite-cash-test-session-secret-32-chars',
    localAuth: { accessToken: token, tenantId, userId: 'cash-owner', email: 'cash@example.test', fullName: 'Cash Owner' } });
  try {
    const stamp = new Date().toISOString();
    await database.query(`INSERT INTO tenants (id,slug,display_name,product,deployment_mode,status,created_at,updated_at) VALUES ($1,$1,'Cash','lite','single-tenant','active',$2,$2)`, [tenantId, stamp]);
    await database.query(`INSERT INTO server_settings (tenant_id,settings_json,created_at,updated_at) VALUES ($1,$2,$3,$3)`, [tenantId, JSON.stringify({ legal: { smallBusinessRule: true }, businessReportingProfile: { jurisdiction: 'DE', legalForm: 'sole_proprietor', profitDetermination: 'eur', fiscalYearStart: '01-01', vatMethod: 'ist' } }), stamp]);
    await database.query(`INSERT INTO accounts (id,tenant_id,name,iban,balance,type,color) VALUES ('cash-bank',$1,'Bank','',0,'bank','#000000')`, [tenantId]);
    await database.query(`INSERT INTO invoices (id,tenant_id,number,client,client_email,date,due_date,amount,status,items_json,payments_json,history_json,tax_mode) VALUES ('cash-invoice',$1,'RE-CASH','Customer','cash@example.test','2026-10-01','2026-10-15',1440,'open','[]','[]','[]','small_business_19_ustg')`, [tenantId]);
    const path = join(dir, 'cash.csv');
    await writeFile(path, 'Date,Amount,Name,Purpose\n2026-10-03,1440,Customer,RE-CASH\n2026-10-03,-119,Adobe,Software\n');
    await app.ready();
    const headers = { 'x-billme-local-token': token };
    const get = async (url: string) => {
      const response = await app.inject({ method: 'GET', url, headers });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    const post = async (url: string, payload: Record<string, unknown>) => {
      const response = await app.inject({ method: 'POST', url, headers, payload });
      assert.equal(response.statusCode, 200, response.body);
      return response.json();
    };
    await post('/api/v1/lite/finance/import/commit', { path, accountId: 'cash-bank', profile: 'generic', mapping: { dateColumn: 'Date', amountColumn: 'Amount', counterpartyColumn: 'Name', purposeColumn: 'Purpose' } });
    const transactions = await get('/api/v1/lite/transactions');
    const income = transactions.find((row: { type: string }) => row.type === 'income');
    const itemsUrl = '/api/v1/lite/reports/eur/items?taxYear=2026';
    const imported = await get(itemsUrl);
    assert.equal(imported.length, 2, 'settled cash must not require a Pro ledger posting');
    assert.deepEqual(imported.map((row: { amountGross: number }) => row.amountGross).sort((a: number, b: number) => a - b), [119, 1440]);
    const linkUrl = `/api/v1/lite/transactions/${income.id}/link`;
    const staleInvoice = await get('/api/v1/lite/invoices/cash-invoice');
    await post(linkUrl, { invoiceId: 'cash-invoice', appliedAmountCents: 72000, reason: 'Partial payment checked' });
    const linked = await get(itemsUrl);
    assert.equal(linked.filter((row: { flowType: string }) => row.flowType === 'income').reduce((sum: number, row: { amountGross: number }) => sum + row.amountGross, 0), 1440);
    assert.equal(linked.find((row: { flowType: string }) => row.flowType === 'expense').amountGross, 119);
    assert.equal(linked.filter((row: { sourceType: string }) => row.sourceType === 'invoice').length, 1);
    await post(linkUrl, { invoiceId: 'cash-invoice', appliedAmountCents: 72000, reason: 'Retry after connection loss' });
    const scope = { tenantId, product: 'lite' as const, deploymentMode: 'single-tenant' as const };
    const repository = createPostgresInvoiceRepository(database);
    await repository.save(scope, staleInvoice);
    assert.equal((await get('/api/v1/lite/invoices/cash-invoice')).payments[0].amount, 720, 'internal ordinary saves cannot replace payments');
    const edited = await app.inject({ method: 'POST', url: '/api/v1/lite/invoices', headers, payload: { invoice: { ...staleInvoice, client: 'Updated customer' }, reason: 'Edit issued content' } });
    assert.equal(edited.statusCode, 409, edited.body);
    assert.equal((await get('/api/v1/lite/invoices/cash-invoice')).payments[0].amount, 720, 'ordinary edits cannot overwrite server-owned payments');
    assert.equal((await get('/api/v1/lite/transactions?type=income&unlinkedOnly=false')).length, 1);
    assert.equal((await get('/api/v1/lite/transactions?type=income&unlinkedOnly=true')).length, 0);
    await post(`/api/v1/lite/transactions/${income.id}/unlink`, { reason: 'Undo checked allocation' });
    assert.equal((await get(itemsUrl)).length, 2);
    const mirror = await database.query<{ status: string }>('SELECT status FROM bank_transactions WHERE source_transaction_id=$1', [income.id]);
    assert.equal(mirror.rows[0]?.status, 'pending', 'Lite must preserve Pro posting state');
    // A refund takes back at most what was paid: after the unlink nothing is paid, so it is refused.
    const refund = { id: 'cash-refund', date: '2026-10-04', amount: -100, method: 'Refund' };
    const unpaidRefund = await app.inject({ method: 'POST', url: '/api/v1/lite/invoices/cash-invoice/payments', headers, payload: { payment: refund, reason: 'Refund without payment' } });
    assert.equal(unpaidRefund.statusCode, 409, unpaidRefund.body);
    assert.equal((await get(itemsUrl)).length, 2, 'the refused refund changed nothing');
    const firstPaid = { id: 'first-paid', date: '2026-10-04', amount: 300, method: 'Bank' };
    await post('/api/v1/lite/invoices/cash-invoice/payments', { payment: firstPaid, reason: 'Partial payment' });
    await post('/api/v1/lite/invoices/cash-invoice/payments', { payment: refund, reason: 'Customer refund checked' });
    await post('/api/v1/lite/invoices/cash-invoice/payments', { payment: refund, reason: 'Repeat refund command' });
    const refunded = await get(itemsUrl);
    assert.equal(refunded.filter((row: { sourceType: string }) => row.sourceType === 'invoice').reduce((sum: number, row: { amountGross: number }) => sum + row.amountGross, 0), 200, 'paid 300, refunded 100 once');
    await post('/api/v1/lite/invoices/cash-invoice/payments/cash-refund/reverse', { expectedPayment: refund, reason: 'Reverse erroneous refund' });
    await post('/api/v1/lite/invoices/cash-invoice/payments/first-paid/reverse', { expectedPayment: firstPaid, reason: 'Reverse partial payment' });
    assert.equal((await get(itemsUrl)).length, 2);
    const paid = { id: 'manual-paid', date: '2026-10-04', amount: 1440, method: 'Bank' };
    await post('/api/v1/lite/invoices/cash-invoice/payments', { payment: paid, reason: 'Pay while dunning renders' });
    await repository.patchDunning!(scope, 'cash-invoice', { dunningLevel: 1, historyEntry: { date: '2026-10-04', action: 'Reminder actually delivered' } });
    const afterDunning = await get('/api/v1/lite/invoices/cash-invoice');
    assert.equal(afterDunning.status, 'paid');
    assert.deepEqual(afterDunning.payments, [paid]);
    assert.equal(afterDunning.dunningLevel, 1);
    assert.ok((await repository.getById(scope, 'cash-invoice'))!.history.some((entry) => entry.action === 'Reminder actually delivered'));
    await post('/api/v1/lite/invoices/cash-invoice/payments/manual-paid/reverse', { expectedPayment: paid, reason: 'Reverse last recorded payment' });
    assert.equal((await get('/api/v1/lite/invoices/cash-invoice')).status, 'open', 'Removing the last payment reopens the receivable');
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('hosted CSV upload handles are scoped and arbitrary server paths are rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'billme-lite-upload-'));
  const database = await PgliteServerDatabase.open(join(dir, 'db'));
  const app = await buildServerApi({ database, runtime: 'server', logger: false, sessionSecret: 'lite-upload-test-secret-32-characters' });
  try {
    const token = app.tokenService.sign({ scope: { tenantId: 'upload-tenant', product: 'lite', deploymentMode: 'single-tenant' }, role: 'owner', user: { id: 'upload-owner', email: 'upload@example.test', fullName: 'Upload Owner', role: 'owner' } });
    const headers = { authorization: `Bearer ${token}` };
    const url = '/api/v1/lite/finance/import/preview';
    const denied = await app.inject({ method: 'POST', url, headers, payload: { path: '/etc/passwd' } });
    assert.equal(denied.statusCode, 400);
    const uploaded = await app.inject({ method: 'POST', url, headers, payload: { fileName: 'bank.csv', contentBase64: Buffer.from('Date,Amount,Name,Purpose\n2026-10-03,119,Customer,RE-CASH\n').toString('base64'), profile: 'generic', mapping: { dateColumn: 'Date', amountColumn: 'Amount' } } });
    assert.equal(uploaded.statusCode, 200, uploaded.body);
    assert.match(uploaded.json().path, /^import-upload:/);
    assert.equal(uploaded.json().fileName, 'bank.csv');
    const otherToken = app.tokenService.sign({ scope: { tenantId: 'other-tenant', product: 'lite', deploymentMode: 'single-tenant' }, role: 'owner', user: { id: 'other-owner', email: 'other@example.test', fullName: 'Other Owner', role: 'owner' } });
    const stolen = await app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${otherToken}` }, payload: { path: uploaded.json().path, profile: 'generic', mapping: { dateColumn: 'Date', amountColumn: 'Amount' } } });
    assert.equal(stolen.statusCode, 404);
    const replay = await app.inject({ method: 'POST', url, headers, payload: { path: uploaded.json().path, profile: 'generic', mapping: { dateColumn: 'Date', amountColumn: 'Amount' } } });
    assert.equal(replay.statusCode, 200, replay.body);
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
