import { describe, expect, it } from 'vitest';
import { createAccountingWorkspaceStore } from './mockBookingStore';
import { mockTransactions } from '../mocks/transactions';

describe('accounting workspace lifetime', () => {
  it('isolates drafts and accounts across instances and delayed failed persistence', async () => {
    let reject!: (error: Error) => void;
    const a = createAccountingWorkspaceStore();
    const b = createAccountingWorkspaceStore();
    const original = b.getBookingDraftByTransactionId('tx-1')!;
    a.configureStorePersistence({ onPersistEntry: () => new Promise((_, fail) => { reject = fail; }) });
    const saving = a.saveDraft({ ...original, bookingText: 'A pending' });
    const failure = expect(saving).rejects.toThrow('offline');
    b.hydrateMockStore({ transactions: [mockTransactions[0]], drafts: [{ ...original, bookingText: 'B current' }], accounts: [] });
    reject(new Error('offline'));
    await failure;
    expect(b.getBookingDraftByTransactionId('tx-1')?.bookingText).toBe('B current');
    expect(b.listAccounts()).toEqual([]);
    expect(a.listAccounts().length).toBeGreaterThan(0);
  });
  it('does not roll back a refreshed seed when an older save fails', async () => {
    let reject!: (error: Error) => void;
    const store = createAccountingWorkspaceStore();
    const original = store.getBookingDraftByTransactionId('tx-1')!;
    store.configureStorePersistence({ onPersistEntry: () => new Promise((_, fail) => { reject = fail; }) });
    const saving = store.saveDraft({ ...original, bookingText: 'pending' });
    const failure = expect(saving).rejects.toThrow();
    store.hydrateMockStore({ transactions: [mockTransactions[0]], drafts: [{ ...original, bookingText: 'refetched' }] });
    reject(new Error('offline'));
    await failure;
    expect(store.getBookingDraftByTransactionId('tx-1')?.bookingText).toBe('refetched');
    store.hydrateMockStore({ transactions: [], drafts: [] });
    expect(store.listTransactions()).toEqual([]);
    expect(store.listDrafts()).toEqual([]);
  });
});
