import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import iconv from 'iconv-lite';
import Papa from 'papaparse';
import { logger } from '../utils/logger';

export type CsvProfile = 'fints' | 'paypal' | 'stripe' | 'generic';

export type CsvMapping = {
  dateColumn: string;
  amountColumn: string;
  counterpartyColumn?: string;
  purposeColumn?: string;
  statusColumn?: string;
  externalIdColumn?: string;
  currencyColumn?: string;
  currencyExpected?: string; // e.g. "EUR"
};

export type CsvPreviewRow = {
  rowIndex: number;
  raw: Record<string, string>;
  parsed: {
    date?: string;
    amount?: number;
    type?: 'income' | 'expense';
    counterparty?: string;
    purpose?: string;
    status?: 'pending' | 'booked';
    externalId?: string;
    currency?: string;
  };
  errors: string[];
  dedupHash?: string;
};

export type CsvPreviewResult = {
  path: string;
  fileName: string;
  fileSha256: string;
  delimiter: string;
  headers: string[];
  profile: CsvProfile;
  suggestedMapping: CsvMapping;
  rows: CsvPreviewRow[];
  stats: { totalRows: number; previewRows: number; validRows: number; errorRows: number };
};

export type CsvImportCommitResult = {
  batchId: string;
  imported: number;
  skipped: number;
  errors: Array<{ rowIndex: number; message: string }>;
  fileSha256: string;
};

const sha256Hex = (buf: Buffer | string) => crypto.createHash('sha256').update(buf).digest('hex');

const firstNonEmptyLine = (s: string): string => {
  const lines = s.split(/\r?\n/);
  for (const l of lines) {
    const t = l.trim();
    if (t) return t;
  }
  return '';
};

const detectDelimiter = (headerLine: string): string => {
  const candidates = [';', ',', '\t'] as const;
  let best = ';';
  let bestCount = -1;
  for (const d of candidates) {
    const count = headerLine.split(d).length - 1;
    if (count > bestCount) {
      bestCount = count;
      best = d;
    }
  }
  return best;
};

const normalizeHeader = (s: string) =>
  s
    .toLowerCase()
    .replaceAll('ä', 'ae')
    .replaceAll('ö', 'oe')
    .replaceAll('ü', 'ue')
    .replaceAll('ß', 'ss')
    .replaceAll(/[^a-z0-9]+/g, '');

const pickHeader = (headers: string[], candidates: string[]): string | undefined => {
  const byNorm = new Map(headers.map((h) => [normalizeHeader(h), h]));
  for (const c of candidates) {
    const hit = byNorm.get(normalizeHeader(c));
    if (hit) return hit;
  }
  return undefined;
};

export const detectProfile = (headers: string[]): CsvProfile => {
  const norms = new Set(headers.map(normalizeHeader));
  const has = (h: string) => norms.has(normalizeHeader(h));

  // Stripe exports typically include "Balance Transaction ID" or "Created (UTC)" or "Currency"
  if (has('Created (UTC)') || has('Balance Transaction ID') || (has('Currency') && has('Type') && has('Description'))) {
    return 'stripe';
  }

  // PayPal exports typically include "Transaction ID" + "Type" + "Net"
  if (has('Transaction ID') || (has('Net') && has('Type') && (has('Date') || has('Datum')))) {
    return 'paypal';
  }

  // FinTS/bank exports often include Buchungstag/Valutadatum/Verwendungszweck/Begünstigter
  if (has('Buchungstag') || has('Valutadatum') || has('Verwendungszweck') || has('Begünstigter/Zahlungspflichtiger')) {
    return 'fints';
  }

  return 'generic';
};

export const suggestedMappingFor = (profile: CsvProfile, headers: string[]): CsvMapping => {
  if (profile === 'stripe') {
    return {
      dateColumn: pickHeader(headers, ['Created (UTC)', 'Created', 'Date']) ?? headers[0]!,
      amountColumn: pickHeader(headers, ['Amount', 'Net', 'Gross']) ?? headers[0]!,
      counterpartyColumn: pickHeader(headers, ['Customer', 'Source', 'Description']),
      purposeColumn: pickHeader(headers, ['Description', 'Type', 'ID']),
      externalIdColumn: pickHeader(headers, ['ID', 'Balance Transaction ID']),
      currencyColumn: pickHeader(headers, ['Currency']),
      currencyExpected: 'EUR',
    };
  }
  if (profile === 'paypal') {
    return {
      dateColumn: pickHeader(headers, ['Date', 'Datum']) ?? headers[0]!,
      amountColumn: pickHeader(headers, ['Net', 'Net Amount', 'Amount', 'Gross']) ?? headers[0]!,
      counterpartyColumn: pickHeader(headers, ['Name', 'From Email Address', 'To Email Address', 'Payee Name']),
      purposeColumn: pickHeader(headers, ['Type', 'Item Title', 'Subject', 'Note', 'Description']),
      externalIdColumn: pickHeader(headers, ['Transaction ID', 'Transaction ID/Order ID']),
      currencyColumn: pickHeader(headers, ['Currency', 'Währung']),
      currencyExpected: 'EUR',
    };
  }
  if (profile === 'fints') {
    return {
      dateColumn: pickHeader(headers, ['Buchungstag', 'Valutadatum', 'Datum']) ?? headers[0]!,
      amountColumn: pickHeader(headers, ['Betrag', 'Umsatz', 'Buchungsbetrag']) ?? headers[0]!,
      counterpartyColumn: pickHeader(headers, [
        'Begünstigter/Zahlungspflichtiger',
        'Auftraggeber/Empfänger',
        'Empfänger',
        'Auftraggeber',
        'Name',
      ]),
      purposeColumn: pickHeader(headers, ['Verwendungszweck', 'Buchungstext', 'Text', 'Beschreibung']),
      currencyColumn: pickHeader(headers, ['Währung', 'Currency']),
      currencyExpected: 'EUR',
    };
  }
  return {
    dateColumn: headers[0] ?? 'date',
    amountColumn: headers[1] ?? headers[0] ?? 'amount',
    counterpartyColumn: headers[2],
    purposeColumn: headers[3],
  };
};

