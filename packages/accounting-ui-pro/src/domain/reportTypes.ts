export type ReportTabId = 'eur' | 'susa' | 'bwa01' | 'management_guv' | 'hgb_guv' | 'bilanz';
export type ReportProfile = 'all' | 'standard' | 'management' | 'tax';
export type ReportPeriodPreset = 'current' | 'ytd' | 'prev_year';

export interface BusinessReportingProfile {
  legalForm: 'sole_proprietor' | 'gmbh';
  profitDetermination: 'eur' | 'double_entry';
  fiscalYearStart?: string;
  chart?: 'SKR03' | 'SKR04';
}

export interface ReportFilterState {
  chart: 'SKR03' | 'SKR04';
  asOfDate: string;
  periodFrom?: string;
  periodTo?: string;
  /** Exact boundaries are used for fiscal years that do not start on the first day of a month. */
  periodFromDate?: string;
  periodToDate?: string;
  compareMode: 'none' | 'prev_period' | 'prev_year';
  includeDrafts: boolean;
  /** Convenience period selector; explicit date/month boundaries remain authoritative. */
  periodPreset?: ReportPeriodPreset;
  businessReportingProfile?: BusinessReportingProfile;
}

export interface ReportQuality {
  generatedAt: string;
  source: 'mock' | 'live';
  /** Reports with unresolved mappings must not be treated as accounting truth. */
  unmappedAccounts?: number | ReportUnmappedAccount[];
  warnings: number;
  state?: 'preview' | 'frozen';
  mappingStatus?: 'healthy' | 'warning' | 'blocked';
  mappingNotes?: string[];
}

export interface SusaRow {
  accountNumber: string;
  accountName: string;
  groupLabel?: string;
  openingBalance: number;
  debitTurnover: number;
  creditTurnover: number;
  closingBalance: number;
  normalBalance: 'debit' | 'credit';
  mappedTo?: string;
  hasWarnings?: boolean;
}

export interface SusaReport {
  rows: SusaRow[];
  totals: {
    openingDebit: number;
    openingCredit: number;
    turnoverDebit: number;
    turnoverCredit: number;
    closingDebit: number;
    closingCredit: number;
  };
  quality: {
    unmappedAccounts: number;
    warnings: number;
    generatedAt: string;
    source: 'mock' | 'live';
    state?: 'preview' | 'frozen';
    mappingStatus?: 'healthy' | 'warning' | 'blocked';
    mappingNotes?: string[];
  };
}

export interface GuvLine {
  id: string;
  code: string;
  label: string;
  level: number;
  amountCurrent: number;
  amountCompare?: number;
  children?: GuvLine[];
  accountRefs?: string[];
  isSubtotal?: boolean;
}

export interface GuvReport {
  lines: GuvLine[];
  totals: {
    revenue: number;
    expenses: number;
    result: number;
  };
  quality: {
    unmappedAccounts: ReportUnmappedAccount[];
    warnings: number;
    generatedAt: string;
    source: 'mock' | 'live';
    state?: 'preview' | 'frozen';
    mappingStatus?: 'healthy' | 'warning' | 'blocked';
    mappingNotes?: string[];
  };
  filing?: ReportFilingProvenance;
}

export interface ReportFilingProvenance {
  kind: 'euer';
  taxYear: number;
  catalog: {
    id: string;
    version: string;
    sourceHash: string;
    delivery: 'print-form-only' | 'elster-ready';
    elsterReady: boolean;
  };
  lineProvenance: Array<{ lineId: string; kennziffer?: string; providerPath?: string; exportable: boolean }>;
}

export interface ReportUnmappedAccount {
  accountNumber: string;
  amount: number;
}

export interface BalanceSheetPreviewLine {
  id: string;
  code: string;
  label: string;
  amount: number;
  level: number;
  side: 'aktiva' | 'passiva';
  /** Authoritative account references supplied by the report adapter. */
  accountRefs?: string[];
  isSubtotal?: boolean;
}

export interface BalanceSheetPreview {
  aktiva: BalanceSheetPreviewLine[];
  passiva: BalanceSheetPreviewLine[];
  totals: {
    aktiva: number;
    passiva: number;
    difference: number;
  };
  quality: {
    status: 'ok' | 'warning' | 'error';
    notes: string[];
    generatedAt: string;
    source: 'mock' | 'live';
    state?: 'preview' | 'frozen';
    mappingStatus?: 'healthy' | 'warning' | 'blocked';
    mappingNotes?: string[];
  };
}

export interface ReportExportRequest {
  report: ReportTabId;
  filters: ReportFilterState;
  format: 'pdf' | 'csv';
}

export interface ReportExportResult {
  format: 'pdf' | 'csv';
  fileName?: string;
  content?: string;
  path?: string;
}

export const REPORT_TABS: ReadonlyArray<{ id: ReportTabId; label: string; description: string }> = [
  { id: 'eur', label: 'EÜR', description: 'Einnahmenüberschussrechnung' },
  { id: 'susa', label: 'SuSa', description: 'Summen- und Saldenliste' },
  { id: 'bwa01', label: 'BWA01', description: 'Betriebswirtschaftliche Auswertung' },
  { id: 'management_guv', label: 'Management-GuV', description: 'Interne Ergebnisrechnung' },
  { id: 'hgb_guv', label: 'HGB-GuV', description: 'Gewinn- und Verlustrechnung nach HGB' },
  { id: 'bilanz', label: 'Bilanz', description: 'Bilanz nach HGB' },
];

export const reportTabsForProfile = (profile: ReportProfile): ReportTabId[] => {
  if (profile === 'management') return ['bwa01', 'management_guv', 'susa'];
  if (profile === 'tax') return ['eur', 'hgb_guv', 'bilanz', 'susa'];
  if (profile === 'standard') return ['susa', 'hgb_guv', 'bilanz'];
  return REPORT_TABS.map((tab) => tab.id);
};

/** Fail closed when onboarding has not supplied the canonical legal/reporting profile. */
export const reportTabsForBusinessProfile = (profile?: BusinessReportingProfile): ReportTabId[] => {
  if (!profile) return ['susa'];
  if (profile.legalForm === 'sole_proprietor' && profile.profitDetermination === 'eur') {
    return ['eur', 'susa', 'bwa01', 'management_guv'];
  }
  if (profile.legalForm === 'gmbh' && profile.profitDetermination === 'double_entry') {
    return ['susa', 'bwa01', 'hgb_guv', 'bilanz'];
  }
  return ['susa'];
};

export interface ReportDrilldownSelection {
  reportType: 'susa' | 'guv' | 'bilanz';
  targetId: string;
  targetLabel: string;
  accountNumbers: string[];
  from?: string;
  to?: string;
}

export type ReportDrilldownSourceType = 'bank_transaction' | 'invoice' | 'incoming_invoice' | 'receipt' | 'payment' | 'journal_entry';

export interface ReportDrilldownSource {
  sourceType: ReportDrilldownSourceType;
  sourceId: string;
}

export interface ReportDrilldownEntry {
  id: string;
  date: string;
  bookingText: string;
  reference?: string;
  journalEntryId: string;
  sourceType: ReportDrilldownSourceType;
  sourceId: string;
  transactionId?: string;
  accountNumber: string;
  debit: number;
  credit: number;
  amount: number;
  source: 'Inbox' | 'Abgleich' | 'Anlagen' | 'AfA' | 'Manuell';
}
