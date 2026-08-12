import assert from 'node:assert/strict';
import test from 'node:test';
import { createSingleTenantScope } from '@billme/server-core';
import type { PostgresQueryable } from './connection.js';
import { createPostgresPool } from './connection.js';
import { runDrizzleMigrations } from './migrations.js';
import { createPostgresProAccountingRepository, insertJournalPostingPair } from './proAccountingRepository.js';

test('journal posting-pair insert binds every persisted column', async () => {
  let captured: { text: string; values: unknown[] } | undefined;
  const db = {
    query: async (text: string, values?: unknown[]) => {
      captured = { text, values: values ?? [] };
      return { rows: [] } as never;
    },
  } as unknown as PostgresQueryable;
  await insertJournalPostingPair(db, ['pair', 'tenant', 'entry', 'debit', 'credit', 10, 'DE_STD_19', '19', '2026-08-12']);
  assert.ok(captured);
  assert.match(captured.text, /datev_bu_key/);
  assert.equal((captured.text.match(/\$\d+/g) ?? []).length, 9);
  assert.equal(captured.values.length, 9);
});

test('OPOS hardening migration protects posted incoming invoice lines and persists tenant ownership', async () => {
  const { readFile } = await import('node:fs/promises');
  const migration = await readFile(new URL('../../drizzle/0007_server_data_opos_hardening.sql', import.meta.url), 'utf8');
  const baseMigration = await readFile(new URL('../../drizzle/0006_server_data_opos.sql', import.meta.url), 'utf8');
  assert.match(migration, /incoming_invoice_lines_posted_immutable/);
  assert.match(migration, /BEFORE INSERT OR UPDATE OR DELETE ON incoming_invoice_lines/);
  assert.match(baseMigration, /vendor_id TEXT NOT NULL REFERENCES vendors/);
  assert.match(migration, /OLD\.incoming_invoice_id/);
  assert.match(migration, /NEW\.incoming_invoice_id/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS config_json/);
  assert.match(migration, /NEW\.status IN \('open','paid','overdue','unresolved'\)/);
});

