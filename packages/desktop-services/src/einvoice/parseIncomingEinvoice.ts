import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString, decodePDFRawStream } from 'pdf-lib';
import type { IncomingEinvoice } from '@billme/server-core';
import { EinvoiceRequestError } from './xrechnung';

/**
 * Reads a received e-invoice into a readable form (no booking, no rule engine):
 * CII (XRechnung CII, ZUGFeRD, Factur-X), UBL 2.1 (Invoice/CreditNote, XRechnung
 * UBL), or a PDF carrying factur-x.xml / zugferd-invoice.xml / xrechnung.xml.
 *
 * Untrusted input: DOCTYPE/ENTITY declarations are refused before parsing, the
 * parser decodes no entities itself and the file is capped at 14 MB.
 */

export const EINVOICE_MAX_BYTES = 14 * 1024 * 1024;
const MAX_XML_CHARS = 20 * 1024 * 1024;
const ATTACHMENT_NAME = /^(factur-x|zugferd[-_]invoice|xrechnung)\.xml$/i;

const notEinvoice = (reason: string) => new EinvoiceRequestError(`Keine E-Rechnung gefunden: ${reason}`, 422);

type Node = unknown;
const list = (value: Node): Node[] => (value == null ? [] : Array.isArray(value) ? value : [value]);
const child = (node: Node, ...path: string[]): Node => {
  let current = node;
  for (const key of path) {
    current = Array.isArray(current) ? current[0] : current;
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, Node>)[key];
  }
  return current;
};
const decodeEntities = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity: string) => {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  if (entity[0] !== '#') return named[entity.toLowerCase()] ?? match;
  const code = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
  return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
});
const text = (node: Node): string | undefined => {
  const value = Array.isArray(node) ? node[0] : node;
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>)['#text'] : value;
  if (raw == null || typeof raw === 'object') return undefined;
  const trimmed = decodeEntities(String(raw)).trim();
  return trimmed || undefined;
};
const attribute = (node: Node, name: string): string | undefined => {
  const value = Array.isArray(node) ? node[0] : node;
  return value && typeof value === 'object' ? text((value as Record<string, Node>)[`@_${name}`]) : undefined;
};
const amount = (node: Node): number | undefined => {
  const value = text(node);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const isCalendarDay = (iso: string) => {
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso;
};
/** CII date (format 102 = YYYYMMDD) or an ISO date (UBL), as YYYY-MM-DD. */
const isoDate = (node: Node): string | undefined => {
  const value = text(node);
  if (!value) return undefined;
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(value);
  const iso = compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : /^\d{4}-\d{2}-\d{2}/.exec(value)?.[0];
  return iso && isCalendarDay(iso) ? iso : undefined;
};
const ciiDate = (node: Node) => isoDate(child(node, 'DateTimeString'));
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const euro = (value: number) => value.toFixed(2).replace('.', ',');
const compact = <T extends Record<string, unknown>>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;

type Parsed = Omit<IncomingEinvoice, 'source' | 'warnings'>;

const parseCii = (root: Node): Parsed => {
  const header = child(root, 'ExchangedDocument');
  const transaction = child(root, 'SupplyChainTradeTransaction');
  const agreement = child(transaction, 'ApplicableHeaderTradeAgreement');
  const settlement = child(transaction, 'ApplicableHeaderTradeSettlement');
  const seller = child(agreement, 'SellerTradeParty');
  const buyer = child(agreement, 'BuyerTradeParty');
  const registration = (party: Node, scheme: string) =>
    list(child(party, 'SpecifiedTaxRegistration')).map((entry) => child(entry, 'ID')).find((id) => attribute(id, 'schemeID') === scheme);
  const currency = text(child(settlement, 'InvoiceCurrencyCode'));
  const summation = child(settlement, 'SpecifiedTradeSettlementHeaderMonetarySummation');
  const taxTotals = list(child(summation, 'TaxTotalAmount'));
  const payment = list(child(settlement, 'SpecifiedTradeSettlementPaymentMeans')).find((means) => child(means, 'PayeePartyCreditorFinancialAccount'));
  const period = child(settlement, 'BillingSpecifiedPeriod');
  const typeCode = text(child(header, 'TypeCode'));
  return {
    syntax: 'CII',
    profile: text(child(root, 'ExchangedDocumentContext', 'GuidelineSpecifiedDocumentContextParameter', 'ID')),
    typeCode,
    isCreditNote: typeCode === '381',
    number: text(child(header, 'ID')),
    issueDate: ciiDate(child(header, 'IssueDateTime')),
    dueDate: ciiDate(child(settlement, 'SpecifiedTradePaymentTerms', 'DueDateDateTime')),
    serviceDate: ciiDate(child(transaction, 'ApplicableHeaderTradeDelivery', 'ActualDeliverySupplyChainEvent', 'OccurrenceDateTime')),
    period: period ? compact({ start: ciiDate(child(period, 'StartDateTime')), end: ciiDate(child(period, 'EndDateTime')) }) : undefined,
    currency,
    buyerReference: text(child(agreement, 'BuyerReference')),
    seller: compact({
      name: text(child(seller, 'Name')),
      vatId: text(registration(seller, 'VA')),
      taxId: text(registration(seller, 'FC')),
      street: text(child(seller, 'PostalTradeAddress', 'LineOne')),
      zip: text(child(seller, 'PostalTradeAddress', 'PostcodeCode')),
      city: text(child(seller, 'PostalTradeAddress', 'CityName')),
      country: text(child(seller, 'PostalTradeAddress', 'CountryID')),
      email: text(child(seller, 'URIUniversalCommunication', 'URIID')) ?? text(child(seller, 'DefinedTradeContact', 'EmailURIUniversalCommunication', 'URIID')),
    }),
    buyer: compact({ name: text(child(buyer, 'Name')), vatId: text(registration(buyer, 'VA')) }),
    iban: text(child(payment, 'PayeePartyCreditorFinancialAccount', 'IBANID')),
    bic: text(child(payment, 'PayeeSpecifiedCreditorFinancialInstitution', 'BICID')),
    paymentReference: text(child(settlement, 'PaymentReference')),
    lines: list(child(transaction, 'IncludedSupplyChainTradeLineItem')).map((line) => {
      const tax = child(line, 'SpecifiedLineTradeSettlement', 'ApplicableTradeTax');
      const quantity = child(line, 'SpecifiedLineTradeDelivery', 'BilledQuantity');
      return compact({
        description: text(child(line, 'SpecifiedTradeProduct', 'Name')) ?? '',
        quantity: amount(quantity),
        unit: attribute(quantity, 'unitCode'),
        netPrice: amount(child(line, 'SpecifiedLineTradeAgreement', 'NetPriceProductTradePrice', 'ChargeAmount')),
        netAmount: amount(child(line, 'SpecifiedLineTradeSettlement', 'SpecifiedTradeSettlementLineMonetarySummation', 'LineTotalAmount')),
        vatRate: amount(child(tax, 'RateApplicablePercent')),
        vatCategory: text(child(tax, 'CategoryCode')),
      });
    }),
    vatBreakdown: list(child(settlement, 'ApplicableTradeTax')).map((group) => ({
      category: text(child(group, 'CategoryCode')) ?? '',
      rate: amount(child(group, 'RateApplicablePercent')) ?? 0,
      netAmount: amount(child(group, 'BasisAmount')) ?? 0,
      vatAmount: amount(child(group, 'CalculatedAmount')) ?? 0,
    })),
    totals: compact({
      net: amount(child(summation, 'TaxBasisTotalAmount')),
      vat: amount(taxTotals.find((total) => attribute(total, 'currencyID') === currency) ?? taxTotals[0]),
      gross: amount(child(summation, 'GrandTotalAmount')),
      due: amount(child(summation, 'DuePayableAmount')),
    }),
    notes: list(child(header, 'IncludedNote')).map((note) => text(child(note, 'Content'))).filter((note): note is string => Boolean(note)),
  };
};

const parseUbl = (root: Node, rootName: 'Invoice' | 'CreditNote'): Parsed => {
  const creditNote = rootName === 'CreditNote';
  const seller = child(root, 'AccountingSupplierParty', 'Party');
  const buyer = child(root, 'AccountingCustomerParty', 'Party');
  const taxScheme = (party: Node, vat: boolean) => list(child(party, 'PartyTaxScheme'))
    .find((scheme) => (text(child(scheme, 'TaxScheme', 'ID'))?.toUpperCase() === 'VAT') === vat);
  const partyName = (party: Node) => text(child(party, 'PartyName', 'Name')) ?? text(child(party, 'PartyLegalEntity', 'RegistrationName'));
  const currency = text(child(root, 'DocumentCurrencyCode'));
  const taxTotals = list(child(root, 'TaxTotal'));
  const taxTotal = taxTotals.find((total) => attribute(child(total, 'TaxAmount'), 'currencyID') === currency) ?? taxTotals[0];
  const monetary = child(root, 'LegalMonetaryTotal');
  const payment = list(child(root, 'PaymentMeans')).find((means) => child(means, 'PayeeFinancialAccount')) ?? child(root, 'PaymentMeans');
  const period = child(root, 'InvoicePeriod');
  const endpoint = child(seller, 'EndpointID');
  const typeCode = text(child(root, creditNote ? 'CreditNoteTypeCode' : 'InvoiceTypeCode'));
  return {
    syntax: 'UBL',
    profile: text(child(root, 'CustomizationID')),
    typeCode,
    isCreditNote: creditNote || typeCode === '381',
    number: text(child(root, 'ID')),
    issueDate: isoDate(child(root, 'IssueDate')),
    dueDate: isoDate(child(root, 'DueDate')) ?? isoDate(child(payment, 'PaymentDueDate')),
    serviceDate: isoDate(child(root, 'Delivery', 'ActualDeliveryDate')),
    period: period ? compact({ start: isoDate(child(period, 'StartDate')), end: isoDate(child(period, 'EndDate')) }) : undefined,
    currency,
    buyerReference: text(child(root, 'BuyerReference')),
    seller: compact({
      name: partyName(seller),
      vatId: text(child(taxScheme(seller, true), 'CompanyID')),
      taxId: text(child(taxScheme(seller, false), 'CompanyID')),
      street: text(child(seller, 'PostalAddress', 'StreetName')),
      zip: text(child(seller, 'PostalAddress', 'PostalZone')),
      city: text(child(seller, 'PostalAddress', 'CityName')),
      country: text(child(seller, 'PostalAddress', 'Country', 'IdentificationCode')),
      email: (attribute(endpoint, 'schemeID') === 'EM' ? text(endpoint) : undefined) ?? text(child(seller, 'Contact', 'ElectronicMail')),
    }),
    buyer: compact({ name: partyName(buyer), vatId: text(child(taxScheme(buyer, true), 'CompanyID')) }),
    iban: text(child(payment, 'PayeeFinancialAccount', 'ID')),
    bic: text(child(payment, 'PayeeFinancialAccount', 'FinancialInstitutionBranch', 'ID')),
    paymentReference: text(child(payment, 'PaymentID')),
    lines: list(child(root, creditNote ? 'CreditNoteLine' : 'InvoiceLine')).map((line) => {
      const quantity = child(line, creditNote ? 'CreditedQuantity' : 'InvoicedQuantity');
      const tax = child(line, 'Item', 'ClassifiedTaxCategory');
      return compact({
        description: text(child(line, 'Item', 'Name')) ?? text(child(line, 'Item', 'Description')) ?? '',
        quantity: amount(quantity),
        unit: attribute(quantity, 'unitCode'),
        netPrice: amount(child(line, 'Price', 'PriceAmount')),
        netAmount: amount(child(line, 'LineExtensionAmount')),
        vatRate: amount(child(tax, 'Percent')),
        vatCategory: text(child(tax, 'ID')),
      });
    }),
    vatBreakdown: list(child(taxTotal, 'TaxSubtotal')).map((subtotal) => ({
      category: text(child(subtotal, 'TaxCategory', 'ID')) ?? '',
      rate: amount(child(subtotal, 'TaxCategory', 'Percent')) ?? 0,
      netAmount: amount(child(subtotal, 'TaxableAmount')) ?? 0,
      vatAmount: amount(child(subtotal, 'TaxAmount')) ?? 0,
    })),
    totals: compact({
      net: amount(child(monetary, 'TaxExclusiveAmount')),
      vat: amount(child(taxTotal, 'TaxAmount')),
      gross: amount(child(monetary, 'TaxInclusiveAmount')),
      due: amount(child(monetary, 'PayableAmount')),
    }),
    notes: list(child(root, 'Note')).map(text).filter((note): note is string => Boolean(note)),
  };
};

const warningsOf = (invoice: Parsed): string[] => {
  const warnings: string[] = [];
  if (!invoice.profile) warnings.push('Kein Profil (BT-24) angegeben: unklar, nach welcher Spezifikation die Rechnung erstellt wurde.');
  if (invoice.isCreditNote) warnings.push('Gutschrift – bitte als Korrekturbeleg erfassen.');
  if (!invoice.number) warnings.push('Rechnungsnummer (BT-1) fehlt.');
  if (!invoice.issueDate) warnings.push('Rechnungsdatum (BT-2) fehlt oder ist kein gültiges Datum.');
  if (!invoice.seller.name) warnings.push('Name des Verkäufers (BT-27) fehlt.');
  if (!invoice.seller.vatId && !invoice.seller.taxId) warnings.push('Weder USt-IdNr. noch Steuernummer des Verkäufers angegeben.');
  if (invoice.currency && invoice.currency !== 'EUR') warnings.push(`Währung ${invoice.currency}: Die Beträge sind nicht in Euro.`);
  if (!invoice.lines.length) warnings.push('Die Rechnung enthält keine Positionen.');
  const { net, vat, gross } = invoice.totals;
  if (gross === undefined) warnings.push('Bruttobetrag (BT-112) fehlt.');
  const breakdownVat = round2(invoice.vatBreakdown.reduce((sum, group) => sum + group.vatAmount, 0));
  if (vat !== undefined && Math.abs(breakdownVat - vat) > 0.01) warnings.push(`Die Steuerbeträge je Steuersatz (${euro(breakdownVat)}) ergeben nicht die Gesamtsteuer (${euro(vat)}).`);
  if (net !== undefined && vat !== undefined && gross !== undefined && Math.abs(round2(net + vat) - gross) > 0.01) warnings.push(`Netto ${euro(net)} plus Steuer ${euro(vat)} ergibt nicht den Bruttobetrag ${euro(gross)}.`);
  return warnings;
};

const decodeUtf8 = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, '');
  } catch {
    throw notEinvoice('Die Datei ist weder PDF noch UTF-8-kodiertes XML.');
  }
};

