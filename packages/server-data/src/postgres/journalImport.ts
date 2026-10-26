import { createHash, randomUUID } from 'node:crypto';
import {
  parseDatevBuchungsstapel, parseJournalCsv,
  type DatevImportRow, type JournalCsvEntry, type JournalImportIssue,
} from '@billme/accounting-engine/journal-import';
import { isMoneyLedgerAccount, type AccountingMutationContext, type JournalLineEntity, type TaxCaseKey } from '@billme/accounting-shared';
import type { TenantScope } from '@billme/server-core';
import { runInTransaction, type PostgresQueryable } from './connection.js';
import { appendWithClient } from './audit.js';
import { accountRoleMappings, taxCaseAccount } from './taxAccounts.js';
import { DATEV_AUTOMATIC_ACCOUNTS } from './datevAutomaticAccounts.js';
import { usableAccountNumbers } from './tenantLedgerAccounts.js';
import { insertEntry } from './proAccountingRepository.js';

/**
 * Journal import: booked entries of another bookkeeping (DATEV Buchungsstapel or journal CSV) posted as journal
 * entries of their own source type `journal_import`. A dry run reports what would be booked; the real run books
 * all new entries of the file in one transaction or none. The same file imported again books nothing twice: the
 * source key is the file hash plus the entry key.
 *
 * Tax: a DATEV row carries the gross amount with a BU-Schlüssel (2/3 USt, 8/9 VSt, 94/91 § 13b, 19/18 Erwerb) or
 * on an Automatikkonto; the row becomes the net line with its tax figures and the VSt/USt line, as a posting of
 * Billme itself would book it, so the UStVA reads the same Kennzahlen. A journal CSV states its lines; a line with
 * a Steuerfall is net when the entry has the tax line already, else it is gross and split.
 */

export type JournalImportFormat = 'datev' | 'journal_csv';

export interface JournalImportRequest {
  format: JournalImportFormat;
  fileName?: string;
  contentBase64: string;
  dryRun?: boolean;
  softLockOverride?: boolean;
  overrideReason?: string;
  mutation?: AccountingMutationContext;
}

export interface JournalImportLinePreview {
  accountNumber: string;
  accountName?: string;
  debitAmount: number;
  creditAmount: number;
  taxCaseKey?: string;
  taxAmount?: number;
  memo?: string;
}

export interface JournalImportEntryPreview {
  key: string;
  rows: number[];
  postingDate: string;
  reference: string;
  bookingText: string;
  /** new: will be booked; imported: booked by an earlier run of this file; invalid: has a blocking issue. */
  status: 'new' | 'imported' | 'invalid';
  lines: JournalImportLinePreview[];
}

export interface JournalImportResult {
  format: JournalImportFormat;
  fileName?: string;
  fileSha256: string;
  dryRun: boolean;
  posted: boolean;
  source: { chart?: 'SKR03' | 'SKR04'; from?: string; to?: string; label?: string; accountLength?: number; consultantNumber?: string; clientNumber?: string };
  entryCount: number;
  newCount: number;
  importedCount: number;
  invalidCount: number;
  postedCount: number;
  /** Soll total of the new entries. */
  debitTotal: number;
  firstDate?: string;
  lastDate?: string;
  /** Accounts the file books on that the tenant's chart does not have; create them, then import again. */
  missingAccounts: string[];
  issues: JournalImportIssue[];
  /** The first PREVIEW_LIMIT entries, invalid ones first. */
  entries: JournalImportEntryPreview[];
}

export const JOURNAL_IMPORT_MAX_BYTES = 20 * 1024 * 1024;
const PREVIEW_LIMIT = 300;
const BOOKING_TEXT_MAX = 60;
const REFERENCE_MAX = 36;

type Side = 'debit' | 'credit';
type Direction = 'input' | 'output';
type Prepared = { key: string; rows: number[]; postingDate: string; reference: string; bookingText: string; lines: JournalLineEntity[]; invalid: boolean };
type TaxCaseRow = { mechanism: string; rate: number; active: boolean; requiresCountry: boolean };
type Context = {
  db: PostgresQueryable;
  t: string;
  chart: 'SKR03' | 'SKR04';
  roles: Record<string, string>;
  names: Map<string, string>;
  usable: Set<string>;
  taxCases: Map<string, TaxCaseRow>;
  taxAccounts: Set<string>;
  accountLength?: number;
  issues: JournalImportIssue[];
  notes: Map<string, { rows: number[]; message: string }>;
};

const q = async <T = any>(db: PostgresQueryable, text: string, values: unknown[] = []): Promise<T[]> => (await db.query(text, values)).rows as T[];
const euro = (cents: number): number => cents / 100;
const blocking = (row: number, message: string): JournalImportIssue => ({ row, message, blocking: true });
/** One non-blocking note per kind, listing the rows it applies to. */
const note = (ctx: Context, kind: string, row: number, message: string) => {
  const current = ctx.notes.get(kind) ?? { rows: [], message };
  current.rows.push(row);
  ctx.notes.set(kind, current);
};

