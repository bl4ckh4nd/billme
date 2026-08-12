import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateBwa01,
  calculateHgbBilanz,
  calculateHgbGuv,
  calculateManagementGuv,
  calculateSusa,
  reconcileEurToLedger,
} from './reporting.js';
import { fiscalYearForDate, fiscalYearRange } from '@billme/accounting-shared';
import type { ReportRequest } from '@billme/accounting-shared';

const mappings = [
  { accountNumber: '1000', statement: 'bilanz' as const, position: 'bank', side: 'asset' as const, label: 'Bank' },
  { accountNumber: '3000', statement: 'bilanz' as const, position: 'equity', side: 'liability' as const, label: 'Eigenkapital' },
  { accountNumber: '4000', statement: ['bwa', 'guv', 'eur'] as const, position: 'materials', label: 'Materialaufwand' },
  { accountNumber: '8000', statement: ['bwa', 'guv', 'eur'] as const, position: 'revenue', label: 'Umsatzerlöse' },
];

const request = (overrides: Partial<ReportRequest> = {}): ReportRequest => ({
  profile: { size: 'small', fiscalYearStart: '07-01', hgbGuvMethod: 'gkv' },
  from: '2025-07-01',
  to: '2025-07-31',
  ledger: {
    entries: [
      { postingDate: '2025-06-30', lines: [{ accountNumber: '1000', debit: 1000, credit: 0 }, { accountNumber: '3000', debit: 0, credit: 1000 }] },
      { postingDate: '2025-07-10', lines: [{ accountNumber: '1000', debit: 1000, credit: 0 }, { accountNumber: '8000', debit: 0, credit: 1000 }] },
      { postingDate: '2025-07-11', lines: [{ accountNumber: '4000', debit: 400, credit: 0 }, { accountNumber: '1000', debit: 0, credit: 400 }] },
    ],
  },
  mappings,
  ...overrides,
});

test('fiscal-year helper uses the start year for non-calendar years', () => {
  assert.equal(fiscalYearForDate('2025-06-30', '07-01'), 2024);
  assert.equal(fiscalYearForDate('2025-07-01', '07-01'), 2025);
  assert.equal(fiscalYearForDate('2025-04-14', '04-15'), 2024);
  assert.equal(fiscalYearForDate('2025-04-15', '04-15'), 2025);
  assert.deepEqual(fiscalYearRange(2025, '07-01'), {
    fiscalYear: 2025,
    start: '2025-07-01',
    end: '2026-06-30',
    label: '2025/2026',
  });
  assert.deepEqual(fiscalYearRange(2025, '04-15'), {
    fiscalYear: 2025,
    start: '2025-04-15',
    end: '2026-04-14',
    label: '2025/2026',
  });
  assert.equal(fiscalYearRange(2023, '03-01').end, '2024-02-29');
  assert.equal(fiscalYearRange(2024, '03-01').end, '2025-02-28');
});

test('SuSa carries opening balances and cent-exact turnover', () => {
  const report = calculateSusa(request());
  assert.deepEqual(report.rows.find((row) => row.accountNumber === '1000'), {
    accountNumber: '1000', openingBalance: 1000, debitTurnover: 1000, creditTurnover: 400,
    closingBalance: 1600, mappedTo: 'bank', label: 'Bank',
  });
  assert.deepEqual(report.totals, { debit: 1400, credit: 1400, balance: 0 });
  assert.equal(report.snapshot.fiscalYear, 2025);
});

test('BWA01, HGB GKV and HGB Bilanz are derived from the same neutral ledger', () => {
  const input = request();
  assert.equal(calculateBwa01(input).totals.operatingResult, 600);
  assert.equal(calculateHgbGuv(input).rows.find((row) => row.position === 'revenue')?.amount, 1000);
  assert.equal(calculateHgbGuv(input).netResult, 600);
  assert.deepEqual(calculateHgbBilanz(input).totals, { assets: 1600, liabilities: 1000, delta: 600 });
});

test('EÜR reconciliation is calendar-year-only and compares cash with ledger', () => {
  assert.throws(() => reconcileEurToLedger(request()), /calendar fiscal year/);
  const report = reconcileEurToLedger(request({
    profile: { size: 'micro', fiscalYearStart: '01-01' },
    from: '2025-01-01', to: '2025-12-31',
    cash: { entries: [
      { id: 'income', date: '2025-07-10', amount: 1000, kind: 'income', accountNumber: '8000' },
      { id: 'expense', date: '2025-07-11', amount: 400, kind: 'expense', accountNumber: '4000' },
    ] },
  }));
  assert.deepEqual(report.differences, { income: 0, expenses: 0, result: 0 });
  assert.deepEqual(report.unmatchedCashEntries, []);
});

test('missing licensed mappings block categorized reports instead of prefix-inference', () => {
  const unmapped = request({
    profile: { size: 'small', fiscalYearStart: '01-01' },
    from: '2025-01-01',
    to: '2025-12-31',
    ledger: { entries: [{ postingDate: '2025-05-01', lines: [
      { accountNumber: '8400', debit: 0, credit: 500 },
      { accountNumber: '1000', debit: 500, credit: 0 },
    ] }] },
    mappings: [],
  });
  const bwa = calculateBwa01(unmapped);
  assert.deepEqual(bwa.mappingHealth.unmappedAccounts, ['1000', '8400']);
  assert.equal(bwa.mappingHealth.inferredAccounts, 0);
  assert.equal(bwa.mappingHealth.blocking, true);
  assert.deepEqual(bwa.rows, []);
  assert.equal(calculateManagementGuv(unmapped).mappingHealth.blocking, true);
  assert.equal(calculateHgbGuv(unmapped).mappingHealth.blocking, true);
  assert.equal(calculateHgbBilanz(unmapped).mappingHealth.blocking, true);
});
