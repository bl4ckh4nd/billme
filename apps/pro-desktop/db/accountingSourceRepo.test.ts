import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bootstrapSql } from './bootstrap';
import { runMigrations } from './migrate';
import { getAccountingSourceRun, postAccountingCommand, postAccountingSource } from './accountingSourceRepo';
import type { AccountingSourceFact } from '@billme/accounting-shared';
import { reverseJournalEntry } from './proAccountingRepo';
import { createProTenantScope } from '../tenantScope';

const createDb = (): Database.Database => {
  const db = new Database(':memory:');
  db.exec(bootstrapSql);
  runMigrations(db);
  db.exec(`
    INSERT INTO ledger_accounts (id, chart, account_number, name, source, created_at, updated_at)
    VALUES ('source-1200', 'SKR03', '1200', 'Bank', 'test', datetime('now'), datetime('now')),
           ('source-8400', 'SKR03', '8400', 'Revenue', 'test', datetime('now'), datetime('now')),
           ('source-1400', 'SKR03', '1400', 'Receivable', 'test', datetime('now'), datetime('now')),
           ('source-1776', 'SKR03', '1776', 'Output VAT', 'test', datetime('now'), datetime('now'));
    INSERT INTO accounting_periods (id, tenant_id, period, fiscal_year, status, starts_at, ends_at, created_at, updated_at)
    VALUES ('source-period', 'default', '2026-03', 2026, 'open', '2026-03-01', '2026-03-31', datetime('now'), datetime('now'));
    INSERT INTO invoices (id, number, client, client_email, date, due_date, amount, status, accounting_status,
      accounting_snapshot_json, accounting_journal_entry_id, accounting_posted_at, created_at, updated_at)
    VALUES ('invoice-1', 'RE-1', 'Original customer', 'customer@example.test', '2026-03-15', '2026-03-31', 119,
      'open', 'posted', '{"sourceVersion":"invoice-r1","vatBreakdown":[{"grossAmount":119,"netAmount":100,"rate":19,"taxAmount":19}]}',
      'invoice-journal-1', datetime('now'), datetime('now'), datetime('now'));
    INSERT INTO journal_entries (id, tenant_id, entry_number, posting_date, document_date, booking_text, reference,
      period, fiscal_year, status, source_type, source_key, created_at)
    VALUES ('invoice-journal-1', 'default', 1, '2026-03-15', '2026-03-15', 'Original invoice', 'RE-1',
      '2026-03', 2026, 'posted', 'outgoing_invoice', 'outgoing-invoice:invoice-1', datetime('now'));
    INSERT INTO journal_lines (id, tenant_id, entry_id, line_no, account_number, debit_amount, credit_amount)
    VALUES ('invoice-journal-1-line-1', 'default', 'invoice-journal-1', 1, '1400', 119, 0),
      ('invoice-journal-1-line-2', 'default', 'invoice-journal-1', 2, '8400', 0, 100);
    INSERT INTO open_items (id, tenant_id, party_type, party_id, source_type, source_id, document_number, document_date, due_date, original_amount, allocated_amount, residual_amount, status, journal_entry_id, created_at, updated_at)
    VALUES ('invoice-open-item-1', 'default', 'debtor', 'client-1', 'outgoing_invoice', 'invoice-1', 'RE-1', '2026-03-15', '2026-03-31', 119, 0, 119, 'open', 'invoice-journal-1', datetime('now'), datetime('now'));
  `);
  return db;
};

const canRunNativeSqlite = (() => {
  try {
    const probe = new Database(':memory:');
    probe.close();
    return true;
  } catch {
    return false;
  }
})();

const source = (revision = 'r1') => ({
  sourceType: 'standalone_source' as const,
  sourceId: 'source-1',
  sourceRevision: revision,
  effectiveDate: '2026-03-15',
  postingDate: '2026-03-15',
  period: '2026-03',
  fiscalYear: 2026,
  currency: 'EUR',
  bookingText: 'Standalone source',
  lines: [
    { accountNumber: '8400', debitAmount: 100, creditAmount: 0 },
    { accountNumber: '1200', debitAmount: 0, creditAmount: 100 },
  ],
});

