import type {
  AccountingHealthSnapshot,
  BilanzReport,
  DatevPostingRow,
  GuvReport,
  LedgerBalanceOptions,
  ListJournalEntriesOptions,
  PostDraftOptions,
  ProAccountingCatalogRepository,
  ProAccountingRepository,
  ProDraftActionRequest,
  ProWorkflowRepository,
  ReportRangeOptions,
  SusaReport,
} from '@billme/server-core';
import type { ReverseJournalEntryOptions } from '@billme/server-core/ports';
import type {
  AccountSuggestionRule,
  BookingDraftEntity,
  DatevExportResult,
  JournalEntryEntity,
  LedgerAccount,
  LedgerAccountStats,
  LedgerBalance,
  ListLedgerAccountsArgs,
  ProBankTransaction,
  ProWorkflowEntry,
  TaxCaseAccountMapping,
  TaxCaseDefinition,
  TaxCaseKey,
  UpsertAccountSuggestionRuleInput,
  ValidationIssue,
  AccountingAccountMapping,
  AccountingBackfillConfirmation,
  AccountingBackfillPreview,
  AccountingBackfillResult,
  AccountingPostingPreview,
  IncomingInvoiceEntity,
  OpenItemEntity,
  OpenItemPaymentEntity,
  OpenItemPaymentInput,
  VendorEntity,
} from '@billme/accounting-shared';
import type { TenantScope } from '@billme/server-core';

export interface ProAccountingOposRepository {
  getAccountingPolicy(scope: TenantScope): Promise<{ tenantId: string; activeChart: 'SKR03' | 'SKR04'; vatMethod: 'soll' | 'ist'; periodPolicy: 'calendar_month'; updatedAt: string }>;
  setAccountingPolicy(scope: TenantScope, input: { activeChart: 'SKR03' | 'SKR04'; vatMethod: 'soll' | 'ist' }): Promise<{ tenantId: string; activeChart: 'SKR03' | 'SKR04'; vatMethod: 'soll' | 'ist'; periodPolicy: 'calendar_month'; updatedAt: string }>;
  listAccountingAccountMappings(scope: TenantScope, chart?: 'SKR03' | 'SKR04'): Promise<AccountingAccountMapping[]>;
  upsertAccountingAccountMapping(scope: TenantScope, input: { id?: string; chart: 'SKR03' | 'SKR04'; role: AccountingAccountMapping['role']; accountNumber: string }): Promise<AccountingAccountMapping>;
  listVendors(scope: TenantScope): Promise<VendorEntity[]>;
  upsertVendor(scope: TenantScope, input: Omit<VendorEntity, 'tenantId' | 'createdAt' | 'updatedAt'>): Promise<VendorEntity>;
  listIncomingInvoices(scope: TenantScope): Promise<IncomingInvoiceEntity[]>;
  upsertIncomingInvoice(scope: TenantScope, input: IncomingInvoiceEntity): Promise<IncomingInvoiceEntity>;
  previewOutgoingInvoice(scope: TenantScope, invoiceId: string): Promise<AccountingPostingPreview>;
  postOutgoingInvoice(scope: TenantScope, invoiceId: string): Promise<AccountingPostingPreview>;
  previewIncomingInvoice(scope: TenantScope, invoiceId: string): Promise<AccountingPostingPreview>;
  postIncomingInvoice(scope: TenantScope, invoiceId: string): Promise<AccountingPostingPreview>;
  listOpenItems(scope: TenantScope): Promise<OpenItemEntity[]>;
  allocateOpenItemPayment(scope: TenantScope, input: OpenItemPaymentInput): Promise<OpenItemPaymentEntity>;
  allocateRemainingOpenItemPayment(scope: TenantScope, paymentId: string, allocations: Array<{ openItemId: string; amount: number }>): Promise<OpenItemPaymentEntity>;
  reverseDocumentAccounting(scope: TenantScope, input: { documentType: 'outgoing_invoice' | 'incoming_invoice'; documentId: string; reason: string; postingDate?: string }): Promise<{ ok: true; reversalEntryId: string }>;
  previewAccountingBackfill(scope: TenantScope): Promise<AccountingBackfillPreview>;
  confirmAccountingBackfill(scope: TenantScope, input: AccountingBackfillConfirmation): Promise<AccountingBackfillResult>;
}
type ProAccountingRepositoryWithOpos = ProAccountingRepository & ProAccountingOposRepository;

