import Papa from 'papaparse';
import type { Article, Client } from '@billme/desktop-core/types';

/**
 * CSV import of clients and articles: pure parsing and mapping, browser-safe,
 * so the renderer reads the chosen file itself and saves the rows through the
 * regular upsert routes.
 */

export type CsvTable = { delimiter: ';' | ','; headers: string[]; rows: Array<Record<string, string>> };

export type CsvImportRow<T> = {
  /** 1-based data row (the header line is not counted). */
  rowIndex: number;
  label: string;
  status: 'ok' | 'duplicate' | 'error';
  errors: string[];
  record: T | null;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Reads a CSV text (UTF-8, optional BOM); the delimiter is taken from the header line, where "1.234,56" cannot occur. */
export const readMasterdataCsv = (text: string): CsvTable => {
  const input = text.replace(/^﻿/, '');
  const headerLine = input.split(/\r?\n/).find((line) => line.trim()) ?? '';
  const delimiter = (headerLine.split(';').length >= headerLine.split(',').length ? ';' : ',') as CsvTable['delimiter'];
  const parsed = Papa.parse<Record<string, string>>(input, {
    delimiter,
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (header) => header.trim(),
    transform: (value) => value.trim(),
  });
  return { delimiter, headers: parsed.meta.fields ?? [], rows: parsed.data };
};

/** "1.234,56", "1234,56", "1234.56", "1.234" and "€ 12" all parse; anything else is null. */
export const parseGermanNumber = (value: string): number | null => {
  const raw = value.replace(/[€%\s]/g, '');
  if (!raw) return null;
  let normalized = raw;
  if (raw.includes(',')) normalized = raw.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(raw)) normalized = raw.replace(/\./g, '');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  return Number(normalized);
};

const headerKey = (header: string) =>
  header.toLowerCase().replace(/ß/g, 'ss').replace(/[^a-z0-9äöü]/g, '');

const CLIENT_ALIASES = {
  company: ['firma', 'name', 'company', 'firmenname', 'kunde'],
  customerNumber: ['kundennummer', 'kundennr', 'customernumber', 'customerno'],
  contactPerson: ['ansprechpartner', 'kontakt', 'contact', 'contactperson'],
  email: ['email', 'mail'],
  phone: ['telefon', 'tel', 'phone'],
  street: ['strasse', 'street', 'adresse'],
  zip: ['plz', 'postleitzahl', 'zip', 'postalcode'],
  city: ['ort', 'stadt', 'city'],
  country: ['land', 'country'],
  vatId: ['ustidnr', 'ustid', 'ustidnummer', 'vatid'],
} as const;

const ARTICLE_ALIASES = {
  sku: ['artikelnummer', 'artikelnr', 'sku'],
  title: ['bezeichnung', 'title', 'titel', 'name'],
  description: ['beschreibung', 'description'],
  price: ['preis', 'netto', 'nettopreis', 'einzelpreis', 'price'],
  unit: ['einheit', 'unit'],
  taxRate: ['ust', 'mwst', 'ustsatz', 'mwstsatz', 'steuersatz', 'vat', 'vatrate', 'taxrate'],
  category: ['kategorie', 'category'],
} as const;

/** Maps each field to the first matching header, case-insensitively and ignoring spaces, dashes and dots. */
const fieldReader = <F extends string>(headers: string[], aliases: Record<F, readonly string[]>) => {
  const byKey = new Map(headers.map((header) => [headerKey(header), header]));
  const columns = Object.fromEntries(
    Object.entries(aliases).map(([field, names]) => [field, (names as readonly string[]).map((name) => byKey.get(name)).find(Boolean)]),
  ) as Record<F, string | undefined>;
  return (row: Record<string, string>, field: F) => {
    const column = columns[field];
    return column ? (row[column] ?? '').trim() : '';
  };
};

const lower = (value: string | undefined) => (value ?? '').trim().toLowerCase();

const billingZip = (client: Client) =>
  (client.addresses?.find((address) => address.isDefaultBilling) ?? client.addresses?.[0])?.zip?.trim() ?? '';

