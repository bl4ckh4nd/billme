import { z } from 'zod';
import { entityIdSchema, isoDateTimeSchema } from './foundations.js';

export const dunningEmailProviderSchema = z.enum(['smtp', 'resend', 'none']);
export type DunningEmailProvider = z.infer<typeof dunningEmailProviderSchema>;

export const dunningLevelSchema = z.object({
  id: z.number().int().nonnegative(),
  name: z.string(),
  enabled: z.boolean().default(true),
  daysAfterDueDate: z.number().int().nonnegative(),
  fee: z.number(),
  subject: z.string(),
  text: z.string(),
});
export type DunningLevel = z.infer<typeof dunningLevelSchema>;

export const dunningSettingsSchema = z.object({
  company: z.object({
    name: z.string(),
    email: z.string(),
  }),
  email: z.object({
    provider: dunningEmailProviderSchema,
    smtpHost: z.string(),
    smtpPort: z.number(),
    smtpSecure: z.boolean(),
    smtpUser: z.string(),
    fromName: z.string(),
    fromEmail: z.string(),
  }),
  dunning: z.object({
    levels: z.array(dunningLevelSchema),
  }),
  automation: z.object({
    dunningEnabled: z.boolean(),
    dunningRunTime: z.string(),
    lastDunningRun: z.string().optional(),
  }),
});
export type DunningSettings = z.infer<typeof dunningSettingsSchema>;

export const dunningHistoryEntrySchema = z.object({
  id: entityIdSchema,
  invoiceId: entityIdSchema,
  invoiceNumber: z.string(),
  dunningLevel: z.number().int().nonnegative(),
  daysOverdue: z.number().int().nonnegative(),
  feeApplied: z.number(),
  emailSent: z.boolean(),
  emailLogId: entityIdSchema.optional(),
  processedAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
});
export type DunningHistoryEntry = z.infer<typeof dunningHistoryEntrySchema>;

export const dunningHistoryEntryDraftSchema = dunningHistoryEntrySchema.omit({
  id: true,
  createdAt: true,
});
export type DunningHistoryEntryDraft = z.infer<typeof dunningHistoryEntryDraftSchema>;

export const dunningRunErrorSchema = z.object({
  invoiceNumber: z.string(),
  error: z.string(),
});
export type DunningRunError = z.infer<typeof dunningRunErrorSchema>;

export const dunningRunResultSchema = z.object({
  processedInvoices: z.number().int().nonnegative(),
  emailsSent: z.number().int().nonnegative(),
  feesApplied: z.number(),
  errors: z.array(dunningRunErrorSchema),
});
export type DunningRunResult = z.infer<typeof dunningRunResultSchema>;

export const invoiceDunningStatusSchema = z.object({
  currentLevel: z.number().int().nonnegative(),
  daysOverdue: z.number().int().nonnegative(),
  lastReminderSent: isoDateTimeSchema.optional(),
  totalFeesApplied: z.number(),
  history: z.array(dunningHistoryEntrySchema),
});
export type InvoiceDunningStatus = z.infer<typeof invoiceDunningStatusSchema>;

/** Document kinds that create a receivable and can therefore fall overdue. */
const RECEIVABLE_DOCUMENT_KINDS = new Set(['invoice', 'advance_invoice', 'partial_invoice', 'final_invoice']);

const localIsoDate = (now: Date): string => {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
};

type OverdueCandidate = { status: string; dueDate: string; documentKind?: string | null };

/**
 * "Überfällig" is derived from the due date, never trusted from storage: an
 * open receivable whose due date lies before today (local calendar day) is
 * overdue, and a stored `overdue` whose due date moved into the future is not.
 */
export const isInvoiceOverdue = (invoice: OverdueCandidate, now: Date = new Date()): boolean => {
  if (invoice.status !== 'open' && invoice.status !== 'overdue') return false;
  if (!RECEIVABLE_DOCUMENT_KINDS.has(invoice.documentKind ?? 'invoice')) return false;
  const due = invoice.dueDate?.slice(0, 10);
  return Boolean(due) && due < localIsoDate(now);
};

/** Returns the invoice with its status derived via {@link isInvoiceOverdue}. */
export const withEffectiveInvoiceStatus = <T extends OverdueCandidate>(invoice: T, now: Date = new Date()): T => {
  if (invoice.status !== 'open' && invoice.status !== 'overdue') return invoice;
  const status = isInvoiceOverdue(invoice, now) ? 'overdue' : 'open';
  return status === invoice.status ? invoice : { ...invoice, status };
};
