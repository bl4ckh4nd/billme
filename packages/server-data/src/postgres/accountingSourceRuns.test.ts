import assert from 'node:assert/strict';
import { sha256Hex, stableStringify } from './audit.js';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CorrectionSettlementError } from '@billme/accounting-shared';
import { createSingleTenantScope } from '@billme/server-core';
import { createPostgresPool, type PostgresQueryable } from './connection.js';
import { runDrizzleMigrations } from './migrations.js';
import { createPostgresProAccountingRepository } from './proAccountingRepository.js';
import { taxCaseForCorrectionRate, taxExportDirectionFromPersistedSource } from './accountingSourceRuns.js';
import { journalSourceIdentity } from '@billme/accounting-engine';

const databaseUrl = process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

test('tax export direction follows persisted source ownership and fails closed when it is absent', () => {
  assert.equal(taxExportDirectionFromPersistedSource({ source_type: 'outgoing_invoice' }), 'output');
  assert.equal(taxExportDirectionFromPersistedSource({ source_type: 'incoming_invoice' }), 'input');
  assert.equal(taxExportDirectionFromPersistedSource({ source_type: 'standalone_source', account_role: 'expense' }), 'input');
  assert.equal(taxExportDirectionFromPersistedSource({ source_type: 'standalone_source', account_role: 'revenue' }), 'output');
  assert.throws(() => taxExportDirectionFromPersistedSource({ source_type: 'standalone_source' }), /TAX_EXPORT_DIRECTION_UNRESOLVED/);
});

test('correction tax mapping supports only canonical rates', () => {
  assert.equal(taxCaseForCorrectionRate(19), 'DE_STD_19');
  assert.equal(taxCaseForCorrectionRate(7), 'DE_STD_7');
  assert.equal(taxCaseForCorrectionRate(0), 'DE_ZERO_EXEMPT');
  assert.throws(() => taxCaseForCorrectionRate(8), /CORRECTION_TAX_CASE_UNSUPPORTED/);
});

