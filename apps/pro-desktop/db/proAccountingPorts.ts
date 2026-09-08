import type Database from 'better-sqlite3';
import type {
  ProAccountingCatalogRepository,
  ProAccountingRepository,
  ProWorkflowRepository,
} from '@billme/server-core';
import type { TenantScope } from '@billme/server-core';
import type { ReverseJournalEntryOptions } from '@billme/server-core/ports';
import {
  buildDatevRows,
  dispatchDraftAction,
  ensureProAccountingSeedData,
  getAccountingHealth,
  getBilanzReport,
  getReportingReport as runReportingReport,
  getReportMappingHealth as readReportMappingHealth,
  getReportSnapshot as readReportSnapshot,
  getDraftByTransactionId,
  getJournalEntryById,
  getGuvReport,
  getLedgerBalances,
  getSusaReport,
  getVatSummary,
  insertDatevExport,
  listBankTransactions,
  listDatevExports,
  listJournalEntries,
  postDraft,
  reverseJournalEntry,
  listReportSnapshots as readReportSnapshots,
  saveReportSnapshot as persistReportSnapshot,
  saveDraft,
  upsertReportMappingOverride as persistReportMappingOverride,
  validateTaxCompliance,
} from './proAccountingRepo';
import type {
  DesktopReportSnapshotRecord,
  ReportMappingOverrideInput,
} from './proAccountingRepo';
import { listProWorkflowEntries, upsertProWorkflowEntry } from './proWorkflowRepo';
import {
  getAccountingSourceRun,
  listAccountingSourceRuns,
  postAccountingCommand,
  postAccountingSource,
  type PostAccountingCommandInput,
  type PostAccountingSourceOptions,
} from './accountingSourceRepo';
import type { AccountingSourceFact } from '@billme/accounting-shared';
import { getLedgerAccountStats, listLedgerAccounts } from './ledgerAccountsRepo';
import {
  deleteAccountSuggestionRule,
  listAccountSuggestionRules,
  upsertAccountSuggestionRule,
} from './accountSuggestionRulesRepo';
import { listTaxCaseAccountMappings, listTaxCases, upsertTaxCaseAccountMapping } from './taxCasesRepo';
import {
  allocateOpenItemPayment,
  allocateRemainingOpenItemPayment,
  confirmAccountingBackfill,
  getAccountingPolicyForPro,
  listAccountingAccountMappings,
  listIncomingInvoices,
  listOpenItems,
  listVendors,
  postIncomingInvoice,
  postOutgoingInvoice,
  previewAccountingBackfill,
  previewIncomingInvoice,
  previewOutgoingInvoice,
  reverseDocumentAccounting,
  setAccountingPolicyForPro,
  upsertAccountingAccountMapping,
  upsertIncomingInvoice,
  upsertVendor,
} from './oposRepo';
import type { ProAccountingOposRepository } from '@billme/accounting-engine';

type LocalReportingReport = (
  db: Database.Database,
  args: Parameters<typeof runReportingReport>[1],
  scope: TenantScope,
) => ReturnType<typeof runReportingReport>;

// The accounting-engine repository contract has a scope-first method with the
// same name. Keep the local SQLite implementation's database-first seam
// explicit rather than weakening the whole port object with `any`.
const runLocalReportingReport = runReportingReport as unknown as LocalReportingReport;
const readLocalReportSnapshot = readReportSnapshot as unknown as (
  db: Database.Database,
  snapshotId: string,
  scope: TenantScope,
) => DesktopReportSnapshotRecord | null;
const readLocalReportSnapshots = readReportSnapshots as unknown as (
  db: Database.Database,
  scope: TenantScope,
  reportType?: string,
) => DesktopReportSnapshotRecord[];
const persistLocalReportSnapshot = persistReportSnapshot as unknown as (
  db: Database.Database,
  input: { reportType: string; args?: unknown; payload: unknown; id?: string; reason?: string },
  scope: TenantScope,
) => DesktopReportSnapshotRecord;
const readLocalReportMappingHealth = readReportMappingHealth as unknown as (
  db: Database.Database,
  scope: TenantScope,
  args?: { chart?: 'SKR03' | 'SKR04'; statement?: string },
) => import('@billme/accounting-shared').MappingHealth;
const persistLocalReportMappingOverride = persistReportMappingOverride as unknown as (
  db: Database.Database,
  input: ReportMappingOverrideInput,
  scope: TenantScope,
) => import('@billme/accounting-shared').ReportingMapping;

