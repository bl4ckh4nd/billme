import type { Account, AccountingActorRole, BookingAction, BookingDraft, LinkedInvoiceSummary, OpenRouterVlmConfig, Transaction, TransactionDocumentAnalysis, UserRole } from '../types';
import type { BalanceSheetPreview, EurCashItem, EurCashClassification, GuvReport, ReportDrilldownEntry, ReportDrilldownSelection, ReportExportRequest, ReportExportResult, ReportFilterState, SusaReport } from '../domain/reportTypes';
import type { ReportMappingHealth, ReportMappingPosition, ReportMappingOverrideInput } from '../domain/reportMapping';
import type { AssetDepreciationScheduleEntry, AssetItem, AssetRegister, AssetUpsertInput } from '../domain/assetTypes';
import type { AccountingPostingPreview, IncomingInvoiceDocumentEntity, IncomingInvoiceEntity, OpenItemEntity, OpenItemPaymentEntity, OpenItemPaymentInput, VendorEntity } from '@billme/accounting-shared';
import type { ProBankTransaction } from '@billme/accounting-shared';
import type { AccountingCommandInput, AccountingSourcePostResult, AccountingSourceRun, EurAnnexFact, EurAnnexFactInput, EurCashFact, EurCashFactInput, TaxPreparationArtifact, TaxPreparationInput } from '../sourceRuns';
import type { JournalEntryEntity, UstvaComputation } from '@billme/accounting-shared';

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