test('accounting source-run migration is tenant-scoped, immutable, and replay-keyed', async () => {
  const sql = await readFile(new URL('../../drizzle/0022_server_data_accounting_source_runs.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS accounting_source_runs/);
  assert.match(sql, /UNIQUE \(tenant_id, source_type, source_id, source_revision\)/);
  assert.match(sql, /UNIQUE \(tenant_id, idempotency_key\)/);
  assert.match(sql, /accounting_source_runs_immutable/);
  assert.match(sql, /journal_entry_id TEXT REFERENCES journal_entries\(id\)/);
});

test('closing source facts persist once, replay deterministically, and remain tenant-isolated', { skip: !databaseUrl }, async () => {
  const pool = createPostgresPool(databaseUrl!);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenantA = `source-run-a-${suffix}`;
  const tenantB = `source-run-b-${suffix}`;
  const now = new Date().toISOString();
  try {
    await runDrizzleMigrations(pool);
    for (const tenantId of [tenantA, tenantB]) {
      await pool.query(`INSERT INTO tenants (id,slug,display_name,product,deployment_mode,status,created_at,updated_at) VALUES ($1,$1,$2,'pro','single-tenant','active',$3,$3)`, [tenantId, tenantId, now]);
      await pool.query(`INSERT INTO accounting_policies (tenant_id,active_chart,vat_method,period_policy,updated_at) VALUES ($1,'SKR03','soll','calendar_month',$2)`, [tenantId, now]);
    }
    await pool.query(`INSERT INTO ledger_accounts (id,chart,account_number,name,source,created_at,updated_at) VALUES ($1,'SKR03','1000','Cash','test',$2,$2),($3,'SKR03','2000','Equity','test',$2,$2) ON CONFLICT DO NOTHING`, [`source-account-a-${suffix}`, now, `source-account-b-${suffix}`]);
    const scopeA = createSingleTenantScope(tenantA, 'pro');
    const scopeB = createSingleTenantScope(tenantB, 'pro');
    const repository = createPostgresProAccountingRepository(pool);
    const input = {
      command: 'source_fact' as const,
      sourceId: `fact-${suffix}`,
      sourceRevision: 'v1',
      idempotencyKey: `fact-${suffix}:v1`,
      reason: 'Closing source fact reviewed',
      input: {
        sourceType: 'standalone_source' as const,
        sourceId: `fact-${suffix}`,
        sourceRevision: 'v1',
        effectiveDate: '2025-01-31',
        postingDate: '2025-01-31',
        period: '2025-01',
        fiscalYear: 2025,
        currency: 'EUR',
        bookingText: 'Test source fact',
        lines: [
          { accountNumber: '1000', debitAmount: 10, creditAmount: 0 },
          { accountNumber: '2000', debitAmount: 0, creditAmount: 10 },
        ],
      },
    };
    const first = await repository.runClosingCommand(scopeA, input);
    const replay = await repository.runClosingCommand(scopeA, input);
    const otherTenant = await repository.runClosingCommand(scopeB, input);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal(otherTenant.replayed, false);
    assert.notEqual(first.run.journalEntryId, otherTenant.run.journalEntryId);
    const firstLineIds = (await pool.query(`SELECT id FROM journal_lines WHERE tenant_id=$1 AND entry_id=$2 ORDER BY line_no`, [tenantA, first.run.journalEntryId])).rows.map((row) => row.id);
    const otherLineIds = (await pool.query(`SELECT id FROM journal_lines WHERE tenant_id=$1 AND entry_id=$2 ORDER BY line_no`, [tenantB, otherTenant.run.journalEntryId])).rows.map((row) => row.id);
    assert.notDeepEqual(firstLineIds, otherLineIds);
    assert.equal((await repository.listAccountingSourceRuns(scopeB)).length, 1);
    const delimiterA = await repository.runClosingCommand(scopeA, {
      ...input,
      sourceId: `${input.sourceId}:part`,
      idempotencyKey: `${input.idempotencyKey}:part`,
      input: { ...input.input, sourceId: `${input.sourceId}:part`, sourceRevision: 'revision' },
    });
    const delimiterB = await repository.runClosingCommand(scopeA, {
      ...input,
      sourceId: input.sourceId,
      sourceRevision: 'part:revision',
      idempotencyKey: `${input.idempotencyKey}:other`,
      input: { ...input.input, sourceId: input.sourceId, sourceRevision: 'part:revision' },
    });
    assert.notEqual(delimiterA.run.journalEntryId, delimiterB.run.journalEntryId);
    await assert.rejects(() => repository.runClosingCommand(scopeA, { ...input, input: { ...input.input, lines: [{ accountNumber: '1000', debitAmount: 20, creditAmount: 0 }, { accountNumber: '2000', debitAmount: 0, creditAmount: 20 }] } }), /ACCOUNTING_SOURCE_RUN_CONFLICT/);
    assert.equal((await repository.listAccountingSourceRuns(scopeA)).length, 3);
  } finally {
    await pool.query(`DELETE FROM tenants WHERE id = ANY($1::text[])`, [[tenantA, tenantB]]).catch(() => undefined);
    await pool.end();
  }
});

test('source-fact validation rolls back invalid accounts and rejects incomplete tax evidence', { skip: !databaseUrl }, async () => {
  const pool = createPostgresPool(databaseUrl!);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenantId = `source-run-invalid-${suffix}`;
  const now = new Date().toISOString();
  try {
    await runDrizzleMigrations(pool);
    await pool.query(`INSERT INTO tenants (id,slug,display_name,product,deployment_mode,status,created_at,updated_at) VALUES ($1,$1,$2,'pro','single-tenant','active',$3,$3)`, [tenantId, tenantId, now]);
    await pool.query(`INSERT INTO accounting_policies (tenant_id,active_chart,vat_method,period_policy,updated_at) VALUES ($1,'SKR03','soll','calendar_month',$2)`, [tenantId, now]);
    await pool.query(`INSERT INTO ledger_accounts (id,chart,account_number,name,source,created_at,updated_at) VALUES ($1,'SKR03','1000','Cash','test',$2,$2),($3,'SKR03','2000','Equity','test',$2,$2) ON CONFLICT DO NOTHING`, [`source-invalid-a-${suffix}`, now, `source-invalid-b-${suffix}`]);
    const repository = createPostgresProAccountingRepository(pool);
    const scope = createSingleTenantScope(tenantId, 'pro');
    const invalid = {
      command: 'source_fact' as const,
      sourceId: `invalid-${suffix}`,
      sourceRevision: 'v1',
      idempotencyKey: `invalid-${suffix}:v1`,
      reason: 'Invalid account test',
      input: {
        sourceType: 'standalone_source' as const, sourceId: `invalid-${suffix}`, sourceRevision: 'v1', effectiveDate: '2025-01-31', postingDate: '2025-01-31', period: '2025-01', fiscalYear: 2025, currency: 'EUR', bookingText: 'Invalid',
        lines: [{ accountNumber: '9999', debitAmount: 10, creditAmount: 0 }, { accountNumber: '2000', debitAmount: 0, creditAmount: 10 }],
      },
    };
    await assert.rejects(() => repository.runClosingCommand(scope, invalid), /UNKNOWN_ACCOUNT/);
    assert.equal((await repository.listAccountingSourceRuns(scope)).length, 0);
    await assert.rejects(() => repository.runClosingCommand(scope, {
      ...invalid,
      sourceId: `invalid-skr04-${suffix}`,
      idempotencyKey: `invalid-skr04-${suffix}:v1`,
      input: { ...invalid.input, sourceId: `invalid-skr04-${suffix}`, lines: [{ accountNumber: '9997', debitAmount: 10, creditAmount: 0 }, { accountNumber: '2000', debitAmount: 0, creditAmount: 10 }] },
    }), /UNKNOWN_ACCOUNT:9997/);
    await assert.rejects(() => repository.prepareTaxExport(scope, {
      kind: 'zm', period: '2025-01', reason: 'Evidence test', entries: [{ postingDate: '2025-01-31', status: 'posted', lines: [{ taxCaseKey: 'EU_B2B_SERVICE_RC', netAmount: 100, countryCode: 'FR', counterpartyVatId: 'FR12345678901' }] }],
    }), /MISSING_EVIDENCE/);
  } finally {
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]).catch(() => undefined);
    await pool.end();
  }
});

