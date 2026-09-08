import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DocumentEditor } from '@billme/desktop-designer/document-editor';
import { INITIAL_INVOICE_TEMPLATE } from '@billme/desktop-core/constants';
import { DEFAULT_SETTINGS, MOCK_SETTINGS } from '@billme/desktop-services/mockData';
import { appSettingsSchema as liteAppSettingsSchema } from '@billme/desktop-contracts/schemas';
import { appSettingsSchema as proAppSettingsSchema } from '@billme/desktop-contracts-pro/schemas';
import { invoiceSchema } from '@billme/server-core';
import { shouldShowBusinessOnboarding } from '@billme/ui';
import type { DocumentDraft, ClientLike, ProjectLike } from '@billme/desktop-designer/document-editor';

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

type EditorOptions = {
  settings?: typeof MOCK_SETTINGS;
  clients?: ClientLike[];
  projects?: ProjectLike[];
  onValidateVatId?: (args: { countryCode: string; vatNumber: string }) => Promise<{ status: 'valid' | 'invalid' | 'unavailable'; normalizedVatId: string; checkedAt: string }>;
  onSelectedClientChange?: (clientId: string) => void;
};

const editor = (document = documentFixture(), onSave = vi.fn(), templateType: 'invoice' | 'offer' = 'invoice', options: EditorOptions = {}) => (
  <DocumentEditor
    document={document}
    templateType={templateType}
    mode="edit"
    clients={options.clients ?? [{
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
    projects={options.projects ?? []}
    settings={options.settings ?? MOCK_SETTINGS}
    templateElements={INITIAL_INVOICE_TEMPLATE}
    onValidateVatId={options.onValidateVatId}
    onSelectedClientChange={options.onSelectedClientChange}
    onSave={onSave}
    onCancel={() => {}}
  />
);

const renderEditor = (document = documentFixture(), onSave = vi.fn(), templateType: 'invoice' | 'offer' = 'invoice', options: EditorOptions = {}) => render(
  editor(document, onSave, templateType, options),
);

describe('document-first invoice editor', () => {
  it('keeps the neutral default valid for both settings contracts and opens onboarding', () => {
    expect(liteAppSettingsSchema.parse(DEFAULT_SETTINGS).company.name).toBe('');
    expect(proAppSettingsSchema.parse(DEFAULT_SETTINGS).company.name).toBe('');
    expect(shouldShowBusinessOnboarding(DEFAULT_SETTINGS)).toBe(true);
  });

  it('switches a selected customer to a manual recipient without carrying customer snapshots forward', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const onSelectedClientChange = vi.fn();
    const clients: ClientLike[] = [{
      id: 'client-1',
      company: 'Alpen GmbH',
      customerNumber: 'KD-001',
      emails: [{ email: 'billing@alpen.example', isDefaultBilling: true }],
      addresses: [{ company: 'Alpen GmbH', street: 'Ringstraße 1', zip: '1010', city: 'Wien', country: 'AT', isDefaultBilling: true, isDefaultShipping: true }],
      taxProfile: { type: 'business', countryCode: 'AT', vatId: 'ATU12345678', vatIdValidation: 'valid', vatIdValidationAt: '2026-08-06T12:00:00.000Z' },
    }];
    const projects: ProjectLike[] = [{ id: 'project-1', code: 'PRJ-1', name: 'Alpen Baustelle' }];
    renderEditor(documentFixture({
      items: [{ description: 'Beratung', quantity: 1, price: 100, total: 100 }],
      taxMode: 'standard_vat',
      taxMeta: {
        buyerCountryCode: 'CH',
        buyerType: 'business',
        buyerVatId: 'CHE-123.456.789 MWST',
        vatIdValidation: 'valid',
        vatIdValidationAt: '2026-08-06T12:00:00.000Z',
        sellerCountryCode: 'DE',
        sellerVatId: 'DE123456789',
        datevEvidenceType: 'USt-IdNr.-Prüfung',
        datevEvidenceReference: 'ATU12345678',
        datevSachverhaltLl: '13',
      },
    }), onSave, 'invoice', { clients, projects, onSelectedClientChange });

    const recipient = screen.getByRole('combobox', { name: 'Kunde auswählen' });
    await user.click(recipient);
    await user.click(await screen.findByRole('option', { name: /Alpen GmbH/ }));
    await user.click(screen.getByRole('button', { name: 'Details bearbeiten' }));
    const project = screen.getByRole('combobox', { name: 'Projekt auswählen' });
    await user.click(project);
    await user.click(await screen.findByRole('option', { name: /PRJ-1/ }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Steuer-Modell' }), 'standard_vat');

    await user.click(recipient);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Empfänger ohne Kundenstamm eingeben' }));

    await waitFor(() => expect(onSelectedClientChange).toHaveBeenLastCalledWith(''));
    expect(recipient).toHaveFocus();
    expect(screen.getByText('Nur in diesem Beleg gespeichert')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Rechnungsadresse' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'E-Mail' })).toHaveValue('');
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    expect(project).toHaveValue('');
    expect(project).toBeDisabled();

    await user.type(recipient, 'Manueller Empfänger');
    const address = screen.getByRole('textbox', { name: 'Rechnungsadresse' });
    await user.type(address, 'Neue Straße 5{Enter}1010 Wien{Enter}AT');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getAllByText(/grenzüberschreitende Rechnung/i).length).toBeGreaterThan(0);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Steuer-Modell' }), 'standard_vat');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));

    expect(onSave).toHaveBeenCalledOnce();
    const saved = onSave.mock.calls[0]![0];
    expect(saved).toMatchObject({
      client: 'Manueller Empfänger',
      clientEmail: '',
      clientAddress: 'Neue Straße 5\n1010 Wien\nAT',
      taxMeta: {
        sellerCountryCode: 'DE',
        sellerVatId: 'DE123456789',
        datevEvidenceType: 'USt-IdNr.-Prüfung',
        datevEvidenceReference: 'ATU12345678',
        datevSachverhaltLl: '13',
      },
    });
    for (const key of ['clientId', 'clientNumber', 'projectId', 'shippingAddressJson'] as const) expect(saved[key]).toBeUndefined();
    for (const key of ['buyerCountryCode', 'buyerType', 'buyerVatId', 'vatIdValidation', 'vatIdValidationAt'] as const) expect(saved.taxMeta?.[key]).toBeUndefined();
    expect(saved.items).toEqual([{ description: 'Beratung', quantity: 1, price: 100, total: 100 }]);
    expect(saved.taxMeta?.taxRuleConfirmed).toBe(true);
    expect(saved.billingAddressJson).toMatchObject({ company: 'Manueller Empfänger', street: 'Neue Straße 5', zip: '1010', city: 'Wien', country: 'AT' });
    expect(saved.billingAddressJson).not.toMatchObject({ company: 'Alpen GmbH', street: 'Ringstraße 1' });
  });

  it('lets an empty document start with a focused manual recipient', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderEditor(documentFixture(), onSave);

    const recipient = screen.getByRole('combobox', { name: 'Kunde auswählen' });
    expect(screen.getByText('Nur in diesem Beleg gespeichert')).toBeInTheDocument();
    await user.click(recipient);
    await user.click(screen.getByRole('button', { name: 'Empfänger ohne Kundenstamm eingeben' }));
    expect(recipient).toHaveFocus();
    await user.type(recipient, 'Direkter Empfänger');
    await user.type(screen.getByRole('textbox', { name: 'Rechnungsadresse' }), 'Straße 2{Enter}50667 Köln{Enter}DE');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));

    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0]![0]).toMatchObject({ client: 'Direkter Empfänger', clientAddress: 'Straße 2\n50667 Köln\nDE' });
    expect(onSave.mock.calls[0]![0].clientId).toBeUndefined();
  });

  it('clears a stale buyer country when selecting a customer without an address', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const clients: ClientLike[] = [
      {
        id: 'client-1',
        company: 'Nord GmbH',
        customerNumber: 'KD-001',
        emails: [{ email: 'billing@nord.example' }],
        addresses: [{ company: 'Nord GmbH', street: 'Hafenstraße 4', zip: '20095', city: 'Hamburg', country: 'DE', isDefaultBilling: true, isDefaultShipping: true }],
      },
      { id: 'client-no-country', company: 'Ohne Land GmbH', customerNumber: 'KD-002', email: 'billing@ohne-land.example' },
    ];
    renderEditor(documentFixture({
      client: 'Nord GmbH',
      clientId: 'client-1',
      clientEmail: 'billing@nord.example',
      clientAddress: 'Hafenstraße 4\n20095 Hamburg\nDE',
      billingAddressJson: { company: 'Nord GmbH', street: 'Hafenstraße 4', zip: '20095', city: 'Hamburg', country: 'DE' },
      taxMeta: { buyerCountryCode: 'DE' },
      status: 'draft',
      dunningLevel: 0,
      payments: [],
    }), onSave, 'invoice', { clients });

    const customer = screen.getByRole('combobox', { name: 'Kunde auswählen' });
    await user.click(customer);
    await user.clear(customer);
    await user.type(customer, 'Ohne Land');
    await user.click(await screen.findByRole('option', { name: /Ohne Land GmbH/ }));
    await user.click(screen.getByRole('button', { name: 'Speichern' }));

    expect(onSave).toHaveBeenCalledOnce();
    const saved = onSave.mock.calls[0]![0];
    const parsed = invoiceSchema.parse({ ...saved, kind: 'invoice', tenantId: 'tenant-1' });
    expect(parsed.taxMeta?.buyerCountryCode).toBeUndefined();
  });

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
    expect(screen.getByRole('combobox', { name: 'Kunde auswählen' })).toHaveFocus();
  });

  it('lists each validation error and jumps to the selected field', async () => {
    const user = userEvent.setup();
    renderEditor(documentFixture({ number: '', date: '', items: [{ description: '', quantity: 1, price: 10, total: 10 }] }));

    await user.click(screen.getByRole('button', { name: 'Speichern' }));

    expect(screen.getByRole('button', { name: /Nummer: Nummer ist erforderlich/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Datum: Datum ist erforderlich/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Kunde: Kunde ist erforderlich/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Position 1 Beschreibung/ })).toBeInTheDocument();
    const client = screen.getByRole('combobox', { name: 'Kunde auswählen' });
    expect(client).toHaveAttribute('aria-invalid', 'true');
    expect(client).toHaveAttribute('aria-describedby', 'document-input-client-error');

    await user.click(screen.getByRole('button', { name: /Datum: Datum ist erforderlich/ }));
    expect(screen.getByLabelText('Datum')).toHaveFocus();
  });

  it('opens DATEV details and marks evidence fields required for small businesses', async () => {
    const user = userEvent.setup();
    const settings = { ...MOCK_SETTINGS, legal: { ...MOCK_SETTINGS.legal, smallBusinessRule: true } };
    renderEditor(documentFixture({ client: 'Nord GmbH', items: [{ description: 'Leistung', quantity: 1, price: 10, total: 10 }] }), vi.fn(), 'invoice', { settings });

    await user.click(screen.getByRole('button', { name: 'Speichern' }));

    expect(screen.getByRole('button', { name: 'Details bearbeiten' })).toHaveAttribute('aria-expanded', 'true');
    for (const label of ['DATEV Nachweistyp', 'DATEV Nachweisreferenz']) {
      expect(screen.getByRole('textbox', { name: label })).toBeRequired();
      expect(screen.getByRole('textbox', { name: label })).toHaveAttribute('aria-required', 'true');
    }
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

    const name = screen.getByRole('combobox', { name: 'Kunde auswählen' });
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

    await user.clear(screen.getByRole('combobox', { name: 'Kunde auswählen' }));
    await user.type(screen.getByRole('combobox', { name: 'Kunde auswählen' }), 'Lokale Änderung');
    view.rerender(editor(second, onSave));

    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Kunde auswählen' })).toHaveValue('Zweiter Kunde'));
    expect(screen.queryByText('Ungespeichert')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(onSave.mock.calls[0]![0]).toMatchObject({ id: 'invoice-2', number: 'RE-2026-002', client: 'Zweiter Kunde' });
  });

  it('uses offer-specific labels without introducing a second editor', () => {
    renderEditor(documentFixture({ number: 'AN-2026-001' }), vi.fn(), 'offer');
    expect(screen.getByRole('heading', { name: 'Angebot bearbeiten' })).toBeInTheDocument();
    expect(screen.getByLabelText('Gültig bis')).toHaveAttribute('type', 'date');
  });

  it('blocks a cross-border save until the VAT rule is confirmed, then saves after selection', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderEditor(documentFixture({
      client: 'Alpen GmbH',
      clientAddress: 'Ringstraße 1\n1010 Wien\nAT',
      billingAddressJson: { company: 'Alpen GmbH', street: 'Ringstraße 1', zip: '1010', city: 'Wien', country: 'AT' },
      items: [{ description: 'Beratung', quantity: 1, price: 100, total: 100 }],
    }), onSave);

    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getAllByText(/grenzüberschreitende Rechnung/i).length).toBeGreaterThan(0);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Steuer-Modell' }), 'standard_vat');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0]![0].taxMeta.taxRuleConfirmed).toBe(true);
  });

  it('applies a guided EU recommendation and keeps the cross-border snapshot zero-rated', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    renderEditor(documentFixture({
      client: 'Alpen GmbH',
      clientAddress: 'Ringstraße 1\n1010 Wien\nAT',
      billingAddressJson: { company: 'Alpen GmbH', street: 'Ringstraße 1', zip: '1010', city: 'Wien', country: 'AT' },
      items: [{ description: 'Beratung', quantity: 1, price: 100, total: 100 }],
      taxMeta: {
        buyerCountryCode: 'AT',
        buyerType: 'business',
        buyerVatId: 'ATU12345678',
        sellerVatId: 'DE123456789',
      },
    }), onSave);

    await user.click(screen.getByRole('button', { name: 'EU-Leistung Reverse Charge' }));
    await user.type(screen.getByRole('spinbutton', { name: 'EU-Steuersatz im Bestimmungsland' }), '20');
    await user.type(screen.getByRole('textbox', { name: 'DATEV Nachweistyp' }), 'USt-IdNr.-Prüfung');
    await user.type(screen.getByRole('textbox', { name: 'DATEV Nachweisreferenz' }), 'ATU12345678');
    await user.type(screen.getByRole('textbox', { name: 'DATEV Sachverhalt L+L' }), '13');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));

    expect(onSave).toHaveBeenCalledOnce();
    expect(onSave.mock.calls[0]![0]).toMatchObject({
      taxMode: 'intra_eu_service_reverse_charge',
      amount: 100,
      taxSnapshot: { vatAmount: 0, grossAmount: 100 },
    });
  });

  it('offers country defaults and preserves a distinct per-line DACH rate', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    const settings = {
      ...MOCK_SETTINGS,
      legal: { ...MOCK_SETTINGS.legal, countryCode: 'AT', defaultVatRate: 20 },
    };
    renderEditor(documentFixture({
      client: 'Wiener Kunde',
      items: [{ description: 'Leistung', quantity: 1, price: 100, total: 100, taxRate: 10 }],
    }), onSave, 'invoice', { settings });

    expect(screen.getByRole('combobox', { name: 'Standardsatz' })).toHaveValue('20');
    expect(screen.getByRole('combobox', { name: 'Umsatzsteuer Position 1' })).toHaveValue('10');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Standardsatz' }), '13');
    await user.click(screen.getByRole('combobox', { name: 'Beschreibung Position 1' }));
    await user.selectOptions(screen.getByRole('combobox', { name: 'Umsatzsteuer Position 1' }), '4.9');
    await user.click(screen.getByRole('button', { name: 'Speichern' }));

    expect(onSave.mock.calls[0]![0]).toMatchObject({
      items: [{ taxRate: 4.9 }],
      taxMeta: { defaultVatRate: 13 },
    });
  });

  it('shows VIES valid, invalid, and unavailable states and clears stale status on edits', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn();
    let status: 'valid' | 'invalid' | 'unavailable' = 'valid';
    const onValidateVatId = vi.fn(async ({ vatNumber }: { countryCode: string; vatNumber: string }) => ({
      status,
      normalizedVatId: vatNumber.replace(/\s+/g, '').toUpperCase(),
      checkedAt: '2026-08-06T12:00:00.000Z',
    }));
    renderEditor(documentFixture({
      client: 'Alpen GmbH',
      clientAddress: 'Ringstraße 1\n1010 Wien\nAT',
      billingAddressJson: { company: 'Alpen GmbH', street: 'Ringstraße 1', zip: '1010', city: 'Wien', country: 'AT' },
      taxMode: 'intra_eu_service_reverse_charge',
      taxMeta: { buyerVatId: 'ATU12345678', buyerCountryCode: 'AT', buyerType: 'business' },
      items: [{ description: 'Beratung', quantity: 1, price: 100, total: 100 }],
    }), onSave, 'invoice', { onValidateVatId });

    const validateButton = screen.getByRole('button', { name: 'VIES prüfen' });
    await user.click(validateButton);
    expect(await screen.findByText('VIES: valid')).toBeInTheDocument();
    status = 'invalid';
    await user.click(validateButton);
    expect(await screen.findByText('VIES: invalid')).toBeInTheDocument();
    status = 'unavailable';
    await user.click(validateButton);
    expect(await screen.findByText('VIES: unavailable')).toBeInTheDocument();

    const vatInput = screen.getByRole('textbox', { name: 'USt-IdNr. des Kunden' });
    await user.type(vatInput, 'X');
    expect(screen.queryByText('VIES: unavailable')).not.toBeInTheDocument();
    expect(onValidateVatId).toHaveBeenCalledTimes(3);
  });
});
