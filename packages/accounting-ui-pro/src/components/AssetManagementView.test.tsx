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
  it('locks status edits after an asset has been activated', async () => {
    render(<AssetManagementView dataAdapter={{ listAssets: vi.fn(async () => [asset]), upsertAsset: vi.fn() }} />);

    await screen.findAllByText('Server');
    fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    await screen.findByText('Anlage bearbeiten');

    expect((screen.getByRole('combobox', { name: /Status/ }) as HTMLSelectElement).disabled).toBe(true);
    expect(screen.getByText(/Gebuchte Anlagen behalten ihren Accounting-Status/)).toBeTruthy();
  });

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

  it('shows German required-field feedback before calling the adapter', async () => {
    const upsertAsset = vi.fn(async () => asset);
    render(<AssetManagementView dataAdapter={{ listAssets: vi.fn(async () => [asset]), upsertAsset }} />);

    await screen.findAllByText('Server');
    fireEvent.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    fireEvent.change(screen.getByLabelText('Bezeichnung *'), { target: { value: '' } });
    fireEvent.submit(screen.getByRole('button', { name: 'Anlage speichern' }).closest('form')!);

    expect((await screen.findByRole('alert')).textContent).toContain('Bitte Pflichtfelder ausfüllen: Bezeichnung.');
    expect(upsertAsset).not.toHaveBeenCalled();
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

  it('discards a slow schedule response after selection changes', async () => {
    const assetB = { ...asset, id: 'asset-2', assetNumber: 'ANL-2026-002', name: 'Monitor' };
    const scheduleB: AssetDepreciationScheduleEntry = { ...scheduleEntry, id: 'schedule-2', assetId: assetB.id, amount: 200 };
    let resolveA: (value: AssetDepreciationScheduleEntry[]) => void = () => undefined;
    const slowA = new Promise<AssetDepreciationScheduleEntry[]>((resolve) => { resolveA = resolve; });
    const getDepreciationSchedule = vi.fn((assetId: string) => assetId === asset.id ? slowA : Promise.resolve([scheduleB]));
    render(<AssetManagementView dataAdapter={{ listAssets: vi.fn(async () => [asset, assetB]), getDepreciationSchedule }} />);

    await screen.findAllByText('Monitor');
    await waitFor(() => expect(getDepreciationSchedule).toHaveBeenCalledWith(asset.id));
    fireEvent.click(screen.getByRole('button', { name: /ANL-2026-002/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Abschreibungsplan' }));

    expect(await screen.findAllByText((text) => text.includes('200,00'))).not.toHaveLength(0);
    resolveA([scheduleEntry]);
    await waitFor(() => expect(screen.getAllByText((text) => text.includes('200,00')).length).toBeGreaterThan(0));
  });

  it('sends tax rate and proceeds account for a sale', async () => {
    const soldAsset = { ...asset, status: 'verkauft' as const, disposalDate: '2026-08-12', disposalProceeds: 500 };
    const listAssets = vi.fn(async () => [asset]);
    const disposeAsset = vi.fn(async () => ({ asset: soldAsset, residualBookValue: 800, gainLoss: -300, journalEntryId: 'journal-sale' }));
    render(<AssetManagementView dataAdapter={{ listAssets, disposeAsset }} />);

    await screen.findAllByText('Server');
    fireEvent.change(screen.getByLabelText('Verkaufserlös netto *'), { target: { value: '500' } });
    fireEvent.change(screen.getByLabelText('Umsatzsteuersatz *'), { target: { value: '19' } });
    fireEvent.change(screen.getByLabelText('Erlöskonto / Zahlungskonto'), { target: { value: '1200' } });
    fireEvent.change(screen.getByPlaceholderText('Warum wird die Anlage ausgebucht?'), { target: { value: 'Verkauf' } });
    fireEvent.click(screen.getByLabelText(/Ich bestätige die Ausbuchung/));
    fireEvent.submit(screen.getByRole('button', { name: 'Ausbuchung bestätigen' }).closest('form')!);

    await waitFor(() => expect(disposeAsset).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole('status')).textContent).toContain('Journal journal-sale');
    expect(disposeAsset).toHaveBeenCalledWith(expect.objectContaining({ proceeds: 500, taxRate: 19, proceedsAccountNumber: '1200', reason: 'Verkauf', actorRole: 'admin' }));
  });
});
