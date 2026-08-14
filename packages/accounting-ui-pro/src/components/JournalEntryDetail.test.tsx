import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { JournalEntryEntity } from '@billme/accounting-shared';
import JournalEntryDetail from './JournalEntryDetail';

const entry: JournalEntryEntity = {
  id: 'journal-1',
  tenantId: 'tenant-1',
  entryNumber: 42,
  postingDate: '2026-08-14',
  documentDate: '2026-08-13',
  bookingText: 'Büromaterial',
  reference: 'BELEG-42',
  period: '2026-08',
  fiscalYear: 2026,
  status: 'posted',
  sourceType: 'manual',
  createdAt: '2026-08-14T10:00:00.000Z',
  lines: [
    { id: 'line-1', accountNumber: '4900', debitAmount: 119, creditAmount: 0 },
    { id: 'line-2', accountNumber: '1200', debitAmount: 0, creditAmount: 119 },
  ],
};

describe('JournalEntryDetail', () => {
  it('loads a journal entry and renders human-readable debit and credit lines', async () => {
    const getJournalEntryById = vi.fn(async () => entry);

    render(<JournalEntryDetail entryId="journal-1" dataAdapter={{ getJournalEntryById }} />);

    expect(screen.getByRole('status').textContent).toContain('Journal wird geladen');
    expect(await screen.findByRole('heading', { name: /Journal 42/ })).toBeTruthy();
    expect(screen.getByText('Soll · Konto 4900')).toBeTruthy();
    expect(screen.getByText('Haben · Konto 1200')).toBeTruthy();
    expect(screen.getAllByText((value) => value.includes('119,00')).length).toBe(2);
    expect(getJournalEntryById).toHaveBeenCalledWith('journal-1');
  });

  it('shows an explicit not-found state', async () => {
    render(<JournalEntryDetail entryId="missing" dataAdapter={{ getJournalEntryById: vi.fn(async () => null) }} />);

    expect((await screen.findByRole('status')).textContent).toContain('Journalbuchung nicht gefunden');
  });

  it('shows adapter errors and retries the same journal id', async () => {
    const getJournalEntryById = vi.fn()
      .mockRejectedValueOnce(new Error('Journal-Backend nicht erreichbar'))
      .mockResolvedValueOnce(entry);

    render(<JournalEntryDetail entryId="journal-1" dataAdapter={{ getJournalEntryById }} />);

    expect((await screen.findByRole('alert')).textContent).toContain('Journal-Backend nicht erreichbar');
    await waitFor(() => expect(getJournalEntryById).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));

    expect(await screen.findByRole('heading', { name: /Journal 42/ })).toBeTruthy();
    expect(getJournalEntryById).toHaveBeenCalledTimes(2);
  });
});
