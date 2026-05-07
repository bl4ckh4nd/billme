import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IpcArgs, IpcResult } from '@billme/desktop-contracts-pro';
import { ProAccountRulesModal } from './ProAccountRulesModal';

const { mockIpc } = vi.hoisted(() => ({
    mockIpc: {
      pro: {
        listAccountSuggestionRules:
          vi.fn<(args?: IpcArgs<'pro:listAccountSuggestionRules'>) => Promise<IpcResult<'pro:listAccountSuggestionRules'>>>(
            async () => [],
          ),
        listLedgerAccounts:
          vi.fn<(args?: IpcArgs<'pro:listLedgerAccounts'>) => Promise<IpcResult<'pro:listLedgerAccounts'>>>(
            async () => [],
          ),
        upsertAccountSuggestionRule: vi.fn(async (payload: any) => ({
          id: payload.id ?? 'rule-new',
          ...payload,
      })),
      deleteAccountSuggestionRule: vi.fn(async () => ({ success: true })),
    },
  },
}));

vi.mock('../ipc/client', () => ({
  ipc: mockIpc,
}));

vi.mock('@billme/ui', () => ({
  Button: (props: any) => <button {...props}>{props.children}</button>,
}));

const renderModal = (props?: Partial<React.ComponentProps<typeof ProAccountRulesModal>>) => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const onClose = vi.fn();
  const onRulesChanged = vi.fn();

  const view = render(
    <QueryClientProvider client={queryClient}>
      <ProAccountRulesModal
        chartFramework="SKR03"
        onClose={onClose}
        onRulesChanged={onRulesChanged}
        {...props}
      />
    </QueryClientProvider>,
  );

  return { ...view, onClose, onRulesChanged };
};

describe('ProAccountRulesModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders empty state and closes via footer action', async () => {
    renderModal();

    expect(await screen.findByText(/Keine Regeln vorhanden/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Schliessen/i }));
  });

  it('creates a new pro account suggestion rule with trimmed values', async () => {
    mockIpc.pro.listLedgerAccounts.mockResolvedValue([
      {
        id: 'acc-8400',
        chart: 'SKR03',
        accountNumber: '8400',
        name: 'Erloese',
        source: 'test',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    const { onRulesChanged } = renderModal();

    await userEvent.click(await screen.findByRole('button', { name: /Neue Regel/i }));
    await userEvent.type(screen.getByPlaceholderText(/z.B. telefon/i), '  telekom  ');
    await userEvent.selectOptions(screen.getAllByRole('combobox')[2], '8400');
    await userEvent.click(screen.getByRole('button', { name: /Regel erstellen/i }));

    await waitFor(() => {
      expect(mockIpc.pro.upsertAccountSuggestionRule).toHaveBeenCalledWith(
        expect.objectContaining({
          chart: 'SKR03',
          field: 'counterparty',
          operator: 'contains',
          value: 'telekom',
          targetAccountNumber: '8400',
          flowType: 'any',
          active: true,
        }),
      );
    });
    await waitFor(() => {
      expect(onRulesChanged).toHaveBeenCalledTimes(1);
    });
  });

  it('supports toggling active status and editing existing rules', async () => {
    mockIpc.pro.listAccountSuggestionRules.mockResolvedValue([
      {
        id: 'rule-1',
        tenantId: 'default',
        chart: 'SKR03',
        priority: 5,
        field: 'purpose',
        operator: 'contains',
        value: 'hosting',
        targetAccountNumber: '4930',
        flowType: 'expense',
        active: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    mockIpc.pro.listLedgerAccounts.mockResolvedValue([
      {
        id: 'acc-4930',
        chart: 'SKR03',
        accountNumber: '4930',
        name: 'Buerobedarf',
        source: 'test',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'acc-4960',
        chart: 'SKR03',
        accountNumber: '4960',
        name: 'Fremdleistungen',
        source: 'test',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    renderModal();

    expect(await screen.findByText(/-> Konto 4930/i)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /Aktiv/i }));
    await waitFor(() => {
      expect(mockIpc.pro.upsertAccountSuggestionRule).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'rule-1', active: false }),
      );
    });

    await userEvent.click(screen.getByRole('button', { name: /Bearbeiten/i }));
    const valueInput = screen.getByDisplayValue('hosting');
    await userEvent.clear(valueInput);
    await userEvent.type(valueInput, 'aws');
    await userEvent.selectOptions(screen.getAllByRole('combobox')[2], '4960');
    await userEvent.click(screen.getByRole('button', { name: /Aktualisieren/i }));

    await waitFor(() => {
      expect(mockIpc.pro.upsertAccountSuggestionRule).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'rule-1',
          value: 'aws',
          targetAccountNumber: '4960',
        }),
      );
    });
  });
});
