import type { AppSettings, Invoice } from '@billme/desktop-core/types';
import {
  getDefaultTaxRate,
  getInvoiceTaxExemptionReason,
  getInvoiceTaxModeDefinition,
  resolveInvoiceTaxMode,
  calculateInvoiceTaxSnapshot,
} from '@billme/server-core/services';
import { getBillingLineAmount, isBillableLine, isOptionalLine } from '@billme/server-core/domain';

type NormalizedAddress = {
  name: string;
  street: string;
  city: string;
  postalCode: string;
  countryCode: string;
};

export type NormalizedEinvoice = {
  invoiceNumber: string;
  /** UNTDID 1001: 380 commercial invoice, 381 credit note. */
  typeCode: '380' | '381';
  issueDate: string; // YYYY-MM-DD
  dueDate: string; // YYYY-MM-DD
  currency: 'EUR';
  seller: NormalizedAddress & {
    vatId?: string;
    taxId?: string;
    iban?: string;
    /** BG-6 seller contact (BT-41 name, BT-42 phone, BT-43 email); BT-34 uses the email too. */
    contactName?: string;
    phone?: string;
    email?: string;
  };
  buyer: NormalizedAddress;
  /** BT-49 buyer electronic address: the billing e-mail of the invoice. */
  buyerEmail?: string;
  buyerVatId?: string;
  /** BT-10 Käuferreferenz (Leitweg-ID). */
  buyerReference?: string;
  /** BT-25/26: the invoice a credit note or cancellation corrects. */
  precedingInvoice?: { number: string; date: string };
  /** BT-20: agreed Skonto, an Entgeltminderung §14 Abs. 4 Nr. 7 UStG requires on the invoice. */
  skonto?: { percent: number; days: number };
  /** BT-72 delivery date, or BG-14 service period when the invoice states a range. */
  delivery?: { date: string } | { start: string; end: string };
  lines: Array<{
    lineId: string;
    name: string;
    quantity: number;
    unitCode: string;
    netUnitPrice: number;
    netLineTotal: number;
    taxRate: number;
    taxCategoryCode: 'S' | 'E' | 'AE' | 'O' | 'K' | 'G';
    taxExemptionReason?: string;
    lineKind: 'item' | 'time' | 'optional';
    /** BG-27 line allowance: the position's own discount (BT-136 amount, BT-139 reason). */
    allowance?: { amount: number; reason: string };
  }>;
  allowances?: Array<Pick<NormalizedEinvoice['lines'][number], 'taxRate' | 'taxCategoryCode' | 'taxExemptionReason'> & {
    amount: number;
    reason: string;
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
    // A client address is often typed in one line: "Straße 1, 12345 Ort".
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    // The editor puts the primary contact as "z. Hd. …" above the street.
    .filter((v) => Boolean(v) && !/^z\.\s?Hd\./i.test(v));
  // The company name may lead the block (generated invoices print it above the street).
  const company = (invoice.client || '').trim();
  const addressLines = company && lines[0] === company ? lines.slice(1) : lines;
  const cityIndex = addressLines.findIndex((v, index) => index > 0 && /^\d{4,6}\s+\S/.test(v));
  const street = addressLines[0] ?? '';
  const cityLine = addressLines[cityIndex >= 0 ? cityIndex : 1] ?? '';
  const parsed = parseAddressFromLine(cityLine);
  return {
    name: (invoice.client || '').trim(),
    street,
    city: parsed.city,
    postalCode: parsed.postalCode,
    countryCode: 'DE',
  };
};

const normalizeSellerAddress = (settings: AppSettings): NormalizedEinvoice['seller'] => {
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
    countryCode: settings.legal.countryCode ?? 'DE',
    vatId: vatId || undefined,
    taxId: taxId || undefined,
    iban: settings.finance.iban.replace(/\s/g, '').toUpperCase() || undefined,
    contactName: (settings.company.owner ?? '').trim() || companyName || undefined,
    phone: (settings.company.phone ?? '').trim() || undefined,
    email: (settings.company.email ?? '').trim() || undefined,
  };
};

const assertRequired = (label: string, value: string) => {
  if (!value.trim()) {
    const hint = label.startsWith('Käufer')
      ? ' Bitte die Kundenadresse mit Straße, PLZ und Ort ergänzen (z. B. „Musterstraße 1, 12345 Musterstadt“). Ein normales PDF ohne E-Rechnung erhalten Sie, wenn Sie ZUGFeRD unter Einstellungen › Rechtliches ausschalten.'
      : '';
    throw new Error(`ZUGFeRD Export fehlgeschlagen: Pflichtfeld "${label}" fehlt.${hint}`);
  }
};

/** Service date or "YYYY-MM-DD bis YYYY-MM-DD" period of the invoice, as the e-invoice states it. */
const deliveryOf = (servicePeriod: string | undefined): NormalizedEinvoice['delivery'] => {
  const range = servicePeriod?.match(/^(\d{4}-\d{2}-\d{2}) bis (\d{4}-\d{2}-\d{2})$/);
  if (range) return { start: range[1]!, end: range[2]! };
  const date = servicePeriod?.match(/^\d{4}-\d{2}-\d{2}$/)?.[0];
  return date ? { date } : undefined;
};

