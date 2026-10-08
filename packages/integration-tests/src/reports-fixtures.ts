import { randomUUID } from 'node:crypto';
import type { BillmeApi } from '@billme/desktop-contracts/api';
import { draftInvoice, type DocumentInput } from './fixtures.js';

/** Helpers shared by reports.test.ts and einvoice.test.ts (tax reports and e-invoices need a real company profile). */
export type ReportSettings = { vatMethod?: 'soll' | 'ist'; smallBusiness?: boolean; vatId?: string; taxId?: string; street?: string; eInvoice?: boolean; countryCode?: 'DE' | 'AT' | 'CH' };

/**
 * What onboarding does: write the settings once. A fresh data dir has no
 * stored profile, so EÜR (409) and the VAT report (DE_PROFILE_REQUIRED) refuse
 * to run before this. `legal.taxAccountingMethod` follows
 * `businessReportingProfile.vatMethod` (appSettingsSchema transform).
 */
export const configureLite = async (api: BillmeApi, over: ReportSettings = {}) => {
  const current = await api.settings.get() as any;
  const next = {
    ...current,
    company: { ...current.company, name: 'Muster Consulting', owner: 'Max Muster', street: over.street ?? 'Werkstraße 1', zip: '10115', city: 'Berlin', email: 'info@muster.example' },
    finance: { ...current.finance, vatId: over.vatId ?? 'DE123456789', taxId: over.taxId ?? '12/345/67890', iban: 'DE02120300000000202051', bic: 'BYLADEM1001', bankName: 'DKB' },
    legal: {
      ...current.legal, smallBusinessRule: over.smallBusiness ?? current.legal.smallBusinessRule, ...(over.countryCode ? { countryCode: over.countryCode } : {}),
      // A Soll/Ist change applies from the current month unless a start is given; these suites look back at
      // past months, so they move the start before all of them (it must differ from the stored one to count).
      ...(over.vatMethod ? { taxAccountingMethodSince: current.legal.taxAccountingMethodSince === '2000-01-01' ? '2000-02-01' : '2000-01-01' } : {}),
    },
    eInvoice: { ...current.eInvoice, enabled: over.eInvoice ?? current.eInvoice.enabled },
    businessReportingProfile: { ...current.businessReportingProfile, vatMethod: over.vatMethod ?? current.businessReportingProfile.vatMethod },
  };
  await api.settings.set({ settings: next } as never);
  return next as typeof current;
};

export const line = (description: string, net: number, taxRate?: number) => ({
  kind: 'item' as const, description, quantity: 1, price: net, total: net, ...(taxRate === undefined ? {} : { taxRate }),
});

/** An issued invoice with a service date (the VAT report needs it; the shared fixture leaves it empty). */
export const issueDated = async (api: BillmeApi, input: DocumentInput & { servicePeriod?: string }) => {
  const { servicePeriod, ...rest } = input;
  const draft = await draftInvoice(api, rest);
  return api.invoices.upsert({ reason: 'Rechnung gestellt', invoice: { ...draft, servicePeriod, status: 'open' } });
};

export const pay = async (api: BillmeApi, invoiceId: string, amount: number, date: string, method = 'bank') => {
  const payment = { id: randomUUID(), date, amount, method };
  await api.invoices.savePayment({ invoiceId, payment, reason: `Zahlung ${date}` });
  return payment;
};

export const bankAccount = (id: string) => ({ id, name: `Giro ${id}`, iban: 'DE02120300000000202051', balance: 0, transactions: [], type: 'bank' as const, color: '#1d4ed8' });

/** Bank statement through the real preview → commit import. `rows` are [date, amount, counterparty, purpose, status?]. */
export const importBankRows = async (api: BillmeApi, accountId: string, rows: Array<[string, number, string, string, string?]>) => {
  const csv = ['Date,Amount,Name,Purpose,Status', ...rows.map(([date, amount, name, purpose, status]) => `${date},${amount.toFixed(2)},${name},${purpose},${status ?? 'booked'}`)].join('\n');
  const mapping = { dateColumn: 'Date', amountColumn: 'Amount', counterpartyColumn: 'Name', purposeColumn: 'Purpose', statusColumn: 'Status' };
  const preview = await api.finance.importPreview({ fileName: 'umsaetze.csv', contentBase64: Buffer.from(csv).toString('base64'), profile: 'generic', mapping } as never);
  return api.finance.importCommit({ path: preview.path, accountId, profile: 'generic', mapping } as never);
};
