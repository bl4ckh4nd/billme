import type {
  BillingLineItem,
  InvoiceTaxMeta,
  InvoiceTaxMode,
  InvoiceTaxModeDefinition,
} from '../domain/foundations.js';
import {
  getDefaultTaxRate,
  getInvoiceTaxExemptionReason,
  getInvoiceTaxModeDefinition,
  resolveInvoiceTaxMode,
  type TaxSettingsShape,
} from './taxMode.js';

type EinvoiceAddressInput = {
  company?: string;
  contactPerson?: string;
  street?: string;
  city?: string;
  zip?: string;
  postalCode?: string;
  country?: string;
};

export type EinvoiceInvoiceInput = {
  number: string;
  date?: string;
  dueDate?: string;
  client: string;
  clientAddress?: string;
  billingAddressJson?: unknown;
  items?: BillingLineItem[];
  taxMode?: InvoiceTaxMode;
  taxMeta?: InvoiceTaxMeta;
};

export type EinvoiceSettingsInput = TaxSettingsShape & {
  company: {
    name: string;
    street: string;
    city: string;
    zip: string;
  };
  finance: {
    vatId?: string;
    taxId?: string;
  };
};

type NormalizedAddress = {
  name: string;
  street: string;
  city: string;
  postalCode: string;
  countryCode: string;
};

export type NormalizedEinvoice = {
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
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
    taxCategoryCode: InvoiceTaxModeDefinition['einvoiceCategoryCode'];
    taxExemptionReason?: string;
  }>;
  totals: {
    lineNetTotal: number;
    taxTotal: number;
    grandTotal: number;
  };
};

export type EmbedZugferdInPdfParams = {
  pdfBytes: Uint8Array;
  xml: string;
  invoiceNumber: string;
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
  const match = /^(\d{4,6})\s+(.+)$/.exec(raw);
  if (match) return { postalCode: match[1]!, city: match[2]!.trim() };
  return { postalCode: '', city: raw };
};

const isEinvoiceAddressInput = (value: unknown): value is EinvoiceAddressInput =>
  typeof value === 'object' && value !== null;

