import { describe, expect, it } from 'vitest';
import { getPreviewElements } from './documentPreview';
import type { AppSettings, Invoice, InvoiceElement } from '../types';

const settings: AppSettings = {
  company: {
    name: 'Billme GmbH',
    owner: 'Max Mustermann',
    street: 'Hauptstr. 1',
    zip: '12345',
    city: 'Berlin',
    email: 'info@example.com',
    phone: '01234',
    website: 'example.com',
  },
  finance: {
    bankName: 'Demo Bank',
    iban: 'DE02120300000000202051',
    bic: 'BYLADEM1001',
    taxId: '12/345/67890',
    vatId: 'DE123456789',
    registerCourt: '',
  },
  legal: {
    smallBusinessRule: false,
    defaultVatRate: 19,
    taxAccountingMethod: 'soll',
    paymentTermsDays: 14,
    defaultIntroText: '',
    defaultFooterText: '',
  },
  numbers: {
    invoicePrefix: 'RE-%Y-',
    nextInvoiceNumber: 1,
    numberLength: 3,
    offerPrefix: 'AN-%Y-',
    nextOfferNumber: 1,
    customerPrefix: 'KD-',
    nextCustomerNumber: 1,
    customerNumberLength: 3,
  },
  dunning: { levels: [] },
  email: {
    provider: 'none',
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: true,
    smtpUser: '',
    fromName: '',
    fromEmail: '',
  },
  automation: {
    dunningEnabled: false,
    dunningRunTime: '09:00',
    recurringEnabled: false,
    recurringRunTime: '09:00',
  },
  dashboard: {
    monthlyRevenueGoal: 0,
    dueSoonDays: 7,
    topCategoriesLimit: 5,
    recentPaymentsLimit: 5,
    topClientsLimit: 5,
  },
  portal: { baseUrl: '' },
  eInvoice: {
    enabled: false,
    standard: 'zugferd-en16931',
    profile: 'EN16931',
    version: '2.3',
  },
  catalog: { categories: [] },
};

const invoice: Invoice = {
  id: 'inv-1',
  number: 'RE-2026-001',
  client: 'Acme GmbH',
  clientEmail: 'billing@acme.test',
  clientAddress: 'Testweg 1',
  date: '2026-05-07',
  dueDate: '2026-05-21',
  servicePeriod: '2026-05-05',
  amount: 119,
  status: 'draft',
  items: [
    {
      description: 'Consulting',
      quantity: 2,
      price: 75,
      total: 100,
    },
  ],
  payments: [],
  taxSnapshot: {
    netAmount: 100,
    vatAmount: 19,
    grossAmount: 119,
    vatRateApplied: 19,
    einvoiceCategoryCode: 'S',
    label: 'Regelbesteuerung',
  },
};

describe('getPreviewElements', () => {
  it('recalculates stale totals from quantity and price', () => {
    const template: InvoiceElement[] = [
      {
        id: 'totals',
        type: 'TEXT',
        x: 0,
        y: 0,
        zIndex: 1,
        label: 'totals_block',
        content: 'Netto: {{total.net}}\nGesamtbetrag: {{total.gross}}',
        style: { fontSize: 12 },
      },
      {
        id: 'table',
        type: 'TABLE',
        x: 0,
        y: 20,
        zIndex: 1,
        label: 'items_table',
        style: { width: 300 },
        tableData: {
          columns: [
            { id: 'pos', label: 'Pos.', width: 40, visible: true, align: 'left' },
            { id: 'desc', label: 'Beschreibung', width: 120, visible: true, align: 'left' },
            { id: 'qty', label: 'Menge', width: 40, visible: true, align: 'right' },
            { id: 'price', label: 'Einzelpreis', width: 50, visible: true, align: 'right' },
            { id: 'total', label: 'Gesamt', width: 50, visible: true, align: 'right' },
          ],
          rows: [],
        },
      },
    ];

    const preview = getPreviewElements(invoice, template, settings);
    const totals = preview[0];
    const table = preview[1];

    expect(totals?.content).toContain('150,00');
    expect(totals?.content).toContain('178,50');
    expect(table?.tableData?.rows[0]?.cells[4]).toContain('150,00');
  });

  it('injects service and due date placeholders into invoice meta blocks', () => {
    const template: InvoiceElement[] = [
      {
        id: 'meta',
        type: 'TEXT',
        x: 0,
        y: 0,
        zIndex: 1,
        label: 'invoice_meta',
        content: 'Rechnungs-Nr: {{invoice.number}}',
        style: { fontSize: 12, height: 80 },
      },
    ];

    const preview = getPreviewElements(invoice, template, settings);

    expect(preview[0]?.content).toContain('05.05.2026');
    expect(preview[0]?.content).toContain('21.05.2026');
    expect(preview[0]?.style?.height).toBe(120);
  });

  it('renders fallback payment text from the due date', () => {
    const template: InvoiceElement[] = [
      {
        id: 'payment',
        type: 'TEXT',
        x: 0,
        y: 0,
        zIndex: 1,
        label: 'payment_terms',
        content: 'Bitte überweisen Sie den Betrag bis spätestens {{invoice.dueDate}} ohne Abzug auf das unten genannte Konto.\nEs gelten unsere AGB.',
        style: { fontSize: 12 },
      },
    ];

    const preview = getPreviewElements(invoice, template, settings);

    expect(preview[0]?.content).toContain('21.05.2026');
    expect(preview[0]?.content).not.toContain('{{invoice.dueDate}}');
  });
});
