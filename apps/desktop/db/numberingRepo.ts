import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { AppSettings } from '../types';
import { getSettings, setSettings } from './settingsRepo';

export type NumberKind = 'invoice' | 'offer' | 'customer';
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

function toSafeLength(value: number): number {
  if (!Number.isFinite(value)) return 3;
  return Math.max(1, Math.floor(value));
}

function toSafeCounter(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.floor(value));
}

function getCurrentCounter(settings: AppSettings, kind: NumberKind): number {
  if (kind === 'invoice') return settings.numbers.nextInvoiceNumber;
  if (kind === 'offer') return settings.numbers.nextOfferNumber;
  return settings.numbers.nextCustomerNumber;
}

function setCurrentCounter(settings: AppSettings, kind: NumberKind, nextValue: number): void {
  const safeNextValue = toSafeCounter(nextValue);
  if (kind === 'invoice') {
    settings.numbers.nextInvoiceNumber = safeNextValue;
    return;
  }
  if (kind === 'offer') {
    settings.numbers.nextOfferNumber = safeNextValue;
    return;
  }
  settings.numbers.nextCustomerNumber = safeNextValue;
}

export function formatDocumentNumber(
  settings: AppSettings,
  kind: NumberKind,
  counterValue: number,
  now = new Date(),
): string {
  const year = String(now.getFullYear());
  let prefixTemplate = settings.numbers.customerPrefix;
  if (kind === 'invoice') {
    prefixTemplate = settings.numbers.invoicePrefix;
  } else if (kind === 'offer') {
    prefixTemplate = settings.numbers.offerPrefix;
  }

  const prefix = (prefixTemplate || '').replace(/%Y/g, year);
  const safeCounterValue = toSafeCounter(counterValue);
  const lengthSetting = kind === 'customer'
    ? settings.numbers.customerNumberLength
    : settings.numbers.numberLength;
  const length = toSafeLength(lengthSetting);
  return `${prefix}${String(safeCounterValue).padStart(length, '0')}`;
}

export const reserveNumber = (
  db: Database.Database,
  kind: NumberKind,
): { reservationId: string; number: string } => {
  const tx = db.transaction(() => {
    const settings = getSettings(db);
    if (!settings) {
      throw new Error('Settings not found');
    }

    const now = new Date().toISOString();
    const current = toSafeCounter(getCurrentCounter(settings, kind));
    const number = formatDocumentNumber(settings, kind, current);
    setCurrentCounter(settings, kind, current + 1);
    setSettings(db, settings);

    const reservationId = randomUUID();
    db.prepare(
      `
        INSERT INTO number_reservations (
          id, kind, number, counter_value, status, document_id, created_at, updated_at
        ) VALUES (
          @id, @kind, @number, @counterValue, @status, @documentId, @createdAt, @updatedAt
        )
      `,
    ).run({
      id: reservationId,
      kind,
      number,
      counterValue: current,
      status: 'reserved',
      documentId: null,
      createdAt: now,
      updatedAt: now,
    });

    return { reservationId, number };
  });

  return tx();
};

export const releaseNumber = (
  db: Database.Database,
  reservationId: string,
): { ok: true } => {
  const tx = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT id, kind, number, counter_value, status, document_id, created_at, updated_at
         FROM number_reservations
         WHERE id = ?`,
      )
      .get(reservationId) as NumberReservationRow | undefined;

    if (!row || row.status !== 'reserved') {
      return { ok: true } as const;
    }

    const settings = getSettings(db);
    if (!settings) {
      throw new Error('Settings not found');
    }

    const currentCounter = toSafeCounter(getCurrentCounter(settings, row.kind));
    const expectedCurrentCounter = row.counter_value + 1;
    if (currentCounter === expectedCurrentCounter) {
      setCurrentCounter(settings, row.kind, Math.max(1, row.counter_value));
      setSettings(db, settings);
    }

    db.prepare(
      `
        UPDATE number_reservations
        SET status = @status, updated_at = @updatedAt
        WHERE id = @id
      `,
    ).run({
      id: reservationId,
      status: 'released',
      updatedAt: new Date().toISOString(),
    });

    return { ok: true } as const;
  });

  return tx();
};

export const finalizeNumber = (
  db: Database.Database,
  reservationId: string,
  documentId: string,
): { ok: true } => {
  const tx = db.transaction(() => {
    const row = db
      .prepare(
        `SELECT id, kind, number, counter_value, status, document_id, created_at, updated_at
         FROM number_reservations
         WHERE id = ?`,
      )
      .get(reservationId) as NumberReservationRow | undefined;

    if (!row || row.status === 'finalized') {
      return { ok: true } as const;
    }
    if (row.status !== 'reserved') {
      throw new Error(`Cannot finalize reservation in status "${row.status}"`);
    }

    db.prepare(
      `
        UPDATE number_reservations
        SET status = @status, document_id = @documentId, updated_at = @updatedAt
        WHERE id = @id
      `,
    ).run({
      id: reservationId,
      status: 'finalized',
      documentId,
      updatedAt: new Date().toISOString(),
    });

    return { ok: true } as const;
  });

  return tx();
};