test('settlement commands derive balanced journal lines, evidence, and replay identity', { skip: !databaseUrl }, async () => {
  const pool = createPostgresPool(databaseUrl!);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenantId = `source-settlement-${suffix}`;
  const now = new Date().toISOString();
  const sourceId = `settlement-${suffix}`;
  const originalId = `settlement-original-${suffix}`;
  const originalJournalId = `settlement-original-journal-${suffix}`;
  const facts = { effectiveDate: '2025-01-31', postingDate: '2025-01-31', period: '2025-01', fiscalYear: 2025, currency: 'EUR', taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }], skontoAmount: 11.9, originalDocumentId: originalId };
  try {
    await runDrizzleMigrations(pool);
    await pool.query(`INSERT INTO tenants (id,slug,display_name,product,deployment_mode,status,created_at,updated_at) VALUES ($1,$1,$2,'pro','single-tenant','active',$3,$3)`, [tenantId, 'Settlement source', now]);
    await pool.query(`INSERT INTO accounting_policies (tenant_id,active_chart,vat_method,period_policy,updated_at) VALUES ($1,'SKR03','soll','calendar_month',$2)`, [tenantId, now]);
    await pool.query(`INSERT INTO ledger_accounts (id,chart,account_number,name,source,created_at,updated_at) VALUES ($1,'SKR03','1400','Receivable','test',$2,$2),($3,'SKR03','8400','Revenue','test',$2,$2),($4,'SKR03','1776','Output VAT','test',$2,$2) ON CONFLICT (chart,account_number) DO NOTHING`, [`settlement-1400-${suffix}`, now, `settlement-8400-${suffix}`, `settlement-1776-${suffix}`]);
    await pool.query(`INSERT INTO invoices (id,tenant_id,number,client,client_email,date,due_date,amount,status,items_json,payments_json,history_json,accounting_status,accounting_snapshot_json,accounting_journal_entry_id,created_at,updated_at) VALUES ($1,$2,$3,'Settlement customer','customer@example.test','2025-01-31','2025-02-28',119,'open','[]','[]','[]','posted',$4,$5,$6,$6)`, [originalId, tenantId, `RE-${suffix}`, JSON.stringify({ sourceVersion: 'settlement-original-v1', vatBreakdown: facts.taxBreakdown }), originalJournalId, now]);
    await pool.query(`INSERT INTO journal_entries (id,tenant_id,entry_number,posting_date,document_date,booking_text,reference,period,fiscal_year,status,source_type,source_key,created_at) VALUES ($1,$2,1,'2025-01-31','2025-01-31','Original settlement invoice',$3,'2025-01',2025,'posted','outgoing_invoice',$4,$5)`, [originalJournalId, tenantId, `RE-${suffix}`, `outgoing_invoice:${originalId}`, now]);
    await pool.query(`INSERT INTO open_items (id,tenant_id,party_type,party_id,source_type,source_id,document_number,document_date,due_date,original_amount,allocated_amount,residual_amount,status,journal_entry_id,created_at,updated_at) VALUES ($1,$2,'debtor','settlement-customer','outgoing_invoice',$3,$4,'2025-01-31','2025-02-28',119,0,119,'open',$5,$6,$6)`, [`settlement-open-${suffix}`, tenantId, originalId, `RE-${suffix}`, originalJournalId, now]);
    const repository = createPostgresProAccountingRepository(pool);
    const scope = createSingleTenantScope(tenantId, 'pro');
    const input = { commandType: 'skonto', sourceId, sourceRevision: 'v1', idempotencyKey: `${sourceId}:v1`, reason: 'Settlement source', input: { ...facts, sourceId, sourceRevision: 'v1' } };
    const duplicateAdvance = {
      commandType: 'advance_settlement', sourceId: `${sourceId}-duplicate`, sourceRevision: 'v1', idempotencyKey: `${sourceId}-duplicate:v1`, reason: 'Reject duplicate settlement references',
      input: {
        effectiveDate: facts.effectiveDate, postingDate: facts.postingDate, period: facts.period, fiscalYear: facts.fiscalYear, currency: facts.currency,
        finalInvoiceId: originalId, finalInvoice: { grossAmount: 119, taxBreakdown: facts.taxBreakdown }, advances: [{ id: originalId, kind: 'advance', grossAmount: 1 }],
        advanceClearingReceivable: '1593', advanceClearingPayable: '1518', sourceId: `${sourceId}-duplicate`, sourceRevision: 'v1',
      },
    };
    await assert.rejects(() => repository.runClosingCommand(scope, duplicateAdvance), (error: unknown) => error instanceof CorrectionSettlementError && error.code === 'IDEMPOTENCY_CONFLICT');
    const unchangedBeforeSettlement = (await pool.query(`SELECT allocated_amount,residual_amount,status FROM open_items WHERE tenant_id=$1 AND source_id=$2`, [tenantId, originalId])).rows[0];
    assert.equal(Number(unchangedBeforeSettlement.allocated_amount), 0);
    assert.equal(Number(unchangedBeforeSettlement.residual_amount), 119);
    assert.equal(unchangedBeforeSettlement.status, 'open');
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM journal_entries WHERE tenant_id=$1`, [tenantId])).rows[0].count, 1);
    const first = await repository.runClosingCommand(scope, input);
    const replay = await repository.runClosingCommand(scope, input);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    const settledItem = (await pool.query(`SELECT allocated_amount,residual_amount,status FROM open_items WHERE tenant_id=$1 AND source_id=$2`, [tenantId, originalId])).rows[0];
    assert.equal(Number(settledItem.allocated_amount), 11.9);
    assert.equal(Number(settledItem.residual_amount), 107.1);
    assert.equal(settledItem.status, 'partially_paid');
    const lines = (await pool.query(`SELECT debit_amount,credit_amount,tax_case_key,evidence_type FROM journal_lines WHERE tenant_id=$1 AND entry_id=$2`, [tenantId, first.run.journalEntryId])).rows;
    assert.equal(lines.reduce((sum, row) => sum + Math.round(Number(row.debit_amount) * 100), 0), lines.reduce((sum, row) => sum + Math.round(Number(row.credit_amount) * 100), 0));
    assert.equal(lines.some((row) => row.tax_case_key === 'DE_STD_19' && row.evidence_type === 'skonto'), true);
    await assert.rejects(() => repository.runClosingCommand(scope, { ...input, sourceId: `${sourceId}-invalid`, idempotencyKey: `${sourceId}-invalid:v1`, input: { ...facts, sourceId: `${sourceId}-invalid`, sourceRevision: 'v1', skontoAmount: 120 } }), /INVALID_AMOUNT|exceeds/);
    const unchanged = (await pool.query(`SELECT allocated_amount,residual_amount,status FROM open_items WHERE tenant_id=$1 AND source_id=$2`, [tenantId, originalId])).rows[0];
    assert.equal(Number(unchanged.allocated_amount), 11.9);
    assert.equal(Number(unchanged.residual_amount), 107.1);
    assert.equal(unchanged.status, 'partially_paid');
    const paidInput = { ...input, sourceId: `${sourceId}-paid`, idempotencyKey: `${sourceId}-paid:v1`, input: { ...facts, sourceId: `${sourceId}-paid`, sourceRevision: 'v1', skontoAmount: 107.1 } };
    const paid = await repository.runClosingCommand(scope, paidInput);
    assert.equal(paid.replayed, false);
    assert.equal((await repository.runClosingCommand(scope, paidInput)).replayed, true);
    const paidItem = (await pool.query(`SELECT residual_amount,status FROM open_items WHERE tenant_id=$1 AND source_id=$2`, [tenantId, originalId])).rows[0];
    assert.equal(Number(paidItem.residual_amount), 0);
    assert.equal(paidItem.status, 'paid');
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM journal_entries WHERE tenant_id=$1`, [tenantId])).rows[0].count, 2);
  } finally {
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]).catch(() => undefined);
    await pool.end();
  }
});

