import type { LedgerChart } from './accounting';

export type ReportingBusinessSize = 'micro' | 'small';

/** The profile contains policy, not persistence details. */
export interface BusinessReportingProfile {
  businessId?: string;
  businessName?: string;
  size: ReportingBusinessSize;
  /** Month in which the fiscal year starts (1 = January, 12 = December). */
  fiscalYearStart: number;
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

/** Returns the fiscal year start year; July 2025 belongs to fiscal year 2025. */
export function fiscalYearForDate(date: string, fiscalYearStart: number): number {
  if (!Number.isInteger(fiscalYearStart) || fiscalYearStart < 1 || fiscalYearStart > 12) {
    throw new RangeError('fiscalYearStart must be a month from 1 to 12');
  }
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return year - (month < fiscalYearStart ? 1 : 0);
}

/** Builds an ISO fiscal-year range without timezone-dependent Date parsing. */
export function fiscalYearRange(fiscalYear: number, fiscalYearStart: number): FiscalYearRange {
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1) throw new RangeError('fiscalYear must be a positive year');
  if (!Number.isInteger(fiscalYearStart) || fiscalYearStart < 1 || fiscalYearStart > 12) {
    throw new RangeError('fiscalYearStart must be a month from 1 to 12');
  }
  const endYear = fiscalYearStart === 1 ? fiscalYear : fiscalYear + 1;
  const endMonth = fiscalYearStart === 1 ? 12 : fiscalYearStart - 1;
  const daysInEndMonth = new Date(Date.UTC(endYear, endMonth, 0)).getUTCDate();
  return {
    fiscalYear,
    start: `${fiscalYear.toString().padStart(4, '0')}-${fiscalYearStart.toString().padStart(2, '0')}-01`,
    end: `${endYear.toString().padStart(4, '0')}-${endMonth.toString().padStart(2, '0')}-${daysInEndMonth.toString().padStart(2, '0')}`,
    label: fiscalYearStart === 1 ? String(fiscalYear) : `${fiscalYear}/${endYear}`,
  };
}

export const getFiscalYearForDate = fiscalYearForDate;
export const getFiscalYearRange = fiscalYearRange;

export function assertEurUsesCalendarYear(profile: BusinessReportingProfile): void {
  if (profile.fiscalYearStart !== 1) throw new RangeError('EÜR requires a calendar fiscal year starting in January');
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

export type ReportingStatement = 'bwa' | 'guv' | 'bilanz' | 'eur';
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
  fiscalYearStart: number;
  fiscalYearRange?: FiscalYearRange;
  businessSize: ReportingBusinessSize;
  ledgerEntryCount: number;
  ledgerAccountCount: number;
  cashEntryCount: number;
}

export interface ReportRequest {
  kind?: ReportKind;
  profile: BusinessReportingProfile;
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
