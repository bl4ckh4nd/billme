import { z } from 'zod';
import type {
  AccountSuggestionRule,
  BookingDraftEntity,
  DatevExportResult,
  DatevExportSourceSnapshot,
  DatevExportContent,
  JournalEntryEntity,
  LedgerAccount,
  LedgerAccountStats,
  LedgerBalance,
  ListLedgerAccountsArgs,
  ReportUnmappedAccount,
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
  AccountingMutationContext,
  IncomingInvoiceEntity,
  OpenItemEntity,
  OpenItemPaymentEntity,
  OpenItemPaymentInput,
  VendorEntity,
  TaxFilingAction,
  TaxFilingMutation,
  TaxFilingProviderResult,
  TaxFilingRecord,
} from '@billme/accounting-shared';

export type { AccountingMutationContext } from '@billme/accounting-shared';
export type { TaxFilingAction, TaxFilingMutation, TaxFilingProviderResult, TaxFilingRecord } from '@billme/accounting-shared';
import type {
  DunningEmailProvider,
  DunningHistoryEntry,
  DunningHistoryEntryDraft,
  DunningSettings,
} from '../domain/dunning.js';
import type {
  EmailOutboxClaimArgs,
  EmailOutboxEntry,
  EmailOutboxMarkFailedArgs,
  EmailOutboxMarkSentArgs,
  QueueEmailDeliveryInput,
} from '../domain/email-outbox.js';
import type {
  MaintenanceRetentionPolicy,
  MaintenanceSweepStep,
  SqliteImportRunRetentionStatus,
} from '../domain/maintenance.js';
import {
  entityIdSchema,
  isoDateTimeSchema,
  tenantScopeSchema,
  type Client,
  type Invoice,
  type Offer,
  type OfferDecision,
  type RecurringProfile,
  type Tenant,
  type TenantMembership,
  type TenantScope,
  type UserAccount,
} from '../domain/foundations.js';

export type MaybePromise<T> = T | Promise<T>;

export interface Clock {
  now(): Date;
  nowIso(): string;
}

export const systemClock: Clock = {
  now: () => new Date(),
  nowIso: () => new Date().toISOString(),
};

export const auditActorTypeSchema = z.enum(['system', 'user', 'service']);
export type AuditActorType = z.infer<typeof auditActorTypeSchema>;

export const auditActorSchema = z.object({
  type: auditActorTypeSchema,
  id: entityIdSchema.optional(),
  displayName: z.string().optional(),
});
export type AuditActor = z.infer<typeof auditActorSchema>;

export const auditSubjectSchema = z.object({
  entityType: z.string().trim().min(1),
  entityId: entityIdSchema,
  tenantId: entityIdSchema.optional(),
});
export type AuditSubject = z.infer<typeof auditSubjectSchema>;

