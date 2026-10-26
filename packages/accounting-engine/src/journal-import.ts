import iconv from 'iconv-lite';
import { DATEV_COLUMNS } from './datev-export';

/**
 * Reading booked entries from another bookkeeping: a DATEV Buchungsstapel (EXTF/DTVF, header 700, category 21) or a
 * plain journal CSV with one row per line. Pure parsing only: which tax lines a row books and whether its accounts,
 * periods and tax cases exist is decided by the tenant (server-data journalImport.ts).
 */

export interface JournalImportIssue {
  /** Line of the file (1-based); 0 for the file as a whole. */
  row: number;
  message: string;
  blocking: boolean;
}

export interface DatevImportRow {
  row: number;
  /** ISO Belegdatum: DATEV field 10 (TTMM) with the year of the header period. */
  date: string;
  /** Umsatz in cents, always positive; the direction is `side`. */
  amountCents: number;
  /** S: Konto in Soll, Gegenkonto in Haben. H: the other way round. Generalumkehr is already applied. */
  side: 'S' | 'H';
  konto: string;
  gegenkonto: string;
  /** Four digits, e.g. 0009; undefined without a BU-Schlüssel. */
  buKey?: string;
  reference: string;
  bookingText: string;
  euLandUstId?: string;
  euSteuersatz?: number;
  sachverhaltLl?: string;
}

export interface DatevImportStack {
  consultantNumber?: string;
  clientNumber?: string;
  fiscalYearStart?: string;
  accountLength?: number;
  from?: string;
  to?: string;
  chart?: 'SKR03' | 'SKR04';
  label?: string;
  rows: DatevImportRow[];
  issues: JournalImportIssue[];
}

export interface JournalCsvLine {
  row: number;
  accountNumber: string;
  debitCents: number;
  creditCents: number;
  /** Tax case key (DE_STD_19, NON_EU_SERVICE_RC, …); the aliases VSt19/USt19/19 are already resolved. */
  taxCaseKey?: string;
  /** VSt… says input, USt… output; a refund books Vorsteuer in Haben, so the side alone does not tell. */
  taxDirection?: 'input' | 'output';
  countryCode?: string;
  counterpartyVatId?: string;
  memo?: string;
}

export interface JournalCsvEntry {
  /** Stable within the file: the Buchung column, else Datum and Belegnummer. */
  key: string;
  rows: number[];
  documentDate: string;
  reference: string;
  bookingText: string;
  lines: JournalCsvLine[];
}

export interface JournalCsvImport {
  entries: JournalCsvEntry[];
  issues: JournalImportIssue[];
}

const blocking = (row: number, message: string): JournalImportIssue => ({ row, message, blocking: true });

/** UTF-8 (with or without BOM) when the bytes are valid UTF-8, else Windows-1252 as DATEV writes it. */
export const decodeImportText = (bytes: Uint8Array): string => {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return iconv.decode(Buffer.from(bytes), 'win1252');
  }
};

/** Rows of a delimited text with the line each row starts on; quoted fields may hold the delimiter, "" and line breaks. */
export const parseDelimited = (text: string, delimiter: string): Array<{ line: number; fields: string[] }> => {
  const rows: Array<{ line: number; fields: string[] }> = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let rowStart = 1;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { field += '"'; index += 1; } else quoted = false;
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === delimiter) { fields.push(field); field = ''; continue; }
    if (char === '\r' && text[index + 1] === '\n') continue;
    if (char === '\n' || char === '\r') {
      fields.push(field);
      if (fields.some((value) => value.trim() !== '')) rows.push({ line: rowStart, fields });
      fields = []; field = ''; line += 1; rowStart = line;
      continue;
    }
    field += char;
  }
  fields.push(field);
  if (fields.some((value) => value.trim() !== '')) rows.push({ line: rowStart, fields });
  return rows;
};

/** 1.234,56 / 1234,56 / 1234.56 to cents; null for anything else (also more than two decimals). */
export const parseAmountCents = (value: string): number | null => {
  const raw = value.trim().replace(/\s/g, '');
  if (!raw) return null;
  const normalized = raw.includes(',') ? raw.replace(/\./g, '').replace(',', '.') : raw;
  if (!/^-?\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
};

const ymd = (value: string): string | undefined => {
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(value.trim());
  return match ? isoIfValid(Number(match[1]), Number(match[2]), Number(match[3])) : undefined;
};
const isoIfValid = (year: number, month: number, day: number): string | undefined => {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  return date.toISOString().slice(0, 10);
};

/** DD.MM.YYYY, YYYY-MM-DD or DD.MM.YY (20YY) to ISO. */
export const parseImportDate = (value: string): string | undefined => {
  const raw = value.trim();
  let match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match) return isoIfValid(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})$/.exec(raw);
  if (match) return isoIfValid(match[3]!.length === 2 ? 2000 + Number(match[3]) : Number(match[3]), Number(match[2]), Number(match[1]));
  return undefined;
};

