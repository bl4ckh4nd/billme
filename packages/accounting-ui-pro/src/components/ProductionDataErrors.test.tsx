import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import AssetManagementView from './AssetManagementView';
import ReportsView from './ReportsView';
import SusaTable from './reports/SusaTable';
import type { SusaReport } from '../domain/reportTypes';

describe('production adapter errors', () => {
  it('does not replace failed asset reads with example assets', async () => {
    const dataAdapter = {
      listAssets: vi.fn(async () => {
        throw new Error('Anlagen-Backend nicht erreichbar');
      }),
    };

    render(<AssetManagementView dataAdapter={dataAdapter} />);

    expect((await screen.findByRole('alert')).textContent).toContain('Anlagen-Backend nicht erreichbar');
    expect(screen.queryByText('MacBook Pro 16" Buchhaltung')).toBeNull();
  });

  it('does not replace failed report reads with example reports', async () => {
    const failure = vi.fn(async () => {
      throw new Error('Berichts-Backend nicht erreichbar');
    });
    const dataAdapter = {
      getSusaReport: failure,
      getGuvReport: failure,
      getBalanceSheetPreview: failure,
    };

    render(<ReportsView dataAdapter={dataAdapter} />);

    expect((await screen.findByRole('alert')).textContent).toContain('Berichts-Backend nicht erreichbar');
    expect(screen.queryByText('Summen- und Saldenliste')).toBeNull();
  });

  it('opens a report row with the keyboard', () => {
    const onSelectRow = vi.fn();
    const report: SusaReport = {
      rows: [{ accountNumber: '8400', accountName: 'Erlöse', openingBalance: 0, debitTurnover: 0, creditTurnover: 100, closingBalance: 100, normalBalance: 'credit' }],
      totals: { openingDebit: 0, openingCredit: 0, turnoverDebit: 0, turnoverCredit: 100, closingDebit: 0, closingCredit: 100 },
      quality: { unmappedAccounts: 0, warnings: 0, generatedAt: '2026-01-01T00:00:00.000Z', source: 'live' },
    };

    render(<SusaTable report={report} onSelectRow={onSelectRow} />);
    const row = screen.getByRole('button', { name: /8400/ });
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onSelectRow).toHaveBeenCalledWith(report.rows[0]);
  });
});
