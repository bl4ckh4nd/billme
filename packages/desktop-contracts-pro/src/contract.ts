import { z } from 'zod';
import {
  baseIpcRoutes,
  type RouteDef as BaseRouteDef,
} from '@billme/desktop-contracts/contract';
import {
  accountSchema,
  accountSuggestionRuleSchema,
  bookingDraftEntitySchema,
  datevExportResultSchema,
  draftValidationIssueSchema,
  invoiceSchema,
  journalEntryEntitySchema,
  ledgerAccountSchema,
  ledgerBalanceRowSchema,
  ledgerChartSchema,
  proDeleteAccountSuggestionRuleArgsSchema,
  proListAccountSuggestionRulesArgsSchema,
  proListTaxCaseAccountMappingsArgsSchema,
  proListTaxCasesArgsSchema,
  proUpsertAccountSuggestionRuleArgsSchema,
  proUpsertTaxCaseAccountMappingArgsSchema,
  proValidateTaxComplianceArgsSchema,
  proValidateTaxComplianceResultSchema,
  proWorkflowEntrySchema,
  taxCaseAccountMappingSchema,
  taxCaseDefinitionSchema,
  taxCaseKeySchema,
  transactionSchema,
  upsertOfferPayloadSchema,
  upsertAccountPayloadSchema,
  upsertPayloadSchema,
} from './schemas';

export type RouteDef<Args extends z.ZodTypeAny, Result extends z.ZodTypeAny> = BaseRouteDef<Args, Result>;

const okSchema = z.object({ ok: z.literal(true) });

const proActorRoleSchema = z.enum(['bookkeeper', 'reviewer', 'accountant', 'admin', 'auditor']);

const taxAuditExportPackageArgsSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  includeDocuments: z.boolean().optional(),
  actorRole: proActorRoleSchema,
});

const taxAuditExportPackageResultSchema = z.object({
  bundleDir: z.string().min(1),
  manifestPath: z.string().min(1),
  createdAt: z.string().min(1),
  fileCount: z.number().int().nonnegative(),
  files: z.array(
    z.object({
      name: z.string().min(1),
      path: z.string().min(1),
      sha256: z.string().length(64),
      sizeBytes: z.number().int().nonnegative(),
      rowCount: z.number().int().nonnegative().optional(),
    }),
  ),
});

const proImportSkrArgsSchema = z.object({
  preferredSource: z.enum(['auto', 'sqlite', 'csv']).optional(),
  sqlitePath: z.string().optional(),
  sourceDir: z.string().optional(),
  strictOnly: z.boolean().optional(),
});

const proListLedgerAccountsArgsSchema = z.object({
  chart: ledgerChartSchema.optional(),
  search: z.string().optional(),
  limit: z.number().int().positive().max(10_000).optional(),
  offset: z.number().int().min(0).optional(),
});

const proGetVatSummaryArgsSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

const proGetVatSummaryResultSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  rows: z.array(
    z.object({
      taxCaseKey: taxCaseKeySchema,
      netAmount: z.number(),
      taxAmount: z.number(),
      grossAmount: z.number(),
      lineCount: z.number().int(),
    }),
  ),
});

const proLedgerStatsSchema = z.object({
  total: z.number().int(),
  byChart: z.object({
    SKR03: z.number().int(),
    SKR04: z.number().int(),
  }),
});

const proImportSkrResultSchema = z.object({
  source: z.enum(['sqlite', 'csv', 'none']),
  sourceDetails: z.array(z.string()),
  inserted: z.number().int(),
  updated: z.number().int(),
  total: z.number().int(),
  skipped: z.number().int(),
  warnings: z.array(z.string()),
  stats: proLedgerStatsSchema,
});

const proUpsertWorkflowEntryArgsSchema = z.object({
  transactionId: z.string().min(1),
  transactionJson: z.string().min(2),
  draftJson: z.string().min(2),
});

const proGetDraftByTransactionIdArgsSchema = z.object({
  transactionId: z.string().min(1),
});

const proSaveDraftArgsSchema = z.object({
  draft: bookingDraftEntitySchema,
});

const proDispatchDraftActionArgsSchema = z.object({
  transactionId: z.string().min(1),
  action: z.enum([
    'save_draft',
    'submit_for_review',
    'approve',
    'reject',
    'post',
    'reverse',
    'create_correction',
    'request_receipt',
  ]),
  rejectReason: z.string().optional(),
});

const proPostDraftArgsSchema = z.object({
  draftId: z.string().min(1),
  postingDate: z.string().optional(),
  actorRole: proActorRoleSchema,
});

const proPostDraftResultSchema = z.object({
  entry: journalEntryEntitySchema,
  issues: z.array(draftValidationIssueSchema),
});

const proReverseJournalEntryArgsSchema = z.object({
  entryId: z.string().min(1),
  reason: z.string().min(1),
  actorRole: proActorRoleSchema,
});

const proReverseJournalEntryResultSchema = z.object({
  ok: z.literal(true),
  reversalEntryId: z.string().min(1),
});

const proListJournalEntriesArgsSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.number().int().positive().max(5000).optional(),
  offset: z.number().int().min(0).optional(),
});