/**
 * DATEV field 10 holds TTMM (a leading zero may be missing) or TTMMJJJJ. The year comes from the header period
 * (Datum vom/bis, else the Wirtschaftsjahr): the first year that puts the date inside it.
 */
const datevBelegdatum = (value: string, from?: string, to?: string, fiscalYearStart?: string): string | undefined => {
  const raw = value.trim();
  if (/^\d{8}$/.test(raw)) return isoIfValid(Number(raw.slice(4)), Number(raw.slice(2, 4)), Number(raw.slice(0, 2)));
  if (!/^\d{3,4}$/.test(raw)) return undefined;
  const padded = raw.padStart(4, '0');
  const day = Number(padded.slice(0, 2)); const month = Number(padded.slice(2));
  const years = [...new Set([from, to, fiscalYearStart].filter((date): date is string => Boolean(date)).map((date) => Number(date.slice(0, 4))))];
  for (const year of years) {
    const iso = isoIfValid(year, month, day);
    if (iso && (!from || iso >= from) && (!to || iso <= to)) return iso;
  }
  return !from && !to && years[0] ? isoIfValid(years[0], month, day) : undefined;
};

const unquote = (value: string | undefined): string => (value ?? '').trim();

/** Header fields 1–31 of format 700 (DATEV Developer Portal, Header). */
const readDatevHeader = (fields: string[], issues: JournalImportIssue[]): Omit<DatevImportStack, 'rows' | 'issues'> | null => {
  const kind = unquote(fields[0]);
  if (kind !== 'EXTF' && kind !== 'DTVF') {
    issues.push(blocking(1, 'Keine DATEV-Datei: Zeile 1 beginnt nicht mit EXTF oder DTVF.'));
    return null;
  }
  const category = Number(unquote(fields[2]));
  if (category !== 21) {
    issues.push(blocking(1, `DATEV-Formatkategorie ${unquote(fields[2]) || '–'} wird nicht unterstützt; importiert wird nur der Buchungsstapel (21).`));
    return null;
  }
  const accountLength = Number(unquote(fields[13]));
  const skr = unquote(fields[26]);
  return {
    consultantNumber: unquote(fields[10]) || undefined,
    clientNumber: unquote(fields[11]) || undefined,
    fiscalYearStart: ymd(unquote(fields[12])),
    accountLength: Number.isInteger(accountLength) && accountLength >= 4 && accountLength <= 8 ? accountLength : undefined,
    from: ymd(unquote(fields[14])),
    to: ymd(unquote(fields[15])),
    label: unquote(fields[16]) || undefined,
    chart: skr === '03' ? 'SKR03' : skr === '04' ? 'SKR04' : undefined,
  };
};

const normalizeHeading = (value: string): string => value.toLowerCase().replace(/[^a-z0-9äöüß+]/g, '');
const DATEV_FIELD = {
  amount: 'Umsatz (ohne Soll/Haben-Kz)', side: 'Soll/Haben-Kennzeichen', currency: 'WKZ Umsatz', konto: 'Konto', gegenkonto: 'Gegenkonto (ohne BU-Schlüssel)',
  bu: 'BU-Schlüssel', date: 'Belegdatum', reference: 'Belegfeld 1', text: 'Buchungstext', euLand: 'EU-Land u. UStID (Bestimmung)',
  euRate: 'EU-Steuersatz (Bestimmung)', sachverhalt: 'Sachverhalt L+L', reversal: 'Generalumkehr (GU)',
} as const;

/** Column index per field: by its heading in row 2, else its position in format 13. */
const datevColumnIndex = (heading: string[]): Record<keyof typeof DATEV_FIELD, number> => {
  const byName = new Map(heading.map((title, index) => [normalizeHeading(title), index]));
  const out = {} as Record<keyof typeof DATEV_FIELD, number>;
  for (const [key, title] of Object.entries(DATEV_FIELD) as Array<[keyof typeof DATEV_FIELD, string]>) {
    out[key] = byName.get(normalizeHeading(title)) ?? (DATEV_COLUMNS as readonly string[]).indexOf(title);
  }
  // Older stacks title field 1 just "Umsatz".
  if (!byName.has(normalizeHeading(DATEV_FIELD.amount)) && byName.has('umsatz')) out.amount = byName.get('umsatz')!;
  return out;
};