export const auditChangeSchema = z.object({
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type AuditChange = z.infer<typeof auditChangeSchema>;

export const auditEntrySchema = z.object({
  sequence: z.number().int().positive().optional(),
  occurredAt: isoDateTimeSchema,
  action: z.string().trim().min(1),
  reason: z.string().optional(),
  actor: auditActorSchema,
  subject: auditSubjectSchema,
  change: auditChangeSchema.optional(),
  prevHash: z.string().nullable().optional(),
  hash: z.string().optional(),
});
export type AuditEntry = z.infer<typeof auditEntrySchema>;

export const auditEntryDraftSchema = auditEntrySchema.omit({
  sequence: true,
  hash: true,
});
export type AuditEntryDraft = z.infer<typeof auditEntryDraftSchema>;

export const transactionContextSchema = z.object({
  scope: tenantScopeSchema,
});
export type TransactionContext = z.infer<typeof transactionContextSchema>;

export interface AuditLogPort {
  append(scope: TenantScope, entry: AuditEntryDraft): MaybePromise<AuditEntry>;
  listBySubject(scope: TenantScope, subject: AuditSubject): MaybePromise<AuditEntry[]>;
}

export interface TenantRepository {
  getById(id: string): MaybePromise<Tenant | null>;
  getPrimary(): MaybePromise<Tenant | null>;
  save(tenant: Tenant): MaybePromise<Tenant>;
}

export interface UserAccountRepository {
  getById(scope: TenantScope, id: string): MaybePromise<UserAccount | null>;
  getByEmail(scope: TenantScope, email: string): MaybePromise<UserAccount | null>;
  list(scope: TenantScope): MaybePromise<UserAccount[]>;
  save(scope: TenantScope, user: UserAccount): MaybePromise<UserAccount>;
}

export interface TenantMembershipRepository {
  list(scope: TenantScope): MaybePromise<TenantMembership[]>;
  get(scope: TenantScope, userId: string): MaybePromise<TenantMembership | null>;
  save(scope: TenantScope, membership: TenantMembership): MaybePromise<TenantMembership>;
}

export interface ClientRepository {
  list(scope: TenantScope): MaybePromise<Client[]>;
  getById(scope: TenantScope, id: string): MaybePromise<Client | null>;
  save(scope: TenantScope, client: Client): MaybePromise<Client>;
  remove(scope: TenantScope, id: string): MaybePromise<void>;
}

export interface InvoiceRepository {
  list(scope: TenantScope): MaybePromise<Invoice[]>;
  getById(scope: TenantScope, id: string): MaybePromise<Invoice | null>;
  save(scope: TenantScope, invoice: Invoice): MaybePromise<Invoice>;
  remove(scope: TenantScope, id: string): MaybePromise<void>;
}

export interface OfferRepository {
  list(scope: TenantScope): MaybePromise<Offer[]>;
  getById(scope: TenantScope, id: string): MaybePromise<Offer | null>;
  save(scope: TenantScope, offer: Offer): MaybePromise<Offer>;
  remove(scope: TenantScope, id: string): MaybePromise<void>;
}

export interface OfferPortalDecisionStatus {
  decidedAt: string;
  decision: OfferDecision;
  acceptedName: string;
  acceptedEmail: string;
  decisionTextVersion: string;
  acceptedUserAgent?: string;
}

export interface OfferPortalStatus {
  decision?: OfferPortalDecisionStatus | null;
}

export interface PublishOfferToPortalInput {
  offer: Offer;
  expiresAt?: string;
}

export interface PublishOfferToPortalReceipt {
  token: string;
  publicUrl: string;
  publishedAt?: string;
}

export interface OfferPortalGateway {
  publishOffer(input: PublishOfferToPortalInput): MaybePromise<PublishOfferToPortalReceipt>;
  getOfferStatus(shareToken: string): MaybePromise<OfferPortalStatus>;
}

export interface RecurringProfileRepository {
  list(scope: TenantScope): MaybePromise<RecurringProfile[]>;
  getById(scope: TenantScope, id: string): MaybePromise<RecurringProfile | null>;
  save(scope: TenantScope, profile: RecurringProfile): MaybePromise<RecurringProfile>;
  remove(scope: TenantScope, id: string): MaybePromise<void>;
}

export interface DunningHistoryRepository {
  listByInvoice(scope: TenantScope, invoiceId: string): MaybePromise<DunningHistoryEntry[]>;
  record(scope: TenantScope, entry: DunningHistoryEntryDraft): MaybePromise<DunningHistoryEntry>;
}

export interface DunningSettingsRepository<TSettings extends DunningSettings = DunningSettings> {
  get(scope: TenantScope): MaybePromise<TSettings | null>;
  save(scope: TenantScope, settings: TSettings): MaybePromise<void>;
}

export interface DunningEmailMessage {
  from: {
    name: string;
    email: string;
  };
  to: {
    name: string;
    email: string;
  };
  subject: string;
  text: string;
}

export interface DunningSmtpProviderConfig {
  host: string;
  port: number;
  secure: boolean;
  auth: {
    user: string;
    pass: string;
  };
}

export interface DunningResendProviderConfig {
  apiKey: string;
}

export type DunningEmailProviderConfig = DunningSmtpProviderConfig | DunningResendProviderConfig;

export interface DunningEmailDeliveryResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface DunningEmailLogEntry {
  id: string;
  documentType: 'invoice';
  documentId: string;
  documentNumber: string;
  recipientEmail: string;
  recipientName: string;
  subject: string;
  bodyText: string;
  provider: Exclude<DunningEmailProvider, 'none'>;
  status: 'sent' | 'failed';
  errorMessage?: string;
  sentAt: string;
  createdAt: string;
}

export type DunningEmailLogDraft = Omit<DunningEmailLogEntry, 'id' | 'createdAt'>;

export interface DunningEmailPort {
  send(
    provider: Exclude<DunningEmailProvider, 'none'>,
    providerConfig: DunningEmailProviderConfig,
    message: DunningEmailMessage,
  ): Promise<DunningEmailDeliveryResult>;
  log(scope: TenantScope, entry: DunningEmailLogDraft): MaybePromise<DunningEmailLogEntry>;
}

export interface DunningSecretPort {
  get(key: 'smtp.password' | 'resend.apiKey'): Promise<string | null>;
}

export interface EmailOutboxRepository {
  enqueue(scope: TenantScope, entry: QueueEmailDeliveryInput): MaybePromise<EmailOutboxEntry>;
  claimDue(scope: TenantScope, args: EmailOutboxClaimArgs): MaybePromise<EmailOutboxEntry[]>;
  markSent(scope: TenantScope, args: EmailOutboxMarkSentArgs): MaybePromise<EmailOutboxEntry | null>;
  markFailed(scope: TenantScope, args: EmailOutboxMarkFailedArgs): MaybePromise<EmailOutboxEntry | null>;
}

export interface MaintenanceRetentionRepository {
  deleteReleasedNumberReservations(
    scope: TenantScope,
    args: { updatedBefore: string },
  ): MaybePromise<number>;
  deleteSqliteImportRuns(
    scope: TenantScope,
    args: { completedBefore: string; statuses: SqliteImportRunRetentionStatus[] },
  ): MaybePromise<number>;
}

export interface MaintenanceSweepResult {
  startedAt: string;
  finishedAt: string;
  totalDeleted: number;
  policies: MaintenanceRetentionPolicy[];
  steps: MaintenanceSweepStep[];
}

export interface BillingRepositories {
  tenantRepo: TenantRepository;
  userRepo: UserAccountRepository;
  membershipRepo: TenantMembershipRepository;
  clientRepo: ClientRepository;
  invoiceRepo: InvoiceRepository;
  offerRepo: OfferRepository;
  recurringProfileRepo: RecurringProfileRepository;
  dunningHistoryRepo: DunningHistoryRepository;
  emailOutboxRepo: EmailOutboxRepository;
  auditLog: AuditLogPort;
}

export interface BillingUnitOfWorkContext<TRepositories extends Partial<BillingRepositories> = BillingRepositories> {
  scope: TenantScope;
  clock: Clock;
  repositories: TRepositories;
}

export interface BillingUnitOfWork<TRepositories extends Partial<BillingRepositories> = BillingRepositories> {
  withTransaction<TResult>(
    scope: TenantScope,
    work: (context: BillingUnitOfWorkContext<TRepositories>) => MaybePromise<TResult>,
  ): MaybePromise<TResult>;
}

export interface ProDraftActionRequest {
  transactionId: string;
  action: 'save_draft' | 'submit_for_review' | 'approve' | 'reject' | 'post' | 'reverse' | 'create_correction' | 'request_receipt';
  rejectReason?: string;
  mutation?: AccountingMutationContext;
}

export interface PostDraftOptions {
  postingDate?: string;
  idempotencyKey?: string;
  softLockOverride?: boolean;
  overrideReason?: string;
  mutation?: AccountingMutationContext;
}

export interface ReverseJournalEntryOptions {
  postingDate?: string;
  softLockOverride?: boolean;
  overrideReason?: string;
  mutation?: AccountingMutationContext;
}

export interface ListJournalEntriesOptions {
  from?: string;
  to?: string;
  accountNumbers?: string[];
  limit?: number;
  offset?: number;
}

export interface LedgerBalanceOptions {
  asOfDate?: string;
  from?: string;
  to?: string;
  /** Optional first day of the turnover range; opening is everything before it. */
  fromDate?: string;
}

export interface ReportRangeOptions {
  from?: string;
  to?: string;
}

export interface SusaReport {
  from?: string;
  to?: string;
  chart?: 'SKR03' | 'SKR04';
  asOfDate: string;
  rows: Array<LedgerBalance & { mappedTo?: string; hasWarnings?: boolean }>;
  totals: {
    debit: number;
    credit: number;
    balance: number;
  };
  unmappedAccounts?: ReportUnmappedAccount[];
  blocking?: boolean;
}

export interface GuvReport {
  from?: string;
  to?: string;
  rows: Array<{
    positionKey: string;
    positionLabel: string;
    amount: number;
    accountRefs?: string[];
  }>;
  chart?: 'SKR03' | 'SKR04';
  netResult: number;
  unmappedAccounts?: ReportUnmappedAccount[];
  blocking?: boolean;
}

export interface BilanzReport {
  chart?: 'SKR03' | 'SKR04';
  asOfDate: string;
  assets: Array<{
    accountNumber: string;
    amount: number;
  }>;
  liabilities: Array<{
    accountNumber: string;
    amount: number;
  }>;
  totals: {
    assets: number;
    liabilities: number;
    delta: number;
  };
  unmappedAccounts?: ReportUnmappedAccount[];
  blocking?: boolean;
}

export interface AccountingHealthSnapshot {
  draftCount: number;
  postedCount: number;
  reversedCount: number;
  unbalancedDraftCount: number;
  unmappedAccountCount: number;
  unmappedAccounts?: string[];
  blocking?: boolean;
  lastDatevExportAt?: string;
}

export interface VatSummary {
  from?: string;
  to?: string;
  rows: Array<{
    taxCaseKey: TaxCaseKey;
    netAmount: number;
    taxAmount: number;
    grossAmount: number;
    lineCount: number;
  }>;
}

export interface DatevPostingRow {
  date: string;
  belegfeld1: string;
  buchungstext: string;
  konto: string;
  gegenkonto: string;
  sollHabenKennzeichen: 'S' | 'H';
  buSchluessel?: string;
  euLandUstId?: string;
  euSteuersatz?: number;
  sachverhaltLl?: string;
  umsatz: number;
}

export interface ProAccountingRepository {
  listBankTransactions(scope: TenantScope): Promise<ProBankTransaction[]>;
  getDraftByTransactionId(scope: TenantScope, transactionId: string): Promise<BookingDraftEntity | null>;
  saveDraft(scope: TenantScope, draft: BookingDraftEntity & { mutation?: AccountingMutationContext }): Promise<BookingDraftEntity>;
  dispatchDraftAction(scope: TenantScope, args: ProDraftActionRequest): Promise<BookingDraftEntity>;
  validateTaxCompliance(
    scope: TenantScope,
    args: { draftId?: string; transactionId?: string; mutation?: AccountingMutationContext },
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
  getDatevExportContent?(scope: TenantScope, exportId: string): Promise<DatevExportContent>;
  insertDatevExport(
    scope: TenantScope,
    args: {
      id?: string;
      filePath: string;
      recordCount: number;
      fromDate?: string;
      toDate?: string;
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
      content?: Uint8Array;
      contentSha256?: string;
      sourceSnapshot?: DatevExportSourceSnapshot;
      mutation?: AccountingMutationContext;
    },
  ): Promise<DatevExportResult>;
  getAccountingHealth(scope: TenantScope): Promise<AccountingHealthSnapshot>;
  getVatSummary(scope: TenantScope, args?: ReportRangeOptions): Promise<VatSummary>;
  buildDatevRows(scope: TenantScope, args?: ReportRangeOptions): Promise<DatevPostingRow[]>;
  getAccountingPolicy(scope: TenantScope): Promise<{ tenantId: string; activeChart: 'SKR03' | 'SKR04'; vatMethod: 'soll' | 'ist'; periodPolicy: 'calendar_month'; updatedAt: string }>;
  setAccountingPolicy(scope: TenantScope, input: { activeChart: 'SKR03' | 'SKR04'; vatMethod: 'soll' | 'ist'; mutation?: AccountingMutationContext }): Promise<{ tenantId: string; activeChart: 'SKR03' | 'SKR04'; vatMethod: 'soll' | 'ist'; periodPolicy: 'calendar_month'; updatedAt: string }>;
  listAccountingAccountMappings(scope: TenantScope, chart?: 'SKR03' | 'SKR04'): Promise<AccountingAccountMapping[]>;
  upsertAccountingAccountMapping(scope: TenantScope, input: { id?: string; chart: 'SKR03' | 'SKR04'; role: AccountingAccountMapping['role']; accountNumber: string; mutation?: AccountingMutationContext }): Promise<AccountingAccountMapping>;
  listVendors(scope: TenantScope): Promise<VendorEntity[]>;
  upsertVendor(scope: TenantScope, input: Omit<VendorEntity, 'tenantId' | 'createdAt' | 'updatedAt'> & { mutation?: AccountingMutationContext }): Promise<VendorEntity>;
  listIncomingInvoices(scope: TenantScope): Promise<IncomingInvoiceEntity[]>;
  upsertIncomingInvoice(scope: TenantScope, input: IncomingInvoiceEntity & { mutation?: AccountingMutationContext }): Promise<IncomingInvoiceEntity>;
  previewOutgoingInvoice(scope: TenantScope, invoiceId: string): Promise<AccountingPostingPreview>;
  postOutgoingInvoice(scope: TenantScope, invoiceId: string, options?: { softLockOverride?: boolean; overrideReason?: string; reservationId?: string; mutation?: AccountingMutationContext }): Promise<AccountingPostingPreview>;
  previewIncomingInvoice(scope: TenantScope, invoiceId: string): Promise<AccountingPostingPreview>;
  postIncomingInvoice(scope: TenantScope, invoiceId: string, options?: { softLockOverride?: boolean; overrideReason?: string; mutation?: AccountingMutationContext }): Promise<AccountingPostingPreview>;
  listOpenItems(scope: TenantScope): Promise<OpenItemEntity[]>;
  allocateOpenItemPayment(scope: TenantScope, input: OpenItemPaymentInput): Promise<OpenItemPaymentEntity>;
  allocateRemainingOpenItemPayment(scope: TenantScope, paymentId: string, allocations: Array<{ openItemId: string; amount: number }>, allocationEventId: string, mutation?: AccountingMutationContext): Promise<OpenItemPaymentEntity>;
  reverseDocumentAccounting(scope: TenantScope, input: { documentType: 'outgoing_invoice' | 'incoming_invoice'; documentId: string; reason: string; postingDate?: string; softLockOverride?: boolean; overrideReason?: string; mutation?: AccountingMutationContext }): Promise<{ ok: true; reversalEntryId: string }>;
  previewAccountingBackfill(scope: TenantScope): Promise<AccountingBackfillPreview>;
  confirmAccountingBackfill(scope: TenantScope, input: AccountingBackfillConfirmation): Promise<AccountingBackfillResult>;
  ensureSeedData(scope: TenantScope): Promise<void>;
}

export type AssetStatus = 'entwurf' | 'aktiv' | 'voll_abgeschrieben' | 'verkauft' | 'stillgelegt';
export type DepreciationMethod = 'linear' | 'gwg' | 'pool';

export interface AssetItem {
  id: string;
  assetNumber: string;
  name: string;
  assetClass: string;
  status: AssetStatus;
  activationDate: string;
  acquisitionCost: number;
  residualValue: number;
  annualDepreciation: number;
  usefulLifeYears?: number;
  depreciationMethod: DepreciationMethod;
  costCenter: string;
  location: string;
  nextDepreciation: string;
  receiptLinked: boolean;
  supplier?: string;
  invoiceRef?: string;
  assetAccountNumber: string;
  acquisitionOffsetAccountNumber?: string;
  sourceIncomingInvoiceId?: string;
  activationJournalEntryId?: string;
  accountingRepairRequired?: boolean;
  accountingRepairReason?: string;
  disposalDate?: string;
  disposalProceeds?: number;
}

export type AssetUpsertInput = Omit<AssetItem, 'id' | 'residualValue' | 'annualDepreciation' | 'nextDepreciation' | 'disposalDate' | 'disposalProceeds' | 'accountingRepairRequired' | 'accountingRepairReason'> & {
  id?: string;
  softLockOverride?: boolean;
  overrideReason?: string;
};

export interface AssetDepreciationScheduleEntry {
  id: string;
  assetId: string;
  year: number;
  amount: number;
  months: number;
  status: 'planned' | 'posted' | 'cancelled';
  journalEntryId?: string;
  sourceType?: string;
  sourceKey?: string;
  postedAt?: string;
}

export interface AssetMutationOptions {
  softLockOverride?: boolean;
  overrideReason?: string;
  mutation?: AccountingMutationContext;
}

export interface AssetDepreciationInput extends AssetMutationOptions {
  assetId: string;
  year: number;
  postingDate: string;
  reason: string;
}

export interface AssetDepreciationResult {
  asset: AssetItem;
  scheduleEntry: AssetDepreciationScheduleEntry;
  journalEntryId: string;
}

export interface AssetDisposalInput extends AssetMutationOptions {
  assetId: string;
  disposalDate: string;
  proceeds: number;
  taxRate?: 0 | 7 | 19;
  proceedsAccountNumber?: string;
  reason: string;
}

export interface AssetDisposalResult {
  asset: AssetItem;
  residualBookValue: number;
  gainLoss: number;
  journalEntryId: string;
}

/**
 * Fixed-asset persistence is intentionally a separate capability from the
 * general Pro accounting repository.  Desktop Pro has its own local asset
 * store, while server mode composes this capability onto the Postgres ledger
 * repository.  Keeping the port separate prevents the server-only asset
 * methods from leaking into the desktop repository contract.
 */
export interface ProAccountingAssetRepository {
  listAssets(scope: TenantScope): Promise<AssetItem[]>;
  upsertAsset(scope: TenantScope, input: AssetUpsertInput, reason: string, options?: AssetMutationOptions): Promise<AssetItem>;
  getDepreciationSchedule(scope: TenantScope, assetId: string): Promise<AssetDepreciationScheduleEntry[]>;
  runDepreciation(scope: TenantScope, input: AssetDepreciationInput): Promise<AssetDepreciationResult>;
  disposeAsset(scope: TenantScope, input: AssetDisposalInput): Promise<AssetDisposalResult>;
}

/** Tenant-scoped persistence for immutable, auditable tax filing snapshots. */
export interface TaxFilingRepository {
  list(scope: TenantScope): MaybePromise<TaxFilingRecord[]>;
  getById(scope: TenantScope, id: string): MaybePromise<TaxFilingRecord | null>;
  getByIdempotencyKey(scope: TenantScope, idempotencyKey: string): MaybePromise<TaxFilingRecord | null>;
  create(scope: TenantScope, record: TaxFilingRecord): MaybePromise<TaxFilingRecord>;
  update(scope: TenantScope, record: TaxFilingRecord, expectedStatus?: TaxFilingRecord['status']): MaybePromise<TaxFilingRecord>;
  enqueueSubmissionJob?(scope: TenantScope, filingId: string, idempotencyKey: string): MaybePromise<void>;
  recordProviderResult?(scope: TenantScope, input: {
    id: string;
    result: TaxFilingProviderResult;
    actorId: string;
    reason: string;
    idempotencyKey: string;
    now?: string;
  }): MaybePromise<TaxFilingRecord>;
}

export interface TaxFilingStateMachinePort {
  create(input: {
    id: string;
    tenantId: string;
    provider: TaxFilingRecord['provider'];
    snapshot: TaxFilingRecord['snapshot'];
    idempotencyKey: string;
    actorId: string;
    now: string;
  }): TaxFilingRecord;
  transition(record: TaxFilingRecord, action: TaxFilingAction, mutation: TaxFilingMutation): {
    record: TaxFilingRecord;
    replayed: boolean;
  };
}

export interface ProWorkflowRepository {
  list(scope: TenantScope): Promise<ProWorkflowEntry[]>;
  upsert(
    scope: TenantScope,
    args: { transactionId: string; transactionJson: string; draftJson: string },
  ): Promise<{ ok: true }>;
}

export interface ProAccountingCatalogRepository {
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
      mutation?: AccountingMutationContext;
    },
  ): Promise<TaxCaseAccountMapping>;
  listAccountSuggestionRules(
    scope: TenantScope,
    args?: { chart?: LedgerAccount['chart']; activeOnly?: boolean },
  ): Promise<AccountSuggestionRule[]>;
  upsertAccountSuggestionRule(
    scope: TenantScope,
    input: UpsertAccountSuggestionRuleInput & { mutation?: AccountingMutationContext },
  ): Promise<AccountSuggestionRule>;
  deleteAccountSuggestionRule(scope: TenantScope, id: string, mutation?: AccountingMutationContext): Promise<void>;
}

export interface TransactionPort {
  inTransaction<TResult>(work: () => MaybePromise<TResult>): MaybePromise<TResult>;
}

export interface SyncTransactionPort extends TransactionPort {
  inTransaction<TResult>(work: () => TResult): TResult;
}

export type DocumentNumberKind = 'invoice' | 'offer' | 'customer';
export type DocumentNumberReservationStatus = 'reserved' | 'released' | 'finalized';

export interface NumberingSettingsShape {
  numbers: {
    invoicePrefix: string;
    nextInvoiceNumber: number;
    numberLength: number;
    offerPrefix: string;
    nextOfferNumber: number;
    customerPrefix: string;
    nextCustomerNumber: number;
    customerNumberLength: number;
  };
}

export interface DocumentNumberReservation {
  id: string;
  kind: DocumentNumberKind;
  number: string;
  counterValue: number;
  status: DocumentNumberReservationStatus;
  documentId: string | null;
}

export interface DocumentNumberingPorts<TSettings extends NumberingSettingsShape = NumberingSettingsShape> {
  tx: TransactionPort;
  getSettings(): MaybePromise<TSettings | null>;
  saveSettings(settings: TSettings): MaybePromise<void>;
  createReservation(reservation: DocumentNumberReservation): MaybePromise<void>;
  getReservationById(reservationId: string): MaybePromise<DocumentNumberReservation | null>;
  updateReservation(reservation: DocumentNumberReservation): MaybePromise<void>;
  isNumberTaken(kind: DocumentNumberKind, number: string): MaybePromise<boolean>;
  generateReservationId(): MaybePromise<string>;
}

export interface SyncDocumentNumberingPorts<TSettings extends NumberingSettingsShape = NumberingSettingsShape>
  extends DocumentNumberingPorts<TSettings> {
  tx: SyncTransactionPort;
  getSettings(): TSettings | null;
  saveSettings(settings: TSettings): void;
  createReservation(reservation: DocumentNumberReservation): void;
  getReservationById(reservationId: string): DocumentNumberReservation | null;
  updateReservation(reservation: DocumentNumberReservation): void;
  isNumberTaken(kind: DocumentNumberKind, number: string): boolean;
  generateReservationId(): string;
}

export interface ClientProjectShape {
  id: string;
  clientId: string;
  code?: string;
  name: string;
  status: string;
  budget: number;
  startDate: string;
  endDate?: string;
  description?: string;
  archivedAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DefaultProjectPorts<TProject extends ClientProjectShape = ClientProjectShape> {
  tx: TransactionPort;
  getActiveDefaultProjectForClient(clientId: string): MaybePromise<TProject | null>;
  listProjectCodesByPrefix(prefix: string): MaybePromise<Array<string | null | undefined>>;
  saveProject(project: TProject): MaybePromise<TProject>;
}

export interface SyncDefaultProjectPorts<TProject extends ClientProjectShape = ClientProjectShape>
  extends DefaultProjectPorts<TProject> {
  tx: SyncTransactionPort;
  getActiveDefaultProjectForClient(clientId: string): TProject | null;
  listProjectCodesByPrefix(prefix: string): Array<string | null | undefined>;
  saveProject(project: TProject): TProject;
}

export interface RecurringNumberingSettingsShape extends NumberingSettingsShape {
  legal: {
    smallBusinessRule: boolean;
    defaultVatRate: number;
    paymentTermsDays: number;
  };
}

export interface RecurringNumberingPort<
  TSettings extends RecurringNumberingSettingsShape = RecurringNumberingSettingsShape,
> {
  getSettings(): MaybePromise<TSettings | null>;
  reserve(kind: DocumentNumberKind, now?: Date): MaybePromise<{ reservationId: string; number: string }>;
  release(reservationId: string): MaybePromise<{ ok: true }>;
  finalize(reservationId: string, documentId: string): MaybePromise<{ ok: true }>;
}

export interface SyncRecurringNumberingPort<
  TSettings extends RecurringNumberingSettingsShape = RecurringNumberingSettingsShape,
> extends RecurringNumberingPort<TSettings> {
  getSettings(): TSettings | null;
  reserve(kind: DocumentNumberKind, now?: Date): { reservationId: string; number: string };
  release(reservationId: string): { ok: true };
  finalize(reservationId: string, documentId: string): { ok: true };
}

export interface RecurringProjectPort<TProject extends ClientProjectShape = ClientProjectShape> {
  ensureDefaultProject(clientId: string): MaybePromise<TProject>;
}

export interface SyncRecurringProjectPort<TProject extends ClientProjectShape = ClientProjectShape>
  extends RecurringProjectPort<TProject> {
  ensureDefaultProject(clientId: string): TProject;
}

export interface RecurringClientPort {
  getById(scope: TenantScope, id: string): MaybePromise<Client | null>;
}

export interface SyncRecurringClientPort extends RecurringClientPort {
  getById(scope: TenantScope, id: string): Client | null;
}

export interface RecurringInvoicePort {
  save(scope: TenantScope, params: { invoice: Invoice; reason: string }): MaybePromise<Invoice>;
}

export interface SyncRecurringInvoicePort extends RecurringInvoicePort {
  save(scope: TenantScope, params: { invoice: Invoice; reason: string }): Invoice;
}

export interface RecurringProfileStore {
  list(scope: TenantScope): MaybePromise<RecurringProfile[]>;
  getById(scope: TenantScope, id: string): MaybePromise<RecurringProfile | null>;
  save(scope: TenantScope, profile: RecurringProfile): MaybePromise<RecurringProfile>;
  remove(scope: TenantScope, id: string): MaybePromise<void>;
}

export interface SyncRecurringProfileStore extends RecurringProfileStore {
  list(scope: TenantScope): RecurringProfile[];
  getById(scope: TenantScope, id: string): RecurringProfile | null;
  save(scope: TenantScope, profile: RecurringProfile): RecurringProfile;
  remove(scope: TenantScope, id: string): void;
}
