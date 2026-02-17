import { z } from 'zod';

export const invoiceItemSchema = z.object({
  description: z.string(),
  quantity: z.number(),
  price: z.number(),
  total: z.number(),
  articleId: z.string().optional(),
  category: z.string().optional(),
});

export const paymentSchema = z.object({
  id: z.string(),
  date: z.string(),
  amount: z.number(),
  method: z.string(),
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
  daysAfterDueDate: z.number(),
  fee: z.number(),
  subject: z.string(),
  text: z.string(),
});

export const appSettingsSchema = z.object({
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
    taxAccountingMethod: z.enum(['soll', 'ist']).default('soll'),
    paymentTermsDays: z.number(),
    defaultIntroText: z.string(),
    defaultFooterText: z.string(),
  }),
  portal: z
    .object({
      baseUrl: z.string().default(''),
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
