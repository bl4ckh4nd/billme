import { defaultBookingPolicy, reviewRequiredForDraft } from '../domain/policies';
import { normalizeTaxCaseKey, toLegacyTaxCode } from '../domain/taxCases';
import { summarizeIssues, validateBookingDraft } from '../domain/validation';
import { canTransition, transitionBooking } from '../domain/workflow';
import { mockAccounts } from '../mocks/accounts';
import { mockBookingDrafts } from '../mocks/bookings';
import { mockTransactions } from '../mocks/transactions';
import { permissionContextForRole } from '../mocks/users';
import { Account, AccountingActorRole, BookingAction, BookingDraft, LinkedInvoiceSummary, OpenRouterVlmConfig, Transaction, TransactionDocumentAnalysis, UserRole } from '../types';
import type {
  BalanceSheetPreview,
  EurCashItem,
  EurCashClassification,
  GuvReport,
  ReportDrilldownEntry,
  ReportDrilldownSelection,
  ReportExportRequest,
  ReportExportResult,
  ReportFilterState,
  SusaReport,
} from '../domain/reportTypes';
import type { ReportMappingHealth, ReportMappingPosition, ReportMappingOverrideInput } from '../domain/reportMapping';
import type {
  AssetDepreciationScheduleEntry,
  AssetItem,
  AssetUpsertInput,
} from '../domain/assetTypes';
import type {
  AccountingPostingPreview,
  IncomingInvoiceDocumentEntity,
  IncomingInvoiceEntity,
  OpenItemEntity,
  OpenItemPaymentEntity,
  OpenItemPaymentInput,
  VendorEntity,
} from '@billme/accounting-shared';
import type { ProBankTransaction } from '@billme/accounting-shared';
import type {
  AccountingCommandInput,
  AccountingSourcePostResult,
  AccountingSourceRun,
  EurAnnexFact,
  EurAnnexFactInput,
  EurCashFact,
  EurCashFactInput,
  TaxPreparationArtifact,
  TaxPreparationInput,
} from '../sourceRuns';
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

type MaybePromise<T> = T | Promise<T>;

type StorePersistenceHooks = {
  onPersistEntry?: (entry: { transaction: Transaction; draft: BookingDraft }) => void | Promise<void>;
};

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

export interface MockStoreSeed {
  transactions?: Transaction[];
  drafts?: BookingDraft[];
  accounts?: Account[];
  chartFramework?: 'SKR03' | 'SKR04';
  bankAccountNumber?: string;
  bankAccountNumberByTransactionId?: Record<string, string>;
}