test('real Postgres permits only OPOS status projection and rejects repeated over-allocation', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const pool = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenantId = `opos-trigger-${suffix}`;
  const scope = createSingleTenantScope(tenantId, 'pro');
  const now = new Date().toISOString();
  const bankAccount = `9${String(Date.now()).slice(-6)}`;
  const receivableAccount = `8${String(Date.now() + 1).slice(-6)}`;
  const payableAccount = `7${String(Date.now() + 2).slice(-6)}`;
  const expenseAccount = `6${String(Date.now() + 3).slice(-6)}`;
  const inputVatAccount = `5${String(Date.now() + 4).slice(-6)}`;
  const line19Account = `4${String(Date.now() + 5).slice(-6)}`;
  const line7Account = `3${String(Date.now() + 6).slice(-6)}`;
  const invoiceId = `invoice-${suffix}`;
  const openItemId = `item-${suffix}`;
  const paymentId = `payment-${suffix}`;
  const vendorId = `vendor-${suffix}`;
  const incomingInvoiceId = `incoming-${suffix}`;
  try {
    await runDrizzleMigrations(pool);
    await pool.query(`INSERT INTO tenants (id,slug,display_name,product,deployment_mode,status,created_at,updated_at) VALUES ($1,$1,$2,'pro','single-tenant','active',$3,$3)`, [tenantId, 'OPOS trigger test', now]);
    await pool.query(`INSERT INTO accounting_policies (tenant_id,active_chart,vat_method,period_policy,updated_at) VALUES ($1,'SKR03','soll','calendar_month',$2)`, [tenantId, now]);
    for (const [id, accountNumber] of [[`bank-${suffix}`, bankAccount], [`receivable-${suffix}`, receivableAccount], [`payable-${suffix}`, payableAccount], [`expense-${suffix}`, expenseAccount], [`input-vat-${suffix}`, inputVatAccount], [`line19-${suffix}`, line19Account], [`line7-${suffix}`, line7Account]] as const) {
      await pool.query(`INSERT INTO ledger_accounts (id,chart,account_number,name,source,created_at,updated_at) VALUES ($1,'SKR03',$2,$2,'test',$3,$3)`, [id, accountNumber, now]);
    }
    await pool.query(`INSERT INTO accounting_account_mappings (id,tenant_id,chart,role,account_number,updated_at) VALUES ($1,$2,'SKR03','bank',$3,$4),($5,$2,'SKR03','accounts_receivable',$6,$4),($7,$2,'SKR03','accounts_payable',$8,$4),($9,$2,'SKR03','expense',$10,$4),($11,$2,'SKR03','input_vat',$12,$4)`, [`bank-map-${suffix}`, tenantId, bankAccount, now, `receivable-map-${suffix}`, receivableAccount, `payable-map-${suffix}`, payableAccount, `expense-map-${suffix}`, expenseAccount, `input-vat-map-${suffix}`, inputVatAccount]);
    await pool.query(`INSERT INTO invoices (id,tenant_id,number,client,client_email,date,due_date,amount,status,dunning_level,items_json,payments_json,history_json,created_at,updated_at,accounting_status,accounting_snapshot_json) VALUES ($1,$2,$3,'Test Client','test@example.test','2026-08-12','2026-08-31',100,'open',0,'[]','[]','[]',$4,$4,'posted','{}')`, [invoiceId, tenantId, `RE-${suffix}`, now]);
    await pool.query(`INSERT INTO open_items (id,tenant_id,party_type,party_id,source_type,source_id,document_number,document_date,due_date,original_amount,allocated_amount,residual_amount,status,created_at,updated_at) VALUES ($1,$2,'debtor','client','outgoing_invoice',$3,$4,'2026-08-12','2026-08-31',100,0,100,'open',$5,$5)`, [openItemId, tenantId, invoiceId, `RE-${suffix}`, now]);

    const repository = createPostgresProAccountingRepository(pool);
    await pool.query(`INSERT INTO vendors (id,tenant_id,name,created_at,updated_at) VALUES ($1,$2,'Mixed rate vendor',$3,$3)`, [vendorId, tenantId, now]);
    await pool.query(`INSERT INTO incoming_invoices (id,tenant_id,vendor_id,number,invoice_date,due_date,net_amount,tax_amount,gross_amount,status,tax_rate,accounting_status,created_at,updated_at) VALUES ($1,$2,$3,$4,'2026-08-12','2026-08-31',200,26,226,'open',19,'unposted',$5,$5)`, [incomingInvoiceId, tenantId, vendorId, `ER-${suffix}`, now]);
    await pool.query(`INSERT INTO incoming_invoice_lines (id,tenant_id,incoming_invoice_id,position,description,quantity,unit_price,net_amount,tax_rate,tax_amount,gross_amount,account_number) VALUES ($1,$2,$3,0,'Standard',1,100,100,19,19,119,$4),($5,$2,$3,1,'Reduced',1,100,100,7,7,107,$6)`, [`incoming-line19-${suffix}`, tenantId, incomingInvoiceId, line19Account, `incoming-line7-${suffix}`, line7Account]);
    const mixedPreview = await repository.previewIncomingInvoice(scope, incomingInvoiceId);
    assert.equal(mixedPreview.status, 'ready');
    const mixedLines = mixedPreview.snapshot!.lines;
    assert.equal(mixedLines.reduce((sum, line) => sum + line.debitAmount, 0), 226);
    assert.equal(mixedLines.find((line) => line.accountNumber === line19Account)?.debitAmount, 100);
    assert.equal(mixedLines.find((line) => line.accountNumber === line7Account)?.debitAmount, 100);
    assert.equal(mixedLines.filter((line) => line.accountNumber === inputVatAccount).reduce((sum, line) => sum + line.debitAmount, 0), 26);
    assert.equal(mixedLines.find((line) => line.accountNumber === payableAccount)?.creditAmount, 226);
    await repository.allocateOpenItemPayment(scope, { paymentId, partyType: 'debtor', partyId: 'client', paymentDate: '2026-08-12', amount: 100, bankAccountNumber: bankAccount, sourceType: 'manual', sourceId: `manual-${suffix}`, allocations: [{ openItemId, amount: 80 }] });
    await assert.rejects(() => repository.allocateRemainingOpenItemPayment(scope, paymentId, [{ openItemId, amount: 80 }]), /PAYMENT_ALLOCATION_EXCEEDS_RESIDUAL/);
    const item = (await pool.query(`SELECT allocated_amount,residual_amount,status FROM open_items WHERE tenant_id=$1 AND id=$2`, [tenantId, openItemId])).rows[0];
    assert.deepEqual({ allocated_amount: Number(item.allocated_amount), residual_amount: Number(item.residual_amount), status: item.status }, { allocated_amount: 80, residual_amount: 20, status: 'partially_paid' });
    const invoice = (await pool.query(`SELECT status,accounting_status FROM invoices WHERE tenant_id=$1 AND id=$2`, [tenantId, invoiceId])).rows[0];
    assert.deepEqual(invoice, { status: 'open', accounting_status: 'posted' });
  } finally {
    await pool.query(`ALTER TABLE invoices DISABLE TRIGGER invoices_posted_immutable`);
    await pool.query(`ALTER TABLE journal_entries DISABLE TRIGGER journal_entries_immutable`);
    await pool.query(`ALTER TABLE journal_lines DISABLE TRIGGER journal_lines_immutable`);
    await pool.query(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_delete`);
    await pool.query(`DELETE FROM incoming_invoices WHERE tenant_id=$1`, [tenantId]);
    await pool.query(`DELETE FROM vendors WHERE tenant_id=$1`, [tenantId]);
    await pool.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]);
    await pool.query(`DELETE FROM ledger_accounts WHERE id LIKE $1`, [`%-${suffix}`]);
    await pool.query(`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_delete`);
    await pool.query(`ALTER TABLE journal_lines ENABLE TRIGGER journal_lines_immutable`);
    await pool.query(`ALTER TABLE journal_entries ENABLE TRIGGER journal_entries_immutable`);
    await pool.query(`ALTER TABLE invoices ENABLE TRIGGER invoices_posted_immutable`);
    await pool.end();
  }
});
