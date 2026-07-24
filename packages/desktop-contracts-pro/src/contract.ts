import { z } from 'zod';
import {
  deleteByIdSchema,
  listTemplatesParamsSchema,
  setActiveTemplatePayloadSchema,
  setSettingsPayloadSchema,
  templateKindSchema,
  templateSchema,
  upsertAccountPayloadSchema,
  upsertArticlePayloadSchema,
  upsertClientPayloadSchema,
  financeImportCommitSchema,
  financeImportPreviewSchema,
  csvMappingSchema,
  upsertOfferPayloadSchema,
  upsertPayloadSchema,
  upsertRecurringPayloadSchema,
  upsertTemplatePayloadSchema,
  invoiceSchema,
  projectSchema,
  clientSchema,
  articleSchema,
  accountSchema,
  recurringProfileSchema,
  appSettingsSchema,
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
  eurGetReportArgsSchema,
  eurReportResultSchema,
  eurListItemsArgsSchema,
  eurListItemSchema,
  eurUpsertClassificationArgsSchema,
  eurClassificationSchema,
  eurExportCsvArgsSchema,
  eurExportPdfArgsSchema,
  eurExportPdfResultSchema,
  eurRuleSchema,
  eurListRulesArgsSchema,
  eurUpsertRuleArgsSchema,
  eurDeleteRuleArgsSchema,
  accountSuggestionRuleSchema,
  proListAccountSuggestionRulesArgsSchema,
  proUpsertAccountSuggestionRuleArgsSchema,
  proDeleteAccountSuggestionRuleArgsSchema,
  assetSchema,
  assetUpsertSchema,
  assetDepreciationScheduleEntrySchema,
} from './schemas';

const okSchema = z.object({ ok: z.literal(true) });
const windowMaximizedStateSchema = z.object({
  isMaximized: z.boolean(),
});
const updateStatusSchema = z.object({
  status: z.enum(['idle', 'checking', 'available', 'downloading', 'downloaded', 'error']),
  version: z.string().optional(),
  error: z.string().optional(),
  progress: z.number().optional(),
});

const deleteWithReasonSchema = z.object({
  id: z.string().min(1),
  reason: z.string().min(1),
});

const createFromClientSchema = z.object({
  kind: z.enum(['invoice', 'offer']),
  clientId: z.string().min(1),
});

const numberKindSchema = z.enum(['invoice', 'offer', 'customer']);
const numbersReserveArgsSchema = z.object({
  kind: numberKindSchema,
});
const numbersReserveResultSchema = z.object({
  reservationId: z.string().min(1),
  number: z.string().min(1),
});
const numbersReleaseArgsSchema = z.object({
  reservationId: z.string().min(1),
});
const numbersFinalizeArgsSchema = z.object({
  reservationId: z.string().min(1),
  documentId: z.string().min(1),
});

const convertOfferToInvoiceSchema = z.object({
  offerId: z.string().min(1),
});

const sendEmailSchema = z.object({
  documentType: z.enum(['invoice', 'offer']),
  documentId: z.string().min(1),
  recipientEmail: z.string().email(),
  recipientName: z.string().min(1),
  subject: z.string().min(1),
  bodyText: z.string().min(1),
});

const sendEmailResultSchema = z.object({
  success: z.boolean(),
  messageId: z.string().optional(),
  error: z.string().optional(),
});

const testEmailConfigSchema = z.object({
  provider: z.enum(['smtp', 'resend']),
  smtpHost: z.string().optional(),
  smtpPort: z.number().optional(),
  smtpSecure: z.boolean().optional(),
  smtpUser: z.string().optional(),
  smtpPassword: z.string().optional(),
  resendApiKey: z.string().optional(),
});

const transactionSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  date: z.string(),
  amount: z.number(),
  type: z.enum(['income', 'expense']),
  counterparty: z.string(),
  purpose: z.string(),
  linkedInvoiceId: z.string().optional(),
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

const linkTransactionSchema = z.object({
  transactionId: z.string().min(1),
  invoiceId: z.string().min(1),
});

