import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDepreciationSchedule,
  computeAssetDisposal,
  calculateIabLifecycle,
  calculateSpecialDepreciationLifecycle,
} from './depreciation.js';

test('linear AfA is monthly from May and carries the tail into year four', () => {
  const schedule = buildDepreciationSchedule({
    acquisitionCost: 3600,
    activationDate: '2026-05-15',
    assetClass: 'IT-Hardware',
  });

  assert.deepEqual(schedule, [
    { year: 2026, amount: 800, months: 8 },
    { year: 2027, amount: 1200, months: 12 },
    { year: 2028, amount: 1200, months: 12 },
    { year: 2029, amount: 400, months: 4 },
  ]);
});

test('GWG boundary writes off 800.00 but 800.01 uses normal AfA', () => {
  assert.deepEqual(
    buildDepreciationSchedule({
      acquisitionCost: 800,
      activationDate: '2026-05-01',
      assetClass: 'IT-Hardware',
    }),
    [{ year: 2026, amount: 800, months: 12 }],
  );
  assert.equal(
    buildDepreciationSchedule({
      acquisitionCost: 800.01,
      activationDate: '2026-05-01',
      assetClass: 'IT-Hardware',
    }).length,
    4,
  );
});

test('pool depreciation stays five times 20 percent after disposal', () => {
  const input = {
    acquisitionCost: 900,
    activationDate: '2026-05-01',
    assetClass: 'IT-Hardware',
    method: 'pool' as const,
  };
  const before = buildDepreciationSchedule(input);
  computeAssetDisposal({ ...input, disposalDate: '2027-06-15', proceeds: 0 });
  const after = buildDepreciationSchedule(input);

  assert.deepEqual(before.map((period) => period.amount), [180, 180, 180, 180, 180]);
  assert.deepEqual(after, before);
});

test('mid-life disposal calculates residual book value and gain or loss', () => {
  assert.deepEqual(
    computeAssetDisposal({
      acquisitionCost: 4800,
      activationDate: '2024-01-01',
      assetClass: 'IT-Hardware',
      usefulLifeYears: 4,
      disposalDate: '2025-06-30',
      proceeds: 3250,
    }),
    {
      depreciationToDate: 1800,
      residualBookValue: 3000,
      proceeds: 3250,
      gainLoss: 250,
    },
  );
});

test('rounded schedule exactly equals the depreciable base', () => {
  const schedule = buildDepreciationSchedule({
    acquisitionCost: 1000.01,
    activationDate: '2026-05-01',
    assetClass: 'IT-Hardware',
  });
  assert.equal(
    Math.round(schedule.reduce((sum, period) => sum + period.amount, 0) * 100),
    100001,
  );
});

test('§7g IAB lifecycle reports remaining amount and blocks over-allocation', () => {
  assert.deepEqual(
    calculateIabLifecycle({ formedYear: 2026, formedAmount: 1000, usedAmount: 600, repaidAmount: 100, asOfYear: 2027 }),
    { formedAmount: 1000, usedAmount: 600, repaidAmount: 100, remainingAmount: 300, status: 'partially-used' },
  );
  assert.throws(() => calculateIabLifecycle({ formedYear: 2026, formedAmount: 1000, usedAmount: 900, repaidAmount: 200 }));
});

test('§7g special depreciation is capped at 20 percent of eligible cost', () => {
  assert.deepEqual(
    calculateSpecialDepreciationLifecycle({ acquisitionCost: 1000, recognizedAmount: 150, asOfYear: 2026 }),
    { eligibleAmount: 200, recognizedAmount: 150, remainingAmount: 50 },
  );
  assert.throws(() => calculateSpecialDepreciationLifecycle({ acquisitionCost: 1000, recognizedAmount: 201 }));
});
