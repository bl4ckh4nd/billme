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
    const facts = { taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }], skontoAmount: 11.9 };
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
});
