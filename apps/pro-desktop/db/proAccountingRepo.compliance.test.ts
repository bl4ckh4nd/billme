import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { bootstrapSql } from './bootstrap';
import { runMigrations } from './migrate';
import {
  getDraftByTransactionId,
  insertDatevExport,
  listJournalEntries,
  postDraft,
} from './proAccountingRepo';
import { createProTenantScope } from '../tenantScope';

const createDb = (): Database.Database => {
  const db = new Database(':memory:');
  db.exec(bootstrapSql);
  runMigrations(db);
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
});
