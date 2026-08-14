import type { JournalEntry, JournalSourceType, LedgerBalance } from './accounting';

/** ISO-4217 money. Values are always interpreted at cent precision. */
export interface AccountingMoney {
  amount: number;
  currency: string;
}

export type ClosingDomainSourceType = Extract<JournalSourceType,
  | 'standalone_source'
  | 'fiscal_close'
  | 'carry_forward'
  | 'provision'
  | 'accrual'
  | 'inventory_closing'
  | 'fx_valuation'
  | 'loan_schedule'
  | 'payroll_batch'
>;

export interface SourceFactLine {
  accountNumber: string;
  debitAmount: number;
  creditAmount: number;
  memo?: string;
}

/** The only input the pure posting boundary needs from a source subsystem. */
export interface AccountingSourceFact {
  sourceType: ClosingDomainSourceType;
  sourceId: string;
  sourceRevision: string;
  effectiveDate: string;
  postingDate: string;
  period: string;
  fiscalYear: number;
  /** Optional non-calendar fiscal-year boundary (MM-DD); defaults to 01-01. */
  fiscalYearStart?: string;
  currency: string;
  bookingText: string;
  reference?: string;
  lines: readonly SourceFactLine[];
}

export interface JournalCommand {
  commandId: string;
  idempotencyKey: string;
  immutableRevision: string;
  effectiveDate: string;
  currency: string;
  source: Pick<AccountingSourceFact, 'sourceType' | 'sourceId' | 'sourceRevision'>;
  entry: JournalEntry;
}

export type ClosingDomainStatus = 'ready' | 'rejected' | 'duplicate' | 'noop';

export type ClosingDomainErrorCode =
  | 'MISSING_SOURCE_ID'
  | 'MISSING_SOURCE_REVISION'
  | 'INVALID_DATE'
  | 'INVALID_PERIOD'
  | 'INVALID_FISCAL_YEAR'
  | 'INVALID_CURRENCY'
  | 'INVALID_AMOUNT'
  | 'NEGATIVE_AMOUNT'
  | 'INVALID_ACCOUNT'
  | 'INVALID_LINE'
  | 'UNBALANCED_ENTRY'
  | 'DUPLICATE_SOURCE_REVISION'
  | 'PERIOD_MISMATCH'
  | 'CURRENCY_MISMATCH'
  | 'INVALID_RANGE'
  | 'INVALID_RATE'
  | 'ROLL_FORWARD_MISMATCH'
  | 'GROSS_TO_NET_MISMATCH'
  | 'SHAREHOLDER_CONFLICT'
  | 'APPROVAL_REQUIRED';

export interface ClosingDomainError {
  code: ClosingDomainErrorCode;
  message: string;
  field?: string;
  blocking: true;
}

export interface ClosingDomainResult<T> {
  status: ClosingDomainStatus;
  value?: T;
  errors: ClosingDomainError[];
  idempotencyKey?: string;
}

export interface FiscalCloseInput {
  sourceId: string;
  sourceRevision: string;
  fiscalYear: number;
  fiscalYearStart?: string;
  period: string;
  closingDate: string;
  currency: string;
  revenueAccounts: readonly string[];
  expenseAccounts: readonly string[];
  retainedEarningsAccount: string;
  balances: readonly LedgerBalance[];
}

export interface FiscalCloseResult {
  netResult: number;
  command?: JournalCommand;
  reconciliation: RollForwardReconciliation;
}

export interface CarryForwardInput {
  sourceId: string;
  sourceRevision: string;
  effectiveDate: string;
  period: string;
  fiscalYear: number;
  fiscalYearStart?: string;
  currency: string;
  balanceSheetAccounts: readonly string[];
  openingBalanceAccount: string;
  balances: readonly LedgerBalance[];
}

export interface CarryForwardResult {
  lines: SourceFactLine[];
  command?: JournalCommand;
  reconciliation: RollForwardReconciliation;
}

export interface RollForwardInput {
  opening: readonly LedgerBalance[];
  movements: readonly LedgerBalance[];
  closing: readonly LedgerBalance[];
}

export interface RollForwardReconciliation {
  balanced: boolean;
  differences: Array<{ accountNumber: string; difference: number }>;
}