export interface ProAccountingService {
  listBankTransactions(scope: TenantScope): Promise<ProBankTransaction[]>;
  getDraftByTransactionId(scope: TenantScope, transactionId: string): Promise<BookingDraftEntity | null>;
  saveDraft(scope: TenantScope, draft: BookingDraftEntity): Promise<BookingDraftEntity>;
  dispatchDraftAction(scope: TenantScope, args: ProDraftActionRequest): Promise<BookingDraftEntity>;
  validateTaxCompliance(
    scope: TenantScope,
    args: { draftId?: string; transactionId?: string },
  ): Promise<{ ok: boolean; issues: ValidationIssue[] }>;
  postDraft(scope: TenantScope, draftId: string, options?: PostDraftOptions): Promise<{
    entry: JournalEntryEntity;
    issues: ValidationIssue[];
  }>;
  reverseJournalEntry(scope: TenantScope, entryId: string, reason: string, options?: ReverseJournalEntryOptions): Promise<{ ok: true; reversalEntryId: string }>;
  listJournalEntries(scope: TenantScope, args?: ListJournalEntriesOptions): Promise<JournalEntryEntity[]>;
  getLedgerBalances(scope: TenantScope, args?: LedgerBalanceOptions): Promise<LedgerBalance[]>;
  getSusaReport(scope: TenantScope, args?: LedgerBalanceOptions): Promise<SusaReport>;
  getGuvReport(scope: TenantScope, args?: ReportRangeOptions): Promise<GuvReport>;
  getBilanzReport(scope: TenantScope, args?: LedgerBalanceOptions): Promise<BilanzReport>;
  listDatevExports(scope: TenantScope): Promise<DatevExportResult[]>;
  insertDatevExport(
    scope: TenantScope,
    args: { filePath: string; recordCount: number; fromDate?: string; toDate?: string },
  ): Promise<DatevExportResult>;
  getAccountingHealth(scope: TenantScope): Promise<AccountingHealthSnapshot>;
  getVatSummary(scope: TenantScope, args?: ReportRangeOptions): Promise<{
    from?: string;
    to?: string;
    rows: Array<{
      taxCaseKey: TaxCaseKey;
      netAmount: number;
      taxAmount: number;
      grossAmount: number;
      lineCount: number;
    }>;
  }>;
  buildDatevRows(scope: TenantScope, args?: ReportRangeOptions): Promise<DatevPostingRow[]>;
  getAccountingPolicy(scope: TenantScope): ReturnType<ProAccountingOposRepository['getAccountingPolicy']>;
  setAccountingPolicy(scope: TenantScope, input: { activeChart: 'SKR03' | 'SKR04'; vatMethod: 'soll' | 'ist' }): ReturnType<ProAccountingOposRepository['setAccountingPolicy']>;
  listAccountingAccountMappings(scope: TenantScope, chart?: 'SKR03' | 'SKR04'): Promise<AccountingAccountMapping[]>;
  upsertAccountingAccountMapping(scope: TenantScope, input: { id?: string; chart: 'SKR03' | 'SKR04'; role: AccountingAccountMapping['role']; accountNumber: string }): Promise<AccountingAccountMapping>;
  listVendors(scope: TenantScope): Promise<VendorEntity[]>;
  upsertVendor(scope: TenantScope, input: Omit<VendorEntity, 'tenantId' | 'createdAt' | 'updatedAt'>): Promise<VendorEntity>;
  listIncomingInvoices(scope: TenantScope): Promise<IncomingInvoiceEntity[]>;
  upsertIncomingInvoice(scope: TenantScope, input: IncomingInvoiceEntity): Promise<IncomingInvoiceEntity>;
  previewOutgoingInvoice(scope: TenantScope, invoiceId: string): Promise<AccountingPostingPreview>;
  postOutgoingInvoice(scope: TenantScope, invoiceId: string): Promise<AccountingPostingPreview>;
  previewIncomingInvoice(scope: TenantScope, invoiceId: string): Promise<AccountingPostingPreview>;
  postIncomingInvoice(scope: TenantScope, invoiceId: string): Promise<AccountingPostingPreview>;
  listOpenItems(scope: TenantScope): Promise<OpenItemEntity[]>;
  allocateOpenItemPayment(scope: TenantScope, input: OpenItemPaymentInput): Promise<OpenItemPaymentEntity>;
  allocateRemainingOpenItemPayment(scope: TenantScope, paymentId: string, allocations: Array<{ openItemId: string; amount: number }>): Promise<OpenItemPaymentEntity>;
  reverseDocumentAccounting(scope: TenantScope, input: { documentType: 'outgoing_invoice' | 'incoming_invoice'; documentId: string; reason: string; postingDate?: string }): Promise<{ ok: true; reversalEntryId: string }>;
  previewAccountingBackfill(scope: TenantScope): Promise<AccountingBackfillPreview>;
  confirmAccountingBackfill(scope: TenantScope, input: AccountingBackfillConfirmation): Promise<AccountingBackfillResult>;
  ensureSeedData(scope: TenantScope): Promise<void>;
}

