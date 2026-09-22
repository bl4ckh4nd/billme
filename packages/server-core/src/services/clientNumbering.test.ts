import assert from 'node:assert/strict';
import test from 'node:test';
import type { DocumentNumberReservation, NumberingSettingsShape, SyncDocumentNumberingPorts } from '../ports/index.js';
import { finalizeDocumentNumber, reserveDocumentNumber } from './clientNumbering.js';

interface Fixture {
  ports: SyncDocumentNumberingPorts;
  reservations: Map<string, DocumentNumberReservation>;
}

const createFixture = (): Fixture => {
  const settings: NumberingSettingsShape = {
    numbers: {
      invoicePrefix: 'RE-%Y-',
      nextInvoiceNumber: 1,
      numberLength: 3,
      offerPrefix: 'ANG-%Y-',
      nextOfferNumber: 1,
      customerPrefix: 'K-%Y-',
      nextCustomerNumber: 1,
      customerNumberLength: 3,
    },
  };
  const reservations = new Map<string, DocumentNumberReservation>();
  let nextId = 1;

  const ports: SyncDocumentNumberingPorts = {
    tx: { inTransaction: <T>(work: () => T): T => work() },
    getSettings: () => settings,
    saveSettings: (next) => {
      Object.assign(settings, next);
    },
    createReservation: (reservation) => {
      reservations.set(reservation.id, { ...reservation });
    },
    getReservationById: (reservationId) => reservations.get(reservationId) ?? null,
    updateReservation: (reservation) => {
      reservations.set(reservation.id, { ...reservation });
    },
    isNumberTaken: (_kind, number) =>
      [...reservations.values()].some((reservation) => reservation.number === number),
    generateReservationId: () => `reservation-${nextId++}`,
  };

  return { ports, reservations };
};

test('reserve then finalize marks the reservation finalized for the document', () => {
  const { ports, reservations } = createFixture();
  const { reservationId } = reserveDocumentNumber(ports, 'invoice', new Date('2026-09-04T10:00:00Z'));

  const result = finalizeDocumentNumber(ports, reservationId, 'invoice-1');

  assert.deepEqual(result, { ok: true });
  const row = reservations.get(reservationId);
  assert.ok(row);
  assert.equal(row.status, 'finalized');
  assert.equal(row.documentId, 'invoice-1');
});

test('finalizing the same reservation for the same document stays idempotent', () => {
  const { ports } = createFixture();
  const { reservationId } = reserveDocumentNumber(ports, 'invoice', new Date('2026-09-04T10:00:00Z'));

  assert.deepEqual(finalizeDocumentNumber(ports, reservationId, 'invoice-1'), { ok: true });
  assert.deepEqual(finalizeDocumentNumber(ports, reservationId, 'invoice-1'), { ok: true });
});

test('finalizing a reservation already finalized for another document rejects', () => {
  const { ports } = createFixture();
  const { reservationId } = reserveDocumentNumber(ports, 'invoice', new Date('2026-09-04T10:00:00Z'));

  finalizeDocumentNumber(ports, reservationId, 'invoice-1');

  assert.throws(
    () => finalizeDocumentNumber(ports, reservationId, 'invoice-2'),
    /FINALIZED_RESERVATION_DOCUMENT_MISMATCH/,
  );
});

test('finalizing an unknown reservation stays a no-op success', () => {
  const { ports } = createFixture();

  assert.deepEqual(finalizeDocumentNumber(ports, 'missing', 'invoice-1'), { ok: true });
});
