import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DocumentEditor } from '@billme/desktop-designer/document-editor';
import { INITIAL_INVOICE_TEMPLATE } from '@billme/desktop-core/constants';
import { MOCK_SETTINGS } from '@billme/desktop-services/mockData';
import type { DocumentDraft } from '@billme/desktop-designer/document-editor';

const documentFixture = (overrides: Partial<DocumentDraft> = {}): DocumentDraft => ({
  id: 'invoice-1',
  number: 'RE-2026-001',
  date: '2026-08-06',
  dueDate: '2026-08-20',
  client: '',
  clientEmail: '',
  amount: 0,
  items: [],
  ...overrides,
});

const editor = (document = documentFixture(), onSave = vi.fn(), templateType: 'invoice' | 'offer' = 'invoice') => (
  <DocumentEditor
    document={document}
    templateType={templateType}
    mode="edit"
    clients={[{
      id: 'client-1',
      company: 'Nord GmbH',
      customerNumber: 'KD-001',
      emails: [{ email: 'billing@nord.example' }],
      addresses: [{ company: 'Nord GmbH', street: 'Hafenstraße 4', zip: '20095', city: 'Hamburg', country: 'Deutschland', isDefaultBilling: true, isDefaultShipping: true }],
    }]}
    articles={[{
      id: 'article-1',
      sku: 'UPD-1',
      title: 'Aktualisierte Leistung',
      description: 'Nachträgliche Korrektur',
      price: 125,
      unit: 'Std',
      category: 'Beratung',
      taxRate: 7,
    }]}
    projects={[]}
    settings={MOCK_SETTINGS}
    templateElements={INITIAL_INVOICE_TEMPLATE}
    onSave={onSave}
    onCancel={() => {}}
  />
);

const renderEditor = (document = documentFixture(), onSave = vi.fn(), templateType: 'invoice' | 'offer' = 'invoice') => render(
  editor(document, onSave, templateType),
);

describe('document-first invoice editor', () => {
  it('searches customer email/address fields and keeps the selected address as a snapshot', async () => {
    const user = userEvent.setup();
    renderEditor();

    const customer = screen.getByRole('combobox', { name: 'Kunde auswählen' });
    await user.click(customer);
    await user.clear(customer);
    await user.type(customer, 'Hafenstrasse');
    await user.click(await screen.findByRole('option', { name: /Nord GmbH/ }));

    expect(screen.getByRole('textbox', { name: 'Rechnungsadresse' })).toHaveValue('Hafenstraße 4\n20095 Hamburg\nDE');
    expect(screen.getByRole('textbox', { name: 'E-Mail' })).toHaveValue('billing@nord.example');
  });

  it('returns from preview to the editor and focuses the first validation error', async () => {
    const user = userEvent.setup();
    renderEditor();

    await user.click(screen.getByRole('button', { name: 'Vorschau' }));
    expect(screen.getByTestId('document-preview')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Speichern' }));

    expect(screen.getByTestId('document-editor')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Pflichtfelder');
    expect(screen.getByRole('textbox', { name: 'Empfängername' })).toHaveFocus();
  });

  it('persists later recipient and structured billing-address corrections consistently', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderEditor(documentFixture({
      client: 'Nord GmbH',
      clientId: 'client-1',
      clientAddress: 'Hafenstraße 4\n20095 Hamburg\nDE',
      billingAddressJson: { company: 'Nord GmbH', street: 'Hafenstraße 4', zip: '20095', city: 'Hamburg', country: 'DE' },
    }), onSave);

    const name = screen.getByRole('textbox', { name: 'Empfängername' });
    await user.clear(name);
    await user.type(name, 'Nord Tochter GmbH');
    const address = screen.getByRole('textbox', { name: 'Rechnungsadresse' });
    await user.clear(address);
    await user.type(address, 'Neue Straße 5{Enter}10115 Berlin{Enter}Deutschland');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));

    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      client: 'Nord Tochter GmbH',
      clientAddress: 'Neue Straße 5\n10115 Berlin\nDeutschland',
      billingAddressJson: {
        company: 'Nord Tochter GmbH',
        street: 'Neue Straße 5',
        line2: '',
        zip: '10115',
        city: 'Berlin',
        country: 'DE',
      },
    });
  });

  it('updates an existing line item and keeps edits across preview before saving', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderEditor(documentFixture({
      client: 'Nord GmbH',
      items: [{ description: 'Alte Leistung', quantity: 1, price: 10, total: 10, taxRate: 19 }],
    }), onSave);

    const description = screen.getByRole('combobox', { name: 'Beschreibung Position 1' });
    await user.clear(description);
    await user.type(description, 'Aktualisierte');
    await user.click(await screen.findByRole('option', { name: /Aktualisierte Leistung/ }));
    const quantity = screen.getByRole('spinbutton', { name: 'Menge' });
    await user.clear(quantity);
    await user.type(quantity, '2');
    await user.click(screen.getByRole('button', { name: 'Vorschau' }));
    await user.click(screen.getByRole('button', { name: 'Bearbeiten' }));
    expect(screen.getByRole('combobox', { name: 'Beschreibung Position 1' })).toHaveValue('Aktualisierte Leistung');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));

    expect(onSave.mock.calls[0]![0].items[0]).toMatchObject({
      articleId: 'article-1',
      description: 'Aktualisierte Leistung',
      quantity: 2,
      price: 125,
      total: 250,
      taxRate: 7,
    });
  });

  it('resets history and customer state when another document replaces the open one', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const first = documentFixture({ client: 'Erster Kunde', clientId: 'client-1' });
    const second = documentFixture({ id: 'invoice-2', number: 'RE-2026-002', client: 'Zweiter Kunde', clientId: undefined });
    const view = renderEditor(first, onSave);

    await user.clear(screen.getByRole('textbox', { name: 'Empfängername' }));
    await user.type(screen.getByRole('textbox', { name: 'Empfängername' }), 'Lokale Änderung');
    view.rerender(editor(second, onSave));

    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Empfängername' })).toHaveValue('Zweiter Kunde'));
    expect(screen.queryByText('Ungespeichert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ id: 'invoice-2', number: 'RE-2026-002', client: 'Zweiter Kunde' });
  });

  it('uses offer-specific labels without introducing a second editor', () => {
    renderEditor(documentFixture({ number: 'AN-2026-001' }), vi.fn(), 'offer');
    expect(screen.getByRole('heading', { name: 'Angebot bearbeiten' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Gültig bis' })).toBeInTheDocument();
  });
});
