import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateEurAnnexValues,
  calculateEurRows,
  type EurAnnexValueLine,
} from './eurReport.js';

const lines = [
  { id: 'income', label: 'Income', kind: 'income' as const, exportable: true, sortOrder: 1 },
  { id: 'expense', label: 'Expense', kind: 'expense' as const, exportable: true, sortOrder: 2 },
];

test('EÜR cash timing excludes items outside the requested calendar year', () => {
  const result = calculateEurRows(lines, [
    { sourceType: 'invoice', sourceId: 'in', amountNet: 100, flowType: 'income', lineId: 'income', cashDate: '2026-01-02' },
    { sourceType: 'invoice', sourceId: 'out', amountNet: 50, flowType: 'income', lineId: 'income', cashDate: '2025-12-31' },
  ], { taxYear: 2026, requireCashDate: true });

  assert.equal(result.summary.incomeTotal, 100);
});

test('EÜR split classifications reconcile cents and remain auditable', () => {
  const result = calculateEurRows(lines, [{
    sourceType: 'transaction',
    sourceId: 'split-1',
    amountNet: 100,
    flowType: 'expense',
    splits: [
      { amountNet: 60, deductibility: 'deductible', lineId: 'expense', reason: 'business use' },
      { amountNet: 40, deductibility: 'non-deductible', reason: 'private use' },
    ],
  }]);

  assert.equal(result.summary.expenseTotal, 60);
  assert.equal(result.deductibility?.nonDeductibleExpenseTotal, 40);
  assert.equal(result.splitClassifications?.[0]?.splits[1]?.reason, 'private use');
  assert.throws(() => calculateEurRows(lines, [{
    sourceType: 'transaction', sourceId: 'bad', amountNet: 100, flowType: 'expense',
    splits: [{ amountNet: 99.99, deductibility: 'deductible', lineId: 'expense', reason: 'short' }],
  }]));
});

test('private and pass-through items stay neutral while facts remain typed', () => {
  const result = calculateEurRows(lines, [
    { sourceType: 'draw', sourceId: 'p1', amountNet: 25, kind: 'private-withdrawal' },
    { sourceType: 'contribution', sourceId: 'p2', amountNet: 10, kind: 'private-contribution' },
    { sourceType: 'escrow', sourceId: 'p3', amountNet: 40, kind: 'pass-through', flowType: 'income' },
  ]);

  assert.deepEqual(result.summary, { incomeTotal: 0, expenseTotal: 0, surplus: 0 });
  assert.equal(result.privateWithdrawals, 25);
  assert.equal(result.privateContributions, 10);
  assert.equal(result.passThroughTotal, 40);
});

test('annex values resolve computed totals and reject incomplete facts when requested', () => {
  const annexLines: EurAnnexValueLine[] = [
    { id: 'opening', kind: 'input', computedFromIds: undefined },
    { id: 'additions', kind: 'input' },
    { id: 'closing', kind: 'computed', computedTerms: [{ id: 'opening', sign: 1 }, { id: 'additions', sign: 1 }] },
  ];
  const result = calculateEurAnnexValues(annexLines, [
    { lineId: 'opening', amount: 100, sourceId: 'asset-1' },
    { lineId: 'additions', amount: 50, sourceId: 'asset-2' },
  ], { totalLineId: 'closing' });

  assert.equal(result.values.closing, 150);
  assert.equal(result.total, 150);
  assert.throws(() => calculateEurAnnexValues(annexLines, [{ lineId: 'opening', amount: 100 }], { requiredLineIds: ['opening', 'additions'] }));
});
