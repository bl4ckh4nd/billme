import { describe, expect, it } from 'vitest';
import { calculateReconciliationTotals, getBankAccountNumber } from './ReconciliationWorkbench';
import type { BookingDraft } from '../types';

const draft = (counterpartAmount: number): BookingDraft => ({
  id: 'draft-1',
  transactionId: 'tx-1',
  workflowStatus: 'suggested',
  bookingText: 'Test',
  chartFramework: 'SKR03',
  lines: [
    { id: 'bank', accountId: '1200', accountName: 'Bank', type: 'Soll', amount: 100 },
    { id: 'counterpart', accountId: '8400', accountName: 'Erlöse', type: 'Haben', amount: counterpartAmount },
  ],
  validationIssues: [],
  activity: [],
  approval: { required: false, status: 'not_required' },
});

describe('calculateReconciliationTotals', () => {
  it('accepts equal bank and counterpart totals', () => {
    expect(calculateReconciliationTotals(draft(100), 100)).toMatchObject({
      bank: 100,
      counterpart: 100,
      difference: 0,
      bankLineCount: 1,
    });
  });

  it('reports the counterpart difference separately', () => {
    expect(calculateReconciliationTotals(draft(110), 100).difference).toBe(10);
  });

  it('derives the bank account instead of assuming SKR03 1200', () => {
    const skr04Draft = draft(100);
    skr04Draft.lines[0] = { ...skr04Draft.lines[0], accountId: '1800', accountName: 'Bank' };
    expect(getBankAccountNumber(skr04Draft, [{ id: '1800', number: '1800', name: 'Geldtransit', type: 'Asset' }], '1800')).toBe('1800');
    expect(calculateReconciliationTotals(skr04Draft, 100, [{ id: '1800', number: '1800', name: 'Geldtransit', type: 'Asset' }], '1800')).toMatchObject({
      bank: 100,
      counterpart: 100,
      difference: 0,
      bankAccountNumber: '1800',
    });
  });

  it('uses an authoritative custom bank GL even when its name is not a bank heuristic', () => {
    const customDraft = draft(100);
    customDraft.lines[0] = { ...customDraft.lines[0], accountId: '1999', accountName: 'Geldtransit' };
    expect(calculateReconciliationTotals(customDraft, 100, [], '1999')).toMatchObject({
      bank: 100,
      counterpart: 100,
      difference: 0,
      bankAccountNumber: '1999',
    });
  });
});
