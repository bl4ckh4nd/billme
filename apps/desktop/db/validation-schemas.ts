import { z } from 'zod';
import { logger } from '../utils/logger';

/**
 * Validation schemas for JSON.parse() operations
 * These schemas ensure that JSON data from the database is valid before use
 */

// Template element schemas
const TextElementSchema = z.object({
  id: z.string(),
  type: z.literal('TEXT'),
  x: z.number(),
  y: z.number(),
  zIndex: z.number(),
  content: z.string().optional(),
  style: z.record(z.any()),
  label: z.string().optional(),
});

const ImageElementSchema = z.object({
  id: z.string(),
  type: z.literal('IMAGE'),
  x: z.number(),
  y: z.number(),
  zIndex: z.number(),
  src: z.string().optional(),
  style: z.record(z.any()),
  label: z.string().optional(),
});

const BoxElementSchema = z.object({
  id: z.string(),
  type: z.literal('BOX'),
  x: z.number(),
  y: z.number(),
  zIndex: z.number(),
  style: z.record(z.any()),
  label: z.string().optional(),
});

const TableColumnSchema = z.object({
  id: z.string(),
  label: z.string(),
  width: z.number(),
  visible: z.boolean(),
  align: z.enum(['left', 'center', 'right']),
});

const TableRowSchema = z.object({
  id: z.string(),
  cells: z.array(z.string()),
});

const TableElementSchema = z.object({
  id: z.string(),
  type: z.literal('TABLE'),
  x: z.number(),
  y: z.number(),
  zIndex: z.number(),
  tableData: z.object({
    columns: z.array(TableColumnSchema),
    rows: z.array(TableRowSchema),
  }).optional(),
  style: z.record(z.any()),
  label: z.string().optional(),
});

const LineElementSchema = z.object({
  id: z.string(),
  type: z.literal('LINE'),
  x: z.number(),
  y: z.number(),
  zIndex: z.number(),
  style: z.record(z.any()),
  label: z.string().optional(),
});

const QRCodeElementSchema = z.object({
  id: z.string(),
  type: z.literal('QRCODE'),
  x: z.number(),
  y: z.number(),
  zIndex: z.number(),
  qrData: z.object({
    iban: z.string(),
    bic: z.string(),
    amount: z.number(),
    reference: z.string(),
  }).optional(),
  style: z.record(z.any()),
  label: z.string().optional(),
});

export const TemplateElementSchema = z.discriminatedUnion('type', [
  TextElementSchema,
  ImageElementSchema,
  BoxElementSchema,
  TableElementSchema,
  LineElementSchema,
  QRCodeElementSchema,
]);

export const TemplateElementsSchema = z.array(TemplateElementSchema);

// Address schema
export const AddressSchema = z.object({
  street: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  zip: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
  company: z.string().optional(),
  contactPerson: z.string().optional(),
});

// Invoice item schema
export const InvoiceItemSchema = z.object({
  description: z.string(),
  quantity: z.number(),
  price: z.number(),
  total: z.number(),
  articleId: z.string().optional(),
  category: z.string().optional(),
});

export const InvoiceItemsSchema = z.array(InvoiceItemSchema);

// Settings schema components
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
});

const DunningLevelSchema = z.object({
  id: z.number(),
  name: z.string(),
  enabled: z.boolean().optional().default(true),
  daysAfterDueDate: z.number(),
  fee: z.number(),
  subject: z.string(),
  text: z.string(),
});

const DunningSettingsSchema = z.object({
  levels: z.array(DunningLevelSchema),
});

const LegalSettingsSchema = z.object({
  smallBusinessRule: z.boolean(),
  defaultVatRate: z.number(),
  taxAccountingMethod: z.enum(['soll', 'ist']).optional().default('soll'),
  paymentTermsDays: z.number(),
  defaultIntroText: z.string(),
  defaultFooterText: z.string(),
});

const PortalSettingsSchema = z.object({
  baseUrl: z.string().optional().default(''),
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

export const SettingsSchema = z.object({
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
});

// Tags schema (for clients)
export const TagsSchema = z.array(z.string());

// Generic fallback for unknown JSON structures
export const UnknownJsonSchema = z.unknown();

/**
 * Safe JSON parse with validation
 * Returns parsed data or default value on error
 */
export function safeJsonParse<T>(
  jsonString: string | null,
  schema: z.ZodType<T>,
  defaultValue: T,
  context?: string
): T {
  if (!jsonString || jsonString === 'null') {
    return defaultValue;
  }

  try {
    const parsed = JSON.parse(jsonString);
    return schema.parse(parsed);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('JSONValidation', `${context || 'Unknown context'}: ${errorMessage}`, error as Error, {
      rawJson: jsonString?.substring(0, 200)
    });
    return defaultValue;
  }
}

/**
 * Safe JSON parse that throws on error (for critical data)
 */
export function strictJsonParse<T>(
  jsonString: string | null,
  schema: z.ZodType<T>,
  context?: string
): T {
  if (!jsonString || jsonString === 'null') {
    throw new Error(`${context || 'JSON'}: Null or empty JSON string`);
  }

  try {
    const parsed = JSON.parse(jsonString);
    return schema.parse(parsed);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('JSONValidation', `${context || 'Unknown context'}: ${errorMessage}`, error as Error, {
      rawJson: jsonString?.substring(0, 200)
    });
    throw new Error(`${context || 'JSON'} validation failed: ${errorMessage}`);
  }
}