export interface BoundProAccountingService {
  listBankTransactions(): Promise<ProBankTransaction[]>;
  getDraftByTransactionId(transactionId: string): Promise<BookingDraftEntity | null>;
  saveDraft(draft: BookingDraftEntity): Promise<BookingDraftEntity>;
  dispatchDraftAction(args: ProDraftActionRequest): Promise<BookingDraftEntity>;
  validateTaxCompliance(args: { draftId?: string; transactionId?: string }): Promise<{ ok: boolean; issues: ValidationIssue[] }>;
  postDraft(draftId: string, options?: PostDraftOptions): Promise<{
    entry: JournalEntryEntity;
    issues: ValidationIssue[];
  }>;
  reverseJournalEntry(entryId: string, reason: string, options?: ReverseJournalEntryOptions): Promise<{ ok: true; reversalEntryId: string }>;
  listJournalEntries(args?: ListJournalEntriesOptions): Promise<JournalEntryEntity[]>;
  getLedgerBalances(args?: LedgerBalanceOptions): Promise<LedgerBalance[]>;
  getSusaReport(args?: LedgerBalanceOptions): Promise<SusaReport>;
  getGuvReport(args?: ReportRangeOptions): Promise<GuvReport>;
  getBilanzReport(args?: LedgerBalanceOptions): Promise<BilanzReport>;
  listDatevExports(): Promise<DatevExportResult[]>;
  insertDatevExport(args: { filePath: string; recordCount: number; fromDate?: string; toDate?: string }): Promise<DatevExportResult>;
  getAccountingHealth(): Promise<AccountingHealthSnapshot>;
  getVatSummary(args?: ReportRangeOptions): Promise<{
    from?: string;
    to?: string;
    rows: Array<{
      taxCaseKey: TaxCaseKey;
      netAmount: number;
      taxAmount: number;
      grossAmount: number;
      lineCount: number;
    }>;
  }>;
  buildDatevRows(args?: ReportRangeOptions): Promise<DatevPostingRow[]>;
  getAccountingPolicy(): ReturnType<ProAccountingOposRepository['getAccountingPolicy']>;
  setAccountingPolicy(input: { activeChart: 'SKR03' | 'SKR04'; vatMethod: 'soll' | 'ist' }): ReturnType<ProAccountingOposRepository['setAccountingPolicy']>;
  listAccountingAccountMappings(chart?: 'SKR03' | 'SKR04'): Promise<AccountingAccountMapping[]>;
  upsertAccountingAccountMapping(input: { id?: string; chart: 'SKR03' | 'SKR04'; role: AccountingAccountMapping['role']; accountNumber: string }): Promise<AccountingAccountMapping>;
  listVendors(): Promise<VendorEntity[]>;
  upsertVendor(input: Omit<VendorEntity, 'tenantId' | 'createdAt' | 'updatedAt'>): Promise<VendorEntity>;
  listIncomingInvoices(): Promise<IncomingInvoiceEntity[]>;
  upsertIncomingInvoice(input: IncomingInvoiceEntity): Promise<IncomingInvoiceEntity>;
  previewOutgoingInvoice(invoiceId: string): Promise<AccountingPostingPreview>;
  postOutgoingInvoice(invoiceId: string): Promise<AccountingPostingPreview>;
  previewIncomingInvoice(invoiceId: string): Promise<AccountingPostingPreview>;
  postIncomingInvoice(invoiceId: string): Promise<AccountingPostingPreview>;
  listOpenItems(): Promise<OpenItemEntity[]>;
  allocateOpenItemPayment(input: OpenItemPaymentInput): Promise<OpenItemPaymentEntity>;
  allocateRemainingOpenItemPayment(paymentId: string, allocations: Array<{ openItemId: string; amount: number }>): Promise<OpenItemPaymentEntity>;
  reverseDocumentAccounting(input: { documentType: 'outgoing_invoice' | 'incoming_invoice'; documentId: string; reason: string; postingDate?: string }): Promise<{ ok: true; reversalEntryId: string }>;
  previewAccountingBackfill(): Promise<AccountingBackfillPreview>;
  confirmAccountingBackfill(input: AccountingBackfillConfirmation): Promise<AccountingBackfillResult>;
  ensureSeedData(): Promise<void>;
}

