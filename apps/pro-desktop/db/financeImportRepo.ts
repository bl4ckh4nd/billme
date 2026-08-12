import type Database from 'better-sqlite3';
import { appendAuditLog } from './audit';
import { createImportBatch, listImportBatches, type ImportBatch } from '@billme/desktop-data/financeImportRepo';

export {
  createImportBatch,
  insertTransactionsIgnoringDuplicates,
  listImportBatches,
  getImportBatchDetails,
  rollbackImportBatch,
} from '@billme/desktop-data/financeImportRepo';
export type { ImportBatch } from '@billme/desktop-data/financeImportRepo';

/** The Pro importer is the one owner of the bank row and its Lite compatibility mirror. */
export type ProImportRow = {
  rowIndex?: number;
  id: string;
  accountId: string;
  date: string;
  amount: number;
  type: 'income' | 'expense';
  counterparty: string;
  purpose: string;
  status: 'pending' | 'booked';
  dedupHash: string;
};

export type ProImportResult = {
  batchId: string;
  inserted: number;
  skipped: number;
  conflicts: Array<{ sourceTransactionId: string; reason: string; rowIndex?: number }>;
};

export const commitProImport = (
  db: Database.Database,
  input: {
    accountId: string;
    profile: string;
    fileName: string;
    fileSha256: string;
    mappingJson: unknown;
    rows: ProImportRow[];
    errorCount: number;
  },
): ProImportResult => db.transaction(() => {
  const batchId = createImportBatch(db, {
    accountId: input.accountId,
    profile: input.profile,
    fileName: input.fileName,
    fileSha256: input.fileSha256,
    mappingJson: input.mappingJson,
    importedCount: 0,
    skippedCount: 0,
    errorCount: input.errorCount,
  });
  const insertTransaction = db.prepare(`
    INSERT INTO transactions
      (id, account_id, date, amount, type, counterparty, purpose, linked_invoice_id, status, dedup_hash, import_batch_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
  `);
  const insertBank = db.prepare(`
    INSERT INTO bank_transactions
      (id, tenant_id, account_id, date, amount, type, counterparty, purpose, linked_invoice_id, status, source_transaction_id, created_at, updated_at)
    VALUES (?, 'default', ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
  `);
  const conflicts: ProImportResult['conflicts'] = [];
  let inserted = 0;
  let skipped = 0;
  const now = new Date().toISOString();

  for (const row of input.rows) {
    // The normalized import hash is stable across re-imports and shared by both records.
    const sourceTransactionId = row.dedupHash;
    const tx = db.prepare('SELECT id, import_batch_id FROM transactions WHERE account_id = ? AND dedup_hash = ?').get(row.accountId, row.dedupHash) as { id: string; import_batch_id: string | null } | undefined;
    const bank = db.prepare('SELECT id, account_id FROM bank_transactions WHERE tenant_id = ? AND source_transaction_id = ?').get('default', sourceTransactionId) as { id: string; account_id: string } | undefined;
    if (tx || bank) {
      if (tx && bank && tx.id === sourceTransactionId && bank.id === sourceTransactionId) {
        skipped += 1;
      } else {
        const reason = tx && bank ? 'SOURCE_ID_CONFLICT' : 'PARTIAL_IMPORT_RECONCILIATION_REQUIRED';
        conflicts.push({ sourceTransactionId, reason, rowIndex: row.rowIndex });
        appendAuditLog(db, {
          entityType: 'finance_import',
          entityId: sourceTransactionId,
          action: 'import_conflict',
          reason,
          before: { transaction: tx ?? null, bank: bank ?? null },
          after: { batchId },
          actor: 'pro',
        });
      }
      continue;
    }

    const transactionId = sourceTransactionId;
    const bankId = sourceTransactionId;
    insertTransaction.run(transactionId, row.accountId, row.date, row.amount, row.type, row.counterparty, row.purpose, row.status, row.dedupHash, batchId);
    try {
      insertBank.run(bankId, row.accountId, row.date, row.amount, row.type, row.counterparty, row.purpose, row.status, sourceTransactionId, now, now);
    } catch (error) {
      // better-sqlite3 rolls the enclosing transaction back; no compatibility half-row survives.
      throw error;
    }
    inserted += 1;
  }

  db.prepare('UPDATE import_batches SET imported_count = ?, skipped_count = ?, error_count = ? WHERE id = ?').run(inserted, skipped, input.errorCount + conflicts.length, batchId);
  return { batchId, inserted, skipped, conflicts };
})();

