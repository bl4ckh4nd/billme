import { z } from 'zod';

// Settings as the worker reads them from settings_json; the transform fills the reporting-profile defaults.

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

const CompanySettingsSchema = z.object({
  name: z.string(),
  owner: z.string(),
  street: z.string(),
  zip: z.string(),
  city: z.string(),
  email: z.string(),
  phone: z.string(),
  website: z.string(),
});

const FinanceSettingsSchema = z.object({
  bankName: z.string(),
  iban: z.string(),
  bic: z.string(),
  taxId: z.string(),
  vatId: z.string(),
  registerCourt: z.string(),
});

const NumbersSettingsSchema = z.object({
  invoicePrefix: z.string(),
  nextInvoiceNumber: z.number(),
  numberLength: z.number(),
  offerPrefix: z.string(),
  nextOfferNumber: z.number(),
  customerPrefix: z.string().optional().default('KD-'),
  nextCustomerNumber: z.number().optional().default(1),
  customerNumberLength: z.number().optional().default(4),
  orderConfirmationPrefix: z.string().optional().default('AB-%Y-'),
  nextOrderConfirmationNumber: z.number().optional().default(1),
  deliveryNotePrefix: z.string().optional().default('LS-%Y-'),
  nextDeliveryNoteNumber: z.number().optional().default(1),
});

const DunningLevelSchema = z.object({
  id: z.number(),
  name: z.string(),
  enabled: z.boolean().optional().default(true),
  daysAfterDueDate: z.number(),
  fee: z.number(),
  subject: z.string(),
  text: z.string(),
  chargeInterest: z.boolean().optional(),
  chargeFlatFee: z.boolean().optional(),
});

const DunningSettingsSchema = z.object({
  levels: z.array(DunningLevelSchema),
  baseInterestRatePercent: z.number().optional(),
});

const LegalSettingsSchema = z.object({
  smallBusinessRule: z.boolean(),
  defaultVatRate: z.number(),
  countryCode: z.enum(['DE', 'AT', 'CH']).optional(),
  taxAccountingMethod: z.enum(['soll', 'ist']).optional().default('soll'),
  taxAccountingMethodSince: z.string().optional(),
  previousTaxAccountingMethod: z.enum(['soll', 'ist']).optional(),
  vatPermanentExtension: z.boolean().optional(),
  vatSpecialPrepayment: z.object({ year: z.number().int(), amountCents: z.number().int() }).optional(),
  paymentTermsDays: z.number(),
  defaultIntroText: z.string(),
  defaultFooterText: z.string(),
});

const PortalSettingsSchema = z.object({
  baseUrl: z
    .string()
    .optional()
    .default('')
    .refine(isAllowedPortalBaseUrl, 'Portal baseUrl must use https (except localhost)'),
});

const EInvoiceSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  standard: z.literal('zugferd-en16931').default('zugferd-en16931'),
  profile: z.literal('EN16931').default('EN16931'),
  version: z.literal('2.3').default('2.3'),
});

const EmailSettingsSchema = z.object({
  provider: z.enum(['smtp', 'resend', 'none']).default('none'),
  smtpHost: z.string().default(''),
  smtpPort: z.number().default(587),
  smtpSecure: z.boolean().default(true),
  smtpUser: z.string().default(''),
  fromName: z.string().default(''),
  fromEmail: z.string().default(''),
});

const AutomationSettingsSchema = z.object({
  dunningEnabled: z.boolean().default(false),
  dunningRunTime: z.string().default('09:00'),
  lastDunningRun: z.string().optional(),
  recurringEnabled: z.boolean().default(false),
  recurringRunTime: z.string().default('03:00'),
  lastRecurringRun: z.string().optional(),
});

const CatalogSettingsSchema = z.object({
  categories: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
    })
  ).default([]),
});

const DashboardSettingsSchema = z.object({
  monthlyRevenueGoal: z.number().default(30000),
  dueSoonDays: z.number().int().min(1).default(7),
  topCategoriesLimit: z.number().int().min(1).max(20).default(5),
  recentPaymentsLimit: z.number().int().min(1).max(20).default(5),
  topClientsLimit: z.number().int().min(1).max(20).default(5),
});

const isValidMonthDay = (value: string): boolean => {
  const [month, day] = value.split('-').map(Number);
  return day <= [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
};

export const BusinessReportingProfileSchema = z
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
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fiscalYearStart'],
        message: 'EÜR requires a calendar-year start (01-01)',
      });
    }
    if (['sole_proprietor', 'gbr', 'ek'].includes(profile.legalForm) && profile.profitDetermination !== 'eur') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['profitDetermination'],
        message: 'Sole proprietors require EÜR (cash-basis accounting)',
      });
    }
    if (profile.legalForm !== 'gmbh' && profile.legalForm !== 'ug') return;
    if (profile.profitDetermination !== 'double_entry') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['profitDetermination'],
        message: 'GmbH requires double-entry accounting',
      });
    }
    if (!profile.hgbSizeClass) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['hgbSizeClass'],
        message: 'GmbH requires an HGB size class',
      });
    }
    if (!profile.chart) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chart'],
        message: 'GmbH requires a ledger chart',
      });
    }
  });

// Mirrors datevSettingsSchema in @billme/desktop-contracts; the worker does not read it.
const DatevSettingsSchema = z.object({
  consultantNumber: z.string(),
  clientNumber: z.string(),
  accountLength: z.number().int().min(4).max(8).default(4),
  chart: z.enum(['SKR03', 'SKR04']).default('SKR03'),
});

const SettingsBaseSchema = z.object({
  businessReportingProfile: BusinessReportingProfileSchema.optional(),
  datev: DatevSettingsSchema.optional(),
  company: CompanySettingsSchema,
  finance: FinanceSettingsSchema,
  numbers: NumbersSettingsSchema,
  dunning: DunningSettingsSchema,
  legal: LegalSettingsSchema,
  portal: PortalSettingsSchema.optional().default({ baseUrl: '' }),
  eInvoice: EInvoiceSettingsSchema.optional().default({
    enabled: false,
    standard: 'zugferd-en16931',
    profile: 'EN16931',
    version: '2.3',
  }),
  email: EmailSettingsSchema.optional().default({
    provider: 'none',
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: true,
    smtpUser: '',
    fromName: '',
    fromEmail: '',
  }),
  automation: AutomationSettingsSchema.optional().default({
    dunningEnabled: false,
    dunningRunTime: '09:00',
    recurringEnabled: false,
    recurringRunTime: '03:00',
  }),
  catalog: CatalogSettingsSchema.optional().default({ categories: [] }),
  dashboard: DashboardSettingsSchema.optional().default({
    monthlyRevenueGoal: 30000,
    dueSoonDays: 7,
    topCategoriesLimit: 5,
    recentPaymentsLimit: 5,
    topClientsLimit: 5,
  }),
  onboardingCompleted: z.boolean().optional(),
  onboardingDraftSaved: z.boolean().optional(),
});

export const SettingsSchema = SettingsBaseSchema.transform((settings) => {
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
