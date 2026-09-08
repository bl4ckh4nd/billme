import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureStoreAdapter,
  configureStorePersistence,
  dispatchBookingAction,
  getBookingDraftByTransactionId,
  hydrateMockStore,
  resetMockStore,
  saveDraft,
} from './mockBookingStore';
import { mockTransactions } from '../mocks/transactions';

describe('mock booking store persistence', () => {
  beforeEach(() => {
    configureStoreAdapter();
    configureStorePersistence({});
    resetMockStore();
  });

  afterEach(() => {
    configureStorePersistence({});
    configureStoreAdapter();
    resetMockStore();
  });

  it('rolls back a local draft when persistence fails', async () => {
    const original = getBookingDraftByTransactionId('tx-1');
    if (!original) throw new Error('seed draft missing');

    configureStorePersistence({
      onPersistEntry: async () => {
        throw new Error('Persistenz nicht erreichbar');
      },
    });

    await expect(saveDraft({ ...original, bookingText: 'Nicht dauerhaft gespeichert' })).rejects.toThrow(
      'Persistenz nicht erreichbar',
    );
    expect(getBookingDraftByTransactionId('tx-1')).toEqual(original);
  });

  it('awaits an asynchronous adapter mutation instead of cloning its Promise', async () => {
    const original = getBookingDraftByTransactionId('tx-1');
    if (!original) throw new Error('seed draft missing');
    configureStoreAdapter({
      saveDraft: async (draft) => ({ ...draft, bookingText: 'Vom Adapter gespeichert' }),
    });

    await expect(saveDraft(original)).resolves.toEqual(
      expect.objectContaining({ bookingText: 'Vom Adapter gespeichert' }),
    );

    configureStoreAdapter({
      dispatchBookingAction: async () => ({ ...original, workflowStatus: 'approved' }),
    });
    await expect(dispatchBookingAction('tx-1', 'approve', { role: 'admin' })).resolves.toEqual(
      expect.objectContaining({ workflowStatus: 'approved' }),
    );
  });

  it('does not mutate the mock store through a read-only adapter', async () => {
    const original = getBookingDraftByTransactionId('tx-1');
    if (!original) throw new Error('seed draft missing');
    configureStoreAdapter({
      listBookingDrafts: () => [original],
    });

    await expect(saveDraft({ ...original, bookingText: 'Nicht erlaubt' })).rejects.toThrow('READ_ONLY_ACCOUNTING_SOURCE');
    await expect(dispatchBookingAction('tx-1', 'submit_for_review', { role: 'admin' })).rejects.toThrow(
      'READ_ONLY_ACCOUNTING_SOURCE',
    );
    expect(getBookingDraftByTransactionId('tx-1')).toEqual(original);
  });

  it('uses the per-transaction bank GL when hydrating a seed', () => {
    const transaction = { ...mockTransactions[0], id: 'seed-tx', bookingDraftId: 'seed-draft' };
    hydrateMockStore({
      transactions: [transaction],
      accounts: [
        { id: 'bank', number: '1999', name: 'Geldtransit', type: 'Asset' },
        { id: 'expense', number: '7000', name: 'Betriebsbedarf', type: 'Expense' },
      ],
      chartFramework: 'SKR04',
      bankAccountNumberByTransactionId: { 'seed-tx': '1999' },
    });

    expect(getBookingDraftByTransactionId('seed-tx')?.lines).toEqual(
      expect.arrayContaining([expect.objectContaining({ accountId: '1999', accountName: 'Geldtransit' })]),
    );
  });
});
