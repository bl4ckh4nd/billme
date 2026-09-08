import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import ExceptionCenter from './ExceptionCenter';
import { configureStoreAdapter } from '../services/mockBookingStore';
import type { BookingDraft, Transaction } from '../types';

const transaction: Transaction = {
  id: 'exception-1',
  date: '2026-08-01',
  payee: 'Lieferant GmbH',
  description: 'Beleg fehlt',
  amount: -119,
  currency: 'EUR',
  workflowStatus: 'incomplete',
  hasReceipt: false,
  issueCounts: { errors: 0, warnings: 1, infos: 0 },
  flags: ['missing_receipt'],
  bookingDraftId: 'draft-1',
  exceptionCase: { state: 'open' },
};

const draft: BookingDraft = {
  id: 'draft-1',
  transactionId: transaction.id,
  workflowStatus: 'incomplete',
  bookingText: 'Beleg fehlt',
  chartFramework: 'SKR03',
  lines: [],
  validationIssues: [],
  activity: [],
  approval: { required: false, status: 'not_required' },
};

describe('ExceptionCenter', () => {
  afterEach(() => configureStoreAdapter(undefined));

  it('does not claim there are no validation problems while exception markers remain', () => {
    configureStoreAdapter({ getBookingDraftByTransactionId: vi.fn(() => draft) });
    render(
      <ExceptionCenter
        role="admin"
        transactions={[transaction]}
        onOpenTransaction={() => undefined}
        onRefresh={() => undefined}
      />,
    );

    expect(screen.queryByText('Keine aktiven Validierungsprobleme.')).toBeNull();
    expect(screen.getByText(/Aktive Hinweise: Ohne Beleg/)).toBeTruthy();
  });
});
