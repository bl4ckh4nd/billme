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

const PRODUCT = 'lite' as const;

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
  return upsertSharedInvoice(db, PRODUCT, invoice, reason) as Invoice;
};

export const deleteInvoice = (db: Database.Database, id: string, reason: string) => {
  return deleteSharedInvoice(db, PRODUCT, id, reason);
};

export const createInvoiceFromOffer = (
  db: Database.Database,
  offerId: string,
  newInvoiceId: string,
  options?: { invoiceDate?: string; dueDate?: string },
): Invoice => {
  const tx = db.transaction(() => {
    const numberReservation = reserveNumber(db, 'invoice');
    try {
      const paymentTerms = getSettings(db)?.legal?.paymentTermsDays ?? 14;
      const invoiceDate = options?.invoiceDate ?? new Date().toISOString().split('T')[0] ?? '';
      const dueDateStr = (() => {
        if (options?.dueDate) return options.dueDate;
        const d = new Date();
        d.setDate(d.getDate() + paymentTerms);
        return d.toISOString().split('T')[0] ?? '';
      })();

      const invoice = createSharedInvoiceFromOffer(db, PRODUCT, {
        offerId,
        invoiceId: newInvoiceId,
        invoiceNumber: numberReservation.number,
        invoiceDate,
        dueDate: dueDateStr,
      }) as Invoice;

      finalizeNumber(db, numberReservation.reservationId, newInvoiceId);
      return invoice;
    } catch (error) {
      releaseNumber(db, numberReservation.reservationId);
      throw error;
    }
  });

  return tx();
};
