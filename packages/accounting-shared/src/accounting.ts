export type BookingWorkflowStatus =
  | 'imported'
  | 'suggested'
  | 'incomplete'
  | 'ready_for_review'
  | 'pending_approval'
  | 'approved'
  | 'posted'
  | 'reversed'
  | 'corrected'
  | 'period_locked'
  | 'integration_error';

export type ValidationSeverity = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  id: string;
  code: string;
  severity: ValidationSeverity;
  message: string;
  fieldPath?: string;
  blocking: boolean;
  source: 'system' | 'user' | 'rule';
}

export interface JournalLine {
  id: string;
  accountNumber: string;
  debitAmount: number;
  creditAmount: number;
  taxCode?: string;
  taxCaseKey?: TaxCaseKey;
  taxRate?: number;
  netAmount?: number;
  taxAmount?: number;
  grossAmount?: number;
  countryCode?: string;
  counterpartyVatId?: string;
  evidenceType?: string;
  evidenceReference?: string;
  costCenter?: string;
  memo?: string;
}

export interface JournalEntry {
  id: string;
  postingDate: string;
  documentDate?: string;
  bookingText: string;
  reference?: string;
  period: string;
  fiscalYear: number;
  status: 'posted' | 'reversed';
  sourceType?: JournalSourceType;
  sourceKey?: string;
  lines: JournalLine[];
}

export type JournalSourceType =
  | 'booking_draft'
  | 'reversal'
  | 'depreciation'
  | 'manual'
  | 'outgoing_invoice'
  | 'incoming_invoice'
  | 'payment'
  | 'payment_vat'
  | 'legacy_transaction';

export interface LedgerBalance {
  accountNumber: string;
  openingBalance: number;
  debitTurnover: number;
  creditTurnover: number;
  closingBalance: number;
}

export interface ReportUnmappedAccount {
  accountNumber: string;
  amount: number;
}

/**
 * Stable source identity used by report drilldowns.  A journal entry is not a
 * bank transaction: callers must use journalEntryId for the former and only
 * route transactionId for the latter.
 */
export type ReportDrilldownSourceType = 'bank_transaction' | 'invoice' | 'incoming_invoice' | 'receipt' | 'payment' | 'journal_entry';

export interface ReportDrilldownSource {
  sourceType: ReportDrilldownSourceType;
  sourceId: string;
}

export interface ReportGenerationContext {
  mandantId: string;
  chart: 'SKR03' | 'SKR04';
  mappingVersion: string;
  asOfDate: string;
}

export interface BookingDraftLineEntity {
  id: string;
  accountNumber: string;
  debitAmount: number;
  creditAmount: number;
  taxCode?: string;
  taxCaseKey?: TaxCaseKey;
  taxRate?: number;
  netAmount?: number;
  taxAmount?: number;
  grossAmount?: number;
  countryCode?: string;
  counterpartyVatId?: string;
  evidenceType?: string;
  evidenceReference?: string;
  costCenter?: string;
  memo?: string;
}

export interface BookingDraftEntity {
  id: string;
  tenantId: string;
  transactionId: string;
  workflowStatus: BookingWorkflowStatus;
  postingDate?: string;
  documentDate?: string;
  bookingText: string;
  reference?: string;
  period: string;
  fiscalYear: number;
  lines: BookingDraftLineEntity[];
  validationIssues: ValidationIssue[];
  updatedAt: string;
}

export interface JournalLineEntity {
  id: string;
  accountNumber: string;
  debitAmount: number;
  creditAmount: number;
  taxCode?: string;
  taxCaseKey?: TaxCaseKey;
  taxRate?: number;
  netAmount?: number;
  taxAmount?: number;
  grossAmount?: number;
  countryCode?: string;
  counterpartyVatId?: string;
  evidenceType?: string;
  evidenceReference?: string;
  costCenter?: string;
  memo?: string;
}

export interface JournalEntryEntity {
  id: string;
  tenantId: string;
  entryNumber: number;
  postingDate: string;
  documentDate?: string;
  bookingText: string;
  reference?: string;
  period: string;
  fiscalYear: number;
  status: 'posted' | 'reversed';
  sourceDraftId?: string;
  sourceType?: JournalSourceType;
  sourceKey?: string;
  reversedEntryId?: string;
  createdAt: string;
  lines: JournalLineEntity[];
}

