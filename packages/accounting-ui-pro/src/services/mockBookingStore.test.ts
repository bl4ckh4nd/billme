import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureStoreAdapter,
  configureStorePersistence,
  getBookingDraftByTransactionId,
  resetMockStore,
  saveDraft,
} from './mockBookingStore';

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
});
