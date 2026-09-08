import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import BookingEditor from './BookingEditor';
import { resetMockStore } from '../services/mockBookingStore';

describe('BookingEditor', () => {
  afterEach(() => resetMockStore());

  it('does not expose save for posted bookings and explains the lock', () => {
    render(
      <BookingEditor
        transactionId="tx-4"
        role="admin"
        onBack={() => undefined}
        onStoreChange={() => undefined}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Speichern', exact: true })).toBeNull();
    expect(screen.getByText('Gebuchte Buchungen sind gesperrt. Änderungen sind nur über eine Korrektur möglich.')).toBeTruthy();
  });

  it('labels the shortcut dialog close action', () => {
    render(
      <BookingEditor
        transactionId="tx-1"
        role="admin"
        onBack={() => undefined}
        onStoreChange={() => undefined}
      />,
    );

    fireEvent.keyDown(window, { key: '?' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Schließen (Tastenkürzel-Hilfe)' })).toBeTruthy();
  });
});