test('corrections require a posted original with its document-owned journal', { skip: !databaseUrl }, async () => {
  const pool = createPostgresPool(databaseUrl!);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenantId = `source-correction-original-${suffix}`;
  const vendorId = `source-correction-vendor-${suffix}`;
  const invoiceId = `source-correction-invoice-${suffix}`;
  const journalId = `source-correction-journal-${suffix}`;
  const now = new Date().toISOString();
  const snapshot = { sourceVersion: 'original-r1', vatBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }] };
  const scope = createSingleTenantScope(tenantId, 'pro');
  const input = {
    id: `source-correction-${suffix}`,
    idempotencyKey: `source-correction-key-${suffix}`,
    correctionDate: '2026-11-20',
    taxEffectiveDate: '2026-10-01',
    documentType: 'incoming_invoice' as const,
    original: {
      documentId: invoiceId,
      documentNumber: 'ER-SOURCE-CORRECTION',
      revision: snapshot.sourceVersion,
      snapshotHash: sha256Hex(stableStringify(snapshot)),
      taxEffectiveDate: '2026-10-01',
      taxBreakdown: snapshot.vatBreakdown,
    },
    deltas: [{ rate: 19, grossAmount: 11.9 }],
    reason: 'source correction original ownership',
  };
  try {
    await runDrizzleMigrations(pool);
    await pool.query(`INSERT INTO tenants (id,slug,display_name,product,deployment_mode,status,created_at,updated_at) VALUES ($1,$1,$2,'pro','single-tenant','active',$3,$3)`, [tenantId, 'Source correction original', now]);
    await pool.query(`INSERT INTO accounting_policies (tenant_id,active_chart,vat_method,period_policy,updated_at) VALUES ($1,'SKR03','soll','calendar_month',$2)`, [tenantId, now]);
    await pool.query(`INSERT INTO vendors (id,tenant_id,name,created_at,updated_at) VALUES ($1,$2,'Source correction vendor',$3,$3)`, [vendorId, tenantId, now]);
    for (const [accountNumber, name] of [['4900', 'Expense'], ['1576', 'Input VAT'], ['1600', 'Payable']] as const) {
      await pool.query(`INSERT INTO ledger_accounts (id,chart,account_number,name,source,created_at,updated_at) VALUES ($1,'SKR03',$2,$3,'test',$4,$4) ON CONFLICT (chart,account_number) DO NOTHING`, [`${tenantId}-${accountNumber}`, accountNumber, name, now]);
    }
    await pool.query(`INSERT INTO incoming_invoices (id,tenant_id,vendor_id,number,invoice_date,due_date,net_amount,tax_amount,gross_amount,status,tax_rate,accounting_status,accounting_snapshot_json,created_at,updated_at) VALUES ($1,$2,$3,'ER-SOURCE-CORRECTION','2026-10-01','2026-10-31',100,19,119,'open',19,'unposted',$4,$5,$5)`, [invoiceId, tenantId, vendorId, JSON.stringify(snapshot), now]);
    await assert.rejects(() => createPostgresProAccountingRepository(pool).createCorrectionSettlement(scope, input), /DOCUMENT_NOT_POSTED/);
    await pool.query(`UPDATE incoming_invoices SET accounting_status='posted', accounting_journal_entry_id=$1 WHERE tenant_id=$2 AND id=$3`, [journalId, tenantId, invoiceId]);
    await assert.rejects(() => createPostgresProAccountingRepository(pool).createCorrectionSettlement(scope, input), /DOCUMENT_NOT_POSTED/);
    await pool.query(`INSERT INTO journal_entries (id,tenant_id,entry_number,posting_date,document_date,booking_text,reference,period,fiscal_year,status,source_type,source_key,created_at) VALUES ($1,$2,1,'2026-10-01','2026-10-01','Source correction original','ER-SOURCE-CORRECTION','2026-10',2026,'posted','incoming_invoice','incoming-invoice:' || $3,$4)`, [journalId, tenantId, invoiceId, now]);
    const posted = await createPostgresProAccountingRepository(pool).createCorrectionSettlement(scope, input);
    assert.equal(posted.replayed, false);
    const correctionIdentity = journalSourceIdentity(tenantId, 'correction', posted.document.id, posted.document.originalRevision);
    assert.equal(posted.run.journalEntryId, `journal-command:${correctionIdentity.slice('source:'.length)}`);
  } finally {
    await pool.query('ALTER TABLE incoming_invoices DISABLE TRIGGER incoming_invoices_posted_immutable').catch(() => undefined);
    await pool.query('DELETE FROM tenants WHERE id=$1', [tenantId]).catch(() => undefined);
    await pool.query('ALTER TABLE incoming_invoices ENABLE TRIGGER incoming_invoices_posted_immutable').catch(() => undefined);
    await pool.end();
  }
});

