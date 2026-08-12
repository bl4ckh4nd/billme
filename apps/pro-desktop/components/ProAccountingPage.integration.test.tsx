import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProAccountingPage } from './ProAccountingPage';

const {
  workspaceState,
  mockUseProLedgerStatsQuery,
  mockUseProLedgerAccountsQuery,
  mockUseAccountsQuery,
  mockUseImportSkrMutation,
  mockImportSkrMutateAsync,
  mockIpc,
  mockOnRulesChangedTrigger,
} = vi.hoisted(() => ({
  workspaceState: {
    lastProps: null as any,
  },
  mockUseProLedgerStatsQuery: vi.fn(),
  mockUseProLedgerAccountsQuery: vi.fn(),
  mockUseAccountsQuery: vi.fn(),
  mockImportSkrMutateAsync: vi.fn(async () => ({ imported: 1 })),
  mockUseImportSkrMutation: vi.fn(),
  mockOnRulesChangedTrigger: vi.fn(),
  mockIpc: {
    pro: {
      // Annotated so the empty defaults do not infer `never[]` / `null`, which
      // would reject the mockResolvedValue(...) overrides in the tests below.
      listBankTransactions: vi.fn(async (): Promise<any[]> => []),
      getDraftByTransactionId: vi.fn(async (_args?: any): Promise<any> => null),
      getSusaReport: vi.fn(async () => ({ totals: { balance: 0 } })),
      getGuvReport: vi.fn(async () => ({ netResult: 0 })),
      getBilanzReport: vi.fn(async () => ({ totals: { delta: 0 } })),
      getAccountingHealth: vi.fn(async () => ({ postedCount: 0, draftCount: 0 })),
      getAccountingPolicy: vi.fn(async () => ({ activeChart: 'SKR03' })),
      saveDraft: vi.fn(async () => ({ ok: true })),
      dispatchDraftAction: vi.fn(async () => ({
        id: 'draft-1',
        tenantId: 'default',
        transactionId: 'tx-1',
        workflowStatus: 'approved',
        postingDate: '2026-01-10',
        documentDate: '2026-01-10',
        bookingText: 'Buchung',
        reference: 'REF-1',
        lines: [],
        validationIssues: [],
        updatedAt: new Date().toISOString(),
      })),
      postDraft: vi.fn(async () => ({ issues: [] })),
      listJournalEntries: vi.fn(async () => []),
      reverseJournalEntry: vi.fn(async () => ({ ok: true })),
      listDatevExports: vi.fn(async () => []),
      exportDatevBuchungsstapel: vi.fn(async (args: any) => ({
        id: 'datev-1',
        filePath: '/exports/datev-1.CSV',
        recordCount: 0,
        fromDate: args.from,
        toDate: args.to,
        createdAt: new Date().toISOString(),
        sha256: 'hash',
      })),
    },
  },
}));

vi.mock('@billme/ui', () => ({
  Button: (props: any) => <button {...props}>{props.children}</button>,
}));

vi.mock('../ipc/client', () => ({
  ipc: mockIpc,
}));

vi.mock('../hooks/useProLedger', () => ({
  useProLedgerStatsQuery: mockUseProLedgerStatsQuery,
  useProLedgerAccountsQuery: mockUseProLedgerAccountsQuery,
  useImportSkrMutation: mockUseImportSkrMutation,
}));

vi.mock('../hooks/useAccounts', () => ({
  useAccountsQuery: mockUseAccountsQuery,
}));

