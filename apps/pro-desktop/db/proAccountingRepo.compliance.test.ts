import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { bootstrapSql } from './bootstrap';
import { runMigrations } from './migrate';
import {
  getDraftByTransactionId,
  insertDatevExport,
  listJournalEntries,
  postDraft,
  reverseJournalEntry,
  saveDraft,
  getVatSummary,
} from './proAccountingRepo';
import { createProTenantScope } from '../tenantScope';

const createDb = (): Database.Database => {
  const db = new Database(':memory:');
  db.exec(bootstrapSql);
  runMigrations(db);
  db.exec("INSERT INTO ledger_accounts (id, chart, account_number, name, source, created_at, updated_at) VALUES ('test-1200', 'SKR03', '1200', 'Bank', 'test', datetime('now'), datetime('now')), ('test-6000', 'SKR03', '6000', 'Aufwand', 'test', datetime('now'), datetime('now'))");
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

const seedBankTransaction = (db: Database.Database, id: string, date: string, amount = -120): void => {
  db.prepare(
    `
      INSERT INTO bank_transactions (
        id,
        tenant_id,
        account_id,
        date,
        amount,
        type,
        counterparty,
        purpose,
        linked_invoice_id,
        status,
        source_transaction_id,
        created_at,
        updated_at
      ) VALUES (?, 'default', 'bank-1', ?, ?, 'expense', 'Lieferant GmbH', 'Eingangsrechnung', NULL, 'pending', ?, ?, ?)
    `,
  ).run(id, date, amount, id, `${date}T09:00:00.000Z`, `${date}T09:00:00.000Z`);
};

describe.skipIf(!canRunNativeSqlite)('proAccountingRepo compliance controls', () => {
  const validDraft = (db: Database.Database, id: string, date = '2026-03-01') => {
    const scope = createProTenantScope('default');
    seedBankTransaction(db, id, date);
    const draft = getDraftByTransactionId(db, id, scope);
    expect(draft).toBeTruthy();
    return saveDraft(db, {
      ...draft!,
      postingDate: date,
      documentDate: date,
      period: date.slice(0, 7),
      fiscalYear: Number(date.slice(0, 4)),
      lines: [
        { ...draft!.lines[0]!, id: `${id}-debit`, accountNumber: '6000', debitAmount: 119, creditAmount: 0, taxAmount: 19, grossAmount: 119 },
        { ...draft!.lines[1]!, id: `${id}-credit`, accountNumber: '1200', debitAmount: 0, creditAmount: 119, taxAmount: 19, grossAmount: 119 },
      ],
    }, scope);
  };

  it('blocks posting in closed period', () => {
    const db = createDb();
    const scope = createProTenantScope('default');

    seedBankTransaction(db, 'tx-closed-1', '2026-02-15');
    const draft = getDraftByTransactionId(db, 'tx-closed-1', scope);
    expect(draft).toBeTruthy();

    db.prepare("UPDATE accounting_periods SET status = 'closed' WHERE tenant_id = ? AND period = '2026-02'").run(scope.tenantId);

    const result = postDraft(db, draft!.id, { postingDate: '2026-02-15' }, scope);
    expect(result.issues.some((issue) => issue.code === 'POSTING_DATE_IN_CLOSED_PERIOD')).toBe(true);

    const postedCount = (db.prepare('SELECT COUNT(*) as c FROM journal_entries').get() as { c: number }).c;
    expect(postedCount).toBe(0);
  });

  it('enforces immutable journals and datev export records', () => {
    const db = createDb();
    const scope = createProTenantScope('default');

    seedBankTransaction(db, 'tx-immut-1', '2026-03-01', -200);
    const draft = getDraftByTransactionId(db, 'tx-immut-1', scope);
    expect(draft).toBeTruthy();

    const post = postDraft(db, draft!.id, { postingDate: '2026-03-01' }, scope);
    expect(post.issues.length).toBe(0);
    expect(post.entry.id).toBeTruthy();

    expect(() =>
      db.prepare("UPDATE journal_entries SET booking_text = 'manipulated' WHERE id = ?").run(post.entry.id),
    ).toThrow(/immutable/i);

    expect(() =>
      db.prepare('DELETE FROM journal_entries WHERE id = ?').run(post.entry.id),
    ).toThrow(/immutable/i);

    expect(() =>
      db.prepare('UPDATE journal_lines SET debit_amount = debit_amount + 1 WHERE entry_id = ?').run(post.entry.id),
    ).toThrow(/immutable/i);

    expect(() =>
      db.prepare('DELETE FROM journal_lines WHERE entry_id = ?').run(post.entry.id),
    ).toThrow(/immutable/i);

    const datev = insertDatevExport(db, {
      filePath: '/tmp/datev-test.csv',
      recordCount: 1,
      fromDate: '2026-03-01',
      toDate: '2026-03-31',
    }, scope);

    expect(() =>
      db.prepare("UPDATE datev_exports SET file_path = '/tmp/tampered.csv' WHERE id = ?").run(datev.id),
    ).toThrow(/immutable/i);

    expect(() =>
      db.prepare('DELETE FROM datev_exports WHERE id = ?').run(datev.id),
    ).toThrow(/immutable/i);
  });

  it('filters journal entries by account before pagination', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    seedBankTransaction(db, 'tx-filter-1', '2026-03-02', -75);
    const draft = getDraftByTransactionId(db, 'tx-filter-1', scope);
    const posted = postDraft(db, draft!.id, { postingDate: '2026-03-02' }, scope);
    const accountNumber = posted.entry.lines[0].accountNumber;

    expect(listJournalEntries(db, { accountNumbers: [accountNumber], limit: 1 }, scope))
      .toHaveLength(1);
    expect(listJournalEntries(db, { accountNumbers: ['does-not-exist'] }, scope))
      .toEqual([]);
  });

  it('allocates one journal entry for repeated posting', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    const draft = validDraft(db, 'tx-idempotent-1');
    const first = postDraft(db, draft.id, { postingDate: '2026-03-01' }, scope);
    const second = postDraft(db, draft.id, { postingDate: '2026-03-01' }, scope);
    expect(second.entry.id).toBe(first.entry.id);
    expect((db.prepare('SELECT COUNT(*) AS c FROM journal_entries').get() as { c: number }).c).toBe(1);
  });

  it('requires a reasoned override for soft-locked periods', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    const draft = validDraft(db, 'tx-soft-lock-1');
    db.prepare("UPDATE accounting_periods SET status = 'soft_locked' WHERE tenant_id = ? AND period = '2026-03'").run(scope.tenantId);

    const blocked = postDraft(db, draft.id, { postingDate: '2026-03-01' }, scope);
    expect(blocked.issues.some((issue) => issue.code === 'SOFT_LOCK_OVERRIDE_REQUIRED')).toBe(true);
    const allowed = postDraft(db, draft.id, { postingDate: '2026-03-01', softLockOverride: true, overrideReason: 'Korrektur nach Belegprüfung' }, scope);
    expect(allowed.entry.id).toBeTruthy();
  });

  it('rejects invalid lines and unknown accounts', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    const draft = validDraft(db, 'tx-invalid-lines-1');
    const invalid = saveDraft(db, {
      ...draft,
      lines: [
        { ...draft.lines[0]!, accountNumber: '9999', debitAmount: 1, creditAmount: 1 },
        { ...draft.lines[1]!, debitAmount: 0, creditAmount: 0 },
      ],
    }, scope);
    expect(invalid.validationIssues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['UNKNOWN_ACCOUNT', 'INVALID_LINE_SIDE']));
  });

  it('reverses on the requested date and nets every VAT-bearing cent', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    const draft = validDraft(db, 'tx-reversal-1');
    const posted = postDraft(db, draft.id, { postingDate: '2026-03-01' }, scope);
    const reversal = reverseJournalEntry(db, posted.entry.id, 'Beleg storniert', scope, { postingDate: '2026-04-15' });
    const entries = listJournalEntries(db, {}, scope);
    const original = entries.find((entry) => entry.id === posted.entry.id)!;
    const reversed = entries.find((entry) => entry.id === reversal.reversalEntryId)!;
    expect(original.status).toBe('reversed');
    expect(reversed).toMatchObject({ postingDate: '2026-04-15', period: '2026-04', fiscalYear: 2026, sourceType: 'reversal' });
    expect(() => reverseJournalEntry(db, reversal.reversalEntryId, 'Storno des Stornos', scope, { postingDate: '2026-04-16' })).toThrow(/cannot be reversed/i);

    const balances = db.prepare('SELECT account_number, ROUND(SUM(debit_amount - credit_amount), 2) AS net FROM journal_lines GROUP BY account_number').all() as Array<{ account_number: string; net: number }>;
    expect(balances.every((row) => Number(row.net) === 0)).toBe(true);
    const vat = getVatSummary(db, {}, scope).rows;
    expect(vat.reduce((total, row) => total + row.taxAmount, 0)).toBe(0);
    expect(vat.reduce((total, row) => total + row.netAmount, 0)).toBe(0);
    expect(vat.reduce((total, row) => total + row.grossAmount, 0)).toBe(0);
  });
});
