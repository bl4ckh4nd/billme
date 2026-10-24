import { z } from 'zod';

/** An e-invoice file sent for reading: CII/UBL XML or a PDF with the XML attached. */
export const einvoiceParseRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  // 14 MB of bytes as base64.
  contentBase64: z.string().min(1).max(19_000_000),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const amount = z.number().finite();

/** A received e-invoice (EN 16931) as a person reads it; `warnings` are German. */
export const incomingEinvoiceSchema = z.object({
  syntax: z.enum(['CII', 'UBL']),
  /** BT-24 specification identifier (e.g. XRechnung 3.0, EN 16931, Factur-X profile). */
  profile: z.string().optional(),
  /** Where the XML came from: the file itself or the attachment of a PDF. */
  source: z.object({ kind: z.enum(['xml', 'pdf']), attachmentName: z.string().optional() }),
  typeCode: z.string().optional(),
  isCreditNote: z.boolean(),
  number: z.string().optional(),
  issueDate: isoDate.optional(),
  dueDate: isoDate.optional(),
  /** BT-72 */
  serviceDate: isoDate.optional(),
  /** BG-14 */
  period: z.object({ start: isoDate.optional(), end: isoDate.optional() }).optional(),
  currency: z.string().optional(),
  buyerReference: z.string().optional(),
  seller: z.object({
    name: z.string().optional(),
    vatId: z.string().optional(),
    taxId: z.string().optional(),
    street: z.string().optional(),
    zip: z.string().optional(),
    city: z.string().optional(),
    country: z.string().optional(),
    email: z.string().optional(),
  }),
  buyer: z.object({ name: z.string().optional(), vatId: z.string().optional() }),
  iban: z.string().optional(),
  bic: z.string().optional(),
  paymentReference: z.string().optional(),
  lines: z.array(z.object({
    description: z.string(),
    quantity: amount.optional(),
    unit: z.string().optional(),
    netPrice: amount.optional(),
    netAmount: amount.optional(),
    vatRate: amount.optional(),
    vatCategory: z.string().optional(),
  })),
  vatBreakdown: z.array(z.object({ category: z.string(), rate: amount, netAmount: amount, vatAmount: amount })),
  totals: z.object({ net: amount.optional(), vat: amount.optional(), gross: amount.optional(), due: amount.optional() }),
  notes: z.array(z.string()),
  warnings: z.array(z.string()),
});
export type IncomingEinvoice = z.infer<typeof incomingEinvoiceSchema>;

/** XRechnung profile identifier (BT-24) for CII. */
export const XRECHNUNG_GUIDELINE_ID = 'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0';

export const xrechnungExportSchema = z.object({ fileName: z.string(), mimeType: z.literal('application/xml'), contentBase64: z.string() });
