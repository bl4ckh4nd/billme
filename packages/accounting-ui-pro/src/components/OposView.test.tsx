import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import OposView from './OposView';
import type { ProAccountingDataAdapter } from '../services/mockBookingStore';

const item = {
  id: 'open-1', tenantId: 'default', partyType: 'debtor' as const, partyId: 'client-1', sourceType: 'outgoing_invoice' as const,
  sourceId: 'invoice-1', documentNumber: 'RE-1', documentDate: '2026-08-01', dueDate: '2026-08-31', originalAmount: 119,
  allocatedAmount: 0, residualAmount: 119, status: 'open' as const, createdAt: '', updatedAt: '',
};

const baseAdapter = (): ProAccountingDataAdapter => ({
  listOpenItems: vi.fn(async () => [item]),
  listBankTransactions: vi.fn(async () => [{ id: 'bank-1', tenantId: 'default', accountId: 'account-1', bankAccountNumber: '1200', date: '2026-08-12', amount: 50, type: 'income' as const, counterparty: 'Kunde', purpose: 'RE-1', status: 'pending' as const }]),
  listVendors: vi.fn(async () => [{ id: 'vendor-1', tenantId: 'default', name: 'Lieferant', createdAt: '', updatedAt: '' }]),
  listIncomingInvoices: vi.fn(async () => []),
});

describe('OposView', () => {
  it('reuses one allocation event id when a partial allocation is retried', async () => {
    const adapter = baseAdapter();
    const allocate = vi.fn()
      .mockRejectedValueOnce(new Error('Netzwerkfehler'))
      .mockResolvedValue({ id: 'payment-1', tenantId: 'default', partyType: 'debtor', paymentDate: '2026-08-12', amount: 50, bankAccountNumber: '1200', sourceType: 'bank_transaction', sourceId: 'bank-1', allocatedAmount: 50, residualAmount: 0, status: 'allocated', createdAt: '' });
    adapter.allocateOpenItemPayment = allocate;
    render(<OposView dataAdapter={adapter} />);
    await screen.findByText('RE-1');
    fireEvent.click(screen.getByRole('button', { name: 'RE-1' }));
    fireEvent.change(screen.getByLabelText('Bankzahlung'), { target: { value: 'bank-1' } });
    fireEvent.change(screen.getAllByLabelText('Begründung', { selector: 'input' })[0], { target: { value: 'Kontoauszug geprüft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Zahlung zuordnen' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Zahlung zuordnen' }));
    await waitFor(() => expect(allocate).toHaveBeenCalledTimes(2));
    expect(allocate.mock.calls[0][0]).toMatchObject({ sourceId: 'bank-1', paymentDate: '2026-08-12', amount: 50, bankAccountNumber: '1200' });
    expect(allocate.mock.calls[0][0].allocationEventId).toBe(allocate.mock.calls[1][0].allocationEventId);
  });

  it('saves and posts an incoming invoice, then refreshes the canonical lists', async () => {
    const adapter = baseAdapter();
    const invoices: any[] = [];
    adapter.listIncomingInvoices = vi.fn(async () => invoices);
    const saved = vi.fn(async (invoice) => invoice);
    const posted = vi.fn(async () => ({ sourceType: 'incoming_invoice' as const, sourceId: 'incoming-1', status: 'ready' as const, issues: [] }));
    adapter.upsertIncomingInvoice = vi.fn(async (invoice) => { invoices.push(invoice); return saved(invoice); });
    adapter.upsertVendor = vi.fn(async (vendor) => ({ ...vendor, tenantId: 'default', createdAt: '', updatedAt: '' }));
    adapter.previewIncomingInvoiceAccounting = vi.fn(async () => ({ sourceType: 'incoming_invoice' as const, sourceId: 'incoming-1', status: 'ready' as const, issues: [] }));
    adapter.postIncomingInvoiceAccounting = posted;
    render(<OposView dataAdapter={adapter} />);
    await screen.findByText('RE-1');
    fireEvent.change(screen.getByLabelText('Rechnungsnummer'), { target: { value: 'ER-1' } });
    fireEvent.change(screen.getByLabelText('Kreditorname'), { target: { value: 'Neue GmbH' } });
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: 'Hosting' } });
    fireEvent.change(screen.getByLabelText('Netto'), { target: { value: '100' } });
    fireEvent.change(screen.getAllByLabelText('Begründung', { selector: 'input' })[1], { target: { value: 'Eingangsbeleg geprüft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    await screen.findByRole('option', { name: /ER-1/ });
    fireEvent.click(screen.getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(posted).toHaveBeenCalledTimes(1));
    expect(adapter.listIncomingInvoices).toHaveBeenCalledTimes(3);
  });
});
