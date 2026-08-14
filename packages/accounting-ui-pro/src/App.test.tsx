import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { JournalEntryEntity } from '@billme/accounting-shared';
import App from './App';

describe('Pro accounting shell', () => {
  it('keeps the accounting tabs reachable without widening the page', () => {
    render(<App />);
    const navigation = screen.getByRole('navigation', { name: 'Buchhaltungsbereiche' });
    expect(navigation.parentElement?.classList.contains('overflow-x-auto')).toBe(true);
    expect(navigation.classList.contains('min-w-max')).toBe(true);
    expect(screen.getByRole('main').classList.contains('min-w-0')).toBe(true);
  });

  it('exposes the active accounting tab to assistive technology', () => {
    render(<App />);
    const inbox = screen.getByRole('button', { name: 'Inbox' });
    const reports = screen.getByRole('button', { name: 'Auswertungen' });

    expect(inbox.getAttribute('aria-current')).toBe('page');
    expect(reports.getAttribute('aria-current')).toBeNull();

    fireEvent.click(reports);

    expect(reports.getAttribute('aria-current')).toBe('page');
    expect(inbox.getAttribute('aria-current')).toBeNull();
  });

  it('keeps Inbox active while a transaction is open in BookingEditor', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: 'Software GmbH öffnen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Erweitern' }));

    expect(screen.getByRole('button', { name: 'Inbox' }).getAttribute('aria-current')).toBe('page');
  });
});

const journalEntry: JournalEntryEntity = {
  id: 'journal-1', tenantId: 'tenant-1', entryNumber: 42, postingDate: '2026-08-14', documentDate: '2026-08-14',
  bookingText: 'Erlöse', reference: 'REF-1', period: '2026-08', fiscalYear: 2026, status: 'posted', sourceType: 'manual',
  createdAt: '2026-08-14T10:00:00.000Z', lines: [
    { id: 'line-1', accountNumber: '8400', debitAmount: 0, creditAmount: 119 },
    { id: 'line-2', accountNumber: '1200', debitAmount: 119, creditAmount: 0 },
  ],
};

describe('ProAccountingWorkspace report journal drilldown', () => {
  it('opens the shared journal detail modal from a report drilldown', async () => {
    const getReportDrilldownEntries = vi.fn(async () => [{
      id: 'drilldown-1', date: '2026-08-14', bookingText: 'Erlöse', reference: 'REF-1', journalEntryId: 'journal-1',
      sourceType: 'journal_entry' as const, sourceId: 'journal-1', accountNumber: '8400', debit: 0, credit: 119, amount: -119, source: 'Manuell' as const,
    }]);
    const getJournalEntryById = vi.fn(async () => journalEntry);
    render(<App dataAdapter={{
      getSusaReport: vi.fn(async () => ({
        rows: [{ accountNumber: '8400', accountName: 'Erlöse', openingBalance: 0, debitTurnover: 0, creditTurnover: 119, closingBalance: 119, normalBalance: 'credit' as const }],
        totals: { openingDebit: 0, openingCredit: 0, turnoverDebit: 0, turnoverCredit: 119, closingDebit: 0, closingCredit: 119 },
        quality: { unmappedAccounts: 0, warnings: 0, generatedAt: '2026-08-14T00:00:00.000Z', source: 'live' as const },
      })),
      getReportDrilldownEntries,
      getJournalEntryById,
    }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Auswertungen' }));
    fireEvent.click(await screen.findByRole('button', { name: '8400' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Journal öffnen' }));

    const dialog = screen.getByRole('dialog', { name: 'Journalbuchung' });
    expect(await within(dialog).findByRole('heading', { name: 'Journal 42' })).toBeTruthy();
    await waitFor(() => expect(getJournalEntryById).toHaveBeenCalledWith('journal-1'));

    fireEvent.click(within(dialog).getByRole('button', { name: 'Journalansicht schließen' }));
    expect(screen.queryByRole('dialog', { name: 'Journalbuchung' })).toBeNull();
  });
});