export const getProImportBatchDetails = (db: Database.Database, batchId: string) => {
  const batch = listImportBatches(db).find((item: ImportBatch) => item.id === batchId);
  if (!batch) throw new Error('Import batch not found');
  const rows = db.prepare(`
    SELECT t.id, t.linked_invoice_id, t.status, b.id AS bank_id, b.linked_invoice_id AS bank_linked_invoice_id
    FROM transactions t LEFT JOIN bank_transactions b ON b.source_transaction_id = t.dedup_hash AND b.tenant_id = 'default'
    WHERE t.import_batch_id = ? AND (t.deleted_at IS NULL OR t.deleted_at = '')
  `).all(batchId) as Array<Record<string, unknown>>;
  const linkedInvoiceCount = rows.filter((row) => row.linked_invoice_id || row.bank_linked_invoice_id).length;
  return { batch, transactions: rows, canRollback: linkedInvoiceCount === 0 && !batch.rolledBackAt, linkedInvoiceCount };
};

export const rollbackProImportBatch = (db: Database.Database, batchId: string, reason: string): { success: true; deletedCount: number } => {
  if (!reason.trim()) throw new Error('Rollback reason is required');
  return db.transaction(() => {
    const details = getProImportBatchDetails(db, batchId);
    if (details.batch.rolledBackAt) throw new Error('Batch has already been rolled back');
    if (details.linkedInvoiceCount > 0) throw new Error('ROLLBACK_REQUIRES_CORRECTION: linked invoice payment');
    const sourceIds = db.prepare('SELECT dedup_hash FROM transactions WHERE import_batch_id = ?').all(batchId) as Array<{ dedup_hash: string | null }>;
    for (const source of sourceIds) {
      if (!source.dedup_hash) continue;
      const bank = db.prepare('SELECT id, linked_invoice_id FROM bank_transactions WHERE tenant_id = ? AND source_transaction_id = ?').get('default', source.dedup_hash) as { id: string; linked_invoice_id: string | null } | undefined;
      if (bank?.linked_invoice_id) throw new Error('ROLLBACK_REQUIRES_CORRECTION: linked invoice payment');
      if (bank && db.prepare("SELECT 1 FROM accounting_periods WHERE tenant_id = 'default' AND period = (SELECT substr(date, 1, 7) FROM bank_transactions WHERE id = ?) AND status = 'closed' LIMIT 1").get(bank.id)) throw new Error('CLOSED_PERIOD_CORRECTION_REQUIRED');
      if (bank && db.prepare("SELECT 1 FROM booking_drafts WHERE tenant_id = 'default' AND transaction_id = ? AND workflow_status IN ('approved', 'posted') LIMIT 1").get(bank.id)) throw new Error('ROLLBACK_REQUIRES_CORRECTION: booking draft or posted accounting effect');
      if (bank && db.prepare("SELECT 1 FROM open_item_payments WHERE tenant_id = 'default' AND source_type = 'bank_transaction' AND source_id = ? LIMIT 1").get(bank.id)) throw new Error('ROLLBACK_REQUIRES_CORRECTION: open-item payment');
      if (bank && db.prepare("SELECT 1 FROM journal_entries WHERE tenant_id = 'default' AND (source_key = ? OR source_key LIKE ?) LIMIT 1").get(bank.id, `%${bank.id}%`)) throw new Error('ROLLBACK_REQUIRES_CORRECTION: posted journal');
    }
    const now = new Date().toISOString();
    const deletedTransactions = db.prepare("UPDATE transactions SET deleted_at = ? WHERE import_batch_id = ? AND (deleted_at IS NULL OR deleted_at = '')").run(now, batchId).changes;
    const bankIds = sourceIds.map((source) => source.dedup_hash).filter((id): id is string => Boolean(id));
    let deletedBanks = 0;
    for (const sourceId of bankIds) {
      deletedBanks += db.prepare("UPDATE bank_transactions SET deleted_at = ?, rollback_reason = ? WHERE tenant_id = 'default' AND source_transaction_id = ? AND (deleted_at IS NULL OR deleted_at = '')").run(now, reason, sourceId).changes;
    }
    db.prepare('UPDATE import_batches SET rolled_back_at = ?, rollback_reason = ? WHERE id = ?').run(now, reason, batchId);
    appendAuditLog(db, { entityType: 'finance_import', entityId: batchId, action: 'rollback', reason, before: { deletedTransactions, deletedBanks }, after: { rolledBackAt: now }, actor: 'pro' });
    return { success: true as const, deletedCount: deletedTransactions + deletedBanks };
  })();
};
