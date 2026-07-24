export interface ReportFilterState {
  chart: 'SKR03' | 'SKR04';
  mandantId: string;
  asOfDate: string;
  periodFrom?: string;
  periodTo?: string;
  compareMode: 'none' | 'prev_period' | 'prev_year';
  includeDrafts: boolean;
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
    unmappedAccounts: number;
    warnings: number;
    generatedAt: string;
    source: 'mock' | 'live';
  };
}

export interface BalanceSheetPreviewLine {
  id: string;
  code: string;
  label: string;
  amount: number;
  level: number;
  side: 'aktiva' | 'passiva';
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
  };
}

export interface ReportDrilldownSelection {
  reportType: 'susa' | 'guv' | 'bilanz';
  targetId: string;
  targetLabel: string;
  accountNumbers: string[];
}

export interface ReportDrilldownEntry {
  id: string;
  date: string;
  bookingText: string;
  reference?: string;
  transactionId?: string;
  accountNumber: string;
  debit: number;
  credit: number;
  amount: number;
  source: 'Inbox' | 'Abgleich' | 'Anlagen' | 'AfA' | 'Manuell';
}
