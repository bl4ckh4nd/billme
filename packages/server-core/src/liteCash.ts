import { z } from 'zod';

const cashDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value, 'Ungültiges Kalenderdatum.');
const cents = z.number().int().safe();

const cashEntryFields = z.object({
  id: z.string().min(1), cashDate, amountCents: cents.refine((value) => value !== 0), currency: z.literal('EUR'),
  flowType: z.enum(['income', 'expense']), counterparty: z.string().trim().min(1), purpose: z.string().trim().min(1), receiptId: z.string().min(1).optional(),
});
export const liteCashEntryInputSchema = cashEntryFields.refine(cashFlowSignMatches, 'Vorzeichen und Zahlungsrichtung stimmen nicht überein.');

function cashFlowSignMatches(entry: { flowType: 'income' | 'expense'; amountCents: number }): boolean {
  return entry.flowType === 'income' ? entry.amountCents > 0 : entry.amountCents < 0;
}

export const liteCashEntrySchema = cashEntryFields.extend({
  originalCashDate: cashDate, matchedTransactionId: z.string().optional(), accountId: z.string().optional(), updatedAt: z.string(),
}).refine(cashFlowSignMatches, 'Vorzeichen und Zahlungsrichtung stimmen nicht überein.');
export const liteReceiptInputSchema = z.object({
  id: z.string().min(1), number: z.string().trim().min(1), counterparty: z.string().trim().min(1), documentDate: cashDate,
  receivedDate: cashDate.optional(), serviceDate: cashDate.optional(), grossAmountCents: cents.refine((value) => value !== 0),
  taxMode: z.enum(['domestic', 'exempt', 'reverse_charge', 'eu_service', 'intra_eu_acquisition', 'import', 'small_business']),
  deductiblePercent: z.number().min(0).max(100), reviewed: z.boolean(), advancePayment: z.boolean().optional(),
  importTaxDate: cashDate.optional(), correctionOfReceiptId: z.string().min(1).optional(), adjustmentDate: cashDate.optional(), correctionReason: z.string().trim().min(1).optional(),
  taxBreakdown: z.array(z.object({ rate: z.union([z.literal(0), z.literal(7), z.literal(19)]), netAmountCents: cents, vatAmountCents: cents })).max(20),
});
export const liteReceiptSchema = liteReceiptInputSchema.extend({ updatedAt: z.string(), fileCount: z.number().int().nonnegative() });
export const liteReceiptFileSchema = z.object({ id: z.string(), receiptId: z.string(), fileName: z.string(), mimeType: z.string(), sha256: z.string(), byteLength: z.number().int(), createdAt: z.string() });
export const liteReceiptUploadSchema = z.object({ fileName: z.string().trim().min(1).max(255), mimeType: z.enum(['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'application/xml', 'text/xml']), contentBase64: z.string().min(1).max(14_000_000), reason: z.string().trim().min(1) });
export type LiteCashEntry = z.infer<typeof liteCashEntrySchema>;
export type LiteReceipt = z.infer<typeof liteReceiptSchema>;