const linkTransactionResultSchema = z.object({
  success: z.boolean(),
  invoice: invoiceSchema.optional(),
});

const unlinkTransactionSchema = z.object({
  transactionId: z.string().min(1),
});

const listTransactionsFiltersSchema = z.object({
  accountId: z.string().optional(),
  type: z.enum(['income', 'expense']).optional(),
  linkedOnly: z.boolean().optional(),
  unlinkedOnly: z.boolean().optional(),
});

const dunningRunResultSchema = z.object({
  success: z.boolean(),
  result: z
    .object({
      processedInvoices: z.number(),
      emailsSent: z.number(),
      feesApplied: z.number(),
      errors: z.array(
        z.object({
          invoiceNumber: z.string(),
          error: z.string(),
        }),
      ),
    })
    .optional(),
  error: z.string().optional(),
});

const invoiceDunningStatusSchema = z.object({
  invoiceId: z.string().min(1),
});

const dunningHistoryEntrySchema = z.object({
  id: z.string(),
  invoiceId: z.string(),
  invoiceNumber: z.string(),
  dunningLevel: z.number(),
  daysOverdue: z.number(),
  feeApplied: z.number(),
  emailSent: z.boolean(),
  emailLogId: z.string().optional(),
  processedAt: z.string(),
  createdAt: z.string(),
});

const invoiceDunningStatusResultSchema = z.object({
  currentLevel: z.number(),
  daysOverdue: z.number(),
  lastReminderSent: z.string().optional(),
  totalFeesApplied: z.number(),
  history: z.array(dunningHistoryEntrySchema),
});

const recurringManualRunResultSchema = z.object({
  success: z.boolean(),
  result: z
    .object({
      generated: z.number(),
      deactivated: z.number(),
      errors: z.array(
        z.object({
          profileName: z.string(),
          error: z.string(),
        }),
      ),
    })
    .optional(),
  error: z.string().optional(),
});

const projectsListArgsSchema = z.object({
  clientId: z.string().min(1).optional(),
  includeArchived: z.boolean().optional(),
});

const projectsGetArgsSchema = z.object({
  id: z.string().min(1),
});

const projectsUpsertArgsSchema = z.object({
  reason: z.string().min(1),
  project: projectSchema,
});

const getActiveTemplateParamsSchema = z.object({
  kind: templateKindSchema,
});

const auditVerifyResultSchema = z.object({
  ok: z.boolean(),
  errors: z.array(z.object({ sequence: z.number(), message: z.string() })),
  count: z.number(),
  headHash: z.string().nullable(),
});

const portalHealthArgsSchema = z.object({
  baseUrl: z.string().min(1),
});

const portalHealthResultSchema = z.object({
  ok: z.boolean(),
  ts: z.string(),
});

const portalPublishOfferArgsSchema = z.object({
  offerId: z.string().min(1),
  expiresAt: z.string().optional(),
});

const portalPublishInvoiceArgsSchema = z.object({
  invoiceId: z.string().min(1),
  expiresAt: z.string().optional(),
});

const portalPublishOfferResultSchema = z.object({
  ok: z.literal(true),
  token: z.string().min(16),
  publicUrl: z.string().min(1),
});

const portalDecisionSchema = z.object({
  decidedAt: z.string(),
  decision: z.enum(['accepted', 'declined']),
  acceptedName: z.string(),
  acceptedEmail: z.string(),
  decisionTextVersion: z.string(),
});

const portalSyncOfferStatusArgsSchema = z.object({
  offerId: z.string().min(1),
});

const portalSyncOfferStatusResultSchema = z.object({
  ok: z.literal(true),
  decision: portalDecisionSchema.nullable(),
  updated: z.boolean(),
});

const portalCustomerLinkArgsSchema = z.object({
  customerRef: z.string().min(1),
  customerLabel: z.string().optional(),
  expiresInDays: z.number().int().positive().max(365).optional(),
});

const portalCustomerLinkResultSchema = z.object({
  ok: z.literal(true),
  token: z.string().min(16),
  publicUrl: z.string().min(1),
  expiresAt: z.string().min(1),
});