export const mapClientCsv = (table: CsvTable, existing: Client[], newId: () => string): CsvImportRow<Client>[] => {
  const read = fieldReader(table.headers, CLIENT_ALIASES);
  const numbers = new Set(existing.map((client) => lower(client.customerNumber)).filter(Boolean));
  const nameZips = new Set(existing.map((client) => `${lower(client.company)}|${billingZip(client)}`));
  return table.rows.map((row, index) => {
    const company = read(row, 'company');
    const customerNumber = read(row, 'customerNumber');
    const contactPerson = read(row, 'contactPerson');
    const email = read(row, 'email');
    const street = read(row, 'street');
    const zip = read(row, 'zip');
    const city = read(row, 'city');
    const country = read(row, 'country') || 'DE';
    const vatId = read(row, 'vatId').toUpperCase();
    const errors: string[] = [];
    if (!company) errors.push('Firma fehlt');
    if (email && !EMAIL.test(email)) errors.push(`Ungültige E-Mail: ${email}`);
    const label = company || `Zeile ${index + 1}`;
    if (errors.length) return { rowIndex: index + 1, label, status: 'error', errors, record: null };

    const nameZip = `${lower(company)}|${zip}`;
    if ((customerNumber && numbers.has(lower(customerNumber))) || nameZips.has(nameZip)) {
      return { rowIndex: index + 1, label, status: 'duplicate', errors: [], record: null };
    }
    if (customerNumber) numbers.add(lower(customerNumber));
    nameZips.add(nameZip);

    const id = newId();
    const hasAddress = Boolean(street || zip || city);
    const record: Client = {
      id,
      customerNumber: customerNumber || undefined,
      company,
      contactPerson,
      email,
      phone: read(row, 'phone'),
      address: [street, `${zip} ${city}`.trim()].filter(Boolean).join('\n'),
      status: 'active',
      tags: [],
      notes: '',
      projects: [],
      activities: [],
      addresses: hasAddress
        ? [{ id: newId(), clientId: id, label: 'Rechnungsadresse', kind: 'billing', street, zip, city, country, isDefaultBilling: true, isDefaultShipping: true }]
        : [],
      emails: email
        ? [{ id: newId(), clientId: id, label: 'Buchhaltung', kind: 'billing', email, isDefaultGeneral: true, isDefaultBilling: true }]
        : [],
      contacts: contactPerson ? [{ id: newId(), name: contactPerson, isPrimary: true }] : [],
      ...(vatId ? { taxProfile: { type: 'business' as const, vatId, ...(/^[A-Za-z]{2}$/.test(country) ? { countryCode: country.toUpperCase() } : {}) } } : {}),
    };
    return { rowIndex: index + 1, label, status: 'ok', errors: [], record };
  });
};

const ALLOWED_VAT_RATES = [0, 7, 19];

export const mapArticleCsv = (table: CsvTable, existing: Article[], newId: () => string): CsvImportRow<Article>[] => {
  const read = fieldReader(table.headers, ARTICLE_ALIASES);
  const skus = new Set(existing.map((article) => lower(article.sku)).filter(Boolean));
  const titles = new Set(existing.map((article) => lower(article.title)));
  return table.rows.map((row, index) => {
    const title = read(row, 'title');
    const sku = read(row, 'sku');
    const priceText = read(row, 'price');
    const rateText = read(row, 'taxRate');
    const price = parseGermanNumber(priceText);
    // A blank rate is the regular German rate.
    const taxRate = rateText ? parseGermanNumber(rateText) : 19;
    const errors: string[] = [];
    if (!title) errors.push('Bezeichnung fehlt');
    if (price === null) errors.push(`Preis ist keine Zahl: ${priceText || 'leer'}`);
    if (taxRate === null || !ALLOWED_VAT_RATES.includes(taxRate)) errors.push(`USt-Satz muss 0, 7 oder 19 sein: ${rateText}`);
    const label = title || sku || `Zeile ${index + 1}`;
    if (errors.length) return { rowIndex: index + 1, label, status: 'error', errors, record: null };

    if ((sku && skus.has(lower(sku))) || titles.has(lower(title))) {
      return { rowIndex: index + 1, label, status: 'duplicate', errors: [], record: null };
    }
    if (sku) skus.add(lower(sku));
    titles.add(lower(title));

    const record: Article = {
      id: newId(),
      ...(sku ? { sku } : {}),
      title,
      description: read(row, 'description'),
      price: price!,
      unit: read(row, 'unit') || 'Stk',
      category: read(row, 'category') || 'Allgemein',
      taxRate: taxRate!,
    };
    return { rowIndex: index + 1, label, status: 'ok', errors: [], record };
  });
};
