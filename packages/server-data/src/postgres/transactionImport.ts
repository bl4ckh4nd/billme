import { randomUUID } from 'node:crypto';
import { previewCsv, type CsvMapping, type CsvPreviewResult, commitCsv } from '@billme/desktop-services/csvImport';
import type { Invoice, TenantScope } from '@billme/server-core';
import { createPostgresBillingDependencies } from './billing.js';
import { appendWithClient } from './audit.js';
import { isPostgresPool, withPostgresTransaction, withSerializablePostgresTransaction, type PostgresQueryable } from './connection.js';
import type { ServerDatabase, ServerDatabaseSession } from '../database.js';

export type TransactionDatabase = PostgresQueryable | ServerDatabase;
type TransactionSession = PostgresQueryable | ServerDatabaseSession;

export interface ServerTransactionRecord {
  id: string;
  accountId: string;
  date: string;
  amount: number;
  type: 'income' | 'expense';
  counterparty: string;
  purpose: string;
  linkedInvoiceId?: string;
  status: 'pending' | 'booked';
  dedupHash?: string;
  importBatchId?: string;
}

export interface TransactionListFilters {
  accountId?: string;
  type?: 'income' | 'expense';
  linkedOnly?: boolean;
  unlinkedOnly?: boolean;
}

export interface InvoiceMatchSuggestion {
  invoice: Invoice;
  confidence: 'high' | 'medium' | 'low';
  matchReasons: string[];
  amountDiff: number;
}

export interface FindTransactionMatchesResult {
  transaction: ServerTransactionRecord;
  suggestions: InvoiceMatchSuggestion[];
}

/**
 * The finance CSV parser is shared with the desktop import UI.  These small
 * adapters keep the parser at one seam while allowing the server runtime to
 * expose the same preview/commit contract over HTTP.
 */
export interface TransactionImportPreviewInput {
  path: string;
  profile?: 'auto' | 'fints' | 'paypal' | 'stripe' | 'generic';
  mapping?: CsvMapping;
  encoding?: 'utf8' | 'win1252';
  delimiter?: string;
  maxRows?: number;
  accountIdForDedupHash?: string;
}

export const previewServerTransactionImport = (
  input: TransactionImportPreviewInput,
): CsvPreviewResult => previewCsv({
  filePath: input.path,
  profile: input.profile,
  mapping: input.mapping,
  encoding: input.encoding,
  delimiter: input.delimiter,
  maxRows: input.maxRows,
  accountIdForDedupHash: input.accountIdForDedupHash,
});

export interface TransactionImportCommitInput {
  path: string;
  accountId: string;
  profile?: 'auto' | 'fints' | 'paypal' | 'stripe' | 'generic';
  mapping: CsvMapping;
  encoding?: 'utf8' | 'win1252';
  delimiter?: string;
}

export const readServerTransactionImport = (
  input: TransactionImportCommitInput,
): ReturnType<typeof commitCsv> => commitCsv({
  filePath: input.path,
  accountId: input.accountId,
  profile: input.profile,
  mapping: input.mapping,
  encoding: input.encoding,
  delimiter: input.delimiter,
});

