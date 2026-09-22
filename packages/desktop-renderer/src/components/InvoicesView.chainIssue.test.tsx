import React from 'react';
import '@testing-library/jest-dom/vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FeedbackProvider } from '@billme/ui';
import type { Invoice } from '@billme/desktop-core/types';
import { MOCK_SETTINGS } from '@billme/desktop-services/mockData';

const mocks = vi.hoisted(() => ({
  chainIssue: vi.fn(),
  reserve: vi.fn(),
  finalize: vi.fn(),
  release: vi.fn(),
  upsert: vi.fn(),
  invoices: [] as Invoice[],
  invoicesRefetch: vi.fn(),
  offersRefetch: vi.fn(),
  settingsRefetch: vi.fn(),
}));

const sourceInvoice: Invoice = {
  id: 'inv-1',
  clientId: 'c1',
  number: 'RE-2026-0001',
  client: 'Acme GmbH',
  clientEmail: 'billing@acme.test',
  date: '2026-09-01',
  dueDate: '2026-09-15',
  servicePeriod: '2026-09',
  taxMode: 'standard_vat',
  amount: 100,
  status: 'open',
  dunningLevel: 0,
  documentKind: 'invoice',
  items: [{ description: 'Beratung', quantity: 1, price: 100, total: 100 }],
  payments: [],
  history: [],
};

const issuedDocument: Invoice = {
  ...sourceInvoice,
  id: 'credit-1',
  documentKind: 'credit_note',
  sourceDocumentId: 'inv-1',
  rootDocumentId: 'inv-1',
  number: 'GS-2026-0001',
  amount: 50,
};

vi.mock('../hooks/useInvoices', () => ({
  useInvoicesQuery: () => ({ data: mocks.invoices, isLoading: false, isError: false, refetch: mocks.invoicesRefetch }),
  useUpsertInvoiceMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useDeleteInvoiceMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('../hooks/useOffers', () => ({
  useOffersQuery: () => ({ data: [], isLoading: false, isError: false, refetch: mocks.offersRefetch }),
  useUpsertOfferMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
  useDeleteOfferMutation: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock('../hooks/useSettings', () => ({
  useSettingsQuery: () => ({ data: MOCK_SETTINGS, isError: false, refetch: mocks.settingsRefetch }),
}));
vi.mock('../runtime-api', () => ({
  ipc: {
    documents: { chainIssue: mocks.chainIssue },
    numbers: { reserve: mocks.reserve, finalize: mocks.finalize, release: mocks.release },
    invoices: { upsert: mocks.upsert },
  },
  getRendererRuntime: () => ({}),
}));

import { DocumentsView } from './InvoicesView';

const renderView = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <FeedbackProvider>
        <DocumentsView
          onOpenTemplates={vi.fn()}
          onOpenRecurring={vi.fn()}
          onEditInvoice={vi.fn()}
          onCreateInvoice={vi.fn()}
          initialDocumentType="invoice"
          initialSelectedId="inv-1"
        />
      </FeedbackProvider>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
};

const confirmCreditNote = async (user: UserEvent, amount: string) => {
  await user.click(screen.getByRole('button', { name: 'Gutschrift' }));
  await user.clear(screen.getByLabelText('Betrag (EUR)'));
  await user.type(screen.getByLabelText('Betrag (EUR)'), amount);
  await user.click(screen.getByRole('button', { name: 'Gutschrift erstellen' }));
};

describe('InvoicesView chain issuance', () => {
  beforeEach(() => {
    mocks.chainIssue.mockReset();
    mocks.reserve.mockReset();
    mocks.finalize.mockReset();
    mocks.release.mockReset();
    mocks.upsert.mockReset();
    mocks.invoicesRefetch.mockReset();
    mocks.offersRefetch.mockReset();
    mocks.settingsRefetch.mockReset();
    mocks.invoices.splice(0, mocks.invoices.length, { ...sourceInvoice });
  });

  it('issues exactly one correction and never touches the legacy number flow', async () => {
    const user = userEvent.setup();
    mocks.chainIssue.mockResolvedValue(issuedDocument);
    renderView();

    await confirmCreditNote(user, '50');

    await waitFor(() => expect(mocks.chainIssue).toHaveBeenCalledOnce());
    expect(mocks.chainIssue).toHaveBeenCalledWith({
      id: expect.any(String),
      operation: 'correction',
      kind: 'credit_note',
      invoiceId: 'inv-1',
      amount: 50,
      date: expect.any(String),
      reason: 'Gutschrift erstellt',
    });
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('does not issue a second document while the first call is pending', async () => {
    const user = userEvent.setup();
    let resolveIssue: (document: Invoice) => void = () => undefined;
    mocks.chainIssue.mockImplementation(() => new Promise<Invoice>((resolve) => {
      resolveIssue = resolve;
    }));
    renderView();

    await confirmCreditNote(user, '50');
    expect(mocks.chainIssue).toHaveBeenCalledOnce();

    const toolbarButton = screen.getByRole('button', { name: 'Gutschrift' });
    expect(toolbarButton).toBeDisabled();
    await user.click(toolbarButton);
    expect(mocks.chainIssue).toHaveBeenCalledOnce();

    resolveIssue(issuedDocument);
    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument());
  });

  it('reuses the operation id after a rejection and starts a new one when the intent changes', async () => {
    const user = userEvent.setup();
    mocks.chainIssue
      .mockRejectedValueOnce(new Error('netzwerk'))
      .mockRejectedValueOnce(new Error('netzwerk'))
      .mockResolvedValue(issuedDocument);
    renderView();

    await confirmCreditNote(user, '50');
    await waitFor(() => expect(mocks.chainIssue).toHaveBeenCalledTimes(1));
    await confirmCreditNote(user, '50');
    await waitFor(() => expect(mocks.chainIssue).toHaveBeenCalledTimes(2));
    await confirmCreditNote(user, '60');
    await waitFor(() => expect(mocks.chainIssue).toHaveBeenCalledTimes(3));

    const first = mocks.chainIssue.mock.calls[0]?.[0];
    const second = mocks.chainIssue.mock.calls[1]?.[0];
    const third = mocks.chainIssue.mock.calls[2]?.[0];
    expect(second).toMatchObject({ id: first?.id });
    expect(third.id).not.toBe(first.id);
    expect(third).toMatchObject({ amount: 60 });
  });

  it('does not seed the invoices cache before the issue resolves', async () => {
    const user = userEvent.setup();
    let resolveIssue: (document: Invoice) => void = () => undefined;
    mocks.chainIssue.mockImplementation(() => new Promise<Invoice>((resolve) => {
      resolveIssue = resolve;
    }));
    const { queryClient } = renderView();
    expect(queryClient.getQueryData(['invoices'])).toBeUndefined();

    await confirmCreditNote(user, '50');
    expect(mocks.chainIssue).toHaveBeenCalledOnce();
    expect(queryClient.getQueryData(['invoices'])).toBeUndefined();

    resolveIssue(issuedDocument);
    await waitFor(() => {
      const cached = queryClient.getQueryData<Invoice[]>(['invoices']);
      expect(cached?.[0]?.id).toBe('credit-1');
    });
  });
});
