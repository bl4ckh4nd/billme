import type { Account, AccountingActorRole, BookingAction, BookingDraft, LinkedInvoiceSummary, OpenRouterVlmConfig, Transaction, TransactionDocumentAnalysis, UserRole } from '../types';
import type { BalanceSheetPreview, EurCashItem, EurCashClassification, GuvReport, ReportDrilldownEntry, ReportDrilldownSelection, ReportExportRequest, ReportExportResult, ReportFilterState, SusaReport } from '../domain/reportTypes';
import type { ReportMappingHealth, ReportMappingPosition, ReportMappingOverrideInput } from '../domain/reportMapping';
import type { AssetDepreciationScheduleEntry, AssetItem, AssetUpsertInput } from '../domain/assetTypes';
import type { AccountingPostingPreview, IncomingInvoiceDocumentEntity, IncomingInvoiceEntity, OpenItemEntity, OpenItemPaymentEntity, OpenItemPaymentInput, VendorEntity } from '@billme/accounting-shared';
import type { ProBankTransaction } from '@billme/accounting-shared';
import type { AccountingCommandInput, AccountingSourcePostResult, AccountingSourceRun, EurAnnexFact, EurAnnexFactInput, EurCashFact, EurCashFactInput, TaxPreparationArtifact, TaxPreparationInput } from '../sourceRuns';
import type { JournalEntryEntity } from '@billme/accounting-shared';

// The desktop IPC transaction schema intentionally omits tenantId because the
// tenant is fixed by the local Pro database. Keep the source identity and
// imported-bank fields intact while enriching it with the resolved ledger
// account needed by OPOS posting.
export type OposBankTransaction = Omit<ProBankTransaction, 'tenantId'> & { bankAccountNumber: string };

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
  chart?: 'SKR03' | 'SKR04';
  sourceSnapshotHash?: string;
  manifestJson?: string;
  status?: string;
  validationJson?: string;
}

export interface MockStoreSeed {
  transactions?: Transaction[];
  drafts?: BookingDraft[];
  accounts?: Account[];
  chartFramework?: 'SKR03' | 'SKR04';
  bankAccountNumber?: string;
  bankAccountNumberByTransactionId?: Record<string, string>;
}

type MaybePromise<T> = T | Promise<T>;

export type AccountingPeriodStatus = 'open' | 'soft_locked' | 'closed';
export interface AccountingPeriodRow { period: string; status: AccountingPeriodStatus; fiscalYear?: number; entryCount: number; updatedAt?: string }

