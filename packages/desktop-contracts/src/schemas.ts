import { z } from 'zod';
import {
  clientContactsSchema,
  offerStatusSchema,
  documentLayoutSchema,
  documentTemplateBodySchema,
  documentTemplateDefaultsSchema,
  documentTemplateRecordSchema,
  templateKindSchema as documentTemplateKindSchema,
} from '@billme/server-core/domain';

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
  /** BT-10 Käuferreferenz, e.g. the Leitweg-ID public buyers require on e-invoices. */
  buyerReference: z.string().trim().max(200).optional(),
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
  documentKind: z.enum(['invoice', 'order_confirmation', 'delivery_note', 'advance_invoice', 'partial_invoice', 'final_invoice', 'credit_note', 'cancellation_invoice']).optional(),
  sourceDocumentId: z.string().optional(),
  rootDocumentId: z.string().optional(),
  revisionOfId: z.string().optional(),
  revisionNumber: z.number().int().nonnegative().optional(),
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
  skonto: z.object({ percent: z.number().gt(0).max(10), days: z.number().int().min(1).max(90) }).optional(),
  amount: z.number(),
  status: z.enum(['paid', 'open', 'overdue', 'draft', 'cancelled']),
  dunningLevel: z.number().optional(),
  items: z.array(invoiceItemSchema),
  payments: z.array(paymentSchema),
  history: z.array(z.object({ date: z.string(), action: z.string() })).optional(),
  layout: documentLayoutSchema.optional(),
});

export const offerSchema = invoiceSchema.extend({ status: offerStatusSchema });

export const upsertPayloadSchema = z.object({
  reason: z.string().min(1),
  invoice: invoiceSchema,
});

export const upsertOfferPayloadSchema = z.object({
  reason: z.string().min(1),
  offer: offerSchema,
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
  contacts: clientContactsSchema.optional(),
});

export const articleSchema = z.object({
  id: z.string(),
  sku: z.string().optional(),
  title: z.string().trim().min(1),
  description: z.string(),
  price: z.number(),
  unit: z.string(),
  category: z.string(),
  taxRate: z.number().min(0).max(100),
});

export const transactionSchema = z.object({
  id: z.string(),
  date: z.string(),
  amount: z.number(),
  type: z.enum(['income', 'expense']),
  counterparty: z.string(),
  purpose: z.string(),
  linkedInvoiceId: z.string().optional(),
  matchedManualEntryId: z.string().optional(), appliedAmountCents: z.number().int().optional(), unallocatedAmountCents: z.number().int().optional(),
  status: z.enum(['pending', 'booked', 'open', 'matched']),
  accountId: z.string().optional(),
  dedupHash: z.string().optional(),
  importBatchId: z.string().optional(),
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
  sourceType: z.enum(['transaction', 'invoice', 'manual']),
  sourceId: z.string(),
  taxYear: z.number().int(),
  eurLineId: z.string().optional(),
  excluded: z.boolean(),
  vatMode: z.enum(['none', 'default']),
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
  sourceType: z.enum(['transaction', 'invoice', 'manual']).optional(),
  flowType: z.enum(['income', 'expense']).optional(),
  status: z.enum(['all', 'unclassified', 'classified', 'excluded']).optional(),
  search: z.string().optional(),
  accountId: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional(),
  offset: z.number().int().min(0).optional(),
});

export const eurListItemSchema = z.object({
  sourceType: z.enum(['transaction', 'invoice', 'manual']),
  sourceId: z.string(),
  date: z.string(),
  amountGross: z.number(),
  amountNet: z.number(),
  flowType: z.enum(['income', 'expense']),
  accountId: z.string().optional(),
  linkedViaInvoice: z.boolean().optional(),
  counterparty: z.string(),
  purpose: z.string(),
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
  sourceType: z.enum(['transaction', 'invoice', 'manual']),
  sourceId: z.string().min(1),
  taxYear: z.number().int().min(2025),
  reason: z.string().trim().min(1),
  eurLineId: z.string().optional(),
  excluded: z.boolean().optional(),
  vatMode: z.enum(['none', 'default']).optional(),
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

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const eurExportDatevArgsSchema = z.object({ from: isoDateSchema, to: isoDateSchema });
/** One DATEV-Buchungsstapel file; `errors` lists EÜR items that are in the period but not in the file. */
export const eurExportDatevResultSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.literal('text/csv'),
  contentBase64: z.string(),
  rowCount: z.number().int().nonnegative(),
  errors: z.array(z.object({ sourceType: z.enum(['transaction', 'invoice', 'manual']), sourceId: z.string(), date: z.string(), amount: z.number(), counterparty: z.string(), message: z.string() })),
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
  transactions: z.array(transactionSchema),
  type: z.enum(['bank', 'paypal', 'cash', 'checking', 'savings', 'credit', 'other']),
  color: z.string(),
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
  daysAfterDueDate: z.number().nonnegative(),
  fee: z.number().nonnegative(),
  subject: z.string(),
  text: z.string(),
  chargeInterest: z.boolean().optional(),
  chargeFlatFee: z.boolean().optional(),
});

const isValidMonthDay = (value: string): boolean => {
  const [month, day] = value.split('-').map(Number);
  return day <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
};

export const businessReportingProfileSchema = z
  .object({
    jurisdiction: z.literal('DE'),
    legalForm: z.enum(['sole_proprietor', 'gmbh', 'ug', 'gbr', 'ek']),
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
    if (['sole_proprietor', 'gbr', 'ek'].includes(profile.legalForm) && profile.profitDetermination !== 'eur') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['profitDetermination'], message: 'Sole proprietors require EÜR (cash-basis accounting)' });
    }
    if (profile.legalForm !== 'gmbh' && profile.legalForm !== 'ug') return;
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