const line = (accountNumber: string, side: Side, cents: number, extra: Partial<JournalLineEntity> = {}): JournalLineEntity => ({
  id: randomUUID(), accountNumber, debitAmount: side === 'debit' ? euro(cents) : 0, creditAmount: side === 'credit' ? euro(cents) : 0, ...extra,
});
const otherSide = (side: Side): Side => (side === 'debit' ? 'credit' : 'debit');

/**
 * Tax figures on the net line. They are signed by direction: a Vorsteuer line in Haben (a refund) or a USt line in
 * Soll (Erlösschmälerung) lowers its Kennzahl, which is how the UStVA reads persisted lines.
 */
const taxFigures = (taxCaseKey: string, rate: number, direction: Direction, side: Side, netCents: number, taxCents: number, grossCents = netCents + taxCents): Partial<JournalLineEntity> => {
  const sign = (direction === 'input') === (side === 'debit') ? 1 : -1;
  return { taxCaseKey: taxCaseKey as TaxCaseKey, taxRate: rate, netAmount: sign * euro(netCents), taxAmount: sign * euro(taxCents), grossAmount: sign * euro(grossCents) };
};

/**
 * An account number of the file: an account of the tenant's chart, else a DATEV Personenkonto (one digit longer than
 * the Sachkonten; Debitoren 1–6, Kreditoren 7–9), which is booked on the receivables or payables account.
 */
const resolveAccount = (ctx: Context, number: string, row: number): { account: string; party?: string } => {
  if (ctx.usable.has(number)) return { account: number };
  const length = ctx.accountLength ?? 4;
  if (number.length === length + 1 && /^[1-9]/.test(number)) {
    const receivable = Number(number[0]) <= 6;
    note(ctx, 'party', row, `Personenkonten (Debitoren/Kreditoren) werden auf ${ctx.roles.accounts_receivable} bzw. ${ctx.roles.accounts_payable} gebucht; die Nummer steht in der Notiz der Zeile.`);
    return { account: receivable ? ctx.roles.accounts_receivable! : ctx.roles.accounts_payable!, party: number };
  }
  return { account: number };
};

/** Name-based reading of a DATEV Automatikkonto: which tax its automatic books. */
const automaticTax = (ctx: Context, account: string): { rate: number; kind: Direction | 'self'; taxCaseKey?: string } | 'unclear' | undefined => {
  const rate = DATEV_AUTOMATIC_ACCOUNTS[ctx.chart][account];
  if (!rate) return undefined;
  const name = ctx.names.get(account) ?? '';
  if (/Vorsteuer und .*(Umsatzsteuer|USt)/i.test(name)) {
    const taxCaseKey = /Erwerb/i.test(name) ? 'EU_IGE_GOODS_RC'
      : /anderen EU-Land/i.test(name) ? 'EU_B2B_SERVICE_RC'
        : /Ausland/i.test(name) ? 'NON_EU_SERVICE_RC'
          : /13b|Bauleistung|Gebäudereinigung|Schrott|Mobilfunk|Gas|Strom/i.test(name) ? 'DE_RC_13B_DOMESTIC' : undefined;
    return { rate, kind: 'self', taxCaseKey };
  }
  if (/Vorsteuer/i.test(name)) return { rate, kind: 'input' };
  if (/\bUSt\b|Umsatzsteuer|Erlös/i.test(name)) return { rate, kind: 'output' };
  return 'unclear';
};

/** Revenue accounts of the zero-rate and exempt cases (role → case): a line on them without its own case reports there. */
const ZERO_RATE_ROLES: Record<string, TaxCaseKey> = {
  revenue_outside_scope: 'NON_EU_SERVICE_OUTSIDE_SCOPE', revenue_eu_supply: 'EU_IGL_GOODS_0', revenue_export: 'NON_EU_EXPORT_0',
  revenue_eu_service: 'EU_B2B_SERVICE_RC', revenue_exempt: 'DE_ZERO_EXEMPT', revenue_rc_13b: 'DE_RC_13B_DOMESTIC', revenue_small_business: 'DE_KU19',
};
const zeroRateCase = (ctx: Context, account: string): TaxCaseKey | undefined => {
  for (const [role, taxCaseKey] of Object.entries(ZERO_RATE_ROLES)) if (ctx.roles[role] === account) return taxCaseKey;
  return undefined;
};
/** A plain line on a zero-rate revenue account carries its case (rate 0) so the UStVA counts it (e.g. Kz 45). */
const withZeroRateCase = (ctx: Context, item: JournalLineEntity): JournalLineEntity => {
  const taxCaseKey = item.taxCaseKey ? undefined : zeroRateCase(ctx, item.accountNumber);
  if (!taxCaseKey) return item;
  const side: Side = item.debitAmount > 0 ? 'debit' : 'credit';
  const cents = Math.round((item.debitAmount || item.creditAmount) * 100);
  return { ...item, ...taxFigures(taxCaseKey, 0, 'output', side, cents, 0) };
};

