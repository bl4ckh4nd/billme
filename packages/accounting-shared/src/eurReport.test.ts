import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateEurRows } from './eurReport.js';

test('calculateEurRows applies 2025-style signed computed terms and blocks bad classifications', () => {
  const result = calculateEurRows([
    { id: 'income', kennziffer: '112', providerPath: 'income', label: 'Einnahme', kind: 'income', exportable: true, sortOrder: 1 },
    { id: 'expense', kennziffer: '280', providerPath: 'expenses', label: 'Ausgabe', kind: 'expense', exportable: true, sortOrder: 2 },
    { id: 'profit', kennziffer: '290', providerPath: 'income', label: 'Gewinn', kind: 'computed', exportable: true, sortOrder: 3, computedTerms: [{ id: 'income', sign: 1 }, { id: 'expense', sign: -1 }] },
  ], [
    { sourceType: 'invoice', sourceId: 'invoice-1', amountNet: 100, flowType: 'income', lineId: 'income' },
    { sourceType: 'transaction', sourceId: 'bank-1', amountNet: 40, flowType: 'expense', lineId: 'expense' },
    { sourceType: 'transaction', sourceId: 'bank-2', amountNet: 1, flowType: 'expense' },
  ]);
  assert.equal(result.rows.find((row) => row.id === 'profit')?.total, 60);
  assert.equal(result.summary.surplus, 60);
  assert.equal(result.unclassifiedCount, 1);
});
