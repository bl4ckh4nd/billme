import { z } from 'zod';
import { ipcRoutes as liteIpcRoutes } from '@billme/desktop-contracts/contract';
import {
  upsertAccountPayloadSchema,
  invoiceSchema,
  accountSchema,
  ledgerAccountSchema,
  ledgerChartSchema,
  taxCaseDefinitionSchema,
  taxCaseAccountMappingSchema,
  taxCaseKeySchema,
  proListTaxCasesArgsSchema,
  proListTaxCaseAccountMappingsArgsSchema,
  proUpsertTaxCaseAccountMappingArgsSchema,
  proValidateTaxComplianceArgsSchema,
  proValidateTaxComplianceResultSchema,
  proWorkflowEntrySchema,
  bookingDraftEntitySchema,
  journalEntryEntitySchema,
  ledgerBalanceRowSchema,
  datevExportResultSchema,
  draftValidationIssueSchema,
  eurListItemsArgsSchema,
  eurListItemSchema,
  eurUpsertClassificationArgsSchema,
  eurClassificationSchema,
  eurCashFactSchema,
  eurAnnexFactSchema,
  eurSaveCashFactArgsSchema,
  eurSaveAnnexFactArgsSchema,
  eurListFactsArgsSchema,
  accountSuggestionRuleSchema,
  proListAccountSuggestionRulesArgsSchema,
  proUpsertAccountSuggestionRuleArgsSchema,
  proDeleteAccountSuggestionRuleArgsSchema,
  assetSchema,
  assetUpsertSchema,
  assetDepreciationScheduleEntrySchema,
  accountingPolicySchema,
  accountingAccountMappingSchema,
  vendorSchema,
  incomingInvoiceSchema,
  incomingInvoiceDocumentSchema,
  incomingInvoiceDocumentUploadSchema,
  incomingInvoiceDocumentDownloadSchema,
  incomingInvoiceDocumentReviewSchema,
  openItemSchema,
  accountingPostingPreviewSchema,
  accountingBackfillPreviewSchema,
  accountingBackfillResultSchema,
  listReportSnapshotsArgsSchema,
  reportSnapshotRecordSchema,
  saveReportSnapshotArgsSchema,
  proGetReportingReportArgsSchema,
  proGetReportingReportResultSchema,
  proGetReportMappingHealthArgsSchema,
  proGetReportMappingHealthResultSchema,
  proListReportMappingPositionsArgsSchema,
  reportMappingPositionSchema,
  proUpsertReportMappingOverrideArgsSchema,
  proPostAccountingSourceArgsSchema,
  proPostAccountingCommandArgsSchema,
  proAccountingSourcePostResultSchema,
  proGetAccountingSourceRunArgsSchema,
  proAccountingSourceRunSchema,
  taxAuditExportArtifactSchema,
  openRouterVlmConfigSchema,
  openRouterVlmAnalyzeInputSchema,
  openRouterVlmAnalyzeResultSchema,
  accountingPeriodKeySchema,
  accountingPeriodSchema,
  accountingPeriodStatusChangeSchema,
  accountingPeriodStatusSchema,
} from './schemas';

const okSchema = z.object({ ok: z.literal(true) });

const transactionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  date: z.string(),
  amount: z.number(),
  type: z.enum(['income', 'expense']),
  counterparty: z.string(),
  purpose: z.string(),
  linkedInvoiceId: z.string().optional(),
  matchedManualEntryId: z.string().optional(), appliedAmountCents: z.number().int().optional(), unallocatedAmountCents: z.number().int().optional(),
  status: z.enum(['pending', 'booked']),
  dedupHash: z.string().optional(),
  importBatchId: z.string().optional(),
  suggestedAccountNumber: z.string().optional(),
  suggestionReason: z.string().optional(),
  suggestionLayer: z.enum(['rule', 'counterparty', 'bayes', 'keyword', 'fallback']).optional(),
  suggestionConfidence: z.number().optional(),
});

const invoiceMatchSuggestionSchema = z.object({
  invoice: invoiceSchema,
  confidence: z.enum(['high', 'medium', 'low']),
  matchReasons: z.array(z.string()),
  amountDiff: z.number(),
});

const findMatchesForTransactionSchema = z.object({
  transactionId: z.string().min(1),
});

const findMatchesResultSchema = z.object({
  transaction: transactionSchema,
  suggestions: z.array(invoiceMatchSuggestionSchema),
});

