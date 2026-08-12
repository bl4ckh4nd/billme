import type Database from 'better-sqlite3';
import {
  findInvoiceMatches as findSharedInvoiceMatches,
  linkTransactionToInvoice as linkSharedTransaction,
  type Transaction,
} from '@billme/desktop-data/transactionsRepo';
import { getInvoice, upsertInvoice } from '@billme/desktop-data/invoicesRepo';

export * from '@billme/desktop-data/transactionsRepo';
export const findInvoiceMatches = (db: Database.Database, transaction: Transaction) =>
  findSharedInvoiceMatches(db, transaction, 'pro');
export const linkTransactionToInvoice = (db: Database.Database, transactionId: string, invoiceId: string) => {
  const posted = db.prepare('SELECT accounting_status FROM invoices WHERE id = ?').get(invoiceId) as { accounting_status: string } | undefined;
  if (posted?.accounting_status === 'posted') throw new Error('Posted accounting invoices require OPOS payment allocation');
  return db.transaction(() => {
    const before = new Set((db.prepare('SELECT id FROM invoice_payments WHERE invoice_id = ?').all(invoiceId) as Array<{ id: string }>).map((row) => row.id));
    const result = linkSharedTransaction(db, transactionId, invoiceId, 'pro');
    const payment = (db.prepare('SELECT id FROM invoice_payments WHERE invoice_id = ?').all(invoiceId) as Array<{ id: string }>).find((row) => !before.has(row.id));
    if (!payment) throw new Error('PAYMENT_SOURCE_ID_MISSING');
    db.prepare('UPDATE transactions SET linked_payment_id = ? WHERE id = ?').run(payment.id, transactionId);
    return result;
  })();
};
export const unlinkTransactionFromInvoice = (db: Database.Database, transactionId: string) => {
  const linked = db.prepare(`SELECT linked_invoice_id, linked_payment_id FROM transactions WHERE id = ?`).get(transactionId) as { linked_invoice_id: string | null; linked_payment_id: string | null } | undefined;
  if (linked?.linked_invoice_id) {
    const posted = db.prepare(`SELECT accounting_status FROM invoices WHERE id = ?`).get(linked.linked_invoice_id) as { accounting_status: string } | undefined;
    if (posted?.accounting_status === 'posted') {
      throw new Error('Posted payment links require a reversal or correction before unlinking');
    }
  }
  if (!linked?.linked_invoice_id) throw new Error('Transaction is not linked to any invoice');
  if (!linked.linked_payment_id) throw new Error('EXACT_PAYMENT_SOURCE_REQUIRED');
  const linkedInvoiceId = linked.linked_invoice_id;
  const linkedPaymentId = linked.linked_payment_id;
  return db.transaction(() => {
    const payment = db.prepare('SELECT id, invoice_id FROM invoice_payments WHERE id = ? AND invoice_id = ?').get(linkedPaymentId, linkedInvoiceId) as { id: string; invoice_id: string } | undefined;
    if (!payment) throw new Error('PAYMENT_SOURCE_NOT_FOUND');
    const invoice = getInvoice(db, 'pro', linkedInvoiceId);
    if (!invoice) throw new Error('Invoice not found');
    const updatedPayments = (invoice.payments ?? []).filter((item) => item.id !== payment.id);
    upsertInvoice(db, 'pro', { ...invoice, payments: updatedPayments, status: updatedPayments.length === 0 ? 'open' : invoice.status }, 'Exact transaction payment unlink');
    db.prepare('UPDATE transactions SET linked_invoice_id = NULL, linked_payment_id = NULL WHERE id = ?').run(transactionId);
    return { success: true };
  })();
};