const parseGermanNumber = (input: string): number | null => {
  const raw = input.trim();
  if (!raw) return null;
  // strip currency symbols/spaces
  let s = raw.replaceAll(/\s+/g, '').replaceAll('€', '');
  // parentheses for negatives
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  // detect decimal separator
  const hasComma = s.includes(',');
  const hasDot = s.includes('.');
  if (hasComma && hasDot) {
    // assume dot thousands, comma decimals: 1.234,56
    s = s.replaceAll('.', '').replaceAll(',', '.');
  } else if (hasComma && !hasDot) {
    // assume comma decimals
    s = s.replaceAll(',', '.');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
};

const parseDateToIso = (input: string): string | null => {
  const s = input.trim();
  if (!s) return null;
  // ISO date
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }
  // DE: DD.MM.YYYY
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
  if (m) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = Number(m[3]);
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return d.toISOString().slice(0, 10);
  }
  // US-ish: MM/DD/YYYY
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (us) {
    const month = Number(us[1]);
    const day = Number(us[2]);
    const year = Number(us[3]);
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
    return d.toISOString().slice(0, 10);
  }
  return null;
};

const readFileDecoded = (filePath: string, encoding: 'utf8' | 'win1252'): { text: string; sha256: string } => {
  let buf: Buffer;
  try {
    buf = fs.readFileSync(filePath);
  } catch (error) {
    logger.error('CSVImport', 'Failed to read CSV file', error as Error, { filePath });
    throw new Error(`Fehler beim Lesen der CSV-Datei: ${error instanceof Error ? error.message : String(error)}`);
  }

  let text: string;
  try {
    text = encoding === 'win1252' ? iconv.decode(buf, 'win1252') : buf.toString('utf8');
  } catch (error) {
    logger.error('CSVImport', 'Failed to decode CSV file', error as Error, { filePath, encoding });
    throw new Error(`Fehler beim Dekodieren der CSV-Datei: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { text, sha256: sha256Hex(buf) };
};

const parseCsvRecords = (params: {
  filePath: string;
  encoding: 'utf8' | 'win1252';
  delimiter?: string;
}): { fileName: string; fileSha256: string; delimiter: string; headers: string[]; data: Record<string, string>[] } => {
  const { text, sha256 } = readFileDecoded(params.filePath, params.encoding);
  const headerLine = firstNonEmptyLine(text);
  const delimiter = params.delimiter ?? detectDelimiter(headerLine);

  let parsed: Papa.ParseResult<Record<string, string>>;
  try {
    parsed = Papa.parse<Record<string, string>>(text, {
      header: true,
      skipEmptyLines: 'greedy',
      delimiter,
      dynamicTyping: false,
    });
  } catch (error) {
    logger.error('CSVImport', 'Failed to parse CSV file', error as Error, { filePath: params.filePath });
    throw new Error(`Fehler beim Parsen der CSV-Datei: ${error instanceof Error ? error.message : String(error)}`);
  }

  const headers = (parsed.meta.fields ?? []).filter(Boolean);
  const data = Array.isArray(parsed.data) ? parsed.data : [];

  return {
    fileName: path.basename(params.filePath),
    fileSha256: sha256,
    delimiter,
    headers,
    data,
  };
};

const buildRows = (params: {
  data: Record<string, string>[];
  mapping: CsvMapping;
  maxRows: number;
  accountIdForDedupHash?: string;
}): { rows: CsvPreviewRow[]; valid: number; errors: number } => {
  let valid = 0;
  let errors = 0;
  const rows: CsvPreviewRow[] = [];

  for (let i = 0; i < Math.min(params.data.length, params.maxRows); i++) {
    const raw = params.data[i] ?? {};
    const rowIndex = i + 2; // + header line
    const rowErrors: string[] = [];

    const dateRaw = String(raw[params.mapping.dateColumn] ?? '').trim();
    const amountRaw = String(raw[params.mapping.amountColumn] ?? '').trim();
    const currencyRaw = params.mapping.currencyColumn ? String(raw[params.mapping.currencyColumn] ?? '').trim() : '';

    const dateIso = parseDateToIso(dateRaw);
    if (!dateIso) rowErrors.push(`Invalid date: "${dateRaw}"`);

    const amount = parseGermanNumber(amountRaw);
    if (amount === null) rowErrors.push(`Invalid amount: "${amountRaw}"`);

    if (params.mapping.currencyExpected && currencyRaw) {
      if (currencyRaw.toUpperCase() !== params.mapping.currencyExpected.toUpperCase()) {
        rowErrors.push(`Unsupported currency: "${currencyRaw}" (expected ${params.mapping.currencyExpected})`);
      }
    }

    const counterparty = params.mapping.counterpartyColumn ? String(raw[params.mapping.counterpartyColumn] ?? '').trim() : '';
    const purpose = params.mapping.purposeColumn ? String(raw[params.mapping.purposeColumn] ?? '').trim() : '';
    const statusRaw = params.mapping.statusColumn ? String(raw[params.mapping.statusColumn] ?? '').trim() : '';
    const externalId = params.mapping.externalIdColumn ? String(raw[params.mapping.externalIdColumn] ?? '').trim() : '';

    const status: 'pending' | 'booked' =
      statusRaw.toLowerCase().includes('pending') || statusRaw.toLowerCase().includes('offen') ? 'pending' : 'booked';

    let type: 'income' | 'expense' | undefined;
    if (amount !== null) {
      if (amount < 0) type = 'expense';
      else type = 'income';
    }

    const parsedTx = {
      date: dateIso ?? undefined,
      amount: amount ?? undefined,
      type,
      counterparty: counterparty || undefined,
      purpose: purpose || undefined,
      status,
      externalId: externalId || undefined,
      currency: currencyRaw || undefined,
    };

    let dedupHash: string | undefined;
    if (params.accountIdForDedupHash && parsedTx.date && typeof parsedTx.amount === 'number') {
      const key = [
        params.accountIdForDedupHash,
        parsedTx.date,
        parsedTx.amount.toFixed(2),
        parsedTx.counterparty ?? '',
        parsedTx.purpose ?? '',
        parsedTx.externalId ?? '',
      ].join('|');
      dedupHash = sha256Hex(key);
    }

    if (rowErrors.length === 0) valid++;
    else errors++;

    rows.push({ rowIndex, raw, parsed: parsedTx, errors: rowErrors, dedupHash });
  }

  return { rows, valid, errors };
};

export const previewCsv = (params: {
  filePath: string;
  encoding?: 'utf8' | 'win1252';
  delimiter?: string;
  profile?: CsvProfile | 'auto';
  mapping?: CsvMapping;
  maxRows?: number;
  accountIdForDedupHash?: string;
}): CsvPreviewResult => {
  const encoding = params.encoding ?? 'utf8';
  const parsed = parseCsvRecords({ filePath: params.filePath, encoding, delimiter: params.delimiter });
  const headers = parsed.headers;
  const detected = detectProfile(headers);
  const profile = params.profile && params.profile !== 'auto' ? params.profile : detected;
  const suggestedMapping = suggestedMappingFor(profile, headers);
  const mapping = params.mapping ?? suggestedMapping;

  const previewN = Math.max(1, Math.min(params.maxRows ?? 50, 200));
  const built = buildRows({
    data: parsed.data,
    mapping,
    maxRows: previewN,
    accountIdForDedupHash: params.accountIdForDedupHash,
  });

  return {
    path: params.filePath,
    fileName: parsed.fileName,
    fileSha256: parsed.fileSha256,
    delimiter: parsed.delimiter,
    headers,
    profile,
    suggestedMapping,
    rows: built.rows,
    stats: {
      totalRows: parsed.data.length,
      previewRows: built.rows.length,
      validRows: built.valid,
      errorRows: built.errors,
    },
  };
};

export const commitCsv = (params: {
  filePath: string;
  accountId: string;
  encoding?: 'utf8' | 'win1252';
  delimiter?: string;
  profile?: CsvProfile | 'auto';
  mapping: CsvMapping;
}): { fileName: string; fileSha256: string; profile: CsvProfile; rows: CsvPreviewRow[] } => {
  const encoding = params.encoding ?? 'utf8';
  const parsed = parseCsvRecords({ filePath: params.filePath, encoding, delimiter: params.delimiter });
  const headers = parsed.headers;
  const detected = detectProfile(headers);
  const profile = params.profile && params.profile !== 'auto' ? params.profile : detected;

  const built = buildRows({
    data: parsed.data,
    mapping: params.mapping,
    maxRows: parsed.data.length,
    accountIdForDedupHash: params.accountId,
  });

  return { fileName: parsed.fileName, fileSha256: parsed.fileSha256, profile, rows: built.rows };
};