export interface ProAccountingDataAdapter {
  hydrate?: (seed: MockStoreSeed) => void;
  listTransactions?: () => Transaction[];
  listBookingDrafts?: () => BookingDraft[];
  getTransactionById?: (id: string) => Transaction | undefined;
  getBookingDraftByTransactionId?: (transactionId: string) => BookingDraft | undefined;
  getLinkedInvoice?: (transactionId: string) => MaybePromise<LinkedInvoiceSummary | null>;
  getOpenRouterVlmConfig?: () => Promise<OpenRouterVlmConfig>;
  analyzeTransactionDocument?: (input: { transaction: { id: string; date: string; amount: number; currency: string; type: 'income' | 'expense'; counterparty: string; purpose: string; linkedInvoiceId?: string; suggestedAccountNumber?: string; suggestionReason?: string }; document: { mimeType: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp'; data: string; fileName?: string }; model?: string }) => Promise<TransactionDocumentAnalysis>;
  getJournalEntryById?: (id: string) => MaybePromise<JournalEntryEntity | null>;
  saveDraft?: (draft: BookingDraft, actorName?: string) => MaybePromise<BookingDraft>;
  dispatchBookingAction?: (
    transactionId: string,
    action: BookingAction,
    options?: { role: UserRole; actorName?: string; rejectReason?: string },
  ) => MaybePromise<BookingDraft>;
  listActivity?: (transactionId: string) => BookingDraft['activity'];
  reset?: () => void;
  updateExceptionCase?: (
    transactionId: string,
    patch: Partial<NonNullable<Transaction['exceptionCase']>>,
    actorName: string,
  ) => MaybePromise<Transaction>;
  assignExceptionOwner?: (transactionId: string, owner: string, actorName: string) => MaybePromise<Transaction>;
  snoozeException?: (transactionId: string, snoozedUntil: string, actorName: string, note?: string) => MaybePromise<Transaction>;
  resolveException?: (transactionId: string, resolutionNote: string, actorName: string) => MaybePromise<Transaction>;
  reopenException?: (transactionId: string, actorName: string) => MaybePromise<Transaction>;
  getSusaReport?: (filters: ReportFilterState) => Promise<SusaReport>;
  getGuvReport?: (filters: ReportFilterState) => Promise<GuvReport>;
  getBalanceSheetPreview?: (filters: ReportFilterState) => Promise<BalanceSheetPreview>;
  getReportDrilldownEntries?: (selection: ReportDrilldownSelection) => Promise<ReportDrilldownEntry[]>;
  getEurReport?: (filters: ReportFilterState) => Promise<GuvReport>;
  listEurCashItems?: (taxYear?: number) => Promise<EurCashItem[]>;
  upsertEurClassification?: (input: EurCashClassification & { reason: string }) => Promise<unknown>;
  postAccountingCommand?: (input: AccountingCommandInput) => Promise<AccountingSourcePostResult>;
  listAccountingSourceRuns?: () => Promise<AccountingSourceRun[]>;
  listAccountingPeriods?: (year: number) => Promise<AccountingPeriodRow[]>;
  setAccountingPeriodStatus?: (input: { period: string; status: AccountingPeriodStatus; reason: string }) => Promise<unknown>;
  getAccountingSourceRun?: (id: string) => Promise<AccountingSourceRun | null>;
  prepareTaxExport?: (input: TaxPreparationInput) => Promise<{ artifact: TaxPreparationArtifact; run?: AccountingSourceRun; replayed?: boolean }>;
  exportTaxArtifact?: (kind: TaxPreparationInput['kind'], id: string) => Promise<Blob | Uint8Array | string>;
  saveEurCashFact?: (input: EurCashFactInput) => Promise<EurCashFact>;
  listEurCashFacts?: (taxYear: number) => Promise<EurCashFact[]>;
  saveEurAnnexFact?: (input: EurAnnexFactInput) => Promise<EurAnnexFact>;
  listEurAnnexFacts?: (taxYear: number, annex?: string) => Promise<EurAnnexFact[]>;
  getBwaReport?: (filters: ReportFilterState) => Promise<GuvReport>;
  getManagementGuvReport?: (filters: ReportFilterState) => Promise<GuvReport>;
  getHgbGuvReport?: (filters: ReportFilterState) => Promise<GuvReport>;
  /** Read-only catalog and report-specific missing-account diagnostics. */
  getReportMappingHealth?: (args?: { chart?: 'SKR03' | 'SKR04'; statement?: ReportMappingHealth['unmapped'][number]['statement']; asOfDate?: string }) => Promise<ReportMappingHealth>;
  listReportMappingPositions?: (args: { statement: ReportMappingHealth['unmapped'][number]['statement']; asOfDate: string }) => Promise<ReportMappingPosition[]>;
  upsertReportMappingOverride?: (input: ReportMappingOverrideInput) => Promise<unknown>;
  listReportSnapshots?: (reportType?: string) => Promise<ReportSnapshotRecord[]>;
  saveReportSnapshot?: (input: {
    reportType: string;
    args: unknown;
    payload: unknown;
    reason: string;
  }) => Promise<ReportSnapshotRecord>;
  exportReport?: (request: ReportExportRequest) => Promise<ReportExportResult | void>;
  exportReportPdf?: (request: Omit<ReportExportRequest, 'format'>) => Promise<ReportExportResult | void>;
  exportReportCsv?: (request: Omit<ReportExportRequest, 'format'>) => Promise<ReportExportResult | void>;
  listAssets?: () => Promise<AssetItem[]>;
  upsertAsset?: (asset: AssetUpsertInput, reason: string) => Promise<AssetItem>;
  getDepreciationSchedule?: (assetId: string) => Promise<AssetDepreciationScheduleEntry[]>;
  runDepreciation?: (args: {
    assetId: string;
    year: number;
    postingDate: string;
    reason: string;
    actorRole: AccountingActorRole;
  }) => Promise<{ asset: AssetItem; scheduleEntry: AssetDepreciationScheduleEntry; journalEntryId: string }>;
  disposeAsset?: (args: {
    assetId: string;
    disposalDate: string;
    proceeds: number;
    taxRate: 0 | 7 | 19;
    proceedsAccountNumber?: string;
    reason: string;
    actorRole: AccountingActorRole;
  }) => Promise<{ asset: AssetItem; residualBookValue: number; gainLoss: number; journalEntryId?: string }>;
  exportDatevBuchungsstapel?: (args: {
    from: string;
    to: string;
    consultantNumber: string;
    clientNumber: string;
    fiscalYearStart: string;
    accountLength: number;
    encoding: 'cp1252' | 'utf8-bom';
  }) => Promise<DatevExportResult>;
  listDatevExports?: (limit?: number) => Promise<DatevExportResult[]>;
  getDatevExportContent?: (exportId: string) => Promise<Blob>;
  listOpenItems?: () => Promise<OpenItemEntity[]>;
  listBankTransactions?: () => Promise<OposBankTransaction[]>;
  allocateOpenItemPayment?: (input: OpenItemPaymentInput) => Promise<OpenItemPaymentEntity>;
  allocateRemainingOpenItemPayment?: (
    paymentId: string,
    allocations: Array<{ openItemId: string; amount: number }>,
    allocationEventId: string,
    reason: string,
  ) => Promise<OpenItemPaymentEntity>;
  listOpenItemPayments?: () => Promise<OpenItemPaymentEntity[]>;
  /** Zahlungsstorno with a required reason; the server posts the mirror entries. */
  reverseOpenItemPayment?: (paymentId: string, reason: string) => Promise<unknown>;
  /** Umbuchung: Storno and new allocation of the same payment under one reason. */
  reallocateOpenItemPayment?: (paymentId: string, input: { reason: string; partyId: string; allocations: Array<{ openItemId: string; amount: number }>; allocationEventId: string }) => Promise<unknown>;
  /** Freie Buchung (Buchungssatz) with Beleg, text and reason; a line with a tax key is gross. */
  postManualJournalEntry?: (input: ManualJournalEntryInput) => Promise<JournalEntryEntity>;
  /** Booked bank lines against the ledger account of their bank account. */
  getBankLedgerReconciliation?: () => Promise<BankLedgerReconciliationRow[]>;
  listVendors?: () => Promise<VendorEntity[]>;
  upsertVendor?: (vendor: Omit<VendorEntity, 'tenantId' | 'createdAt' | 'updatedAt'>, reason: string) => Promise<VendorEntity>;
  listIncomingInvoices?: () => Promise<IncomingInvoiceEntity[]>;
  upsertIncomingInvoice?: (invoice: IncomingInvoiceEntity, reason: string) => Promise<IncomingInvoiceEntity>;
  listIncomingInvoiceDocuments?: (invoiceId?: string) => Promise<IncomingInvoiceDocumentEntity[]>;
  uploadIncomingInvoiceDocument?: (input: { invoiceId: string; originalFilename: string; mimeType: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp'; data: string; reason: string }) => Promise<IncomingInvoiceDocumentEntity>;
  downloadIncomingInvoiceDocument?: (documentId: string) => Promise<{ document: IncomingInvoiceDocumentEntity; data: string }>;
  reviewIncomingInvoiceDocument?: (input: { documentId: string; reviewStatus: 'accepted' | 'rejected'; reason: string }) => Promise<IncomingInvoiceDocumentEntity>;
  previewIncomingInvoiceAccounting?: (invoiceId: string) => Promise<AccountingPostingPreview>;
  postIncomingInvoiceAccounting?: (invoiceId: string, options: { reason: string; softLockOverride?: boolean; overrideReason?: string }) => Promise<AccountingPostingPreview>;
  findInvoiceMatches?: (transactionId: string) => Promise<InvoiceMatchCandidate[]>;
  listAccountSuggestionRules?: () => Promise<AccountSuggestionRuleSummary[]>;
}

export interface ManualJournalEntryInput {
  reason: string;
  documentDate: string;
  postingDate?: string;
  reference: string;
  bookingText: string;
  lines: Array<{ accountNumber: string; debitAmount: number; creditAmount: number; taxCaseKey?: 'DE_STD_19' | 'DE_STD_7' }>;
  idempotencyKey: string;
  softLockOverride?: boolean;
  overrideReason?: string;
}

export interface BankLedgerReconciliationRow {
  ledgerAccountNumber: string;
  bankAccountIds: string[];
  bookedBankTotal: number;
  pendingCount: number;
  pendingTotal: number;
  ledgerBalance: number;
  difference: number;
}

/** An open invoice the bank payment could settle, as the existing invoice matcher reports it. */
export interface InvoiceMatchCandidate {
  invoiceId: string;
  invoiceNumber: string;
  client: string;
  amount: number;
  dueDate: string;
  confidence: 'high' | 'medium' | 'low';
  matchReasons: string[];
  amountDiff: number;
}

/** An account suggestion rule with its derived hit statistics. */
export interface AccountSuggestionRuleSummary {
  id: string;
  field: 'counterparty' | 'purpose' | 'any';
  operator: 'contains' | 'equals' | 'startsWith';
  value: string;
  targetAccountNumber: string;
  active: boolean;
  createdAt: string;
  hitCount?: number;
  lastHitAt?: string;
}

export interface ReportSnapshotRecord {
  id: string;
  reportType: string;
  args: unknown;
  payload: unknown;
  createdAt: string;
  sourceHash: string;
}