const account = (value: string): string => value.trim().replace(/^0+(?=\d{4,})/, '');

/** A DATEV Buchungsstapel: header, heading and one booking per row. Rows that cannot be read become blocking issues. */
export const parseDatevBuchungsstapel = (bytes: Uint8Array): DatevImportStack => {
  const issues: JournalImportIssue[] = [];
  const rows = parseDelimited(decodeImportText(bytes), ';');
  if (rows.length < 2) return { rows: [], issues: [blocking(0, 'Die Datei enthält keinen DATEV-Kopf und keine Spaltenüberschrift.')] };
  const header = readDatevHeader(rows[0]!.fields, issues);
  if (!header) return { rows: [], issues };
  const column = datevColumnIndex(rows[1]!.fields);
  const out: DatevImportRow[] = [];
  for (const { line, fields } of rows.slice(2)) {
    const get = (key: keyof typeof DATEV_FIELD) => unquote(fields[column[key]]);
    const amountCents = parseAmountCents(get('amount'));
    if (amountCents === null || amountCents <= 0) { issues.push(blocking(line, `Umsatz „${get('amount')}“ ist kein positiver Betrag.`)); continue; }
    const currency = get('currency');
    if (currency && currency.toUpperCase() !== 'EUR') { issues.push(blocking(line, `Fremdwährung ${currency} wird nicht importiert.`)); continue; }
    let side = get('side').toUpperCase();
    if (side !== 'S' && side !== 'H') { issues.push(blocking(line, `Soll/Haben-Kennzeichen „${get('side')}“ ist weder S noch H.`)); continue; }
    // Generalumkehr: the booking is a reversal with swapped sides.
    if (get('reversal') === '1') side = side === 'S' ? 'H' : 'S';
    const konto = account(get('konto')); const gegenkonto = account(get('gegenkonto'));
    if (!/^\d{1,9}$/.test(konto) || !/^\d{1,9}$/.test(gegenkonto)) { issues.push(blocking(line, `Konto „${get('konto')}“ oder Gegenkonto „${get('gegenkonto')}“ ist keine Kontonummer.`)); continue; }
    const date = datevBelegdatum(get('date'), header.from, header.to, header.fiscalYearStart);
    if (!date) { issues.push(blocking(line, `Belegdatum „${get('date')}“ liegt nicht im Zeitraum des Stapels.`)); continue; }
    const bu = get('bu');
    if (bu && !/^\d{1,4}$/.test(bu)) { issues.push(blocking(line, `BU-Schlüssel „${bu}“ ist ungültig.`)); continue; }
    const euRate = get('euRate') ? Number(get('euRate').replace(',', '.')) : undefined;
    out.push({
      row: line, date, amountCents, side: side as 'S' | 'H', konto, gegenkonto,
      buKey: bu && Number(bu) !== 0 ? bu.padStart(4, '0') : undefined,
      reference: get('reference'), bookingText: get('text'),
      euLandUstId: get('euLand') || undefined,
      euSteuersatz: euRate !== undefined && Number.isFinite(euRate) ? euRate : undefined,
      sachverhaltLl: get('sachverhalt') && get('sachverhalt') !== '0' ? get('sachverhalt') : undefined,
    });
  }
  if (!out.length && !issues.length) issues.push(blocking(0, 'Der Buchungsstapel enthält keine Buchungen.'));
  return { ...header, rows: out, issues };
};

const JOURNAL_COLUMNS = {
  entry: ['buchung', 'buchungsnr', 'buchungsnummer', 'satz', 'satznr', 'entry'],
  date: ['datum', 'belegdatum', 'buchungsdatum', 'date'],
  reference: ['belegnr', 'belegnummer', 'beleg', 'belegfeld1', 'reference'],
  text: ['buchungstext', 'text'],
  account: ['konto', 'kontonr', 'kontonummer', 'account'],
  debit: ['soll', 'debit'],
  credit: ['haben', 'credit'],
  tax: ['steuerfall', 'steuerschlüssel', 'steuerschluessel', 'steuer', 'taxcase'],
  country: ['land', 'country'],
  vatId: ['ustidnr', 'ustid', 'vatid'],
  memo: ['notiz', 'memo', 'bemerkung', 'anmerkung'],
} as const;

const TAX_ALIASES: Record<string, string> = {
  '19': 'DE_STD_19', VST19: 'DE_STD_19', UST19: 'DE_STD_19', '7': 'DE_STD_7', VST7: 'DE_STD_7', UST7: 'DE_STD_7',
};
const taxCase = (value: string): { taxCaseKey: string; taxDirection?: 'input' | 'output' } | undefined => {
  const raw = value.trim().toUpperCase().replace(/\s|%/g, '');
  if (!raw || raw === '0' || raw === 'OHNE') return undefined;
  const taxDirection = raw.startsWith('VST') ? 'input' : raw.startsWith('UST') ? 'output' : undefined;
  return { taxCaseKey: TAX_ALIASES[raw] ?? raw, ...(taxDirection ? { taxDirection } : {}) };
};

