import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ReportsView from './ReportsView';

describe('ReportsView drilldown ranges', () => {
  const liveSusaReport = {
    rows: [{ accountNumber: '8400', accountName: 'Erlöse', openingBalance: 0, debitTurnover: 0, creditTurnover: 100, closingBalance: 100, normalBalance: 'credit' as const }],
    totals: { openingDebit: 0, openingCredit: 0, turnoverDebit: 0, turnoverCredit: 100, closingDebit: 0, closingCredit: 100 },
    quality: { unmappedAccounts: 0, warnings: 0, generatedAt: '2026-12-31T00:00:00.000Z', source: 'live' as const },
  };

  it('loads only visible reports and does not require hidden adapter methods', async () => {
    const getSusaReport = vi.fn(async () => liveSusaReport);
    render(<ReportsView dataAdapter={{ getSusaReport }} availableTabs={['susa']} />);

    expect(await screen.findByRole('button', { name: '8400' })).toBeTruthy();
    expect(getSusaReport).toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('fails closed instead of returning a mock when a visible adapter method is missing', async () => {
    render(<ReportsView dataAdapter={{ getSusaReport: vi.fn(async () => liveSusaReport) }} availableTabs={['bwa01']} />);

    expect((await screen.findByRole('alert')).textContent).toContain('BWA01 ist für diese Verbindung nicht verfügbar');
    expect(screen.queryByText('BWA01-Auswertung')).toBeNull();
  });

  it('uses authoritative balance-sheet account references and disables unmapped drilldown', async () => {
    const getReportDrilldownEntries = vi.fn(async () => []);
    const getBalanceSheetPreview = vi.fn(async () => ({
      aktiva: [
        { id: 'asset-1', code: '1000', label: 'Bank', amount: 100, level: 0, side: 'aktiva' as const, accountRefs: ['1000'] },
        { id: 'asset-2', code: 'unmapped', label: 'Nicht zugeordnet', amount: 0, level: 0, side: 'aktiva' as const },
      ],
      passiva: [],
      totals: { aktiva: 100, passiva: 100, difference: 0 },
      quality: { status: 'ok' as const, notes: [], generatedAt: '2026-12-31T00:00:00.000Z', source: 'live' as const },
    }));
    render(<ReportsView dataAdapter={{ getBalanceSheetPreview, getReportDrilldownEntries }} availableTabs={['bilanz']} />);

    const mappedLine = await screen.findByRole('button', { name: /1000 Bank/ });
    const unmappedLine = screen.getByRole('button', { name: /unmapped Nicht zugeordnet/ });
    expect((unmappedLine as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(mappedLine);
    await waitFor(() => expect(getReportDrilldownEntries).toHaveBeenCalledWith(expect.objectContaining({ accountNumbers: ['1000'] })));
  });

  it('renders profile tabs and routes report exports through the adapter', async () => {
    const exportReport = vi.fn(async () => ({ format: 'csv' as const, path: '/tmp/report.csv' }));
    const dataAdapter = {
      getSusaReport: vi.fn(async () => ({ rows: [], totals: { openingDebit: 0, openingCredit: 0, turnoverDebit: 0, turnoverCredit: 0, closingDebit: 0, closingCredit: 0 }, quality: { unmappedAccounts: 0, warnings: 0, generatedAt: '', source: 'live' as const } })),
      getGuvReport: vi.fn(async () => ({ lines: [], totals: { revenue: 0, expenses: 0, result: 0 }, quality: { unmappedAccounts: [], warnings: 0, generatedAt: '', source: 'live' as const } })),
      getBalanceSheetPreview: vi.fn(async () => ({ aktiva: [], passiva: [], totals: { aktiva: 0, passiva: 0, difference: 0 }, quality: { status: 'ok' as const, notes: [], generatedAt: '', source: 'live' as const } })),
      exportReport,
    };
    render(<ReportsView dataAdapter={dataAdapter} profile="management" />);
    expect(await screen.findByRole('button', { name: 'BWA01' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'EÜR' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'CSV' }));
    await waitFor(() => expect(exportReport).toHaveBeenCalledWith(expect.objectContaining({ report: 'susa', format: 'csv' })));
    expect(await screen.findByText(/Export erstellt/)).toBeTruthy();
  });

  it('blocks a report with explicit mapping health failure', async () => {
    const dataAdapter = {
      getSusaReport: vi.fn(async () => ({ rows: [], totals: { openingDebit: 0, openingCredit: 0, turnoverDebit: 0, turnoverCredit: 0, closingDebit: 0, closingCredit: 0 }, quality: { unmappedAccounts: 2, warnings: 0, mappingStatus: 'blocked' as const, generatedAt: '', source: 'live' as const } })),
      getGuvReport: vi.fn(async () => ({ lines: [], totals: { revenue: 0, expenses: 0, result: 0 }, quality: { unmappedAccounts: [], warnings: 0, generatedAt: '', source: 'live' as const } })),
      getBalanceSheetPreview: vi.fn(async () => ({ aktiva: [], passiva: [], totals: { aktiva: 0, passiva: 0, difference: 0 }, quality: { status: 'ok' as const, notes: [], generatedAt: '', source: 'live' as const } })),
    };
    render(<ReportsView dataAdapter={dataAdapter} />);
    expect((await screen.findByRole('alert')).textContent).toContain('Mapping unvollständig');
  });

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