const isValidIban = (value: string): boolean => {
  const iban = value.replace(/\s/g, '').toUpperCase();
  if (!iban) return true;
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const char of rearranged) {
    const digits = /[A-Z]/.test(char) ? String(char.charCodeAt(0) - 55) : char;
    for (const digit of digits) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
};

/** DATEV-Buchungsstapel for the tax advisor; the bounds mirror the formatter in `@billme/accounting-engine/datev-export`. */
export const datevSettingsSchema = z.object({
  consultantNumber: z.string().trim().regex(/^\d{4,7}$/, 'Beraternummer: 4 bis 7 Ziffern.').refine((value) => Number(value) >= 1001, 'Beraternummer ab 1001.'),
  clientNumber: z.string().trim().regex(/^\d{1,5}$/, 'Mandantennummer: 1 bis 5 Ziffern.').refine((value) => Number(value) >= 1, 'Mandantennummer ab 1.'),
  accountLength: z.number().int().min(4).max(8).default(4),
  chart: z.enum(['SKR03', 'SKR04']).default('SKR03'),
});

const appSettingsBaseSchema = z.object({
  businessReportingProfile: businessReportingProfileSchema.optional(),
  datev: datevSettingsSchema.optional(),
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
    iban: z.string().refine(isValidIban, 'Ungültige IBAN.'),
    bic: z.string().refine((value) => !value.trim() || /^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(value.trim()), 'Ungültige BIC.'),
    taxId: z.string(),
    vatId: z.string(),
    registerCourt: z.string(),
  }),
  numbers: z.object({
    invoicePrefix: z.string(),
    nextInvoiceNumber: z.number().int().min(1),
    numberLength: z.number().int().min(1).max(10),
    offerPrefix: z.string(),
    nextOfferNumber: z.number().int().min(1),
    customerPrefix: z.string().default('KD-'),
    nextCustomerNumber: z.number().int().min(1).default(1),
    customerNumberLength: z.number().int().min(1).max(10).default(4),
    // Order confirmations and delivery notes are no invoices and get their own ranges.
    orderConfirmationPrefix: z.string().optional(),
    nextOrderConfirmationNumber: z.number().int().min(1).optional(),
    deliveryNotePrefix: z.string().optional(),
    nextDeliveryNoteNumber: z.number().int().min(1).optional(),
  }),
  dunning: z.object({
    levels: z.array(dunningLevelSchema),
    /** Basiszinssatz in percent (§247 BGB); the user keeps it current. */
    baseInterestRatePercent: z.number().min(-10).max(20).optional(),
  }),
  legal: z.object({
    smallBusinessRule: z.boolean(),
    defaultVatRate: z.number().min(0).max(100),
    countryCode: z.enum(['DE', 'AT', 'CH']).optional(),
    taxAccountingMethod: z.enum(['soll', 'ist']).default('soll'),
    /** First day the current method applies (YYYY-MM-01); earlier periods keep `previousTaxAccountingMethod`. */
    taxAccountingMethodSince: z.string().regex(/^\d{4}-\d{2}-01$/).optional(),
    previousTaxAccountingMethod: z.enum(['soll', 'ist']).optional(),
    paymentTermsDays: z.number().nonnegative(),
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
  onboardingDraftSaved: z.boolean().optional(),
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
  /** Audit reason; the HTTP adapters fall back to their own wording. */
  reason: z.string().trim().min(1).optional(),
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
  path: z.string().min(1).optional(),
  fileName: z.string().optional(),
  contentBase64: z.string().optional(),
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


// Flow-layout document templates.
export {
  documentLayoutSchema,
  documentTemplateBodySchema,
  documentTemplateDefaultsSchema,
  documentTemplateKindSchema,
  documentTemplateRecordSchema,
};

export const listDocumentTemplatesArgsSchema = z.object({ kind: documentTemplateKindSchema.optional() });

export const upsertDocumentTemplateArgsSchema = z.object({
  template: z.object({
    id: z.string().min(1).optional(),
    kind: documentTemplateKindSchema,
    name: z.string().trim().min(1).max(120),
    body: documentTemplateBodySchema,
  }),
});

export const setDefaultDocumentTemplateArgsSchema = z.object({
  kind: documentTemplateKindSchema,
  templateId: z.string().min(1).nullable(),
});

export const documentRenderContextArgsSchema = z.object({
  kind: z.enum(['invoice', 'offer', 'dunning']),
  id: z.string().min(1),
  /** Dunning level; defaults to the invoice's current level. */
  level: z.number().int().positive().optional(),
});

export const documentRenderContextSchema = z.object({
  templateKind: documentTemplateKindSchema,
  // Offers print too, with their own statuses (accepted, declined, expired).
  document: invoiceSchema.extend({ status: z.union([invoiceSchema.shape.status, offerStatusSchema]) }),
  template: z.object({
    id: z.string().optional(),
    version: z.number().int().positive().optional(),
    name: z.string().optional(),
    body: documentTemplateBodySchema,
  }),
  settings: appSettingsSchema.nullable(),
  source: z.object({
    number: z.string(),
    date: z.string(),
    documentKind: invoiceSchema.shape.documentKind,
  }).optional(),
  texts: z.object({ intro: z.string().optional(), closing: z.string().optional() }).optional(),
  dunning: z.object({
    level: z.number().int(),
    levelName: z.string(),
    date: z.string(),
    payUntil: z.string(),
    fee: z.number(),
    originalAmount: z.number(),
    paidAmount: z.number(),
    creditedAmount: z.number().optional(),
    daysOverdue: z.number().int(),
    interest: z.number().optional(),
    interestRatePercent: z.number().optional(),
    interestDays: z.number().int().optional(),
    flatFee: z.boolean().optional(),
  }).optional(),
});