export interface AccountingPolicy {
  tenantId: string;
  activeChart: LedgerChart;
  vatMethod: 'soll' | 'ist';
  periodPolicy: 'calendar_month';
  updatedAt: string;
}

export interface AccountingPeriod {
  id: string;
  tenantId: string;
  period: string;
  fiscalYear: number;
  status: 'open' | 'soft_locked' | 'closed';
  startsAt: string;
  endsAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface DatevExportResult {
  id: string;
  filePath: string;
  recordCount: number;
  fromDate?: string;
  toDate?: string;
  createdAt: string;
  sha256?: string;
  byteSize?: number;
  encoding?: 'cp1252' | 'utf8-bom';
  headerVersion?: number;
  formatVersion?: number;
  chart?: LedgerChart;
  sourceSnapshotHash?: string;
  manifestJson?: string;
  status?: string;
  validationJson?: string;
}

export interface ProWorkflowEntry {
  transactionId: string;
  transactionJson: string;
  draftJson: string;
  updatedAt: string;
}

export interface ProBankTransaction {
  id: string;
  tenantId: string;
  accountId: string;
  date: string;
  amount: number;
  type: 'income' | 'expense';
  counterparty: string;
  purpose: string;
  status: 'pending' | 'booked';
  linkedInvoiceId?: string;
  suggestedAccountNumber?: string;
  suggestionReason?: string;
  suggestionLayer?: 'rule' | 'counterparty' | 'bayes' | 'keyword' | 'fallback';
  suggestionConfidence?: number;
}

export type LedgerChart = 'SKR03' | 'SKR04';

export interface LedgerAccount {
  id: string;
  chart: LedgerChart;
  accountNumber: string;
  name: string;
  keywords?: string[];
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface ListLedgerAccountsArgs {
  chart?: LedgerChart;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface LedgerAccountStats {
  total: number;
  byChart: Record<LedgerChart, number>;
}

export type TaxMechanism = 'standard_vat' | 'reverse_charge' | 'zero_rate' | 'exempt';

export type TaxCaseKey =
  | 'DE_STD_19'
  | 'DE_STD_7'
  | 'DE_ZERO_EXEMPT'
  | 'DE_KU19'
  | 'DE_RC_13B_DOMESTIC'
  | 'EU_B2C_OSS'
  | 'DE_MARGIN_25A'
  | 'DE_BAUABZUG_48'
  | 'DE_TRIANGULAR_25B'
  | 'EU_B2B_SERVICE_RC'
  | 'EU_IGL_GOODS_0'
  | 'EU_IGE_GOODS_RC'
  | 'NON_EU_EXPORT_0'
  | 'NON_EU_SERVICE_RC';

export interface TaxCaseDefinition {
  key: TaxCaseKey;
  label: string;
  mechanism: TaxMechanism;
  defaultRate: number;
  requiresCounterpartyVatId: boolean;
  requiresCountry: boolean;
  requiresEvidence: boolean;
  active: boolean;
}

export type TaxMappingRole = 'output_tax' | 'input_tax' | 'datev_bu';

export interface TaxCaseAccountMapping {
  id: string;
  chart: LedgerChart;
  taxCaseKey: TaxCaseKey;
  role: TaxMappingRole;
  accountNumber: string;
  datevBuKey?: string;
  validFrom?: string;
  validTo?: string;
  updatedAt: string;
}

export type AccountSuggestionRuleField = 'counterparty' | 'purpose' | 'any';
export type AccountSuggestionRuleOperator = 'contains' | 'equals' | 'startsWith';
export type AccountSuggestionRuleFlowType = 'income' | 'expense' | 'any';

export interface AccountSuggestionRule {
  id: string;
  tenantId: string;
  chart: LedgerChart;
  priority: number;
  field: AccountSuggestionRuleField;
  operator: AccountSuggestionRuleOperator;
  value: string;
  targetAccountNumber: string;
  flowType: AccountSuggestionRuleFlowType;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertAccountSuggestionRuleInput {
  id?: string;
  tenantId?: string;
  chart: LedgerChart;
  priority: number;
  field: AccountSuggestionRuleField;
  operator: AccountSuggestionRuleOperator;
  value: string;
  targetAccountNumber: string;
  flowType?: AccountSuggestionRuleFlowType;
  active?: boolean;
}