export interface ProWorkflowService {
  list(scope: TenantScope): Promise<ProWorkflowEntry[]>;
  upsert(
    scope: TenantScope,
    args: { transactionId: string; transactionJson: string; draftJson: string },
  ): Promise<{ ok: true }>;
}

export interface BoundProWorkflowService {
  list(): Promise<ProWorkflowEntry[]>;
  upsert(args: { transactionId: string; transactionJson: string; draftJson: string }): Promise<{ ok: true }>;
}

export interface ProAccountingCatalogService {
  listLedgerAccounts(scope: TenantScope, args?: ListLedgerAccountsArgs): Promise<LedgerAccount[]>;
  getLedgerStats(): Promise<LedgerAccountStats>;
  listTaxCases(scope: TenantScope, args?: { activeOnly?: boolean }): Promise<TaxCaseDefinition[]>;
  listTaxCaseAccountMappings(
    scope: TenantScope,
    args?: { chart?: LedgerAccount['chart']; taxCaseKey?: TaxCaseKey },
  ): Promise<TaxCaseAccountMapping[]>;
  upsertTaxCaseAccountMapping(
    scope: TenantScope,
    args: {
      id?: string;
      chart: LedgerAccount['chart'];
      taxCaseKey: TaxCaseKey;
      role: TaxCaseAccountMapping['role'];
      accountNumber: string;
      datevBuKey?: string;
      validFrom?: string;
      validTo?: string;
    },
  ): Promise<TaxCaseAccountMapping>;
  listAccountSuggestionRules(
    scope: TenantScope,
    args?: { chart?: LedgerAccount['chart']; activeOnly?: boolean },
  ): Promise<AccountSuggestionRule[]>;
  upsertAccountSuggestionRule(
    scope: TenantScope,
    input: UpsertAccountSuggestionRuleInput,
  ): Promise<AccountSuggestionRule>;
  deleteAccountSuggestionRule(scope: TenantScope, id: string): Promise<void>;
}

export interface BoundProAccountingCatalogService {
  listLedgerAccounts(args?: ListLedgerAccountsArgs): Promise<LedgerAccount[]>;
  getLedgerStats(): Promise<LedgerAccountStats>;
  listTaxCases(args?: { activeOnly?: boolean }): Promise<TaxCaseDefinition[]>;
  listTaxCaseAccountMappings(args?: {
    chart?: LedgerAccount['chart'];
    taxCaseKey?: TaxCaseKey;
  }): Promise<TaxCaseAccountMapping[]>;
  upsertTaxCaseAccountMapping(args: {
    id?: string;
    chart: LedgerAccount['chart'];
    taxCaseKey: TaxCaseKey;
    role: TaxCaseAccountMapping['role'];
    accountNumber: string;
    datevBuKey?: string;
    validFrom?: string;
    validTo?: string;
  }): Promise<TaxCaseAccountMapping>;
  listAccountSuggestionRules(args?: {
    chart?: LedgerAccount['chart'];
    activeOnly?: boolean;
  }): Promise<AccountSuggestionRule[]>;
  upsertAccountSuggestionRule(input: UpsertAccountSuggestionRuleInput): Promise<AccountSuggestionRule>;
  deleteAccountSuggestionRule(id: string): Promise<void>;
}