const STANDARD_BU: Record<number, { rate: number; direction: Direction }> = { 2: { rate: 7, direction: 'output' }, 3: { rate: 19, direction: 'output' }, 8: { rate: 7, direction: 'input' }, 9: { rate: 19, direction: 'input' } };
/** DATEV § 13b with Vorsteuerabzug (94/91) and Erwerb (19/18), as Billme's DATEV export writes them. */
const SELF_ASSESSED_BU: Record<number, { rate: number; erwerb: boolean }> = { 94: { rate: 19, erwerb: false }, 91: { rate: 7, erwerb: false }, 19: { rate: 19, erwerb: true }, 18: { rate: 7, erwerb: true } };
const SACHVERHALT_CASE: Record<string, TaxCaseKey> = { 1: 'NON_EU_SERVICE_RC', 4: 'DE_RC_13B_DOMESTIC', 7: 'EU_B2B_SERVICE_RC' };

const standardTaxAccount = (ctx: Context, taxCaseKey: string, direction: Direction, date: string): Promise<string> =>
  taxCaseAccount(ctx.db, ctx.t, ctx.chart, taxCaseKey, direction === 'input' ? 'input_tax' : 'output_tax', direction === 'input' ? ctx.roles.input_vat : ctx.roles.output_vat, date);

/** Gross on the base account: net plus VSt/USt on the same side, the other account carries the gross. */
const grossSplit = async (ctx: Context, input: { base: string; baseSide: Side; other: string; grossCents: number; rate: number; direction: Direction; date: string; memo?: Record<string, string | undefined> }): Promise<JournalLineEntity[]> => {
  const taxCaseKey = input.rate === 7 ? 'DE_STD_7' : 'DE_STD_19';
  const netCents = Math.round(input.grossCents * 100 / (100 + input.rate));
  const taxCents = input.grossCents - netCents;
  const taxAccount = await standardTaxAccount(ctx, taxCaseKey, input.direction, input.date);
  const lines = [
    line(input.base, input.baseSide, netCents, { ...taxFigures(taxCaseKey, input.rate, input.direction, input.baseSide, netCents, taxCents), memo: input.memo?.[input.base] }),
    ...(taxCents ? [line(taxAccount, input.baseSide, taxCents, { memo: `${input.direction === 'input' ? 'Vorsteuer' : 'Umsatzsteuer'} ${input.rate} %` })] : []),
    line(input.other, otherSide(input.baseSide), input.grossCents, { memo: input.memo?.[input.other] }),
  ];
  return lines;
};

/** § 13b and Erwerb: the amount is net; the buyer books the USt he owes and the same amount as Vorsteuer. */
const selfAssessed = async (ctx: Context, input: { base: string; baseSide: Side; other: string; netCents: number; rate: number; taxCaseKey: string; date: string; countryCode?: string; counterpartyVatId?: string; sachverhaltLl?: string; memo?: Record<string, string | undefined> }): Promise<JournalLineEntity[]> => {
  const taxCents = Math.round(input.netCents * input.rate / 100);
  const inputAccount = await taxCaseAccount(ctx.db, ctx.t, ctx.chart, input.taxCaseKey, 'input_tax', undefined, input.date, input.rate);
  const outputAccount = await taxCaseAccount(ctx.db, ctx.t, ctx.chart, input.taxCaseKey, 'output_tax', undefined, input.date, input.rate);
  return [
    line(input.base, input.baseSide, input.netCents, {
      ...taxFigures(input.taxCaseKey, input.rate, 'input', input.baseSide, input.netCents, taxCents, input.netCents),
      countryCode: input.countryCode, counterpartyVatId: input.counterpartyVatId, datevSachverhaltLl: input.sachverhaltLl, memo: input.memo?.[input.base],
    }),
    ...(taxCents ? [
      line(inputAccount, input.baseSide, taxCents, { memo: `Vorsteuer ${input.taxCaseKey}` }),
      line(outputAccount, otherSide(input.baseSide), taxCents, { memo: `Umsatzsteuer ${input.taxCaseKey}` }),
    ] : []),
    line(input.other, otherSide(input.baseSide), input.netCents, { memo: input.memo?.[input.other] }),
  ];
};

const bookingText = (ctx: Context, value: string, row: number, fallback: string): string => {
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim() || fallback;
  if (text.length <= BOOKING_TEXT_MAX) return text;
  note(ctx, 'text', row, `Buchungstexte über ${BOOKING_TEXT_MAX} Zeichen werden gekürzt.`);
  return `${text.slice(0, BOOKING_TEXT_MAX - 1)}…`;
};
const reference = (ctx: Context, value: string, row: number, fallback: string): string => {
  const text = value.trim().slice(0, REFERENCE_MAX);
  if (text) return text;
  note(ctx, 'reference', row, 'Buchungen ohne Belegnummer bekommen die Zeilennummer der Datei als Beleg (Z<Zeile>).');
  return fallback;
};

