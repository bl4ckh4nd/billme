import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ReportMappingSetup from './ReportMappingSetup';
import type { ProAccountingDataAdapter } from '../../services/mockBookingStore';

const positions = [
  { key: 'revenue', label: 'Umsatzerlöse', kind: 'line' as const },
  { key: 'assets.current.cash', label: 'Kassenbestand', side: 'asset' as const, kind: 'line' as const },
];

function adapter(overrides: Partial<ProAccountingDataAdapter> = {}): ProAccountingDataAdapter {
  return {
    getReportMappingHealth: vi.fn(async () => ({ chart: 'SKR03' as const, unmapped: [
      { accountNumber: '8400', statement: 'hgb-guv' as const },
      { accountNumber: '1200', statement: 'hgb-bilanz' as const },
    ] })),
    listReportMappingPositions: vi.fn(async (statement) => statement === 'hgb-bilanz' ? [positions[1]] : [positions[0]]),
    upsertReportMappingOverride: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

describe('ReportMappingSetup', () => {
  it('shows report-specific missing accounts and only catalog positions', async () => {
    const dataAdapter = adapter();
    render(<ReportMappingSetup dataAdapter={dataAdapter} chart="SKR03" role="admin" asOfDate="2025-12-31" />);

    expect(await screen.findByText('8400')).toBeTruthy();
    expect(screen.getByText('1200')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Umsatzerlöse' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: /freie Position/ })).toBeNull();
    expect(screen.getByText(/DATEV.*Import-Gate/)).toBeTruthy();
    expect(dataAdapter.getReportMappingHealth).toHaveBeenCalledWith({ chart: 'SKR03', statement: 'hgb-guv', asOfDate: '2025-12-31' });
  });

  it('requires an audit reason and derives label/side from the selected catalog position', async () => {
    const upsertReportMappingOverride = vi.fn(async () => ({ ok: true }));
    render(<ReportMappingSetup dataAdapter={adapter({ upsertReportMappingOverride })} chart="SKR03" role="admin" />);
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
    })));
  });

  it('hides mutation controls for viewer and surfaces load failures', async () => {
    const readonly = adapter();
    const { unmount } = render(<ReportMappingSetup dataAdapter={readonly} chart="SKR03" role="viewer" />);
    await screen.findByText('8400');
    expect(screen.getAllByRole('button', { name: 'Zuordnen' })[0]).toHaveProperty('disabled', true);
    expect(screen.getByText(/darf Report-Mappings nur lesen/)).toBeTruthy();
    unmount();

    const failure = adapter({ getReportMappingHealth: vi.fn(async () => { throw new Error('Mapping-Service ausgefallen'); }) });
    render(<ReportMappingSetup dataAdapter={failure} chart="SKR03" role="admin" />);
    expect((await screen.findByRole('alert')).textContent).toContain('Mapping-Service ausgefallen');
  });
});
