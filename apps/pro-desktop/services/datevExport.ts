import iconv from 'iconv-lite';

/**
 * DATEV Developer Portal: Buchungsstapel, header 700 / format 13 (02/2024).
 * @see https://developer.datev.de/de/file-format/details/datev-format/format-description/header
 * @see https://developer.datev.de/de/file-format/details/datev-format/format-description/booking-batch
 */
export const DATEV_HEADER_VERSION = 700 as const;
export const DATEV_FORMAT_VERSION = 13 as const;
export const DATEV_FORMAT_CATEGORY = 21 as const;
export const DATEV_MAX_ROWS = 99_999 as const;

export type DatevEncoding = 'cp1252' | 'utf8-bom';

export interface DatevBuchungsstapelRow {
  /** ISO date. DATEV field 10 is emitted as TTMM; the year is in header field 13. */
  date: string;
  belegfeld1: string;
  buchungstext: string;
  konto: string;
  gegenkonto: string;
  sollHabenKennzeichen?: 'S' | 'H';
  /** DATEV field 9 is four quoted digits in format version 13. */
  buSchluessel?: string;
  umsatz: number;
}

export interface DatevBuchungsstapelOptions {
  consultantNumber: string | number;
  clientNumber: string | number;
  fiscalYearStart: string;
  accountLength: number;
  chart: 'SKR03' | 'SKR04';
  from: string;
  to: string;
  encoding?: DatevEncoding;
  createdAt?: Date | string;
  origin?: string;
  exportedBy?: string;
  importedBy?: string;
  stackName?: string;
  dictationCode?: string;
}

// DATEV Developer Portal, booking-batch field heading (format version 13).
export const DATEV_COLUMNS = [
  'Umsatz (ohne Soll/Haben-Kz)', 'Soll/Haben-Kennzeichen', 'WKZ Umsatz', 'Kurs', 'Basis-Umsatz', 'WKZ Basis-Umsatz',
  'Konto', 'Gegenkonto (ohne BU-Schlüssel)', 'BU-Schlüssel', 'Belegdatum', 'Belegfeld 1', 'Belegfeld 2', 'Skonto',
  'Buchungstext', 'Postensperre', 'Diverse Adressnummer', 'Geschäftspartnerbank', 'Sachverhalt', 'Zinssperre',
  'Beleglink', 'Beleginfo - Art 1', 'Beleginfo - Inhalt 1', 'Beleginfo - Art 2', 'Beleginfo - Inhalt 2',
  'Beleginfo - Art 3', 'Beleginfo - Inhalt 3', 'Beleginfo - Art 4', 'Beleginfo - Inhalt 4',
  'Beleginfo - Art 5', 'Beleginfo - Inhalt 5', 'Beleginfo - Art 6', 'Beleginfo - Inhalt 6',
  'Beleginfo - Art 7', 'Beleginfo - Inhalt 7', 'Beleginfo - Art 8', 'Beleginfo - Inhalt 8',
  'KOST1 - Kostenstelle', 'KOST2 - Kostenstelle', 'Kost-Menge', 'EU-Land u. UStID (Bestimmung)',
  'EU-Steuersatz (Bestimmung)', 'Abw. Versteuerungsart', 'Sachverhalt L+L', 'Funktionsergänzung L+L',
  'BU 49 Hauptfunktionstyp', 'BU 49 Hauptfunktionsnummer', 'BU 49 Funktionsergänzung', 'Zusatzinformation - Art 1',
  'Zusatzinformation- Inhalt 1', 'Zusatzinformation - Art 2', 'Zusatzinformation- Inhalt 2', 'Zusatzinformation - Art 3',
  'Zusatzinformation- Inhalt 3', 'Zusatzinformation - Art 4', 'Zusatzinformation- Inhalt 4', 'Zusatzinformation - Art 5',
  'Zusatzinformation- Inhalt 5', 'Zusatzinformation - Art 6', 'Zusatzinformation- Inhalt 6', 'Zusatzinformation - Art 7',
  'Zusatzinformation- Inhalt 7', 'Zusatzinformation - Art 8', 'Zusatzinformation- Inhalt 8', 'Zusatzinformation - Art 9',
  'Zusatzinformation- Inhalt 9', 'Zusatzinformation - Art 10', 'Zusatzinformation- Inhalt 10', 'Zusatzinformation - Art 11',
  'Zusatzinformation- Inhalt 11', 'Zusatzinformation - Art 12', 'Zusatzinformation- Inhalt 12', 'Zusatzinformation - Art 13',
  'Zusatzinformation- Inhalt 13', 'Zusatzinformation - Art 14', 'Zusatzinformation- Inhalt 14', 'Zusatzinformation - Art 15',
  'Zusatzinformation- Inhalt 15', 'Zusatzinformation - Art 16', 'Zusatzinformation- Inhalt 16', 'Zusatzinformation - Art 17',
  'Zusatzinformation- Inhalt 17', 'Zusatzinformation - Art 18', 'Zusatzinformation- Inhalt 18', 'Zusatzinformation - Art 19',
  'Zusatzinformation- Inhalt 19', 'Zusatzinformation - Art 20', 'Zusatzinformation- Inhalt 20', 'Stück', 'Gewicht',
  'Zahlweise', 'Forderungsart', 'Veranlagungsjahr', 'Zugeordnete Fälligkeit', 'Skontotyp', 'Auftragsnummer',
  'Buchungstyp', 'USt-Schlüssel (Anzahlungen)', 'EU-Land (Anzahlungen)', 'Sachverhalt L+L (Anzahlungen)',
  'EU-Steuersatz (Anzahlungen)', 'Erlöskonto (Anzahlungen)', 'Herkunft-Kz', 'Buchungs GUID', 'KOST-Datum',
  'SEPA-Mandatsreferenz', 'Skontosperre', 'Gesellschaftername', 'Beteiligtennummer', 'Identifikationsnummer',
  'Zeichnernummer', 'Postensperre bis', 'Bezeichnung SoBil-Sachverhalt', 'Kennzeichen SoBil-Buchung', 'Festschreibung',
  'Leistungsdatum', 'Datum Zuord. Steuerperiode', 'Fälligkeit', 'Generalumkehr (GU)', 'Steuersatz', 'Land',
  'Abrechnungsreferenz', 'BVV-Position', 'EU-Land u. UStID (Ursprung)', 'EU-Steuersatz (Ursprung)', 'Abw. Skontokonto',
] as const;

