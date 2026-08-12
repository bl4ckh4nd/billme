import type { LedgerChart } from './accounting';

export type ReportingBusinessSize = 'micro' | 'small';

/** Calculation-only projection of the persisted business reporting settings. */
export interface ReportingCalculationProfile {
  businessId?: string;
  businessName?: string;
  size: ReportingBusinessSize;
  /** Fiscal-year start as a calendar month/day, e.g. 04-15. */
  fiscalYearStart: string;
  chart?: LedgerChart;
  currency?: string;
  hgbGuvMethod?: 'gkv';
}

export interface FiscalYearRange {
  fiscalYear: number;
  start: string;
  end: string;
  label: string;
}

interface MonthDay {
  month: number;
  day: number;
}

const isLeapYear = (year: number): boolean => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number =>
  month === 2 ? (isLeapYear(year) ? 29 : 28) : [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

function parseMonthDay(value: string): MonthDay {
  const match = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(value);
  if (!match) throw new RangeError('fiscalYearStart must use MM-DD');
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (day > (month === 2 ? 29 : [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1])) throw new RangeError('fiscalYearStart is not a valid calendar date');
  return { month, day };
}

const isoDate = (year: number, month: number, day: number): string =>
  `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;

/** Returns the fiscal-year start year; 2025-04-15 belongs to fiscal year 2025 for 04-15. */
export function fiscalYearForDate(date: string, fiscalYearStart: string): number {
  const { month, day } = parseMonthDay(fiscalYearStart);
  const year = Number(date.slice(0, 4));
  const dateMonth = Number(date.slice(5, 7));
  const dateDay = Number(date.slice(8, 10));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || dateMonth < 1 || dateMonth > 12 || dateDay < 1 || dateDay > daysInMonth(year, dateMonth)) {
    throw new RangeError('date must use YYYY-MM-DD');
  }
  return dateMonth < month || (dateMonth === month && dateDay < day) ? year - 1 : year;
}

/** Builds an ISO fiscal-year range without timezone-dependent Date parsing. */
export function fiscalYearRange(fiscalYear: number, fiscalYearStart: string): FiscalYearRange {
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1) throw new RangeError('fiscalYear must be a positive year');
  const { month, day } = parseMonthDay(fiscalYearStart);
  if (day > daysInMonth(fiscalYear, month)) throw new RangeError('fiscalYearStart is not valid in the fiscal year');
  const nextYear = fiscalYear + 1;
  const nextStart = Date.UTC(nextYear, month - 1, day);
  const end = new Date(nextStart - 86_400_000);
  const endYear = end.getUTCFullYear();
  const endMonth = end.getUTCMonth() + 1;
  const endDay = end.getUTCDate();
  return {
    fiscalYear,
    start: isoDate(fiscalYear, month, day),
    end: isoDate(endYear, endMonth, endDay),
    label: month === 1 && day === 1 ? String(fiscalYear) : `${fiscalYear}/${endYear}`,
  };
}

export const getFiscalYearForDate = fiscalYearForDate;
export const getFiscalYearRange = fiscalYearRange;

export function assertEurUsesCalendarYear(profile: ReportingCalculationProfile): void {
  if (profile.fiscalYearStart !== '01-01') throw new RangeError('EÜR requires a calendar fiscal year starting on 01-01');
}

export type ReportKind =
  | 'susa'
  | 'bwa01'
  | 'management-guv'
  | 'management_guv'
  | 'hgb-guv'
  | 'hgb_guv'
  | 'hgb-bilanz'
  | 'hgb_bilanz'
  | 'eur-ledger-reconciliation'
  | 'eur_ledger_reconciliation';

export interface ReportingPeriod {
  from?: string;
  to?: string;
  asOfDate?: string;
}

export interface LedgerInputLine {
  accountNumber: string;
  debit: number;
  credit: number;
  memo?: string;
}

export interface LedgerInputEntry {
  id?: string;
  postingDate: string;
  status?: 'posted' | 'reversed' | 'void';
  lines: LedgerInputLine[];
}

export interface LedgerInputBalance {
  accountNumber: string;
  openingBalance?: number;
  debitTurnover?: number;
  creditTurnover?: number;
  closingBalance?: number;
}

/** Neutral journal/balance input accepted by every report calculator. */
export interface LedgerInput {
  entries?: LedgerInputEntry[];
  balances?: LedgerInputBalance[];
}

export type CashInputKind = 'income' | 'expense' | 'tax' | 'transfer' | 'private' | 'other';

export interface CashInputEntry {
  id?: string;
  date: string;
  amount: number;
  kind: CashInputKind;
  accountNumber?: string;
  memo?: string;
}

export interface CashInput {
  entries: CashInputEntry[];
}

/**
 * Report mappings are statement-scoped.  The short names remain accepted for
 * old persisted mappings, but the calculators treat them as compatibility
 * input and never use them as an implicit mapping for another statement.
 */
export type ReportingStatement =
  | 'bwa01'
  | 'management-guv'
  | 'hgb-guv'
  | 'hgb-gkv'
  | 'hgb-bilanz'
  | 'hgb-balance'
  | 'eur'
  | 'bwa'
  | 'guv'
  | 'bilanz';
export type ReportingBalanceSide = 'asset' | 'liability';

/** Explicit account-to-report mapping. Amounts remain owned by the ledger. */
export interface ReportingMapping {
  accountNumber: string;
  statement: ReportingStatement | readonly ReportingStatement[];
  position: string;
  label?: string;
  side?: ReportingBalanceSide;
}

/** Mapping diagnostics are part of every result so incomplete reports are visible. */
export interface MappingHealth {
  mappedAccounts: number;
  inferredAccounts: number;
  unmappedAccounts: string[];
  warnings: string[];
  blocking: boolean;
}

export interface ReportSnapshot {
  from?: string;
  to?: string;
  asOfDate?: string;
  fiscalYear: number;
  fiscalYearStart: string;
  fiscalYearRange?: FiscalYearRange;
  businessSize: ReportingBusinessSize;
  ledgerEntryCount: number;
  ledgerAccountCount: number;
  cashEntryCount: number;
}

export interface ReportRequest {
  kind?: ReportKind;
  profile: ReportingCalculationProfile;
  ledger: LedgerInput;
  cash?: CashInput;
  mappings?: ReportingMapping[];
  from?: string;
  to?: string;
  asOfDate?: string;
  period?: ReportingPeriod;
}

export interface ReportEnvelope {
  kind: ReportKind;
  snapshot: ReportSnapshot;
  mappingHealth: MappingHealth;
}

export type ReportResult<T extends object> = T & ReportEnvelope;

export interface SusaRow {
  accountNumber: string;
  openingBalance: number;
  debitTurnover: number;
  creditTurnover: number;
  closingBalance: number;
  mappedTo?: string;
  label?: string;
}

export interface SusaReport {
  rows: SusaRow[];
  totals: {
    debit: number;
    credit: number;
    balance: number;
  };
}

export interface ReportingLine {
  position: string;
  label: string;
  amount: number;
  accountNumbers: string[];
  /** API-facing alias retained for report drilldowns. */
  accountRefs?: string[];
  /** Public catalog hierarchy metadata. */
  kind?: 'heading' | 'line' | 'subtotal' | 'result';
  parentPosition?: string;
  /** Human-readable formula for derived subtotal/result rows. */
  formula?: string;
}

export interface Bwa01Report {
  rows: ReportingLine[];
  totals: {
    revenue: number;
    expenses: number;
    operatingResult: number;
  };
}

export interface ManagementGuvReport {
  rows: ReportingLine[];
  netResult: number;
}

export interface HgbGuvReport {
  method: 'gkv';
  rows: ReportingLine[];
  netResult: number;
}

export interface HgbBilanzReport {
  assets: ReportingLine[];
  liabilities: ReportingLine[];
  totals: {
    assets: number;
    liabilities: number;
    delta: number;
  };
}

export interface EurLedgerReconciliationReport {
  cashIncome: number;
  cashExpenses: number;
  cashResult: number;
  ledgerIncome: number;
  ledgerExpenses: number;
  ledgerResult: number;
  differences: {
    income: number;
    expenses: number;
    result: number;
  };
  unmatchedCashEntries: string[];
}

export interface ReportResultsByKind {
  susa: ReportResult<SusaReport>;
  bwa01: ReportResult<Bwa01Report>;
  'management-guv': ReportResult<ManagementGuvReport>;
  'hgb-guv': ReportResult<HgbGuvReport>;
  'hgb-bilanz': ReportResult<HgbBilanzReport>;
  'eur-ledger-reconciliation': ReportResult<EurLedgerReconciliationReport>;
}
