import { z } from 'zod';

const isAllowedPortalBaseUrl = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return true;
  try {
    const parsed = new URL(trimmed);
    const hostname = parsed.hostname.toLowerCase();
    const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLocalhost);
  } catch {
    return false;
  }
};

export const invoiceItemSchema = z.object({
  kind: z.enum(['item', 'time', 'optional', 'text', 'group', 'summary']).optional(),
  description: z.string(),
  quantity: z.number(),
  price: z.number(),
  total: z.number(),
  articleId: z.string().optional(),
  category: z.string().optional(),
  unit: z.string().optional(),
  discountPercent: z.number().min(0).max(100).optional(),
  taxRate: z.number().min(0).optional(),
  note: z.string().optional(),
  optionNote: z.string().optional(),
  date: z.string().optional(),
  durationMinutes: z.number().nonnegative().optional(),
  groupId: z.string().optional(),
  summaryScope: z.enum(['running', 'group']).optional(),
  summaryMetric: z.enum(['amount', 'quantity']).optional(),
  summaryUnit: z.string().optional(),
});

export const paymentSchema = z.object({
  id: z.string(),
  date: z.string(),
  amount: z.number(),
  method: z.string(),
});

export const invoiceTaxModeSchema = z.enum([
  'standard_vat',
  'small_business_19_ustg',
  'reverse_charge_13b',
  'intra_eu_supply_6a',
  'intra_eu_service_reverse_charge',
  'export_third_country',
  'vat_exempt_4_ustg',
  'non_taxable_outside_scope',
]);

export const invoiceTaxMetaSchema = z.object({
  legalReference: z.string().optional(),
  exemptionReasonOverride: z.string().optional(),
  buyerVatId: z.string().optional(),
  sellerVatId: z.string().optional(),
  defaultVatRate: z.number().min(0).max(100).optional(),
  destinationVatRate: z.number().min(0).max(99.99).optional(),
  buyerCountryCode: z.string().length(2).optional(),
  sellerCountryCode: z.string().length(2).optional(),
  buyerType: z.enum(['business', 'consumer']).optional(),
  vatIdValidation: z.enum(['valid', 'invalid', 'unavailable', 'manual_override']).optional(),
  vatIdValidationAt: z.string().optional(),
  taxRuleConfirmed: z.boolean().optional(),
  datevSachverhaltLl: z.string().regex(/^[1-9]\d{0,2}$/).optional(),
  datevEvidenceType: z.string().min(1).optional(),
  datevEvidenceReference: z.string().min(1).optional(),
});

export const invoiceTaxSnapshotSchema = z.object({
  vatRateApplied: z.number(),
  vatAmount: z.number(),
  netAmount: z.number(),
  grossAmount: z.number(),
  einvoiceCategoryCode: z.enum(['S', 'E', 'AE', 'O', 'K', 'G']),
  label: z.string().optional(),
  vatBreakdown: z.array(z.object({
    rate: z.number(),
    netAmount: z.number(),
    vatAmount: z.number(),
  })).optional(),
  taxNotice: z.string().optional(),
  taxRuleConfirmed: z.boolean().optional(),
});

export const invoiceSchema = z.object({
  id: z.string(),
  clientId: z.string().optional(),
  clientNumber: z.string().optional(),
  projectId: z.string().optional(),
  number: z.string(),
  numberReservationId: z.string().optional(),
  client: z.string(),
  clientEmail: z.string(),
  clientAddress: z.string().optional(),
  billingAddressJson: z.unknown().optional(),
  shippingAddressJson: z.unknown().optional(),
  taxMode: invoiceTaxModeSchema.optional(),
  taxMeta: invoiceTaxMetaSchema.optional(),
  taxSnapshot: invoiceTaxSnapshotSchema.optional(),
  shareToken: z.string().nullable().optional(),
  sharePublishedAt: z.string().nullable().optional(),
  shareDecision: z.enum(['accepted', 'declined']).nullable().optional(),
  shareDecisionTextVersion: z.string().nullable().optional(),
  acceptedAt: z.string().nullable().optional(),
  acceptedBy: z.string().nullable().optional(),
  acceptedEmail: z.string().nullable().optional(),
  acceptedUserAgent: z.string().nullable().optional(),
  date: z.string(),
  dueDate: z.string(),
  servicePeriod: z.string().optional(),
  amount: z.number(),
  status: z.enum(['paid', 'open', 'overdue', 'draft', 'cancelled']),
  dunningLevel: z.number().optional(),
  items: z.array(invoiceItemSchema),
  payments: z.array(paymentSchema),
  history: z.array(z.object({ date: z.string(), action: z.string() })).optional(),
});

export const upsertPayloadSchema = z.object({
  reason: z.string().min(1),
  invoice: invoiceSchema,
});

export const upsertOfferPayloadSchema = z.object({
  reason: z.string().min(1),
  offer: invoiceSchema,
});

export const activitySchema = z.object({
  id: z.string(),
  type: z.enum(['note', 'email', 'call', 'meeting']),
  content: z.string(),
  date: z.string(),
  author: z.string(),
});