vi.mock('@billme/accounting-ui-pro', () => ({
  ProAccountingWorkspace: (props: any) => {
    workspaceState.lastProps = props;
    return (
      <div data-testid="pro-accounting-workspace">
        <button
          onClick={async () => {
            try {
              await props.dataAdapter.dispatchBookingAction('tx-1', 'submit_for_review', { role: 'admin' });
            } catch {
              // The page renders the adapter error for the user.
            }
          }}
        >
          failing-action
        </button>
        <button
          onClick={async () => {
            await props.onPersistEntry({
              transaction: {
                id: 'tx-1',
              },
              draft: {
                id: 'draft-1',
                transactionId: 'tx-1',
                workflowStatus: 'suggested',
                postingDate: '2026-01-10',
                documentDate: '2026-01-10',
                bookingText: 'Telefonkosten',
                externalReference: 'TEL-1',
                validationIssues: [],
                lines: [
                  {
                    id: 'line-1',
                    accountId: '8400',
                    type: 'Soll',
                    amount: 119,
                  },
                  {
                    id: 'line-2',
                    accountId: '1200',
                    type: 'Haben',
                    amount: 119,
                  },
                ],
              },
            });
          }}
        >
          persist-entry
        </button>
      </div>
    );
  },
}));

vi.mock('./ProAccountRulesModal', () => ({
  ProAccountRulesModal: (props: any) => (
    <div data-testid="pro-rules-modal">
      <button
        onClick={() => {
          mockOnRulesChangedTrigger();
          props.onRulesChanged();
        }}
      >
        trigger-rules-changed
      </button>
      <button onClick={props.onClose}>close-rules</button>
    </div>
  ),
}));

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

