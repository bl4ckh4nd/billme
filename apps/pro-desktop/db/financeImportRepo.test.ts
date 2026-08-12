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

  it('rolls back both rows as one audited soft-delete operation', () => {
    const db = openDb();
    const imported = commitProImport(db, { accountId: 'bank', profile: 'generic', fileName: 'x.csv', fileSha256: 'sha', mappingJson: {}, rows: [row], errorCount: 0 });
    expect(rollbackProImportBatch(db, imported.batchId, 'wrong file')).toEqual({ success: true, deletedCount: 2 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM transactions WHERE deleted_at IS NOT NULL").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM bank_transactions WHERE deleted_at IS NOT NULL").get()).toEqual({ count: 1 });
  });
});
