import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ReportsView from './ReportsView';

describe('ReportsView drilldown ranges', () => {
  it('offers a retry when report loading fails', async () => {
    const getSusaReport = vi.fn()
      .mockRejectedValueOnce(new Error('Berichts-Backend vorübergehend nicht erreichbar'))
      .mockResolvedValue({
        rows: [],
        totals: { openingDebit: 0, openingCredit: 0, turnoverDebit: 0, turnoverCredit: 0, closingDebit: 0, closingCredit: 0 },
        quality: { unmappedAccounts: 0, warnings: 0, generatedAt: '2026-12-31T00:00:00.000Z', source: 'live' as const },
      });
    const dataAdapter = {
      getSusaReport,
      getGuvReport: vi.fn(async () => ({ lines: [], totals: { revenue: 0, expenses: 0, result: 0 }, quality: { unmappedAccounts: [], warnings: 0, generatedAt: '2026-12-31T00:00:00.000Z', source: 'live' as const } })),
      getBalanceSheetPreview: vi.fn(async () => ({ aktiva: [], passiva: [], totals: { aktiva: 0, passiva: 0, difference: 0 }, quality: { status: 'ok' as const, notes: [], generatedAt: '2026-12-31T00:00:00.000Z', source: 'live' as const } })),
    };

    render(<ReportsView dataAdapter={dataAdapter} />);

    expect((await screen.findByRole('alert')).textContent).toContain('vorübergehend');
    fireEvent.click(screen.getByRole('button', { name: 'Erneut versuchen' }));

    await waitFor(() => expect(getSusaReport).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('offers a retry when drilldown loading fails', async () => {
    const getReportDrilldownEntries = vi.fn()
      .mockRejectedValueOnce(new Error('Drilldown-Backend vorübergehend nicht erreichbar'))
      .mockResolvedValueOnce([]);
    const dataAdapter = {
      getSusaReport: vi.fn(async () => ({
        rows: [{ accountNumber: '8400', accountName: 'Erlöse', openingBalance: 0, debitTurnover: 0, creditTurnover: 100, closingBalance: 100, normalBalance: 'credit' as const }],
        totals: { openingDebit: 0, openingCredit: 0, turnoverDebit: 0, turnoverCredit: 100, closingDebit: 0, closingCredit: 100 },
        quality: { unmappedAccounts: 0, warnings: 0, generatedAt: '2026-12-31T00:00:00.000Z', source: 'live' as const },
      })),
      getGuvReport: vi.fn(async () => ({ lines: [], totals: { revenue: 0, expenses: 0, result: 0 }, quality: { unmappedAccounts: [], warnings: 0, generatedAt: '2026-12-31T00:00:00.000Z', source: 'live' as const } })),
      getBalanceSheetPreview: vi.fn(async () => ({ aktiva: [], passiva: [], totals: { aktiva: 0, passiva: 0, difference: 0 }, quality: { status: 'ok' as const, notes: [], generatedAt: '2026-12-31T00:00:00.000Z', source: 'live' as const } })),
      getReportDrilldownEntries,
    };

    render(<ReportsView dataAdapter={dataAdapter} />);
    fireEvent.click(await screen.findByRole('button', { name: '8400' }));

    expect((await screen.findByRole('alert')).textContent).toContain('vorübergehend');
    fireEvent.click(screen.getByRole('button', { name: 'Drilldown erneut versuchen' }));

    await waitFor(() => expect(getReportDrilldownEntries).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  it('passes inclusive December bounds to the drilldown adapter', async () => {
    const getReportDrilldownEntries = vi.fn(async () => []);
    const adapter = {
      getSusaReport: vi.fn(async () => ({
        rows: [{ accountNumber: '8400', accountName: 'Erlöse', openingBalance: 0, debitTurnover: 0, creditTurnover: 100, closingBalance: 100, normalBalance: 'credit' as const }],
        totals: { openingDebit: 0, openingCredit: 0, turnoverDebit: 0, turnoverCredit: 100, closingDebit: 0, closingCredit: 100 },
        quality: { unmappedAccounts: 0, warnings: 0, generatedAt: '2026-12-31T00:00:00.000Z', source: 'live' as const },
      })),
      getGuvReport: vi.fn(async () => ({ lines: [], totals: { revenue: 0, expenses: 0, result: 0 }, quality: { unmappedAccounts: [], warnings: 0, generatedAt: '2026-12-31T00:00:00.000Z', source: 'live' as const } })),
      getBalanceSheetPreview: vi.fn(async () => ({ aktiva: [], passiva: [], totals: { aktiva: 0, passiva: 0, difference: 0 }, quality: { status: 'ok' as const, notes: [], generatedAt: '2026-12-31T00:00:00.000Z', source: 'live' as const } })),
      getReportDrilldownEntries,
    };

    render(<ReportsView dataAdapter={adapter} />);
    await screen.findByRole('button', { name: '8400' });
    fireEvent.change(screen.getByLabelText('Periode von'), { target: { value: '2026-12' } });
    fireEvent.change(screen.getByLabelText('Periode bis'), { target: { value: '2026-12' } });
    fireEvent.click(await screen.findByRole('button', { name: '8400' }));

    await waitFor(() => expect(getReportDrilldownEntries).toHaveBeenCalledWith(expect.objectContaining({
      from: '2026-12-01',
      to: '2026-12-31',
    })));
  });
});
