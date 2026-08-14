import type { ClosingDomainSourceType } from '@billme/accounting-shared';

export type AccountingCommandKind =
  | 'standalone'
  | 'correction'
  | 'skonto'
  | 'bad_debt'
  | 'advance_settlement'
  | 'fiscal_close'
  | 'carry_forward'
  | 'provision'
  | 'accrual'
  | 'inventory_closing'
  | 'fx_valuation'
  | 'loan_schedule'
  | 'payroll_batch'
  | 'shareholder_flow';

/** Source runs use the shared closing source identities plus shareholder flows. */
export type AccountingSourceType = ClosingDomainSourceType | 'shareholder_flow';

export type SourceFactLine = {
  accountNumber: string;
  debitAmount: number;
  creditAmount: number;
  memo?: string;
};

export type AccountingSourceFact = {
  sourceType: AccountingSourceType;
  sourceId: string;
  sourceRevision: string;
  effectiveDate: string;
  postingDate: string;
  period: string;
  fiscalYear: number;
  currency: string;
  bookingText: string;
  reference?: string;
  lines: SourceFactLine[];
};

/** Command payload for this workspace: domain builders, not the UI, own lines. */
export type DomainAccountingSourceFact = Omit<AccountingSourceFact, 'lines'> & { lines: [] };

export type AccountingSourceRun = {
  id: string;
  sourceType: AccountingSourceType;
  sourceId: string;
  sourceRevision: string;
  status: 'posted' | 'rejected' | 'noop' | 'prepared';
  fact?: AccountingSourceFact;
  journalEntryId?: string;
  createdAt: string;
};

export type AccountingSourcePostResult = {
  status: 'posted' | 'rejected' | 'duplicate' | 'noop';
  sourceRun?: AccountingSourceRun;
  errors: Array<{ code: string; message: string; field?: string; blocking?: boolean }>;
  idempotencyKey: string;
};

export type AccountingCommandInput = {
  kind: AccountingCommandKind;
  source: DomainAccountingSourceFact;
  domainFacts?: Record<string, unknown>;
  reason: string;
};

/** Facts for a domain workflow. The workspace owns this source context. */
export type AccountingDomainFacts = Record<string, unknown> & {
  sourceId: string;
  date: string;
  period: string;
  fiscalYear: number;
};

export type TaxPreparationKind = 'ustva' | 'zm' | 'oss';

export type TaxPreparationInput = {
  kind: TaxPreparationKind;
  period: string;
  year?: number;
  reason: string;
  idempotencyKey?: string;
  entries?: readonly Record<string, unknown>[];
};

export type TaxPreparationArtifact = {
  kind: TaxPreparationKind;
  status: 'prepared' | 'blocked';
  submissionReady: false;
  providerValidation: 'unavailable';
  exportable: true;
  sourceHash?: string;
  warnings?: string[];
  [key: string]: unknown;
};

export type EurFactKind = 'income' | 'expense' | 'private-withdrawal' | 'private-contribution' | 'pass-through';

export type EurExpenseSplit = {
  amountNet: number;
  deductibility?: 'deductible' | 'non-deductible';
  lineId?: string;
  reason?: string;
};

export type EurCashFact = {
  id: string;
  sourceType: 'transaction' | 'invoice';
  sourceId: string;
  taxYear: number;
  kind: EurFactKind;
  amountNet: number;
  flowType?: 'income' | 'expense';
  eurLineId?: string;
  splits?: EurExpenseSplit[];
  createdAt?: string;
};

export type EurCashFactInput = Omit<EurCashFact, 'id' | 'createdAt'> & {
  reason: string;
  idempotencyKey?: string;
};

export type EurAnnexFact = {
  id: string;
  taxYear: number;
  annex: string;
  lineId: string;
  amount: number;
  sourceId?: string;
  date?: string;
  createdAt?: string;
};

export type EurAnnexFactInput = Omit<EurAnnexFact, 'id' | 'createdAt'> & {
  reason: string;
  idempotencyKey?: string;
};
