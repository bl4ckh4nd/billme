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
export const unlinkTransactionFromInvoice = (db: Database.Database, transactionId: string) =>
  unlinkSharedTransaction(db, transactionId, 'pro');
