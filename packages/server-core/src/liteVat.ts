import { z } from 'zod';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value);
export const liteVatPeriodSchema = z.object({ from: date, to: date }).refine(({ from, to }) => {
  const year = Number(from.slice(0, 4));
  const end = new Date(`${to}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 1);
  const months = (end.getUTCFullYear() - year) * 12 + end.getUTCMonth() - Number(from.slice(5, 7)) + 1;
  return [2025, 2026].includes(year) && to.startsWith(String(year)) && from <= to && from.endsWith('-01') && end.getUTCDate() === 1 && ([1, 12].includes(months) || (months === 3 && [1, 4, 7, 10].includes(Number(from.slice(5, 7)))));
}, 'Bitte einen vollständigen Monat, ein Kalenderquartal oder Kalenderjahr 2025/2026 wählen.');
const cents = z.number().int().safe();
export const liteVatReportSchema = z.object({
  from: date, to: date, method: z.enum(['soll', 'ist']), smallBusiness: z.boolean(), generatedAt: z.string(), sourceHash: z.string(),
  preparationComplete: z.boolean(), submissionReady: z.literal(false), outputVatCents: cents, inputVatCents: cents, payableCents: cents,
  reconciliation: z.object({ paymentCashCents: cents, paymentRecognizedCents: cents, paymentResidualCents: cents }),
  positions: z.array(z.object({ code: z.string(), taxCode: z.string().optional(), label: z.string(), direction: z.enum(['output', 'input', 'information']), basisCents: cents, taxCents: cents, basisWholeEuros: z.number().int() })),
  sources: z.array(z.object({ sourceType: z.enum(['invoice', 'receipt']), sourceId: z.string(), date, label: z.string(), code: z.string(), taxCode: z.string().optional(), rate: z.number(), basisCents: cents, taxCents: cents, direction: z.enum(['output', 'input', 'information']) })),
  issues: z.array(z.object({ code: z.string(), sourceId: z.string().optional(), message: z.string() })),
});
export const liteVatExportSchema = z.object({ fileName: z.string(), mimeType: z.enum(['application/pdf', 'text/csv']), contentBase64: z.string() });
export type LiteVatReport = z.infer<typeof liteVatReportSchema>;
