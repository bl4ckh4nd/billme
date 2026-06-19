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
} from '@billme/accounting-shared';
import type { TenantScope } from '@billme/server-core';

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
  reverseJournalEntry(scope: TenantScope, entryId: string, reason: string): Promise<{ ok: true; reversalEntryId: string }>;
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
  reverseJournalEntry(entryId: string, reason: string): Promise<{ ok: true; reversalEntryId: string }>;
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

export interface ProAccountingFacade {
  accounting: ProAccountingService;
  catalog: ProAccountingCatalogService;
  workflow: ProWorkflowService;
}

export interface BoundProAccountingFacade {
  accounting: BoundProAccountingService;
  catalog: BoundProAccountingCatalogService;
  workflow: BoundProWorkflowService;
}

export const createProAccountingService = (repository: ProAccountingRepository): ProAccountingService => ({
  listBankTransactions: (scope) => repository.listBankTransactions(scope),
  getDraftByTransactionId: (scope, transactionId) => repository.getDraftByTransactionId(scope, transactionId),
  saveDraft: (scope, draft) => repository.saveDraft(scope, draft),
  dispatchDraftAction: (scope, args) => repository.dispatchDraftAction(scope, args),
  validateTaxCompliance: (scope, args) => repository.validateTaxCompliance(scope, args),
  postDraft: (scope, draftId, options) => repository.postDraft(scope, draftId, options),
  reverseJournalEntry: (scope, entryId, reason) => repository.reverseJournalEntry(scope, entryId, reason),
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
  reverseJournalEntry: (entryId, reason) => service.reverseJournalEntry(scope, entryId, reason),
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

export const createProAccountingFacade = (repositories: {
  accounting: ProAccountingRepository;
  catalog: ProAccountingCatalogRepository;
  workflow: ProWorkflowRepository;
}): ProAccountingFacade => ({
  accounting: createProAccountingService(repositories.accounting),
  catalog: createProAccountingCatalogService(repositories.catalog),
  workflow: createProWorkflowService(repositories.workflow),
});

export const bindProAccountingFacadeScope = (
  facade: ProAccountingFacade,
  scope: TenantScope,
): BoundProAccountingFacade => ({
  accounting: bindProAccountingScope(facade.accounting, scope),
  catalog: bindProAccountingCatalogScope(facade.catalog, scope),
  workflow: bindProWorkflowScope(facade.workflow, scope),
});