export const createProAccountingService = (repository: ProAccountingRepositoryWithOpos): ProAccountingService => ({
  listBankTransactions: (scope) => repository.listBankTransactions(scope),
  getDraftByTransactionId: (scope, transactionId) => repository.getDraftByTransactionId(scope, transactionId),
  saveDraft: (scope, draft) => repository.saveDraft(scope, draft),
  dispatchDraftAction: (scope, args) => repository.dispatchDraftAction(scope, args),
  validateTaxCompliance: (scope, args) => repository.validateTaxCompliance(scope, args),
  postDraft: (scope, draftId, options) => repository.postDraft(scope, draftId, options),
  reverseJournalEntry: (scope, entryId, reason, options) =>
    (repository.reverseJournalEntry as unknown as (scope: TenantScope, entryId: string, reason: string, options?: ReverseJournalEntryOptions) => Promise<{ ok: true; reversalEntryId: string }>)(scope, entryId, reason, options),
  listJournalEntries: (scope, args) => repository.listJournalEntries(scope, args),
  getLedgerBalances: (scope, args) => repository.getLedgerBalances(scope, args),
  getSusaReport: (scope, args) => repository.getSusaReport(scope, args),
  getGuvReport: (scope, args) => repository.getGuvReport(scope, args),
  getBilanzReport: (scope, args) => repository.getBilanzReport(scope, args),
  listDatevExports: (scope) => repository.listDatevExports(scope),
  insertDatevExport: (scope, args) => repository.insertDatevExport(scope, args),
  getAccountingHealth: (scope) => repository.getAccountingHealth(scope),
  getVatSummary: (scope, args) => repository.getVatSummary(scope, args),
  buildDatevRows: (scope, args) => repository.buildDatevRows(scope, args),
  getAccountingPolicy: (scope) => repository.getAccountingPolicy(scope),
  setAccountingPolicy: (scope, input) => repository.setAccountingPolicy(scope, input),
  listAccountingAccountMappings: (scope, chart) => repository.listAccountingAccountMappings(scope, chart),
  upsertAccountingAccountMapping: (scope, input) => repository.upsertAccountingAccountMapping(scope, input),
  listVendors: (scope) => repository.listVendors(scope),
  upsertVendor: (scope, input) => repository.upsertVendor(scope, input),
  listIncomingInvoices: (scope) => repository.listIncomingInvoices(scope),
  upsertIncomingInvoice: (scope, input) => repository.upsertIncomingInvoice(scope, input),
  previewOutgoingInvoice: (scope, invoiceId) => repository.previewOutgoingInvoice(scope, invoiceId),
  postOutgoingInvoice: (scope, invoiceId) => repository.postOutgoingInvoice(scope, invoiceId),
  previewIncomingInvoice: (scope, invoiceId) => repository.previewIncomingInvoice(scope, invoiceId),
  postIncomingInvoice: (scope, invoiceId) => repository.postIncomingInvoice(scope, invoiceId),
  listOpenItems: (scope) => repository.listOpenItems(scope),
  allocateOpenItemPayment: (scope, input) => repository.allocateOpenItemPayment(scope, input),
  allocateRemainingOpenItemPayment: (scope, paymentId, allocations) => repository.allocateRemainingOpenItemPayment(scope, paymentId, allocations),
  reverseDocumentAccounting: (scope, input) => repository.reverseDocumentAccounting(scope, input),
  previewAccountingBackfill: (scope) => repository.previewAccountingBackfill(scope),
  confirmAccountingBackfill: (scope, input) => repository.confirmAccountingBackfill(scope, input),
  ensureSeedData: (scope) => repository.ensureSeedData(scope),
});

