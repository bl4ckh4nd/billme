import type Database from 'better-sqlite3';
import {
  findInvoiceMatches as findSharedInvoiceMatches,
  linkTransactionToInvoice as linkSharedTransaction,
  unlinkTransactionFromInvoice as unlinkSharedTransaction,
  type Transaction,
} from '@billme/desktop-data/transactionsRepo';

export * from '@billme/desktop-data/transactionsRepo';
export const findInvoiceMatches = (db: Database.Database, transaction: Transaction) =>
  findSharedInvoiceMatches(db, transaction, 'pro');
export const linkTransactionToInvoice = (db: Database.Database, transactionId: string, invoiceId: string) =>
  linkSharedTransaction(db, transactionId, invoiceId, 'pro');
export const unlinkTransactionFromInvoice = (db: Database.Database, transactionId: string) => {
  const linked = db.prepare(`SELECT linked_invoice_id FROM transactions WHERE id = ?`).get(transactionId) as { linked_invoice_id: string | null } | undefined;
  if (linked?.linked_invoice_id) {
    const posted = db.prepare(`SELECT accounting_status FROM invoices WHERE id = ?`).get(linked.linked_invoice_id) as { accounting_status: string } | undefined;
    if (posted?.accounting_status === 'posted') {
      throw new Error('Posted payment links require a reversal or correction before unlinking');
    }
  }
  return unlinkSharedTransaction(db, transactionId, 'pro');
};
