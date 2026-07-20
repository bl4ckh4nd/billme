import type { Invoice as InvoiceType } from '../../types';

export interface InvoiceMatchSuggestion {
  invoice: InvoiceType;
  confidence: 'high' | 'medium' | 'low';
  matchReasons: string[];
  amountDiff: number;
}

export interface MatchResult {
  transaction: import('../../types').Transaction;
  suggestions: InvoiceMatchSuggestion[];
}

export type MatchingTab = 'matching' | 'eur';
export type EurStatus = 'all' | 'unclassified' | 'classified' | 'excluded';

export type EurTxItem = {
  sourceType: 'transaction' | 'invoice';
  sourceId: string;
  date: string;
  amountGross: number;
  amountNet: number;
  flowType: 'income' | 'expense';
  accountId?: string;
  linkedViaInvoice?: boolean;
  counterparty: string;
  purpose: string;
  suggestedLineId?: string;
  suggestionReason?: string;
  classification?: {
    eurLineId?: string;
    excluded: boolean;
    vatMode: 'none' | 'default';
    updatedAt: string;
  };
};

export type EurUndo = {
  sourceType: 'transaction' | 'invoice';
  sourceId: string;
  taxYear: number;
  prevLineId?: string;
  prevExcluded: boolean;
  prevVatMode: 'none' | 'default';
};

export const keyOf = (item: { sourceType: 'transaction' | 'invoice'; sourceId: string }): string =>
  `${item.sourceType}:${item.sourceId}`;