export const projectSchema = z.object({
  id: z.string(),
  clientId: z.string().optional(),
  code: z.string().optional(),
  name: z.string(),
  status: z.enum(['active', 'completed', 'planned', 'on_hold', 'inactive', 'archived']),
  budget: z.number(),
  startDate: z.string(),
  endDate: z.string().optional(),
  description: z.string().optional(),
  archivedAt: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
});

export const clientSchema = z.object({
  id: z.string(),
  customerNumber: z.string().optional(),
  company: z.string(),
  contactPerson: z.string(),
  email: z.string(),
  phone: z.string(),
  address: z.string(),
  status: z.enum(['active', 'inactive']),
  avatar: z.string().optional(),
  tags: z.array(z.string()),
  notes: z.string(),
  taxProfile: z.object({
    type: z.enum(['business', 'consumer']),
    countryCode: z.string().optional(),
    vatId: z.string().optional(),
    vatIdValidation: z.enum(['valid', 'invalid', 'unavailable', 'manual_override']).optional(),
    vatIdValidationAt: z.string().optional(),
  }).optional(),
  projects: z.array(projectSchema),
  activities: z.array(activitySchema),
  addresses: z
    .array(
      z.object({
        id: z.string(),
        clientId: z.string(),
        label: z.string(),
        kind: z.enum(['billing', 'shipping', 'other']),
        company: z.string().optional(),
        contactPerson: z.string().optional(),
        street: z.string(),
        line2: z.string().optional(),
        zip: z.string(),
        city: z.string(),
        country: z.string(),
        isDefaultBilling: z.boolean().optional(),
        isDefaultShipping: z.boolean().optional(),
      }),
    )
    .optional(),
  emails: z
    .array(
      z.object({
        id: z.string(),
        clientId: z.string(),
        label: z.string(),
        kind: z.enum(['general', 'billing', 'shipping', 'other']),
        email: z.string(),
        isDefaultGeneral: z.boolean().optional(),
        isDefaultBilling: z.boolean().optional(),
      }),
    )
    .optional(),
});

export const articleSchema = z.object({
  id: z.string(),
  sku: z.string().optional(),
  title: z.string(),
  description: z.string(),
  price: z.number(),
  unit: z.string(),
  category: z.string(),
  taxRate: z.number(),
});

export const transactionSchema = z.object({
  id: z.string(),
  date: z.string(),
  amount: z.number(),
  type: z.enum(['income', 'expense']),
  counterparty: z.string(),
  purpose: z.string(),
  linkedInvoiceId: z.string().optional(),
  status: z.enum(['pending', 'booked', 'open', 'matched']),
  accountId: z.string().optional(),
  dedupHash: z.string().optional(),
  importBatchId: z.string().optional(),
  suggestedAccountNumber: z.string().optional(),
  suggestionReason: z.string().optional(),
  suggestionLayer: z.enum(['rule', 'counterparty', 'bayes', 'keyword', 'fallback']).optional(),
  suggestionConfidence: z.number().optional(),
});

export const eurLineSchema = z.object({
  id: z.string(),
  taxYear: z.number().int(),
  kennziffer: z.string().optional(),
  label: z.string(),
  kind: z.enum(['income', 'expense', 'computed']),
  exportable: z.boolean(),
  sortOrder: z.number().int(),
  computedFromIds: z.array(z.string()),
  sourceVersion: z.string(),
});

export const eurClassificationSchema = z.object({
  id: z.string(),
  sourceType: z.enum(['transaction', 'invoice']),
  sourceId: z.string(),
  taxYear: z.number().int(),
  eurLineId: z.string().optional(),
  excluded: z.boolean(),
  vatMode: z.enum(['none', 'default']),
  vatRate: z.number().min(0).max(100).optional(),
  note: z.string().optional(),
  updatedAt: z.string(),
});

export const eurReportRowSchema = z.object({
  lineId: z.string(),
  kennziffer: z.string().optional(),
  providerPath: z.string().optional(),
  label: z.string(),
  kind: z.enum(['income', 'expense', 'computed']),
  exportable: z.boolean(),
  total: z.number(),
  sortOrder: z.number().int(),
});

export const eurReportResultSchema = z.object({
  taxYear: z.number().int(),
  from: z.string(),
  to: z.string(),
  rows: z.array(eurReportRowSchema),
  summary: z.object({
    incomeTotal: z.number(),
    expenseTotal: z.number(),
    surplus: z.number(),
  }),
  unclassifiedCount: z.number().int(),
  warnings: z.array(z.string()),
  catalog: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    delivery: z.enum(['print-form-only', 'elster-ready']),
    elsterReady: z.boolean(),
  }),
});

export const eurListItemsArgsSchema = z.object({
  taxYear: z.number().int().min(2025),
  from: z.string().optional(),
  to: z.string().optional(),
  onlyUnclassified: z.boolean().optional(),
  sourceType: z.enum(['transaction', 'invoice']).optional(),
  flowType: z.enum(['income', 'expense']).optional(),
  status: z.enum(['all', 'unclassified', 'classified', 'excluded']).optional(),
  search: z.string().optional(),
  accountId: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional(),
  offset: z.number().int().min(0).optional(),
});

