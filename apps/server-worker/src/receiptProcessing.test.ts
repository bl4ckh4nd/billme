import assert from 'node:assert/strict';
import test from 'node:test';
import { extractReceiptSuggestion, normalizeReceiptDate } from './receiptProcessing.js';

test('extractReceiptSuggestion reads German receipt totals without posting them', () => {
  const result = extractReceiptSuggestion(`
    Muster Bürobedarf GmbH
    Rechnung Nr. RE-2026-4711
    Datum 12.07.2026
    Netto 100,00 EUR
    MwSt. 19,00 EUR
    Gesamtbetrag 119,00 EUR
  `, '4930');
  assert.equal(result.merchant.value, 'Muster Bürobedarf GmbH');
  assert.equal(result.invoiceNumber.value, 'RE-2026-4711');
  assert.equal(result.date.value, '2026-07-12');
  assert.equal(result.netAmount.value, 100);
  assert.equal(result.vatAmount.value, 19);
  assert.equal(result.grossAmount.value, 119);
  assert.equal(result.suggestedAccountNumber?.value, '4930');
});

test('normalizeReceiptDate rejects impossible dates', () => {
  assert.equal(normalizeReceiptDate('12.07.2026'), '2026-07-12');
  assert.equal(normalizeReceiptDate('2026-07-12'), '2026-07-12');
  assert.equal(normalizeReceiptDate('31.02.2026'), null);
});
