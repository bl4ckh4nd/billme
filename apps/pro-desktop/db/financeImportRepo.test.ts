import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { bootstrapSql } from './bootstrap';
import { runMigrations } from './migrate';
import { commitProImport, getProImportBatchDetails, rollbackProImportBatch } from './financeImportRepo';

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

  it('normalizes legacy id/dedup pairs and blocks rollback on the resolved bank draft', () => {
    const db = new Database(':memory:');
    db.exec(bootstrapSql);
    db.prepare("INSERT INTO accounts (id, name, iban, balance, type, color) VALUES ('bank', 'Bank', '', 0, 'bank', '')").run();
    db.prepare(`INSERT INTO import_batches
      (id, account_id, profile, file_name, file_sha256, mapping_json, imported_count, skipped_count, error_count, created_at)
      VALUES ('legacy-batch', 'bank', 'generic', 'legacy.csv', 'sha', '{}', 1, 0, 0, datetime('now'))`).run();
    db.prepare(`INSERT INTO transactions
      (id, account_id, date, amount, type, counterparty, purpose, status, dedup_hash, import_batch_id)
      VALUES ('legacy-bank-id', 'bank', '2025-01-03', 10, 'income', 'Acme', 'Legacy', 'booked', 'stable-source', 'legacy-batch')`).run();
    db.prepare(`INSERT INTO bank_transactions
      (id, tenant_id, account_id, date, amount, type, counterparty, purpose, status, source_transaction_id, created_at, updated_at)
      VALUES ('legacy-bank-id', 'default', 'bank', '2025-01-03', 10, 'income', 'Acme', 'Legacy', 'booked', NULL, datetime('now'), datetime('now'))`).run();

    runMigrations(db);
    expect(db.prepare('SELECT source_transaction_id FROM bank_transactions WHERE id = ?').get('legacy-bank-id')).toEqual({ source_transaction_id: 'stable-source' });
    db.prepare(`INSERT INTO booking_drafts
      (id, tenant_id, transaction_id, workflow_status, draft_json, updated_at)
      VALUES ('legacy-draft', 'default', 'legacy-bank-id', 'draft', '{}', datetime('now'))`).run();

    expect(getProImportBatchDetails(db, 'legacy-batch').canRollback).toBe(false);
    expect(() => rollbackProImportBatch(db, 'legacy-batch', 'wrong legacy import')).toThrow('ROLLBACK_REQUIRES_CORRECTION');
    expect(db.prepare('SELECT deleted_at FROM bank_transactions WHERE id = ?').get('legacy-bank-id')).toEqual({ deleted_at: null });

    db.prepare('DELETE FROM booking_drafts WHERE id = ?').run('legacy-draft');
    expect(rollbackProImportBatch(db, 'legacy-batch', 'legacy correction')).toEqual({ success: true, deletedCount: 2 });
    expect(db.prepare('SELECT deleted_at FROM bank_transactions WHERE id = ?').get('legacy-bank-id')).not.toEqual({ deleted_at: null });
  });

  it('marks closed-period imports as non-rollbackable in batch details', () => {
    const db = openDb();
    const imported = commitProImport(db, { accountId: 'bank', profile: 'generic', fileName: 'x.csv', fileSha256: 'sha', mappingJson: {}, rows: [row], errorCount: 0 });
    db.prepare("INSERT OR IGNORE INTO accounting_periods (id, tenant_id, period, fiscal_year, status, starts_at, ends_at, created_at, updated_at) VALUES ('period-2025-01', 'default', '2025-01', 2025, 'open', '2025-01-01', '2025-01-31', datetime('now'), datetime('now'))").run();
    db.prepare("UPDATE accounting_periods SET status = 'closed' WHERE tenant_id = 'default' AND period = '2025-01'").run();
    expect(getProImportBatchDetails(db, imported.batchId).canRollback).toBe(false);
    expect(() => rollbackProImportBatch(db, imported.batchId, 'closed period')).toThrow('CLOSED_PERIOD_CORRECTION_REQUIRED');
  });
});
