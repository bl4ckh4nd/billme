import { BookingDraft, Transaction } from '../types';

export interface BookingPolicy {
  requireReceiptForExpenses: boolean;
}

export const defaultBookingPolicy: BookingPolicy = {
  requireReceiptForExpenses: true,
};

export function requiresReceipt(transaction: Transaction, policy: BookingPolicy): boolean {
  return policy.requireReceiptForExpenses && transaction.amount < 0;
}

export function reviewRequiredForDraft(draft: BookingDraft): boolean {
  const gross = Math.max(
    draft.lines.reduce((sum, line) => sum + (Number(line.amount) || 0), 0),
    0,
  );
  return gross >= 1000 || draft.lines.length > 2;
}

