export type SourceType = 'transaction' | 'invoice';
export type VatMode = 'none' | 'default';
export type QueueStatus = 'all' | 'unclassified' | 'classified' | 'excluded';
export type QueueSort = 'date_desc' | 'amount_desc' | 'counterparty_asc';
export type SuggestionLayer = 'rule' | 'counterparty' | 'bayes' | 'keyword';

export type EurItem = {
  sourceType: SourceType;
  sourceId: string;
  date: string;
  amountGross: number;
  amountNet: number;
  flowType: 'income' | 'expense';
  counterparty: string;
  purpose: string;
  suggestedLineId?: string;
  suggestionReason?: string;
  suggestionLayer?: SuggestionLayer;
  classification?: {
    eurLineId?: string;
    excluded: boolean;
    vatMode: VatMode;
    updatedAt: string;
  };
  line?: {
    lineId?: string;
    id?: string;
    kennziffer?: string;
    label: string;
  };
};

export type EurReportRow = {
  lineId: string;
  kennziffer?: string;
  label: string;
  kind: string;
  exportable: boolean;
  total: number;
  sortOrder: number;
};

export type EurReport = {
  taxYear: number;
  from: string;
  to: string;
  rows: EurReportRow[];
  summary: {
    incomeTotal: number;
    expenseTotal: number;
    surplus: number;
  };
  unclassifiedCount: number;
  warnings: string[];
};

export type EurLineOption = {
  lineId: string;
  kennziffer?: string;
  label: string;
  kind: string;
};

export type UndoChange = {
  sourceType: SourceType;
  sourceId: string;
  taxYear: number;
  prevLineId?: string;
  prevExcluded: boolean;
  prevVatMode: VatMode;
};

export const DEFAULT_YEAR = 2025;

export const LAYER_LABELS: Record<SuggestionLayer, string> = {
  rule: 'Regel',
  counterparty: 'Gemerkt',
  bayes: 'KI',
  keyword: 'Stichwort',
};

export const LAYER_COLORS: Record<SuggestionLayer, string> = {
  rule: 'bg-purple-100 text-purple-700',
  counterparty: 'bg-green-100 text-green-700',
  bayes: 'bg-amber-100 text-amber-700',
  keyword: 'bg-blue-100 text-blue-700',
};

export const formatCurrency = (amount: number): string =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);

export const triggerCsvDownload = (content: string, fileName: string): void => {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

export const itemKey = (item: { sourceType: SourceType; sourceId: string }): string =>
  `${item.sourceType}:${item.sourceId}`;
