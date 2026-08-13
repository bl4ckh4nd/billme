import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCarryForward,
  buildFiscalClose,
  buildFxValuation,
  buildInventoryClosingValuation,
  buildJournalCommand,
  buildLoanSchedule,
  buildProvisionCommand,
  planAccrualSchedule,
  reconcileRollForward,
  validatePayrollBatch,
  validateShareholderFlow,
} from './closingDomain.ts';

const fact = (overrides: Record<string, unknown> = {}) => ({
  sourceType: 'standalone_source' as const,
  sourceId: 'bank-1',
  sourceRevision: 'v1',
  effectiveDate: '2026-01-15',
  postingDate: '2026-01-15',
  period: '2026-01',
  fiscalYear: 2026,
  currency: 'EUR',
  bookingText: 'Source posting',
  lines: [
    { accountNumber: '1200', debitAmount: 10, creditAmount: 0 },
    { accountNumber: '8400', debitAmount: 0, creditAmount: 10 },
  ],
  ...overrides,
});

test('source facts produce cent-exact deterministic commands and reject repeats', () => {
  const first = buildJournalCommand(fact());
  assert.equal(first.status, 'ready');
  assert.equal(first.value?.entry.lines[0]?.debitAmount, 10);
  const repeat = buildJournalCommand(fact(), [first.idempotencyKey!]);
  assert.equal(repeat.status, 'duplicate');
  assert.equal(buildJournalCommand(fact({ lines: [{ accountNumber: '1200', debitAmount: 10.001, creditAmount: 0 }] })).status, 'rejected');
});

test('fiscal close clears P&L and carries a profit to retained earnings', () => {
  const result = buildFiscalClose({
    sourceId: 'close-2026', sourceRevision: 'v1', fiscalYear: 2026, period: '2026-12', closingDate: '2026-12-31', currency: 'EUR',
    revenueAccounts: ['8400'], expenseAccounts: ['4900'], retainedEarningsAccount: '0860',
    balances: [
      { accountNumber: '8400', openingBalance: 0, debitTurnover: 0, creditTurnover: 100, closingBalance: -100 },
      { accountNumber: '4900', openingBalance: 0, debitTurnover: 40, creditTurnover: 0, closingBalance: 40 },
    ],
  });
  assert.equal(result.status, 'ready');
  assert.equal(result.value?.netResult, 60);
  assert.equal(result.value?.command.entry.lines.reduce((sum, item) => sum + item.debitAmount, 0), 100);
  assert.equal(result.value?.command.entry.lines.reduce((sum, item) => sum + item.creditAmount, 0), 100);
});

test('carry-forward and roll-forward reconcile exactly', () => {
  const carry = buildCarryForward({
    sourceId: 'carry-2026', sourceRevision: 'v1', effectiveDate: '2027-01-01', period: '2027-01', fiscalYear: 2027, currency: 'EUR',
    balanceSheetAccounts: ['1200', '1800'], openingBalanceAccount: '9000',
    balances: [
      { accountNumber: '1200', openingBalance: 0, debitTurnover: 100, creditTurnover: 0, closingBalance: 100 },
      { accountNumber: '1800', openingBalance: 0, debitTurnover: 0, creditTurnover: 25, closingBalance: -25 },
    ],
  });
  assert.equal(carry.status, 'ready');
  assert.equal(carry.value?.reconciliation.balanced, true);
  assert.equal(reconcileRollForward({
    opening: [{ accountNumber: '1200', openingBalance: 10, debitTurnover: 0, creditTurnover: 0, closingBalance: 10 }],
    movements: [{ accountNumber: '1200', openingBalance: 0, debitTurnover: 5, creditTurnover: 0, closingBalance: 5 }],
    closing: [{ accountNumber: '1200', openingBalance: 0, debitTurnover: 0, creditTurnover: 0, closingBalance: 15 }],
  }).balanced, true);
});

test('provisions, accruals, inventory and FX produce balanced adjustments', () => {
  const provision = buildProvisionCommand({ sourceId: 'p1', sourceRevision: 'v1', effectiveDate: '2026-12-31', period: '2026-12', fiscalYear: 2026, currency: 'EUR', previousAmount: 10, targetAmount: 12.50, expenseAccount: '6700', provisionAccount: '3070' });
  assert.equal(provision.status, 'ready');
  assert.equal(provision.value?.entry.lines[0]?.debitAmount, 2.5);
  const accrual = planAccrualSchedule({ sourceId: 'a1', sourceRevision: 'v1', startDate: '2026-01-15', endDate: '2026-03-20', period: '2026-01', fiscalYear: 2026, currency: 'EUR', totalAmount: 100, expenseAccount: '4900', deferralAccount: '2900' });
  assert.deepEqual(accrual.value?.periods.map((item) => item.amount), [33.34, 33.33, 33.33]);
  const inventory = buildInventoryClosingValuation({ sourceId: 'i1', sourceRevision: 'v1', effectiveDate: '2026-12-31', period: '2026-12', fiscalYear: 2026, currency: 'EUR', items: [{ id: 'sku', quantity: 2, unitCost: 10, unitMarketValue: 8, inventoryAccount: '1140', expenseAccount: '5880' }] });
  assert.equal(inventory.value?.totalWriteDown, 4);
  const fx = buildFxValuation({ sourceId: 'fx1', sourceRevision: 'v1', effectiveDate: '2026-12-31', period: '2026-12', fiscalYear: 2026, foreignCurrency: 'USD', functionalCurrency: 'EUR', foreignAmount: 100, closingRate: 0.95, carryingAmount: 90, position: 'asset', positionAccount: '1200', gainAccount: '4840', lossAccount: '6880' });
  assert.equal(fx.value?.difference, 5);
  assert.equal(fx.value?.command?.entry.lines.reduce((d, item) => d + item.debitAmount, 0), fx.value?.command?.entry.lines.reduce((d, item) => d + item.creditAmount, 0));
});

test('loan schedule closes to zero and payroll validates gross-to-net', () => {
  const loan = buildLoanSchedule({ sourceId: 'l1', sourceRevision: 'v1', startDate: '2026-01-01', period: '2026-01', fiscalYear: 2026, currency: 'EUR', principal: 1000, annualInterestRate: 0, termMonths: 3, liabilityAccount: '4250', interestAccount: '7310', cashAccount: '1200' });
  assert.equal(loan.periods.at(-1)?.closingBalance, 0);
  assert.equal(validatePayrollBatch({ batchId: 'pay-1', sourceRevision: 'v1', effectiveDate: '2026-01-31', period: '2026-01', fiscalYear: 2026, currency: 'EUR', lines: [{ employeeId: 'e1', gross: 1000, employeeTaxes: 200, otherDeductions: 50, net: 750 }] }).status, 'valid');
  assert.equal(validatePayrollBatch({ batchId: 'pay-2', sourceRevision: 'v1', effectiveDate: '2026-01-31', period: '2026-01', fiscalYear: 2026, currency: 'EUR', lines: [{ employeeId: 'e1', gross: 1000, employeeTaxes: 200, otherDeductions: 50, net: 751 }] }).status, 'invalid');
});

test('shareholder flows classify private and related-party risk', () => {
  assert.equal(validateShareholderFlow({ flowId: 's1', shareholderId: 'person-1', companyId: 'co-1', amount: 100, flowType: 'private_withdrawal' }).classification, 'conflict');
  assert.equal(validateShareholderFlow({ flowId: 's2', shareholderId: 'person-1', companyId: 'co-1', amount: 100, flowType: 'loan_to_company' }).classification, 'related_party');
});
