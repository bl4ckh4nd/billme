import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { bootstrapSql } from './bootstrap';
import { runMigrations } from './migrate';
import { commitProImport, rollbackProImportBatch } from './financeImportRepo';

const openDb = () => {
  const db = new Database(':memory:');
  db.exec(bootstrapSql);
  runMigrations(db);
  db.prepare("INSERT INTO accounts (id, name, iban, balance, type, color) VALUES ('bank', 'Bank', '', 0, 'bank', '')").run();
  return db;
};

const row = { id: 'ignored', accountId: 'bank', date: '2025-01-01', amount: 10, type: 'income' as const, counterparty: 'Acme', purpose: 'P', status: 'pending' as const, dedupHash: 'stable-source' };

describe('Pro finance import', () => {
  it('creates one compatibility and one bank row, then deduplicates re-imports', () => {
    const db = openDb();
    const first = commitProImport(db, { accountId: 'bank', profile: 'generic', fileName: 'x.csv', fileSha256: 'sha', mappingJson: {}, rows: [row], errorCount: 0 });
    const second = commitProImport(db, { accountId: 'bank', profile: 'generic', fileName: 'x.csv', fileSha256: 'sha', mappingJson: {}, rows: [row], errorCount: 0 });
    expect(first.inserted).toBe(1);
    expect(second.skipped).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS count FROM transactions').get()).toEqual({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM bank_transactions').get()).toEqual({ count: 1 });
  });

  it('rolls back both representations when the bank insert fails', () => {
    const db = openDb();
    expect(() => commitProImport(db, {
      accountId: 'bank', profile: 'generic', fileName: 'x.csv', fileSha256: 'sha', mappingJson: {}, errorCount: 0,
      rows: [{ ...row, status: 'invalid' as unknown as 'pending' }],
    })).toThrow();
    expect(db.prepare('SELECT COUNT(*) AS count FROM transactions').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM bank_transactions').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM import_batches').get()).toEqual({ count: 0 });
  });

  it('rolls back both rows as one audited soft-delete operation', () => {
    const db = openDb();
    const imported = commitProImport(db, { accountId: 'bank', profile: 'generic', fileName: 'x.csv', fileSha256: 'sha', mappingJson: {}, rows: [row], errorCount: 0 });
    expect(rollbackProImportBatch(db, imported.batchId, 'wrong file')).toEqual({ success: true, deletedCount: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE deleted_at IS NOT NULL").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM bank_transactions WHERE deleted_at IS NOT NULL").get()).toEqual({ count: 1 });
  });

  it('blocks rollback for any booking draft or workflow state', () => {
    for (const blocker of ['draft', 'workflow']) {
      const db = openDb();
      const imported = commitProImport(db, { accountId: 'bank', profile: 'generic', fileName: 'x.csv', fileSha256: 'sha', mappingJson: {}, rows: [row], errorCount: 0 });
      if (blocker === 'draft') {
        db.prepare("INSERT INTO booking_drafts (id, tenant_id, transaction_id, workflow_status, draft_json, updated_at) VALUES ('d', 'default', ?, 'imported', '{}', datetime('now'))").run(row.dedupHash);
      } else {
        db.prepare("INSERT INTO pro_workflow_entries (tenant_id, transaction_id, transaction_json, draft_json, updated_at) VALUES ('default', ?, '{}', '{}', datetime('now'))").run(row.dedupHash);
      }
      expect(() => rollbackProImportBatch(db, imported.batchId, 'wrong file')).toThrow('ROLLBACK_REQUIRES_CORRECTION');
      expect(db.prepare("SELECT deleted_at FROM transactions WHERE id = ?").get(row.dedupHash)).toEqual({ deleted_at: null });
    }
  });

  it('backfills legacy bank mirrors idempotently and audits source conflicts', () => {
    const db = new Database(':memory:');
    db.exec(bootstrapSql);
    db.prepare("INSERT INTO accounts (id, name, iban, balance, type, color) VALUES ('bank', 'Bank', '', 0, 'bank', '')").run();
    const insertBank = db.prepare(`INSERT INTO bank_transactions
      (id, tenant_id, account_id, date, amount, type, counterparty, purpose, status, source_transaction_id, created_at, updated_at)
      VALUES (?, 'default', 'bank', '2025-01-02', 10, 'income', 'Acme', 'Legacy', 'booked', ?, datetime('now'), datetime('now'))`);
    insertBank.run('legacy-bank-a', 'legacy-source');
    insertBank.run('legacy-bank-b', 'legacy-source');

    runMigrations(db);
    const firstCount = (db.prepare('SELECT COUNT(*) AS count FROM transactions').get() as { count: number }).count;
    expect(firstCount).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS count FROM audit_log WHERE action = ?').get('source_identity_conflict')).toEqual({ count: 1 });

    runMigrations(db);
    expect(db.prepare('SELECT COUNT(*) AS count FROM transactions').get()).toEqual({ count: firstCount });
    expect(db.prepare('SELECT COUNT(*) AS count FROM bank_transactions WHERE source_transaction_id IS NOT NULL').get()).toEqual({ count: 2 });
  });
});