const listImportBatchesArgsSchema = z.object({
  accountId: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

const importBatchSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  profile: z.string(),
  fileName: z.string(),
  fileSha256: z.string(),
  mappingJson: z.unknown(),
  importedCount: z.number().int(),
  skippedCount: z.number().int(),
  errorCount: z.number().int(),
  createdAt: z.string(),
  rolledBackAt: z.string().optional(),
  rollbackReason: z.string().optional(),
});

const getImportBatchDetailsArgsSchema = z.object({
  batchId: z.string().min(1),
});

const importBatchDetailsSchema = z.object({
  batch: importBatchSchema,
  transactions: z.array(
    z.object({
      id: z.string(),
      date: z.string(),
      amount: z.number(),
      type: z.enum(['income', 'expense']),
      counterparty: z.string(),
      purpose: z.string(),
      linkedInvoiceId: z.string().optional(),
      status: z.enum(['pending', 'booked']),
    }),
  ),
  canRollback: z.boolean(),
  linkedInvoiceCount: z.number().int(),
});

const rollbackImportBatchArgsSchema = z.object({
  batchId: z.string().min(1),
  reason: z.string().min(1),
});

const rollbackImportBatchResultSchema = z.object({
  success: z.boolean(),
  deletedCount: z.number().int(),
});

const secretKeySchema = z.enum(['smtp.password', 'portal.apiKey', 'resend.apiKey']);

const secretGetSchema = z.object({ key: secretKeySchema });
const secretSetSchema = z.object({ key: secretKeySchema, value: z.string().min(1) });
const secretDeleteSchema = z.object({ key: secretKeySchema });
const secretHasSchema = z.object({ key: secretKeySchema });

const dbRestoreSchema = z.object({ path: z.string().min(1) });
const dbBackupResultSchema = z.object({ path: z.string().min(1) });
const dbRestoreResultSchema = z.object({ ok: z.boolean(), verification: auditVerifyResultSchema });
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

const pdfExportArgsSchema = z.object({
  kind: z.enum(['invoice', 'offer']),
  id: z.string().min(1),
});
const pdfExportResultSchema = z.object({
  path: z.string().min(1),
});

const shellOpenPathArgsSchema = z.object({
  path: z.string().min(1),
});
const shellOpenPathResultSchema = z.object({
  ok: z.literal(true),
});

const shellOpenExternalArgsSchema = z.object({
  url: z.string().min(1),
});
const shellOpenExternalResultSchema = z.object({
  ok: z.literal(true),
});

const dialogPickCsvArgsSchema = z.object({
  title: z.string().optional(),
});
const dialogPickCsvResultSchema = z.object({
  path: z.string().nullable(),
});

const financeImportPreviewResultSchema = z.object({
  path: z.string(),
  fileName: z.string(),
  fileSha256: z.string(),
  delimiter: z.string(),
  headers: z.array(z.string()),
  profile: z.enum(['fints', 'paypal', 'stripe', 'generic']),
  suggestedMapping: csvMappingSchema,
  rows: z.array(
    z.object({
      rowIndex: z.number().int(),
      raw: z.record(z.string(), z.string()),
      parsed: z.object({
        date: z.string().optional(),
        amount: z.number().optional(),
        type: z.enum(['income', 'expense']).optional(),
        counterparty: z.string().optional(),
        purpose: z.string().optional(),
        status: z.enum(['pending', 'booked']).optional(),
        externalId: z.string().optional(),
        currency: z.string().optional(),
      }),
      errors: z.array(z.string()),
      dedupHash: z.string().optional(),
    }),
  ),
  stats: z.object({
    totalRows: z.number().int(),
    previewRows: z.number().int(),
    validRows: z.number().int(),
    errorRows: z.number().int(),
  }),
});

const financeImportCommitResultSchema = z.object({
  batchId: z.string(),
  imported: z.number().int(),
  skipped: z.number().int(),
  errors: z.array(z.object({ rowIndex: z.number().int(), message: z.string() })),
  fileSha256: z.string(),
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
  accountNumbers: z.array(z.string().min(1)).optional(),
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
  reason: z.string().min(1),
  actorRole: proActorRoleSchema,
});