export interface ServerImportBatch {
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

export interface ServerImportBatchDetails {
  batch: ServerImportBatch;
  transactions: Array<Pick<ServerTransactionRecord, 'id' | 'date' | 'amount' | 'type' | 'counterparty' | 'purpose' | 'linkedInvoiceId' | 'status'>>;
  canRollback: boolean;
  linkedInvoiceCount: number;
}

export interface TransactionImportMutationActor {
  id: string;
  displayName: string;
}

export interface TransactionImportCommitResult {
  batchId: string;
  imported: number;
  skipped: number;
  errors: Array<{ rowIndex: number; message: string }>;
  fileSha256: string;
}

const tenant = (scope: TenantScope): string => scope.tenantId;
const now = (): string => new Date().toISOString();
const transactionPaymentId = (transactionId: string): string => `transaction-payment:${transactionId}`;

const query = async <Row>(
  database: TransactionSession,
  text: string,
  values?: readonly unknown[],
): Promise<{ rows: Row[] }> => (database as unknown as {
  query: (queryText: string, queryValues?: readonly unknown[]) => Promise<{ rows: Row[] }>;
}).query(text, values);

const isServerDatabase = (database: TransactionDatabase): database is ServerDatabase =>
  'transaction' in database && typeof database.transaction === 'function';

const inTransaction = async <T>(
  database: TransactionDatabase,
  work: (session: TransactionSession) => Promise<T>,
  options: { serializable?: boolean } = {},
): Promise<T> => {
  if (isServerDatabase(database)) return database.transaction(options.serializable ? { isolation: 'serializable' } : {}, work);
  if (options.serializable && isPostgresPool(database)) return withSerializablePostgresTransaction(database, work);
  if (isPostgresPool(database)) return withPostgresTransaction(database, work);
  return work(database);
};

const toTransaction = (row: Record<string, unknown>): ServerTransactionRecord => ({
  id: String(row.id),
  accountId: String(row.account_id),
  date: String(row.date),
  amount: Number(row.amount),
  type: row.type === 'expense' ? 'expense' : 'income',
  counterparty: String(row.counterparty ?? ''),
  purpose: String(row.purpose ?? ''),
  linkedInvoiceId: typeof row.linked_invoice_id === 'string' && row.linked_invoice_id ? row.linked_invoice_id : undefined,
  status: row.status === 'booked' ? 'booked' : 'pending',
  dedupHash: typeof row.dedup_hash === 'string' && row.dedup_hash ? row.dedup_hash : undefined,
  importBatchId: typeof row.import_batch_id === 'string' && row.import_batch_id ? row.import_batch_id : undefined,
});

const parseJson = (value: unknown): unknown => {
  if (typeof value !== 'string') return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const toImportBatch = (row: Record<string, unknown>): ServerImportBatch => ({
  id: String(row.id),
  accountId: String(row.account_id),
  profile: String(row.profile),
  fileName: String(row.file_name),
  fileSha256: String(row.file_sha256),
  mappingJson: parseJson(row.mapping_json),
  importedCount: Number(row.imported_count ?? 0),
  skippedCount: Number(row.skipped_count ?? 0),
  errorCount: Number(row.error_count ?? 0),
  createdAt: String(row.created_at),
  rolledBackAt: typeof row.rolled_back_at === 'string' && row.rolled_back_at ? row.rolled_back_at : undefined,
  rollbackReason: typeof row.rollback_reason === 'string' && row.rollback_reason ? row.rollback_reason : undefined,
});

const importBatchSelect = `
  SELECT id, account_id, profile, file_name, file_sha256, mapping_json,
         imported_count, skipped_count, error_count, created_at,
         rolled_back_at, rollback_reason
  FROM import_batches`;

const getImportBatch = async (
  database: TransactionSession,
  scope: TenantScope,
  batchId: string,
  lock = false,
): Promise<ServerImportBatch | null> => {
  const result = await query<Record<string, unknown>>(
    database,
    `${importBatchSelect}
     WHERE tenant_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
    [tenant(scope), batchId],
  );
  return result.rows[0] ? toImportBatch(result.rows[0]) : null;
};

const importErrors = (rows: ReturnType<typeof commitCsv>['rows']): Array<{ rowIndex: number; message: string }> => rows
  .filter((row) => row.errors.length > 0)
  .map((row) => ({ rowIndex: row.rowIndex, message: row.errors.join('; ') }));

const importMappingJson = (input: TransactionImportCommitInput): string => JSON.stringify({
  profile: input.profile ?? 'auto',
  mapping: input.mapping,
  encoding: input.encoding,
  delimiter: input.delimiter,
});

/**
 * Commit a CSV import through the shared database seam.  The parser runs
 * before the transaction; every account, batch, transaction, and audit write
 * below is part of one serializable unit of work.
 */
export const commitServerTransactionImport = async (
  database: TransactionDatabase,
  scope: TenantScope,
  input: TransactionImportCommitInput,
  actor: TransactionImportMutationActor,
): Promise<TransactionImportCommitResult> => {
  const committed = readServerTransactionImport(input);
  const errors = importErrors(committed.rows);
  const validRows = committed.rows.filter((row) => row.errors.length === 0 && row.parsed.date && typeof row.parsed.amount === 'number' && row.parsed.type && row.dedupHash);
  const mappingJson = importMappingJson(input);

  return inTransaction(database, async (session) => {
    const account = await query<{ id: string }>(
      session,
      'SELECT id FROM accounts WHERE tenant_id = $1 AND id = $2',
      [tenant(scope), input.accountId],
    );
    if (!account.rows[0]) throw new Error('ACCOUNT_NOT_FOUND');

    const existing = await query<Record<string, unknown>>(
      session,
      `${importBatchSelect}
       WHERE tenant_id = $1 AND account_id = $2 AND file_sha256 = $3
       ORDER BY created_at ASC, id ASC LIMIT 1`,
      [tenant(scope), input.accountId, committed.fileSha256],
    );
    if (existing.rows[0]) {
      const batch = toImportBatch(existing.rows[0]);
      return {
        batchId: batch.id,
        imported: batch.importedCount,
        skipped: batch.skippedCount,
        errors,
        fileSha256: committed.fileSha256,
      };
    }

    const batchId = randomUUID();
    const createdAt = now();
    await query(session,
      `INSERT INTO import_batches
        (id, tenant_id, account_id, profile, file_name, file_sha256, mapping_json,
         imported_count, skipped_count, error_count, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0, 0, $8, $9)`,
      [batchId, tenant(scope), input.accountId, committed.profile, committed.fileName, committed.fileSha256, mappingJson, errors.length, createdAt],
    );

    let imported = 0;
    let skipped = 0;
    const seenHashes = new Set<string>();
    for (const row of validRows) {
      const dedupHash = row.dedupHash!;
      if (seenHashes.has(dedupHash)) {
        skipped += 1;
        continue;
      }
      seenHashes.add(dedupHash);
      const duplicate = await query<{ id: string }>(
        session,
        `SELECT id
         FROM transactions
         WHERE tenant_id = $1 AND account_id = $2 AND dedup_hash = $3
           AND (deleted_at IS NULL OR deleted_at = '')
         LIMIT 1
         FOR UPDATE`,
        [tenant(scope), input.accountId, dedupHash],
      );
      if (duplicate.rows[0]) {
        skipped += 1;
        continue;
      }
      await query(session,
        `INSERT INTO transactions
          (id, tenant_id, account_id, date, amount, type, counterparty, purpose,
           linked_invoice_id, status, dedup_hash, import_batch_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, $10, $11)`,
        [
          randomUUID(),
          tenant(scope),
          input.accountId,
          row.parsed.date,
          row.parsed.amount,
          row.parsed.type,
          row.parsed.counterparty ?? '',
          row.parsed.purpose ?? '',
          row.parsed.status ?? 'booked',
          dedupHash,
          batchId,
        ],
      );
      imported += 1;
    }

    await query(session,
      `UPDATE import_batches
       SET imported_count = $1, skipped_count = $2, error_count = $3
       WHERE tenant_id = $4 AND id = $5`,
      [imported, skipped, errors.length, tenant(scope), batchId],
    );
    await appendWithClient(session, scope, {
      occurredAt: createdAt,
      action: 'finance_import.commit',
      reason: `CSV-Import ${committed.fileName}`,
      actor: { type: 'user', id: actor.id, displayName: actor.displayName },
      subject: { entityType: 'finance_import', entityId: batchId, tenantId: tenant(scope) },
      change: { before: null, after: { batchId, imported, skipped, errors: errors.length, fileSha256: committed.fileSha256 } },
    });
    return { batchId, imported, skipped, errors, fileSha256: committed.fileSha256 };
  }, { serializable: true });
};

export const listServerImportBatches = async (
  database: TransactionDatabase,
  scope: TenantScope,
  accountId?: string,
  limit = 50,
): Promise<ServerImportBatch[]> => {
  const values: unknown[] = [tenant(scope)];
  const clauses = ['tenant_id = $1'];
  if (accountId) {
    values.push(accountId);
    clauses.push(`account_id = $${values.length}`);
  }
  values.push(Math.min(Math.max(Math.trunc(limit), 1), 100));
  const result = await query<Record<string, unknown>>(
    database,
    `${importBatchSelect}
     WHERE ${clauses.join(' AND ')}
     ORDER BY created_at DESC, id DESC
     LIMIT $${values.length}`,
    values,
  );
  return result.rows.map(toImportBatch);
};

export const getServerImportBatchDetails = async (
  database: TransactionDatabase,
  scope: TenantScope,
  batchId: string,
): Promise<ServerImportBatchDetails> => {
  const batch = await getImportBatch(database, scope, batchId);
  if (!batch) throw new Error('IMPORT_BATCH_NOT_FOUND');
  const transactions = await query<Record<string, unknown>>(
    database,
    `SELECT id, account_id, date, amount, type, counterparty, purpose,
            linked_invoice_id, status, dedup_hash, import_batch_id
     FROM transactions
     WHERE tenant_id = $1 AND import_batch_id = $2
       AND (deleted_at IS NULL OR deleted_at = '')
     ORDER BY date DESC, id ASC`,
    [tenant(scope), batchId],
  );
  const linked = transactions.rows.filter((row) => typeof row.linked_invoice_id === 'string' && row.linked_invoice_id).length;
  return {
    batch,
    transactions: transactions.rows.map(toTransaction),
    canRollback: linked === 0 && !batch.rolledBackAt,
    linkedInvoiceCount: linked,
  };
};

export const rollbackServerImportBatch = async (
  database: TransactionDatabase,
  scope: TenantScope,
  batchId: string,
  reason: string,
  actor: TransactionImportMutationActor,
): Promise<{ success: true; deletedCount: number }> => {
  if (!reason.trim()) throw new Error('ROLLBACK_REASON_REQUIRED');
  return inTransaction(database, async (session) => {
    const batch = await getImportBatch(session, scope, batchId, true);
    if (!batch) throw new Error('IMPORT_BATCH_NOT_FOUND');
    if (batch.rolledBackAt) throw new Error('IMPORT_BATCH_ALREADY_ROLLED_BACK');
    const linked = await query<{ id: string }>(
      session,
      `SELECT id FROM transactions
       WHERE tenant_id = $1 AND import_batch_id = $2
         AND (deleted_at IS NULL OR deleted_at = '')
         AND linked_invoice_id IS NOT NULL AND linked_invoice_id <> ''
       FOR UPDATE`,
      [tenant(scope), batchId],
    );
    if (linked.rows.length > 0) throw new Error('IMPORT_BATCH_LINKED');
    const rolledBackAt = now();
    const deleted = await query<{ id: string }>(
      session,
      `UPDATE transactions
       SET deleted_at = $1
       WHERE tenant_id = $2 AND import_batch_id = $3
         AND (deleted_at IS NULL OR deleted_at = '')
       RETURNING id`,
      [rolledBackAt, tenant(scope), batchId],
    );
    await query(session,
      `UPDATE import_batches
       SET rolled_back_at = $1, rollback_reason = $2
       WHERE tenant_id = $3 AND id = $4`,
      [rolledBackAt, reason, tenant(scope), batchId],
    );
    await appendWithClient(session, scope, {
      occurredAt: rolledBackAt,
      action: 'finance_import.rollback',
      reason,
      actor: { type: 'user', id: actor.id, displayName: actor.displayName },
      subject: { entityType: 'finance_import', entityId: batchId, tenantId: tenant(scope) },
      change: { before: batch, after: { ...batch, rolledBackAt, rollbackReason: reason, deletedCount: deleted.rows.length } },
    });
    return { success: true as const, deletedCount: deleted.rows.length };
  }, { serializable: true });
};

const transactionWhere = (scope: TenantScope, filters: TransactionListFilters = {}) => {
  const values: unknown[] = [tenant(scope)];
  const clauses = [
    'tenant_id = $1',
    "(deleted_at IS NULL OR deleted_at = '')",
  ];
  const add = (clause: string, value: unknown) => {
    values.push(value);
    clauses.push(clause.replace('$VALUE', `$${values.length}`));
  };
  if (filters.accountId) add('account_id = $VALUE', filters.accountId);
  if (filters.type) add('type = $VALUE', filters.type);
  if (filters.linkedOnly) clauses.push("linked_invoice_id IS NOT NULL AND linked_invoice_id <> ''");
  if (filters.unlinkedOnly) clauses.push("(linked_invoice_id IS NULL OR linked_invoice_id = '')");
  return { clauses, values };
};

export const listServerTransactions = async (
  database: TransactionDatabase,
  scope: TenantScope,
  filters: TransactionListFilters = {},
): Promise<ServerTransactionRecord[]> => {
  const where = transactionWhere(scope, filters);
  const result = await query<Record<string, unknown>>(database,
    `SELECT id, account_id, date, amount, type, counterparty, purpose, linked_invoice_id, status, dedup_hash, import_batch_id
     FROM transactions
     WHERE ${where.clauses.join(' AND ')}
     ORDER BY date DESC, amount DESC, id ASC`,
    where.values,
  );
  return result.rows.map(toTransaction);
};

const getTransaction = async (
  database: TransactionSession,
  scope: TenantScope,
  id: string,
  lock = false,
): Promise<ServerTransactionRecord | null> => {
  const result = await query<Record<string, unknown>>(database,
    `SELECT id, account_id, date, amount, type, counterparty, purpose, linked_invoice_id, status, dedup_hash, import_batch_id
     FROM transactions
     WHERE tenant_id = $1 AND id = $2 AND (deleted_at IS NULL OR deleted_at = '')${lock ? ' FOR UPDATE' : ''}`,
    [tenant(scope), id],
  );
  return result.rows[0] ? toTransaction(result.rows[0]) : null;
};

const invoiceMatchSuggestions = (
  transaction: ServerTransactionRecord,
  invoices: Invoice[],
): InvoiceMatchSuggestion[] => {
  const suggestions: InvoiceMatchSuggestion[] = [];
  for (const invoice of invoices) {
    const matchReasons: string[] = [];
    let confidence: InvoiceMatchSuggestion['confidence'] = 'low';
    const alreadyPaid = (invoice.payments ?? []).reduce((sum, payment) => sum + Number(payment.amount), 0);
    const remainingAmount = invoice.amount - alreadyPaid;
    const amountDiff = Math.abs(transaction.amount - remainingAmount);
    if (amountDiff <= 5) {
      matchReasons.push(`Betrag stimmt überein (±${amountDiff.toFixed(2)}€)`);
      confidence = 'high';
    } else if (amountDiff <= remainingAmount * 0.1) {
      matchReasons.push(`Betrag ähnlich (${amountDiff.toFixed(2)}€ Differenz)`);
      confidence = 'medium';
    }
    if (transaction.purpose.toLowerCase().includes(invoice.number.toLowerCase())) {
      matchReasons.push('Rechnungsnummer in Verwendungszweck');
      confidence = 'high';
    }
    const counterparty = transaction.counterparty.toLowerCase();
    const clientWords = invoice.client.toLowerCase().split(/\s+/).filter((word) => word.length > 2);
    if (clientWords.some((word) => counterparty.includes(word))) {
      matchReasons.push('Kundenname im Auftraggeber');
      if (confidence === 'low') confidence = 'medium';
    }
    const daysDiff = Math.abs((new Date(transaction.date).getTime() - new Date(invoice.dueDate).getTime()) / (1000 * 60 * 60 * 24));
    if (daysDiff <= 14) {
      matchReasons.push(`Zahlung nahe Fälligkeitsdatum (${Math.floor(daysDiff)} Tage)`);
      if (confidence === 'low') confidence = 'medium';
    }
    if (matchReasons.length > 0) suggestions.push({ invoice, confidence, matchReasons, amountDiff });
  }
  suggestions.sort((left, right) => {
    const confidenceOrder = { high: 3, medium: 2, low: 1 };
    return confidenceOrder[right.confidence] - confidenceOrder[left.confidence] || left.amountDiff - right.amountDiff;
  });
  return suggestions.slice(0, 5);
};

export const findServerTransactionMatches = async (
  database: TransactionDatabase,
  scope: TenantScope,
  transactionId: string,
): Promise<FindTransactionMatchesResult> => {
  const transaction = await getTransaction(database, scope, transactionId);
  if (!transaction) throw new Error('TRANSACTION_NOT_FOUND');
  const invoices = await createPostgresBillingDependencies(database).invoiceRepo.list(scope);
  return {
    transaction,
    suggestions: invoiceMatchSuggestions(transaction, invoices.filter((invoice) => invoice.status === 'open' || invoice.status === 'overdue')),
  };
};

const audit = async (
  database: TransactionSession,
  scope: TenantScope,
  entityType: 'transaction' | 'invoice',
  entityId: string,
  action: string,
  reason: string,
  before: unknown,
  after: unknown,
  actor: { id: string; displayName: string },
): Promise<void> => {
  await appendWithClient(database, scope, {
    occurredAt: now(),
    action,
    reason,
    actor: { type: 'user', id: actor.id, displayName: actor.displayName },
    subject: { entityType, entityId, tenantId: scope.tenantId },
    change: { before, after },
  });
};

export interface TransactionMutationActor {
  id: string;
  displayName: string;
}

export const linkServerTransaction = async (
  database: TransactionDatabase,
  scope: TenantScope,
  transactionId: string,
  invoiceId: string,
  reason: string,
  actor: TransactionMutationActor,
): Promise<{ success: true; invoice: Invoice }> => inTransaction(database, async (session) => {
  const transaction = await getTransaction(session, scope, transactionId, true);
  if (!transaction) throw new Error('TRANSACTION_NOT_FOUND');
  if (transaction.linkedInvoiceId) throw new Error('TRANSACTION_ALREADY_LINKED');
  const dependencies = createPostgresBillingDependencies(session);
  const invoice = await dependencies.invoiceRepo.getById(scope, invoiceId);
  if (!invoice) throw new Error('INVOICE_NOT_FOUND');
  const payment = { id: transactionPaymentId(transaction.id), date: transaction.date, amount: transaction.amount, method: 'Überweisung' };
  const updatedInvoice: Invoice = {
    ...invoice,
    payments: [...(invoice.payments ?? []), payment],
    status: (invoice.payments ?? []).reduce((sum, entry) => sum + Number(entry.amount), 0) + transaction.amount >= invoice.amount
      ? 'paid'
      : invoice.status,
  };
  const savedInvoice = await dependencies.invoiceRepo.save(scope, updatedInvoice);
  await query(session,
    `UPDATE transactions SET linked_invoice_id = $1 WHERE tenant_id = $2 AND id = $3`,
    [invoiceId, tenant(scope), transactionId],
  );
  await audit(session, scope, 'transaction', transactionId, 'link_invoice', reason, transaction, { ...transaction, linkedInvoiceId: invoiceId }, actor);
  await audit(session, scope, 'invoice', invoiceId, 'payment_linked', reason, invoice, savedInvoice, actor);
  return { success: true, invoice: savedInvoice };
});

export const unlinkServerTransaction = async (
  database: TransactionDatabase,
  scope: TenantScope,
  transactionId: string,
  reason: string,
  actor: TransactionMutationActor,
): Promise<{ success: true }> => inTransaction(database, async (session) => {
  const transaction = await getTransaction(session, scope, transactionId, true);
  if (!transaction) throw new Error('TRANSACTION_NOT_FOUND');
  if (!transaction.linkedInvoiceId) throw new Error('TRANSACTION_NOT_LINKED');
  const dependencies = createPostgresBillingDependencies(session);
  const invoice = await dependencies.invoiceRepo.getById(scope, transaction.linkedInvoiceId);
  if (invoice) {
    // Payment identity is transaction-derived.  Filtering by date and amount
    // would remove a legitimate second payment with the same values.
    const paymentId = transactionPaymentId(transaction.id);
    const payments = (invoice.payments ?? []).filter((payment) => payment.id !== paymentId);
    const totalPaid = payments.reduce((sum, payment) => sum + Number(payment.amount), 0);
    const updatedInvoice: Invoice = {
      ...invoice,
      payments,
      status: totalPaid >= invoice.amount ? 'paid' : 'open',
    };
    const savedInvoice = await dependencies.invoiceRepo.save(scope, updatedInvoice);
    await audit(session, scope, 'invoice', invoice.id, 'payment_unlinked', reason, invoice, savedInvoice, actor);
  }
  await query(session,
    `UPDATE transactions SET linked_invoice_id = NULL WHERE tenant_id = $1 AND id = $2`,
    [tenant(scope), transactionId],
  );
  await audit(session, scope, 'transaction', transactionId, 'unlink_invoice', reason, transaction, { ...transaction, linkedInvoiceId: undefined }, actor);
  return { success: true };
});