const parseXml = (xml: string, source: IncomingEinvoice['source']): IncomingEinvoice => {
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(xml)) {
    throw new EinvoiceRequestError('Die XML-Datei enthält eine DOCTYPE- oder ENTITY-Deklaration und wird aus Sicherheitsgründen nicht gelesen.', 400);
  }
  if (!/^\s*</.test(xml)) throw notEinvoice('Die Datei ist weder PDF noch XML.');
  if (XMLValidator.validate(xml) !== true) throw notEinvoice('Das XML ist nicht wohlgeformt.');
  const document = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    removeNSPrefix: true,
    processEntities: false,
    htmlEntities: false,
    parseTagValue: false,
    parseAttributeValue: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
  }).parse(xml) as Record<string, Node>;
  const rootName = Object.keys(document).find((key) => !key.startsWith('?') && !key.startsWith('#'));
  const root = rootName ? document[rootName] : undefined;
  const parsed = rootName === 'CrossIndustryInvoice'
    ? parseCii(root)
    : rootName === 'Invoice' || rootName === 'CreditNote'
      ? parseUbl(root, rootName)
      : undefined;
  if (!parsed) throw notEinvoice('Das XML ist weder eine CII-Rechnung (XRechnung, ZUGFeRD, Factur-X) noch eine UBL-Rechnung.');
  return { ...parsed, source, warnings: warningsOf(parsed) };
};

