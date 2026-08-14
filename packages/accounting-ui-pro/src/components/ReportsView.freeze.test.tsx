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
  it('makes annex facts idempotent, single-flight, and visible after refetch', async () => {
    let resolveSave: (() => void) | undefined;
    const saveEurAnnexFact = vi.fn(() => new Promise<any>((resolve) => { resolveSave = resolve; }));
    const listEurAnnexFacts = vi.fn(async () => [{ id: 'annex-1', taxYear: 2025, annex: 'IAB', lineId: 'formed', amount: 120, createdAt: '2025-12-31T00:00:00.000Z' }]);
    render(<ReportsView
      dataAdapter={{
        getEurReport: vi.fn(async () => eurReport),
        listEurCashItems: vi.fn(async () => []),
        upsertEurClassification: vi.fn(async () => ({})),
        saveEurAnnexFact,
        listEurAnnexFacts,
      }}
      availableTabs={['eur']}
    />);

    await screen.findByLabelText('EÜR-Anlagen-Fakt');
    fireEvent.change(screen.getByLabelText('Audit-Grund für Klassifikationen'), { target: { value: 'Anlage geprüft' } });
    fireEvent.change(screen.getByLabelText('Betrag'), { target: { value: '120' } });
    const save = screen.getByRole('button', { name: 'Anlagen-Fakt speichern' });
    fireEvent.click(save);
    fireEvent.click(save);
    expect(saveEurAnnexFact).toHaveBeenCalledTimes(1);
    expect(saveEurAnnexFact).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: expect.stringContaining('eur-annex:2025:IAB:formed') }));
    expect(save.getAttribute('aria-busy')).toBe('true');
    resolveSave?.();
    await waitFor(() => expect(listEurAnnexFacts).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Gespeicherte Anlagen-Fakten')).toBeTruthy();
  });

  it('includes authoritative EÜR facts in a supported snapshot adapter', async () => {
    const saveReportSnapshot = vi.fn(async () => ({ id: 'snapshot-1', reportType: 'eur', args: {}, payload: {}, createdAt: '2025-12-31T23:00:00.000Z', sourceHash: 'a'.repeat(64) }));
    const cashFact = { id: 'cash-1', taxYear: 2025, sourceType: 'transaction' as const, sourceId: 'tx-1', kind: 'expense' as const, amountNet: 10 };
    const annexFact = { id: 'annex-1', taxYear: 2025, annex: 'IAB', lineId: 'formed', amount: 120 };
    render(<ReportsView
      dataAdapter={{
        getEurReport: vi.fn(async () => eurReport),
        listEurCashFacts: vi.fn(async () => [cashFact]),
        listEurAnnexFacts: vi.fn(async () => [annexFact]),
        saveReportSnapshot,
      }}
      availableTabs={['eur']}
    />);

    await screen.findByLabelText('Audit-Grund für EÜR-Snapshot');
    fireEvent.change(screen.getByLabelText('Audit-Grund für EÜR-Snapshot'), { target: { value: 'Abschlussprüfung EÜR 2025' } });
    fireEvent.click(screen.getByRole('button', { name: 'Snapshot einfrieren' }));
    await waitFor(() => expect(saveReportSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ eurCashFacts: [cashFact], eurAnnexFacts: [annexFact] }),
    })));
  });

  it('keeps the native EÜR snapshot locked to the full 2025 period', async () => {
    const saveReportSnapshot = vi.fn(async () => ({ id: 'snapshot-1', reportType: 'eur', args: {}, payload: {}, createdAt: '2025-05-31T23:00:00.000Z', sourceHash: 'a'.repeat(64) }));
    render(<ReportsView dataAdapter={{ getEurReport: vi.fn(async () => eurReport), saveReportSnapshot }} availableTabs={['eur']} />);

    await screen.findByLabelText('Audit-Grund für EÜR-Snapshot');
    expect(screen.getByLabelText('Zeitraum')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Stichtag')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Periode von')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Periode bis')).toHaveProperty('disabled', true);
    setFreezeForm('2025-03', '2025-05');
    expect((screen.getByLabelText('Periode von') as HTMLInputElement).value).toBe('2025-01');
    expect((screen.getByLabelText('Periode bis') as HTMLInputElement).value).toBe('2025-12');
    fireEvent.click(await screen.findByRole('button', { name: 'Snapshot einfrieren' }));

    await waitFor(() => expect(saveReportSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      reportType: 'eur',
      reason: 'Abschlussprüfung EÜR 2025',
      args: expect.objectContaining({ periodFrom: '2025-01', periodTo: '2025-12', periodFromDate: '2025-01-01', periodToDate: '2025-12-31' }),
    })));
    expect(screen.queryByRole('alert')).toBeNull();
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
