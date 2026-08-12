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
  getDraftByTransactionId,
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
  saveDraft,
  validateTaxCompliance,
} from './proAccountingRepo';
import { listProWorkflowEntries, upsertProWorkflowEntry } from './proWorkflowRepo';
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

export const createSqliteProAccountingRepository = (db: Database.Database): ProAccountingRepository & ProAccountingOposRepository => ({
  listBankTransactions: async (scope) => listBankTransactions(db, scope),
  getDraftByTransactionId: async (scope, transactionId) => getDraftByTransactionId(db, transactionId, scope),
  saveDraft: async (scope, draft) => saveDraft(db, draft, scope),
  dispatchDraftAction: async (scope, args) => dispatchDraftAction(db, args, scope),
  validateTaxCompliance: async (scope, args) => validateTaxCompliance(db, args, scope),
  postDraft: async (scope, draftId, options) => postDraft(db, draftId, options, scope),
  reverseJournalEntry: async (scope: TenantScope, entryId: string, reason: string, options?: ReverseJournalEntryOptions) => reverseJournalEntry(db, entryId, reason, scope, options),
  listJournalEntries: async (scope, args) => listJournalEntries(db, args, scope),
  getLedgerBalances: async (scope, args) => getLedgerBalances(db, args, scope),
  getSusaReport: async (scope, args) => getSusaReport(db, args, scope),
  getGuvReport: async (scope, args) => getGuvReport(db, args, scope),
  getBilanzReport: async (scope, args) => getBilanzReport(db, args, scope),
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
  previewOutgoingInvoice: async (scope, invoiceId) => previewOutgoingInvoice(db, scope, invoiceId),
  postOutgoingInvoice: async (scope, invoiceId, options) => postOutgoingInvoice(db, scope, invoiceId, options),
  previewIncomingInvoice: async (scope, invoiceId) => previewIncomingInvoice(db, scope, invoiceId),
  postIncomingInvoice: async (scope, invoiceId, options) => postIncomingInvoice(db, scope, invoiceId, options),
  listOpenItems: async (scope) => listOpenItems(db, scope),
  allocateOpenItemPayment: async (scope, input) => allocateOpenItemPayment(db, scope, input),
  allocateRemainingOpenItemPayment: async (scope, paymentId, allocations) => allocateRemainingOpenItemPayment(db, scope, paymentId, allocations),
  reverseDocumentAccounting: async (scope, input) => reverseDocumentAccounting(db, scope, input),
  previewAccountingBackfill: async (scope) => previewAccountingBackfill(db, scope),
  confirmAccountingBackfill: async (scope, input) => confirmAccountingBackfill(db, scope, input),
  ensureSeedData: async (scope) => {
    ensureProAccountingSeedData(db, scope);
  },
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