export interface BankTransactionDocument {
  id: string;
  bankTransactionId: string;
  originalFilename: string;
  mimeType: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';
  byteLength: number;
  sha256: string;
  createdAt: string;
}

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
  reverseJournalEntry?: (input: { entryId: string; reason: string; postingDate?: string; softLockOverride?: boolean; overrideReason?: string }) => Promise<unknown>;
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
  getAssetRegister?: (year: number) => Promise<AssetRegister>;
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
    /** A sale to this customer: a draft outgoing invoice „Verkauf Anlage …“ books the proceeds, the disposal only the book value. */
    saleCustomerId?: string;
    reason: string;
    actorRole: AccountingActorRole;
  }) => Promise<{ asset: AssetItem; residualBookValue: number; gainLoss: number; journalEntryId?: string; saleInvoiceNumber?: string }>;
  /** Customers a fixed asset can be sold to. */
  listCustomers?: () => Promise<Array<{ id: string; name: string }>>;
  exportDatevBuchungsstapel?: (args: {
    from: string;
    to: string;
    consultantNumber: string;
    clientNumber: string;
    fiscalYearStart: string;
    accountLength: number;
    encoding: 'cp1252' | 'utf8-bom';
    kind?: 'journal' | 'opening_balances' | 'parties';
  }) => Promise<DatevExportResult>;
  listDatevExports?: (limit?: number) => Promise<DatevExportResult[]>;
  /** Prüferpaket (GoBD Z3): journal, Kontenplan, master data, receipts, OPOS, assets and mappings of the range. */
  exportAuditPackage?: (args: { from: string; to: string; includeDocuments: boolean }) => Promise<{ bundleDir: string; fileCount: number }>;
  /** Draft Verfahrensdokumentation (GoBD Rz. 151 ff.) as Markdown, filled from settings and books. */
  exportProcedureDocumentation?: () => Promise<{ fileName: string }>;
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
  /** DATEV Buchungsstapel or journal CSV of another bookkeeping: dryRun checks, otherwise the whole file is booked or nothing. */
  importJournal?: (input: JournalImportInput) => Promise<JournalImportResult>;
  /** UStVA per month or quarter from the journal, with Frist and status, and the largest tax lines. */
  getVatAnalytics?: (range: { from: string; to: string; granularity: 'month' | 'quarter' }) => Promise<VatAnalytics>;
  /** Payments to and from the tax offices per topic. */
  getTaxPayments?: (range: { from: string; to: string }) => Promise<TaxPayments>;
  /** One money account (Bank, Kasse, Kreditkarte) over a year; without arguments the first account, its last year. */
  getMoneyAccountYear?: (input: { accountNumber?: string; year?: number }) => Promise<MoneyAccountYear>;
  /** Checks on the journal (Prüfungen); without a range over the whole journal. */
  getLedgerChecks?: (range: { from?: string; to?: string }) => Promise<LedgerChecks>;
  /** Marks a finding as OK with a reason, or opens it again. */
  setLedgerCheckDismissal?: (input: { checkKey: LedgerCheckKey; subjectKey: string; dismissed: boolean; reason: string }) => Promise<{ dismissed: boolean }>;
  /** Business partners behind the money movements of the journal. */
  getLedgerPartners?: (range: { from?: string; to?: string }) => Promise<LedgerPartners>;
  getLedgerPartnerDetail?: (input: { name: string; from?: string; to?: string }) => Promise<LedgerPartnerDetail>;
  /** Booked bank lines against the ledger account of their bank account. */
  getBankLedgerReconciliation?: () => Promise<BankLedgerReconciliationRow[]>;
  /** VAT per tax case plus the UStVA Kennzahlen of a range, live from the ledger (no lock). */
  getVatSummary?: (range: { from: string; to: string }) => Promise<{ kennzahlen?: UstvaComputation }>;
  listVendors?: () => Promise<VendorEntity[]>;
  upsertVendor?: (vendor: Omit<VendorEntity, 'tenantId' | 'createdAt' | 'updatedAt'>, reason: string) => Promise<VendorEntity>;
  listIncomingInvoices?: () => Promise<IncomingInvoiceEntity[]>;
  upsertIncomingInvoice?: (invoice: IncomingInvoiceEntity, reason: string) => Promise<IncomingInvoiceEntity>;
  listIncomingInvoiceDocuments?: (invoiceId?: string) => Promise<IncomingInvoiceDocumentEntity[]>;
  /** Belege archived on a bank line (the booking draft's evidence). */
  listBankTransactionDocuments?: (transactionId: string) => Promise<BankTransactionDocument[]>;
  uploadBankTransactionDocument?: (input: { transactionId: string; originalFilename: string; mimeType: BankTransactionDocument['mimeType']; data: string; reason: string }) => Promise<BankTransactionDocument>;
  downloadBankTransactionDocument?: (documentId: string) => Promise<{ document: BankTransactionDocument; data: string }>;
  uploadIncomingInvoiceDocument?: (input: { invoiceId: string; originalFilename: string; mimeType: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp'; data: string; reason: string }) => Promise<IncomingInvoiceDocumentEntity>;
  downloadIncomingInvoiceDocument?: (documentId: string) => Promise<{ document: IncomingInvoiceDocumentEntity; data: string }>;
  reviewIncomingInvoiceDocument?: (input: { documentId: string; reviewStatus: 'accepted' | 'rejected'; reason: string }) => Promise<IncomingInvoiceDocumentEntity>;
  previewIncomingInvoiceAccounting?: (invoiceId: string) => Promise<AccountingPostingPreview>;
  postIncomingInvoiceAccounting?: (invoiceId: string, options: { reason: string; softLockOverride?: boolean; overrideReason?: string }) => Promise<AccountingPostingPreview>;
  findInvoiceMatches?: (transactionId: string) => Promise<InvoiceMatchCandidate[]>;
  listAccountSuggestionRules?: () => Promise<AccountSuggestionRuleSummary[]>;
  getTransitOverview?: () => Promise<TransitOverview>;
}

/** Geldtransit balance per month; a balance left over means one side of a transfer is not booked yet. */
export interface TransitOverview {
  transitAccountNumber: string;
  months: Array<{ period: string; debit: number; credit: number; balance: number; cumulative: number }>;
  openBalance: number;
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

export interface VatAnalytics {
  from: string;
  to: string;
  granularity: 'month' | 'quarter';
  permanentExtension: boolean;
  periods: Array<{ key: string; from: string; to: string; outputTax: number; inputTax: number; payable: number; lineCount: number; deadline: string; preparedAt?: string; status: 'prepared' | 'due' | 'open' | 'past' }>;
  totals: { outputTax: number; inputTax: number; payable: number };
  topLines: Array<{ entryId?: string; entryNumber?: number; postingDate: string; reference?: string; kennziffer: string; direction: string; taxCaseKey: string; netAmount: number; taxAmount: number }>;
}

export interface TaxPayments {
  from: string;
  to: string;
  topics: Array<{
    key: 'vat' | 'wage' | 'income' | 'other';
    label: string;
    accounts: Array<{ accountNumber: string; name?: string }>;
    paid: number;
    refunded: number;
    net: number;
    months: Array<{ period: string; paid: number; refunded: number }>;
    entries: Array<{ entryId: string; entryNumber: number; postingDate: string; reference?: string; bookingText: string; accountNumber: string; amount: number }>;
  }>;
}

export type LedgerCheckKey = 'vat_without_case' | 'private_on_corporation' | 'foreign_vat' | 'revenue_without_vat' | 'refund_as_revenue' | 'duplicate' | 'transit_open' | 'unmapped_account';

export interface LedgerChecks {
  from?: string;
  to?: string;
  openErrors: number;
  openWarnings: number;
  openInfos: number;
  checks: Array<{
    key: LedgerCheckKey;
    label: string;
    description: string;
    severity: 'error' | 'warning' | 'info';
    openCount: number;
    dismissedCount: number;
    findings: Array<{
      subjectKey: string; entryId?: string; entryNumber?: number; postingDate?: string; reference?: string; bookingText?: string;
      accountNumber?: string; amount?: number; detail: string; dismissed?: { reason: string; at: string; by?: string };
    }>;
  }>;
}

export interface LedgerPartners {
  from?: string;
  to?: string;
  partners: Array<{ name: string; income: number; expense: number; net: number; count: number; firstDate: string; lastDate: string; topAccount?: string }>;
}

export interface LedgerPartnerDetail {
  name: string;
  income: number;
  expense: number;
  net: number;
  count: number;
  months: Array<{ period: string; income: number; expense: number }>;
  entries: Array<{ entryId: string; entryNumber: number; postingDate: string; reference?: string; bookingText: string; amount: number }>;
}

export interface MoneyAccountYear {
  chart: 'SKR03' | 'SKR04';
  accounts: Array<{ accountNumber: string; name?: string; firstYear: number; lastYear: number }>;
  accountNumber: string;
  name?: string;
  year: number;
  openingBalance: number;
  closingBalance: number;
  inflow: number;
  outflow: number;
  entryCount: number;
  months: Array<{ period: string; inflow: number; outflow: number; balance: number }>;
  counterAccounts: Array<{ accountNumber: string; name?: string; position?: string; inflow: number; outflow: number; count: number }>;
  topInflows: Array<{ label: string; amount: number; count: number }>;
  topOutflows: Array<{ label: string; amount: number; count: number }>;
}

export interface JournalImportInput {
  reason: string;
  format: 'datev' | 'journal_csv';
  fileName?: string;
  contentBase64: string;
  dryRun: boolean;
  softLockOverride?: boolean;
  overrideReason?: string;
}

export interface JournalImportResult {
  format: 'datev' | 'journal_csv';
  fileName?: string;
  fileSha256: string;
  dryRun: boolean;
  posted: boolean;
  source: { chart?: 'SKR03' | 'SKR04'; from?: string; to?: string; label?: string; accountLength?: number; consultantNumber?: string; clientNumber?: string };
  entryCount: number;
  newCount: number;
  importedCount: number;
  invalidCount: number;
  postedCount: number;
  debitTotal: number;
  firstDate?: string;
  lastDate?: string;
  missingAccounts: string[];
  issues: Array<{ row: number; message: string; blocking: boolean }>;
  entries: Array<{
    key: string;
    rows: number[];
    postingDate: string;
    reference: string;
    bookingText: string;
    status: 'new' | 'imported' | 'invalid';
    lines: Array<{ accountNumber: string; accountName?: string; debitAmount: number; creditAmount: number; taxCaseKey?: string; taxAmount?: number; memo?: string }>;
  }>;
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
  name?: string;
  stage?: 'base' | 'override';
  actions?: { accountNumber?: string; taxCaseKey?: string };
}

export interface ReportSnapshotRecord {
  id: string;
  reportType: string;
  args: unknown;
  payload: unknown;
  createdAt: string;
  sourceHash: string;
}
