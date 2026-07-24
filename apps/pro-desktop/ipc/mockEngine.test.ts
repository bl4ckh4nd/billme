import { describe, expect, it } from 'vitest';
import { createMockInvoke } from './mockEngine';

describe('mockEngine customer numbering', () => {
  it('skips duplicate customer numbers when auto-assigning a blank Kundennummer', async () => {
    const invoke = createMockInvoke();
    const settings = await invoke('settings:get', undefined);
    expect(settings).not.toBeNull();
    if (!settings) {
      throw new Error('Expected mock settings');
    }

    await invoke('settings:set', {
      settings: {
        ...settings,
        numbers: {
          ...settings.numbers,
          nextCustomerNumber: 1,
        },
      },
    });

    const saved = await invoke('clients:upsert', {
      client: {
        id: 'client-stale-counter',
        customerNumber: undefined,
        company: 'Neue Kundin GmbH',
        contactPerson: '',
        email: '',
        phone: '',
        address: '',
        status: 'active',
        tags: [],
        notes: '',
        projects: [],
        activities: [],
        addresses: [],
        emails: [],
      },
    });

    expect(saved.customerNumber).toBe('KD-0004');
  });
});

// Regression guard for the Pro tax model. Pro used to compute the gross amount
// with a local helper that only knew settings.legal.smallBusinessRule, so
// per-document tax modes such as §13b reverse charge silently kept charging VAT
// and never produced a taxSnapshot. Both are required for a conformant ZUGFeRD
// export (the category code comes from the resolved tax mode).
describe('mockEngine invoice tax model', () => {
  const invoiceBase = {
    id: 'inv-tax-1',
    number: 'RE-TAX-1',
    client: 'Acme GmbH',
    clientEmail: 'billing@acme.test',
    date: '2026-03-01',
    dueDate: '2026-03-15',
    amount: 0,
    status: 'draft' as const,
    items: [{ description: 'Beratung', quantity: 1, price: 1000, total: 1000 }],
    payments: [],
    history: [],
  };

  it('zero-rates a reverse charge invoice and records the AE category', async () => {
    const invoke = createMockInvoke();
    const saved = await invoke('invoices:upsert', {
      invoice: { ...invoiceBase, taxMode: 'reverse_charge_13b' } as never,
      reason: 'test',
    });

    expect(saved.taxMode).toBe('reverse_charge_13b');
    expect(saved.taxSnapshot?.vatAmount).toBe(0);
    expect(saved.taxSnapshot?.netAmount).toBe(1000);
    expect(saved.taxSnapshot?.einvoiceCategoryCode).toBe('AE');
    expect(saved.amount).toBe(1000);
  });

  it('applies the standard rate when no tax mode is given', async () => {
    const invoke = createMockInvoke();
    const saved = await invoke('invoices:upsert', {
      invoice: { ...invoiceBase, id: 'inv-tax-2' } as never,
      reason: 'test',
    });

    expect(saved.taxMode).toBe('standard_vat');
    expect(saved.taxSnapshot?.vatAmount).toBe(190);
    expect(saved.amount).toBe(1190);
  });

  it('falls back to §19 Kleinunternehmer from the settings', async () => {
    const invoke = createMockInvoke();
    const settings = await invoke('settings:get', undefined);
    await invoke('settings:set', {
      settings: { ...settings!, legal: { ...settings!.legal, smallBusinessRule: true } } as never,
    });

    const saved = await invoke('invoices:upsert', {
      invoice: { ...invoiceBase, id: 'inv-tax-3' } as never,
      reason: 'test',
    });

    expect(saved.taxMode).toBe('small_business_19_ustg');
    expect(saved.taxSnapshot?.vatAmount).toBe(0);
    expect(saved.taxSnapshot?.einvoiceCategoryCode).toBe('E');
    expect(saved.amount).toBe(1000);
  });
});