const proDisposeAssetArgsSchema = z.object({
  assetId: z.string().min(1),
  disposalDate: z.string(),
  proceeds: z.number().nonnegative(),
  reason: z.string().min(1),
  actorRole: proActorRoleSchema,
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

export type RouteDef<Args extends z.ZodTypeAny, Result extends z.ZodTypeAny> = {
  channel: string;
  args: Args;
  result: Result;
};

export const ipcRoutes = {
  'invoices:list': {
    channel: 'invoices:list',
    args: z.undefined(),
    result: z.array(invoiceSchema),
  },
  'invoices:upsert': {
    channel: 'invoices:upsert',
    args: upsertPayloadSchema,
    result: invoiceSchema,
  },
  'invoices:delete': {
    channel: 'invoices:delete',
    args: deleteWithReasonSchema,
    result: okSchema,
  },

  'offers:list': {
    channel: 'offers:list',
    args: z.undefined(),
    result: z.array(invoiceSchema),
  },
  'offers:upsert': {
    channel: 'offers:upsert',
    args: upsertOfferPayloadSchema,
    result: invoiceSchema,
  },
  'offers:delete': {
    channel: 'offers:delete',
    args: deleteWithReasonSchema,
    result: okSchema,
  },

  'clients:list': {
    channel: 'clients:list',
    args: z.undefined(),
    result: z.array(clientSchema),
  },
  'clients:upsert': {
    channel: 'clients:upsert',
    args: upsertClientPayloadSchema,
    result: clientSchema,
  },
  'clients:delete': {
    channel: 'clients:delete',
    args: deleteByIdSchema,
    result: okSchema,
  },

  'projects:list': {
    channel: 'projects:list',
    args: projectsListArgsSchema,
    result: z.array(projectSchema),
  },
  'projects:get': {
    channel: 'projects:get',
    args: projectsGetArgsSchema,
    result: projectSchema.nullable(),
  },
  'projects:upsert': {
    channel: 'projects:upsert',
    args: projectsUpsertArgsSchema,
    result: projectSchema,
  },
  'projects:archive': {
    channel: 'projects:archive',
    args: deleteWithReasonSchema,
    result: projectSchema,
  },

  'articles:list': {
    channel: 'articles:list',
    args: z.undefined(),
    result: z.array(articleSchema),
  },
  'articles:upsert': {
    channel: 'articles:upsert',
    args: upsertArticlePayloadSchema,
    result: articleSchema,
  },
  'articles:delete': {
    channel: 'articles:delete',
    args: deleteByIdSchema,
    result: okSchema,
  },

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
  'accounts:delete': {
    channel: 'accounts:delete',
    args: deleteByIdSchema,
    result: okSchema,
  },

  'recurring:list': {
    channel: 'recurring:list',
    args: z.undefined(),
    result: z.array(recurringProfileSchema),
  },
  'recurring:upsert': {
    channel: 'recurring:upsert',
    args: upsertRecurringPayloadSchema,
    result: recurringProfileSchema,
  },
  'recurring:delete': {
    channel: 'recurring:delete',
    args: deleteByIdSchema,
    result: okSchema,
  },

  'settings:get': {
    channel: 'settings:get',
    args: z.undefined(),
    result: appSettingsSchema.nullable(),
  },
  'settings:set': {
    channel: 'settings:set',
    args: setSettingsPayloadSchema,
    result: okSchema,
  },

  'numbers:reserve': {
    channel: 'numbers:reserve',
    args: numbersReserveArgsSchema,
    result: numbersReserveResultSchema,
  },
  'numbers:release': {
    channel: 'numbers:release',
    args: numbersReleaseArgsSchema,
    result: okSchema,
  },
  'numbers:finalize': {
    channel: 'numbers:finalize',
    args: numbersFinalizeArgsSchema,
    result: okSchema,
  },

  'documents:createFromClient': {
    channel: 'documents:createFromClient',
    args: createFromClientSchema,
    result: invoiceSchema,
  },
  'documents:convertOfferToInvoice': {
    channel: 'documents:convertOfferToInvoice',
    args: convertOfferToInvoiceSchema,
    result: invoiceSchema,
  },

  'templates:list': {
    channel: 'templates:list',
    args: listTemplatesParamsSchema,
    result: z.array(templateSchema),
  },
  'templates:active': {
    channel: 'templates:active',
    args: getActiveTemplateParamsSchema,
    result: templateSchema.nullable(),
  },
  'templates:upsert': {
    channel: 'templates:upsert',
    args: upsertTemplatePayloadSchema,
    result: templateSchema,
  },
  'templates:delete': {
    channel: 'templates:delete',
    args: deleteByIdSchema,
    result: okSchema,
  },
  'templates:setActive': {
    channel: 'templates:setActive',
    args: setActiveTemplatePayloadSchema,
    result: okSchema,
  },

  'audit:verify': {
    channel: 'audit:verify',
    args: z.undefined(),
    result: auditVerifyResultSchema,
  },
  'audit:exportCsv': {
    channel: 'audit:exportCsv',
    args: z.undefined(),
    result: z.string(),
  },

  'pdf:export': {
    channel: 'pdf:export',
    args: pdfExportArgsSchema,
    result: pdfExportResultSchema,
  },

  'window:minimize': {
    channel: 'window:minimize',
    args: z.undefined(),
    result: okSchema,
  },
  'window:toggleMaximize': {
    channel: 'window:toggle-maximize',
    args: z.undefined(),
    result: okSchema,
  },
  'window:close': {
    channel: 'window:close',
    args: z.undefined(),
    result: okSchema,
  },
  'window:isMaximized': {
    channel: 'window:is-maximized',
    args: z.undefined(),
    result: windowMaximizedStateSchema,
  },

  'shell:openPath': {
    channel: 'shell:openPath',
    args: shellOpenPathArgsSchema,
    result: shellOpenPathResultSchema,
  },
  'shell:openExportsDir': {
    channel: 'shell:openExportsDir',
    args: z.undefined(),
    result: shellOpenPathResultSchema,
  },
  'shell:openExternal': {
    channel: 'shell:openExternal',
    args: shellOpenExternalArgsSchema,
    result: shellOpenExternalResultSchema,
  },

  'dialog:pickCsv': {
    channel: 'dialog:pickCsv',
    args: dialogPickCsvArgsSchema,
    result: dialogPickCsvResultSchema,
  },

  'finance:importPreview': {
    channel: 'finance:importPreview',
    args: financeImportPreviewSchema,
    result: financeImportPreviewResultSchema,
  },
  'finance:importCommit': {
    channel: 'finance:importCommit',
    args: financeImportCommitSchema,
    result: financeImportCommitResultSchema,
  },
  'finance:listImportBatches': {
    channel: 'finance:listImportBatches',
    args: listImportBatchesArgsSchema,
    result: z.array(importBatchSchema),
  },
  'finance:getImportBatchDetails': {
    channel: 'finance:getImportBatchDetails',
    args: getImportBatchDetailsArgsSchema,
    result: importBatchDetailsSchema,
  },
  'finance:rollbackImportBatch': {
    channel: 'finance:rollbackImportBatch',
    args: rollbackImportBatchArgsSchema,
    result: rollbackImportBatchResultSchema,
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

  'eur:getReport': {
    channel: 'eur:getReport',
    args: eurGetReportArgsSchema,
    result: eurReportResultSchema,
  },
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
  'eur:exportCsv': {
    channel: 'eur:exportCsv',
    args: eurExportCsvArgsSchema,
    result: z.string(),
  },
  'eur:exportPdf': {
    channel: 'eur:exportPdf',
    args: eurExportPdfArgsSchema,
    result: eurExportPdfResultSchema,
  },
  'eur:listRules': {
    channel: 'eur:listRules',
    args: eurListRulesArgsSchema,
    result: z.array(eurRuleSchema),
  },
  'eur:upsertRule': {
    channel: 'eur:upsertRule',
    args: eurUpsertRuleArgsSchema,
    result: eurRuleSchema,
  },
  'eur:deleteRule': {
    channel: 'eur:deleteRule',
    args: eurDeleteRuleArgsSchema,
    result: okSchema,
  },

  'portal:health': {
    channel: 'portal:health',
    args: portalHealthArgsSchema,
    result: portalHealthResultSchema,
  },
  'portal:publishOffer': {
    channel: 'portal:publishOffer',
    args: portalPublishOfferArgsSchema,
    result: portalPublishOfferResultSchema,
  },
  'portal:publishInvoice': {
    channel: 'portal:publishInvoice',
    args: portalPublishInvoiceArgsSchema,
    result: portalPublishOfferResultSchema,
  },
  'portal:syncOfferStatus': {
    channel: 'portal:syncOfferStatus',
    args: portalSyncOfferStatusArgsSchema,
    result: portalSyncOfferStatusResultSchema,
  },
  'portal:createCustomerAccessLink': {
    channel: 'portal:createCustomerAccessLink',
    args: portalCustomerLinkArgsSchema,
    result: portalCustomerLinkResultSchema,
  },
  'portal:rotateCustomerAccessLink': {
    channel: 'portal:rotateCustomerAccessLink',
    args: portalCustomerLinkArgsSchema,
    result: portalCustomerLinkResultSchema,
  },

  'secrets:get': {
    channel: 'secrets:get',
    args: secretGetSchema,
    result: z.string().nullable(),
  },
  'secrets:set': {
    channel: 'secrets:set',
    args: secretSetSchema,
    result: z.void(),
  },
  'secrets:delete': {
    channel: 'secrets:delete',
    args: secretDeleteSchema,
    result: z.boolean(),
  },
  'secrets:has': {
    channel: 'secrets:has',
    args: secretHasSchema,
    result: z.boolean(),
  },

  'db:backup': {
    channel: 'db:backup',
    args: z.undefined(),
    result: dbBackupResultSchema,
  },
  'db:restore': {
    channel: 'db:restore',
    args: dbRestoreSchema,
    result: dbRestoreResultSchema,
  },
  'tax:auditExportPackage': {
    channel: 'tax:auditExportPackage',
    args: taxAuditExportPackageArgsSchema,
    result: taxAuditExportPackageResultSchema,
  },

  'email:send': {
    channel: 'email:send',
    args: sendEmailSchema,
    result: sendEmailResultSchema,
  },
  'email:testConfig': {
    channel: 'email:testConfig',
    args: testEmailConfigSchema,
    result: sendEmailResultSchema,
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
  'transactions:link': {
    channel: 'transactions:link',
    args: linkTransactionSchema,
    result: linkTransactionResultSchema,
  },
  'transactions:unlink': {
    channel: 'transactions:unlink',
    args: unlinkTransactionSchema,
    result: z.object({ success: z.boolean() }),
  },

  'dunning:manualRun': {
    channel: 'dunning:manualRun',
    args: z.undefined(),
    result: dunningRunResultSchema,
  },
  'dunning:getInvoiceStatus': {
    channel: 'dunning:getInvoiceStatus',
    args: invoiceDunningStatusSchema,
    result: invoiceDunningStatusResultSchema,
  },

  'recurring:manualRun': {
    channel: 'recurring:manualRun',
    args: z.undefined(),
    result: recurringManualRunResultSchema,
  },

  'updater:getStatus': {
    channel: 'updater:get-status',
    args: z.undefined(),
    result: updateStatusSchema,
  },
  'updater:downloadUpdate': {
    channel: 'updater:download-update',
    args: z.undefined(),
    result: okSchema,
  },
  'updater:quitAndInstall': {
    channel: 'updater:quit-and-install',
    args: z.undefined(),
    result: okSchema,
  },
} as const satisfies Record<string, RouteDef<z.ZodTypeAny, z.ZodTypeAny>>;

export type IpcRouteKey = keyof typeof ipcRoutes;
export type IpcArgs<K extends IpcRouteKey> = z.infer<(typeof ipcRoutes)[K]['args']>;
export type IpcResult<K extends IpcRouteKey> = z.infer<(typeof ipcRoutes)[K]['result']>;