/** One DATEV row as one journal entry. */
const datevEntry = async (ctx: Context, row: DatevImportRow): Promise<Prepared> => {
  const fail = (message: string): Prepared => {
    ctx.issues.push(blocking(row.row, message));
    return { key: `z${row.row}`, rows: [row.row], postingDate: row.date, reference: row.reference, bookingText: row.bookingText, lines: [], invalid: true };
  };
  const konto = resolveAccount(ctx, row.konto, row.row);
  const gegen = resolveAccount(ctx, row.gegenkonto, row.row);
  const kontoSide: Side = row.side === 'S' ? 'debit' : 'credit';
  const memo: Record<string, string | undefined> = {};
  if (konto.party) memo[konto.account] = `Personenkonto ${konto.party}`;
  if (gegen.party) memo[gegen.account] = `Personenkonto ${gegen.party}`;
  const sideOf = (account: string): Side => (account === konto.account ? kontoSide : otherSide(kontoSide));
  /** DATEV keys the tax to the Gegenkonto; a money, party or tax account cannot carry it, then it is the Konto. */
  const carriesTax = (resolved: { account: string; party?: string }) => !resolved.party && !isMoneyLedgerAccount(ctx.chart, resolved.account) && !ctx.taxAccounts.has(resolved.account);
  const base = carriesTax(gegen) ? gegen.account : carriesTax(konto) ? konto.account : undefined;
  const plain = () => [line(konto.account, kontoSide, row.amountCents, { memo: memo[konto.account] }), line(gegen.account, otherSide(kontoSide), row.amountCents, { memo: memo[gegen.account] })].map((item) => withZeroRateCase(ctx, item));
  let lines: JournalLineEntity[];
  const bu = row.buKey ? Number(row.buKey) : undefined;
  const country = row.euLandUstId?.slice(0, 2);
  const vatId = row.euLandUstId && row.euLandUstId.length > 2 ? row.euLandUstId : undefined;
  if (konto.account === gegen.account) return fail(`Konto und Gegenkonto sind beide ${konto.account}.`);
  if (bu === 40) {
    lines = plain();
  } else if (bu !== undefined && STANDARD_BU[bu]) {
    if (!base) return fail(`BU-Schlüssel ${row.buKey}: weder Konto noch Gegenkonto kann die Steuer tragen.`);
    const { rate, direction } = STANDARD_BU[bu]!;
    lines = await grossSplit(ctx, { base, baseSide: sideOf(base), other: base === konto.account ? gegen.account : konto.account, grossCents: row.amountCents, rate, direction, date: row.date, memo });
  } else if (bu !== undefined && SELF_ASSESSED_BU[bu]) {
    if (!base) return fail(`BU-Schlüssel ${row.buKey}: weder Konto noch Gegenkonto kann die Steuer tragen.`);
    const { rate, erwerb } = SELF_ASSESSED_BU[bu]!;
    const taxCaseKey = erwerb ? 'EU_IGE_GOODS_RC' : SACHVERHALT_CASE[row.sachverhaltLl ?? ''];
    if (!taxCaseKey) return fail(`BU-Schlüssel ${row.buKey} braucht den Sachverhalt L+L (1 Drittland, 4 § 13b Inland, 7 EU-Dienstleistung).`);
    lines = await selfAssessed(ctx, { base, baseSide: sideOf(base), other: base === konto.account ? gegen.account : konto.account, netCents: row.amountCents, rate, taxCaseKey, date: row.date, countryCode: country, counterpartyVatId: vatId, sachverhaltLl: erwerb ? undefined : row.sachverhaltLl, memo });
  } else if (bu !== undefined) {
    return fail(`BU-Schlüssel ${row.buKey} wird nicht importiert (unterstützt: 2, 3, 8, 9, 18, 19, 40, 91, 94).`);
  } else {
    const automatic = [konto.account, gegen.account].map((account) => ({ account, tax: automaticTax(ctx, account) })).filter((item) => item.tax !== undefined);
    if (automatic.length > 1) return fail(`Konto ${konto.account} und Gegenkonto ${gegen.account} sind beide Automatikkonten.`);
    const auto = automatic[0];
    if (!auto) {
      lines = plain();
    } else if (auto.tax === 'unclear' || !auto.tax) {
      return fail(`Automatikkonto ${auto.account}: welche Steuer es bucht, ist nicht bekannt; bitte mit BU-Schlüssel 40 und eigener Steuerzeile exportieren.`);
    } else if (auto.tax.rate !== 19 && auto.tax.rate !== 7) {
      return fail(`Automatikkonto ${auto.account} mit ${auto.tax.rate} % wird nicht importiert (nur 19 % und 7 %).`);
    } else {
      const other = auto.account === konto.account ? gegen.account : konto.account;
      if (auto.tax.kind === 'self') {
        if (!auto.tax.taxCaseKey) return fail(`Automatikkonto ${auto.account}: welcher Fall des § 13b gemeint ist, ist nicht bekannt.`);
        lines = await selfAssessed(ctx, { base: auto.account, baseSide: sideOf(auto.account), other, netCents: row.amountCents, rate: auto.tax.rate, taxCaseKey: auto.tax.taxCaseKey, date: row.date, countryCode: country, counterpartyVatId: vatId, memo });
      } else {
        lines = await grossSplit(ctx, { base: auto.account, baseSide: sideOf(auto.account), other, grossCents: row.amountCents, rate: auto.tax.rate, direction: auto.tax.kind, date: row.date, memo });
      }
    }
  }
  return {
    key: `z${row.row}`, rows: [row.row], postingDate: row.date,
    reference: reference(ctx, row.reference, row.row, `Z${row.row}`),
    bookingText: bookingText(ctx, row.bookingText, row.row, 'DATEV-Import'),
    lines, invalid: false,
  };
};

