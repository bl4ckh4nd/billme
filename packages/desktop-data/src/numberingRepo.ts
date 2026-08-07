import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { and, eq, ne } from 'drizzle-orm';
import {
  finalizeDocumentNumber,
  formatDocumentNumber as formatSharedDocumentNumber,
  releaseDocumentNumber,
  reserveDocumentNumber,
} from '@billme/server-core/services';
import type {
  DocumentNumberKind,
  DocumentNumberReservation,
  SyncDocumentNumberingPorts,
} from '@billme/server-core/ports';
import type { AppSettings } from '@billme/desktop-core/types';
import { getSettings, setSettings } from './settingsRepo';
import { createDrizzle, schema } from './drizzle';

export type NumberKind = DocumentNumberKind;
type ReservationStatus = 'reserved' | 'released' | 'finalized';

type NumberReservationRow = {
  id: string;
  kind: NumberKind;
  number: string;
  counter_value: number;
  status: ReservationStatus;
  document_id: string | null;
  created_at: string;
  updated_at: string;
};

const rowToReservation = (row: NumberReservationRow): DocumentNumberReservation => ({
  id: row.id,
  kind: row.kind,
  number: row.number,
  counterValue: row.counter_value,
  status: row.status,
  documentId: row.document_id,
});

const createDocumentNumberingPorts = (db: Database.Database): SyncDocumentNumberingPorts<AppSettings> => ({
  tx: {
    inTransaction<TResult>(work: () => TResult): TResult {
      return db.transaction(work)();
    },
  },
  getSettings: () => getSettings(db),
  saveSettings: (settings) => setSettings(db, settings),
  createReservation: (reservation) => {
    const now = new Date().toISOString();
    createDrizzle(db).insert(schema.numberReservations).values({
      id: reservation.id,
      kind: reservation.kind,
      number: reservation.number,
      counterValue: reservation.counterValue,
      status: reservation.status,
      documentId: reservation.documentId,
      createdAt: now,
      updatedAt: now,
    }).run();
  },
  getReservationById: (reservationId) => {
    const row = createDrizzle(db).select({
      id: schema.numberReservations.id,
      kind: schema.numberReservations.kind,
      number: schema.numberReservations.number,
      counter_value: schema.numberReservations.counterValue,
      status: schema.numberReservations.status,
      document_id: schema.numberReservations.documentId,
      created_at: schema.numberReservations.createdAt,
      updated_at: schema.numberReservations.updatedAt,
    }).from(schema.numberReservations).where(eq(schema.numberReservations.id, reservationId)).get() as NumberReservationRow | undefined;
    return row ? rowToReservation(row) : null;
  },
  updateReservation: (reservation) => {
    createDrizzle(db).update(schema.numberReservations).set({
      status: reservation.status,
      documentId: reservation.documentId,
      updatedAt: new Date().toISOString(),
    }).where(eq(schema.numberReservations.id, reservation.id)).run();
  },
  isNumberTaken: (kind, number) => {
    const drizzle = createDrizzle(db);
    const existingEntity = kind === 'customer'
      ? drizzle.select({ id: schema.clients.id }).from(schema.clients).where(eq(schema.clients.customerNumber, number)).limit(1).get()
      : kind === 'invoice'
        ? drizzle.select({ id: schema.invoices.id }).from(schema.invoices).where(eq(schema.invoices.number, number)).limit(1).get()
        : drizzle.select({ id: schema.offers.id }).from(schema.offers).where(eq(schema.offers.number, number)).limit(1).get();
    if (existingEntity) return true;

    const existingReservation = drizzle.select({ id: schema.numberReservations.id })
      .from(schema.numberReservations).where(and(
        eq(schema.numberReservations.kind, kind),
        eq(schema.numberReservations.number, number),
        ne(schema.numberReservations.status, 'released'),
      )).limit(1).get();
    return Boolean(existingReservation);
  },
  generateReservationId: () => randomUUID(),
});

export function formatDocumentNumber(
  settings: AppSettings,
  kind: NumberKind,
  counterValue: number,
  now = new Date(),
): string {
  return formatSharedDocumentNumber(settings, kind, counterValue, now);
}

export const reserveNumber = (
  db: Database.Database,
  kind: NumberKind,
): { reservationId: string; number: string } => {
  return reserveDocumentNumber(createDocumentNumberingPorts(db), kind);
};

export const releaseNumber = (
  db: Database.Database,
  reservationId: string,
): { ok: true } => {
  return releaseDocumentNumber(createDocumentNumberingPorts(db), reservationId);
};

export const finalizeNumber = (
  db: Database.Database,
  reservationId: string,
  documentId: string,
): { ok: true } => {
  return finalizeDocumentNumber(createDocumentNumberingPorts(db), reservationId, documentId);
};