const normalizeBuyerAddress = (invoice: EinvoiceInvoiceInput): NormalizedAddress => {
  const fromJson = isEinvoiceAddressInput(invoice.billingAddressJson) ? invoice.billingAddressJson : undefined;

  if (fromJson) {
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

const normalizeSellerAddress = (
  settings: EinvoiceSettingsInput,
): NormalizedAddress & { vatId?: string; taxId?: string } => {
  const companyName = settings.company.name.trim();
  const street = settings.company.street.trim();
  const city = settings.company.city.trim();
  const postalCode = settings.company.zip.trim();
  const vatId = settings.finance.vatId?.trim() ?? '';
  const taxId = settings.finance.taxId?.trim() ?? '';

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
  invoice: EinvoiceInvoiceInput,
  settings: EinvoiceSettingsInput,
): NormalizedEinvoice => {
  const seller = normalizeSellerAddress(settings);
  const buyer = normalizeBuyerAddress(invoice);
  const taxMode = resolveInvoiceTaxMode(invoice.taxMode, settings);
  const definition = getInvoiceTaxModeDefinition(taxMode);
  const isZeroVatMode = Boolean(definition.forceZeroVat);
  const defaultTaxRate = isZeroVatMode ? 0 : getDefaultTaxRate(settings);
  const taxExemptionReason = getInvoiceTaxExemptionReason(taxMode, invoice.taxMeta);

  assertRequired('Rechnungsnummer', invoice.number);
  assertRequired('Rechnungsdatum', invoice.date ?? '');
  assertRequired('Fälligkeitsdatum', invoice.dueDate ?? '');
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
    return {
      lineId: String(idx + 1),
      name: (item.description || `Position ${idx + 1}`).trim(),
      quantity,
      unitCode: 'C62',
      netUnitPrice,
      netLineTotal,
      taxRate: defaultTaxRate,
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
      grandTotal: round2(lineNetTotal + taxTotal),
    },
  };
};

const xmlEscape = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');

const formatAmount = (value: number): string => value.toFixed(2);
const formatQuantity = (value: number): string => Number(value.toFixed(6)).toString();

export const buildZugferdXml = (doc: NormalizedEinvoice): string => {
  const linesXml = doc.lines
    .map(
      (line) => `    <ram:IncludedSupplyChainTradeLineItem>
      <ram:AssociatedDocumentLineDocument>
        <ram:LineID>${xmlEscape(line.lineId)}</ram:LineID>
      </ram:AssociatedDocumentLineDocument>
      <ram:SpecifiedTradeProduct>
        <ram:Name>${xmlEscape(line.name)}</ram:Name>
      </ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeAgreement>
        <ram:NetPriceProductTradePrice>
          <ram:ChargeAmount>${formatAmount(line.netUnitPrice)}</ram:ChargeAmount>
        </ram:NetPriceProductTradePrice>
      </ram:SpecifiedLineTradeAgreement>
      <ram:SpecifiedLineTradeDelivery>
        <ram:BilledQuantity unitCode="${xmlEscape(line.unitCode)}">${formatQuantity(line.quantity)}</ram:BilledQuantity>
      </ram:SpecifiedLineTradeDelivery>
      <ram:SpecifiedLineTradeSettlement>
        <ram:ApplicableTradeTax>
          <ram:TypeCode>VAT</ram:TypeCode>
          <ram:CategoryCode>${line.taxCategoryCode}</ram:CategoryCode>
          <ram:RateApplicablePercent>${formatAmount(line.taxRate)}</ram:RateApplicablePercent>
        </ram:ApplicableTradeTax>
        <ram:SpecifiedTradeSettlementLineMonetarySummation>
          <ram:LineTotalAmount>${formatAmount(line.netLineTotal)}</ram:LineTotalAmount>
        </ram:SpecifiedTradeSettlementLineMonetarySummation>
      </ram:SpecifiedLineTradeSettlement>
    </ram:IncludedSupplyChainTradeLineItem>`,
    )
    .join('\n');

  const exemptionXml = doc.lines[0]?.taxExemptionReason
    ? `
          <ram:ExemptionReason>${xmlEscape(doc.lines[0].taxExemptionReason)}</ram:ExemptionReason>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice
  xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
  xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100"
  xmlns:udt="urn:un:unece:uncefact:data:standard:UnqualifiedDataType:100"
  xmlns:qdt="urn:un:unece:uncefact:data:standard:QualifiedDataType:100">
  <rsm:ExchangedDocumentContext>
    <ram:GuidelineSpecifiedDocumentContextParameter>
      <ram:ID>urn:cen.eu:en16931:2017</ram:ID>
    </ram:GuidelineSpecifiedDocumentContextParameter>
  </rsm:ExchangedDocumentContext>
  <rsm:ExchangedDocument>
    <ram:ID>${xmlEscape(doc.invoiceNumber)}</ram:ID>
    <ram:TypeCode>380</ram:TypeCode>
    <ram:IssueDateTime>
      <udt:DateTimeString format="102">${doc.issueDate.replaceAll('-', '')}</udt:DateTimeString>
    </ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
${linesXml}
    <ram:ApplicableHeaderTradeAgreement>
      <ram:SellerTradeParty>
        <ram:Name>${xmlEscape(doc.seller.name)}</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${xmlEscape(doc.seller.postalCode)}</ram:PostcodeCode>
          <ram:LineOne>${xmlEscape(doc.seller.street)}</ram:LineOne>
          <ram:CityName>${xmlEscape(doc.seller.city)}</ram:CityName>
          <ram:CountryID>${xmlEscape(doc.seller.countryCode)}</ram:CountryID>
        </ram:PostalTradeAddress>
        ${doc.seller.vatId ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="VA">${xmlEscape(doc.seller.vatId)}</ram:ID></ram:SpecifiedTaxRegistration>` : ''}
        ${doc.seller.taxId ? `<ram:SpecifiedTaxRegistration><ram:ID schemeID="FC">${xmlEscape(doc.seller.taxId)}</ram:ID></ram:SpecifiedTaxRegistration>` : ''}
      </ram:SellerTradeParty>
      <ram:BuyerTradeParty>
        <ram:Name>${xmlEscape(doc.buyer.name)}</ram:Name>
        <ram:PostalTradeAddress>
          <ram:PostcodeCode>${xmlEscape(doc.buyer.postalCode)}</ram:PostcodeCode>
          <ram:LineOne>${xmlEscape(doc.buyer.street)}</ram:LineOne>
          <ram:CityName>${xmlEscape(doc.buyer.city)}</ram:CityName>
          <ram:CountryID>${xmlEscape(doc.buyer.countryCode)}</ram:CountryID>
        </ram:PostalTradeAddress>
      </ram:BuyerTradeParty>
    </ram:ApplicableHeaderTradeAgreement>
    <ram:ApplicableHeaderTradeDelivery/>
    <ram:ApplicableHeaderTradeSettlement>
      <ram:InvoiceCurrencyCode>${doc.currency}</ram:InvoiceCurrencyCode>
      <ram:SpecifiedTradeSettlementPaymentMeans>
        <ram:TypeCode>58</ram:TypeCode>
      </ram:SpecifiedTradeSettlementPaymentMeans>
      <ram:ApplicableTradeTax>
        <ram:CalculatedAmount>${formatAmount(doc.totals.taxTotal)}</ram:CalculatedAmount>
        <ram:TypeCode>VAT</ram:TypeCode>
        <ram:BasisAmount>${formatAmount(doc.totals.lineNetTotal)}</ram:BasisAmount>
        <ram:CategoryCode>${doc.lines[0]?.taxCategoryCode ?? 'S'}</ram:CategoryCode>
        <ram:RateApplicablePercent>${formatAmount(doc.lines[0]?.taxRate ?? 0)}</ram:RateApplicablePercent>${exemptionXml}
      </ram:ApplicableTradeTax>
      <ram:SpecifiedTradePaymentTerms>
        <ram:DueDateDateTime>
          <udt:DateTimeString format="102">${doc.dueDate.replaceAll('-', '')}</udt:DateTimeString>
        </ram:DueDateDateTime>
      </ram:SpecifiedTradePaymentTerms>
      <ram:SpecifiedTradeSettlementHeaderMonetarySummation>
        <ram:LineTotalAmount>${formatAmount(doc.totals.lineNetTotal)}</ram:LineTotalAmount>
        <ram:TaxBasisTotalAmount>${formatAmount(doc.totals.lineNetTotal)}</ram:TaxBasisTotalAmount>
        <ram:TaxTotalAmount currencyID="${doc.currency}">${formatAmount(doc.totals.taxTotal)}</ram:TaxTotalAmount>
        <ram:GrandTotalAmount>${formatAmount(doc.totals.grandTotal)}</ram:GrandTotalAmount>
        <ram:DuePayableAmount>${formatAmount(doc.totals.grandTotal)}</ram:DuePayableAmount>
      </ram:SpecifiedTradeSettlementHeaderMonetarySummation>
    </ram:ApplicableHeaderTradeSettlement>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>
`;
};

export const embedZugferdInPdf = async ({
  pdfBytes,
  xml,
  invoiceNumber,
}: EmbedZugferdInPdfParams): Promise<Uint8Array> => {
  const payload = [
    '\n% BILLME_ZUGFERD_PAYLOAD_BEGIN',
    `% invoice=${invoiceNumber}`,
    '% filename=zugferd-invoice.xml',
    xml,
    '% BILLME_ZUGFERD_PAYLOAD_END',
    '',
  ].join('\n');
  const markerBytes = new TextEncoder().encode(payload);
  const out = new Uint8Array(pdfBytes.length + markerBytes.length);
  out.set(pdfBytes, 0);
  out.set(markerBytes, pdfBytes.length);
  return out;
};