/** Zero-rate and exempt cases that only exist on the sales side; the others follow the side of the line. */
const OUTPUT_ONLY_CASES = new Set(['EU_IGL_GOODS_0', 'NON_EU_EXPORT_0', 'NON_EU_SERVICE_OUTSIDE_SCOPE', 'DE_KU19', 'DE_TRIANGULAR_25B']);

/** One entry of a journal CSV: its lines, a Steuerfall turned into tax figures (and a split-off tax line when gross). */
const csvEntry = async (ctx: Context, entry: JournalCsvEntry): Promise<Prepared> => {
  const errors: string[] = [];
  const out: JournalLineEntity[] = [];
  const resolved = entry.lines.map((csv) => ({ csv, ...resolveAccount(ctx, csv.accountNumber, csv.row), side: (csv.debitCents > 0 ? 'debit' : 'credit') as Side, cents: csv.debitCents || csv.creditCents }));
  // Tax lines the file states itself: lines without Steuerfall on a VSt/USt account, used up by the net lines below.
  const stated = new Map<string, number>();
  for (const item of resolved) if (!item.csv.taxCaseKey && ctx.taxAccounts.has(item.account)) stated.set(item.account, (stated.get(item.account) ?? 0) + item.cents);
  // Net lines left per VSt/USt account: the last one takes what is left of the stated tax, so the figures add up to it.
  // Direction of a standard line: VSt/USt of the Steuerfall, else the tax line the entry states, else its side.
  const standardAccount = new Map<number, { account: string; direction: Direction }>();
  const pending = new Map<string, number>();
  for (const [index, item] of resolved.entries()) {
    const taxCase = item.csv.taxCaseKey ? ctx.taxCases.get(item.csv.taxCaseKey) : undefined;
    if (!taxCase || taxCase.mechanism !== 'standard_vat' || !(taxCase.rate > 0)) continue;
    const input = await standardTaxAccount(ctx, item.csv.taxCaseKey!, 'input', entry.documentDate);
    const output = await standardTaxAccount(ctx, item.csv.taxCaseKey!, 'output', entry.documentDate);
    const direction: Direction = item.csv.taxDirection
      ?? (stated.has(input) && !stated.has(output) ? 'input' : stated.has(output) && !stated.has(input) ? 'output' : item.side === 'debit' ? 'input' : 'output');
    const account = direction === 'input' ? input : output;
    standardAccount.set(index, { account, direction });
    pending.set(account, (pending.get(account) ?? 0) + 1);
  }
  for (const [index, item] of resolved.entries()) {
    const memo = [item.csv.memo, item.party ? `Personenkonto ${item.party}` : undefined].filter(Boolean).join(' · ') || undefined;
    const key = item.csv.taxCaseKey;
    if (!key) { out.push(withZeroRateCase(ctx, line(item.account, item.side, item.cents, { memo }))); continue; }
    const taxCase = ctx.taxCases.get(key);
    if (!taxCase || !taxCase.active) { errors.push(`Zeile ${item.csv.row}: Steuerfall ${key} gibt es nicht.`); continue; }
    if (taxCase.requiresCountry && !item.csv.countryCode) note(ctx, 'country', item.csv.row, 'Steuerfälle mit Land (EU, Drittland) ohne Spalte Land: für ZM und OSS fehlt dann das Land.');
    const location = { countryCode: item.csv.countryCode, counterpartyVatId: item.csv.counterpartyVatId };
    if (taxCase.mechanism === 'standard_vat' && taxCase.rate > 0) {
      const { account: taxAccount, direction } = standardAccount.get(index)!;
      const available = stated.get(taxAccount);
      if (available !== undefined) {
        const left = pending.get(taxAccount)! - 1;
        pending.set(taxAccount, left);
        const taxCents = left === 0 ? available : Math.min(available, Math.round(item.cents * taxCase.rate / 100));
        stated.set(taxAccount, available - taxCents);
        out.push(line(item.account, item.side, item.cents, { ...taxFigures(key, taxCase.rate, direction, item.side, item.cents, taxCents), ...location, memo }));
      } else {
        const netCents = Math.round(item.cents * 100 / (100 + taxCase.rate));
        out.push(line(item.account, item.side, netCents, { ...taxFigures(key, taxCase.rate, direction, item.side, netCents, item.cents - netCents), ...location, memo }));
        if (item.cents - netCents) out.push(line(taxAccount, item.side, item.cents - netCents, { memo: `${direction === 'input' ? 'Vorsteuer' : 'Umsatzsteuer'} ${taxCase.rate} %` }));
      }
    } else if (taxCase.mechanism === 'reverse_charge') {
      const inputAccount = await taxCaseAccount(ctx.db, ctx.t, ctx.chart, key, 'input_tax', undefined, entry.documentDate, taxCase.rate);
      const outputAccount = await taxCaseAccount(ctx.db, ctx.t, ctx.chart, key, 'output_tax', undefined, entry.documentDate, taxCase.rate);
      const taxCents = Math.round(item.cents * taxCase.rate / 100);
      out.push(line(item.account, item.side, item.cents, { ...taxFigures(key, taxCase.rate, 'input', item.side, item.cents, taxCents, item.cents), ...location, memo }));
      if (stated.has(inputAccount) && stated.has(outputAccount)) {
        stated.set(inputAccount, stated.get(inputAccount)! - taxCents);
        stated.set(outputAccount, stated.get(outputAccount)! - taxCents);
      } else if (taxCents) {
        out.push(line(inputAccount, item.side, taxCents, { memo: `Vorsteuer ${key}` }), line(outputAccount, otherSide(item.side), taxCents, { memo: `Umsatzsteuer ${key}` }));
      }
    } else if (taxCase.mechanism === 'exempt' || taxCase.mechanism === 'zero_rate') {
      const direction: Direction = OUTPUT_ONLY_CASES.has(key) || item.side === 'credit' ? 'output' : 'input';
      out.push(line(item.account, item.side, item.cents, { ...taxFigures(key, 0, direction, item.side, item.cents, 0), ...location, memo }));
    } else {
      errors.push(`Zeile ${item.csv.row}: Steuerfall ${key} wird nicht importiert.`);
    }
  }
  const debit = out.reduce((sum, item) => sum + Math.round(item.debitAmount * 100), 0);
  const credit = out.reduce((sum, item) => sum + Math.round(item.creditAmount * 100), 0);
  if (!errors.length && out.length < 2) errors.push(`Buchung ${entry.key}: mindestens zwei Zeilen.`);
  if (!errors.length && debit !== credit) errors.push(`Buchung ${entry.key}: Soll ${euro(debit).toFixed(2)} und Haben ${euro(credit).toFixed(2)} sind nicht gleich.`);
  for (const message of errors) ctx.issues.push(blocking(entry.rows[0] ?? 0, message));
  return {
    key: `b:${entry.key}`, rows: entry.rows, postingDate: entry.documentDate,
    reference: reference(ctx, entry.reference, entry.rows[0] ?? 0, `Z${entry.rows[0] ?? 0}`),
    bookingText: bookingText(ctx, entry.bookingText, entry.rows[0] ?? 0, 'Journal-Import'),
    lines: out, invalid: errors.length > 0,
  };
};

