import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ReportsView from './ReportsView';

const eurReport = {
  lines: [],
  totals: { revenue: 10, expenses: 2, result: 8 },
  quality: { unmappedAccounts: [], warnings: 0, generatedAt: '', source: 'live' as const },
};

function setFreezeForm(from: string, to: string) {
  fireEvent.change(screen.getByLabelText('Periode von'), { target: { value: from } });
  fireEvent.change(screen.getByLabelText('Periode bis'), { target: { value: to } });
  fireEvent.change(screen.getByLabelText('Audit-Grund für EÜR-Snapshot'), { target: { value: 'Abschlussprüfung EÜR 2025' } });
}

describe('ReportsView EÜR snapshots', () => {
  it('rejects a partial 2025 period instead of claiming a full-year snapshot', async () => {
    const saveReportSnapshot = vi.fn(async () => ({ id: 'snapshot-1', reportType: 'eur', args: {}, payload: {}, createdAt: '2025-05-31T23:00:00.000Z' }));
    render(<ReportsView dataAdapter={{ getEurReport: vi.fn(async () => eurReport), saveReportSnapshot }} availableTabs={['eur']} />);

    await screen.findByText('Einnahmenüberschussrechnung');
    setFreezeForm('2025-03', '2025-05');
    fireEvent.click(await screen.findByRole('button', { name: 'Snapshot einfrieren' }));

    expect((await screen.findByRole('alert')).textContent).toContain('vollständiger EÜR-2025-Zeitraum');
    expect(saveReportSnapshot).not.toHaveBeenCalled();
  });

  it('requires the exact calendar year and reports success as a status notice', async () => {
    const saveReportSnapshot = vi.fn(async () => ({ id: 'snapshot-1', reportType: 'eur', args: {}, payload: {}, createdAt: '2025-12-31T23:00:00.000Z' }));
    render(<ReportsView dataAdapter={{ getEurReport: vi.fn(async () => eurReport), saveReportSnapshot }} availableTabs={['eur']} />);

    await screen.findByText('Einnahmenüberschussrechnung');
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
    const saveReportSnapshot = vi.fn(async () => ({ id: 'snapshot-1', reportType: 'eur', args: {}, payload: {}, createdAt: '2025-12-31T23:00:00.000Z' }));
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
});
