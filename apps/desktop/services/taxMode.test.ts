import { describe, expect, it } from 'vitest';
import { calculateInvoiceTaxSnapshot, resolveInvoiceTaxMode } from './taxMode';
import type { AppSettings } from '../types';

const settings: AppSettings = {
  company: {
    name: 'Test GmbH',
    owner: 'Owner',
    street: 'Street 1',
    zip: '10115',
    city: 'Berlin',
    email: 'mail@test.de',
    phone: '',
    website: '',
  },
  catalog: { categories: [] },
  finance: {
    bankName: '',
    iban: '',
    bic: '',
    taxId: '',
    vatId: '',
    registerCourt: '',
  },
  numbers: {
    invoicePrefix: 'RE-',
    nextInvoiceNumber: 1,
    numberLength: 3,
    offerPrefix: 'ANG-',
    nextOfferNumber: 1,
    customerPrefix: 'KD-',
    nextCustomerNumber: 1,
    customerNumberLength: 4,
  },
  dunning: { levels: [] },
  legal: {
    smallBusinessRule: false,
    defaultVatRate: 19,
    taxAccountingMethod: 'soll',
    paymentTermsDays: 14,
    defaultIntroText: '',
    defaultFooterText: '',
  },
  portal: { baseUrl: '' },
  eInvoice: {
    enabled: false,
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
};

describe('taxMode', () => {
  it('calculates standard VAT snapshot', () => {
    const snapshot = calculateInvoiceTaxSnapshot(
      {
        items: [{ description: 'A', quantity: 1, price: 100, total: 100 }],
        taxMode: 'standard_vat',
      },
      settings,
    );
    expect(snapshot.netAmount).toBe(100);
    expect(snapshot.vatAmount).toBe(19);
    expect(snapshot.grossAmount).toBe(119);
    expect(snapshot.einvoiceCategoryCode).toBe('S');
  });

  it('forces zero VAT for reverse charge', () => {
    const snapshot = calculateInvoiceTaxSnapshot(
      {
        items: [{ description: 'A', quantity: 1, price: 100, total: 100 }],
        taxMode: 'reverse_charge_13b',
      },
      settings,
    );
    expect(snapshot.vatAmount).toBe(0);
    expect(snapshot.grossAmount).toBe(100);
    expect(snapshot.einvoiceCategoryCode).toBe('AE');
  });

  it('resolves default mode from small business setting', () => {
    const mode = resolveInvoiceTaxMode(undefined, {
      legal: { ...settings.legal, smallBusinessRule: true },
    });
    expect(mode).toBe('small_business_19_ustg');
  });
});

