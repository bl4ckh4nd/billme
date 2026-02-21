import type { AppSettings, Invoice } from '../../types';
import {
  getDefaultTaxRate,
  getInvoiceTaxExemptionReason,
  getInvoiceTaxModeDefinition,
  resolveInvoiceTaxMode,
} from '../taxMode';

type NormalizedAddress = {
  name: string;
  street: string;
  city: string;
  postalCode: string;
  countryCode: string;
};

export type NormalizedEinvoice = {
  invoiceNumber: string;
  issueDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  currency: 'EUR';
  seller: NormalizedAddress & {
    vatId?: string;
    taxId?: string;
  };
  buyer: NormalizedAddress;
  lines: Array<{
    lineId: string;
    name: string;
    quantity: number;
    unitCode: string;
    netUnitPrice: number;
    netLineTotal: number;
    taxRate: number;
    taxCategoryCode: 'S' | 'E' | 'AE' | 'O';
    taxExemptionReason?: string;
  }>;
  totals: {
    lineNetTotal: number;
    taxTotal: number;
    grandTotal: number;
  };
};

const toIsoDate = (value: string | undefined, fieldName: string): string => {
  if (!value) throw new Error(`ZUGFeRD Export fehlgeschlagen: Feld "${fieldName}" fehlt.`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`ZUGFeRD Export fehlgeschlagen: Feld "${fieldName}" fehlt.`);
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(trimmed);
  if (!match) throw new Error(`ZUGFeRD Export fehlgeschlagen: Feld "${fieldName}" hat kein gültiges Datumsformat.`);
  return match[1]!;
};

const toAmount = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
};

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

const parseAddressFromLine = (line: string | undefined): { postalCode: string; city: string } => {
  const raw = (line ?? '').trim();
  const m = /^(\d{4,6})\s+(.+)$/.exec(raw);
  if (m) return { postalCode: m[1]!, city: m[2]!.trim() };
  return { postalCode: '', city: raw };
};

const normalizeBuyerAddress = (invoice: Invoice): NormalizedAddress => {
  const fromJson = (invoice.billingAddressJson ?? undefined) as
    | {
        company?: string;
        contactPerson?: string;
        street?: string;
        city?: string;
        zip?: string;
        postalCode?: string;
        country?: string;
      }
    | undefined;

  if (fromJson && typeof fromJson === 'object') {
    const name = (fromJson.company || invoice.client || '').trim();
    const street = (fromJson.street || '').trim();
    const postalCode = (fromJson.postalCode || fromJson.zip || '').trim();
    const city = (fromJson.city || '').trim();
    const countryCode = (fromJson.country || 'DE').trim().toUpperCase();
    if (name && street && postalCode && city) {
      return { name, street, postalCode, city, countryCode: countryCode || 'DE' };
    }
  }

  const lines = (invoice.clientAddress ?? '')
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
  const street = lines[0] ?? '';
  const cityLine = lines[1] ?? '';
  const parsed = parseAddressFromLine(cityLine);
  return {
    name: (invoice.client || '').trim(),
    street,
    city: parsed.city,
    postalCode: parsed.postalCode,
    countryCode: 'DE',
  };
};

const normalizeSellerAddress = (settings: AppSettings): NormalizedAddress & { vatId?: string; taxId?: string } => {
  const companyName = settings.company.name.trim();
  const street = settings.company.street.trim();
  const city = settings.company.city.trim();
  const postalCode = settings.company.zip.trim();
  const vatId = settings.finance.vatId.trim();
  const taxId = settings.finance.taxId.trim();

  return {
    name: companyName,
    street,
    city,
    postalCode,
    countryCode: 'DE',
    vatId: vatId || undefined,
    taxId: taxId || undefined,
  };
};

const assertRequired = (label: string, value: string) => {
  if (!value.trim()) {
    throw new Error(`ZUGFeRD Export fehlgeschlagen: Pflichtfeld "${label}" fehlt.`);
  }
};

export const normalizeInvoiceForEinvoice = (
  invoice: Invoice,
  settings: AppSettings,
): NormalizedEinvoice => {
  const seller = normalizeSellerAddress(settings);
  const buyer = normalizeBuyerAddress(invoice);
  const taxMode = resolveInvoiceTaxMode(invoice.taxMode, settings);
  const definition = getInvoiceTaxModeDefinition(taxMode);
  const isZeroVatMode = Boolean(definition.forceZeroVat);
  const defaultTaxRate = isZeroVatMode ? 0 : getDefaultTaxRate(settings);
  const taxExemptionReason = getInvoiceTaxExemptionReason(taxMode, invoice.taxMeta);

  assertRequired('Rechnungsnummer', invoice.number);
  assertRequired('Rechnungsdatum', invoice.date);
  assertRequired('Fälligkeitsdatum', invoice.dueDate);
  assertRequired('Verkäufer Name', seller.name);
  assertRequired('Verkäufer Straße', seller.street);
  assertRequired('Verkäufer PLZ', seller.postalCode);
  assertRequired('Verkäufer Ort', seller.city);
  assertRequired('Käufer Name', buyer.name);
  assertRequired('Käufer Straße', buyer.street);
  assertRequired('Käufer PLZ', buyer.postalCode);
  assertRequired('Käufer Ort', buyer.city);

  const lines = (invoice.items ?? []).map((item, idx) => {
    const quantity = toAmount(item.quantity) || 1;
    const netLineTotal = round2(toAmount(item.total));
    const netUnitPrice = round2(quantity === 0 ? 0 : netLineTotal / quantity);
    const taxRate = defaultTaxRate;
    return {
      lineId: String(idx + 1),
      name: (item.description || `Position ${idx + 1}`).trim(),
      quantity,
      unitCode: 'C62', // piece
      netUnitPrice,
      netLineTotal,
      taxRate,
      taxCategoryCode: definition.einvoiceCategoryCode,
      taxExemptionReason,
    };
  });

  if (lines.length === 0) {
    throw new Error('ZUGFeRD Export fehlgeschlagen: Rechnung enthält keine Positionen.');
  }

  const lineNetTotal = round2(lines.reduce((acc, line) => acc + line.netLineTotal, 0));
  const taxTotal = round2(
    isZeroVatMode
      ? 0
      : lines.reduce((acc, line) => acc + line.netLineTotal * (line.taxRate / 100), 0),
  );
  const grandTotal = round2(lineNetTotal + taxTotal);

  return {
    invoiceNumber: invoice.number.trim(),
    issueDate: toIsoDate(invoice.date, 'date'),
    dueDate: toIsoDate(invoice.dueDate, 'dueDate'),
    currency: 'EUR',
    seller,
    buyer,
    lines,
    totals: {
      lineNetTotal,
      taxTotal,
      grandTotal,
    },
  };
};
