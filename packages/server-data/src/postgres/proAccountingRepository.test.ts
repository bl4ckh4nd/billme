import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { incomingInvoiceSchema } from '@billme/desktop-contracts-pro/schemas';
import type { IncomingInvoiceEntity } from '@billme/accounting-shared';
import { createSingleTenantScope } from '@billme/server-core';
import type { PostgresQueryable, PostgresTransactionClient } from './connection.js';
import { createPostgresPool } from './connection.js';
import { runDrizzleMigrations } from './migrations.js';
import { createPostgresProAccountingRepository, insertJournalPostingPair } from './proAccountingRepository.js';
import { importRawTenantRows } from './oposImport.js';

test('journal posting-pair insert binds every persisted column', async () => {
  let captured: { text: string; values: unknown[] } | undefined;
  const db = {
    query: async (text: string, values?: unknown[]) => {
      captured = { text, values: values ?? [] };
      return { rows: [] } as never;
    },
  } as unknown as PostgresTransactionClient;
  await insertJournalPostingPair(db, ['pair', 'tenant', 'entry', 'debit', 'credit', 10, 'DE_STD_19', '19', '2026-08-12']);
  assert.ok(captured);
  assert.match(captured.text, /datev_bu_key/);
  assert.equal((captured.text.match(/\$\d+/g) ?? []).length, 9);
  assert.equal(captured.values.length, 9);
});

test('OPOS import is tenant-safe and idempotent without global conflict drops', async () => {
  const rows = new Map<string, Record<string, unknown>>();
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      if (text.startsWith('SELECT * FROM vendors')) return { rows: rows.has(String(values[0]) || '') ? [rows.get(String(values[0]))] : [] };
      if (text.startsWith('INSERT INTO vendors')) {
        rows.set(String(values[0]), { id: values[0], tenant_id: values[1], name: values[2] });
        return { rows: [] };
      }
      throw new Error(`unexpected import query: ${text}`);
    },
  } as unknown as PostgresTransactionClient;
  const columns = ['id', 'tenant_id', 'name'];
  const source = [{ id: 'vendor-1', tenant_id: 'source', name: 'Acme' }];
  assert.equal(await importRawTenantRows(client, 'vendors', source, 'tenant-a', columns), 1);
  assert.equal(await importRawTenantRows(client, 'vendors', source, 'tenant-a', columns), 0);
  rows.set('vendor-foreign', { id: 'vendor-foreign', tenant_id: 'tenant-b', name: 'Other' });
  await assert.rejects(() => importRawTenantRows(client, 'vendors', [{ id: 'vendor-foreign', name: 'Changed' }], 'tenant-a', columns), /IMPORT_ID_TENANT_COLLISION/);
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
  assert.match(migration, /ADD COLUMN IF NOT EXISTS event_key/);
  assert.match(migration, /NEW\.status IN \('open','paid','overdue','unresolved'\)/);
});

test('DATEV byte snapshot migration is additive and immutable', async () => {
  const { readFile } = await import('node:fs/promises');
  const migration = await readFile(new URL('../../drizzle/0009_server_data_datev_export_bytes.sql', import.meta.url), 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS content_bytes BYTEA/);
  assert.match(migration, /datev_exports_immutable/);
  assert.match(migration, /OLD\.content_bytes IS DISTINCT FROM NEW\.content_bytes/);
  assert.match(migration, /CREATE TRIGGER datev_exports_immutable BEFORE UPDATE OR DELETE/);
});

