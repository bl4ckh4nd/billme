import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
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
    db.prepare(
      `
        INSERT INTO number_reservations (
          id, kind, number, counter_value, status, document_id, created_at, updated_at
        ) VALUES (
          @id, @kind, @number, @counterValue, @status, @documentId, @createdAt, @updatedAt
        )
      `,
    ).run({
      id: reservation.id,
      kind: reservation.kind,
      number: reservation.number,
      counterValue: reservation.counterValue,
      status: reservation.status,
      documentId: reservation.documentId,
      createdAt: now,
      updatedAt: now,
    });
  },
  getReservationById: (reservationId) => {
    const row = db
      .prepare(
        `SELECT id, kind, number, counter_value, status, document_id, created_at, updated_at
         FROM number_reservations
         WHERE id = ?`,
      )
      .get(reservationId) as NumberReservationRow | undefined;
    return row ? rowToReservation(row) : null;
  },
  updateReservation: (reservation) => {
    db.prepare(
      `
        UPDATE number_reservations
        SET status = @status, document_id = @documentId, updated_at = @updatedAt
        WHERE id = @id
      `,
    ).run({
      id: reservation.id,
      status: reservation.status,
      documentId: reservation.documentId,
      updatedAt: new Date().toISOString(),
    });
  },
  isNumberTaken: (kind, number) => {
    const existingEntity = kind === 'customer'
      ? db.prepare('SELECT 1 FROM clients WHERE customer_number = ? LIMIT 1').get(number)
      : db.prepare(`SELECT 1 FROM ${kind === 'invoice' ? 'invoices' : 'offers'} WHERE number = ? LIMIT 1`).get(number);
    if (existingEntity) return true;

    const existingReservation = db
      .prepare(
        `
          SELECT 1
          FROM number_reservations
          WHERE kind = ?
            AND number = ?
            AND status <> 'released'
          LIMIT 1
        `,
      )
      .get(kind, number) as { 1: number } | undefined;
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
