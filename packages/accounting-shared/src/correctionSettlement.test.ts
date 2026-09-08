import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateSkontoVatApportionment,
  createLinkedCorrection,
  CorrectionSettlementError,
  calculateBadDebtWriteOff,
  calculateInvoiceSettlement,
  validateUstg17AdjustmentFacts,
} from './correctionSettlement.js';

test('allocates a mixed-rate skonto across 7% and 19% VAT', () => {
  const result = calculateSkontoVatApportionment({
    taxBreakdown: [
      { rate: 7, netAmount: 100, taxAmount: 7 },
      { rate: 19, netAmount: 100, taxAmount: 19 },
    ],
    skontoAmount: 11.9,
  });

  assert.equal(result.discountGrossAmount, 11.9);
  assert.deepEqual(result.byRate, [
    { rate: 7, grossAmount: 5.63, netAmount: 5.26, taxAmount: 0.37 },
    { rate: 19, grossAmount: 6.27, netAmount: 5.27, taxAmount: 1 },
  ]);
  assert.equal(result.discountNetAmount, 10.53);
  assert.equal(result.discountTaxAmount, 1.37);
});

test('calculates a partial skonto from its percentage and keeps cents conserved', () => {
  const result = calculateSkontoVatApportionment({
    taxBreakdown: [{ rate: 19, netAmount: 99.99, taxAmount: 19 }, { rate: 7, netAmount: 10, taxAmount: 0.7 }],
    skontoPercent: 2.5,
  });

  assert.equal(result.discountGrossAmount, 3.24);
  assert.equal(result.byRate.reduce((sum, line) => sum + line.grossAmount, 0), 3.24);
  assert.equal(result.discountGrossAmount, result.discountNetAmount + result.discountTaxAmount);
});

test('returns typed errors for invalid skonto facts', () => {
  assert.throws(
    () => calculateSkontoVatApportionment({
      taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19 }],
      skontoAmount: 120,
    }),
    (error) => error instanceof CorrectionSettlementError && error.code === 'INVALID_AMOUNT',
  );
});

const original = {
  documentId: 'invoice-1',
  documentNumber: 'RE-1',
  revision: 'revision-1',
  snapshotHash: 'hash-1',
  taxEffectiveDate: '2026-01-01',
  taxBreakdown: [
    { rate: 7, netAmount: 100, taxAmount: 7 },
    { rate: 19, netAmount: 100, taxAmount: 19 },
  ],
};