const accountNames = async (db: PostgresQueryable, t: string, chart: string, accounts: string[]): Promise<Map<string, string>> => {
  const rows = await q<{ account_number: string; name: string }>(db, `SELECT n.account_number, COALESCE(t.name, g.name, '') AS name FROM unnest($3::text[]) AS n(account_number)
    LEFT JOIN tenant_ledger_accounts t ON t.tenant_id=$1 AND t.chart=$2 AND t.account_number=n.account_number
    LEFT JOIN ledger_accounts g ON g.chart=$2 AND g.account_number=n.account_number`, [t, chart, accounts]);
  return new Map(rows.map((row) => [String(row.account_number), String(row.name ?? '')]));
};

/** Status of the months the file books into: a festgeschriebener month refuses, a soft lock needs the override. */
const periodIssues = async (db: PostgresQueryable, t: string, prepared: Prepared[], override: boolean): Promise<JournalImportIssue[]> => {
  const months = [...new Set(prepared.map((entry) => entry.postingDate.slice(0, 7)))].sort();
  if (!months.length) return [];
  const rows = await q<{ period: string; status: string }>(db, `SELECT period,status FROM accounting_periods WHERE tenant_id=$1 AND period = ANY($2::text[])`, [t, months]);
  const latestClosed = (await q<{ period: string | null }>(db, `SELECT MAX(period) AS period FROM accounting_periods WHERE tenant_id=$1 AND status='closed'`, [t]))[0]?.period ?? '';
  const status = new Map(rows.map((row) => [row.period, row.status]));
  const issues: JournalImportIssue[] = [];
  for (const month of months) {
    const rowsOf = prepared.filter((entry) => entry.postingDate.startsWith(month)).flatMap((entry) => entry.rows);
    const where = `Zeile${rowsOf.length > 1 ? 'n' : ''} ${rowsOf.slice(0, 5).join(', ')}${rowsOf.length > 5 ? ' …' : ''}`;
    if (status.get(month) === 'closed' || (latestClosed && month <= latestClosed)) issues.push(blocking(rowsOf[0] ?? 0, `${month} ist festgeschrieben; dorthin wird nicht gebucht (${where}).`));
    else if (status.get(month) === 'soft_locked' && !override) issues.push(blocking(rowsOf[0] ?? 0, `${month} ist vorläufig gesperrt; zum Import die Sperre mit Begründung übergehen (${where}).`));
  }
  return issues;
};

const sourceKeyOf = (sha: string, key: string): string => `journal-import:${sha}:${key}`;

