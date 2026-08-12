import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ProAccountingWorkspace } from '@billme/accounting-ui-pro';

describe('ProAccountingWorkspace report routing', () => {
  it('keeps incoming invoice sources visible without routing them to the bank inbox', async () => {
    const user = userEvent.setup();
    const adapter = {
      getSusaReport: async () => ({
        rows: [{
          accountNumber: '1400', accountName: 'Debitoren', openingBalance: 0,
          debitTurnover: 119, creditTurnover: 0, closingBalance: 119,
          normalBalance: 'debit' as const, mappedTo: 'receivables', hasWarnings: false,
        }],
        totals: { openingDebit: 0, openingCredit: 0, turnoverDebit: 119, turnoverCredit: 0, closingDebit: 119, closingCredit: 0 },
        quality: { unmappedAccounts: 0, warnings: 0, generatedAt: new Date().toISOString(), source: 'live' as const },
      }),
      getGuvReport: async () => ({
        lines: [], totals: { revenue: 0, expenses: 0, result: 0 },
        quality: { unmappedAccounts: [], warnings: 0, generatedAt: new Date().toISOString(), source: 'live' as const },
      }),
      getBalanceSheetPreview: async () => ({
        aktiva: [], passiva: [], totals: { aktiva: 0, passiva: 0, difference: 0 },
        quality: { status: 'ok' as const, notes: [], generatedAt: new Date().toISOString(), source: 'live' as const },
      }),
      getReportDrilldownEntries: async () => [{
        id: 'incoming-entry:incoming-line', date: '2026-03-02', bookingText: 'Eingangsrechnung',
        journalEntryId: 'incoming-entry', sourceType: 'incoming_invoice' as const, sourceId: 'incoming-42',
        accountNumber: '1400', debit: 119, credit: 0, amount: 119, source: 'Inbox' as const,
      }],
    } as any;

    render(<ProAccountingWorkspace dataAdapter={adapter} />);
    await user.click(screen.getByRole('button', { name: 'Auswertungen' }));
    await waitFor(() => expect(screen.getByText('Summen- und Saldenliste (Preview)')).toBeInTheDocument());
    await user.click(screen.getByText('1400'));
    await waitFor(() => expect(screen.getByTestId('drilldown-source-incoming-entry:incoming-line')).toHaveTextContent('incoming_invoice · incoming-42'));
    expect(screen.queryByRole('button', { name: /Transaktion öffnen|Beleg öffnen|Eingangsrechnung öffnen/i })).toBeNull();
  });
});
