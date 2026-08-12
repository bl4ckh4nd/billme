import React from 'react';
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

  it('blocks a balance sheet with mapping health and shows affected account IDs', async () => {
    const getReportDrilldownEntries = vi.fn(async () => []);
    const getBalanceSheetPreview = vi.fn(async () => ({
      aktiva: [{ id: 'asset-1', code: '1200', label: 'Bank', amount: 100, level: 0, side: 'aktiva' as const, accountRefs: ['1200'] }],
      passiva: [],
      totals: { aktiva: 100, passiva: 100, difference: 0 },
      quality: {
        status: 'error' as const,
        notes: ['Konto 1200 ist nicht zugeordnet.'],
        generatedAt: '2025-12-31T00:00:00.000Z',
        source: 'live' as const,
        mappingStatus: 'blocked' as const,
        unmappedAccounts: [{ accountNumber: '1200', amount: 100 }],
      },
    }));
    render(<ReportsView dataAdapter={{ getBalanceSheetPreview, getReportDrilldownEntries }} availableTabs={['bilanz']} />);

    const block = await screen.findByRole('alert');
    expect(block.textContent).toContain('Mapping-Health: blockierend');
    expect(block.textContent).toContain('Betroffene Konten: 1200');
    expect(screen.queryByRole('button', { name: /1200 Bank/ })).toBeNull();
    expect(getReportDrilldownEntries).not.toHaveBeenCalled();
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

  it('freezes only an EÜR-2025 report with an explicit audit reason', async () => {
    const saveReportSnapshot = vi.fn(async () => ({ id: 'snapshot-1', reportType: 'eur', args: {}, payload: {}, createdAt: '2025-12-31T23:00:00.000Z', sourceHash: 'a'.repeat(64) }));
    const getEurReport = vi.fn(async () => ({
      lines: [],
      totals: { revenue: 10, expenses: 2, result: 8 },
      quality: { unmappedAccounts: [], warnings: 0, generatedAt: '', source: 'live' as const },
      filing: {
        kind: 'euer' as const,
        taxYear: 2025,
        catalog: { id: 'anlage-euer-2025', version: 'BMF-2025-2025-08-29', sourceHash: 'b'.repeat(64), delivery: 'print-form-only' as const, elsterReady: false },
        lineProvenance: [{ lineId: 'E2025_KZ111', kennziffer: '111', providerPath: 'income', exportable: true }],
      },
    }));
    render(<ReportsView dataAdapter={{ getEurReport, saveReportSnapshot }} availableTabs={['eur']} />);

    await screen.findByText('Einnahmenüberschussrechnung');
    fireEvent.change(screen.getByLabelText('Periode von'), { target: { value: '2025-01' } });
    fireEvent.change(screen.getByLabelText('Periode bis'), { target: { value: '2025-12' } });
    fireEvent.change(screen.getByLabelText('Audit-Grund für EÜR-Snapshot'), { target: { value: 'Abschlussprüfung EÜR 2025' } });
    const freezeButton = await screen.findByRole('button', { name: 'Snapshot einfrieren' });
    await waitFor(() => expect(freezeButton).not.toHaveProperty('disabled', true));
    fireEvent.click(freezeButton);

    await waitFor(() => expect(saveReportSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      reportType: 'eur',
      reason: 'Abschlussprüfung EÜR 2025',
      args: expect.objectContaining({ periodFrom: '2025-01', periodTo: '2025-12' }),
    })));
  });

  it('locks native EÜR filters to 2025 and never requests a 2026 range', async () => {
    const getEurReport = vi.fn(async (filters) => ({
      lines: [],
      totals: { revenue: 0, expenses: 0, result: 0 },
      quality: { unmappedAccounts: [], warnings: 0, generatedAt: '', source: 'live' as const },
      filing: {
        kind: 'euer' as const,
        taxYear: 2025,
        catalog: { id: 'anlage-euer-2025', version: '2025', sourceHash: 'b'.repeat(64), delivery: 'print-form-only' as const, elsterReady: false },
        lineProvenance: [{ lineId: 'E2025_KZ111', kennziffer: '111', providerPath: 'income', exportable: true }],
      },
    }));
    render(<ReportsView dataAdapter={{ getEurReport }} availableTabs={['eur']} />);

    expect(await screen.findByText(/nur für das Druckformular 2025 verfügbar/)).toBeTruthy();
    expect((screen.getByLabelText('Stichtag') as HTMLInputElement).value).toBe('2025-12-31');
    expect((screen.getByLabelText('Periode von') as HTMLInputElement).value).toBe('2025-01');
    expect((screen.getByLabelText('Periode bis') as HTMLInputElement).value).toBe('2025-12');
    expect((screen.getByLabelText('Stichtag') as HTMLInputElement).disabled).toBe(true);
    expect(getEurReport).toHaveBeenCalledWith(expect.objectContaining({
      asOfDate: '2025-12-31',
      periodFromDate: '2025-01-01',
      periodToDate: '2025-12-31',
    }));
  });

  it('keeps sole-proprietor SuSa, BWA01, and Management-GuV on the visible calendar year', async () => {
    const year = new Date().getUTCFullYear();
    const getSusaReport = vi.fn(async () => ({
      rows: [],
      totals: { openingDebit: 0, openingCredit: 0, turnoverDebit: 0, turnoverCredit: 0, closingDebit: 0, closingCredit: 0 },
      quality: { unmappedAccounts: 0, warnings: 0, generatedAt: '', source: 'live' as const },
    }));
    const guvReport = {
      lines: [],
      totals: { revenue: 0, expenses: 0, result: 0 },
      quality: { unmappedAccounts: [], warnings: 0, generatedAt: '', source: 'live' as const },
    };
    const getBwaReport = vi.fn(async () => guvReport);
    const getManagementGuvReport = vi.fn(async () => guvReport);
    render(<ReportsView
      businessReportingProfile={{ legalForm: 'sole_proprietor', profitDetermination: 'eur', fiscalYearStart: '01-01' }}
      dataAdapter={{ getSusaReport, getBwaReport, getManagementGuvReport }}
      availableTabs={['susa', 'bwa01', 'management_guv']}
    />);

    await screen.findByText('Summen- und Saldenliste');
    const expectedRange = {
      asOfDate: expect.stringMatching(new RegExp(`^${year}-\\d{2}-\\d{2}$`)),
      periodFromDate: `${year}-01-01`,
      periodToDate: `${year}-12-31`,
    };
    expect(getSusaReport).toHaveBeenCalledWith(expect.objectContaining(expectedRange));
    expect(getBwaReport).toHaveBeenCalledWith(expect.objectContaining(expectedRange));
    expect(getManagementGuvReport).toHaveBeenCalledWith(expect.objectContaining(expectedRange));
  });

  it('classifies native EÜR cash sources with an audit reason', async () => {
    const upsertEurClassification = vi.fn(async () => ({}));
    const getEurReport = vi.fn(async () => ({
      lines: [{ id: 'E2025_KZ123', code: '123', label: 'Betriebsausgaben', level: 0, amountCurrent: 0, isSubtotal: false }],
      totals: { revenue: 0, expenses: 0, result: 0 },
      quality: { unmappedAccounts: [], warnings: 1, generatedAt: '', source: 'live' as const, mappingStatus: 'blocked' as const },
      filing: {
        kind: 'euer' as const,
        taxYear: 2025,
        catalog: { id: 'anlage-euer-2025', version: 'BMF-2025-2025-08-29', sourceHash: 'b'.repeat(64), delivery: 'print-form-only' as const, elsterReady: false },
        lineProvenance: [{ lineId: 'E2025_KZ123', kennziffer: '123', providerPath: 'expense', exportable: true }],
      },
    }));
    render(<ReportsView
      dataAdapter={{
        getEurReport,
        listEurCashItems: vi.fn(async () => [{ sourceType: 'transaction', sourceId: 'bank-1', date: '2025-02-01', amountGross: 119, amountNet: 119, flowType: 'expense', counterparty: 'Lieferant', purpose: 'Beleg' }]),
        upsertEurClassification,
      }}
      availableTabs={['eur']}
    />);

    await screen.findByText('Quelle: transaction:bank-1');
    fireEvent.change(screen.getByLabelText('Audit-Grund für Klassifikationen'), { target: { value: 'Beleg geprüft' } });
    fireEvent.change(screen.getByLabelText('EÜR-Zeile'), { target: { value: 'E2025_KZ123' } });
    fireEvent.change(screen.getByLabelText('USt.'), { target: { value: 'default' } });
    fireEvent.change(screen.getByLabelText('USt.-Satz'), { target: { value: '19' } });
    fireEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => expect(upsertEurClassification).toHaveBeenCalledWith(expect.objectContaining({
      sourceType: 'transaction', sourceId: 'bank-1', eurLineId: 'E2025_KZ123', reason: 'Beleg geprüft', taxYear: 2025, vatMode: 'default', vatRate: 19,
    })));
  });

  it.each(['viewer', 'auditor'] as const)('keeps EÜR classification controls hidden for %s', async (role) => {
    const upsertEurClassification = vi.fn(async () => ({}));
    render(<ReportsView
      role={role}
      dataAdapter={{
        getEurReport: vi.fn(async () => ({ lines: [], totals: { revenue: 0, expenses: 0, result: 0 }, quality: { unmappedAccounts: [], warnings: 0, generatedAt: '', source: 'live' as const } })),
        listEurCashItems: vi.fn(async () => [{ sourceType: 'transaction', sourceId: 'bank-1', date: '2025-02-01', amountGross: 10, amountNet: 10, flowType: 'income', counterparty: 'Kunde', purpose: 'Zahlung' }]),
        upsertEurClassification,
      }}
      availableTabs={['eur']}
    />);

    await screen.findByText('Quelle: transaction:bank-1');
    expect(screen.queryByLabelText('Audit-Grund für Klassifikationen')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Speichern' })).toBeNull();
    expect(upsertEurClassification).not.toHaveBeenCalled();
  });

  it('allows BWA export when the public catalog provenance is verified', async () => {
    const exportReport = vi.fn(async () => ({ format: 'csv' as const }));
    render(<ReportsView
      dataAdapter={{
        getBwaReport: vi.fn(async () => ({
          lines: [],
          totals: { revenue: 0, expenses: 0, result: 0 },
          quality: { unmappedAccounts: [], warnings: 0, mappingStatus: 'ready' as const, mappingNotes: [], generatedAt: '', source: 'live' as const },
        })),
        exportReport,
      }}
      availableTabs={['bwa01']}
    />);

    const csv = await screen.findByRole('button', { name: 'CSV' });
    expect(csv).toHaveProperty('disabled', false);
    fireEvent.click(csv);
    await waitFor(() => expect(exportReport).toHaveBeenCalledWith(expect.objectContaining({ report: 'bwa01', format: 'csv' })));
  });
});