test('links a correction to an immutable original and replays the same idempotency key', () => {
  const first = createLinkedCorrection({
    id: 'correction-1',
    idempotencyKey: 'correction-key-1',
    correctionDate: '2026-02-01',
    original,
    deltas: [{ rate: 19, grossAmount: 11.9 }],
  });
  assert.equal(first.replayed, false);
  assert.equal(first.document.originalSnapshotHash, 'hash-1');
  assert.equal(first.document.grossAmount, -11.9);

  const replay = createLinkedCorrection({
    id: 'ignored-on-replay',
    idempotencyKey: 'correction-key-1',
    correctionDate: '2026-02-01',
    original,
    deltas: [{ rate: 19, grossAmount: 11.9 }],
    existing: [first.document],
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.document.id, 'correction-1');

  assert.throws(
    () => createLinkedCorrection({
      id: 'correction-2',
      idempotencyKey: 'correction-key-1',
      correctionDate: '2026-02-01',
      original,
      deltas: [{ rate: 19, grossAmount: 12 }],
      existing: [first.document],
    }),
    (error) => error instanceof CorrectionSettlementError && error.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('rejects a correction that credits more than the immutable original', () => {
  assert.throws(
    () => createLinkedCorrection({
      id: 'correction-over-credit',
      idempotencyKey: 'correction-over-credit-key',
      correctionDate: '2026-02-01',
      original,
      deltas: [{ rate: 19, grossAmount: 120 }],
    }),
    (error) => error instanceof CorrectionSettlementError && error.code === 'OVER_CREDIT',
  );
});

test('rejects a correction when its live original hash or tax-effective date is stale', () => {
  assert.throws(
    () => createLinkedCorrection({
      id: 'correction-stale-original',
      idempotencyKey: 'correction-stale-original-key',
      correctionDate: '2026-02-01',
      original: { ...original, currentSnapshotHash: 'hash-after-edit' },
      deltas: [{ rate: 19, grossAmount: 1 }],
    }),
    (error) => error instanceof CorrectionSettlementError && error.code === 'ORIGINAL_CHANGED',
  );
  assert.throws(
    () => createLinkedCorrection({
      id: 'correction-stale-tax-date',
      idempotencyKey: 'correction-stale-tax-date-key',
      correctionDate: '2025-12-31',
      original,
      deltas: [{ rate: 19, grossAmount: 1 }],
    }),
    (error) => error instanceof CorrectionSettlementError && error.code === 'TAX_EFFECTIVE_DATE_INVALID',
  );
});

test('validates UStG §17 adjustment facts and preserves the effective date', () => {
  const facts = validateUstg17AdjustmentFacts({
    legalBasis: '§17 UStG',
    reason: 'bad_debt',
    originalDocumentId: 'invoice-1',
    originalDocumentNumber: 'RE-1',
    originalTaxEffectiveDate: '2026-01-01',
    adjustmentDate: '2026-02-01',
    evidenceReference: 'insolvency-file-1',
  });

  assert.equal(facts.legalBasis, '§17 UStG');
  assert.equal(facts.taxEffectiveDate, '2026-02-01');
  assert.throws(
    () => validateUstg17AdjustmentFacts({
      legalBasis: '§17 UStG',
      reason: 'bad_debt',
      originalDocumentId: 'invoice-1',
      originalDocumentNumber: 'RE-1',
      originalTaxEffectiveDate: '2026-01-01',
      adjustmentDate: '2026-02-01',
      evidenceReference: '',
    }),
    (error) => error instanceof CorrectionSettlementError && error.code === 'INVALID_FACTS',
  );
});

test('apportions a partial bad-debt write-off over mixed VAT rates', () => {
  const result = calculateBadDebtWriteOff({
    taxBreakdown: original.taxBreakdown,
    writeOffGrossAmount: 113,
    facts: {
      legalBasis: '§17 UStG',
      reason: 'bad_debt',
      originalDocumentId: 'invoice-1',
      originalDocumentNumber: 'RE-1',
      originalTaxEffectiveDate: '2026-01-01',
      adjustmentDate: '2026-03-01',
      evidenceReference: 'insolvency-file-1',
    },
  });

  assert.equal(result.writeOffGrossAmount, 113);
  assert.deepEqual(result.byRate, [
    { rate: 7, grossAmount: 53.5, netAmount: 50, taxAmount: 3.5 },
    { rate: 19, grossAmount: 59.5, netAmount: 50, taxAmount: 9.5 },
  ]);
  assert.equal(result.writeOffNetAmount, 100);
  assert.equal(result.writeOffTaxAmount, 13);
});

test('settles advances and partial invoices against a final mixed-rate invoice', () => {
  const result = calculateInvoiceSettlement({
    finalInvoice: { taxBreakdown: original.taxBreakdown },
    advances: [{
      id: 'advance-1',
      kind: 'advance',
      taxBreakdown: [
        { rate: 7, netAmount: 50, taxAmount: 3.5 },
        { rate: 19, netAmount: 50, taxAmount: 9.5 },
      ],
    }],
    partialInvoices: [{
      id: 'partial-1',
      kind: 'partial',
      taxBreakdown: [
        { rate: 7, netAmount: 10, taxAmount: 0.7 },
        { rate: 19, netAmount: 20, taxAmount: 3.8 },
      ],
    }],
  });

  assert.equal(result.finalGrossAmount, 226);
  assert.equal(result.settledGrossAmount, 147.5);
  assert.equal(result.dueGrossAmount, 78.5);
  assert.deepEqual(result.dueByRate, [
    { rate: 7, grossAmount: 42.8, netAmount: 40, taxAmount: 2.8 },
    { rate: 19, grossAmount: 35.7, netAmount: 30, taxAmount: 5.7 },
  ]);
});

test('rejects an advance that settles more than the final invoice', () => {
  assert.throws(
    () => calculateInvoiceSettlement({
      finalInvoice: { taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19 }] },
      advances: [{ id: 'advance-over', kind: 'advance', grossAmount: 120 }],
    }),
    (error) => error instanceof CorrectionSettlementError && error.code === 'OVER_CREDIT',
  );
});

test('rejects duplicate advance and partial settlement document ids', () => {
  assert.throws(
    () => calculateInvoiceSettlement({
      finalInvoice: { taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19 }] },
      advances: [{ id: 'settlement-1', kind: 'advance', grossAmount: 1 }],
      partialInvoices: [{ id: 'settlement-1', kind: 'partial', grossAmount: 1 }],
    }),
    (error) => error instanceof CorrectionSettlementError && error.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('rejects a credit that repeats the final invoice id', () => {
  assert.throws(
    () => calculateInvoiceSettlement({
      finalInvoice: { id: 'invoice-final', taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19 }] },
      advances: [{ id: 'invoice-final', kind: 'advance', grossAmount: 1 }],
    }),
    (error) => error instanceof CorrectionSettlementError && error.code === 'IDEMPOTENCY_CONFLICT',
  );
});