/**
 * Journal CSV: one row per journal line with Konto, Soll and Haben; the column Buchung (or Datum + Belegnummer)
 * groups the rows of one entry. Steuerfall on a line keys its tax: with a matching tax line in the entry the line is
 * net, without one it is gross and the tax line is split off. Delimiter ; or , (the one of the heading row).
 */
export const parseJournalCsv = (bytes: Uint8Array): JournalCsvImport => {
  const text = decodeImportText(bytes);
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const count = (char: string) => firstLine.split(char).length - 1;
  const delimiter = [';', '\t', ','].reduce((best, char) => (count(char) > count(best) ? char : best), ';');
  const rows = parseDelimited(text, delimiter);
  const issues: JournalImportIssue[] = [];
  if (!rows.length) return { entries: [], issues: [blocking(0, 'Die Datei ist leer.')] };
  const heading = rows[0]!.fields.map(normalizeHeading);
  const index = Object.fromEntries(Object.entries(JOURNAL_COLUMNS).map(([key, names]) => [key, heading.findIndex((title) => (names as readonly string[]).includes(title))])) as Record<keyof typeof JOURNAL_COLUMNS, number>;
  const missing = (['account', 'debit', 'credit'] as const).filter((key) => index[key] < 0);
  if (index.entry < 0 && (index.date < 0 || index.reference < 0)) missing.push('entry' as never);
  if (missing.length) {
    const names: Record<string, string> = { account: 'Konto', debit: 'Soll', credit: 'Haben', entry: 'Buchung (oder Datum und Belegnr)' };
    return { entries: [], issues: [blocking(1, `Spalten fehlen: ${missing.map((key) => names[key]).join(', ')}.`)] };
  }
  const entries = new Map<string, JournalCsvEntry>();
  for (const { line, fields } of rows.slice(1)) {
    const get = (key: keyof typeof JOURNAL_COLUMNS) => (index[key] >= 0 ? (fields[index[key]] ?? '').trim() : '');
    const dateText = get('date'); const reference = get('reference');
    const key = get('entry') || (dateText && reference ? `${dateText}|${reference}` : '');
    if (!key) { issues.push(blocking(line, 'Die Zeile gehört zu keiner Buchung: Buchung bzw. Datum und Belegnummer fehlen.')); continue; }
    const debit = get('debit') ? parseAmountCents(get('debit')) : 0;
    const credit = get('credit') ? parseAmountCents(get('credit')) : 0;
    if (debit === null || credit === null || debit < 0 || credit < 0 || (debit > 0) === (credit > 0)) {
      issues.push(blocking(line, 'Jede Zeile braucht einen positiven Betrag entweder im Soll oder im Haben.'));
      continue;
    }
    const accountNumber = account(get('account'));
    if (!/^\d{1,9}$/.test(accountNumber)) { issues.push(blocking(line, `Konto „${get('account')}“ ist keine Kontonummer.`)); continue; }
    let entry = entries.get(key);
    if (!entry) {
      const documentDate = parseImportDate(dateText);
      if (!documentDate) { issues.push(blocking(line, `Datum „${dateText}“ ist ungültig (TT.MM.JJJJ oder JJJJ-MM-TT).`)); continue; }
      entry = { key, rows: [], documentDate, reference, bookingText: get('text'), lines: [] };
      entries.set(key, entry);
    } else if (dateText && parseImportDate(dateText) !== entry.documentDate) {
      issues.push(blocking(line, `Die Zeilen der Buchung ${key} haben verschiedene Daten.`));
      continue;
    }
    if (!entry.reference && reference) entry.reference = reference;
    if (!entry.bookingText && get('text')) entry.bookingText = get('text');
    const country = get('country').toUpperCase();
    entry.rows.push(line);
    entry.lines.push({
      row: line, accountNumber, debitCents: debit, creditCents: credit, ...taxCase(get('tax')),
      countryCode: /^[A-Z]{2}$/.test(country) ? country : undefined,
      counterpartyVatId: get('vatId').replace(/\s/g, '').toUpperCase() || undefined,
      memo: get('memo') || undefined,
    });
  }
  if (!entries.size && !issues.length) issues.push(blocking(0, 'Die Datei enthält keine Buchungszeilen.'));
  return { entries: [...entries.values()], issues };
};