const proGetLedgerBalancesArgsSchema = z.object({
  asOfDate: z.string().optional(),
});

const proGetSusaReportArgsSchema = z.object({
  asOfDate: z.string().optional(),
});

const proGetSusaReportResultSchema = z.object({
  asOfDate: z.string(),
  rows: z.array(ledgerBalanceRowSchema),
  totals: z.object({
    debit: z.number(),
    credit: z.number(),
    balance: z.number(),
  }),
});

const proGetGuvReportArgsSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

const proGetGuvReportResultSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  rows: z.array(
    z.object({
      positionKey: z.string(),
      positionLabel: z.string(),
      amount: z.number(),
    }),
  ),
  netResult: z.number(),
});

const proGetBilanzReportArgsSchema = z.object({
  asOfDate: z.string().optional(),
});

const proGetBilanzReportResultSchema = z.object({
  asOfDate: z.string(),
  assets: z.array(
    z.object({
      accountNumber: z.string(),
      amount: z.number(),
    }),
  ),
  liabilities: z.array(
    z.object({
      accountNumber: z.string(),
      amount: z.number(),
    }),
  ),
  totals: z.object({
    assets: z.number(),
    liabilities: z.number(),
    delta: z.number(),
  }),
});

const proExportDatevBuchungsstapelArgsSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  actorRole: proActorRoleSchema,
});

const proListDatevExportsArgsSchema = z.object({
  limit: z.number().int().positive().max(1000).optional(),
});

const proGetAccountingHealthResultSchema = z.object({
  draftCount: z.number().int(),
  postedCount: z.number().int(),
  reversedCount: z.number().int(),
  unbalancedDraftCount: z.number().int(),
  unmappedAccountCount: z.number().int(),
  lastDatevExportAt: z.string().optional(),
});

const invoiceMatchSuggestionSchema = z.object({
  invoice: invoiceSchema,
  confidence: z.enum(['high', 'medium', 'low']),
  matchReasons: z.array(z.string()),
  amountDiff: z.number(),
});

const findMatchesResultSchema = z.object({
  transaction: transactionSchema,
  suggestions: z.array(invoiceMatchSuggestionSchema),
});

const linkTransactionResultSchema = z.object({
  success: z.boolean(),
  invoice: invoiceSchema.optional(),
});

export const proRouteOverrides = {
  'invoices:list': {
    ...baseIpcRoutes['invoices:list'],
    result: z.array(invoiceSchema),
  },
  'invoices:upsert': {
    ...baseIpcRoutes['invoices:upsert'],
    args: upsertPayloadSchema,
    result: invoiceSchema,
  },
  'offers:list': {
    ...baseIpcRoutes['offers:list'],
    result: z.array(invoiceSchema),
  },
  'offers:upsert': {
    ...baseIpcRoutes['offers:upsert'],
    args: upsertOfferPayloadSchema,
    result: invoiceSchema,
  },
  'documents:createFromClient': {
    ...baseIpcRoutes['documents:createFromClient'],
    result: invoiceSchema,
  },
  'documents:convertOfferToInvoice': {
    ...baseIpcRoutes['documents:convertOfferToInvoice'],
    result: invoiceSchema,
  },
  'accounts:list': {
    ...baseIpcRoutes['accounts:list'],
    result: z.array(accountSchema),
  },
  'accounts:upsert': {
    ...baseIpcRoutes['accounts:upsert'],
    args: upsertAccountPayloadSchema,
    result: accountSchema,
  },
  'transactions:list': {
    ...baseIpcRoutes['transactions:list'],
    result: z.array(transactionSchema),
  },
  'transactions:findMatches': {
    ...baseIpcRoutes['transactions:findMatches'],
    result: findMatchesResultSchema,
  },
  'transactions:link': {
    ...baseIpcRoutes['transactions:link'],
    result: linkTransactionResultSchema,
  },
} as const satisfies Record<string, RouteDef<z.ZodTypeAny, z.ZodTypeAny>>;

