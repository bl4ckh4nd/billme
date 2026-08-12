import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { bootstrapSql } from './bootstrap';
import { runMigrations } from './migrate';
import { commitProImport } from './financeImportRepo';
import { linkTransactionToInvoice, unlinkTransactionFromInvoice } from './transactionsRepo';

const openDb = () => {
  const db = new Database(':memory:');
  db.exec(bootstrapSql);
  runMigrations(db);
  db.prepare("INSERT INTO accounts (id, name, iban, balance, type, color) VALUES ('bank', 'Bank', '', 0, 'bank', '')").run();
  const imported = commitProImport(db, { accountId: 'bank', profile: 'generic', fileName: 'x.csv', fileSha256: 'sha', mappingJson: {}, rows: [{ id: 'x', accountId: 'bank', date: '2025-01-01', amount: 10, type: 'income', counterparty: 'Acme', purpose: 'P', status: 'booked', dedupHash: 'stable-source' }], errorCount: 0 });
  return { db, transactionId: 'stable-source', batchId: imported.batchId };
};

describe('Pro transaction compatibility guard', () => {
  it('requires the bank/OPOS source for mirrored imports', () => {
    const { db, transactionId } = openDb();
    expect(() => linkTransactionToInvoice(db, transactionId, 'missing-invoice')).toThrow('PRO_BANK_SOURCE_REQUIRED');
    expect(() => unlinkTransactionFromInvoice(db, transactionId)).toThrow('PRO_BANK_SOURCE_REQUIRED');
  });

  it('rejects a tombstoned mirrored import explicitly', () => {
    const { db, transactionId } = openDb();
    db.prepare("UPDATE bank_transactions SET deleted_at = '2025-01-02T00:00:00.000Z' WHERE id = ?").run(transactionId);
    db.prepare("UPDATE transactions SET deleted_at = '2025-01-02T00:00:00.000Z' WHERE id = ?").run(transactionId);
    expect(() => linkTransactionToInvoice(db, transactionId, 'missing-invoice')).toThrow('PRO_IMPORT_ROLLED_BACK');
    expect(() => unlinkTransactionFromInvoice(db, transactionId)).toThrow('PRO_IMPORT_ROLLED_BACK');
  });
});