test('derived schedules persist every command atomically and honor period fiscal years', { skip: !databaseUrl }, async () => {
  const pool = createPostgresPool(databaseUrl!);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenantId = `source-run-schedule-${suffix}`;
  const now = new Date().toISOString();
  try {
    await runDrizzleMigrations(pool);
    await pool.query(`INSERT INTO tenants (id,slug,display_name,product,deployment_mode,status,created_at,updated_at) VALUES ($1,$1,$2,'pro','single-tenant','active',$3,$3)`, [tenantId, tenantId, now]);
    await pool.query(`INSERT INTO accounting_policies (tenant_id,active_chart,vat_method,period_policy,updated_at) VALUES ($1,'SKR03','soll','calendar_month',$2)`, [tenantId, now]);
    await pool.query(`INSERT INTO ledger_accounts (id,chart,account_number,name,source,created_at,updated_at) VALUES ($1,'SKR03','1000','Expense','test',$2,$2),($3,'SKR03','2000','Deferral','test',$2,$2) ON CONFLICT DO NOTHING`, [`schedule-account-a-${suffix}`, now, `schedule-account-b-${suffix}`]);
    await pool.query(`INSERT INTO accounting_periods (id,tenant_id,period,fiscal_year,status,starts_at,ends_at,created_at,updated_at) VALUES ($1,$2,'2025-01',2025,'open','2025-01-01','2025-01-31',$3,$3),($4,$2,'2025-02',2024,'open','2025-02-01','2025-02-28',$3,$3)`, [`schedule-period-a-${suffix}`, tenantId, now, `schedule-period-b-${suffix}`]);
    const repository = createPostgresProAccountingRepository(pool);
    const scope = createSingleTenantScope(tenantId, 'pro');
    const input = {
      command: 'accrual' as const, sourceId: `accrual-${suffix}`, sourceRevision: 'v1', idempotencyKey: `accrual-${suffix}:v1`, reason: 'Schedule atomicity',
      input: { sourceId: `accrual-${suffix}`, sourceRevision: 'v1', startDate: '2025-01-01', endDate: '2025-02-01', period: '2025-01', fiscalYear: 2025, currency: 'EUR', totalAmount: 20, expenseAccount: '1000', deferralAccount: '2000' },
    };
    await assert.rejects(() => repository.runClosingCommand(scope, input), /FISCAL_YEAR_PERIOD_MISMATCH/);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM journal_entries WHERE tenant_id=$1`, [tenantId])).rows[0].count, 0);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM accounting_source_runs WHERE tenant_id=$1`, [tenantId])).rows[0].count, 0);
  } finally {
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]).catch(() => undefined);
    await pool.end();
  }
});

test('repository source-run methods remain callable through the query-only seam', async () => {
  const calls: string[] = [];
  const db = { query: async (text: string) => { calls.push(text); return { rows: [] }; } } as unknown as PostgresQueryable;
  const repository = createPostgresProAccountingRepository(db);
  assert.deepEqual(await repository.listAccountingSourceRuns(createSingleTenantScope('query-only', 'pro')), []);
  assert.equal(calls.length, 1);
});

test('settlement commands reject fabricated sources without an original document', async () => {
  const db = { query: async () => ({ rows: [] }) } as unknown as PostgresQueryable;
  const repository = createPostgresProAccountingRepository(db);
  await assert.rejects(() => repository.runClosingCommand(createSingleTenantScope('query-only', 'pro'), {
    commandType: 'skonto',
    sourceId: 'settlement-without-original',
    sourceRevision: 'v1',
    idempotencyKey: 'settlement-without-original:v1',
    reason: 'must have persisted source',
    input: { taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }], skontoAmount: 11.9 },
  }), /ORIGINAL_DOCUMENT_REQUIRED/);
});
