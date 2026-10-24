import { z } from 'zod';
import { dunningDeliverySchema, resolveDunningDeliverySchema } from '@billme/server-core';
import { liteVatPeriodSchema, liteVatReportSchema, liteVatExportSchema, einvoiceParseRequestSchema, incomingEinvoiceSchema, xrechnungExportSchema } from '@billme/server-core';
import { serverRoleSchema, teamInviteResultSchema, teamSchema } from '@billme/server-core';
import { cliAccessRequestSchema, cliTokenSummarySchema, liteCashEntryInputSchema, liteCashEntrySchema, liteReceiptInputSchema, liteReceiptSchema, liteReceiptFileSchema, liteReceiptUploadSchema } from '@billme/server-core';
import { taxFilingRoutes } from './taxFiling';
import {
  deleteByIdSchema,
  documentRenderContextArgsSchema,
  documentRenderContextSchema,
  documentTemplateDefaultsSchema,
  documentTemplateRecordSchema,
  listDocumentTemplatesArgsSchema,
  setDefaultDocumentTemplateArgsSchema,
  upsertDocumentTemplateArgsSchema,
  setSettingsPayloadSchema,
  upsertAccountPayloadSchema,
  upsertArticlePayloadSchema,
  upsertClientPayloadSchema,
  financeImportCommitSchema,
  financeImportPreviewSchema,
  csvMappingSchema,
  upsertOfferPayloadSchema,
  upsertPayloadSchema,
  upsertRecurringPayloadSchema,
  invoiceSchema,
  offerSchema,
  paymentSchema,
  projectSchema,
  clientSchema,
  articleSchema,
  accountSchema,
  recurringProfileSchema,
  appSettingsSchema,
  eurGetReportArgsSchema,
  eurReportResultSchema,
  eurListItemsArgsSchema,
  eurListItemSchema,
  eurUpsertClassificationArgsSchema,
  eurClassificationSchema,
  eurExportCsvArgsSchema,
  eurExportPdfArgsSchema,
  eurExportPdfResultSchema,
  eurExportDatevArgsSchema,
  eurExportDatevResultSchema,
  eurRuleSchema,
  eurListRulesArgsSchema,
  eurUpsertRuleArgsSchema,
  eurDeleteRuleArgsSchema,
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

const documentChainCommonSchema = z.object({
  id: z.string().min(1),
  number: z.string().min(1),
  date: z.string().min(1),
  dueDate: z.string().min(1).optional(),
  servicePeriod: z.string().min(1).optional(),
  reason: z.string().min(1),
});
const documentChainCreateSchema = z.discriminatedUnion('operation', [
  documentChainCommonSchema.extend({ operation: z.literal('order_confirmation'), offerId: z.string().min(1) }),
  documentChainCommonSchema.extend({ operation: z.literal('delivery_note'), orderId: z.string().min(1), items: invoiceSchema.shape.items.optional() }),
  documentChainCommonSchema.extend({ operation: z.literal('settlement_invoice'), orderId: z.string().min(1), kind: z.enum(['advance_invoice', 'partial_invoice', 'final_invoice']), amount: z.number().finite().positive(), items: invoiceSchema.shape.items.optional() }),
  documentChainCommonSchema.extend({ operation: z.literal('correction'), invoiceId: z.string().min(1), kind: z.enum(['credit_note', 'cancellation_invoice']), amount: z.number().finite().positive().optional(), items: invoiceSchema.shape.items.optional() }),
  documentChainCommonSchema.extend({ operation: z.literal('revision'), invoiceId: z.string().min(1) }),
]);
const documentChainIssueCommonSchema = documentChainCommonSchema.omit({ number: true });
const documentChainIssueSchema = z.discriminatedUnion('operation', [
  documentChainIssueCommonSchema.extend({ operation: z.literal('order_confirmation'), offerId: z.string().min(1) }),
  documentChainIssueCommonSchema.extend({ operation: z.literal('delivery_note'), orderId: z.string().min(1), items: invoiceSchema.shape.items.optional() }),
  documentChainIssueCommonSchema.extend({ operation: z.literal('settlement_invoice'), orderId: z.string().min(1), kind: z.enum(['advance_invoice', 'partial_invoice', 'final_invoice']), amount: z.number().finite().positive(), items: invoiceSchema.shape.items.optional() }),
  documentChainIssueCommonSchema.extend({ operation: z.literal('correction'), invoiceId: z.string().min(1), kind: z.enum(['credit_note', 'cancellation_invoice']), amount: z.number().finite().positive().optional(), items: invoiceSchema.shape.items.optional() }),
  documentChainIssueCommonSchema.extend({ operation: z.literal('revision'), invoiceId: z.string().min(1) }),
]);
const documentChainListSchema = z.object({ rootDocumentId: z.string().min(1) });

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
  matchedManualEntryId: z.string().optional(), appliedAmountCents: z.number().int().optional(), unallocatedAmountCents: z.number().int().optional(),
  status: z.enum(['pending', 'booked']),
  dedupHash: z.string().optional(),
  importBatchId: z.string().optional(),
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
  appliedAmountCents: z.number().int().positive().optional(),
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

const pdfExportArgsSchema = z.object({
  kind: z.enum(['invoice', 'offer', 'dunning']),
  /** For `dunning` the invoice id. */
  id: z.string().min(1),
  level: z.number().int().positive().optional(),
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
  fileName: z.string().optional(),
  contentBase64: z.string().optional(),
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
        fee: z.number().optional(),
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
  /** Lines imported before as pending ("vorgemerkt") that the bank has booked since. */
  updated: z.number().int().optional(),
  skipped: z.number().int(),
  errors: z.array(z.object({ rowIndex: z.number().int(), message: z.string() })),
  fileSha256: z.string(),
});

export type RouteDef<Args extends z.ZodTypeAny, Result extends z.ZodTypeAny> = {
  channel: string;
  args: Args;
  result: Result;
};

export const ipcRoutes = {
  ...taxFilingRoutes,
  'vat:getReport': { channel: 'vat:getReport', args: liteVatPeriodSchema, result: liteVatReportSchema },
  'vat:exportCsv': { channel: 'vat:exportCsv', args: liteVatPeriodSchema, result: liteVatExportSchema },
  'vat:exportPdf': { channel: 'vat:exportPdf', args: liteVatPeriodSchema, result: liteVatExportSchema },
  'einvoice:parse': { channel: 'einvoice:parse', args: einvoiceParseRequestSchema, result: incomingEinvoiceSchema },
  'documents:exportXRechnung': { channel: 'documents:exportXRechnung', args: z.object({ id: z.string().min(1) }), result: xrechnungExportSchema },
  'cash:listEntries': { channel: 'cash:listEntries', args: z.undefined(), result: z.array(liteCashEntrySchema) },
  'cash:listReceipts': { channel: 'cash:listReceipts', args: z.undefined(), result: z.array(liteReceiptSchema) },
  'cash:saveEntry': { channel: 'cash:saveEntry', args: z.object({ entry: liteCashEntryInputSchema, expectedUpdatedAt: z.string().optional(), reason: z.string().trim().min(1) }), result: liteCashEntrySchema },
  'cash:saveReceipt': { channel: 'cash:saveReceipt', args: z.object({ receipt: liteReceiptInputSchema, expectedUpdatedAt: z.string().optional(), reason: z.string().trim().min(1) }), result: liteReceiptSchema },
  'cash:deleteEntry': { channel: 'cash:deleteEntry', args: z.object({ id: z.string().min(1), expectedUpdatedAt: z.string(), reason: z.string().trim().min(1) }), result: okSchema },
  'cash:matchEntry': { channel: 'cash:matchEntry', args: z.object({ id: z.string().min(1), transactionId: z.string().min(1), expectedCashDate: z.string(), transit: z.boolean().optional(), reason: z.string().trim().min(1) }), result: liteCashEntrySchema },
  'cash:unmatchEntry': { channel: 'cash:unmatchEntry', args: z.object({ id: z.string().min(1), reason: z.string().trim().min(1) }), result: liteCashEntrySchema },
  'cash:listClosedPeriods': { channel: 'cash:listClosedPeriods', args: z.undefined(), result: z.array(z.object({ period: z.string(), closedAt: z.string() })) },
  'cash:closePeriod': { channel: 'cash:closePeriod', args: z.object({ period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), reason: z.string().trim().min(1) }), result: z.object({ period: z.string(), closed: z.literal(true) }) },
  'cash:listFiles': { channel: 'cash:listFiles', args: z.object({ receiptId: z.string().min(1) }), result: z.array(liteReceiptFileSchema) },
  'cash:uploadFile': { channel: 'cash:uploadFile', args: liteReceiptUploadSchema.extend({ receiptId: z.string().min(1) }), result: liteReceiptFileSchema },
  'cash:downloadFile': { channel: 'cash:downloadFile', args: z.object({ id: z.string().min(1) }), result: liteReceiptFileSchema.extend({ contentBase64: z.string() }) },
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
  'invoices:savePayment': {
    channel: 'invoices:savePayment',
    args: z.object({ invoiceId: z.string().min(1), payment: paymentSchema, expectedPayment: paymentSchema.optional(), reason: z.string().trim().min(1) }),
    result: invoiceSchema,
  },
  'invoices:removePayment': {
    channel: 'invoices:removePayment',
    args: z.object({ invoiceId: z.string().min(1), expectedPayment: paymentSchema, reason: z.string().trim().min(1) }),
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
    result: z.array(offerSchema),
  },
  'offers:upsert': {
    channel: 'offers:upsert',
    args: upsertOfferPayloadSchema,
    result: offerSchema,
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
  'documents:chainCreate': {
    channel: 'documents:chainCreate',
    args: documentChainCreateSchema,
    result: invoiceSchema,
  },
  'documents:chainIssue': {
    channel: 'documents:chainIssue',
    args: documentChainIssueSchema,
    result: invoiceSchema,
  },
  'documents:chainList': {
    channel: 'documents:chainList',
    args: documentChainListSchema,
    result: z.array(invoiceSchema),
  },

  'documentTemplates:list': {
    channel: 'documentTemplates:list',
    args: listDocumentTemplatesArgsSchema,
    result: z.array(documentTemplateRecordSchema),
  },
  'documentTemplates:upsert': {
    channel: 'documentTemplates:upsert',
    args: upsertDocumentTemplateArgsSchema,
    result: documentTemplateRecordSchema,
  },
  'documentTemplates:delete': {
    channel: 'documentTemplates:delete',
    args: deleteByIdSchema,
    result: okSchema,
  },
  'documentTemplates:getDefaults': {
    channel: 'documentTemplates:getDefaults',
    args: z.undefined(),
    result: documentTemplateDefaultsSchema,
  },
  'documentTemplates:setDefault': {
    channel: 'documentTemplates:setDefault',
    args: setDefaultDocumentTemplateArgsSchema,
    result: okSchema,
  },
  'documents:renderContext': {
    channel: 'documents:renderContext',
    args: documentRenderContextArgsSchema,
    result: documentRenderContextSchema,
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
  'window:setTheme': {
    channel: 'window:set-theme',
    args: z.object({ theme: z.enum(['system', 'light', 'dark']) }),
    result: okSchema,
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
  'eur:exportDatev': {
    channel: 'eur:exportDatev',
    args: eurExportDatevArgsSchema,
    result: eurExportDatevResultSchema,
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

  'dunning:listDeliveries': { channel: 'dunning:listDeliveries', args: z.undefined(), result: z.array(dunningDeliverySchema) },
  'dunning:resolveDelivery': { channel: 'dunning:resolveDelivery', args: resolveDunningDeliverySchema, result: z.object({ ok: z.literal(true) }) },
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

  // Access for the `billme` CLI: a person confirms the code the CLI shows, and can revoke tokens later.
  'cliAccess:pending': {
    channel: 'cliAccess:pending',
    args: z.object({ code: z.string().min(1) }),
    result: cliAccessRequestSchema.nullable(),
  },
  'cliAccess:decide': {
    channel: 'cliAccess:decide',
    args: z.object({ code: z.string().min(1), approve: z.boolean() }),
    result: okSchema,
  },
  'cliAccess:list': {
    channel: 'cliAccess:list',
    args: z.undefined(),
    result: z.array(cliTokenSummarySchema),
  },
  'cliAccess:revoke': {
    channel: 'cliAccess:revoke',
    args: deleteByIdSchema,
    result: okSchema,
  },

  // The workspace's people (hosted server mode only; owners and admins).
  'team:list': {
    channel: 'team:list',
    args: z.undefined(),
    result: teamSchema,
  },
  'team:invite': {
    channel: 'team:invite',
    args: z.object({ email: z.string().email(), role: serverRoleSchema }),
    result: teamInviteResultSchema,
  },
  'team:revokeInvitation': {
    channel: 'team:revokeInvitation',
    args: deleteByIdSchema,
    result: okSchema,
  },
  'team:changeRole': {
    channel: 'team:changeRole',
    args: z.object({ userId: z.string().min(1), role: serverRoleSchema }),
    result: okSchema,
  },
  'team:remove': {
    channel: 'team:remove',
    args: z.object({ userId: z.string().min(1) }),
    result: okSchema,
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