/** Parse, check and (unless dry run) book a journal file. Never books part of a file. */
export const runJournalImport = async (db: PostgresQueryable, scope: TenantScope, input: JournalImportRequest): Promise<JournalImportResult> => {
  const bytes = Buffer.from(input.contentBase64, 'base64');
  if (!bytes.length) throw new Error('JOURNAL_IMPORT_EMPTY: Die Datei ist leer.');
  if (bytes.length > JOURNAL_IMPORT_MAX_BYTES) throw new Error('JOURNAL_IMPORT_TOO_LARGE: Die Datei ist größer als 20 MB.');
  const t = scope.tenantId;
  const fileSha256 = createHash('sha256').update(bytes).digest('hex');
  const dryRun = input.dryRun !== false;
  const override = Boolean(input.softLockOverride && input.overrideReason?.trim());
  const policy = (await q<any>(db, `SELECT active_chart FROM accounting_policies WHERE tenant_id=$1`, [t]))[0];
  const chart: 'SKR03' | 'SKR04' = policy?.active_chart === 'SKR04' ? 'SKR04' : 'SKR03';
  const roles = await accountRoleMappings(db, t, chart);
  const taxCaseRows = await q<any>(db, `SELECT key,mechanism,default_rate,active,requires_country FROM tax_cases`);
  const taxCases = new Map<string, TaxCaseRow>(taxCaseRows.map((row) => [String(row.key), { mechanism: String(row.mechanism), rate: Number(row.default_rate), active: Boolean(row.active), requiresCountry: Boolean(row.requires_country) }]));
  const taxAccounts = new Set(Object.entries(roles).filter(([role]) => /(^|_)vat(_|$)/.test(role)).map(([, account]) => account));

  const issues: JournalImportIssue[] = [];
  let source: JournalImportResult['source'] = {};
  let datevRows: DatevImportRow[] = [];
  let csvEntries: JournalCsvEntry[] = [];
  if (input.format === 'datev') {
    const stack = parseDatevBuchungsstapel(bytes);
    issues.push(...stack.issues);
    datevRows = stack.rows;
    source = { chart: stack.chart, from: stack.from, to: stack.to, label: stack.label, accountLength: stack.accountLength, consultantNumber: stack.consultantNumber, clientNumber: stack.clientNumber };
    if (stack.chart && stack.chart !== chart) issues.push(blocking(1, `Der Stapel ist im ${stack.chart} gebucht, der Mandant führt ${chart}.`));
  } else {
    const parsed = parseJournalCsv(bytes);
    issues.push(...parsed.issues);
    csvEntries = parsed.entries;
  }
  const numbers = [...new Set([...datevRows.flatMap((row) => [row.konto, row.gegenkonto]), ...csvEntries.flatMap((entry) => entry.lines.map((item) => item.accountNumber))])];
  const usable = await usableAccountNumbers(db, t, chart, numbers);
  const ctx: Context = { db, t, chart, roles, names: new Map(), usable, taxCases, taxAccounts, accountLength: source.accountLength, issues, notes: new Map() };
  ctx.names = await accountNames(db, t, chart, numbers);

  const prepared: Prepared[] = [];
  for (const row of datevRows) prepared.push(await datevEntry(ctx, row));
  for (const entry of csvEntries) prepared.push(await csvEntry(ctx, entry));

  // Accounts after mapping (Personenkonten, tax accounts): one issue per missing account with the rows it appears on.
  const missing = new Map<string, { rows: number[]; entries: number }>();
  const booked = [...new Set(prepared.flatMap((entry) => entry.lines.map((item) => item.accountNumber)))];
  const known = await usableAccountNumbers(db, t, chart, booked);
  const names = await accountNames(db, t, chart, booked);
  for (const entry of prepared) {
    for (const accountNumber of new Set(entry.lines.map((item) => item.accountNumber).filter((account) => !known.has(account)))) {
      const current = missing.get(accountNumber) ?? { rows: [], entries: 0 };
      current.rows.push(entry.rows[0] ?? 0);
      current.entries += 1;
      missing.set(accountNumber, current);
      entry.invalid = true;
    }
  }
  for (const [accountNumber, { rows, entries }] of missing) {
    issues.push(blocking(rows[0] ?? 0, `Konto ${accountNumber} gibt es im ${chart} des Mandanten nicht (${entries} Buchung${entries > 1 ? 'en' : ''}). Bitte unter Kontenplan anlegen.`));
  }

  const existing = new Set((await q<{ source_key: string }>(db, `SELECT source_key FROM journal_entries WHERE tenant_id=$1 AND source_type='journal_import' AND source_key LIKE $2`, [t, `journal-import:${fileSha256}:%`])).map((row) => row.source_key));
  const fresh = prepared.filter((entry) => !entry.invalid && !existing.has(sourceKeyOf(fileSha256, entry.key)));
  issues.push(...await periodIssues(db, t, fresh, override));
  if (fresh.some((entry) => entry.lines.some((item) => isMoneyLedgerAccount(chart, item.accountNumber)))) {
    issues.push({ row: 0, message: 'Buchungen auf Bank- und Kassenkonten kommen ohne Bankzeile: der Bankabgleich zeigt sie als Differenz, bis die Kontoauszüge importiert und zugeordnet sind.', blocking: false });
  }
  // Same date, Beleg and amount already in the journal (e.g. booked by hand or from another export of the same data).
  const references = [...new Set(fresh.map((entry) => entry.reference))];
  if (references.length) {
    const booked = await q<{ posting_date: string; reference: string; total: string }>(db, `SELECT je.posting_date,je.reference,SUM(jl.debit_amount) AS total FROM journal_entries je JOIN journal_lines jl ON jl.tenant_id=je.tenant_id AND jl.entry_id=je.id
      WHERE je.tenant_id=$1 AND je.status='posted' AND je.reference = ANY($2::text[]) AND NOT (je.source_type='journal_import' AND je.source_key LIKE $3) GROUP BY je.id,je.posting_date,je.reference`, [t, references, `journal-import:${fileSha256}:%`]);
    const seen = new Set(booked.map((row) => `${row.posting_date}|${row.reference}|${Math.round(Number(row.total) * 100)}`));
    for (const entry of fresh) {
      const total = entry.lines.reduce((sum, item) => sum + Math.round(item.debitAmount * 100), 0);
      if (seen.has(`${entry.postingDate}|${entry.reference}|${total}`)) note(ctx, 'duplicate', entry.rows[0] ?? 0, 'Buchungen mit gleichem Datum, Beleg und Betrag stehen schon im Journal; bitte prüfen, ob sie doppelt wären.');
    }
  }
  for (const { rows, message } of ctx.notes.values()) {
    const unique = [...new Set(rows)];
    issues.push({ row: unique[0] ?? 0, message: `${message} (${unique.length} Zeile${unique.length > 1 ? 'n' : ''}: ${unique.slice(0, 8).join(', ')}${unique.length > 8 ? ' …' : ''})`, blocking: false });
  }

  const blocked = issues.some((issue) => issue.blocking);
  const ordered = [...fresh].sort((a, b) => a.postingDate.localeCompare(b.postingDate) || (a.rows[0] ?? 0) - (b.rows[0] ?? 0));
  let postedCount = 0;
  if (!dryRun && !blocked && ordered.length) {
    await runInTransaction(db, async (tx) => {
      for (const entry of ordered) {
        await insertEntry(tx, scope, 'journal_import', sourceKeyOf(fileSha256, entry.key), entry.postingDate, entry.bookingText, entry.lines, {
          documentDate: entry.postingDate, reference: entry.reference, softLockOverride: override, overrideReason: override ? input.overrideReason!.trim() : undefined, mutation: input.mutation,
        });
        postedCount += 1;
      }
      await appendWithClient(tx, scope, {
        occurredAt: new Date().toISOString(), action: 'import', reason: input.mutation?.reason?.trim() || 'Journal-Import',
        actor: input.mutation?.actor ?? { type: 'service', displayName: 'server-accounting' },
        subject: { entityType: 'journal_import', entityId: fileSha256, tenantId: t },
        change: { before: null, after: { format: input.format, fileName: input.fileName, entries: postedCount, from: ordered[0]!.postingDate, to: ordered.at(-1)!.postingDate } },
      });
    }, { serializable: true });
  }

  const statusOf = (entry: Prepared): JournalImportEntryPreview['status'] => (entry.invalid ? 'invalid' : existing.has(sourceKeyOf(fileSha256, entry.key)) ? 'imported' : 'new');
  const preview = [...prepared].sort((a, b) => Number(b.invalid) - Number(a.invalid) || a.postingDate.localeCompare(b.postingDate)).slice(0, PREVIEW_LIMIT).map((entry): JournalImportEntryPreview => ({
    key: entry.key, rows: entry.rows, postingDate: entry.postingDate, reference: entry.reference, bookingText: entry.bookingText, status: statusOf(entry),
    lines: entry.lines.map((item) => ({ accountNumber: item.accountNumber, accountName: names.get(item.accountNumber) || undefined, debitAmount: item.debitAmount, creditAmount: item.creditAmount, taxCaseKey: item.taxCaseKey, taxAmount: item.taxAmount, memo: item.memo })),
  }));
  return {
    format: input.format, fileName: input.fileName, fileSha256, dryRun, posted: postedCount > 0, source,
    entryCount: prepared.length, newCount: fresh.length, importedCount: prepared.filter((entry) => statusOf(entry) === 'imported').length,
    invalidCount: prepared.filter((entry) => entry.invalid).length, postedCount,
    debitTotal: euro(fresh.reduce((sum, entry) => sum + entry.lines.reduce((inner, item) => inner + Math.round(item.debitAmount * 100), 0), 0)),
    firstDate: ordered[0]?.postingDate, lastDate: ordered.at(-1)?.postingDate,
    missingAccounts: [...missing.keys()].sort(),
    issues: issues.sort((a, b) => Number(b.blocking) - Number(a.blocking) || a.row - b.row),
    entries: preview,
  };
};