const incomingInvoiceDocumentsRequirePglite = (): never => {
  throw new Error('PGLITE_SQLITE_IPC_UNAVAILABLE: Eingangsbelege werden über den eingebetteten PGlite-Server verwaltet.');
};

export const createSqliteProAccountingRepository = (db: Database.Database): ProAccountingRepository & ProAccountingOposRepository & {
  getReportSnapshot: typeof readReportSnapshot;
  listReportSnapshots: typeof readReportSnapshots;
  saveReportSnapshot: typeof persistReportSnapshot;
  getReportMappingHealth: typeof readReportMappingHealth;
  getReportingReport: (scope: TenantScope, args: Parameters<typeof runReportingReport>[1]) => ReturnType<typeof runReportingReport>;
  upsertReportMappingOverride: typeof persistReportMappingOverride;
  postAccountingSource: (scope: TenantScope, fact: AccountingSourceFact, options?: PostAccountingSourceOptions) => ReturnType<typeof postAccountingSource> | Promise<ReturnType<typeof postAccountingSource>>;
  postAccountingCommand: (scope: TenantScope, input: PostAccountingCommandInput, options?: PostAccountingSourceOptions) => ReturnType<typeof postAccountingCommand> | Promise<ReturnType<typeof postAccountingCommand>>;
  listAccountingSourceRuns: (scope: TenantScope) => ReturnType<typeof listAccountingSourceRuns> | Promise<ReturnType<typeof listAccountingSourceRuns>>;
  getAccountingSourceRun: (scope: TenantScope, id: string) => ReturnType<typeof getAccountingSourceRun> | Promise<ReturnType<typeof getAccountingSourceRun>>;
} => ({
  listBankTransactions: async (scope) => listBankTransactions(db, scope),
  getDraftByTransactionId: async (scope, transactionId) => getDraftByTransactionId(db, transactionId, scope),
  saveDraft: async (scope, draft) => saveDraft(db, draft, scope),
  dispatchDraftAction: async (scope, args) => dispatchDraftAction(db, args, scope),
  validateTaxCompliance: async (scope, args) => validateTaxCompliance(db, args, scope),
  postDraft: async (scope, draftId, options) => postDraft(db, draftId, options, scope),
  reverseJournalEntry: async (scope: TenantScope, entryId: string, reason: string, options?: ReverseJournalEntryOptions) => reverseJournalEntry(db, entryId, reason, scope, options),
  listJournalEntries: async (scope, args) => listJournalEntries(db, args, scope),
  getJournalEntryById: async (scope, entryId) => getJournalEntryById(db, entryId, scope),
  getLedgerBalances: async (scope, args) => getLedgerBalances(db, args, scope),
  getSusaReport: async (scope, args) => getSusaReport(db, args, scope),
  getGuvReport: async (scope, args) => getGuvReport(db, args, scope),
  getBilanzReport: async (scope, args) => getBilanzReport(db, args, scope),
  getReportingReport: (scope, args) => Reflect.apply(runLocalReportingReport, null, [db, args, scope]),
  getReportSnapshot: (scope, id) => Reflect.apply(readLocalReportSnapshot, null, [db, id, scope]),
  listReportSnapshots: (scope, reportType) => Reflect.apply(readLocalReportSnapshots, null, [db, scope, reportType]),
  saveReportSnapshot: (scope, input) => Reflect.apply(persistLocalReportSnapshot, null, [db, input, scope]),
  getReportMappingHealth: (scope, args) => Reflect.apply(readLocalReportMappingHealth, null, [db, scope, args]),
  upsertReportMappingOverride: (scope, input) => Reflect.apply(persistLocalReportMappingOverride, null, [db, input, scope]),
  listDatevExports: async (scope) => listDatevExports(db, scope),
  insertDatevExport: async (scope, args) => insertDatevExport(db, args, scope),
  getAccountingHealth: async (scope) => getAccountingHealth(db, scope),
  getVatSummary: async (scope, args) => getVatSummary(db, args, scope),
  buildDatevRows: async (scope, args) => buildDatevRows(db, args, scope),
  getAccountingPolicy: async (scope) => getAccountingPolicyForPro(db, scope),
  setAccountingPolicy: async (scope, input) => setAccountingPolicyForPro(db, scope, input),
  listAccountingAccountMappings: async (scope, chart) => listAccountingAccountMappings(db, scope, chart),
  upsertAccountingAccountMapping: async (scope, input) => upsertAccountingAccountMapping(db, scope, input),
  listVendors: async (scope) => listVendors(db, scope),
  upsertVendor: async (scope, input) => upsertVendor(db, scope, input),
  listIncomingInvoices: async (scope) => listIncomingInvoices(db, scope),
  upsertIncomingInvoice: async (scope, input) => upsertIncomingInvoice(db, scope, input),
  listIncomingInvoiceDocuments: async () => incomingInvoiceDocumentsRequirePglite(),
  uploadIncomingInvoiceDocument: async () => incomingInvoiceDocumentsRequirePglite(),
  downloadIncomingInvoiceDocument: async () => incomingInvoiceDocumentsRequirePglite(),
  reviewIncomingInvoiceDocument: async () => incomingInvoiceDocumentsRequirePglite(),
  previewOutgoingInvoice: async (scope, invoiceId) => previewOutgoingInvoice(db, scope, invoiceId),
  postOutgoingInvoice: async (scope, invoiceId, options) => postOutgoingInvoice(db, scope, invoiceId, options),
  previewIncomingInvoice: async (scope, invoiceId) => previewIncomingInvoice(db, scope, invoiceId),
  postIncomingInvoice: async (scope, invoiceId, options) => postIncomingInvoice(db, scope, invoiceId, options),
  listOpenItems: async (scope) => listOpenItems(db, scope),
  allocateOpenItemPayment: async (scope, input) => allocateOpenItemPayment(db, scope, input),
  allocateRemainingOpenItemPayment: async (scope, paymentId, allocations, allocationEventId, mutation) => allocateRemainingOpenItemPayment(db, scope, paymentId, allocations, allocationEventId, mutation),
  reverseDocumentAccounting: async (scope, input) => reverseDocumentAccounting(db, scope, input),
  previewAccountingBackfill: async (scope) => previewAccountingBackfill(db, scope),
  confirmAccountingBackfill: async (scope, input) => confirmAccountingBackfill(db, scope, input),
  ensureSeedData: async (scope) => {
    ensureProAccountingSeedData(db, scope);
  },
  postAccountingSource: async (scope, fact: AccountingSourceFact, options?: PostAccountingSourceOptions) => postAccountingSource(db, fact, scope, options),
  postAccountingCommand: async (scope, input: PostAccountingCommandInput, options?: PostAccountingSourceOptions) => postAccountingCommand(db, input, scope, options),
  listAccountingSourceRuns: async (scope) => listAccountingSourceRuns(db, scope),
  getAccountingSourceRun: async (scope, id) => getAccountingSourceRun(db, id, scope),
});

export const createSqliteProWorkflowRepository = (db: Database.Database): ProWorkflowRepository => ({
  list: async (scope) => listProWorkflowEntries(db, scope),
  upsert: async (scope, args) => upsertProWorkflowEntry(db, args, scope),
});

export const createSqliteProAccountingCatalogRepository = (
  db: Database.Database,
): ProAccountingCatalogRepository => ({
  listLedgerAccounts: async (scope, args) => listLedgerAccounts(db, args, scope),
  getLedgerStats: async () => getLedgerAccountStats(db),
  listTaxCases: async (_scope, args) => listTaxCases(db, args),
  listTaxCaseAccountMappings: async (_scope, args) => listTaxCaseAccountMappings(db, args),
  upsertTaxCaseAccountMapping: async (_scope, args) => upsertTaxCaseAccountMapping(db, args),
  listAccountSuggestionRules: async (scope, args) => listAccountSuggestionRules(db, args, scope),
  upsertAccountSuggestionRule: async (scope, input) => upsertAccountSuggestionRule(db, input, scope),
  deleteAccountSuggestionRule: async (scope, id) => {
    deleteAccountSuggestionRule(db, id, scope);
  },
});