export const normalizeInvoiceForEinvoice = (
  invoice: Invoice,
  settings: AppSettings,
  source?: { number: string; date: string },
): NormalizedEinvoice => {
  const seller = normalizeSellerAddress(settings);
  const buyer = normalizeBuyerAddress(invoice);
  const taxMode = resolveInvoiceTaxMode(invoice.taxMode, settings);
  const definition = getInvoiceTaxModeDefinition(taxMode);
  const isZeroVatMode = Boolean(definition.forceZeroVat);
  const defaultTaxRate = isZeroVatMode ? 0 : getDefaultTaxRate(settings);
  const taxExemptionReason = getInvoiceTaxExemptionReason(taxMode, invoice.taxMeta);
  const taxSnapshot = invoice.taxSnapshot ?? calculateInvoiceTaxSnapshot(
    { items: invoice.items, taxMode, taxMeta: invoice.taxMeta },
    settings,
  );

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
  assertRequired('Verkäufer USt-IdNr. oder Steuernummer', seller.vatId || seller.taxId || '');
  if (definition.requiresBuyerVatId) assertRequired('Käufer USt-IdNr.', invoice.taxMeta?.buyerVatId || '');

  const normalizedLines = (invoice.items ?? []).filter((item) => isBillableLine(item) || isOptionalLine(item)).map((item, idx) => {
    const optional = isOptionalLine(item);
    const quantity = toAmount(item.quantity) || 1;
    const netLineTotal = optional ? 0 : round2(getBillingLineAmount(item));
    // A position discount is a line allowance (BG-27): the unit price stays the agreed price.
    const discountPercent = Math.min(100, Math.max(0, toAmount(item.discountPercent)));
    const discountAmount = Math.max(0, toAmount(item.discountAmount));
    const price = toAmount(item.price);
    const discounted = !optional && price > 0 && netLineTotal >= 0 && (discountPercent > 0 || discountAmount > 0);
    const allowanceAmount = discounted ? round2(round2(quantity * round2(price)) - netLineTotal) : 0;
    const netUnitPrice = discounted && allowanceAmount >= 0 ? round2(price) : round2(quantity === 0 ? 0 : netLineTotal / quantity);
    const taxRate = isZeroVatMode ? 0 : item.taxRate ?? (invoice.taxMeta?.defaultVatRate ?? defaultTaxRate);
    return {
      lineId: String(idx + 1),
      name: `${(item.description || `Position ${idx + 1}`).trim()}${optional ? ` (Optional${item.optionNote ? `: ${item.optionNote.trim()}` : ''})` : ''}`,
      quantity,
      unitCode: 'C62', // piece
      netUnitPrice,
      netLineTotal,
      taxRate,
      taxCategoryCode: definition.einvoiceCategoryCode,
      taxExemptionReason,
      lineKind: (optional ? 'optional' : item.kind === 'time' ? 'time' : 'item') as 'item' | 'time' | 'optional',
      ...(discounted && allowanceAmount > 0
        ? { allowance: { amount: allowanceAmount, reason: discountPercent > 0 ? `Rabatt ${String(discountPercent).replace('.', ',')} %` : 'Rabatt' } }
        : {}),
    };
  });

  if (normalizedLines.length === 0) {
    throw new Error('ZUGFeRD Export fehlgeschlagen: Rechnung enthält keine Positionen.');
  }

  const allowances = normalizedLines.filter((line) => line.netLineTotal < 0).map((line) => ({
    amount: -line.netLineTotal,
    reason: line.name,
    taxRate: line.taxRate,
    taxCategoryCode: line.taxCategoryCode,
    taxExemptionReason: line.taxExemptionReason,
  }));
  const lines = normalizedLines.filter((line) => line.netLineTotal >= 0);
  const lineNetTotal = round2(lines.reduce((acc, line) => acc + line.netLineTotal, 0));
  const taxTotal = taxSnapshot.vatAmount;
  const grandTotal = taxSnapshot.grossAmount;

  const typeCode = invoice.documentKind === 'credit_note' || invoice.documentKind === 'cancellation_invoice' ? '381' as const : '380' as const;
  return {
    invoiceNumber: invoice.number.trim(),
    typeCode,
    issueDate: toIsoDate(invoice.date, 'date'),
    dueDate: toIsoDate(invoice.dueDate, 'dueDate'),
    currency: 'EUR',
    seller,
    buyer,
    buyerEmail: invoice.clientEmail?.trim() || undefined,
    buyerVatId: invoice.taxMeta?.buyerVatId?.trim() || undefined,
    buyerReference: (invoice.taxMeta as { buyerReference?: string } | undefined)?.buyerReference?.trim() || undefined,
    precedingInvoice: typeCode === '381' && source ? { number: source.number, date: toIsoDate(source.date, 'source.date') } : undefined,
    delivery: deliveryOf(invoice.servicePeriod),
    skonto: typeCode === '380' ? (invoice as { skonto?: { percent: number; days: number } }).skonto : undefined,
    lines,
    allowances,
    totals: {
      lineNetTotal,
      taxTotal,
      grandTotal,
    },
  };
};