export const eurListItemSchema = z.object({
  sourceType: z.enum(['transaction', 'invoice']),
  sourceId: z.string(),
  date: z.string(),
  amountGross: z.number(),
  amountNet: z.number(),
  flowType: z.enum(['income', 'expense']),
  accountId: z.string().optional(),
  linkedViaInvoice: z.boolean().optional(),
  counterparty: z.string(),
  purpose: z.string(),
  vatWarning: z.string().optional(),
  suggestedLineId: z.string().optional(),
  suggestionReason: z.string().optional(),
  suggestionLayer: z.enum(['rule', 'counterparty', 'bayes', 'keyword']).optional(),
  classification: eurClassificationSchema.optional(),
  line: eurLineSchema.optional(),
});

export const eurGetReportArgsSchema = z.object({
  taxYear: z.number().int().min(2025),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const eurUpsertClassificationArgsSchema = z.object({
  sourceType: z.enum(['transaction', 'invoice']),
  sourceId: z.string().min(1),
  taxYear: z.number().int().min(2025),
  reason: z.string().trim().min(1),
  eurLineId: z.string().optional(),
  excluded: z.boolean().optional(),
  vatMode: z.enum(['none', 'default']).optional(),
  vatRate: z.number().min(0).max(100).optional(),
  note: z.string().optional(),
});

export const eurExportCsvArgsSchema = z.object({
  taxYear: z.number().int().min(2025),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const eurExportPdfArgsSchema = z.object({
  taxYear: z.number().int().min(2025),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const eurExportPdfResultSchema = z.object({
  path: z.string().min(1),
});

export const eurRuleSchema = z.object({
  id: z.string(),
  taxYear: z.number().int(),
  priority: z.number().int(),
  field: z.enum(['counterparty', 'purpose', 'any']),
  operator: z.enum(['contains', 'equals', 'startsWith']),
  value: z.string(),
  targetEurLineId: z.string(),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const eurListRulesArgsSchema = z.object({
  taxYear: z.number().int().min(2025),
});

export const eurUpsertRuleArgsSchema = z.object({
  id: z.string().optional(),
  taxYear: z.number().int().min(2025),
  priority: z.number().int(),
  field: z.enum(['counterparty', 'purpose', 'any']),
  operator: z.enum(['contains', 'equals', 'startsWith']),
  value: z.string().min(1),
  targetEurLineId: z.string().min(1),
  active: z.boolean().optional(),
});

export const eurDeleteRuleArgsSchema = z.object({
  id: z.string().min(1),
});

export const accountSchema = z.object({
  id: z.string(),
  name: z.string(),
  iban: z.string(),
  balance: z.number(),
  defaultSkrAccountNumber: z.string().min(1),
  transactions: z.array(transactionSchema),
  type: z.enum(['bank', 'paypal', 'cash', 'checking', 'savings', 'credit', 'other']),
  color: z.string(),
});

export const ledgerChartSchema = z.enum(['SKR03', 'SKR04']);

export const taxCaseKeySchema = z.enum([
  'DE_STD_19',
  'DE_STD_7',
  'DE_ZERO_EXEMPT',
  'DE_KU19',
  'DE_RC_13B_DOMESTIC',
  'EU_B2C_OSS',
  'DE_MARGIN_25A',
  'DE_BAUABZUG_48',
  'DE_TRIANGULAR_25B',
  'EU_B2B_SERVICE_RC',
  'EU_IGL_GOODS_0',
  'EU_IGE_GOODS_RC',
  'NON_EU_EXPORT_0',
  'NON_EU_SERVICE_RC',
]);

export const taxCaseDefinitionSchema = z.object({
  key: taxCaseKeySchema,
  label: z.string(),
  mechanism: z.enum(['standard_vat', 'reverse_charge', 'zero_rate', 'exempt']),
  defaultRate: z.number(),
  requiresCounterpartyVatId: z.boolean(),
  requiresCountry: z.boolean(),
  requiresEvidence: z.boolean(),
  active: z.boolean(),
});

const queryBooleanSchema = z
  .union([z.boolean(), z.enum(['true', 'false']).transform((value) => value === 'true')])
  .optional();

export const taxCaseAccountMappingSchema = z.object({
  id: z.string(),
  chart: ledgerChartSchema,
  taxCaseKey: taxCaseKeySchema,
  role: z.enum(['output_tax', 'input_tax', 'datev_bu']),
  accountNumber: z.string(),
  datevBuKey: z.string().optional(),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
  updatedAt: z.string(),
});

export const proListTaxCasesArgsSchema = z.object({
  activeOnly: queryBooleanSchema,
});

export const proListTaxCaseAccountMappingsArgsSchema = z.object({
  chart: ledgerChartSchema.optional(),
  taxCaseKey: taxCaseKeySchema.optional(),
});

export const proUpsertTaxCaseAccountMappingArgsSchema = z.object({
  id: z.string().optional(),
  chart: ledgerChartSchema,
  taxCaseKey: taxCaseKeySchema,
  role: z.enum(['output_tax', 'input_tax', 'datev_bu']),
  accountNumber: z.string().min(1),
  datevBuKey: z.string().optional(),
  validFrom: z.string().optional(),
  validTo: z.string().optional(),
  reason: z.string().trim().min(1).optional(),
});

export const ledgerAccountSchema = z.object({
  id: z.string(),
  chart: ledgerChartSchema,
  accountNumber: z.string(),
  name: z.string(),
  keywords: z.array(z.string()).optional(),
  source: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const accountSuggestionRuleSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  chart: ledgerChartSchema,
  priority: z.number().int(),
  field: z.enum(['counterparty', 'purpose', 'any']),
  operator: z.enum(['contains', 'equals', 'startsWith']),
  value: z.string(),
  targetAccountNumber: z.string(),
  flowType: z.enum(['income', 'expense', 'any']),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const proListAccountSuggestionRulesArgsSchema = z.object({
  chart: ledgerChartSchema.optional(),
  activeOnly: queryBooleanSchema,
});

export const proUpsertAccountSuggestionRuleArgsSchema = z.object({
  id: z.string().optional(),
  chart: ledgerChartSchema,
  priority: z.number().int(),
  field: z.enum(['counterparty', 'purpose', 'any']),
  operator: z.enum(['contains', 'equals', 'startsWith']),
  value: z.string().min(1),
  targetAccountNumber: z.string().min(1),
  flowType: z.enum(['income', 'expense', 'any']).optional(),
  active: z.boolean().optional(),
  reason: z.string().trim().min(1).optional(),
});

export const proDeleteAccountSuggestionRuleArgsSchema = z.object({
  id: z.string().min(1),
  reason: z.string().trim().min(1).optional(),
});

export const proWorkflowEntrySchema = z.object({
  transactionId: z.string().min(1),
  transactionJson: z.string().min(2),
  draftJson: z.string().min(2),
  updatedAt: z.string(),
});

const accountingSourceTypeSchema = z.enum(['outgoing_invoice', 'incoming_invoice', 'legacy_transaction']);
const accountingSnapshotSchema = z.object({
  sourceType: accountingSourceTypeSchema,
  sourceId: z.string(),
  sourceVersion: z.string(),
  chart: ledgerChartSchema,
  vatMethod: z.enum(['soll', 'ist']),
  netAmount: z.number(),
  taxAmount: z.number(),
  grossAmount: z.number(),
  lines: z.array(z.object({ accountNumber: z.string(), debitAmount: z.number(), creditAmount: z.number(), taxCaseKey: z.string().optional(), netAmount: z.number().optional(), taxRate: z.number().optional(), taxAmount: z.number().optional(), grossAmount: z.number().optional(), evidenceType: z.string().optional(), evidenceReference: z.string().optional(), memo: z.string().optional() })),
  capturedAt: z.string(),
});
export const accountingPostingPreviewSchema = z.object({
  sourceType: accountingSourceTypeSchema,
  sourceId: z.string(),
  status: z.enum(['ready', 'unresolved']),
  reason: z.string().optional(),
  snapshot: accountingSnapshotSchema.optional(),
  issues: z.array(z.object({ code: z.string(), message: z.string(), blocking: z.boolean() })),
});
export const accountingPolicySchema = z.object({ tenantId: z.string(), activeChart: ledgerChartSchema, vatMethod: z.enum(['soll', 'ist']), periodPolicy: z.literal('calendar_month'), updatedAt: z.string() });
export const accountingAccountMappingSchema = z.object({ id: z.string(), tenantId: z.string(), chart: ledgerChartSchema, role: z.enum(['accounts_receivable', 'accounts_payable', 'bank', 'revenue', 'expense', 'asset', 'output_vat', 'output_vat_deferred', 'input_vat']), accountNumber: z.string(), updatedAt: z.string() });
export const vendorSchema = z.object({ id: z.string(), tenantId: z.string(), vendorNumber: z.string().optional(), name: z.string().min(1), email: z.string().optional(), address: z.string().optional(), vatId: z.string().optional(), iban: z.string().optional(), defaultExpenseAccount: z.string().optional(), createdAt: z.string(), updatedAt: z.string() });
const incomingInvoiceLineSchema = z.object({ id: z.string(), incomingInvoiceId: z.string(), position: z.number().int(), description: z.string(), quantity: z.number(), unitPrice: z.number(), netAmount: z.number(), taxRate: z.number(), taxAmount: z.number(), grossAmount: z.number(), accountNumber: z.string().optional(), assetAccountNumber: z.string().optional() });
export const incomingInvoiceSchema = z.object({ id: z.string(), tenantId: z.string(), vendorId: z.string(), number: z.string(), invoiceDate: z.string(), dueDate: z.string(), servicePeriod: z.string().optional(), netAmount: z.number(), taxAmount: z.number(), grossAmount: z.number(), status: z.enum(['draft', 'open', 'paid', 'cancelled', 'unresolved']), taxRate: z.number(), taxCaseKey: z.string().optional(), notes: z.string().optional(), lines: z.array(incomingInvoiceLineSchema), accountingStatus: z.enum(['unposted', 'posted', 'unresolved', 'reversed']), accountingSnapshot: accountingSnapshotSchema.optional(), createdAt: z.string(), updatedAt: z.string() });
export const openItemSchema = z.object({ id: z.string(), tenantId: z.string(), partyType: z.enum(['debtor', 'creditor']), partyId: z.string(), sourceType: accountingSourceTypeSchema, sourceId: z.string(), documentNumber: z.string(), documentDate: z.string(), dueDate: z.string(), originalAmount: z.number(), allocatedAmount: z.number(), residualAmount: z.number(), status: z.enum(['open', 'partially_paid', 'paid', 'overpaid', 'unresolved']), journalEntryId: z.string().optional(), createdAt: z.string(), updatedAt: z.string() });
const accountingCandidateSchema = z.object({ sourceType: accountingSourceTypeSchema, sourceId: z.string(), status: z.enum(['ready', 'unresolved']), reason: z.string().optional(), sourceVersion: z.string(), snapshot: z.unknown().optional() });
export const accountingBackfillPreviewSchema = z.object({ runId: z.string(), status: z.enum(['preview', 'confirmed', 'completed']), candidates: z.array(accountingCandidateSchema), readyCount: z.number().int(), unresolvedCount: z.number().int(), confirmationHash: z.string() });
export const accountingBackfillResultSchema = z.object({ runId: z.string(), postedCount: z.number().int(), unresolvedCount: z.number().int(), status: z.literal('completed') });

export const bookingDraftLineEntitySchema = z.object({
  id: z.string(),
  accountNumber: z.string(),
  debitAmount: z.number(),
  creditAmount: z.number(),
  taxCode: z.string().optional(),
  taxCaseKey: taxCaseKeySchema.optional(),
  taxRate: z.number().optional(),
  netAmount: z.number().optional(),
  taxAmount: z.number().optional(),
  grossAmount: z.number().optional(),
  countryCode: z.string().optional(),
  counterpartyVatId: z.string().optional(),
  evidenceType: z.string().optional(),
  evidenceReference: z.string().optional(),
  datevSachverhaltLl: z.string().regex(/^[1-9]\d{0,2}$/).optional(),
  costCenter: z.string().optional(),
  memo: z.string().optional(),
});

export const draftValidationIssueSchema = z.object({
  id: z.string(),
  code: z.string(),
  severity: z.enum(['error', 'warning', 'info']),
  message: z.string(),
  fieldPath: z.string().optional(),
  blocking: z.boolean(),
  source: z.enum(['system', 'user', 'rule']),
});

export const bookingDraftEntitySchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  transactionId: z.string(),
  workflowStatus: z.enum([
    'imported',
    'suggested',
    'incomplete',
    'ready_for_review',
    'pending_approval',
    'approved',
    'posted',
    'reversed',
    'corrected',
    'period_locked',
    'integration_error',
  ]),
  postingDate: z.string().optional(),
  documentDate: z.string().optional(),
  bookingText: z.string(),
  reference: z.string().optional(),
  period: z.string(),
  fiscalYear: z.number().int(),
  lines: z.array(bookingDraftLineEntitySchema),
  validationIssues: z.array(draftValidationIssueSchema),
  updatedAt: z.string(),
  isVirtualProjection: z.boolean().optional(),
});

export const journalLineEntitySchema = z.object({
  id: z.string(),
  accountNumber: z.string(),
  debitAmount: z.number(),
  creditAmount: z.number(),
  taxCode: z.string().optional(),
  taxCaseKey: taxCaseKeySchema.optional(),
  taxRate: z.number().optional(),
  netAmount: z.number().optional(),
  taxAmount: z.number().optional(),
  grossAmount: z.number().optional(),
  countryCode: z.string().optional(),
  counterpartyVatId: z.string().optional(),
  evidenceType: z.string().optional(),
  evidenceReference: z.string().optional(),
  datevSachverhaltLl: z.string().regex(/^[1-9]\d{0,2}$/).optional(),
  costCenter: z.string().optional(),
  memo: z.string().optional(),
});

export const proValidateTaxComplianceArgsSchema = z
  .object({
    draftId: z.string().min(1).optional(),
    transactionId: z.string().min(1).optional(),
  })
  .refine((value) => Boolean(value.draftId || value.transactionId), {
    message: 'draftId or transactionId is required',
  });

export const proValidateTaxComplianceResultSchema = z.object({
  ok: z.boolean(),
  issues: z.array(draftValidationIssueSchema),
});

export const journalEntryEntitySchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  entryNumber: z.number().int(),
  postingDate: z.string(),
  documentDate: z.string().optional(),
  bookingText: z.string(),
  reference: z.string().optional(),
  period: z.string(),
  fiscalYear: z.number().int(),
  status: z.enum(['posted', 'reversed']),
  sourceDraftId: z.string().optional(),
  sourceType: z.enum(['booking_draft', 'reversal', 'depreciation', 'manual', 'outgoing_invoice', 'incoming_invoice', 'payment', 'payment_vat', 'legacy_transaction']).optional(),
  sourceKey: z.string().optional(),
  reversedEntryId: z.string().optional(),
  createdAt: z.string(),
  lines: z.array(journalLineEntitySchema),
});

export const ledgerBalanceRowSchema = z.object({
  accountNumber: z.string(),
  openingBalance: z.number(),
  debitTurnover: z.number(),
  creditTurnover: z.number(),
  closingBalance: z.number(),
});

export const assetStatusSchema = z.enum([
  'entwurf',
  'aktiv',
  'voll_abgeschrieben',
  'verkauft',
  'stillgelegt',
]);

export const depreciationMethodSchema = z.enum(['linear', 'gwg', 'pool']);

export const assetSchema = z.object({
  id: z.string(),
  assetNumber: z.string(),
  name: z.string(),
  assetClass: z.string(),
  status: assetStatusSchema,
  activationDate: z.string(),
  acquisitionCost: z.number().nonnegative(),
  residualValue: z.number().nonnegative(),
  annualDepreciation: z.number().nonnegative(),
  usefulLifeYears: z.number().int().positive().optional(),
  depreciationMethod: depreciationMethodSchema,
  costCenter: z.string(),
  location: z.string(),
  nextDepreciation: z.string(),
  receiptLinked: z.boolean(),
  supplier: z.string().optional(),
  invoiceRef: z.string().optional(),
  assetAccountNumber: z.string(),
  disposalDate: z.string().optional(),
  disposalProceeds: z.number().optional(),
  acquisitionOffsetAccountNumber: z.string().optional(),
  sourceIncomingInvoiceId: z.string().optional(),
  activationJournalEntryId: z.string().optional(),
  accountingRepairRequired: z.boolean().optional(),
  accountingRepairReason: z.string().optional(),
});

export const assetUpsertSchema = assetSchema
  .omit({
    residualValue: true,
    annualDepreciation: true,
    nextDepreciation: true,
    disposalDate: true,
    disposalProceeds: true,
    accountingRepairRequired: true,
    accountingRepairReason: true,
  })
  .extend({
    id: z.string().optional(),
    acquisitionOffsetAccountNumber: z.string().optional(),
    sourceIncomingInvoiceId: z.string().optional(),
    softLockOverride: z.boolean().optional(),
    overrideReason: z.string().min(1).optional(),
  }).refine((input) => !input.softLockOverride || Boolean(input.overrideReason?.trim()), { path: ['overrideReason'], message: 'overrideReason required for soft-lock override' });

export const assetDepreciationScheduleEntrySchema = z.object({
  id: z.string(),
  assetId: z.string(),
  year: z.number().int(),
  amount: z.number().nonnegative(),
  months: z.number().int().min(1).max(12),
  status: z.enum(['planned', 'posted', 'cancelled']),
  journalEntryId: z.string().optional(),
  sourceType: z.string().optional(),
  sourceKey: z.string().optional(),
  postedAt: z.string().optional(),
});

export const datevExportResultSchema = z.object({
  id: z.string(),
  filePath: z.string(),
  recordCount: z.number().int(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
  createdAt: z.string(),
  sha256: z.string().optional(),
  byteSize: z.number().int().nonnegative().optional(),
  encoding: z.enum(['cp1252', 'utf8-bom']).optional(),
  headerVersion: z.number().int().optional(),
  formatVersion: z.number().int().optional(),
  chart: ledgerChartSchema.optional(),
  sourceSnapshotHash: z.string().optional(),
  manifestJson: z.string().optional(),
  status: z.string().optional(),
  validationJson: z.string().optional(),
  contentSha256: z.string().length(64).optional(),
});

export const recurringProfileSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  active: z.boolean(),
  name: z.string(),
  interval: z.enum(['daily', 'weekly', 'monthly', 'quarterly', 'yearly']),
  nextRun: z.string(),
  lastRun: z.string().optional(),
  endDate: z.string().optional(),
  amount: z.number(),
  items: z.array(invoiceItemSchema),
});

export const dunningLevelSchema = z.object({
  id: z.number(),
  name: z.string(),
  enabled: z.boolean(),
  daysAfterDueDate: z.number(),
  fee: z.number(),
  subject: z.string(),
  text: z.string(),
});

const isValidMonthDay = (value: string): boolean => {
  const [month, day] = value.split('-').map(Number);
  return day <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
};

export const businessReportingProfileSchema = z
  .object({
    jurisdiction: z.literal('DE'),
    legalForm: z.enum(['sole_proprietor', 'gmbh']),
    profitDetermination: z.enum(['eur', 'double_entry']),
    hgbSizeClass: z.enum(['micro', 'small']).optional(),
    fiscalYearStart: z.string()
      .regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, 'Expected MM-DD')
      .refine(isValidMonthDay, 'Expected a valid MM-DD date'),
    chart: z.enum(['SKR03', 'SKR04']).optional(),
    vatMethod: z.enum(['soll', 'ist']),
  })
  .superRefine((profile, ctx) => {
    if (profile.profitDetermination === 'eur' && profile.fiscalYearStart !== '01-01') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fiscalYearStart'], message: 'EÜR requires a calendar-year start (01-01)' });
    }
    if (profile.legalForm === 'sole_proprietor' && profile.profitDetermination !== 'eur') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profitDetermination'], message: 'Sole proprietors require EÜR (cash-basis accounting)' });
    }
    if (profile.legalForm !== 'gmbh') return;
    if (profile.profitDetermination !== 'double_entry') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profitDetermination'], message: 'GmbH requires double-entry accounting' });
    }
    if (!profile.hgbSizeClass) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['hgbSizeClass'], message: 'GmbH requires an HGB size class' });
    }
    if (!profile.chart) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chart'], message: 'GmbH requires a ledger chart' });
    }
  });

