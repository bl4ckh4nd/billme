import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import InboxView from './InboxView';
import { mockTransactions } from '../mocks/transactions';
import { configureStoreAdapter, configureStorePersistence, resetMockStore } from '../services/mockBookingStore';

describe('InboxView bulk actions', () => {
  beforeEach(() => {
    configureStoreAdapter();
    configureStorePersistence({});
    resetMockStore();
  });

  it('skips an invalid first row and still processes the next valid row', async () => {
    const onRefresh = vi.fn();
    render(
      <InboxView
        role="admin"
        transactions={mockTransactions.slice(0, 2)}
        onOpenTransaction={vi.fn()}
        onRefresh={onRefresh}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Sichtbare markieren' }));
    fireEvent.click(screen.getByRole('button', { name: 'Freigeben' }));

    await waitFor(() => {
      expect(screen.getByText(/1 erfolgreich, 1 übersprungen/)).toBeTruthy();
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
