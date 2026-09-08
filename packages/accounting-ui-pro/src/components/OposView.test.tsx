import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  afterEach(() => cleanup());

  it('renders viewer OPOS as read-only before the server authorization boundary', async () => {
    const adapter = baseAdapter();
    render(<OposView dataAdapter={adapter} role="viewer" />);
    await screen.findByText('RE-1');
    expect(screen.getByText('Diese Rolle kann OPOS-Daten nur lesen.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Zahlung zuordnen' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Entwurf speichern' }).hasAttribute('disabled')).toBe(true);
  });

  it('gives the stored-document combobox an accessible name', async () => {
    const adapter = baseAdapter();
    render(<OposView dataAdapter={adapter} />);
    await screen.findByText('RE-1');
    expect(screen.getByRole('combobox', { name: 'Gespeicherten Beleg wählen' })).toBeTruthy();
  });

  it('summarizes and focuses the first invalid incoming-invoice field on empty submit', async () => {
    const adapter = baseAdapter();
    adapter.upsertIncomingInvoice = vi.fn();
    render(<OposView dataAdapter={adapter} />);
    await screen.findByText('RE-1');

    fireEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));

    const invoiceNumber = screen.getByLabelText('Rechnungsnummer');
    expect(document.activeElement).toBe(invoiceNumber);
    expect(invoiceNumber.getAttribute('aria-invalid')).toBe('true');
    expect(invoiceNumber.getAttribute('aria-describedby')).toBe('opos-invoice-number-error');
    expect(screen.getAllByText('Rechnungsnummer ist erforderlich.').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('alert').some((entry) => entry.textContent?.includes('Bitte prüfe die markierten Felder.'))).toBe(true);
    expect(adapter.upsertIncomingInvoice).not.toHaveBeenCalled();
  });

  it('summarizes and focuses the first invalid payment-assignment target on empty submit', async () => {
    const adapter = baseAdapter();
    adapter.allocateOpenItemPayment = vi.fn();
    render(<OposView dataAdapter={adapter} />);
    await screen.findByText('RE-1');

    fireEvent.click(screen.getByRole('button', { name: 'Zahlung zuordnen' }));

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'RE-1' }));
    expect(screen.getByRole('combobox', { name: 'Bankzahlung' }).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getAllByRole('alert').some((entry) => entry.textContent?.includes('Bitte prüfe die markierten Felder.'))).toBe(true);
    expect(adapter.allocateOpenItemPayment).not.toHaveBeenCalled();
  });

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
    adapter.upsertIncomingInvoice = vi.fn(async (invoice) => {
      const index = invoices.findIndex((item) => item.id === invoice.id);
      if (index < 0) invoices.push(invoice);
      else invoices[index] = invoice;
      return saved(invoice);
    });
    adapter.upsertVendor = vi.fn(async (vendor) => ({ ...vendor, tenantId: 'default', createdAt: '', updatedAt: '' }));
    adapter.previewIncomingInvoiceAccounting = vi.fn(async () => ({ sourceType: 'incoming_invoice' as const, sourceId: 'incoming-1', status: 'ready' as const, issues: [] }));
    adapter.postIncomingInvoiceAccounting = posted;
    render(<OposView dataAdapter={adapter} />);
    await screen.findByText('RE-1');
    fireEvent.change(screen.getByLabelText('Rechnungsnummer'), { target: { value: 'ER-1' } });
    fireEvent.change(screen.getByLabelText('Kreditorname'), { target: { value: 'Neue GmbH' } });
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: 'Hosting' } });
    fireEvent.change(screen.getByLabelText('Einzelpreis'), { target: { value: '100' } });
    fireEvent.change(screen.getAllByLabelText('Begründung', { selector: 'input' })[1], { target: { value: 'Eingangsbeleg geprüft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(1));
    await screen.findByRole('option', { name: /ER-1/ });
    expect(invoices[0].status).toBe('draft');
    expect(screen.getByRole('button', { name: 'Buchen' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Für Buchung freigeben' }));
    await waitFor(() => expect(saved).toHaveBeenCalledTimes(2));
    expect(invoices[0].status).toBe('open');
    expect(adapter.upsertIncomingInvoice).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: invoices[0].id, status: 'open' }), 'Eingangsbeleg geprüft');
    expect(screen.getByRole('status').textContent).toContain('zur Buchung freigegeben');
    expect(screen.getByRole('button', { name: 'Buchen' }).hasAttribute('disabled')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Buchen' }));
    await waitFor(() => expect(posted).toHaveBeenCalledTimes(1));
    expect(posted).toHaveBeenCalledWith(invoices[0].id, { reason: 'Eingangsbeleg geprüft', softLockOverride: false, overrideReason: undefined });
    expect(adapter.listIncomingInvoices).toHaveBeenCalledTimes(4);
  });

  it('replaces a successful invoice save with the next validation error', async () => {
    const adapter = baseAdapter();
    adapter.upsertIncomingInvoice = vi.fn(async (invoice) => invoice);
    render(<OposView dataAdapter={adapter} />);
    await screen.findByText('RE-1');
    fireEvent.change(screen.getByLabelText('Rechnungsnummer'), { target: { value: 'ER-REPLACE-1' } });
    fireEvent.change(screen.getByLabelText('Kreditor'), { target: { value: 'vendor-1' } });
    fireEvent.change(screen.getByLabelText('Position'), { target: { value: 'Hosting' } });
    fireEvent.change(screen.getByLabelText('Einzelpreis'), { target: { value: '100' } });
    fireEvent.change(screen.getAllByLabelText('Begründung', { selector: 'input' })[1]!, { target: { value: 'Eingangsbeleg geprüft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));
    await waitFor(() => expect(screen.getByTestId('opos-feedback').textContent).toContain('Eingangsrechnung als Entwurf gespeichert.'));

    fireEvent.change(screen.getByLabelText('Rechnungsnummer'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));

    const feedback = await screen.findByTestId('opos-feedback');
    expect(screen.getAllByTestId('opos-feedback')).toHaveLength(1);
    expect(feedback.getAttribute('role')).toBe('alert');
    expect(feedback.getAttribute('aria-live')).toBe('assertive');
    expect(feedback.textContent).toContain('Rechnungsnummer, mindestens eine Position und Begründung sind Pflichtfelder.');
  });

  it('sends multiple incoming lines with independent tax rates and account assignments', async () => {
    const adapter = baseAdapter();
    const invoices: any[] = [];
    adapter.listIncomingInvoices = vi.fn(async () => invoices);
    adapter.upsertIncomingInvoice = vi.fn(async (invoice) => {
      invoices.push(invoice);
      return invoice;
    });
    render(<OposView dataAdapter={adapter} />);
    await screen.findByText('RE-1');
    fireEvent.change(screen.getByLabelText('Rechnungsnummer'), { target: { value: 'ER-MIXED-1' } });
    fireEvent.change(screen.getByLabelText('Kreditor'), { target: { value: 'vendor-1' } });
    const positions = screen.getAllByLabelText('Position');
    fireEvent.change(positions[0]!, { target: { value: 'Hosting' } });
    fireEvent.change(screen.getAllByLabelText('Einzelpreis')[0]!, { target: { value: '100' } });
    fireEvent.change(screen.getAllByLabelText('Steuersatz')[0]!, { target: { value: '19' } });
    fireEvent.change(screen.getAllByLabelText('Konto')[0]!, { target: { value: '4900' } });
    fireEvent.change(screen.getAllByLabelText('Anlagekonto')[0]!, { target: { value: '0480' } });
    fireEvent.click(screen.getByRole('button', { name: 'Position hinzufügen' }));
    fireEvent.change(screen.getAllByLabelText('Position')[1]!, { target: { value: 'Support' } });
    fireEvent.change(screen.getAllByLabelText('Menge')[1]!, { target: { value: '2' } });
    fireEvent.change(screen.getAllByLabelText('Einzelpreis')[1]!, { target: { value: '50' } });
    fireEvent.change(screen.getAllByLabelText('Steuersatz')[1]!, { target: { value: '7' } });
    fireEvent.change(screen.getAllByLabelText('Konto')[1]!, { target: { value: '4950' } });
    fireEvent.change(screen.getAllByLabelText('Begründung', { selector: 'input' })[1]!, { target: { value: 'Eingangsbeleg geprüft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));

    await waitFor(() => expect(adapter.upsertIncomingInvoice).toHaveBeenCalledTimes(1));
    const saved = adapter.upsertIncomingInvoice.mock.calls[0][0];
    expect(saved).toMatchObject({ netAmount: 200, taxAmount: 26, grossAmount: 226 });
    expect(saved.lines).toEqual([
      expect.objectContaining({ description: 'Hosting', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 19, taxAmount: 19, grossAmount: 119, accountNumber: '4900', assetAccountNumber: '0480' }),
      expect.objectContaining({ description: 'Support', quantity: 2, unitPrice: 50, netAmount: 100, taxRate: 7, taxAmount: 7, grossAmount: 107, accountNumber: '4950' }),
    ]);
    expect(screen.getByTestId('incoming-invoice-summary').textContent).toContain('2 Positionen gespeichert');
    expect(screen.getByTestId('incoming-invoice-summary').textContent).toContain('7% 7,00 €');
    expect(screen.getByTestId('incoming-invoice-summary').textContent).toContain('19% 19,00 €');
  });

  it('blocks empty or invalid incoming invoice rows before persistence', async () => {
    const adapter = baseAdapter();
    adapter.upsertIncomingInvoice = vi.fn(async (invoice) => invoice);
    render(<OposView dataAdapter={adapter} />);
    await screen.findByText('RE-1');
    fireEvent.change(screen.getByLabelText('Rechnungsnummer'), { target: { value: 'ER-INVALID-1' } });
    fireEvent.change(screen.getByLabelText('Kreditor'), { target: { value: 'vendor-1' } });
    fireEvent.change(screen.getAllByLabelText('Position')[0]!, { target: { value: 'Hosting' } });
    fireEvent.change(screen.getAllByLabelText('Einzelpreis')[0]!, { target: { value: '100' } });
    fireEvent.change(screen.getAllByLabelText('Begründung', { selector: 'input' })[1]!, { target: { value: 'Eingangsbeleg geprüft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Position hinzufügen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Entwurf speichern' }));

    expect(screen.getAllByRole('alert').some((entry) => entry.textContent?.includes('Position 2: Beschreibung ist erforderlich.'))).toBe(true);
    expect(adapter.upsertIncomingInvoice).not.toHaveBeenCalled();
  });

  it('archives and downloads an original for a saved incoming invoice', async () => {
    const adapter = baseAdapter();
    const invoice = {
      id: 'incoming-1', tenantId: 'default', vendorId: 'vendor-1', number: 'ER-1',
      invoiceDate: '2026-08-01', dueDate: '2026-08-31', netAmount: 100, taxAmount: 19,
      grossAmount: 119, taxRate: 19, status: 'open' as const, accountingStatus: 'unposted' as const,
      lines: [], createdAt: '', updatedAt: '',
    };
    const document = {
      id: 'incoming-document-1', tenantId: 'default', incomingInvoiceId: invoice.id,
      originalFilename: 'rechnung.pdf', mimeType: 'application/pdf' as const, byteLength: 3,
      sha256: 'a'.repeat(64), reviewStatus: 'pending' as const, createdAt: '', updatedAt: '',
    };
    adapter.listIncomingInvoices = vi.fn(async () => [invoice]);
    adapter.listIncomingInvoiceDocuments = vi.fn(async () => []);
    adapter.uploadIncomingInvoiceDocument = vi.fn(async () => document);
    adapter.downloadIncomingInvoiceDocument = vi.fn(async () => ({ document, data: 'cGRm' }));
    adapter.reviewIncomingInvoiceDocument = vi.fn(async ({ reviewStatus }) => ({ ...document, reviewStatus }));
    render(<OposView dataAdapter={adapter} />);
    await screen.findByRole('option', { name: /ER-1/ });
    fireEvent.change(screen.getByRole('combobox', { name: 'Gespeicherten Beleg wählen' }), { target: { value: invoice.id } });
    const file = new File(['pdf'], document.originalFilename, { type: document.mimeType });
    fireEvent.change(screen.getByLabelText('Datei archivieren'), { target: { files: [file] } });
    fireEvent.change(screen.getAllByLabelText('Begründung', { selector: 'input' })[1], { target: { value: 'Original geprüft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Original archivieren' }));
    await screen.findByText(document.originalFilename);
    expect(screen.getByText('Ausstehend')).toBeTruthy();
    expect(adapter.uploadIncomingInvoiceDocument).toHaveBeenCalledWith(expect.objectContaining({
      invoiceId: invoice.id,
      originalFilename: document.originalFilename,
      mimeType: document.mimeType,
      data: 'cGRm',
      reason: 'Original geprüft',
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Als geprüft markieren' }));
    await waitFor(() => expect(adapter.reviewIncomingInvoiceDocument).toHaveBeenCalledWith({ documentId: document.id, reviewStatus: 'accepted', reason: 'Original geprüft' }));
    expect(screen.getByText('Geprüft')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Herunterladen' }));
    await waitFor(() => expect(adapter.downloadIncomingInvoiceDocument).toHaveBeenCalledWith(document.id));
  });

  it('clears an oversized original selection after client-side rejection', async () => {
    const adapter = baseAdapter();
    const invoice = {
      id: 'incoming-oversized', tenantId: 'default', vendorId: 'vendor-1', number: 'ER-OVERSIZED',
      invoiceDate: '2026-08-01', dueDate: '2026-08-31', netAmount: 100, taxAmount: 19,
      grossAmount: 119, taxRate: 19, status: 'open' as const, accountingStatus: 'unposted' as const,
      lines: [], createdAt: '', updatedAt: '',
    };
    adapter.listIncomingInvoices = vi.fn(async () => [invoice]);
    adapter.listIncomingInvoiceDocuments = vi.fn(async () => []);
    adapter.uploadIncomingInvoiceDocument = vi.fn();
    render(<OposView dataAdapter={adapter} />);
    await screen.findByRole('option', { name: /ER-OVERSIZED/ });
    fireEvent.change(screen.getByRole('combobox', { name: 'Gespeicherten Beleg wählen' }), { target: { value: invoice.id } });
    fireEvent.change(screen.getAllByLabelText('Begründung', { selector: 'input' })[1], { target: { value: 'Größenprüfung' } });
    const input = screen.getByLabelText('Datei archivieren') as HTMLInputElement;
    const oversized = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'too-large.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [oversized] } });
    fireEvent.click(screen.getByRole('button', { name: 'Original archivieren' }));
    await screen.findByText('Originalbelege dürfen höchstens 10 MiB groß sein.');
    expect(input.value).toBe('');
    expect(adapter.uploadIncomingInvoiceDocument).not.toHaveBeenCalled();
  });

  it('localizes OPOS statuses, invoice states, and incoming-document errors', async () => {
    const adapter = baseAdapter();
    const statuses = ['open', 'partially_paid', 'paid', 'overpaid', 'unresolved'] as const;
    adapter.listOpenItems = vi.fn(async () => statuses.map((status, index) => ({
      ...item,
      id: `open-${status}`,
      documentNumber: `RE-${index + 1}`,
      status,
    })));
    const invoice = {
      id: 'incoming-localized', tenantId: 'default', vendorId: 'vendor-1', number: 'ER-LOCALIZED',
      invoiceDate: '2026-08-01', dueDate: '2026-08-31', netAmount: 100, taxAmount: 19,
      grossAmount: 119, taxRate: 19, status: 'open' as const, accountingStatus: 'unposted' as const,
      lines: [], createdAt: '', updatedAt: '',
    };
    adapter.listIncomingInvoices = vi.fn(async () => [invoice]);
    adapter.listIncomingInvoiceDocuments = vi.fn(async () => []);
    adapter.uploadIncomingInvoiceDocument = vi.fn()
      .mockRejectedValueOnce(new Error('INCOMING_INVOICE_DOCUMENT_DUPLICATE: technische Zusatzinformation'))
      .mockRejectedValueOnce(new Error('INCOMING_INVOICE_DOCUMENT_CONTENT_MISMATCH'));
    render(<OposView dataAdapter={adapter} />);
    await screen.findByText('RE-1');
    expect(screen.getByText('Teilweise bezahlt')).toBeTruthy();
    expect(screen.getByText('Bezahlt')).toBeTruthy();
    expect(screen.getByText('Überzahlt')).toBeTruthy();
    expect(screen.getByText('Ungeklärt')).toBeTruthy();
    expect(screen.getByRole('option', { name: 'ER-LOCALIZED · Offen · Nicht gebucht' })).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: 'Gespeicherten Beleg wählen' }), { target: { value: invoice.id } });
    fireEvent.change(screen.getAllByLabelText('Begründung', { selector: 'input' })[1], { target: { value: 'Original geprüft' } });
    const input = screen.getByLabelText('Datei archivieren');
    const upload = screen.getByRole('button', { name: 'Original archivieren' });
    const file = new File(['%PDF-1.7'], 'rechnung.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(upload);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Diese Datei ist im Mandanten bereits als Originalbeleg archiviert.'));
    expect(screen.queryByText(/INCOMING_INVOICE_DOCUMENT_/)).toBeNull();

    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(upload);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Der Dateiinhalt passt nicht zum angegebenen Dateityp.'));
    expect(screen.queryByText(/INCOMING_INVOICE_DOCUMENT_/)).toBeNull();
  });
});