const appSettingsBaseSchema = z.object({
  businessReportingProfile: businessReportingProfileSchema.optional(),
  company: z.object({
    name: z.string(),
    owner: z.string(),
    street: z.string(),
    zip: z.string(),
    city: z.string(),
    email: z.string(),
    phone: z.string(),
    website: z.string(),
  }),
  catalog: z
    .object({
      categories: z.array(
        z.object({
          id: z.string().min(1),
          name: z.string().min(1),
        }),
      ),
    })
    .default({ categories: [] }),
  finance: z.object({
    bankName: z.string(),
    iban: z.string(),
    bic: z.string(),
    taxId: z.string(),
    vatId: z.string(),
    registerCourt: z.string(),
  }),
  numbers: z.object({
    invoicePrefix: z.string(),
    nextInvoiceNumber: z.number(),
    numberLength: z.number(),
    offerPrefix: z.string(),
    nextOfferNumber: z.number(),
    customerPrefix: z.string().default('KD-'),
    nextCustomerNumber: z.number().default(1),
    customerNumberLength: z.number().default(4),
  }),
  dunning: z.object({
    levels: z.array(dunningLevelSchema),
  }),
  legal: z.object({
    smallBusinessRule: z.boolean(),
    defaultVatRate: z.number(),
    countryCode: z.enum(['DE', 'AT', 'CH']).optional(),
    taxAccountingMethod: z.enum(['soll', 'ist']).default('soll'),
    paymentTermsDays: z.number(),
    defaultIntroText: z.string(),
    defaultFooterText: z.string(),
  }),
  portal: z
    .object({
      baseUrl: z.string().default('').refine(
        isAllowedPortalBaseUrl,
        'Portal baseUrl must use https (except localhost)',
      ),
    })
    .default({ baseUrl: '' }),
  eInvoice: z
    .object({
      enabled: z.boolean().default(false),
      standard: z.literal('zugferd-en16931').default('zugferd-en16931'),
      profile: z.literal('EN16931').default('EN16931'),
      version: z.literal('2.3').default('2.3'),
    })
    .default({
      enabled: false,
      standard: 'zugferd-en16931',
      profile: 'EN16931',
      version: '2.3',
    }),
  email: z
    .object({
      provider: z.enum(['smtp', 'resend', 'none']).default('none'),
      smtpHost: z.string().default(''),
      smtpPort: z.number().default(587),
      smtpSecure: z.boolean().default(true),
      smtpUser: z.string().default(''),
      fromName: z.string().default(''),
      fromEmail: z.string().default(''),
    })
    .default({
      provider: 'none',
      smtpHost: '',
      smtpPort: 587,
      smtpSecure: true,
      smtpUser: '',
      fromName: '',
      fromEmail: '',
    }),
  automation: z
    .object({
      dunningEnabled: z.boolean().default(false),
      dunningRunTime: z.string().default('09:00'),
      lastDunningRun: z.string().optional(),
      recurringEnabled: z.boolean().default(false),
      recurringRunTime: z.string().default('03:00'),
      lastRecurringRun: z.string().optional(),
    })
    .default({
      dunningEnabled: false,
      dunningRunTime: '09:00',
      recurringEnabled: false,
      recurringRunTime: '03:00',
    }),
  dashboard: z
    .object({
      monthlyRevenueGoal: z.number().default(30000),
      dueSoonDays: z.number().int().min(1).default(7),
      topCategoriesLimit: z.number().int().min(1).max(20).default(5),
      recentPaymentsLimit: z.number().int().min(1).max(20).default(5),
      topClientsLimit: z.number().int().min(1).max(20).default(5),
    })
    .default({
      monthlyRevenueGoal: 30000,
      dueSoonDays: 7,
      topCategoriesLimit: 5,
      recentPaymentsLimit: 5,
      topClientsLimit: 5,
    }),
  onboardingCompleted: z.boolean().optional(),
});