describe('ProAccountingPage integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceState.lastProps = null;

    mockUseProLedgerStatsQuery.mockReturnValue({
      data: {
        total: 10,
        byChart: { SKR03: 10, SKR04: 0 },
      },
    });
    mockUseProLedgerAccountsQuery.mockReturnValue({
      data: [
        { accountNumber: '8400', name: 'Erloese', keywords: ['umsatz'] },
        { accountNumber: '1200', name: 'Bank', keywords: [] },
      ],
    });
    mockUseAccountsQuery.mockReturnValue({ data: [] });
    mockIpc.pro.getAccountingPolicy.mockResolvedValue({ activeChart: 'SKR03' });
    mockUseImportSkrMutation.mockReturnValue({
      mutateAsync: mockImportSkrMutateAsync,
      isPending: false,
    });
  });

  it('shows import CTA when no ledger chart exists and triggers import', async () => {
    mockUseProLedgerStatsQuery.mockReturnValue({
      data: { total: 0, byChart: { SKR03: 0, SKR04: 0 } },
    });

    render(<ProAccountingPage />, { wrapper: createWrapper() });

    expect(await screen.findByText(/Pro Kontenrahmen fehlt/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /SKR03\/04 importieren/i }));
    await waitFor(() => {
      expect(mockImportSkrMutateAsync).toHaveBeenCalledWith({ preferredSource: 'auto' });
    });
  });

  it('exposes a failed SKR import without leaving a pending action', async () => {
    mockUseProLedgerStatsQuery.mockReturnValue({
      data: { total: 0, byChart: { SKR03: 0, SKR04: 0 } },
    });
    mockImportSkrMutateAsync.mockRejectedValueOnce(new Error('Kontenrahmen-Backend nicht erreichbar'));

    render(<ProAccountingPage />, { wrapper: createWrapper() });

    await userEvent.click(await screen.findByRole('button', { name: /SKR03\/04 importieren/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Kontenrahmen-Backend nicht erreichbar');
    expect(screen.getByRole('button', { name: /SKR03\/04 importieren/i })).not.toHaveAttribute('aria-busy', 'true');
  });

  it('maps pro bookkeeping data into workspace seed and persists entries via IPC', async () => {
    mockIpc.pro.listBankTransactions.mockResolvedValueOnce([
      {
        id: 'tx-1',
        date: '2026-01-10',
        counterparty: 'Telekom',
        purpose: 'Telefon',
        amount: 119,
        status: 'booked',
        linkedInvoiceId: null,
        suggestedAccountNumber: '8400',
        suggestionConfidence: 0.91,
      },
      {
        id: 'tx-2',
        date: '2026-01-11',
        counterparty: 'Bestandskunde',
        purpose: 'Ausgleich',
        amount: 250,
        status: 'open',
        linkedInvoiceId: 'inv-2',
        suggestedAccountNumber: '1200',
        suggestionConfidence: 0.77,
      },
    ]);
    mockIpc.pro.getDraftByTransactionId.mockImplementation(async ({ transactionId }: { transactionId: string }) => {
      if (transactionId !== 'tx-1') return null;
      return {
        id: 'draft-1',
        tenantId: 'default',
        transactionId: 'tx-1',
        workflowStatus: 'posted',
        postingDate: '2026-01-10',
        documentDate: '2026-01-10',
        bookingText: 'Telefonkosten',
        reference: 'TEL-1',
        lines: [
          {
            id: 'line-1',
            accountNumber: '8400',
            debitAmount: 119,
            creditAmount: 0,
          },
        ],
        validationIssues: [],
        updatedAt: new Date().toISOString(),
      };
    });
    mockIpc.pro.getSusaReport.mockResolvedValueOnce({ totals: { balance: 15.5 } });
    mockIpc.pro.getGuvReport.mockResolvedValueOnce({ netResult: -10.25 });
    mockIpc.pro.getBilanzReport.mockResolvedValueOnce({ totals: { delta: 0 } });
    mockIpc.pro.getAccountingHealth.mockResolvedValueOnce({ postedCount: 4, draftCount: 2 });

    render(<ProAccountingPage />, { wrapper: createWrapper() });

    expect(await screen.findByTestId('pro-accounting-workspace')).toBeInTheDocument();
    await waitFor(() => {
      expect(workspaceState.lastProps?.seed?.transactions?.length).toBe(2);
    });

    expect(workspaceState.lastProps.seed.transactions[0].workflowStatus).toBe('posted');
    expect(workspaceState.lastProps.seed.transactions[1].workflowStatus).toBe('posted');
    expect(workspaceState.lastProps.seed.accounts[0]).toEqual(
      expect.objectContaining({ id: '8400', type: 'Revenue' }),
    );
    expect(workspaceState.lastProps.seed.accounts[1]).toEqual(
      expect.objectContaining({ id: '1200', keywords: ['Bank'] }),
    );
    expect(workspaceState.lastProps.seed.drafts).toHaveLength(1);
    expect(workspaceState.lastProps.seed.drafts[0].workflowStatus).toBe('posted');

    await userEvent.click(screen.getByRole('button', { name: 'persist-entry' }));
    await waitFor(() => {
      expect(mockIpc.pro.saveDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          draft: expect.objectContaining({
            id: 'draft-1',
            transactionId: 'tx-1',
            bookingText: 'Telefonkosten',
            lines: expect.arrayContaining([
              expect.objectContaining({ accountNumber: '8400', debitAmount: 119, creditAmount: 0 }),
              expect.objectContaining({ accountNumber: '1200', debitAmount: 0, creditAmount: 119 }),
            ]),
          }),
        }),
      );
    });
  });

  it('loads the active SKR04 catalog and carries a configured custom bank GL into the workspace', async () => {
    mockUseProLedgerStatsQuery.mockReturnValue({
      data: { total: 1, byChart: { SKR03: 0, SKR04: 1 } },
    });
    mockIpc.pro.getAccountingPolicy.mockResolvedValue({ activeChart: 'SKR04' });
    mockUseProLedgerAccountsQuery.mockReturnValue({
      data: [
        { id: 'skr04-1999', chart: 'SKR04', accountNumber: '1999', name: 'Geldtransit', keywords: ['Bankkonto'] },
        { id: 'skr04-7000', chart: 'SKR04', accountNumber: '7000', name: 'Erlöse custom', keywords: [] },
      ],
    });
    mockUseAccountsQuery.mockReturnValue({
      data: [{ id: 'bank-1', defaultSkrAccountNumber: '1999' }],
    });
    mockIpc.pro.listBankTransactions.mockResolvedValueOnce([
      {
        id: 'tx-skr04',
        accountId: 'bank-1',
        date: '2026-01-10',
        counterparty: 'Kunde',
        purpose: 'Zahlung',
        amount: 100,
        status: 'open',
        linkedInvoiceId: null,
      },
    ]);
    mockIpc.pro.getDraftByTransactionId.mockResolvedValueOnce({
      id: 'draft-skr04',
      tenantId: 'default',
      transactionId: 'tx-skr04',
      workflowStatus: 'suggested',
      postingDate: '2026-01-10',
      documentDate: '2026-01-10',
      bookingText: 'Zahlung',
      reference: 'TX-SKR04',
      lines: [
        { id: 'bank-line', accountNumber: '1999', debitAmount: 100, creditAmount: 0 },
        { id: 'counter-line', accountNumber: '7000', debitAmount: 0, creditAmount: 100 },
      ],
      validationIssues: [],
      updatedAt: new Date().toISOString(),
    });

    render(<ProAccountingPage />, { wrapper: createWrapper() });
    await waitFor(() => expect(workspaceState.lastProps?.seed?.chartFramework).toBe('SKR04'));
    expect(mockUseProLedgerAccountsQuery).toHaveBeenCalledWith(expect.objectContaining({ chart: 'SKR04' }));
    expect(workspaceState.lastProps.seed.bankAccountNumber).toBe('1999');
    expect(workspaceState.lastProps.seed.drafts[0].lines[0]).toEqual(
      expect.objectContaining({ accountId: '1999', accountName: 'Geldtransit' }),
    );
  });

  it('opens rules modal from pro page and handles rule-change callback flow', async () => {
    render(<ProAccountingPage />, { wrapper: createWrapper() });

    expect(await screen.findByTestId('pro-accounting-workspace')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Regeln/i }));
    expect(screen.getByTestId('pro-rules-modal')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'trigger-rules-changed' }));
    expect(mockOnRulesChangedTrigger).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous status and exposes failed adapter mutations', async () => {
    mockIpc.pro.listBankTransactions.mockResolvedValueOnce([
      {
        id: 'tx-1',
        date: '2026-01-10',
        counterparty: 'Telekom',
        purpose: 'Telefon',
        amount: -119,
        status: 'open',
        linkedInvoiceId: null,
      },
    ]);
    mockIpc.pro.getDraftByTransactionId.mockResolvedValue({
      id: 'draft-1',
      tenantId: 'default',
      transactionId: 'tx-1',
      workflowStatus: 'suggested',
      postingDate: '2026-01-10',
      documentDate: '2026-01-10',
      bookingText: 'Telefonkosten',
      reference: 'TEL-1',
      lines: [],
      validationIssues: [],
      updatedAt: new Date().toISOString(),
    });
    mockIpc.pro.dispatchDraftAction.mockRejectedValueOnce(new Error('Backend nicht erreichbar'));

    render(<ProAccountingPage />, { wrapper: createWrapper() });
    await screen.findByTestId('pro-accounting-workspace');
    await userEvent.click(screen.getByRole('button', { name: 'failing-action' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Backend nicht erreichbar');
    expect(workspaceState.lastProps.dataAdapter.getBookingDraftByTransactionId('tx-1')).toEqual(
      expect.objectContaining({ workflowStatus: 'suggested' }),
    );
  });

  it('wires DATEV export and immutable history through the productive IPC adapter', async () => {
    render(<ProAccountingPage />, { wrapper: createWrapper() });
    await screen.findByTestId('pro-accounting-workspace');

    await act(async () => {
      await workspaceState.lastProps.dataAdapter.listDatevExports(20);
    });
    expect(mockIpc.pro.listDatevExports).toHaveBeenCalledWith({ limit: 20 });

    await act(async () => {
      await workspaceState.lastProps.dataAdapter.exportDatevBuchungsstapel({
        from: '2026-03-01',
        to: '2026-03-31',
        consultantNumber: '1001',
        clientNumber: '1',
        fiscalYearStart: '2026-01-01',
        accountLength: 4,
        encoding: 'cp1252',
      });
    });
    expect(mockIpc.pro.exportDatevBuchungsstapel).toHaveBeenCalledWith(expect.objectContaining({
      from: '2026-03-01',
      accountLength: 4,
      encoding: 'cp1252',
    }));
  });
});
