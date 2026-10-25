import { createHash, randomUUID } from 'node:crypto';
import { liteCashEntryInputSchema, liteCashEntrySchema, liteReceiptInputSchema, liteReceiptSchema, liteReceiptUploadSchema, type AccountingMutationContext, type TenantScope } from '@billme/server-core';
import { assertIncomingInvoiceDocumentContent } from '@billme/accounting-shared';
import { appendWithClient } from './audit.js';
import { carryLiteEurDecisionInTransaction } from './eurFacts.js';
import { assertLitePeriodsOpen, periodClosedMessage } from './litePeriods.js';
import { runInTransaction, type PostgresQueryable, type PostgresTransactionClient } from './connection.js';

const rows = async <T = Record<string, unknown>>(db: PostgresQueryable, sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows as T[];
const changedAt = (before?: string) => new Date(Math.max(Date.now(), before ? Date.parse(before) + 1 : 0)).toISOString();
const audit = (db: PostgresTransactionClient, scope: TenantScope, mutation: AccountingMutationContext, type: string, id: string, action: string, before: unknown, after: unknown) => {
  if (!mutation.actor || !mutation.reason?.trim()) throw new Error('LITE_CASH_AUDIT_REQUIRED');
  return appendWithClient(db, scope, { occurredAt: changedAt(), reason: mutation.reason, actor: mutation.actor, action, subject: { entityType: type, entityId: id, tenantId: scope.tenantId }, change: { before, after } });
};

/**
 * GoBD Festschreibung: a closed month (accounting_periods, status closed) takes no new, changed, deleted or
 * re-matched cash entries, payments or bank links. Closing is final; corrections go into an open month.
 */
export const listLiteClosedPeriods = async (db: PostgresQueryable, scope: TenantScope) =>
  (await rows<{ period: string; updated_at: string }>(db, "SELECT period, updated_at FROM accounting_periods WHERE tenant_id=$1 AND status='closed' ORDER BY period", [scope.tenantId]))
    .map((row) => ({ period: row.period, closedAt: row.updated_at }));

export { assertLitePeriodsOpen, periodClosedMessage };

export const closeLitePeriod = (db: PostgresQueryable, scope: TenantScope, period: string, today: string, mutation: AccountingMutationContext) => runInTransaction(db, async (client) => {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new Error('LITE_PERIOD_INVALID');
  // A month is closed once it is over; the running month still takes entries.
  if (period >= today.slice(0, 7)) throw new Error('LITE_PERIOD_INVALID');
  const before = (await rows<{ status: string }>(client, 'SELECT status FROM accounting_periods WHERE tenant_id=$1 AND period=$2 FOR UPDATE', [scope.tenantId, period]))[0];
  if (before?.status === 'closed') return { period, closed: true as const };
  const [year, month] = period.split('-').map(Number);
  const end = new Date(Date.UTC(year!, month!, 0)).toISOString().slice(0, 10);
  const stamp = changedAt();
  await client.query(`INSERT INTO accounting_periods (id,tenant_id,period,fiscal_year,status,starts_at,ends_at,created_at,updated_at) VALUES ($1,$2,$3,$4,'closed',$5,$6,$7,$7)
    ON CONFLICT (tenant_id,period) DO UPDATE SET status='closed', updated_at=EXCLUDED.updated_at`, [randomUUID(), scope.tenantId, period, year, `${period}-01`, end, stamp]);
  await audit(client, scope, mutation, 'accounting_period', period, 'lite.period.close', before ?? null, { period, status: 'closed' });
  return { period, closed: true as const };
});

export const listLiteCashEntries = async (db: PostgresQueryable, scope: TenantScope) => {
  const result = await rows(db, `SELECT m.*,t.date AS bank_date,t.account_id FROM lite_cash_entries m LEFT JOIN transactions t ON t.tenant_id=m.tenant_id AND t.id=m.matched_transaction_id WHERE m.tenant_id=$1 AND m.deleted_at IS NULL ORDER BY COALESCE(t.date,m.cash_date) DESC,m.id`, [scope.tenantId]);
  return result.map((row) => liteCashEntrySchema.parse({ id: row.id, cashDate: row.bank_date ?? row.cash_date, originalCashDate: row.cash_date, amountCents: Number(row.amount_cents), currency: row.currency, flowType: row.flow_type, counterparty: row.counterparty, purpose: row.purpose, receiptId: row.receipt_id ?? undefined, paymentMethod: row.payment_method ?? undefined, matchedTransactionId: row.matched_transaction_id ?? undefined, accountId: row.account_id ?? undefined, updatedAt: row.updated_at }));
};
export const listLiteReceipts = async (db: PostgresQueryable, scope: TenantScope) =>
  (await rows(db, `SELECT r.*, (SELECT count(*)::int FROM lite_receipt_files f WHERE f.tenant_id=r.tenant_id AND f.receipt_id=r.id) AS file_count FROM lite_receipts r WHERE r.tenant_id=$1 ORDER BY r.updated_at DESC`, [scope.tenantId]))
    .map((row) => liteReceiptSchema.parse({ ...(typeof row.receipt_json === 'string' ? JSON.parse(row.receipt_json) : row.receipt_json as object), updatedAt: row.updated_at, fileCount: row.file_count }));

/** The dates that place a receipt in a VAT month (see liteVat: later of received/service date, import or correction date). */
const receiptTaxDates = (receipt: { documentDate: string; receivedDate?: string; serviceDate?: string; importTaxDate?: string; adjustmentDate?: string }) =>
  [[receipt.receivedDate ?? receipt.documentDate, receipt.serviceDate ?? receipt.documentDate].sort()[1], receipt.importTaxDate, receipt.adjustmentDate];

export const saveLiteReceipt = (db: PostgresQueryable, scope: TenantScope, input: unknown, expectedUpdatedAt: string | undefined, mutation: AccountingMutationContext) => runInTransaction(db, async (client) => {
  const receipt = liteReceiptInputSchema.parse(input);
  const before = (await rows(client, 'SELECT * FROM lite_receipts WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [scope.tenantId, receipt.id]))[0];
  const old = before?.receipt_json;
  if (before && JSON.stringify(liteReceiptInputSchema.parse(old)) === JSON.stringify(receipt)) return (await listLiteReceipts(client, scope)).find((row) => row.id === receipt.id)!;
  if (before && expectedUpdatedAt !== before.updated_at) throw new Error('LITE_CASH_STALE');
  // Festschreibung: neither the input VAT month of the receipt (old or new) nor a month it was paid in may change.
  const paidOn = await rows<{ date: string }>(client, 'SELECT COALESCE(t.date, m.cash_date) AS date FROM lite_cash_entries m LEFT JOIN transactions t ON t.tenant_id=m.tenant_id AND t.id=m.matched_transaction_id WHERE m.tenant_id=$1 AND m.receipt_id=$2 AND m.deleted_at IS NULL', [scope.tenantId, receipt.id]);
  await assertLitePeriodsOpen(client, scope, [...(old ? receiptTaxDates(liteReceiptInputSchema.parse(old)) : []), ...receiptTaxDates(receipt), ...paidOn.map((row) => row.date)]);
  if (receipt.reviewed) {
    const total = receipt.taxBreakdown.reduce((sum, line) => sum + line.netAmountCents + (['reverse_charge', 'eu_service', 'intra_eu_acquisition'].includes(receipt.taxMode) ? 0 : line.vatAmountCents), 0);
    if (!receipt.receivedDate || !receipt.serviceDate || total !== receipt.grossAmountCents || receipt.taxBreakdown.length === 0) throw new Error('LITE_RECEIPT_TAX_INCOMPLETE');
    for (const line of receipt.taxBreakdown) {
      if (['exempt', 'small_business'].includes(receipt.taxMode) && (line.rate !== 0 || line.vatAmountCents !== 0)) throw new Error('LITE_RECEIPT_TAX_INVALID');
      if (receipt.taxMode !== 'import' && Math.abs(Math.round(line.netAmountCents * line.rate / 100) - line.vatAmountCents) > 1) throw new Error('LITE_RECEIPT_TAX_INVALID');
    }
  }
  if (receipt.correctionOfReceiptId) {
    const source = (await rows(client, 'SELECT receipt_json FROM lite_receipts WHERE tenant_id=$1 AND id=$2', [scope.tenantId, receipt.correctionOfReceiptId]))[0];
    if (!source || receipt.correctionOfReceiptId === receipt.id) throw new Error('LITE_CASH_REFERENCE_INVALID');
    const original = liteReceiptInputSchema.parse(source.receipt_json);
    if (original.grossAmountCents <= 0 || receipt.taxMode !== original.taxMode || receipt.deductiblePercent !== original.deductiblePercent) throw new Error('LITE_RECEIPT_TAX_INCOMPLETE');
  }
  const stamp = changedAt(before?.updated_at as string | undefined);
  const saved = await rows(client, `INSERT INTO lite_receipts (id,tenant_id,receipt_json,updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET receipt_json=EXCLUDED.receipt_json,updated_at=EXCLUDED.updated_at WHERE lite_receipts.tenant_id=EXCLUDED.tenant_id RETURNING id`, [receipt.id, scope.tenantId, JSON.stringify(receipt), stamp]);
  if (!saved.length) throw new Error('LITE_CASH_REFERENCE_INVALID');
  await audit(client, scope, mutation, 'lite_receipt', receipt.id, before ? 'lite.receipt.update' : 'lite.receipt.create', old ?? null, receipt);
  return (await listLiteReceipts(client, scope)).find((row) => row.id === receipt.id)!;
});

export const saveLiteCashEntry = (db: PostgresQueryable, scope: TenantScope, input: unknown, expectedUpdatedAt: string | undefined, mutation: AccountingMutationContext) => runInTransaction(db, async (client) => {
  const entry = liteCashEntryInputSchema.parse(input);
  const before = (await rows(client, 'SELECT * FROM lite_cash_entries WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE', [scope.tenantId, entry.id]))[0];
  if (before) {
    const current = (await listLiteCashEntries(client, scope)).find((row) => row.id === entry.id)!;
    if (JSON.stringify(liteCashEntryInputSchema.parse({ ...current, cashDate: current.originalCashDate })) === JSON.stringify(entry)) return current;
  }
  if (before && before.matched_transaction_id) throw new Error('LITE_CASH_MATCHED');
  if (before && expectedUpdatedAt !== before.updated_at) throw new Error('LITE_CASH_STALE');
  await assertLitePeriodsOpen(client, scope, [entry.cashDate, before?.cash_date as string | undefined]);
  if (entry.receiptId && !(await rows(client, 'SELECT id FROM lite_receipts WHERE tenant_id=$1 AND id=$2', [scope.tenantId, entry.receiptId])).length) throw new Error('LITE_CASH_REFERENCE_INVALID');
  const stamp = changedAt(before?.updated_at as string | undefined);
  const saved = await rows(client, `INSERT INTO lite_cash_entries (id,tenant_id,cash_date,amount_cents,currency,flow_type,counterparty,purpose,receipt_id,updated_at,payment_method) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO UPDATE SET payment_method=EXCLUDED.payment_method, cash_date=EXCLUDED.cash_date,amount_cents=EXCLUDED.amount_cents,currency=EXCLUDED.currency,flow_type=EXCLUDED.flow_type,counterparty=EXCLUDED.counterparty,purpose=EXCLUDED.purpose,receipt_id=EXCLUDED.receipt_id,updated_at=EXCLUDED.updated_at WHERE lite_cash_entries.tenant_id=EXCLUDED.tenant_id AND lite_cash_entries.deleted_at IS NULL RETURNING id`, [entry.id, scope.tenantId, entry.cashDate, entry.amountCents, entry.currency, entry.flowType, entry.counterparty, entry.purpose, entry.receiptId ?? null, stamp, entry.paymentMethod ?? null]);
  if (!saved.length) throw new Error('LITE_CASH_REFERENCE_INVALID');
  await audit(client, scope, mutation, 'lite_cash_entry', entry.id, before ? 'lite.cash.update' : 'lite.cash.create', before ?? null, entry);
  return (await listLiteCashEntries(client, scope)).find((row) => row.id === entry.id)!;
});

/**
 * Ties a cash entry to its bank line. Same amount and direction for a card or bank payment entered by hand;
 * with `transit` the opposite direction, for a Barabhebung (bank out, cash in) or Bareinzahlung (cash out,
 * bank in): one Geldtransit, which the EÜR then counts nowhere.
 */
export const matchLiteCashEntry = (db: PostgresQueryable, scope: TenantScope, entryId: string, transactionId: string | undefined, expectedCashDate: string | undefined, mutation: AccountingMutationContext, transit = false) => runInTransaction(db, async (client) => {
  const current = (await rows(client, 'SELECT matched_transaction_id FROM lite_cash_entries WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL', [scope.tenantId, entryId]))[0];
  if (!current) throw new Error('LITE_CASH_NOT_FOUND');
  const bankId = transactionId ?? current.matched_transaction_id;
  const bank = bankId ? (await rows(client, "SELECT * FROM transactions WHERE tenant_id=$1 AND id=$2 AND (deleted_at IS NULL OR deleted_at='') FOR UPDATE", [scope.tenantId, bankId]))[0] : undefined;
  const before = (await rows(client, 'SELECT * FROM lite_cash_entries WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE', [scope.tenantId, entryId]))[0]!;
  await assertLitePeriodsOpen(client, scope, [before.cash_date as string, bank?.date as string | undefined]);
  if (transactionId) {
    // A booking without money (Pauschale, AfA, Privatanteil) never has a bank line.
    if (before.payment_method === 'non_cash' || !bank || bank.status !== 'booked' || bank.linked_invoice_id || Math.round(Number(bank.amount) * 100) !== (transit ? -1 : 1) * Number(before.amount_cents) || before.currency !== 'EUR') throw new Error('LITE_CASH_MATCH_INVALID');
    if (before.matched_transaction_id === transactionId) return (await listLiteCashEntries(client, scope)).find((row) => row.id === entryId)!;
    if (before.matched_transaction_id || before.cash_date !== expectedCashDate || (await rows(client, 'SELECT id FROM lite_cash_entries WHERE tenant_id=$1 AND matched_transaction_id=$2', [scope.tenantId, transactionId])).length) throw new Error('LITE_CASH_MATCH_INVALID');
  } else if (before.matched_transaction_id !== (current.matched_transaction_id ?? null)) throw new Error('LITE_CASH_STALE');
  await client.query('UPDATE lite_cash_entries SET matched_transaction_id=$1,updated_at=$2 WHERE tenant_id=$3 AND id=$4', [transactionId ?? null, changedAt(before.updated_at as string), scope.tenantId, entryId]);
  // The bank line is now shown as this entry: its category goes with it instead of being left behind.
  if (transactionId && !transit) await carryLiteEurDecisionInTransaction(client, scope, transactionId, entryId, mutation);
  const after = (await listLiteCashEntries(client, scope)).find((row) => row.id === entryId)!;
  await audit(client, scope, mutation, 'lite_cash_entry', entryId, transactionId ? (transit ? 'lite.cash.match_transit' : 'lite.cash.match') : 'lite.cash.unmatch', before, after);
  return after;
});

export const deleteLiteCashEntry = (db: PostgresQueryable, scope: TenantScope, id: string, expectedUpdatedAt: string, mutation: AccountingMutationContext) => runInTransaction(db, async (client) => {
  const before = (await rows(client, 'SELECT * FROM lite_cash_entries WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE', [scope.tenantId, id]))[0];
  if (!before) throw new Error('LITE_CASH_NOT_FOUND');
  if (before.matched_transaction_id) throw new Error('LITE_CASH_MATCHED');
  if (before.updated_at !== expectedUpdatedAt) throw new Error('LITE_CASH_STALE');
  await assertLitePeriodsOpen(client, scope, [before.cash_date as string]);
  await client.query('UPDATE lite_cash_entries SET deleted_at=$1 WHERE tenant_id=$2 AND id=$3', [changedAt(), scope.tenantId, id]);
  await audit(client, scope, mutation, 'lite_cash_entry', id, 'lite.cash.reverse', before, null);
  return { ok: true as const };
});

const fileMetadata = (row: Record<string, unknown>) => ({ id: String(row.id), receiptId: String(row.receipt_id), fileName: String(row.original_filename), mimeType: String(row.mime_type), byteLength: Number(row.byte_length), sha256: String(row.sha256), createdAt: String(row.created_at) });
export const listLiteReceiptFiles = async (db: PostgresQueryable, scope: TenantScope, receiptId: string) => (await rows(db, 'SELECT id,receipt_id,original_filename,mime_type,byte_length,sha256,created_at FROM lite_receipt_files WHERE tenant_id=$1 AND receipt_id=$2 ORDER BY created_at', [scope.tenantId, receiptId])).map(fileMetadata);
export const getLiteReceiptFile = async (db: PostgresQueryable, scope: TenantScope, id: string) => {
  const row = (await rows(db, 'SELECT * FROM lite_receipt_files WHERE tenant_id=$1 AND id=$2', [scope.tenantId, id]))[0];
  if (!row) throw new Error('LITE_CASH_NOT_FOUND');
  return { ...fileMetadata(row), contentBase64: Buffer.from(row.content_bytes as Uint8Array).toString('base64') };
};
export const uploadLiteReceiptFile = (db: PostgresQueryable, scope: TenantScope, receiptId: string, input: unknown, mutation: AccountingMutationContext) => runInTransaction(db, async (client) => {
  const file = liteReceiptUploadSchema.parse(input);
  const bytes = Buffer.from(file.contentBase64, 'base64');
  if (!bytes.length || bytes.length > 10 * 1024 * 1024 || bytes.toString('base64') !== file.contentBase64 || /[\\/\x00-\x1f]/.test(file.fileName)) throw new Error('LITE_RECEIPT_FILE_INVALID');
  if (file.mimeType === 'application/xml' || file.mimeType === 'text/xml') {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new Error('LITE_RECEIPT_FILE_INVALID'); }
    if (text.includes('\x00') || /<!\s*(DOCTYPE|ENTITY)/i.test(text) || !/^\s*(?:\uFEFF)?\s*</.test(text) || /encoding\s*=\s*['"](?!UTF-8['"])/i.test(text)) throw new Error('LITE_RECEIPT_FILE_INVALID');
  } else { try { assertIncomingInvoiceDocumentContent(file.mimeType, bytes); } catch { throw new Error('LITE_RECEIPT_FILE_INVALID'); } }
  if (!(await rows(client, 'SELECT id FROM lite_receipts WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [scope.tenantId, receiptId])).length) throw new Error('LITE_CASH_NOT_FOUND');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const existing = (await rows(client, 'SELECT * FROM lite_receipt_files WHERE tenant_id=$1 AND receipt_id=$2 AND sha256=$3', [scope.tenantId, receiptId, sha256]))[0];
  if (existing) return fileMetadata(existing);
  if ((await listLiteReceiptFiles(client, scope, receiptId)).length >= 10) throw new Error('LITE_RECEIPT_FILE_LIMIT');
  const saved = (await rows(client, 'INSERT INTO lite_receipt_files (id,tenant_id,receipt_id,original_filename,mime_type,byte_length,sha256,content_bytes,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *', [randomUUID(), scope.tenantId, receiptId, file.fileName, file.mimeType, bytes.length, sha256, bytes, changedAt()]))[0]!;
  const metadata = fileMetadata(saved);
  await audit(client, scope, mutation, 'lite_receipt', receiptId, 'lite.receipt.upload', null, metadata);
  return metadata;
});