export const appSettingsSchema: z.ZodType<
  z.output<typeof appSettingsBaseSchema>,
  z.ZodTypeDef,
  z.input<typeof appSettingsBaseSchema>
> = appSettingsBaseSchema.transform((settings) => {
  const businessReportingProfile = settings.businessReportingProfile ?? {
    jurisdiction: 'DE' as const,
    legalForm: 'sole_proprietor' as const,
    profitDetermination: 'eur' as const,
    fiscalYearStart: '01-01',
    vatMethod: settings.legal.taxAccountingMethod,
  };
  return {
    ...settings,
    businessReportingProfile,
    legal: {
      ...settings.legal,
      taxAccountingMethod: businessReportingProfile.vatMethod,
    },
  };
});

export const upsertClientPayloadSchema = z.object({
  client: clientSchema,
});

export const deleteByIdSchema = z.object({
  id: z.string().min(1),
});

export const upsertArticlePayloadSchema = z.object({
  article: articleSchema,
});

export const upsertAccountPayloadSchema = z.object({
  account: accountSchema,
});

export const upsertRecurringPayloadSchema = z.object({
  profile: recurringProfileSchema,
});

export const csvProfileSchema = z.enum(['auto', 'fints', 'paypal', 'stripe', 'generic']);

export const csvMappingSchema = z.object({
  dateColumn: z.string().min(1),
  amountColumn: z.string().min(1),
  counterpartyColumn: z.string().optional(),
  purposeColumn: z.string().optional(),
  statusColumn: z.string().optional(),
  externalIdColumn: z.string().optional(),
  currencyColumn: z.string().optional(),
  currencyExpected: z.string().optional(),
});

