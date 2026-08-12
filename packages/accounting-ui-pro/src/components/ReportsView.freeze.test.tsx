import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ReportsView from './ReportsView';

const eurReport = {
  lines: [],
  totals: { revenue: 10, expenses: 2, result: 8 },
  quality: { unmappedAccounts: [], warnings: 0, generatedAt: '', source: 'live' as const },
  filing: {
    kind: 'euer' as const,
    taxYear: 2025,
    catalog: { id: 'anlage-euer-2025', version: 'BMF-2025-2025-08-29', sourceHash: 'b'.repeat(64), delivery: 'print-form-only' as const, elsterReady: false },
    lineProvenance: [{ lineId: 'E2025_KZ111', kennziffer: '111', providerPath: 'income', exportable: true }],
  },
};

function setFreezeForm(from: string, to: string) {
  fireEvent.change(screen.getByLabelText('Periode von'), { target: { value: from } });
  fireEvent.change(screen.getByLabelText('Periode bis'), { target: { value: to } });
  fireEvent.change(screen.getByLabelText('Audit-Grund für EÜR-Snapshot'), { target: { value: 'Abschlussprüfung EÜR 2025' } });
}

describe('ReportsView EÜR snapshots', () => {
  it('rejects a partial 2025 period instead of claiming a full-year snapshot', async () => {
    const saveReportSnapshot = vi.fn(async () => ({ id: 'snapshot-1', reportType: 'eur', args: {}, payload: {}, createdAt: '2025-05-31T23:00:00.000Z', sourceHash: 'a'.repeat(64) }));
    render(<ReportsView dataAdapter={{ getEurReport: vi.fn(async () => eurReport), saveReportSnapshot }} availableTabs={['eur']} />);

    await screen.findByLabelText('Audit-Grund für EÜR-Snapshot');
    setFreezeForm('2025-03', '2025-05');
    fireEvent.click(await screen.findByRole('button', { name: 'Snapshot einfrieren' }));

    expect((await screen.findByRole('alert')).textContent).toContain('vollständiger EÜR-2025-Zeitraum');
    expect(saveReportSnapshot).not.toHaveBeenCalled();
  });

  it('requires the exact calendar year and reports success as a status notice', async () => {
    const saveReportSnapshot = vi.fn(async () => ({ id: 'snapshot-1', reportType: 'eur', args: {}, payload: {}, createdAt: '2025-12-31T23:00:00.000Z', sourceHash: 'a'.repeat(64) }));
    render(<ReportsView dataAdapter={{ getEurReport: vi.fn(async () => eurReport), saveReportSnapshot }} availableTabs={['eur']} />);

    await screen.findByLabelText('Audit-Grund für EÜR-Snapshot');
    setFreezeForm('2025-01', '2025-12');
    fireEvent.click(await screen.findByRole('button', { name: 'Snapshot einfrieren' }));

    await waitFor(() => expect(saveReportSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      reportType: 'eur',
      reason: 'Abschlussprüfung EÜR 2025',
      args: expect.objectContaining({ periodFrom: '2025-01', periodTo: '2025-12' }),
    })));
    const successNotice = await screen.findByText('EÜR-Snapshot eingefroren und im Audit protokolliert.');
    expect(successNotice.getAttribute('role')).toBe('status');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not expose the snapshot mutation to viewer or auditor roles', async () => {
    const saveReportSnapshot = vi.fn(async () => ({ id: 'snapshot-1', reportType: 'eur', args: {}, payload: {}, createdAt: '2025-12-31T23:00:00.000Z', sourceHash: 'a'.repeat(64) }));
    const adapter = { getEurReport: vi.fn(async () => eurReport), saveReportSnapshot };

    const { unmount } = render(<ReportsView dataAdapter={adapter} role="viewer" availableTabs={['eur']} />);
    expect(await screen.findByText('Diese Rolle kann EÜR-Snapshots nur lesen.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Snapshot einfrieren' })).toBeNull();
    unmount();

    render(<ReportsView dataAdapter={adapter} role="auditor" availableTabs={['eur']} />);
    expect(await screen.findByText('Diese Rolle kann EÜR-Snapshots nur lesen.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Snapshot einfrieren' })).toBeNull();
    expect(saveReportSnapshot).not.toHaveBeenCalled();
  });

  it('explains and blocks an incomplete EÜR snapshot before IPC', async () => {
    const saveReportSnapshot = vi.fn(async () => ({ id: 'snapshot-1', reportType: 'eur', args: {}, payload: {}, createdAt: '2025-12-31T23:00:00.000Z', sourceHash: 'a'.repeat(64) }));
    const blockedReport = {
      ...eurReport,
      quality: { ...eurReport.quality, warnings: 1, mappingStatus: 'blocked' as const },
    };
    render(<ReportsView dataAdapter={{ getEurReport: vi.fn(async () => blockedReport), saveReportSnapshot }} availableTabs={['eur']} />);

    await screen.findByLabelText('Audit-Grund für EÜR-Snapshot');
    setFreezeForm('2025-01', '2025-12');
    const freezeButton = await screen.findByRole('button', { name: 'Snapshot einfrieren' });
    expect(freezeButton).toHaveProperty('disabled', true);
    expect(await screen.findByText('Snapshot kann wegen unvollständiger oder nicht-live Reportdaten nicht eingefroren werden.')).toBeTruthy();
    expect(saveReportSnapshot).not.toHaveBeenCalled();
  });
});
