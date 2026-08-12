import type Database from 'better-sqlite3';
import type { Invoice } from '../types';
import {
  createInvoiceFromOffer as createSharedInvoiceFromOffer,
  deleteInvoice as deleteSharedInvoice,
  getInvoice as getSharedInvoice,
  listInvoices as listSharedInvoices,
  upsertInvoice as upsertSharedInvoice,
} from '@billme/desktop-data/invoicesRepo';
import { finalizeNumber, releaseNumber, reserveNumber } from './numberingRepo';
import { getSettings } from './settingsRepo';
import { postOutgoingInvoice } from './oposRepo';
import { createProTenantScope, resolveRuntimeProTenantScope } from '../tenantScope';

const PRODUCT = 'pro' as const;

export const listInvoices = (db: Database.Database): Invoice[] => {
  return listSharedInvoices(db, PRODUCT) as Invoice[];
};

export const getInvoice = (db: Database.Database, id: string): Invoice | null => {
  return getSharedInvoice(db, PRODUCT, id) as Invoice | null;
};

export const upsertInvoice = (
  db: Database.Database,
  invoice: Invoice,
  reason: string,
): Invoice => {
  const scope = resolveRuntimeProTenantScope();
  if (scope.tenantId !== 'default') throw new Error('DESKTOP_SINGLE_TENANT_ONLY');
  const before = getSharedInvoice(db, PRODUCT, invoice.id) as Invoice | null;
  const accounting = db.prepare('SELECT accounting_status FROM invoices WHERE id = ?').get(invoice.id) as { accounting_status: string } | undefined;
  if (accounting?.accounting_status === 'posted' && before) {
    const immutableSame = JSON.stringify({ number: before.number, date: before.date, dueDate: before.dueDate, amount: before.amount, taxSnapshot: before.taxSnapshot, items: before.items }) === JSON.stringify({ number: invoice.number, date: invoice.date, dueDate: invoice.dueDate, amount: invoice.amount, taxSnapshot: invoice.taxSnapshot, items: invoice.items });
    if (!immutableSame) throw new Error('POSTED_DOCUMENT_IMMUTABLE');
    // The repository intentionally does not re-save posted line items.  This
    // keeps ordinary UI refetch/save idempotent while DB triggers protect the
    // accounting artifact. Payment status remains the projection owner.
    return before;
  }
  const finalize = before?.status === 'draft' && invoice.status === 'open';
  if (finalize) {
    const reservation = db.prepare(`SELECT id FROM number_reservations
      WHERE kind = 'invoice' AND status = 'finalized' AND document_id = ? AND number = ?`).get(invoice.id, invoice.number) as { id: string } | undefined;
    if (!reservation) throw new Error('NUMBER_FINALIZATION_REQUIRED');
  }
  return db.transaction(() => {
    const saved = upsertSharedInvoice(db, PRODUCT, invoice, reason) as Invoice;
    if (finalize) {
      const result = postOutgoingInvoice(db, scope, invoice.id);
      if (result.status !== 'ready') throw new Error(`ACCOUNTING_UNRESOLVED:${result.issues[0]?.code ?? 'unknown'}`);
    }
    return saved;
  })();
};

/** Number finalization and accounting posting are one SQLite transaction. */
export const finalizeOutgoingInvoice = (db: Database.Database, reservationId: string, documentId: string): { ok: true } => db.transaction(() => {
  finalizeNumber(db, reservationId, documentId);
  const result = postOutgoingInvoice(db, createProTenantScope('default'), documentId);
  if (result.status !== 'ready') throw new Error(`ACCOUNTING_UNRESOLVED:${result.issues[0]?.code ?? 'unknown'}`);
  return { ok: true as const };
})();

export const deleteInvoice = (db: Database.Database, id: string, reason: string) => {
  return deleteSharedInvoice(db, PRODUCT, id, reason);
};

export const createInvoiceFromOffer = (
  db: Database.Database,
  offerId: string,
  newInvoiceId: string,
): Invoice => {
  const tx = db.transaction(() => {
    const numberReservation = reserveNumber(db, 'invoice');
    try {
      const paymentTerms = getSettings(db)?.legal?.paymentTermsDays || 14;
      const invoiceDate = new Date().toISOString().split('T')[0] ?? '';
      const dueDate = new Date();
      dueDate.setDate(dueDate.getDate() + paymentTerms);
      const dueDateStr = dueDate.toISOString().split('T')[0] ?? '';

      const invoice = createSharedInvoiceFromOffer(db, PRODUCT, {
        offerId,
        invoiceId: newInvoiceId,
        invoiceNumber: numberReservation.number,
        invoiceDate,
        dueDate: dueDateStr,
      }) as Invoice;

      finalizeNumber(db, numberReservation.reservationId, newInvoiceId);
      const posted = postOutgoingInvoice(db, createProTenantScope('default'), newInvoiceId);
      if (posted.status !== 'ready') throw new Error(`ACCOUNTING_UNRESOLVED:${posted.issues[0]?.code ?? 'unknown'}`);
      return invoice;
    } catch (error) {
      releaseNumber(db, numberReservation.reservationId);
      throw error;
    }
  });

  return tx();
};
