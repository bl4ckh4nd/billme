import { describe, expect, it } from 'vitest';
import { normalizeInvoiceForEinvoice } from './normalizeInvoiceForEinvoice';
import type { AppSettings, Invoice } from '../../types';

const makeSettings = (smallBusinessRule = false): AppSettings => ({
  company: {
    name: 'Billme GmbH',
    owner: 'Max Mustermann',
    street: 'Hauptstr. 1',
    zip: '10115',
    city: 'Berlin',
    email: 'info@billme.app',
    phone: '+49 30 123456',
    website: 'billme.app',
  },
  catalog: { categories: [{ id: '1', name: 'Allgemein' }] },
  finance: {
    bankName: 'Bank',
    iban: 'DE001234',
    bic: 'GENODEF1',
    taxId: '12/34/5678',
    vatId: 'DE123456789',
    registerCourt: 'AG Berlin',
  },
  numbers: {
    invoicePrefix: 'RE-%Y-',
    nextInvoiceNumber: 1,
    numberLength: 3,
    offerPrefix: 'ANG-%Y-',
    nextOfferNumber: 1,
    customerPrefix: 'KD-',
    nextCustomerNumber: 1,
    customerNumberLength: 4,
  },
  dunning: { levels: [] },
  legal: {
    smallBusinessRule,
    defaultVatRate: 19,
    taxAccountingMethod: 'soll',
    paymentTermsDays: 14,
    defaultIntroText: '',
    defaultFooterText: '',
  },
  portal: { baseUrl: '' },
  eInvoice: {
    enabled: true,
    standard: 'zugferd-en16931',
    profile: 'EN16931',
    version: '2.3',
  },
  email: {
    provider: 'none',
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: '',
    fromName: '',
    fromEmail: '',
  },
  automation: {
    dunningEnabled: false,
    dunningRunTime: '09:00',
    recurringEnabled: false,
    recurringRunTime: '03:00',
  },
  dashboard: {
    monthlyRevenueGoal: 30000,
    dueSoonDays: 7,
    topCategoriesLimit: 5,
    recentPaymentsLimit: 5,
    topClientsLimit: 5,
  },
});

const makeInvoice = (): Invoice => ({
  id: 'inv-1',
  number: 'RE-2026-001',
  client: 'Kunde GmbH',
  clientEmail: 'kunde@example.com',
  clientAddress: 'Kundenweg 5\n20095 Hamburg',
  date: '2026-02-15',
  dueDate: '2026-02-22',
  taxMode: 'standard_vat',
  amount: 119,
  status: 'open',
  items: [{ description: 'Leistung A', quantity: 1, price: 100, total: 100 }],
  payments: [],
});

describe('normalizeInvoiceForEinvoice', () => {
  it('normalizes invoice with VAT', () => {
    const normalized = normalizeInvoiceForEinvoice(makeInvoice(), makeSettings(false));
    expect(normalized.invoiceNumber).toBe('RE-2026-001');
    expect(normalized.totals.lineNetTotal).toBe(100);
    expect(normalized.totals.taxTotal).toBe(19);
    expect(normalized.totals.grandTotal).toBe(119);
    expect(normalized.lines[0]?.taxCategoryCode).toBe('S');
  });

  it('uses exemption for small business rule', () => {
    const normalized = normalizeInvoiceForEinvoice(
      {
        ...makeInvoice(),
        taxMode: 'small_business_19_ustg',
      },
      makeSettings(true),
    );
    expect(normalized.totals.taxTotal).toBe(0);
    expect(normalized.lines[0]?.taxCategoryCode).toBe('E');
    expect(normalized.lines[0]?.taxExemptionReason).toContain('§19');
  });

  it('maps reverse charge to AE category', () => {
    const normalized = normalizeInvoiceForEinvoice(
      {
        ...makeInvoice(),
        taxMode: 'reverse_charge_13b',
      },
      makeSettings(false),
    );
    expect(normalized.totals.taxTotal).toBe(0);
    expect(normalized.lines[0]?.taxCategoryCode).toBe('AE');
    expect(normalized.lines[0]?.taxExemptionReason).toContain('§13b');
  });
});
