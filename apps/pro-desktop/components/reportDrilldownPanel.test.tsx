import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ReportDrilldownPanel from '../../../packages/accounting-ui-pro/src/components/reports/ReportDrilldownPanel';
import GuvView from '../../../packages/accounting-ui-pro/src/components/reports/GuvView';
import type { GuvReport, ReportDrilldownEntry, ReportDrilldownSelection } from '../../../packages/accounting-ui-pro/src/domain/reportTypes';

const selection: ReportDrilldownSelection = {
  reportType: 'susa',
  targetId: '1200',
  targetLabel: '1200 · Bank',
  accountNumbers: ['1200'],
};

const entry = (sourceType: ReportDrilldownEntry['sourceType'], sourceId: string): ReportDrilldownEntry => ({
  id: `${sourceType}-${sourceId}`,
  date: '2026-03-01',
  bookingText: 'Buchung',
  journalEntryId: 'journal-1',
  sourceType,
  sourceId,
  accountNumber: '1200',
  debit: 100,
  credit: 0,
  amount: 100,
  source: 'Abgleich',
});

describe('ReportDrilldownPanel', () => {
  it('displays source and journal identifiers without a misleading action', () => {
    render(
      <ReportDrilldownPanel
        selection={selection}
        entries={[entry('invoice', 'invoice-42')]}
        onClose={vi.fn()}
      />,
    );

    const source = screen.getByTestId('drilldown-source-invoice-invoice-42');
    expect(source).toHaveTextContent('invoice · invoice-42');
    expect(source).toHaveTextContent('journal-1');
    expect(screen.queryByRole('button', { name: /öffnen/i })).toBeNull();
  });

  it('does not route incoming invoices to the bank inbox when no invoice UI exists', () => {
    render(
      <ReportDrilldownPanel
        selection={selection}
        entries={[entry('incoming_invoice', 'incoming-42')]}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('drilldown-source-incoming_invoice-incoming-42')).toHaveTextContent('incoming_invoice · incoming-42');
    expect(screen.queryByRole('button', { name: /Transaktion öffnen|Beleg öffnen|Eingangsrechnung öffnen/i })).toBeNull();
  });

  it('routes only a bank source to the transaction handler', async () => {
    const onOpenTransaction = vi.fn();
    const user = userEvent.setup();
    render(
      <ReportDrilldownPanel
        selection={selection}
        entries={[entry('bank_transaction', 'bank-42')]}
        onClose={vi.fn()}
        onOpenTransaction={onOpenTransaction}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Transaktion öffnen' }));
    expect(onOpenTransaction).toHaveBeenCalledWith('bank-42');
  });

  it('shows exact GuV unmapped account identities in the warning panel', () => {
    const report: GuvReport = {
      lines: [],
      totals: { revenue: 0, expenses: 0, result: 0 },
      quality: {
        unmappedAccounts: [{ accountNumber: '9999', amount: -12.5 }],
        warnings: 1,
        generatedAt: '2026-03-31T00:00:00.000Z',
        source: 'live',
      },
    };

    render(<GuvView report={report} compareMode="none" onSelectLine={vi.fn()} />);

    expect(screen.getByTestId('guv-unmapped-accounts')).toHaveTextContent('Konto 9999');
    expect(screen.getByTestId('guv-unmapped-accounts')).toHaveTextContent('12,50');
  });
});