export function createAccountingWorkspaceStore() {
  let drafts = structuredClone(mockBookingDrafts) as BookingDraft[];
  let transactions = structuredClone(mockTransactions) as Transaction[];
  let accounts = structuredClone(mockAccounts);
  let persistenceHooks: StorePersistenceHooks = {};
  let generation = 0;
  let revision = 0;
  const listeners = new Set<() => void>();
  const notify = () => { revision++; listeners.forEach((listener) => listener()); };
  let dataAdapter: ProAccountingDataAdapter | null = null;

  function clone<T>(value: T): T {
    return structuredClone(value);
  }

  function getDraftIndexById(id: string) {
    return drafts.findIndex((draft) => draft.id === id);
  }

  function getTxIndexById(id: string) {
    return transactions.findIndex((tx) => tx.id === id);
  }

  async function persistPair(transactionId: string) {
    const tx = transactions.find((item) => item.id === transactionId);
    const draft = drafts.find((item) => item.transactionId === transactionId);
    if (!tx || !draft || !persistenceHooks.onPersistEntry) return;
    await Promise.resolve(
      persistenceHooks.onPersistEntry({
        transaction: clone(tx),
        draft: clone(draft),
      }),
    );
  }

  function configureStorePersistence(hooks: StorePersistenceHooks) {
    persistenceHooks = hooks;
  }

  function configureStoreAdapter(adapter?: ProAccountingDataAdapter) {
    if (dataAdapter !== (adapter ?? null)) generation++;
    dataAdapter = adapter ?? null;
  }

  function deriveFlags(tx: Transaction, draft: BookingDraft): Transaction['flags'] {
    const flags = new Set(tx.flags);
    const issueCodes = new Set(draft.validationIssues.map((issue) => issue.code));
    if (issueCodes.has('MISSING_RECEIPT')) flags.add('missing_receipt');
    else flags.delete('missing_receipt');
    if (issueCodes.has('DUPLICATE_SUSPECTED')) flags.add('duplicate_suspected');
    if (issueCodes.has('POSTING_DATE_IN_CLOSED_PERIOD')) flags.add('period_locked');
    else flags.delete('period_locked');
    return Array.from(flags);
  }

  function revalidateDraftAndSyncTransaction(draft: BookingDraft) {
    const tx = transactions.find((item) => item.id === draft.transactionId);
    if (!tx) return draft;

    const issues = validateBookingDraft(draft, tx, defaultBookingPolicy);
    draft.validationIssues = issues;

    const derivedStatus =
      draft.workflowStatus === 'posted' || draft.workflowStatus === 'reversed' || draft.workflowStatus === 'corrected'
        ? draft.workflowStatus
        : issues.some((issue) => issue.code === 'POSTING_DATE_IN_CLOSED_PERIOD')
          ? 'period_locked'
          : issues.some((issue) => issue.blocking)
            ? 'incomplete'
            : draft.workflowStatus;

    draft.workflowStatus = derivedStatus;

    const txIndex = getTxIndexById(tx.id);
    transactions[txIndex] = {
      ...tx,
      workflowStatus: draft.workflowStatus,
      issueCounts: summarizeIssues(issues),
      flags: deriveFlags(tx, draft),
    };

    return draft;
  }

  function syncAll() {
    drafts = drafts.map((draft) => revalidateDraftAndSyncTransaction(draft));
  }

  syncAll();

  function listTransactions(): Transaction[] {
    if (dataAdapter?.listTransactions) return clone(dataAdapter.listTransactions());
    return clone(transactions);
  }

  function listBookingDrafts(): BookingDraft[] {
    if (dataAdapter?.listBookingDrafts) return clone(dataAdapter.listBookingDrafts());
    return clone(drafts);
  }

  function getTransactionById(id: string): Transaction | undefined {
    if (dataAdapter?.getTransactionById) {
      const tx = dataAdapter.getTransactionById(id);
      return tx ? clone(tx) : undefined;
    }
    const tx = transactions.find((item) => item.id === id);
    return tx ? clone(tx) : undefined;
  }

  function listDrafts(): BookingDraft[] {
    if (dataAdapter?.listBookingDrafts) return clone(dataAdapter.listBookingDrafts());
    return clone(drafts);
  }

  function getBookingDraftByTransactionId(transactionId: string): BookingDraft | undefined {
    if (dataAdapter?.getBookingDraftByTransactionId) {
      const draft = dataAdapter.getBookingDraftByTransactionId(transactionId);
      return draft ? clone(draft) : undefined;
    }
    const tx = transactions.find((item) => item.id === transactionId);
    if (!tx) return undefined;
    const draft = drafts.find((item) => item.id === tx.bookingDraftId);
    return draft ? clone(draft) : undefined;
  }

  async function saveDraft(draft: BookingDraft, actorName = 'Mara Buchhaltung'): Promise<BookingDraft> {
    if (dataAdapter && !dataAdapter.saveDraft && !persistenceHooks.onPersistEntry) {
      throw new Error('READ_ONLY_ACCOUNTING_SOURCE: Entwürfe sind für diesen Adapter schreibgeschützt.');
    }
    if (dataAdapter?.saveDraft) {
      return clone(await dataAdapter.saveDraft(clone(draft), actorName));
    }
    const started = generation;
    const index = getDraftIndexById(draft.id);
    if (index === -1) throw new Error('Draft not found');
    const previousDraft = clone(drafts[index]);
    const previousTransaction = transactions.find((tx) => tx.id === draft.transactionId);
    try {
      drafts[index] = clone(draft);
      drafts[index].activity.unshift({
        id: `save-${Date.now()}`,
        at: new Date().toISOString(),
        actorId: 'local-user',
        actorName,
        type: 'field_changed',
        label: 'Entwurf gespeichert',
      });
      revalidateDraftAndSyncTransaction(drafts[index]);
      const result = clone(drafts[index]);
      await persistPair(result.transactionId);
      if (generation === started) notify();
      return result;
    } catch (error) {
      if (generation !== started) throw error;
      drafts[index] = previousDraft;
      if (previousTransaction) {
        const txIndex = getTxIndexById(previousTransaction.id);
        if (txIndex !== -1) transactions[txIndex] = previousTransaction;
      }
      notify();
      throw error;
    }
  }

  async function dispatchBookingAction(
    transactionId: string,
    action: BookingAction,
    options: { role: UserRole; actorName?: string; rejectReason?: string } = { role: 'bookkeeper' },
  ): Promise<BookingDraft> {
    if (dataAdapter && !dataAdapter.dispatchBookingAction && !persistenceHooks.onPersistEntry) {
      throw new Error('READ_ONLY_ACCOUNTING_SOURCE: Workflow-Aktionen sind für diesen Adapter schreibgeschützt.');
    }
    if (dataAdapter?.dispatchBookingAction) {
      return clone(await dataAdapter.dispatchBookingAction(transactionId, action, options));
    }
    const draft = getBookingDraftByTransactionId(transactionId);
    const tx = getTransactionById(transactionId);
    if (!draft || !tx) throw new Error('Transaction or draft not found');

    const permissionCtx = permissionContextForRole(options.role);
    const currentIssues = validateBookingDraft(draft, tx, defaultBookingPolicy);
    draft.validationIssues = currentIssues;

    if (!canTransition(draft, action, permissionCtx, currentIssues)) {
      throw new Error('Action not allowed');
    }

    const approvalRequired = reviewRequiredForDraft(draft);
    const transitioned = transitionBooking(draft, action, {
      actorId: `role-${options.role}`,
      actorName: options.actorName ?? options.role,
      approvalRequired,
      validationIssues: currentIssues,
      rejectReason: options.rejectReason,
    });

    const started = generation;
    const draftIndex = getDraftIndexById(transitioned.id);
    const previousDraft = clone(drafts[draftIndex]);
    const previousTransaction = transactions.find((item) => item.id === transactionId);
    try {
      drafts[draftIndex] = transitioned;
      revalidateDraftAndSyncTransaction(drafts[draftIndex]);
      const result = clone(drafts[draftIndex]);
      await persistPair(transactionId);
      if (generation === started) notify();
      return result;
    } catch (error) {
      if (generation !== started) throw error;
      drafts[draftIndex] = previousDraft;
      if (previousTransaction) {
        const txIndex = getTxIndexById(previousTransaction.id);
        if (txIndex !== -1) transactions[txIndex] = previousTransaction;
      }
      notify();
      throw error;
    }
  }

  function listActivity(transactionId: string) {
    if (dataAdapter?.listActivity) {
      return clone(dataAdapter.listActivity(transactionId));
    }
    return getBookingDraftByTransactionId(transactionId)?.activity ?? [];
  }

  function resetMockStore() {
    generation++;
    if (dataAdapter?.reset) {
      dataAdapter.reset();
      return;
    }
    drafts = structuredClone(mockBookingDrafts) as BookingDraft[];
    transactions = structuredClone(mockTransactions) as Transaction[];
    syncAll();
    notify();
  }


  const deriveAccountSuggestion = (tx: Transaction, accounts: Account[]): Account | undefined => {
    const lowered = `${tx.payee} ${tx.description}`.toLowerCase();
    const byKeyword = accounts.find((account) =>
      (account.keywords ?? []).some((keyword) => lowered.includes(keyword.toLowerCase())),
    );
    if (byKeyword) return byKeyword;

    if (tx.amount >= 0) {
      return accounts.find((account) => account.type === 'Revenue');
    }
    return accounts.find((account) => account.type === 'Expense');
  };

  const buildSeedDraft = (
    tx: Transaction,
    index: number,
    accounts: Account[],
    chartFramework: 'SKR03' | 'SKR04',
    bankAccountNumber?: string,
    bankAccountNumberByTransactionId?: Record<string, string>,
  ): BookingDraft => {
    const amount = Math.abs(Number(tx.amount) || 0);
    const suggestedAccount = deriveAccountSuggestion(tx, accounts);
    const configuredBankAccountNumber = bankAccountNumberByTransactionId?.[tx.id] ?? bankAccountNumber;
    const clearingAccount =
      (configuredBankAccountNumber ? accounts.find((account) => account.number === configuredBankAccountNumber) : undefined) ??
      (configuredBankAccountNumber ? undefined : accounts.find((account) => /bank|giro|konto/i.test(`${account.name} ${account.keywords?.join(' ') ?? ''}`))) ??
      accounts.find((account) => account.type === 'Asset') ??
      accounts[0];
    const fallbackText = tx.amount >= 0 ? 'Einnahme' : 'Ausgabe';
    const defaultTaxCase = normalizeTaxCaseKey(suggestedAccount?.defaultTaxCode);
    const defaultTaxCode = toLegacyTaxCode(defaultTaxCase) ?? suggestedAccount?.defaultTaxCode;

    return {
      id: tx.bookingDraftId,
      transactionId: tx.id,
      workflowStatus: tx.workflowStatus,
      documentDate: tx.date,
      postingDate: tx.date,
      serviceDate: tx.date,
      bookingText: tx.description || fallbackText,
      externalReference: tx.id,
      chartFramework,
      lines:
        suggestedAccount && clearingAccount
          ? [
              {
                id: `line-${index}-1`,
                accountId: tx.amount >= 0 ? clearingAccount.number : suggestedAccount.number,
                accountName: tx.amount >= 0 ? clearingAccount.name : suggestedAccount.name,
                type: 'Soll',
                amount,
                taxCaseKey: tx.amount < 0 ? defaultTaxCase : undefined,
                taxCode: tx.amount < 0 ? defaultTaxCode : undefined,
              },
              {
                id: `line-${index}-2`,
                accountId: tx.amount >= 0 ? suggestedAccount.number : clearingAccount.number,
                accountName: tx.amount >= 0 ? suggestedAccount.name : clearingAccount.name,
                type: 'Haben',
                amount,
                taxCaseKey: tx.amount >= 0 ? defaultTaxCase : undefined,
                taxCode: tx.amount >= 0 ? defaultTaxCode : undefined,
              },
            ]
          : [],
      validationIssues: [],
      activity: [
        {
          id: `seed-${tx.id}`,
          at: new Date().toISOString(),
          actorId: 'seed',
          actorName: 'System',
          type: 'state_changed',
          label: 'Importierter Entwurf erstellt',
        },
      ],
      assignedTo: tx.owner,
      approval: {
        required: false,
        status: 'not_required',
      },
    };
  };

  function hydrateMockStore(seed: MockStoreSeed) {
    generation++;
    if (seed.accounts) accounts = clone(seed.accounts);
    if (dataAdapter?.hydrate) {
      dataAdapter.hydrate(seed);
      notify();
      return;
    }

    if (seed.transactions) {
      const txRows = clone(seed.transactions);
      transactions = txRows;
    }

    if (seed.drafts) {
      drafts = clone(seed.drafts);
      syncAll();
      notify();
      return;
    }

    if (seed.transactions) {
      const chartFramework = seed.chartFramework ?? 'SKR03';
      const currentAccounts = seed.accounts && seed.accounts.length > 0 ? seed.accounts : [];
      drafts = seed.transactions.map((tx, idx) =>
        buildSeedDraft(
          tx,
          idx,
          currentAccounts,
          chartFramework,
          seed.bankAccountNumber,
          seed.bankAccountNumberByTransactionId,
        ),
      );
      syncAll();
    }
    notify();
  }

  async function updateExceptionCase(
    transactionId: string,
    patch: Partial<NonNullable<Transaction['exceptionCase']>>,
    actorName: string,
  ) {
    if (dataAdapter?.updateExceptionCase) {
      return clone(await dataAdapter.updateExceptionCase(transactionId, patch, actorName));
    }
    if (dataAdapter) throw new Error('Änderungen an Ausnahmen sind in dieser Oberfläche nicht verfügbar.');
    const started = generation;
    const txIndex = getTxIndexById(transactionId);
    if (txIndex === -1) throw new Error('Transaction not found');
    const tx = transactions[txIndex];
    const previousTransaction = clone(tx);
    const nextCase = {
      state: 'open' as const,
      ...(tx.exceptionCase ?? {}),
      ...patch,
    };
    transactions[txIndex] = {
      ...tx,
      exceptionCase: nextCase,
    };

    const draftIndex = drafts.findIndex((draft) => draft.transactionId === transactionId);
    const previousDraft = draftIndex === -1 ? undefined : clone(drafts[draftIndex]);
    if (draftIndex !== -1) {
      drafts[draftIndex].activity.unshift({
        id: `exc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        at: new Date().toISOString(),
        actorId: 'local-user',
        actorName,
        type: 'comment_added',
        label: `Exception aktualisiert: ${nextCase.state}`,
        details: patch.resolutionNote || patch.snoozedUntil || patch.owner,
      });
    }

    try {
      const result = clone(transactions[txIndex]);
      if (draftIndex !== -1) await persistPair(transactionId);
      if (generation === started) notify();
      return result;
    } catch (error) {
      if (generation !== started) throw error;
      transactions[txIndex] = previousTransaction;
      if (draftIndex !== -1 && previousDraft) drafts[draftIndex] = previousDraft;
      notify();
      throw error;
    }
  }

  async function assignExceptionOwner(transactionId: string, owner: string, actorName: string) {
    if (dataAdapter?.assignExceptionOwner) {
      return clone(await dataAdapter.assignExceptionOwner(transactionId, owner, actorName));
    }
    return updateExceptionCase(transactionId, { owner, state: 'open' }, actorName);
  }

  async function snoozeException(transactionId: string, snoozedUntil: string, actorName: string, note?: string) {
    if (dataAdapter?.snoozeException) {
      return clone(await dataAdapter.snoozeException(transactionId, snoozedUntil, actorName, note));
    }
    return updateExceptionCase(
      transactionId,
      { state: 'snoozed', snoozedUntil, resolutionNote: note },
      actorName,
    );
  }

  async function resolveException(transactionId: string, resolutionNote: string, actorName: string) {
    if (dataAdapter?.resolveException) {
      return clone(await dataAdapter.resolveException(transactionId, resolutionNote, actorName));
    }
    return updateExceptionCase(transactionId, {
      state: 'resolved',
      resolutionNote,
      resolvedAt: new Date().toISOString(),
      resolvedBy: actorName,
    }, actorName);
  }

  async function reopenException(transactionId: string, actorName: string) {
    if (dataAdapter?.reopenException) {
      return clone(await dataAdapter.reopenException(transactionId, actorName));
    }
    return updateExceptionCase(
      transactionId,
      { state: 'open', snoozedUntil: undefined, resolvedAt: undefined, resolvedBy: undefined },
      actorName,
    );
  }

  return {
    configureStorePersistence, configureStoreAdapter, listTransactions, listBookingDrafts, getTransactionById, listDrafts, getBookingDraftByTransactionId, saveDraft, dispatchBookingAction, listActivity, resetMockStore, hydrateMockStore, updateExceptionCase, assignExceptionOwner, snoozeException, resolveException, reopenException,
    listAccounts: () => clone(accounts),
    getGeneration: () => generation,
    getSnapshot: () => revision,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export type AccountingWorkspaceStore = ReturnType<typeof createAccountingWorkspaceStore>;
// Standalone demo consumers retain a default store; mounted workspaces own theirs.
export const defaultAccountingStore = createAccountingWorkspaceStore();
export const { configureStorePersistence, configureStoreAdapter, listTransactions, listBookingDrafts, getTransactionById, listDrafts, getBookingDraftByTransactionId, saveDraft, dispatchBookingAction, listActivity, resetMockStore, hydrateMockStore, updateExceptionCase, assignExceptionOwner, snoozeException, resolveException, reopenException } = defaultAccountingStore;