export const financeImportPreviewSchema = z.object({
  path: z.string().min(1),
  profile: csvProfileSchema.optional(),
  mapping: csvMappingSchema.optional(),
  encoding: z.enum(['utf8', 'win1252']).optional(),
  delimiter: z.string().optional(),
  maxRows: z.number().int().min(1).max(200).optional(),
  accountIdForDedupHash: z.string().optional(),
});

export const financeImportCommitSchema = z.object({
  path: z.string().min(1),
  accountId: z.string().min(1),
  profile: csvProfileSchema.optional(),
  mapping: csvMappingSchema,
  encoding: z.enum(['utf8', 'win1252']).optional(),
  delimiter: z.string().optional(),
});

export const setSettingsPayloadSchema = z.object({
  settings: appSettingsSchema,
});

export const templateKindSchema = z.enum(['invoice', 'offer']);

export const templateSchema = z.object({
  id: z.string(),
  kind: templateKindSchema,
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  elements: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      x: z.number(),
      y: z.number(),
      zIndex: z.number(),
      content: z.string().optional(),
      src: z.string().optional(),
      tableData: z
        .object({
          columns: z.array(
            z.object({
              id: z.string(),
              label: z.string(),
              width: z.number(),
              visible: z.boolean(),
              align: z.enum(['left', 'center', 'right']),
            }),
          ),
          rows: z.array(
            z.object({
              id: z.string(),
              cells: z.array(z.string()),
            }),
          ),
        })
        .optional(),
      qrData: z
        .object({
          iban: z.string(),
          bic: z.string(),
          amount: z.number(),
          reference: z.string(),
        })
        .optional(),
      style: z.record(z.any()),
      label: z.string().optional(),
    }),
  ),
});