describe.skipIf(!canRunNativeSqlite)('accounting source repository', () => {
  it('posts, replays, and rejects conflicting immutable revisions', () => {
    const db = createDb();
    const scope = createProTenantScope('default');

    const first = postAccountingSource(db, source(), scope, { reason: 'test source' });
    expect(first.status).toBe('posted');
    expect(first.sourceRun?.journalEntryId).toBeTruthy();
    expect(postAccountingSource(db, source(), scope, { reason: 'replay' }).status).toBe('duplicate');
    expect(postAccountingSource(db, { ...source(), lines: [{ accountNumber: '8400', debitAmount: 90, creditAmount: 0 }, { accountNumber: '1200', debitAmount: 0, creditAmount: 90 }] }, scope, { reason: 'conflict' }).status).toBe('rejected');
    expect(db.prepare('SELECT COUNT(*) AS count FROM journal_entries').get()).toEqual({ count: 2 });
    db.close();
  });

  it('rejects a renderer chart that differs from the persisted policy', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    expect(() => postAccountingSource(db, source(), scope, { chart: 'SKR04', reason: 'stale chart' }))
      .toThrow('ACCOUNTING_CHART_MISMATCH');
    expect(db.prepare('SELECT COUNT(*) AS count FROM accounting_source_runs').get()).toEqual({ count: 0 });
    db.close();
  });

  it('rejects locked periods and unknown accounts without a journal', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    db.prepare("UPDATE accounting_periods SET status = 'closed' WHERE id = 'source-period'").run();
    const closed = postAccountingSource(db, source('closed'), scope, { reason: 'closed test' });
    expect(closed.status).toBe('rejected');
    expect(closed.errors.length).toBeGreaterThan(0);

    db.prepare("UPDATE accounting_periods SET status = 'open' WHERE id = 'source-period'").run();
    const invalid = postAccountingSource(db, { ...source('invalid'), lines: [{ accountNumber: '9999', debitAmount: 100, creditAmount: 0 }, { accountNumber: '1200', debitAmount: 0, creditAmount: 100 }] }, scope, { reason: 'invalid account' });
    expect(invalid.status).toBe('rejected');
    expect(db.prepare('SELECT COUNT(*) AS count FROM journal_entries').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM accounting_source_runs WHERE status = \'rejected\'').get()).toEqual({ count: 2 });
    db.close();
  });

  it('does not let the generic reversal path own source-run journals', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    const posted = postAccountingSource(db, source(), scope, { reason: 'source ownership' });
    expect(() => reverseJournalEntry(db, posted.sourceRun!.journalEntryId!, 'generic reversal', scope)).toThrow('SOURCE_REVERSAL_REQUIRED');
    db.close();
  });

  it('rolls back the journal and immutable run when audit persistence fails', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    db.exec(`CREATE TRIGGER fail_source_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT, 'source audit failed'); END;`);
    expect(() => postAccountingSource(db, source(), scope, { reason: 'rollback test' })).toThrow('source audit failed');
    expect(db.prepare('SELECT COUNT(*) AS count FROM journal_entries').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM journal_lines').get()).toEqual({ count: 2 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM accounting_source_runs').get()).toEqual({ count: 0 });
    db.close();
  });

  it('retains correction linkage provenance across refetch', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    const result = postAccountingCommand(db, {
      kind: 'correction',
      source: source('correction-r1'),
      domainFacts: {
        id: 'correction-1',
        idempotencyKey: 'correction-1:r1',
        correctionDate: '2026-03-15',
        original: {
          documentId: 'invoice-1',
          documentNumber: 'RE-1',
          revision: 'invoice-r1',
          snapshotHash: createHash('sha256').update(JSON.stringify({ sourceVersion: 'invoice-r1', vatBreakdown: [{ grossAmount: 119, netAmount: 100, rate: 19, taxAmount: 19 }] })).digest('hex'),
          taxEffectiveDate: '2026-03-15',
          taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }],
        },
        deltas: [{ rate: 19, grossAmount: 11.90 }],
      },
    }, scope, { reason: 'correction linkage' });
    expect(result.status).toBe('posted');
    const refetched = getAccountingSourceRun(db, result.sourceRun!.id, scope);
    expect((refetched?.fact as AccountingSourceFact & { provenance?: { domainFacts?: { original?: { documentId?: string } } } }).provenance?.domainFacts?.original?.documentId).toBe('invoice-1');

    const overCredit = postAccountingCommand(db, {
      kind: 'correction',
      source: source('correction-r2'),
      domainFacts: {
        id: 'correction-2',
        idempotencyKey: 'correction-2:r1',
        correctionDate: '2026-03-15',
        original: {
          documentId: 'invoice-1',
          documentNumber: 'RE-1',
          revision: 'invoice-r1',
          snapshotHash: createHash('sha256').update(JSON.stringify({ sourceVersion: 'invoice-r1', vatBreakdown: [{ grossAmount: 119, netAmount: 100, rate: 19, taxAmount: 19 }] })).digest('hex'),
          taxEffectiveDate: '2026-03-15',
          taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }],
        },
        deltas: [{ rate: 19, grossAmount: 107.11 }],
      },
    }, scope, { reason: 'second correction cap' });
    expect(overCredit.status).toBe('rejected');
    expect(overCredit.errors.some((issue) => /OVER_CREDIT|exceeds/.test(issue.code + issue.message))).toBe(true);
    db.close();
  });

  it('loads only posted corrections with their own posted journal', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    const original = {
      documentId: 'invoice-1',
      documentNumber: 'RE-1',
      revision: 'invoice-r1',
      snapshotHash: createHash('sha256').update(JSON.stringify({ sourceVersion: 'invoice-r1', vatBreakdown: [{ grossAmount: 119, netAmount: 100, rate: 19, taxAmount: 19 }] })).digest('hex'),
      taxEffectiveDate: '2026-03-15',
      taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }],
    };
    const first = postAccountingCommand(db, {
      kind: 'correction', source: source('correction-first'), domainFacts: {
        id: 'correction-first', idempotencyKey: 'correction-first-key', correctionDate: '2026-03-15', original, deltas: [{ rate: 19, grossAmount: 11.90 }],
      },
    }, scope, { reason: 'first correction' });
    expect(first.status).toBe('posted');
    const ghostFacts = { id: 'ghost-correction', idempotencyKey: 'ghost-correction-key', correctionDate: '2026-03-15', original, deltas: [{ rate: 19, grossAmount: 100 }] };
    const insertGhost = db.prepare(`INSERT INTO accounting_source_runs
      (id, tenant_id, source_type, source_id, source_revision, idempotency_key, fact_json, result_json, status,
       journal_entry_id, effective_date, posting_date, period, fiscal_year, currency, booking_text, created_at)
      VALUES (?, 'default', 'standalone_source', ?, 'invoice-r1', ?, ?, '{}', ?, ?, '2026-03-15', '2026-03-15', '2026-03', 2026, 'EUR', 'ghost', datetime('now'))`);
    const ghostFact = JSON.stringify({ sourceType: 'standalone_source', sourceId: 'ghost-correction', sourceRevision: 'invoice-r1', provenance: { domainFacts: ghostFacts } });
    insertGhost.run('ghost-rejected', 'ghost-rejected', 'ghost-rejected-key', ghostFact, 'rejected', null);
    insertGhost.run('ghost-noop', 'ghost-noop', 'ghost-noop-key', JSON.stringify({ sourceType: 'standalone_source', sourceId: 'ghost-noop', sourceRevision: 'invoice-r1', provenance: { domainFacts: ghostFacts } }), 'noop', null);
    insertGhost.run('ghost-unowned', 'ghost-unowned', 'ghost-unowned-key', ghostFact, 'posted', 'invoice-journal-1');
    const second = postAccountingCommand(db, {
      kind: 'correction', source: source('correction-second'), domainFacts: {
        id: 'correction-second', idempotencyKey: 'correction-second-key', correctionDate: '2026-03-15', original, deltas: [{ rate: 19, grossAmount: 100 }],
      },
    }, scope, { reason: 'second correction' });
    expect(second.status).toBe('posted');
    db.close();
  });

  it('posts every derived schedule command atomically and ignores submitted lines', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    const result = postAccountingCommand(db, {
      kind: 'accrual',
      source: { ...source('submitted'), lines: [{ accountNumber: '8400', debitAmount: 999, creditAmount: 0 }, { accountNumber: '1200', debitAmount: 0, creditAmount: 999 }] },
      domainFacts: {
        sourceId: 'accrual-1', sourceRevision: 'r1', startDate: '2026-03-01', endDate: '2026-05-01', period: '2026-03', fiscalYear: 2026,
        currency: 'EUR', totalAmount: 30, expenseAccount: '8400', deferralAccount: '1200',
      },
    }, scope, { reason: 'derived schedule' });
    expect(result.status).toBe('posted');
    expect(db.prepare("SELECT COUNT(*) AS count FROM journal_entries WHERE source_type = 'accrual'").get()).toEqual({ count: 3 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM accounting_source_runs WHERE source_type = 'accrual'").get()).toEqual({ count: 3 });
    expect(db.prepare("SELECT COUNT(DISTINCT source_key) AS count FROM journal_entries WHERE source_type = 'accrual'").get()).toEqual({ count: 3 });
    const replay = postAccountingCommand(db, {
      kind: 'accrual',
      source: { ...source('submitted'), lines: [{ accountNumber: '8400', debitAmount: 999, creditAmount: 0 }, { accountNumber: '1200', debitAmount: 0, creditAmount: 999 }] },
      domainFacts: {
        sourceId: 'accrual-1', sourceRevision: 'r1', startDate: '2026-03-01', endDate: '2026-05-01', period: '2026-03', fiscalYear: 2026,
        currency: 'EUR', totalAmount: 30, expenseAccount: '8400', deferralAccount: '1200',
      },
    }, scope, { reason: 'derived schedule replay' });
    expect(replay.status).toBe('duplicate');
    expect(db.prepare("SELECT COUNT(*) AS count FROM journal_entries WHERE source_type = 'accrual'").get()).toEqual({ count: 3 });
    db.close();
  });

  it('rejects a source whose fiscal year disagrees with the accounting period', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    const result = postAccountingSource(db, { ...source('period-mismatch'), fiscalYear: 2025 }, scope, { reason: 'period mismatch' });
    expect(result.status).toBe('rejected');
    expect(result.errors.some((issue) => issue.code === 'PERIOD_MISMATCH')).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS count FROM journal_entries').get()).toEqual({ count: 1 });
    db.close();
  });

  it('derives balanced settlement journals and rejects invalid totals without posting', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    const facts = { taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }], skontoAmount: 11.9, originalDocumentId: 'invoice-1' };
    const posted = postAccountingCommand(db, { kind: 'skonto', source: source('skonto'), domainFacts: facts }, scope, { reason: 'settlement test' });
    expect(posted.status).toBe('posted');
    const lines = db.prepare('SELECT debit_amount AS debit, credit_amount AS credit, tax_case_key, evidence_type FROM journal_lines WHERE entry_id = ?').all(posted.sourceRun!.journalEntryId) as Array<{ debit: number; credit: number; tax_case_key: string | null; evidence_type: string | null }>;
    expect(lines.reduce((sum, line) => sum + Math.round(line.debit * 100), 0)).toBe(lines.reduce((sum, line) => sum + Math.round(line.credit * 100), 0));
    expect(lines.some((line) => line.tax_case_key === 'DE_STD_19' && line.evidence_type === 'skonto')).toBe(true);
    const invalid = postAccountingCommand(db, { kind: 'skonto', source: source('skonto-invalid'), domainFacts: { ...facts, skontoAmount: 120 } }, scope, { reason: 'invalid settlement' });
    expect(invalid.status).toBe('rejected');
    expect(db.prepare("SELECT COUNT(*) AS count FROM journal_entries WHERE source_key LIKE 'standalone_source:source-1:skonto-invalid'").get()).toEqual({ count: 0 });
    db.close();
  });

  it('returns typed settlement validation codes through the desktop result', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    const settlementSource = (revision: string) => source(revision);
    const settlementTax = [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }];
    const post = (revision: string, kind: 'skonto' | 'advance_settlement', domainFacts: Record<string, unknown>) =>
      postAccountingCommand(db, { kind, source: settlementSource(revision), domainFacts }, scope, { reason: `typed error ${revision}` });

    const invalidFacts = post('typed-invalid-facts', 'skonto', {
      taxBreakdown: [{ rate: 20, netAmount: 100, taxAmount: 20, grossAmount: 120 }],
      skontoAmount: 11.9,
      originalDocumentId: 'invoice-1',
    });
    expect(invalidFacts.errors[0]).toMatchObject({ code: 'INVALID_FACTS' });

    let reads = 0;
    const missingReference = { kind: 'advance', grossAmount: 1 } as { id?: string; kind: string; grossAmount: number };
    Object.defineProperty(missingReference, 'id', {
      enumerable: true,
      get: () => (reads++ === 0 ? 'invoice-1' : undefined),
    });
    const referenceRequired = post('typed-reference-required', 'advance_settlement', {
      finalInvoiceId: 'invoice-1',
      finalInvoice: { grossAmount: 119, taxBreakdown: settlementTax },
      advances: [missingReference],
      advanceClearingReceivable: '1200',
      advanceClearingPayable: '1600',
    });
    expect(referenceRequired.errors[0]).toMatchObject({ code: 'REFERENCE_REQUIRED' });

    const idempotencyConflict = post('typed-idempotency-conflict', 'advance_settlement', {
      finalInvoiceId: 'invoice-1',
      finalInvoice: { grossAmount: 119, taxBreakdown: settlementTax },
      advances: [
        { id: 'invoice-1', kind: 'advance', grossAmount: 1 },
        { id: 'invoice-1', kind: 'advance', grossAmount: 1 },
      ],
      advanceClearingReceivable: '1200',
      advanceClearingPayable: '1600',
    });
    expect(idempotencyConflict.errors[0]).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    db.exec(`
      INSERT INTO invoices (id, number, client, client_email, date, due_date, amount, status, accounting_status,
        accounting_snapshot_json, accounting_journal_entry_id, accounting_posted_at, created_at, updated_at)
      VALUES ('invoice-2', 'RE-2', 'Original customer', 'customer@example.test', '2026-03-15', '2026-03-31', 119,
        'open', 'posted', '{"sourceVersion":"invoice-r2","vatBreakdown":[{"grossAmount":119,"netAmount":100,"rate":19,"taxAmount":19}]}',
        'invoice-journal-2', datetime('now'), datetime('now'), datetime('now'));
      INSERT INTO journal_entries (id, tenant_id, entry_number, posting_date, document_date, booking_text, reference,
        period, fiscal_year, status, source_type, source_key, created_at)
      VALUES ('invoice-journal-2', 'default', 2, '2026-03-15', '2026-03-15', 'Original invoice', 'RE-2',
        '2026-03', 2026, 'posted', 'outgoing_invoice', 'outgoing-invoice:invoice-2', datetime('now'));
      INSERT INTO open_items (id, tenant_id, party_type, party_id, source_type, source_id, document_number, document_date, due_date,
        original_amount, allocated_amount, residual_amount, status, journal_entry_id, created_at, updated_at)
      VALUES ('invoice-open-item-2', 'default', 'debtor', 'client-1', 'outgoing_invoice', 'invoice-2', 'RE-2', '2026-03-15',
        '2026-03-31', 119, 0, 119, 'open', 'invoice-journal-2', datetime('now'), datetime('now'));
    `);
    const overCredit = post('typed-over-credit', 'advance_settlement', {
      finalInvoiceId: 'invoice-1',
      finalInvoice: { id: 'invoice-1', grossAmount: 119, taxBreakdown: settlementTax },
      advances: [{ id: 'invoice-2', kind: 'advance', grossAmount: 60 }],
      partialInvoices: [{ id: 'invoice-1', kind: 'partial', grossAmount: 60 }],
      advanceClearingReceivable: '1200',
      advanceClearingPayable: '1600',
    });
    expect(overCredit.errors[0]).toMatchObject({ code: 'OVER_CREDIT' });
    db.close();
  });
});