test('real Postgres unposted incoming invoices omit empty accounting snapshots for the typed API response', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const pool = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenantId = `incoming-response-${suffix}`;
  const vendorId = `incoming-vendor-${suffix}`;
  const invoiceId = `incoming-invoice-${suffix}`;
  const now = new Date().toISOString();
  const scope = createSingleTenantScope(tenantId, 'pro');
  try {
    await runDrizzleMigrations(pool);
    await pool.query(`INSERT INTO tenants (id,slug,display_name,product,deployment_mode,status,created_at,updated_at) VALUES ($1,$1,$2,'pro','single-tenant','active',$3,$3)`, [tenantId, 'Incoming response test', now]);
    await pool.query(`INSERT INTO vendors (id,tenant_id,name,created_at,updated_at) VALUES ($1,$2,'Snapshot test vendor',$3,$3)`, [vendorId, tenantId, now]);
    const repository = createPostgresProAccountingRepository(pool);
    const saved = await repository.upsertIncomingInvoice(scope, {
      id: invoiceId,
      tenantId,
      vendorId,
      number: `ER-${suffix}`,
      invoiceDate: '2026-08-12',
      dueDate: '2026-08-31',
      netAmount: 100,
      taxAmount: 19,
      grossAmount: 119,
      status: 'open',
      taxRate: 19,
      lines: [{
        id: `${invoiceId}-line`,
        incomingInvoiceId: invoiceId,
        position: 0,
        description: 'Snapshot test service',
        quantity: 1,
        unitPrice: 100,
        netAmount: 100,
        taxRate: 19,
        taxAmount: 19,
        grossAmount: 119,
        accountNumber: '6200',
      }],
      accountingStatus: 'unposted',
      createdAt: now,
      updatedAt: now,
    } satisfies IncomingInvoiceEntity);
    assert.equal(saved.accountingStatus, 'unposted');
    assert.equal(saved.accountingSnapshot, undefined);
    assert.equal(Object.hasOwn(saved, 'accountingSnapshot'), true);
    assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(saved)), 'accountingSnapshot'), false);
    assert.doesNotThrow(() => incomingInvoiceSchema.parse(saved));
    const refetched = (await repository.listIncomingInvoices(scope)).find((invoice) => invoice.id === invoiceId);
    assert.ok(refetched);
    assert.equal(refetched.accountingSnapshot, undefined);
    assert.doesNotThrow(() => incomingInvoiceSchema.parse(refetched));
  } finally {
    try {
      await pool.query(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_delete`);
      await pool.query(`DELETE FROM incoming_invoices WHERE tenant_id=$1`, [tenantId]);
      await pool.query(`DELETE FROM vendors WHERE tenant_id=$1`, [tenantId]);
      await pool.query(`DELETE FROM audit_log WHERE tenant_id=$1`, [tenantId]);
      await pool.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]);
      await pool.query(`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_delete`);
    } finally {
      await pool.end();
    }
  }
});

test('tax-case mapping tenancy migration keeps global defaults and drops global overwrite uniqueness', async () => {
  const { readFile } = await import('node:fs/promises');
  const migration = await readFile(new URL('../../drizzle/0011_server_data_tax_case_mapping_tenancy.sql', import.meta.url), 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS tenant_id TEXT REFERENCES tenants/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS tax_case_account_mappings_chart_tax_case_key_role_key/);
  assert.match(migration, /idx_tax_case_account_mappings_tenant_lookup/);
  assert.match(migration, /WHERE tenant_id IS NULL/);
});

test('asset-owned journal entries stay behind asset correction guards', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./proAccountingRepository.ts', import.meta.url), 'utf8');
  assert.match(source, /entry\.source_type === 'asset_activation'/);
  assert.match(source, /entry\.source_type === 'asset_depreciation'/);
  assert.match(source, /entry\.source_type === 'asset_disposal'/);
  assert.match(source, /ASSET_REVERSAL_REQUIRED/);
  assert.match(source, /ASSET_CORRECTION_REQUIRED/);
});

test('real Postgres DATEV exports return the exact persisted bytes after source changes', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const pool = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const tenantId = `datev-bytes-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const scope = createSingleTenantScope(tenantId, 'pro');
  const now = new Date().toISOString();
  const filePath = `datev-export/test-${tenantId}`;
  const sourceBytes = new TextEncoder().encode('konto;gegenkonto;buchungstext\n1200;8400;"source;before"\n');
  try {
    await runDrizzleMigrations(pool);
    await pool.query(`INSERT INTO tenants (id,slug,display_name,product,deployment_mode,status,created_at,updated_at) VALUES ($1,$1,$2,'pro','single-tenant','active',$3,$3)`, [tenantId, 'DATEV bytes test', now]);
    const repository = createPostgresProAccountingRepository(pool);
    const receipt = await repository.insertDatevExport(scope, {
      filePath,
      recordCount: 1,
      content: sourceBytes,
      contentSha256: createHash('sha256').update(sourceBytes).digest('hex'),
      sourceSnapshot: { recordCount: 1 },
      mutation: { reason: 'verify DATEV snapshot', actor: { type: 'user', id: 'test-user' } },
    });
    const sourceBytesAfterSourceChange = new TextEncoder().encode('konto;gegenkonto;buchungstext\n1200;8400;"source;after"\n');
    assert.notDeepEqual(Array.from(sourceBytes), Array.from(sourceBytesAfterSourceChange));
    const snapshot = await repository.getDatevExportContent!(scope, receipt.id);
    assert.deepEqual(Array.from(snapshot.content), Array.from(sourceBytes));
    assert.equal(snapshot.contentSha256, receipt.contentSha256);
    await assert.rejects(
      () => pool.query(`UPDATE datev_exports SET content_bytes=$1 WHERE tenant_id=$2 AND id=$3`, [sourceBytesAfterSourceChange, tenantId, receipt.id]),
      /DATEV export snapshots are immutable/,
    );
    await assert.rejects(
      () => pool.query(`DELETE FROM datev_exports WHERE tenant_id=$1 AND id=$2`, [tenantId, receipt.id]),
      /DATEV export snapshots are immutable/,
    );
  } finally {
    await pool.query('BEGIN');
    try {
      await pool.query(`ALTER TABLE datev_exports DISABLE TRIGGER datev_exports_immutable`);
      await pool.query(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_delete`);
      await pool.query(`DELETE FROM datev_exports WHERE tenant_id=$1`, [tenantId]);
      await pool.query(`DELETE FROM audit_log WHERE tenant_id=$1`, [tenantId]);
      await pool.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]);
      await pool.query(`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_delete`);
      await pool.query(`ALTER TABLE datev_exports ENABLE TRIGGER datev_exports_immutable`);
      await pool.query('COMMIT');
    } catch (error) {
      await pool.query('ROLLBACK');
      throw error;
    }
    await pool.end();
  }
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
  const deferredVatAccount = `2${String(Date.now() + 7).slice(-6)}`;
  const outputVatAccount = `1${String(Date.now() + 8).slice(-6)}`;
  const mappedOutputVatAccount = `1${String(Date.now() + 9).slice(-6)}`;
  const mappedInputVatAccount = `5${String(Date.now() + 10).slice(-6)}`;
  const reservationTaxCaseKey = `TEST_STD_19_${suffix.replace(/[^a-zA-Z0-9]/g, '').slice(-12)}`;
  const reservationTaxMappingId = `tax-map-${suffix}`;
  const bankAccountId = `bank-account-${suffix}`;
  const bankTransactionId = `bank-transaction-${suffix}`;
  const reservationInvoiceId = `reservation-invoice-${suffix}`;
  const reservationId = `reservation-${suffix}`;
  const backfillInvoiceId = `backfill-invoice-${suffix}`;
  const backfillReservationId = `backfill-reservation-${suffix}`;
  const legacyEntryId = `legacy-entry-${suffix}`;
  const invoiceId = `invoice-${suffix}`;
  const openItemId = `item-${suffix}`;
  const paymentId = `payment-${suffix}`;
  const vendorId = `vendor-${suffix}`;
  const incomingInvoiceId = `incoming-${suffix}`;
  try {
    await runDrizzleMigrations(pool);
    await pool.query(`INSERT INTO tenants (id,slug,display_name,product,deployment_mode,status,created_at,updated_at) VALUES ($1,$1,$2,'pro','single-tenant','active',$3,$3)`, [tenantId, 'OPOS trigger test', now]);
    await pool.query(`INSERT INTO accounting_policies (tenant_id,active_chart,vat_method,period_policy,updated_at) VALUES ($1,'SKR03','soll','calendar_month',$2)`, [tenantId, now]);
    await pool.query(`INSERT INTO accounts (id,tenant_id,name,iban,balance,default_skr_account_number,type,color) VALUES ($1,$2,'Test bank','DE00000000000000000000',0,$3,'bank','#000000')`, [bankAccountId, tenantId, bankAccount]);
    for (const [id, accountNumber] of [[`bank-${suffix}`, bankAccount], [`receivable-${suffix}`, receivableAccount], [`payable-${suffix}`, payableAccount], [`expense-${suffix}`, expenseAccount], [`input-vat-${suffix}`, inputVatAccount], [`mapped-input-vat-${suffix}`, mappedInputVatAccount], [`line19-${suffix}`, line19Account], [`line7-${suffix}`, line7Account], [`deferred-vat-${suffix}`, deferredVatAccount], [`output-vat-${suffix}`, outputVatAccount], [`mapped-output-vat-${suffix}`, mappedOutputVatAccount], [`revenue-${suffix}`, '8400']] as const) {
      await pool.query(`INSERT INTO ledger_accounts (id,chart,account_number,name,source,created_at,updated_at) VALUES ($1,'SKR03',$2,$2,'test',$3,$3) ON CONFLICT (chart,account_number) DO NOTHING`, [id, accountNumber, now]);
    }
    await pool.query(`INSERT INTO tax_cases (key,label,mechanism,default_rate,updated_at) VALUES ('DE_STD_19','Standard 19','domestic',19,$1) ON CONFLICT (key) DO NOTHING`, [now]);
    await pool.query(`INSERT INTO tax_cases (key,label,mechanism,default_rate,updated_at) VALUES ($1,'Test Standard 19','domestic',19,$2)`, [reservationTaxCaseKey, now]);
    await pool.query(`INSERT INTO tax_case_account_mappings (id,chart,tax_case_key,role,account_number,updated_at) VALUES ($1,'SKR03',$2,'output_tax',$3,$4)`, [reservationTaxMappingId, reservationTaxCaseKey, mappedOutputVatAccount, now]);
    await pool.query(`INSERT INTO tax_case_account_mappings (id,chart,tax_case_key,role,account_number,updated_at) VALUES ($1,'SKR03','DE_STD_19','input_tax',$2,$3)`, [`tax-input-map-${suffix}`, mappedInputVatAccount, now]);
    await pool.query(`INSERT INTO accounting_account_mappings (id,tenant_id,chart,role,account_number,updated_at) VALUES ($1,$2,'SKR03','bank',$3,$4),($5,$2,'SKR03','accounts_receivable',$6,$4),($7,$2,'SKR03','accounts_payable',$8,$4),($9,$2,'SKR03','expense',$10,$4),($11,$2,'SKR03','input_vat',$12,$4),($13,$2,'SKR03','output_vat_deferred',$14,$4),($15,$2,'SKR03','output_vat',$16,$4)`, [`bank-map-${suffix}`, tenantId, bankAccount, now, `receivable-map-${suffix}`, receivableAccount, `payable-map-${suffix}`, payableAccount, `expense-map-${suffix}`, expenseAccount, `input-vat-map-${suffix}`, inputVatAccount, `deferred-map-${suffix}`, deferredVatAccount, `output-map-${suffix}`, outputVatAccount]);
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
    assert.equal(mixedLines.filter((line) => line.accountNumber === mappedInputVatAccount).reduce((sum, line) => sum + line.debitAmount, 0), 19);
    assert.equal(mixedLines.filter((line) => line.accountNumber === inputVatAccount).reduce((sum, line) => sum + line.debitAmount, 0), 7);
    assert.equal(mixedLines.find((line) => line.accountNumber === payableAccount)?.creditAmount, 226);
    await repository.postIncomingInvoice(scope, incomingInvoiceId);
    await assert.rejects(() => pool.query(`UPDATE incoming_invoice_lines SET description='tampered' WHERE tenant_id=$1 AND id=$2`, [tenantId, `incoming-line19-${suffix}`]), /posted incoming invoice lines are immutable/);
    await assert.rejects(() => pool.query(`INSERT INTO incoming_invoice_lines (id,tenant_id,incoming_invoice_id,position,description,quantity,unit_price,net_amount,tax_rate,tax_amount,gross_amount) VALUES ($1,$2,$3,99,'tampered',1,1,1,19,.19,1.19)`, [`tamper-line-${suffix}`, tenantId, incomingInvoiceId]), /posted incoming invoice lines are immutable/);
    await assert.rejects(() => pool.query(`DELETE FROM incoming_invoice_lines WHERE tenant_id=$1 AND id=$2`, [tenantId, `incoming-line19-${suffix}`]), /posted incoming invoice lines are immutable/);
    const noEventPaymentCount = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM open_item_payments WHERE tenant_id=$1`, [tenantId])).rows[0].count);
    const noEventJournalCount = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM journal_entries WHERE tenant_id=$1`, [tenantId])).rows[0].count);
    await assert.rejects(() => repository.allocateOpenItemPayment(scope, { paymentId: `no-event-${suffix}`, partyType: 'debtor', partyId: 'client', paymentDate: '2026-08-12', amount: 100, bankAccountNumber: bankAccount, sourceType: 'manual', sourceId: `no-event-${suffix}`, allocations: [{ openItemId, amount: 10 }] } as any), /ALLOCATION_EVENT_ID_REQUIRED/);
    assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS count FROM open_item_payments WHERE tenant_id=$1`, [tenantId])).rows[0].count), noEventPaymentCount);
    assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS count FROM journal_entries WHERE tenant_id=$1`, [tenantId])).rows[0].count), noEventJournalCount);
    await repository.allocateOpenItemPayment(scope, { paymentId, partyType: 'debtor', partyId: 'client', paymentDate: '2026-08-12', amount: 100, bankAccountNumber: bankAccount, sourceType: 'manual', sourceId: `manual-${suffix}`, allocations: [{ openItemId, amount: 80 }], allocationEventId: 'initial-80', reason: 'test allocation' });
    await assert.rejects(() => repository.allocateRemainingOpenItemPayment(scope, paymentId, [{ openItemId, amount: 1 }], '' as any), /ALLOCATION_EVENT_ID_REQUIRED/);
    await assert.rejects(() => repository.allocateRemainingOpenItemPayment(scope, paymentId, [{ openItemId, amount: 80 }], 'over-allocation'), /PAYMENT_ALLOCATION_EXCEEDS_RESIDUAL/);
    const item = (await pool.query(`SELECT allocated_amount,residual_amount,status FROM open_items WHERE tenant_id=$1 AND id=$2`, [tenantId, openItemId])).rows[0];
    assert.deepEqual({ allocated_amount: Number(item.allocated_amount), residual_amount: Number(item.residual_amount), status: item.status }, { allocated_amount: 80, residual_amount: 20, status: 'partially_paid' });
    const invoice = (await pool.query(`SELECT status,accounting_status FROM invoices WHERE tenant_id=$1 AND id=$2`, [tenantId, invoiceId])).rows[0];
    assert.deepEqual(invoice, { status: 'open', accounting_status: 'posted' });
    await pool.query(`INSERT INTO bank_transactions (id,tenant_id,account_id,date,amount,type,counterparty,purpose,linked_invoice_id,status,source_transaction_id,created_at,updated_at) VALUES ($1,$2,$3,'2026-08-12',20,'income','Test payer','RE test',NULL,'pending',$1,$4,$4)`, [bankTransactionId, tenantId, bankAccountId, now]);
    await assert.rejects(() => repository.allocateOpenItemPayment(scope, { partyType: 'debtor', partyId: 'client', paymentDate: '2026-08-12', amount: 19, bankAccountNumber: bankAccount, sourceType: 'bank_transaction', sourceId: bankTransactionId, allocations: [{ openItemId, amount: 19 }], allocationEventId: 'bank-wrong-amount', reason: 'test allocation' }), /PAYMENT_SOURCE_MISMATCH/);
    await assert.rejects(() => repository.allocateOpenItemPayment(scope, { partyType: 'debtor', partyId: 'client', paymentDate: '2026-08-13', amount: 20, bankAccountNumber: bankAccount, sourceType: 'bank_transaction', sourceId: bankTransactionId, allocations: [{ openItemId, amount: 20 }], allocationEventId: 'bank-wrong-date', reason: 'test allocation' }), /PAYMENT_SOURCE_MISMATCH/);
    await assert.rejects(() => repository.allocateOpenItemPayment(scope, { partyType: 'creditor', partyId: 'client', paymentDate: '2026-08-12', amount: 20, bankAccountNumber: bankAccount, sourceType: 'bank_transaction', sourceId: bankTransactionId, allocations: [{ openItemId, amount: 20 }], allocationEventId: 'bank-wrong-direction', reason: 'test allocation' }), /PAYMENT_SOURCE_DIRECTION_MISMATCH/);
    await assert.rejects(() => repository.allocateOpenItemPayment(createSingleTenantScope(`foreign-${suffix}`, 'pro'), { partyType: 'debtor', partyId: 'client', paymentDate: '2026-08-12', amount: 20, bankAccountNumber: bankAccount, sourceType: 'bank_transaction', sourceId: bankTransactionId, allocations: [{ openItemId, amount: 20 }], allocationEventId: 'bank-foreign', reason: 'test allocation' }), /PAYMENT_SOURCE_NOT_FOUND/);
    await repository.allocateOpenItemPayment(scope, { partyType: 'debtor', partyId: 'client', paymentDate: '2026-08-12', amount: 20, bankAccountNumber: bankAccount, sourceType: 'bank_transaction', sourceId: bankTransactionId, allocations: [{ openItemId, amount: 20 }], allocationEventId: 'bank-payment', reason: 'test allocation' });
    assert.equal((await pool.query(`SELECT status,linked_invoice_id FROM bank_transactions WHERE tenant_id=$1 AND id=$2`, [tenantId, bankTransactionId])).rows[0].status, 'booked');
    await pool.query(`INSERT INTO invoices (id,tenant_id,number,client,client_email,date,due_date,amount,status,dunning_level,items_json,payments_json,history_json,created_at,updated_at,accounting_status,tax_snapshot_json) VALUES ($1,$2,$3,'Reserved client','test@example.test','2026-08-12','2026-08-31',119,'open',0,$4,'[]','[]',$5,$5,'unposted',$6)`, [reservationInvoiceId, tenantId, `RE-RES-${suffix}`, JSON.stringify([{ description: 'Service', total: 119, taxRate: 19 }]), now, JSON.stringify({ netAmount: 100, taxAmount: 19, grossAmount: 119, vatBreakdown: [{ rate: 19, netAmount: 100, vatAmount: 19, taxCaseKey: reservationTaxCaseKey }] })]);
    await assert.rejects(() => repository.postOutgoingInvoice(scope, reservationInvoiceId), /FINALIZED_RESERVATION_REQUIRED/);
    await pool.query(`INSERT INTO number_reservations (id,tenant_id,kind,number,counter_value,status,document_id,created_at,updated_at) VALUES ($1,$2,'offer',$3,1,'finalized',$4,$5,$5)`, [reservationId, tenantId, `RE-RES-${suffix}`, reservationInvoiceId, now]);
    const reservationPreview = await repository.previewOutgoingInvoice(scope, reservationInvoiceId);
    assert.equal(reservationPreview.snapshot?.lines.find((line) => line.memo?.startsWith('USt '))?.accountNumber, mappedOutputVatAccount);
    await assert.rejects(() => repository.postOutgoingInvoice(scope, reservationInvoiceId, { reservationId }), /FINALIZED_RESERVATION_REQUIRED/);
    await pool.query(`UPDATE number_reservations SET kind='invoice',number='WRONG',updated_at=$1 WHERE id=$2`, [now, reservationId]);
    await assert.rejects(() => repository.postOutgoingInvoice(scope, reservationInvoiceId, { reservationId }), /FINALIZED_RESERVATION_REQUIRED/);
    await pool.query(`UPDATE number_reservations SET number=$1,updated_at=$2 WHERE id=$3`, [`RE-RES-${suffix}`, now, reservationId]);
    await pool.query(`UPDATE invoices SET status='draft',updated_at=$1 WHERE tenant_id=$2 AND id=$3`, [now, tenantId, reservationInvoiceId]);
    await assert.rejects(() => repository.postOutgoingInvoice(scope, reservationInvoiceId, { reservationId }), /FINALIZED_RESERVATION_REQUIRED/);
    await pool.query(`UPDATE invoices SET status='open',updated_at=$1 WHERE tenant_id=$2 AND id=$3`, [now, tenantId, reservationInvoiceId]);
    const postedReservation = await repository.postOutgoingInvoice(scope, reservationInvoiceId, { reservationId });
    assert.equal(postedReservation.status, 'ready', JSON.stringify(postedReservation));
    const postedReservationRow = (await pool.query(`SELECT accounting_status,accounting_posted_at FROM invoices WHERE tenant_id=$1 AND id=$2`, [tenantId, reservationInvoiceId])).rows[0];
    assert.equal(postedReservationRow.accounting_status, 'posted');
    assert.ok(postedReservationRow.accounting_posted_at);
    const legacyEntryNumber = Number((await pool.query(`SELECT COALESCE(MAX(entry_number),0)+1 AS number FROM journal_entries WHERE tenant_id=$1`, [tenantId])).rows[0].number);
    await pool.query(`INSERT INTO journal_entries (id,tenant_id,entry_number,posting_date,document_date,booking_text,period,fiscal_year,status,source_type,source_key,created_at) VALUES ($1,$2,$3,'2026-08-11','2026-08-11','Legacy imported','2026-08',2026,'posted','legacy_transaction',$4,$5)`, [legacyEntryId, tenantId, legacyEntryNumber, `legacy:${suffix}`, now]);
    await pool.query(`INSERT INTO journal_lines (id,tenant_id,entry_id,line_no,account_number,debit_amount,credit_amount) VALUES ($1,$2,$3,1,$4,10,0),($5,$2,$3,2,$6,0,10)`, [`legacy-debit-${suffix}`, tenantId, legacyEntryId, bankAccount, `legacy-credit-${suffix}`, receivableAccount]);
    const datevRows = await repository.buildDatevRows(scope, { from: '2026-08-11', to: '2026-08-12' });
    assert.ok(datevRows.some((row) => row.belegfeld1 === String(legacyEntryNumber) && row.umsatz === 10));
    assert.ok(datevRows.some((row) => row.belegfeld1 !== String(legacyEntryNumber)));
    const allocationCountBeforeAuditFailure = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM open_item_allocations WHERE tenant_id=$1 AND payment_id=$2`, [tenantId, paymentId])).rows[0].count);
    await assert.rejects(() => repository.allocateOpenItemPayment(scope, { paymentId, partyType: 'debtor', partyId: 'client', paymentDate: '2026-08-12', amount: 100, bankAccountNumber: bankAccount, sourceType: 'manual', sourceId: `manual-${suffix}`, allocations: [{ openItemId, amount: 10 }], allocationEventId: 'audit-failure', reason: 'test allocation', mutation: { reason: '   ', actor: { type: 'user', id: 'reviewer' } } }), /ACCOUNTING_AUDIT_REASON_REQUIRED/);
    assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS count FROM open_item_allocations WHERE tenant_id=$1 AND payment_id=$2`, [tenantId, paymentId])).rows[0].count), allocationCountBeforeAuditFailure);

    await pool.query(`UPDATE accounting_policies SET vat_method='ist' WHERE tenant_id=$1`, [tenantId]);
    const vatBaseline = (await repository.getVatSummary(scope)).rows.find((row) => row.taxCaseKey === 'DE_STD_19')?.taxAmount ?? 0;
    const istInvoiceId = `ist-invoice-${suffix}`;
    const istItemId = `ist-item-${suffix}`;
    await pool.query(`INSERT INTO invoices (id,tenant_id,number,client,client_email,date,due_date,amount,status,dunning_level,items_json,payments_json,history_json,created_at,updated_at,accounting_status,accounting_snapshot_json) VALUES ($1,$2,$3,'Ist Client','test@example.test','2026-08-12','2026-08-31',119,'open',0,'[]','[]','[]',$4,$4,'posted',$5)`, [istInvoiceId, tenantId, `RE-IST-${suffix}`, now, JSON.stringify({ sourceType: 'outgoing_invoice', sourceId: istInvoiceId, sourceVersion: 'fixture', chart: 'SKR03', vatMethod: 'ist', netAmount: 100, taxAmount: 19, grossAmount: 119, lines: [{ id: 'ar', accountNumber: receivableAccount, debitAmount: 119, creditAmount: 0 }, { id: 'base', accountNumber: '8400', debitAmount: 0, creditAmount: 100, memo: 'UStBasis DE_STD_19' }, { id: 'vat', accountNumber: deferredVatAccount, debitAmount: 0, creditAmount: 19, memo: 'USt DE_STD_19' }], capturedAt: now })]);
    await pool.query(`INSERT INTO open_items (id,tenant_id,party_type,party_id,source_type,source_id,document_number,document_date,due_date,original_amount,allocated_amount,residual_amount,status,created_at,updated_at) VALUES ($1,$2,'debtor','ist-client','outgoing_invoice',$3,$4,'2026-08-12','2026-08-31',119,0,119,'open',$5,$5)`, [istItemId, tenantId, istInvoiceId, `RE-IST-${suffix}`, now]);
    const istPaymentId = `ist-payment-${suffix}`;
    await repository.allocateOpenItemPayment(scope, { paymentId: istPaymentId, partyType: 'debtor', partyId: 'ist-client', paymentDate: '2026-08-12', amount: 119, bankAccountNumber: bankAccount, sourceType: 'manual', sourceId: `ist-manual-${suffix}`, allocations: [{ openItemId: istItemId, amount: 59.5 }], allocationEventId: 'ist-first', reason: 'test allocation' });
    assert.equal((await pool.query(`SELECT COUNT(*)::int c FROM journal_entries WHERE tenant_id=$1 AND source_type='payment_vat'`, [tenantId])).rows[0].c, 1);
    assert.equal((await repository.getVatSummary(scope)).rows.find((row) => row.taxCaseKey === 'DE_STD_19')?.taxAmount, vatBaseline + 9.5);
    await repository.allocateOpenItemPayment(scope, { paymentId: istPaymentId, partyType: 'debtor', partyId: 'ist-client', paymentDate: '2026-08-12', amount: 119, bankAccountNumber: bankAccount, sourceType: 'manual', sourceId: `ist-manual-${suffix}`, allocations: [{ openItemId: istItemId, amount: 59.5 }], allocationEventId: 'ist-first', reason: 'test allocation' });
    assert.equal((await pool.query(`SELECT COUNT(*)::int c FROM journal_entries WHERE tenant_id=$1 AND source_type='payment_vat'`, [tenantId])).rows[0].c, 1);
    await repository.allocateRemainingOpenItemPayment(scope, istPaymentId, [{ openItemId: istItemId, amount: 59.5 }], 'ist-second');
    assert.equal((await pool.query(`SELECT COUNT(*)::int c FROM journal_entries WHERE tenant_id=$1 AND source_type='payment_vat'`, [tenantId])).rows[0].c, 2);
    assert.equal((await repository.getVatSummary(scope)).rows.find((row) => row.taxCaseKey === 'DE_STD_19')?.taxAmount, vatBaseline + 19);
    await repository.allocateRemainingOpenItemPayment(scope, istPaymentId, [{ openItemId: istItemId, amount: 59.5 }], 'ist-replay-after-paid');
    assert.equal((await pool.query(`SELECT COUNT(*)::int c FROM journal_entries WHERE tenant_id=$1 AND source_type='payment_vat'`, [tenantId])).rows[0].c, 2);
    const balances = await repository.getLedgerBalances(scope, { fromDate: '2026-08-12', asOfDate: '2026-08-12' });
    assert.ok(balances.some((row) => row.debitTurnover > 0));
    const guv = await repository.getGuvReport(scope, { from: '2026-08-12', to: '2026-08-12' });
    assert.ok(guv.rows.some((row) => row.positionKey.startsWith('unmapped:')));
    const bilanz = await repository.getBilanzReport(scope, { asOfDate: '2026-08-12' });
    assert.ok((bilanz.unmappedAccounts ?? []).length > 0);
    const backfillNumber = `RE-BF-${suffix}`;
    await pool.query(`INSERT INTO invoices (id,tenant_id,number,client,client_email,date,due_date,amount,status,dunning_level,items_json,payments_json,history_json,created_at,updated_at,accounting_status) VALUES ($1,$2,$3,'Backfill client','test@example.test','2026-08-12','2026-08-31',119,'open',0,$4,'[]','[]',$5,$5,'unposted')`, [backfillInvoiceId, tenantId, backfillNumber, JSON.stringify([{ description: 'Backfill service', total: 119, taxRate: 19 }]), now]);
    await pool.query(`INSERT INTO number_reservations (id,tenant_id,kind,number,counter_value,status,document_id,created_at,updated_at) VALUES ($1,$2,'invoice',$3,1,'finalized',$4,$5,$5)`, [backfillReservationId, tenantId, backfillNumber, backfillInvoiceId, now]);
    const backfillPreview = await repository.previewAccountingBackfill(scope);
    assert.ok(backfillPreview.candidates.some((candidate) => candidate.sourceId === backfillInvoiceId && candidate.status === 'ready'));
    await pool.query(`UPDATE tax_case_account_mappings SET account_number=$1,updated_at=$2 WHERE id=$3`, [outputVatAccount, now, reservationTaxMappingId]);
    await assert.rejects(() => repository.confirmAccountingBackfill(scope, { runId: backfillPreview.runId, confirmationHash: backfillPreview.confirmationHash, reason: 'review backfill' }), /BACKFILL_STALE_PREVIEW/);
    assert.equal((await pool.query(`SELECT accounting_status FROM invoices WHERE tenant_id=$1 AND id=$2`, [tenantId, backfillInvoiceId])).rows[0].accounting_status, 'unposted');
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM journal_entries WHERE tenant_id=$1 AND source_type='outgoing_invoice' AND source_key=$2`, [tenantId, `outgoing_invoice:${backfillInvoiceId}`])).rows[0].count, 0);
    const terminalPreview = await repository.previewAccountingBackfill(scope);
    assert.ok(terminalPreview.candidates.some((candidate) => candidate.sourceId === backfillInvoiceId && candidate.status === 'ready'));
    await pool.query(`UPDATE invoices SET status='cancelled',accounting_status='reversed',updated_at=$1 WHERE tenant_id=$2 AND id=$3`, [now, tenantId, backfillInvoiceId]);
    await assert.rejects(() => repository.confirmAccountingBackfill(scope, { runId: terminalPreview.runId, confirmationHash: terminalPreview.confirmationHash, reason: 'terminal backfill source' }), /BACKFILL_STALE_PREVIEW/);
    const outgoingJournalCountBeforeTerminalPost = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM journal_entries WHERE tenant_id=$1`, [tenantId])).rows[0].count);
    await assert.rejects(() => repository.postOutgoingInvoice(scope, backfillInvoiceId, { reservationId: backfillReservationId }), /DOCUMENT_NOT_POSTABLE/);
    assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS count FROM journal_entries WHERE tenant_id=$1`, [tenantId])).rows[0].count), outgoingJournalCountBeforeTerminalPost);
    await repository.reverseDocumentAccounting(scope, { documentType: 'incoming_invoice', documentId: incomingInvoiceId, reason: 'terminal incoming test' });
    const incomingTerminalPreview = await repository.previewAccountingBackfill(scope);
    assert.equal(incomingTerminalPreview.candidates.some((candidate) => candidate.sourceId === incomingInvoiceId), false);
    const incomingJournalCountBeforeTerminalPost = Number((await pool.query(`SELECT COUNT(*)::int AS count FROM journal_entries WHERE tenant_id=$1`, [tenantId])).rows[0].count);
    await assert.rejects(() => repository.postIncomingInvoice(scope, incomingInvoiceId), /DOCUMENT_NOT_POSTABLE/);
    assert.equal(Number((await pool.query(`SELECT COUNT(*)::int AS count FROM journal_entries WHERE tenant_id=$1`, [tenantId])).rows[0].count), incomingJournalCountBeforeTerminalPost);
  } finally {
    await pool.query(`ALTER TABLE invoices DISABLE TRIGGER invoices_posted_immutable`);
    await pool.query(`ALTER TABLE incoming_invoices DISABLE TRIGGER incoming_invoices_posted_immutable`);
    await pool.query(`ALTER TABLE journal_entries DISABLE TRIGGER journal_entries_immutable`);
    await pool.query(`ALTER TABLE journal_lines DISABLE TRIGGER journal_lines_immutable`);
    await pool.query(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_delete`);
    await pool.query(`DELETE FROM incoming_invoices WHERE tenant_id=$1`, [tenantId]);
    await pool.query(`DELETE FROM vendors WHERE tenant_id=$1`, [tenantId]);
    await pool.query(`DELETE FROM tax_case_account_mappings WHERE id=$1`, [reservationTaxMappingId]);
    await pool.query(`DELETE FROM tax_cases WHERE key=$1`, [reservationTaxCaseKey]);
    await pool.query(`DELETE FROM tax_case_account_mappings WHERE id=$1`, [`tax-input-map-${suffix}`]);
    await pool.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]);
    await pool.query(`DELETE FROM ledger_accounts WHERE id LIKE $1`, [`%-${suffix}`]);
    await pool.query(`ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_delete`);
    await pool.query(`ALTER TABLE journal_lines ENABLE TRIGGER journal_lines_immutable`);
    await pool.query(`ALTER TABLE journal_entries ENABLE TRIGGER journal_entries_immutable`);
    await pool.query(`ALTER TABLE invoices ENABLE TRIGGER invoices_posted_immutable`);
    await pool.query(`ALTER TABLE incoming_invoices ENABLE TRIGGER incoming_invoices_posted_immutable`);
    await pool.end();
  }
});
