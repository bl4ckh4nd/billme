import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ReportMappingSetup from './ReportMappingSetup';
import type { ProAccountingDataAdapter } from '../../services/mockBookingStore';

const positions = [
  { key: 'revenue', label: 'Umsatzerlöse', kind: 'line' as const },
  { key: 'assets.current.cash', label: 'Kassenbestand', side: 'asset' as const, kind: 'line' as const },
];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function adapter(overrides: Partial<ProAccountingDataAdapter> = {}): ProAccountingDataAdapter {
  return {
    getReportMappingHealth: vi.fn(async () => ({ chart: 'SKR03' as const, unmapped: [
      { accountNumber: '8400', statement: 'hgb-guv' as const },
      { accountNumber: '1200', statement: 'hgb-bilanz' as const },
    ] })),
    listReportMappingPositions: vi.fn(async ({ statement }) => statement === 'hgb-bilanz' ? [positions[1]] : [positions[0]]),
    upsertReportMappingOverride: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

describe('ReportMappingSetup', () => {
  it('ignores stale health and position results after an as-of-date refresh', async () => {
    const oldHealth = deferred<{ chart: 'SKR03'; unmapped: [{ accountNumber: string; statement: 'hgb-guv' }] }>();
    const newHealth = deferred<{ chart: 'SKR03'; unmapped: [{ accountNumber: string; statement: 'hgb-guv' }] }>();
    const oldPositions = deferred<typeof positions>();
    const newPositions = deferred<typeof positions>();
    const getReportMappingHealth = vi.fn()
      .mockImplementationOnce(() => oldHealth.promise)
      .mockImplementationOnce(() => newHealth.promise);
    const listReportMappingPositions = vi.fn(({ asOfDate }: { asOfDate: string }) => (
      asOfDate === '2026-01-31' ? newPositions.promise : oldPositions.promise
    ));
    const dataAdapter = adapter({ getReportMappingHealth, listReportMappingPositions });

    const { rerender } = render(
      <ReportMappingSetup
        dataAdapter={dataAdapter}
        chart="SKR03"
        role="admin"
        statements={['hgb-guv']}
        asOfDate="2025-12-31"
      />,
    );
    await waitFor(() => expect(getReportMappingHealth).toHaveBeenCalledTimes(1));
    rerender(
      <ReportMappingSetup
        dataAdapter={dataAdapter}
        chart="SKR03"
        role="admin"
        statements={['hgb-guv']}
        asOfDate="2026-01-31"
      />,
    );
    await waitFor(() => expect(getReportMappingHealth).toHaveBeenCalledTimes(2));

    newHealth.resolve({ chart: 'SKR03', unmapped: [{ accountNumber: '8600', statement: 'hgb-guv' }] });
    await waitFor(() => expect(listReportMappingPositions).toHaveBeenCalledTimes(1));
    newPositions.resolve([positions[0]]);
    expect(await screen.findByText('8600')).toBeTruthy();

    oldHealth.resolve({ chart: 'SKR03', unmapped: [{ accountNumber: '8400', statement: 'hgb-guv' }] });
    await waitFor(() => expect(listReportMappingPositions).toHaveBeenCalledTimes(2));
    oldPositions.resolve([positions[1]]);
    await waitFor(() => expect(screen.queryByText('8400')).toBeNull());
    expect(screen.getByText('8600')).toBeTruthy();
  });

  it('ignores stale refresh failures after the latest mapping load succeeds', async () => {
    const stale = deferred<{ chart: 'SKR03'; unmapped: [{ accountNumber: string; statement: 'hgb-guv' }] }>();
    const fresh = deferred<{ chart: 'SKR03'; unmapped: [{ accountNumber: string; statement: 'hgb-guv' }] }>();
    const getReportMappingHealth = vi.fn()
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => fresh.promise);
    const listReportMappingPositions = vi.fn(async () => [positions[0]]);
    const dataAdapter = adapter({ getReportMappingHealth, listReportMappingPositions });

    const { rerender } = render(
      <ReportMappingSetup dataAdapter={dataAdapter} chart="SKR03" role="admin" statements={['hgb-guv']} asOfDate="2025-12-31" />,
    );
    await waitFor(() => expect(getReportMappingHealth).toHaveBeenCalledTimes(1));
    rerender(
      <ReportMappingSetup dataAdapter={dataAdapter} chart="SKR03" role="admin" statements={['hgb-guv']} asOfDate="2025-12-31" refreshKey={1} />,
    );
    await waitFor(() => expect(getReportMappingHealth).toHaveBeenCalledTimes(2));

    fresh.resolve({ chart: 'SKR03', unmapped: [{ accountNumber: '8600', statement: 'hgb-guv' }] });
    expect(await screen.findByText('8600')).toBeTruthy();
    stale.reject(new Error('veralteter Mapping-Fehler'));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByText('8600')).toBeTruthy();
  });

  it('shows report-specific missing accounts and only catalog positions', async () => {
    const dataAdapter = adapter();
    render(<ReportMappingSetup dataAdapter={dataAdapter} chart="SKR03" role="admin" asOfDate="2025-12-31" />);

    expect(await screen.findByText('8400')).toBeTruthy();
    expect(screen.getByText('1200')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Umsatzerlöse' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /freie Position/ })).toBeNull();
    expect(screen.getByText(/DATEV.*Import-Gate/)).toBeTruthy();
    expect(dataAdapter.getReportMappingHealth).toHaveBeenCalledWith({ chart: 'SKR03', statement: 'hgb-guv', asOfDate: '2025-12-31' });
    expect(dataAdapter.listReportMappingPositions).toHaveBeenCalledWith({ statement: 'hgb-guv', asOfDate: '2025-12-31' });
  });

  it('requires an audit reason and derives label/side from the selected catalog position', async () => {
    const upsertReportMappingOverride = vi.fn(async () => ({ ok: true }));
    render(<ReportMappingSetup dataAdapter={adapter({ upsertReportMappingOverride })} chart="SKR03" role="admin" asOfDate="2025-12-31" />);
    await screen.findByText('1200');

    const saveButtons = screen.getAllByRole('button', { name: 'Zuordnen' });
    expect(saveButtons[0]).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText('Audit-Grund für Mapping-Änderungen'), { target: { value: 'Kontenabstimmung' } });
    fireEvent.change(screen.getAllByLabelText('Erlaubte Position', { selector: 'select' })[1], { target: { value: 'assets.current.cash' } });
    fireEvent.click(saveButtons[1]);

    await waitFor(() => expect(upsertReportMappingOverride).toHaveBeenCalledWith(expect.objectContaining({
      accountNumber: '1200',
      statement: 'hgb-bilanz',
      position: 'assets.current.cash',
      label: 'Kassenbestand',
      side: 'asset',
      reason: 'Kontenabstimmung',
      asOfDate: '2025-12-31',
    })));
  });

  it('hides mutation controls for viewer and surfaces load failures', async () => {
    const readonly = adapter();
    const { unmount } = render(<ReportMappingSetup dataAdapter={readonly} chart="SKR03" role="viewer" asOfDate="2025-12-31" />);
    await screen.findByText('8400');
    expect(screen.getAllByRole('button', { name: 'Zuordnen' })[0]).toHaveProperty('disabled', true);
    expect(screen.getByText(/darf Report-Mappings nur lesen/)).toBeTruthy();
    unmount();

    const failure = adapter({ getReportMappingHealth: vi.fn(async () => { throw new Error('Mapping-Service ausgefallen'); }) });
    render(<ReportMappingSetup dataAdapter={failure} chart="SKR03" role="admin" asOfDate="2025-12-31" />);
    expect((await screen.findByRole('alert')).textContent).toContain('Mapping-Service ausgefallen');
  });
});
