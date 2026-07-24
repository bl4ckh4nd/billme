import { z } from 'zod';
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
}

export interface PostDraftOptions {
  postingDate?: string;
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
}

export interface ReportRangeOptions {
  from?: string;
  to?: string;
}

export interface SusaReport {
  asOfDate: string;
  rows: LedgerBalance[];
  totals: {
    debit: number;
    credit: number;
    balance: number;
  };
}

export interface GuvReport {
  from?: string;
  to?: string;
  rows: Array<{
    positionKey: string;
    positionLabel: string;
    amount: number;
  }>;
  netResult: number;
}

export interface BilanzReport {
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
}

export interface AccountingHealthSnapshot {
  draftCount: number;
  postedCount: number;
  reversedCount: number;
  unbalancedDraftCount: number;
  unmappedAccountCount: number;
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
  umsatz: number;
}

export interface ProAccountingRepository {
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
  getVatSummary(scope: TenantScope, args?: ReportRangeOptions): Promise<VatSummary>;
  buildDatevRows(scope: TenantScope, args?: ReportRangeOptions): Promise<DatevPostingRow[]>;
  ensureSeedData(scope: TenantScope): Promise<void>;
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