const listTransactionsFiltersSchema = z.object({
  accountId: z.string().optional(),
  type: z.enum(['income', 'expense']).optional(),
  linkedOnly: z.boolean().optional(),
  unlinkedOnly: z.boolean().optional(),
});
const proActorRoleSchema = z.enum(['bookkeeper', 'reviewer', 'accountant', 'admin', 'auditor']);
const taxAuditExportPackageArgsSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  includeDocuments: z.boolean().optional(),
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
  actorRole: proActorRoleSchema.optional(),
  idempotencyKey: z.string().min(1).optional(),
  softLockOverride: z.boolean().optional(),
  overrideReason: z.string().optional(),
});

const proPostDraftResultSchema = z.object({
  entry: journalEntryEntitySchema,
  issues: z.array(draftValidationIssueSchema),
});

const proReverseJournalEntryArgsSchema = z.object({
  entryId: z.string().min(1),
  reason: z.string().min(1),
  actorRole: proActorRoleSchema.optional(),
  postingDate: z.string().optional(),
  softLockOverride: z.boolean().optional(),
  overrideReason: z.string().optional(),
});

const proReverseJournalEntryResultSchema = z.object({
  ok: z.literal(true),
  reversalEntryId: z.string().min(1),
});

const proListJournalEntriesArgsSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  accountNumbers: z.array(z.string().min(1)).optional(),
  limit: z.number().int().positive().max(5000).optional(),
  offset: z.number().int().min(0).optional(),
});

const proGetJournalEntryByIdArgsSchema = z.object({
  entryId: z.string().min(1),
});

const proGetLedgerBalancesArgsSchema = z.object({
  asOfDate: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

const proGetSusaReportArgsSchema = z.object({
  asOfDate: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

const proGetSusaReportResultSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  chart: z.enum(['SKR03', 'SKR04']).optional(),
  asOfDate: z.string(),
  rows: z.array(ledgerBalanceRowSchema.extend({
    mappedTo: z.string().optional(),
    hasWarnings: z.boolean().optional(),
  })),
  totals: z.object({
    debit: z.number(),
    credit: z.number(),
    balance: z.number(),
  }),
  unmappedAccounts: z.array(z.object({ accountNumber: z.string(), amount: z.number() })).optional(),
  blocking: z.boolean().optional(),
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
      accountRefs: z.array(z.string()).optional(),
    }),
  ),
  chart: z.enum(['SKR03', 'SKR04']).optional(),
  netResult: z.number(),
  unmappedAccounts: z.array(z.object({ accountNumber: z.string(), amount: z.number() })).optional(),
  blocking: z.boolean().optional(),
});

const proGetBilanzReportArgsSchema = z.object({
  asOfDate: z.string().optional(),
});

const proGetBilanzReportResultSchema = z.object({
  chart: z.enum(['SKR03', 'SKR04']).optional(),
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
  unmappedAccounts: z.array(z.object({ accountNumber: z.string(), amount: z.number() })).optional(),
  blocking: z.boolean().optional(),
});

const proUpsertAssetArgsSchema = z.object({
  asset: assetUpsertSchema,
  reason: z.string().min(1),
});

const proGetDepreciationScheduleArgsSchema = z.object({
  assetId: z.string().min(1),
});

const proRunDepreciationArgsSchema = z.object({
  assetId: z.string().min(1),
  year: z.number().int(),
  postingDate: z.string(),
  softLockOverride: z.boolean().optional(),
  overrideReason: z.string().min(1).optional(),
  reason: z.string().min(1),
  actorRole: proActorRoleSchema.optional(),
}).refine((input) => !input.softLockOverride || Boolean(input.overrideReason?.trim()), { path: ['overrideReason'], message: 'overrideReason required for soft-lock override' });

const proDisposeAssetArgsSchema = z.object({
  assetId: z.string().min(1),
  disposalDate: z.string(),
  proceeds: z.number().nonnegative(),
  taxRate: z.union([z.literal(0), z.literal(7), z.literal(19)]).optional(),
  proceedsAccountNumber: z.string().min(1).optional(),
  softLockOverride: z.boolean().optional(),
  overrideReason: z.string().min(1).optional(),
  reason: z.string().min(1),
  actorRole: proActorRoleSchema.optional(),
}).refine((input) => !input.softLockOverride || Boolean(input.overrideReason?.trim()), { path: ['overrideReason'], message: 'overrideReason required for soft-lock override' });

const proExportDatevBuchungsstapelArgsSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  consultantNumber: z.union([z.string(), z.number().int()]).optional(),
  clientNumber: z.union([z.string(), z.number().int()]).optional(),
  fiscalYearStart: z.string().optional(),
  accountLength: z.number().int().min(4).max(8).optional(),
  encoding: z.enum(['cp1252', 'utf8-bom']).optional(),
  actorRole: proActorRoleSchema.optional(),
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
  unmappedAccounts: z.array(z.string()).optional(),
  blocking: z.boolean().optional(),
  lastDatevExportAt: z.string().optional(),
});

const proSetAccountingPolicyArgsSchema = z.object({ activeChart: ledgerChartSchema, vatMethod: z.enum(['soll', 'ist']) });
const proListAccountingPeriodsArgsSchema = z.object({ year: z.number().int().min(2000).max(2100) });
const proSetAccountingPeriodStatusArgsSchema = z.object({ period: accountingPeriodKeySchema, status: accountingPeriodStatusSchema, reason: z.string().trim().min(1) });
const proListAccountingAccountMappingsArgsSchema = z.object({ chart: ledgerChartSchema.optional() });
const proUpsertAccountingAccountMappingArgsSchema = z.object({ id: z.string().optional(), chart: ledgerChartSchema, role: z.enum(['accounts_receivable', 'accounts_payable', 'bank', 'revenue', 'expense', 'asset', 'output_vat', 'output_vat_deferred', 'input_vat']), accountNumber: z.string().min(1) });
const proUpsertVendorArgsSchema = z.object({ vendor: vendorSchema, reason: z.string().trim().min(1) });
const proUpsertIncomingInvoiceArgsSchema = z.object({ invoice: incomingInvoiceSchema, reason: z.string().trim().min(1) });
const proInvoiceAccountingArgsBaseSchema = z.object({ invoiceId: z.string().min(1), softLockOverride: z.boolean().optional(), overrideReason: z.string().min(1).optional() });
const proInvoiceAccountingArgsSchema = proInvoiceAccountingArgsBaseSchema.refine((input) => !input.softLockOverride || Boolean(input.overrideReason?.trim()), { path: ['overrideReason'], message: 'overrideReason required for soft-lock override' });
const proPostIncomingInvoiceAccountingArgsSchema = proInvoiceAccountingArgsBaseSchema.extend({ reason: z.string().trim().min(1) }).refine((input) => !input.softLockOverride || Boolean(input.overrideReason?.trim()), { path: ['overrideReason'], message: 'overrideReason required for soft-lock override' });
const proOutgoingInvoiceAccountingArgsSchema = proInvoiceAccountingArgsBaseSchema.extend({ reservationId: z.string().min(1) }).refine((input) => !input.softLockOverride || Boolean(input.overrideReason?.trim()), { path: ['overrideReason'], message: 'overrideReason required for soft-lock override' });
const proAllocateOpenItemPaymentArgsSchema = z.object({ payment: z.object({ paymentId: z.string().optional(), sourceType: z.enum(['bank_transaction', 'invoice_payment', 'manual']), sourceId: z.string().min(1), partyType: z.enum(['debtor', 'creditor']), partyId: z.string().optional(), paymentDate: z.string(), amount: z.number().positive(), bankAccountNumber: z.string().min(1), method: z.string().optional(), allocations: z.array(z.object({ openItemId: z.string().min(1), amount: z.number().positive() })), reason: z.string().trim().min(1), allocationEventId: z.string().trim().min(1), refund: z.boolean().optional() }) });
const proReverseDocumentAccountingArgsSchema = z.object({ documentType: z.enum(['outgoing_invoice', 'incoming_invoice']), documentId: z.string().min(1), reason: z.string().min(1), postingDate: z.string().optional(), softLockOverride: z.boolean().optional(), overrideReason: z.string().min(1).optional() }).refine((input) => !input.softLockOverride || Boolean(input.overrideReason?.trim()), { path: ['overrideReason'], message: 'overrideReason required for soft-lock override' });
const proAllocateRemainingPaymentArgsSchema = z.object({ paymentId: z.string().min(1), allocations: z.array(z.object({ openItemId: z.string().min(1), amount: z.number().positive() })), reason: z.string().trim().min(1), allocationEventId: z.string().trim().min(1) });
const proOpenItemPaymentSchema = z.object({ id: z.string(), tenantId: z.string(), partyType: z.enum(['debtor', 'creditor']), partyId: z.string().optional(), paymentDate: z.string(), amount: z.number(), bankAccountNumber: z.string(), method: z.string().optional(), sourceType: z.enum(['bank_transaction', 'invoice_payment', 'manual']), sourceId: z.string(), allocatedAmount: z.number(), residualAmount: z.number(), status: z.enum(['open', 'partially_allocated', 'overpaid', 'allocated', 'reversed']), journalEntryId: z.string().optional(), createdAt: z.string(), refund: z.boolean().optional(), creditedPaymentId: z.string().optional() });
const proOpenItemPaymentReversalSchema = z.object({ paymentId: z.string(), reversalEntryIds: z.array(z.string()), reopenedItemIds: z.array(z.string()) });
const proReverseOpenItemPaymentArgsSchema = z.object({ paymentId: z.string().min(1), reason: z.string().trim().min(1), postingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const proReallocateOpenItemPaymentArgsSchema = z.object({ paymentId: z.string().min(1), reason: z.string().trim().min(1), partyId: z.string().min(1), allocations: z.array(z.object({ openItemId: z.string().min(1), amount: z.number().positive() })).min(1), allocationEventId: z.string().trim().min(1) });
const proConfirmAccountingBackfillArgsSchema = z.object({ runId: z.string().min(1), confirmationHash: z.string().min(1), reason: z.string().min(1) });

export type RouteDef<Args extends z.ZodTypeAny, Result extends z.ZodTypeAny> = {
  channel: string;
  args: Args;
  result: Result;
};

export const ipcRoutes = {
  ...liteIpcRoutes,

  'accounts:list': {
    channel: 'accounts:list',
    args: z.undefined(),
    result: z.array(accountSchema),
  },
  'accounts:upsert': {
    channel: 'accounts:upsert',
    args: upsertAccountPayloadSchema,
    result: accountSchema,
  },

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
  'pro:getOpenRouterVlmConfig': {
    channel: 'pro:getOpenRouterVlmConfig',
    args: z.undefined(),
    result: openRouterVlmConfigSchema,
  },
  'pro:analyzeTransactionDocument': {
    channel: 'pro:analyzeTransactionDocument',
    args: openRouterVlmAnalyzeInputSchema,
    result: openRouterVlmAnalyzeResultSchema,
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
  'pro:getJournalEntryById': {
    channel: 'pro:getJournalEntryById',
    args: proGetJournalEntryByIdArgsSchema,
    result: journalEntryEntitySchema.nullable(),
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
  'pro:getReportingReport': {
    channel: 'pro:getReportingReport',
    args: proGetReportingReportArgsSchema,
    result: proGetReportingReportResultSchema,
  },
  'pro:listReportSnapshots': {
    channel: 'pro:listReportSnapshots',
    args: listReportSnapshotsArgsSchema,
    result: z.array(reportSnapshotRecordSchema),
  },
  'pro:saveReportSnapshot': {
    channel: 'pro:saveReportSnapshot',
    args: saveReportSnapshotArgsSchema,
    result: reportSnapshotRecordSchema,
  },
  'pro:getReportMappingHealth': {
    channel: 'pro:getReportMappingHealth',
    args: proGetReportMappingHealthArgsSchema,
    result: proGetReportMappingHealthResultSchema,
  },
  'pro:listReportMappingPositions': {
    channel: 'pro:listReportMappingPositions',
    args: proListReportMappingPositionsArgsSchema,
    result: z.array(reportMappingPositionSchema),
  },
  'pro:upsertReportMappingOverride': {
    channel: 'pro:upsertReportMappingOverride',
    args: proUpsertReportMappingOverrideArgsSchema,
    result: z.unknown(),
  },
  'pro:listAssets': {
    channel: 'pro:listAssets',
    args: z.undefined(),
    result: z.array(assetSchema),
  },
  'pro:upsertAsset': {
    channel: 'pro:upsertAsset',
    args: proUpsertAssetArgsSchema,
    result: assetSchema,
  },
  'pro:getDepreciationSchedule': {
    channel: 'pro:getDepreciationSchedule',
    args: proGetDepreciationScheduleArgsSchema,
    result: z.array(assetDepreciationScheduleEntrySchema),
  },
  'pro:runDepreciation': {
    channel: 'pro:runDepreciation',
    args: proRunDepreciationArgsSchema,
    result: z.object({
      asset: assetSchema,
      scheduleEntry: assetDepreciationScheduleEntrySchema,
      journalEntryId: z.string().min(1),
    }),
  },
  'pro:disposeAsset': {
    channel: 'pro:disposeAsset',
    args: proDisposeAssetArgsSchema,
    result: z.object({
      asset: assetSchema,
      residualBookValue: z.number().nonnegative(),
      gainLoss: z.number(),
      journalEntryId: z.string().min(1),
    }),
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
  'pro:getAccountingPolicy': { channel: 'pro:getAccountingPolicy', args: z.undefined(), result: accountingPolicySchema },
  'pro:setAccountingPolicy': { channel: 'pro:setAccountingPolicy', args: proSetAccountingPolicyArgsSchema, result: accountingPolicySchema },
  'pro:listAccountingPeriods': { channel: 'pro:listAccountingPeriods', args: proListAccountingPeriodsArgsSchema, result: z.array(accountingPeriodSchema) },
  'pro:setAccountingPeriodStatus': { channel: 'pro:setAccountingPeriodStatus', args: proSetAccountingPeriodStatusArgsSchema, result: accountingPeriodStatusChangeSchema },
  'pro:listAccountingAccountMappings': { channel: 'pro:listAccountingAccountMappings', args: proListAccountingAccountMappingsArgsSchema, result: z.array(accountingAccountMappingSchema) },
  'pro:upsertAccountingAccountMapping': { channel: 'pro:upsertAccountingAccountMapping', args: proUpsertAccountingAccountMappingArgsSchema, result: accountingAccountMappingSchema },
  'pro:listVendors': { channel: 'pro:listVendors', args: z.undefined(), result: z.array(vendorSchema) },
  'pro:upsertVendor': { channel: 'pro:upsertVendor', args: proUpsertVendorArgsSchema, result: vendorSchema },
  'pro:listIncomingInvoices': { channel: 'pro:listIncomingInvoices', args: z.undefined(), result: z.array(incomingInvoiceSchema) },
  'pro:upsertIncomingInvoice': { channel: 'pro:upsertIncomingInvoice', args: proUpsertIncomingInvoiceArgsSchema, result: incomingInvoiceSchema },
  'pro:listIncomingInvoiceDocuments': { channel: 'pro:listIncomingInvoiceDocuments', args: z.object({ invoiceId: z.string().min(1).optional() }), result: z.array(incomingInvoiceDocumentSchema) },
  'pro:uploadIncomingInvoiceDocument': { channel: 'pro:uploadIncomingInvoiceDocument', args: incomingInvoiceDocumentUploadSchema, result: incomingInvoiceDocumentSchema },
  'pro:downloadIncomingInvoiceDocument': { channel: 'pro:downloadIncomingInvoiceDocument', args: z.object({ documentId: z.string().min(1) }), result: incomingInvoiceDocumentDownloadSchema },
  'pro:reviewIncomingInvoiceDocument': { channel: 'pro:reviewIncomingInvoiceDocument', args: incomingInvoiceDocumentReviewSchema, result: incomingInvoiceDocumentSchema },
  'pro:previewOutgoingInvoiceAccounting': { channel: 'pro:previewOutgoingInvoiceAccounting', args: proInvoiceAccountingArgsSchema, result: accountingPostingPreviewSchema },
  'pro:postOutgoingInvoiceAccounting': { channel: 'pro:postOutgoingInvoiceAccounting', args: proOutgoingInvoiceAccountingArgsSchema, result: accountingPostingPreviewSchema },
  'pro:previewIncomingInvoiceAccounting': { channel: 'pro:previewIncomingInvoiceAccounting', args: proInvoiceAccountingArgsSchema, result: accountingPostingPreviewSchema },
  'pro:postIncomingInvoiceAccounting': { channel: 'pro:postIncomingInvoiceAccounting', args: proPostIncomingInvoiceAccountingArgsSchema, result: accountingPostingPreviewSchema },
  'pro:listOpenItems': { channel: 'pro:listOpenItems', args: z.undefined(), result: z.array(openItemSchema) },
  'pro:allocateOpenItemPayment': { channel: 'pro:allocateOpenItemPayment', args: proAllocateOpenItemPaymentArgsSchema, result: proOpenItemPaymentSchema },
  'pro:allocateRemainingPayment': { channel: 'pro:allocateRemainingPayment', args: proAllocateRemainingPaymentArgsSchema, result: proOpenItemPaymentSchema },
  'pro:listOpenItemPayments': { channel: 'pro:listOpenItemPayments', args: z.undefined(), result: z.array(proOpenItemPaymentSchema) },
  'pro:reverseOpenItemPayment': { channel: 'pro:reverseOpenItemPayment', args: proReverseOpenItemPaymentArgsSchema, result: proOpenItemPaymentReversalSchema },
  'pro:reallocateOpenItemPayment': { channel: 'pro:reallocateOpenItemPayment', args: proReallocateOpenItemPaymentArgsSchema, result: z.object({ reversal: proOpenItemPaymentReversalSchema, payment: proOpenItemPaymentSchema }) },
  'pro:reverseDocumentAccounting': { channel: 'pro:reverseDocumentAccounting', args: proReverseDocumentAccountingArgsSchema, result: z.object({ ok: z.literal(true), reversalEntryId: z.string() }) },
  'pro:previewAccountingBackfill': { channel: 'pro:previewAccountingBackfill', args: z.undefined(), result: accountingBackfillPreviewSchema },
  'pro:confirmAccountingBackfill': { channel: 'pro:confirmAccountingBackfill', args: proConfirmAccountingBackfillArgsSchema, result: accountingBackfillResultSchema },
  'pro:postAccountingSource': { channel: 'pro:postAccountingSource', args: proPostAccountingSourceArgsSchema, result: proAccountingSourcePostResultSchema },
  'pro:postAccountingCommand': { channel: 'pro:postAccountingCommand', args: proPostAccountingCommandArgsSchema, result: proAccountingSourcePostResultSchema },
  'pro:listAccountingSourceRuns': { channel: 'pro:listAccountingSourceRuns', args: z.undefined(), result: z.array(proAccountingSourceRunSchema) },
  'pro:getAccountingSourceRun': { channel: 'pro:getAccountingSourceRun', args: proGetAccountingSourceRunArgsSchema, result: proAccountingSourceRunSchema.nullable() },
  'eur:listItems': {
    channel: 'eur:listItems',
    args: eurListItemsArgsSchema,
    result: z.array(eurListItemSchema),
  },
  'eur:upsertClassification': {
    channel: 'eur:upsertClassification',
    args: eurUpsertClassificationArgsSchema,
    result: eurClassificationSchema,
  },
  'eur:saveCashFact': {
    channel: 'eur:saveCashFact',
    args: eurSaveCashFactArgsSchema,
    result: eurCashFactSchema,
  },
  'eur:listCashFacts': {
    channel: 'eur:listCashFacts',
    args: eurListFactsArgsSchema,
    result: z.array(eurCashFactSchema),
  },
  'eur:saveAnnexFact': {
    channel: 'eur:saveAnnexFact',
    args: eurSaveAnnexFactArgsSchema,
    result: eurAnnexFactSchema,
  },
  'eur:listAnnexFacts': {
    channel: 'eur:listAnnexFacts',
    args: eurListFactsArgsSchema,
    result: z.array(eurAnnexFactSchema),
  },
  'tax:auditExportPackage': {
    channel: 'tax:auditExportPackage',
    args: taxAuditExportPackageArgsSchema,
    result: taxAuditExportPackageResultSchema,
  },
  'tax:saveAuditExportPackage': {
    channel: 'tax:saveAuditExportPackage',
    args: taxAuditExportArtifactSchema,
    result: taxAuditExportPackageResultSchema,
  },

  'transactions:list': {
    channel: 'transactions:list',
    args: listTransactionsFiltersSchema,
    result: z.array(transactionSchema),
  },
  'transactions:findMatches': {
    channel: 'transactions:findMatches',
    args: findMatchesForTransactionSchema,
    result: findMatchesResultSchema,
  },
} as const satisfies Record<string, RouteDef<z.ZodTypeAny, z.ZodTypeAny>>;

export type IpcRouteKey = keyof typeof ipcRoutes;
export type IpcArgs<K extends IpcRouteKey> = z.infer<(typeof ipcRoutes)[K]['args']>;
export type IpcResult<K extends IpcRouteKey> = z.infer<(typeof ipcRoutes)[K]['result']>;
