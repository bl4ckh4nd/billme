import crypto from 'crypto';
import type Database from 'better-sqlite3';

export type ImportBatchMeta = {
  accountId: string;
  profile: string;
  fileName: string;
  fileSha256: string;
  mappingJson: unknown;
  importedCount: number;
  skippedCount: number;
  errorCount: number;
};

export const createImportBatch = (db: Database.Database, meta: ImportBatchMeta): string => {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(
    `
      INSERT INTO import_batches (
        id, account_id, profile, file_name, file_sha256, mapping_json,
        imported_count, skipped_count, error_count, created_at
      ) VALUES (
        @id, @accountId, @profile, @fileName, @fileSha256, @mappingJson,
        @importedCount, @skippedCount, @errorCount, @createdAt
      )
    `,
  ).run({
    id,
    accountId: meta.accountId,
    profile: meta.profile,
    fileName: meta.fileName,
    fileSha256: meta.fileSha256,
    mappingJson: JSON.stringify(meta.mappingJson ?? null),
    importedCount: meta.importedCount,
    skippedCount: meta.skippedCount,
    errorCount: meta.errorCount,
    createdAt,
  });
  return id;
};

export type InsertableTransaction = {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  type: string;
  counterparty: string;
  purpose: string;
  linkedInvoiceId?: string | null;
  status: string;
  dedupHash: string;
  importBatchId: string;
};

export const insertTransactionsIgnoringDuplicates = (
  db: Database.Database,
  txs: InsertableTransaction[],
): { inserted: number; skipped: number } => {
  const insert = db.prepare(
    `
      INSERT OR IGNORE INTO transactions (
        id, account_id, date, amount, type, counterparty, purpose, linked_invoice_id, status, dedup_hash, import_batch_id
      ) VALUES (
        @id, @accountId, @date, @amount, @type, @counterparty, @purpose, @linkedInvoiceId, @status, @dedupHash, @importBatchId
      )
    `,
  );

  let inserted = 0;
  for (const t of txs) {
    const res = insert.run({
      id: t.id,
      accountId: t.accountId,
      date: t.date,
      amount: t.amount,
      type: t.type,
      counterparty: t.counterparty,
      purpose: t.purpose,
      linkedInvoiceId: t.linkedInvoiceId ?? null,
      status: t.status,
      dedupHash: t.dedupHash,
      importBatchId: t.importBatchId,
    });
    if (res.changes === 1) inserted++;
  }

  return { inserted, skipped: txs.length - inserted };
};

export interface ImportBatch {
  id: string;
  accountId: string;
  profile: string;
  fileName: string;
  fileSha256: string;
  mappingJson: unknown;
  importedCount: number;
  skippedCount: number;
  errorCount: number;
  createdAt: string;
  rolledBackAt?: string;
  rollbackReason?: string;
}

/**
 * List all import batches (optionally filter by account)
 */
export const listImportBatches = (
  db: Database.Database,
  accountId?: string,
  limit: number = 50,
): ImportBatch[] => {
  let query = 'SELECT * FROM import_batches';
  const params: unknown[] = [];

  if (accountId) {
    query += ' WHERE account_id = ?';
    params.push(accountId);
  }

  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(query).all(...params) as Array<{
    id: string;
    account_id: string;
    profile: string;
    file_name: string;
    file_sha256: string;
    mapping_json: string;
    imported_count: number;
    skipped_count: number;
    error_count: number;
    created_at: string;
    rolled_back_at: string | null;
    rollback_reason: string | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    profile: r.profile,
    fileName: r.file_name,
    fileSha256: r.file_sha256,
    mappingJson: JSON.parse(r.mapping_json),
    importedCount: r.imported_count,
    skippedCount: r.skipped_count,
    errorCount: r.error_count,
    createdAt: r.created_at,
    rolledBackAt: r.rolled_back_at ?? undefined,
    rollbackReason: r.rollback_reason ?? undefined,
  }));
};

/**
 * Get detailed information about an import batch
 */
export const getImportBatchDetails = (
  db: Database.Database,
  batchId: string,
): {
  batch: ImportBatch;
  transactions: Array<{
    id: string;
    date: string;
    amount: number;
    type: string;
    counterparty: string;
    purpose: string;
    linkedInvoiceId?: string;
    status: string;
  }>;
  canRollback: boolean;
  linkedInvoiceCount: number;
} => {
  const batches = listImportBatches(db);
  const batch = batches.find((b) => b.id === batchId);

  if (!batch) {
    throw new Error('Import batch not found');
  }

  // Get transactions for this batch (excluding soft-deleted)
  const txRows = db
    .prepare(
      `
      SELECT * FROM transactions
      WHERE import_batch_id = ?
        AND (deleted_at IS NULL OR deleted_at = '')
      ORDER BY date DESC
      LIMIT 50
    `,
    )
    .all(batchId) as Array<{
    id: string;
    date: string;
    amount: number;
    type: string;
    counterparty: string;
    purpose: string;
    linked_invoice_id: string | null;
    status: string;
  }>;

  const transactions = txRows.map((r) => ({
    id: r.id,
    date: r.date,
    amount: r.amount,
    type: r.type,
    counterparty: r.counterparty,
    purpose: r.purpose,
    linkedInvoiceId: r.linked_invoice_id ?? undefined,
    status: r.status,
  }));

  // Count how many transactions are linked to invoices
  const linkedCount = db
    .prepare(
      `
      SELECT COUNT(*) as count FROM transactions
      WHERE import_batch_id = ?
        AND linked_invoice_id IS NOT NULL
        AND linked_invoice_id <> ''
        AND (deleted_at IS NULL OR deleted_at = '')
    `,
    )
    .get(batchId) as { count: number };

  const canRollback = linkedCount.count === 0 && !batch.rolledBackAt;

  return {
    batch,
    transactions,
    canRollback,
    linkedInvoiceCount: linkedCount.count,
  };
};

/**
 * Rollback an import batch (soft delete transactions)
 */
export const rollbackImportBatch = (
  db: Database.Database,
  batchId: string,
  reason: string,
): { success: boolean; deletedCount: number } => {
  if (!reason || reason.trim().length === 0) {
    throw new Error('Rollback reason is required');
  }

  return db.transaction(() => {
    const details = getImportBatchDetails(db, batchId);

    if (!details.canRollback) {
      if (details.batch.rolledBackAt) {
        throw new Error('Batch has already been rolled back');
      }
      throw new Error(
        `Cannot rollback: ${details.linkedInvoiceCount} transaction(s) are linked to invoices`,
      );
    }

    const now = new Date().toISOString();

    // Soft delete all transactions from this batch
    const result = db
      .prepare(
        `
        UPDATE transactions
        SET deleted_at = ?
        WHERE import_batch_id = ?
          AND (deleted_at IS NULL OR deleted_at = '')
      `,
      )
      .run(now, batchId);

    // Mark batch as rolled back
    db.prepare(
      `
        UPDATE import_batches
        SET rolled_back_at = ?, rollback_reason = ?
        WHERE id = ?
      `,
    ).run(now, reason, batchId);

    return {
      success: true,
      deletedCount: result.changes,
    };
  })();
};