export const listTemplatesParamsSchema = z.object({
  kind: templateKindSchema.optional(),
});

export const upsertTemplatePayloadSchema = z.object({
  template: templateSchema,
});

export const setActiveTemplatePayloadSchema = z.object({
  kind: templateKindSchema,
  templateId: z.string().nullable(),
});

export const reportSnapshotRecordSchema = z.object({
  id: z.string().min(1),
  reportType: z.string().min(1),
  args: z.unknown(),
  payload: z.unknown(),
  createdAt: z.string().datetime(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
});

export const listReportSnapshotsArgsSchema = z.object({
  reportType: z.string().min(1).optional(),
});

export const saveReportSnapshotArgsSchema = z.object({
  reportType: z.string().min(1),
  args: z.unknown().optional(),
  payload: z.unknown(),
  reason: z.string().trim().min(1),
});

export const proGetReportingReportArgsSchema = z.object({
  kind: z.enum(['bwa01', 'management-guv', 'hgb-guv', 'hgb-bilanz']),
  from: z.string().optional(),
  to: z.string().optional(),
  asOfDate: z.string().optional(),
});

export const proGetReportingReportResultSchema = z.object({
  kind: z.enum(['bwa01', 'management-guv', 'hgb-guv', 'hgb-bilanz']),
  snapshot: z.object({
    fiscalYear: z.number().int(),
    fiscalYearStart: z.string(),
    ledgerEntryCount: z.number().int().nonnegative(),
    ledgerAccountCount: z.number().int().nonnegative(),
    cashEntryCount: z.number().int().nonnegative(),
  }).passthrough(),
  mappingHealth: z.object({
    mappedAccounts: z.number().int().nonnegative(),
    inferredAccounts: z.number().int().nonnegative(),
    unmappedAccounts: z.array(z.string()),
    warnings: z.array(z.string()),
    blocking: z.boolean(),
  }),
}).passthrough();

export const reportMappingStatementSchema = z.enum(['bwa01', 'management-guv', 'hgb-guv', 'hgb-bilanz']);
export const reportMappingPositionSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  kind: z.enum(['heading', 'line', 'subtotal', 'result']),
  side: z.enum(['asset', 'liability']).optional(),
});
export const proGetReportMappingHealthArgsSchema = z.object({
  chart: z.enum(['SKR03', 'SKR04']).optional(),
  statement: reportMappingStatementSchema.optional(),
  asOfDate: z.string().date().optional(),
});
export const proGetReportMappingHealthResultSchema = z.object({
  chart: z.enum(['SKR03', 'SKR04']),
  unmapped: z.array(z.object({ accountNumber: z.string().min(1), statement: reportMappingStatementSchema })),
});
export const proListReportMappingPositionsArgsSchema = z.object({ statement: reportMappingStatementSchema, asOfDate: z.string().date() });
export const proUpsertReportMappingOverrideArgsSchema = z.object({
  chart: z.enum(['SKR03', 'SKR04']),
  asOfDate: z.string().date(),
  accountNumber: z.string().trim().min(1),
  statement: reportMappingStatementSchema,
  position: z.string().trim().min(1),
  label: z.string().trim().min(1),
  side: z.enum(['asset', 'liability']).optional(),
  reason: z.string().trim().min(1),
});
