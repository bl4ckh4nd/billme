import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const { mockIpc } = vi.hoisted(() => ({
  mockIpc: {
  transactions: {
    list: vi.fn<(...args: any[]) => Promise<any[]>>(async () => []),
    findMatches: vi.fn<(...args: any[]) => Promise<any>>(async () => ({ transaction: null, suggestions: [] })),
    link: vi.fn(async () => ({ success: true })),
    unlink: vi.fn(async () => ({ success: true })),
  },
  eur: {
    getReport: vi.fn(async () => ({
      taxYear: 2025,
      from: '2025-01-01',
      to: '2025-12-31',
      rows: [
        {
          lineId: 'E2025_KZ280',
          kennziffer: '280',
          label: 'Aufwendungen fuer Telekommunikation',
          kind: 'expense',
          exportable: true,
          total: 0,
          sortOrder: 1,
        },
      ],
      summary: { incomeTotal: 0, expenseTotal: 0, surplus: 0 },
      unclassifiedCount: 0,
      warnings: [],
    })),
    listItems: vi.fn<(...args: any[]) => Promise<any[]>>(async () => []),
    upsertClassification: vi.fn(async (payload: any) => ({
      id: 'cls-1',
      sourceType: payload.sourceType,
      sourceId: payload.sourceId,
      taxYear: payload.taxYear,
      eurLineId: payload.eurLineId,
      excluded: payload.excluded ?? false,
      vatMode: payload.vatMode ?? 'none',
      updatedAt: new Date().toISOString(),
    })),
    exportCsv: vi.fn(async () => '\uFEFFKennziffer;Bezeichnung;Betrag\n'),
  },
}}));

vi.mock('../ipc/client', () => ({
  ipc: mockIpc,
}));

import { TransactionMatchingView } from './TransactionMatchingView';

const renderView = (initialTab: 'matching' | 'eur' = 'eur') => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <TransactionMatchingView onBack={() => {}} initialTab={initialTab} />
    </QueryClientProvider>,
  );
};

describe('TransactionMatchingView EÜR integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves single inline EÜR classification from transaction tab', async () => {
    mockIpc.eur.listItems.mockResolvedValueOnce([
      {
        sourceType: 'transaction',
        sourceId: 'tx-1',
        date: '2025-01-03',
        amountGross: 59.5,
        amountNet: 59.5,
        flowType: 'expense',
        accountId: 'acc-1',
        linkedViaInvoice: false,
        counterparty: 'Hosting GmbH',
        purpose: 'Hosting Januar',
        suggestedLineId: 'E2025_KZ280',
        suggestionReason: 'Telekommunikation erkannt',
      },
    ]);

    renderView('eur');

    const rowBtn = await screen.findByRole('button', { name: /Hosting GmbH/i });
    await userEvent.click(rowBtn);

    const saveBtn = await screen.findByRole('button', { name: /Klassifizierung speichern/i });
    await userEvent.click(saveBtn);

    await waitFor(() => {
      expect(mockIpc.eur.upsertClassification).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceType: 'transaction',
          sourceId: 'tx-1',
          taxYear: 2025,
          eurLineId: 'E2025_KZ280',
          excluded: false,
          vatMode: 'none',
        }),
      );
    });
  });

  it('applies bulk suggestion to selected transactions', async () => {
    mockIpc.eur.listItems.mockResolvedValueOnce([
      {
        sourceType: 'transaction',
        sourceId: 'tx-1',
        date: '2025-01-03',
        amountGross: 59.5,
        amountNet: 59.5,
        flowType: 'expense',
        counterparty: 'Hosting GmbH',
        purpose: 'Hosting Januar',
        suggestedLineId: 'E2025_KZ280',
        suggestionReason: 'Telekommunikation erkannt',
      },
      {
        sourceType: 'transaction',
        sourceId: 'tx-2',
        date: '2025-01-04',
        amountGross: 120,
        amountNet: 120,
        flowType: 'expense',
        counterparty: 'Agentur Ads',
        purpose: 'Google Ads',
        suggestedLineId: 'E2025_KZ280',
        suggestionReason: 'Fallback',
      },
    ]);

    renderView('eur');

    const selectAllBtn = await screen.findByRole('button', { name: /Alle wählen/i });
    await userEvent.click(selectAllBtn);

    const bulkBtn = await screen.findByRole('button', { name: /Vorschlag anwenden/i });
    await userEvent.click(bulkBtn);

    await waitFor(() => {
      expect(mockIpc.eur.upsertClassification).toHaveBeenCalledTimes(2);
    });

    expect(mockIpc.eur.upsertClassification).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'tx-1', eurLineId: 'E2025_KZ280', excluded: false }),
    );
    expect(mockIpc.eur.upsertClassification).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'tx-2', eurLineId: 'E2025_KZ280', excluded: false }),
    );
  });
});