if (DATEV_COLUMNS.length !== 125) throw new Error('DATEV heading must contain exactly 125 fields');

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const parseDate = (value: string): Date => {
  const match = DATE_RE.exec(value);
  if (!match) throw new Error(`DATEV Buchungsstapel Validierung fehlgeschlagen: Ungültiges Datum ${value}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (date.toISOString().slice(0, 10) !== value) throw new Error(`DATEV Buchungsstapel Validierung fehlgeschlagen: Ungültiges Datum ${value}`);
  return date;
};

const datevYmd = (value: string): string => value.replaceAll('-', '');
const toDatevDate = (isoDate: string): string => `${isoDate.slice(8, 10)}${isoDate.slice(5, 7)}`;

const quote = (value: string): string => {
  if (CONTROL_CHARACTERS.test(value)) throw new Error('DATEV-Textfelder dürfen keine Steuerzeichen enthalten.');
  return `"${value.replaceAll('"', '""')}"`;
};

const normalizeBuKey = (value: string): string => {
  if (!/^\d{4}$/.test(value)) throw new Error(`Ungültiger DATEV BU-Schlüssel: ${value}`);
  return value;
};

const amount = (value: number, rowNo: number): string => {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`Zeile ${rowNo}: Umsatz muss positiv sein.`);
  const cents = Math.round(value * 100);
  if (Math.abs(value - cents / 100) > 1e-9) throw new Error(`Zeile ${rowNo}: Umsatz darf höchstens zwei Dezimalstellen haben.`);
  const formatted = value.toFixed(2).replace('.', ',');
  if (!/^\d{1,10},\d{2}$/.test(formatted) || /^0+,00$/.test(formatted)) {
    throw new Error(`Zeile ${rowNo}: Umsatz überschreitet DATEV-Feld 1.`);
  }
  return formatted;
};

const validateText = (value: string, field: string, maxLength: number): string => {
  if (CONTROL_CHARACTERS.test(value)) throw new Error(`${field} darf keine Steuerzeichen enthalten.`);
  if (value.length > maxLength) throw new Error(`${field} darf höchstens ${maxLength} Zeichen enthalten.`);
  return value;
};

const validateDatevOptions = (options: DatevBuchungsstapelOptions): void => {
  const consultant = String(options.consultantNumber);
  const client = String(options.clientNumber);
  if (!/^(?:\d{4,6}|\d{7})$/.test(consultant) || Number(consultant) < 1001) throw new Error('DATEV Beraternummer fehlt oder ist ungültig.');
  if (!/^\d{1,5}$/.test(client) || Number(client) < 1) throw new Error('DATEV Mandantennummer fehlt oder ist ungültig.');
  parseDate(options.fiscalYearStart);
  parseDate(options.from);
  parseDate(options.to);
  if (options.from > options.to) throw new Error('DATEV-Zeitraum ist umgekehrt.');
  if (options.from.slice(0, 7) !== options.to.slice(0, 7)) throw new Error('DATEV Buchungsstapel muss genau eine Periode enthalten.');
  if (!Number.isInteger(options.accountLength) || options.accountLength < 4 || options.accountLength > 8) throw new Error('DATEV Sachkontenlänge muss 4 bis 8 sein.');
  if (!['SKR03', 'SKR04'].includes(options.chart)) throw new Error('DATEV Kontenrahmen fehlt oder ist ungültig.');
  if (options.origin !== undefined && !/^\w{0,2}$/.test(options.origin)) throw new Error('DATEV Herkunft ist ungültig.');
  if (options.exportedBy !== undefined) validateText(options.exportedBy, 'Exportiert von', 25);
  if (options.importedBy !== undefined) validateText(options.importedBy, 'Importiert von', 25);
  if (options.stackName !== undefined) validateText(options.stackName, 'Stapelbezeichnung', 30);
  if (options.dictationCode !== undefined && !/^(?:[A-Z]{2}){0,2}$/.test(options.dictationCode)) throw new Error('DATEV Diktatkürzel ist ungültig.');
};

