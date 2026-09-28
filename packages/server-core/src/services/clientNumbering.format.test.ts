import assert from 'node:assert/strict';
import test from 'node:test';
import type { NumberingSettingsShape } from '../ports/index.js';
import { formatDocumentNumber } from './clientNumbering.js';

const settings: NumberingSettingsShape = {
  numbers: {
    invoicePrefix: 'RE-%Y-',
    nextInvoiceNumber: 1,
    numberLength: 4,
    offerPrefix: 'ANG-%Y-',
    nextOfferNumber: 1,
    customerPrefix: 'KD-%Y-',
    nextCustomerNumber: 1,
    customerNumberLength: 5,
  },
};
const now = new Date(2026, 5, 15);

test('formatDocumentNumber replaces the year token and zero-pads invoices', () => {
  assert.equal(formatDocumentNumber(settings, 'invoice', 7, now), 'RE-2026-0007');
});

test('formatDocumentNumber pads offers with the shared document length', () => {
  const offerSettings = { numbers: { ...settings.numbers, numberLength: 3 } };
  assert.equal(formatDocumentNumber(offerSettings, 'offer', 42, now), 'ANG-2026-042');
});

test('formatDocumentNumber pads customers with the dedicated customer length', () => {
  assert.equal(formatDocumentNumber(settings, 'customer', 42, now), 'KD-2026-00042');
});

test('formatDocumentNumber falls back to counter 1 when the counter is not finite', () => {
  assert.equal(formatDocumentNumber(settings, 'invoice', Number.NaN, now), 'RE-2026-0001');
});