export interface ProvisionInput {
  sourceId: string;
  sourceRevision: string;
  effectiveDate: string;
  period: string;
  fiscalYear: number;
  fiscalYearStart?: string;
  currency: string;
  previousAmount: number;
  targetAmount: number;
  expenseAccount: string;
  provisionAccount: string;
  bookingText?: string;
}

export interface AccrualInput {
  sourceId: string;
  sourceRevision: string;
  startDate: string;
  endDate: string;
  period: string;
  fiscalYear: number;
  fiscalYearStart?: string;
  currency: string;
  totalAmount: number;
  expenseAccount: string;
  deferralAccount: string;
}

export interface AccrualPeriod {
  period: string;
  date: string;
  amount: number;
}

export interface AccrualSchedule {
  periods: AccrualPeriod[];
  totalAmount: number;
  commands: JournalCommand[];
}

export interface InventoryClosingItem {
  id: string;
  quantity: number;
  unitCost: number;
  unitMarketValue: number;
  inventoryAccount: string;
  expenseAccount: string;
}

export interface InventoryClosingInput {
  sourceId: string;
  sourceRevision: string;
  effectiveDate: string;
  period: string;
  fiscalYear: number;
  fiscalYearStart?: string;
  currency: string;
  items: readonly InventoryClosingItem[];
}

export interface InventoryClosingValuation {
  id: string;
  cost: number;
  marketValue: number;
  closingValue: number;
  writeDown: number;
}

export interface InventoryClosingResult {
  valuations: InventoryClosingValuation[];
  totalCost: number;
  totalClosingValue: number;
  totalWriteDown: number;
  command?: JournalCommand;
}

export interface FxValuationInput {
  sourceId: string;
  sourceRevision: string;
  effectiveDate: string;
  period: string;
  fiscalYear: number;
  fiscalYearStart?: string;
  foreignCurrency: string;
  functionalCurrency: string;
  foreignAmount: number;
  closingRate: number;
  carryingAmount: number;
  position: 'asset' | 'liability';
  positionAccount: string;
  gainAccount: string;
  lossAccount: string;
}

export interface FxValuationResult {
  translatedAmount: number;
  difference: number;
  command?: JournalCommand;
}

export interface LoanScheduleInput {
  sourceId: string;
  sourceRevision: string;
  startDate: string;
  period: string;
  fiscalYear: number;
  fiscalYearStart?: string;
  currency: string;
  principal: number;
  annualInterestRate: number;
  termMonths: number;
  liabilityAccount: string;
  interestAccount: string;
  cashAccount: string;
}

export interface LoanSchedulePeriod {
  period: number;
  date: string;
  openingBalance: number;
  payment: number;
  interest: number;
  principal: number;
  closingBalance: number;
}

export interface LoanSchedule {
  periods: LoanSchedulePeriod[];
  commands: JournalCommand[];
}

export interface PayrollBatchLine {
  employeeId: string;
  gross: number;
  employeeTaxes: number;
  otherDeductions: number;
  net: number;
  employerContributions?: number;
}

export interface PayrollBatchInput {
  batchId: string;
  sourceRevision: string;
  effectiveDate: string;
  period: string;
  fiscalYear: number;
  fiscalYearStart?: string;
  currency: string;
  lines: readonly PayrollBatchLine[];
}

export interface PayrollControlTotals {
  employeeCount: number;
  gross: number;
  employeeTaxes: number;
  otherDeductions: number;
  net: number;
  employerContributions: number;
  totalEmployerCost: number;
}

export interface PayrollBatchValidation {
  controlTotals: PayrollControlTotals;
  errors: ClosingDomainError[];
  status: 'valid' | 'invalid';
}

export interface ShareholderFlowInput {
  flowId: string;
  shareholderId: string;
  companyId: string;
  amount: number;
  flowType: 'capital_contribution' | 'distribution' | 'loan_to_company' | 'loan_from_company' | 'private_withdrawal' | 'private_expense';
  approved?: boolean;
  counterpartyId?: string;
  purpose?: string;
}

export type ShareholderFlowClassification = 'allowed' | 'related_party' | 'conflict' | 'requires_approval';

export interface ShareholderFlowValidation {
  classification: ShareholderFlowClassification;
  conflicts: ClosingDomainError[];
}