export const bindProAccountingScope = (
  service: ProAccountingService,
  scope: TenantScope,
): BoundProAccountingService => ({
  listBankTransactions: () => service.listBankTransactions(scope),
  getDraftByTransactionId: (transactionId) => service.getDraftByTransactionId(scope, transactionId),
  saveDraft: (draft) => service.saveDraft(scope, draft),
  dispatchDraftAction: (args) => service.dispatchDraftAction(scope, args),
  validateTaxCompliance: (args) => service.validateTaxCompliance(scope, args),
  postDraft: (draftId, options) => service.postDraft(scope, draftId, options),
  reverseJournalEntry: (entryId, reason, options) => service.reverseJournalEntry(scope, entryId, reason, options),
  listJournalEntries: (args) => service.listJournalEntries(scope, args),
  getLedgerBalances: (args) => service.getLedgerBalances(scope, args),
  getSusaReport: (args) => service.getSusaReport(scope, args),
  getGuvReport: (args) => service.getGuvReport(scope, args),
  getBilanzReport: (args) => service.getBilanzReport(scope, args),
  listDatevExports: () => service.listDatevExports(scope),
  insertDatevExport: (args) => service.insertDatevExport(scope, args),
  getAccountingHealth: () => service.getAccountingHealth(scope),
  getVatSummary: (args) => service.getVatSummary(scope, args),
  buildDatevRows: (args) => service.buildDatevRows(scope, args),
  getAccountingPolicy: () => service.getAccountingPolicy(scope),
  setAccountingPolicy: (input) => service.setAccountingPolicy(scope, input),
  listAccountingAccountMappings: (chart) => service.listAccountingAccountMappings(scope, chart),
  upsertAccountingAccountMapping: (input) => service.upsertAccountingAccountMapping(scope, input),
  listVendors: () => service.listVendors(scope),
  upsertVendor: (input) => service.upsertVendor(scope, input),
  listIncomingInvoices: () => service.listIncomingInvoices(scope),
  upsertIncomingInvoice: (input) => service.upsertIncomingInvoice(scope, input),
  previewOutgoingInvoice: (invoiceId) => service.previewOutgoingInvoice(scope, invoiceId),
  postOutgoingInvoice: (invoiceId) => service.postOutgoingInvoice(scope, invoiceId),
  previewIncomingInvoice: (invoiceId) => service.previewIncomingInvoice(scope, invoiceId),
  postIncomingInvoice: (invoiceId) => service.postIncomingInvoice(scope, invoiceId),
  listOpenItems: () => service.listOpenItems(scope),
  allocateOpenItemPayment: (input) => service.allocateOpenItemPayment(scope, input),
  allocateRemainingOpenItemPayment: (paymentId, allocations) => service.allocateRemainingOpenItemPayment(scope, paymentId, allocations),
  reverseDocumentAccounting: (input) => service.reverseDocumentAccounting(scope, input),
  previewAccountingBackfill: () => service.previewAccountingBackfill(scope),
  confirmAccountingBackfill: (input) => service.confirmAccountingBackfill(scope, input),
  ensureSeedData: () => service.ensureSeedData(scope),
});

export const createProWorkflowService = (repository: ProWorkflowRepository): ProWorkflowService => ({
  list: (scope) => repository.list(scope),
  upsert: (scope, args) => repository.upsert(scope, args),
});

export const bindProWorkflowScope = (service: ProWorkflowService, scope: TenantScope): BoundProWorkflowService => ({
  list: () => service.list(scope),
  upsert: (args) => service.upsert(scope, args),
});

export const createProAccountingCatalogService = (
  repository: ProAccountingCatalogRepository,
): ProAccountingCatalogService => ({
  listLedgerAccounts: (scope, args) => repository.listLedgerAccounts(scope, args),
  getLedgerStats: () => repository.getLedgerStats(),
  listTaxCases: (scope, args) => repository.listTaxCases(scope, args),
  listTaxCaseAccountMappings: (scope, args) => repository.listTaxCaseAccountMappings(scope, args),
  upsertTaxCaseAccountMapping: (scope, args) => repository.upsertTaxCaseAccountMapping(scope, args),
  listAccountSuggestionRules: (scope, args) => repository.listAccountSuggestionRules(scope, args),
  upsertAccountSuggestionRule: (scope, input) => repository.upsertAccountSuggestionRule(scope, input),
  deleteAccountSuggestionRule: (scope, id) => repository.deleteAccountSuggestionRule(scope, id),
});

export const bindProAccountingCatalogScope = (
  service: ProAccountingCatalogService,
  scope: TenantScope,
): BoundProAccountingCatalogService => ({
  listLedgerAccounts: (args) => service.listLedgerAccounts(scope, args),
  getLedgerStats: () => service.getLedgerStats(),
  listTaxCases: (args) => service.listTaxCases(scope, args),
  listTaxCaseAccountMappings: (args) => service.listTaxCaseAccountMappings(scope, args),
  upsertTaxCaseAccountMapping: (args) => service.upsertTaxCaseAccountMapping(scope, args),
  listAccountSuggestionRules: (args) => service.listAccountSuggestionRules(scope, args),
  upsertAccountSuggestionRule: (input) => service.upsertAccountSuggestionRule(scope, input),
  deleteAccountSuggestionRule: (id) => service.deleteAccountSuggestionRule(scope, id),
});