export const proOnlyIpcRoutes = {
  'pro:importSkr': {
    channel: 'pro:importSkr',
    args: proImportSkrArgsSchema,
    result: proImportSkrResultSchema,
  },
  'pro:listLedgerAccounts': {
    channel: 'pro:listLedgerAccounts',
    args: proListLedgerAccountsArgsSchema,
    result: z.array(ledgerAccountSchema),
  },
  'pro:listTaxCases': {
    channel: 'pro:listTaxCases',
    args: proListTaxCasesArgsSchema,
    result: z.array(taxCaseDefinitionSchema),
  },
  'pro:listTaxCaseAccountMappings': {
    channel: 'pro:listTaxCaseAccountMappings',
    args: proListTaxCaseAccountMappingsArgsSchema,
    result: z.array(taxCaseAccountMappingSchema),
  },
  'pro:upsertTaxCaseAccountMapping': {
    channel: 'pro:upsertTaxCaseAccountMapping',
    args: proUpsertTaxCaseAccountMappingArgsSchema,
    result: taxCaseAccountMappingSchema,
  },
  'pro:getLedgerStats': {
    channel: 'pro:getLedgerStats',
    args: z.undefined(),
    result: proLedgerStatsSchema,
  },
  'pro:listBankTransactions': {
    channel: 'pro:listBankTransactions',
    args: z.undefined(),
    result: z.array(transactionSchema),
  },
  'pro:listAccountSuggestionRules': {
    channel: 'pro:listAccountSuggestionRules',
    args: proListAccountSuggestionRulesArgsSchema,
    result: z.array(accountSuggestionRuleSchema),
  },
  'pro:upsertAccountSuggestionRule': {
    channel: 'pro:upsertAccountSuggestionRule',
    args: proUpsertAccountSuggestionRuleArgsSchema,
    result: accountSuggestionRuleSchema,
  },
  'pro:deleteAccountSuggestionRule': {
    channel: 'pro:deleteAccountSuggestionRule',
    args: proDeleteAccountSuggestionRuleArgsSchema,
    result: okSchema,
  },
  'pro:getDraftByTransactionId': {
    channel: 'pro:getDraftByTransactionId',
    args: proGetDraftByTransactionIdArgsSchema,
    result: bookingDraftEntitySchema.nullable(),
  },
  'pro:saveDraft': {
    channel: 'pro:saveDraft',
    args: proSaveDraftArgsSchema,
    result: bookingDraftEntitySchema,
  },
  'pro:dispatchDraftAction': {
    channel: 'pro:dispatchDraftAction',
    args: proDispatchDraftActionArgsSchema,
    result: bookingDraftEntitySchema,
  },
  'pro:postDraft': {
    channel: 'pro:postDraft',
    args: proPostDraftArgsSchema,
    result: proPostDraftResultSchema,
  },
  'pro:reverseJournalEntry': {
    channel: 'pro:reverseJournalEntry',
    args: proReverseJournalEntryArgsSchema,
    result: proReverseJournalEntryResultSchema,
  },
  'pro:listJournalEntries': {
    channel: 'pro:listJournalEntries',
    args: proListJournalEntriesArgsSchema,
    result: z.array(journalEntryEntitySchema),
  },
  'pro:getLedgerBalances': {
    channel: 'pro:getLedgerBalances',
    args: proGetLedgerBalancesArgsSchema,
    result: z.array(ledgerBalanceRowSchema),
  },
  'pro:getSusaReport': {
    channel: 'pro:getSusaReport',
    args: proGetSusaReportArgsSchema,
    result: proGetSusaReportResultSchema,
  },
  'pro:getGuvReport': {
    channel: 'pro:getGuvReport',
    args: proGetGuvReportArgsSchema,
    result: proGetGuvReportResultSchema,
  },
  'pro:getBilanzReport': {
    channel: 'pro:getBilanzReport',
    args: proGetBilanzReportArgsSchema,
    result: proGetBilanzReportResultSchema,
  },
  'pro:exportDatevBuchungsstapel': {
    channel: 'pro:exportDatevBuchungsstapel',
    args: proExportDatevBuchungsstapelArgsSchema,
    result: datevExportResultSchema,
  },
  'pro:listDatevExports': {
    channel: 'pro:listDatevExports',
    args: proListDatevExportsArgsSchema,
    result: z.array(datevExportResultSchema),
  },
  'pro:getAccountingHealth': {
    channel: 'pro:getAccountingHealth',
    args: z.undefined(),
    result: proGetAccountingHealthResultSchema,
  },
  'pro:validateTaxCompliance': {
    channel: 'pro:validateTaxCompliance',
    args: proValidateTaxComplianceArgsSchema,
    result: proValidateTaxComplianceResultSchema,
  },
  'pro:getVatSummary': {
    channel: 'pro:getVatSummary',
    args: proGetVatSummaryArgsSchema,
    result: proGetVatSummaryResultSchema,
  },
  'pro:listWorkflowEntries': {
    channel: 'pro:listWorkflowEntries',
    args: z.undefined(),
    result: z.array(proWorkflowEntrySchema),
  },
  'pro:upsertWorkflowEntry': {
    channel: 'pro:upsertWorkflowEntry',
    args: proUpsertWorkflowEntryArgsSchema,
    result: okSchema,
  },
  'tax:auditExportPackage': {
    channel: 'tax:auditExportPackage',
    args: taxAuditExportPackageArgsSchema,
    result: taxAuditExportPackageResultSchema,
  },
} as const satisfies Record<string, RouteDef<z.ZodTypeAny, z.ZodTypeAny>>;

export const ipcRoutes = {
  ...baseIpcRoutes,
  ...proRouteOverrides,
  ...proOnlyIpcRoutes,
} as const satisfies Record<string, RouteDef<z.ZodTypeAny, z.ZodTypeAny>>;

export type IpcRouteKey = Extract<keyof typeof ipcRoutes, string>;
export type IpcArgs<K extends IpcRouteKey> = z.infer<(typeof ipcRoutes)[K]['args']>;
export type IpcResult<K extends IpcRouteKey> = z.infer<(typeof ipcRoutes)[K]['result']>;