const pdfText = (value: unknown) => (value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined);

/** The e-invoice XML attached to a PDF (embedded-files name tree, then the catalog's AF list). */
const extractFromPdf = async (bytes: Uint8Array): Promise<{ name: string; xml: string }> => {
  try {
    return findAttachment(await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }));
  } catch (error) {
    // pdf-lib parses broken files leniently and fails later, in any lookup.
    if (error instanceof EinvoiceRequestError) throw error;
    throw notEinvoice('Die PDF-Datei konnte nicht gelesen werden.');
  }
};

const findAttachment = (pdf: PDFDocument): { name: string; xml: string } => {
  const specs: PDFDict[] = [];
  const walk = (node: PDFDict | undefined, depth: number) => {
    if (!node || depth > 8) return;
    const names = node.lookupMaybe(PDFName.of('Names'), PDFArray);
    for (let index = 1; names && index < names.size(); index += 2) {
      const spec = names.lookupMaybe(index, PDFDict);
      if (spec) specs.push(spec);
    }
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    for (let index = 0; kids && index < kids.size(); index += 1) walk(kids.lookupMaybe(index, PDFDict), depth + 1);
  };
  walk(pdf.catalog.lookupMaybe(PDFName.of('Names'), PDFDict)?.lookupMaybe(PDFName.of('EmbeddedFiles'), PDFDict), 0);
  const associated = pdf.catalog.lookupMaybe(PDFName.of('AF'), PDFArray);
  for (let index = 0; associated && index < associated.size(); index += 1) {
    const spec = associated.lookupMaybe(index, PDFDict);
    if (spec) specs.push(spec);
  }
  for (const spec of specs) {
    const name = pdfText(spec.lookup(PDFName.of('UF'))) ?? pdfText(spec.lookup(PDFName.of('F')));
    if (!name || !ATTACHMENT_NAME.test(name)) continue;
    const files = spec.lookupMaybe(PDFName.of('EF'), PDFDict);
    const stream = files?.lookup(PDFName.of('F')) ?? files?.lookup(PDFName.of('UF'));
    if (!(stream instanceof PDFRawStream)) continue;
    let content: Uint8Array;
    try {
      content = decodePDFRawStream(stream).decode();
    } catch {
      throw notEinvoice(`Der Anhang ${name} konnte nicht entpackt werden.`);
    }
    if (content.length > MAX_XML_CHARS) throw notEinvoice(`Der Anhang ${name} ist zu groß.`);
    return { name, xml: decodeUtf8(content) };
  }
  throw notEinvoice('Die PDF-Datei enthält keine eingebettete Rechnung (factur-x.xml, zugferd-invoice.xml oder xrechnung.xml).');
};

export const parseIncomingEinvoice = async (bytes: Uint8Array, fileName: string): Promise<IncomingEinvoice> => {
  if (!bytes.length) throw new EinvoiceRequestError('Die Datei ist leer.', 400);
  if (bytes.length > EINVOICE_MAX_BYTES) throw new EinvoiceRequestError('Die Datei ist größer als 14 MB.', 400);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (head.includes('%PDF-')) {
    const { name, xml } = await extractFromPdf(bytes);
    return parseXml(xml, { kind: 'pdf', attachmentName: name });
  }
  if (/\.pdf$/i.test(fileName)) throw notEinvoice('Die Datei ist keine lesbare PDF-Datei.');
  return parseXml(decodeUtf8(bytes), { kind: 'xml' });
};