export const validateDatevRows = (rows: DatevBuchungsstapelRow[], options?: Pick<DatevBuchungsstapelOptions, 'accountLength'>): void => {
  if (rows.length > DATEV_MAX_ROWS) throw new Error(`DATEV Buchungsstapel darf höchstens ${DATEV_MAX_ROWS} Buchungen enthalten.`);
  const accountLength = options?.accountLength;
  if (accountLength !== undefined && (!Number.isInteger(accountLength) || accountLength < 4 || accountLength > 8)) throw new Error('DATEV Sachkontenlänge muss 4 bis 8 sein.');
  rows.forEach((row, idx) => {
    const rowNo = idx + 1;
    parseDate(row.date);
    if (!/^\d+$/.test(String(row.konto)) || /^0+$/.test(String(row.konto)) || (accountLength !== undefined ? String(row.konto).length !== accountLength : String(row.konto).length < 1 || String(row.konto).length > 9)) throw new Error(`Zeile ${rowNo}: Konto passt nicht zur Sachkontenlänge.`);
    if (!/^\d+$/.test(String(row.gegenkonto)) || /^0+$/.test(String(row.gegenkonto)) || (accountLength !== undefined ? String(row.gegenkonto).length !== accountLength : String(row.gegenkonto).length < 1 || String(row.gegenkonto).length > 9)) throw new Error(`Zeile ${rowNo}: Gegenkonto passt nicht zur Sachkontenlänge.`);
    if (row.sollHabenKennzeichen !== undefined && !['S', 'H'].includes(row.sollHabenKennzeichen)) throw new Error(`Zeile ${rowNo}: Soll/Haben-Kennzeichen ist ungültig.`);
    if (row.buSchluessel !== undefined) normalizeBuKey(row.buSchluessel);
    amount(row.umsatz, rowNo);
    const reference = validateText(row.belegfeld1, `Zeile ${rowNo} Belegfeld 1`, 36);
    if (!/^[\w$&%*+\-/]*$/.test(reference)) throw new Error(`Zeile ${rowNo}: Belegfeld 1 enthält unzulässige Zeichen.`);
    validateText(row.buchungstext, `Zeile ${rowNo} Buchungstext`, 60);
  });
};

const headerTimestamp = (value?: Date | string): string => {
  const date = value instanceof Date ? value : value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) throw new Error('DATEV Erstellzeitpunkt ist ungültig.');
  const iso = date.toISOString();
  return `${iso.slice(0, 10).replaceAll('-', '')}${iso.slice(11, 19).replaceAll(':', '')}${iso.slice(20, 23)}`;
};

const buildHeader = (options: DatevBuchungsstapelOptions): string => {
  const fields: Array<string | number> = [
    quote('EXTF'), DATEV_HEADER_VERSION, DATEV_FORMAT_CATEGORY, quote('Buchungsstapel'), DATEV_FORMAT_VERSION,
    headerTimestamp(options.createdAt), '', quote(options.origin ?? 'RE'), quote(options.exportedBy ?? ''), quote(options.importedBy ?? ''),
    String(options.consultantNumber), String(options.clientNumber), datevYmd(options.fiscalYearStart), options.accountLength,
    datevYmd(options.from), datevYmd(options.to), quote(options.stackName ?? 'Buchungsstapel'), quote(options.dictationCode ?? ''),
    1, 0, 0, quote('EUR'), '', quote(''), '', '', quote(options.chart.slice(-2)), '', '', quote(''), quote(''),
  ];
  return fields.join(';');
};

const buildDataRow = (row: DatevBuchungsstapelRow): string => [
  amount(row.umsatz, 0), quote(row.sollHabenKennzeichen ?? 'S'), quote('EUR'), '', '', '', String(row.konto), String(row.gegenkonto),
  row.buSchluessel === undefined ? '' : quote(normalizeBuKey(row.buSchluessel)), toDatevDate(row.date), quote(row.belegfeld1), quote(''), '',
  quote(row.buchungstext), '', quote(''), '', '', '', quote(''), ...Array.from({ length: 105 }, () => ''),
].join(';');

export const buildDatevBuchungsstapelCsv = (
  rows: DatevBuchungsstapelRow[],
  options: DatevBuchungsstapelOptions,
): Buffer => {
  validateDatevOptions(options);
  validateDatevRows(rows, options);
  const plain = `${buildHeader(options)}\r\n${DATEV_COLUMNS.join(';')}\r\n${rows.map(buildDataRow).join('\r\n')}${rows.length ? '\r\n' : ''}`;
  const encoded = options.encoding === 'utf8-bom' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(plain, 'utf8')]) : iconv.encode(plain, 'win1252');
  if (options.encoding !== 'utf8-bom' && iconv.decode(encoded, 'win1252') !== plain) throw new Error('DATEV CP1252 kann Zeichen nicht verlustfrei darstellen.');
  return encoded;
};
