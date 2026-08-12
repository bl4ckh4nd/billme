import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import AssetManagementView from './AssetManagementView';
import type { AssetDepreciationScheduleEntry, AssetItem } from '../domain/assetTypes';

const asset: AssetItem = {
  id: 'asset-1',
  assetNumber: 'ANL-2026-001',
  name: 'Server',
  assetClass: 'IT-Hardware',
  status: 'aktiv',
  activationDate: '2026-01-01',
  acquisitionCost: 1200,
  residualValue: 1200,
  annualDepreciation: 400,
  depreciationMethod: 'linear',
  costCenter: 'IT-01',
  location: 'Berlin',
  nextDepreciation: '2026-12-31',
  receiptLinked: true,
  assetAccountNumber: '0440',
};

const scheduleEntry: AssetDepreciationScheduleEntry = {
  id: 'schedule-1',
  assetId: asset.id,
  year: 2026,
  amount: 400,
  months: 12,
  status: 'posted',
  journalEntryId: 'journal-1',
};

describe('AssetManagementView productive mutations', () => {
  it('surfaces an adapter rejection without refreshing or replacing canonical data', async () => {
    const listAssets = vi.fn(async () => [asset]);
    const upsertAsset = vi.fn(async () => { throw new Error('Anlagen-Backend abgelehnt'); });
    render(<AssetManagementView dataAdapter={{ listAssets, upsertAsset }} />);

    await screen.findAllByText('Server');
    fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    fireEvent.change(screen.getByLabelText('Audit-Grund *'), { target: { value: 'Korrektur' } });
    fireEvent.change(screen.getByLabelText('Bezeichnung *'), { target: { value: 'Server neu' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Anlage speichern' }).closest('form')!);

    expect((await screen.findByRole('alert')).textContent).toContain('Anlagen-Backend abgelehnt');
    expect(upsertAsset).toHaveBeenCalledTimes(1);
    expect(listAssets).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText('Server').length).toBeGreaterThan(0);
  });

  it('refreshes the list and schedule only after a successful AfA booking', async () => {
    const updatedAsset = { ...asset, residualValue: 800, nextDepreciation: '2027-12-31' };
    const listAssets = vi.fn()
      .mockResolvedValueOnce([asset])
      .mockResolvedValueOnce([updatedAsset]);
    const getDepreciationSchedule = vi.fn(async () => [scheduleEntry]);
    const runDepreciation = vi.fn(async () => ({ asset: updatedAsset, scheduleEntry, journalEntryId: 'journal-1' }));
    render(<AssetManagementView dataAdapter={{ listAssets, getDepreciationSchedule, runDepreciation }} />);

    await screen.findAllByText('Server');
    fireEvent.change(screen.getByPlaceholderText('Warum wird die AfA jetzt gebucht?'), { target: { value: 'Jahres-AfA 2026' } });
    fireEvent.click(screen.getByRole('button', { name: 'AfA buchen' }));

    expect((await screen.findByRole('status')).textContent).toContain('Journal journal-1');
    await waitFor(() => expect(listAssets).toHaveBeenCalledTimes(2));
    expect(getDepreciationSchedule).toHaveBeenCalledTimes(2);
    expect(runDepreciation).toHaveBeenCalledWith(expect.objectContaining({ assetId: asset.id, reason: 'Jahres-AfA 2026', actorRole: 'admin' }));
    expect(screen.getAllByText((text) => text.includes('800,00')).length).toBeGreaterThan(0);
  });
});
