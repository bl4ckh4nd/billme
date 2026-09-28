import { z } from 'zod';

/**
 * Flow-layout document templates ("Vorlagen").
 *
 * A template no longer positions elements on a canvas. It picks a designed
 * preset, brand settings and the texts of fixed sections; the renderer lays
 * the sections out in document flow with DIN 5008 Form B geometry.
 */

export const templateKindSchema = z.enum([
  'invoice',
  'offer',
  'order_confirmation',
  'delivery_note',
  'credit_note',
  'dunning',
]);
export type TemplateKind = z.infer<typeof templateKindSchema>;

export const TEMPLATE_KIND_LABELS: Record<TemplateKind, string> = {
  invoice: 'Rechnung',
  offer: 'Angebot',
  order_confirmation: 'Auftragsbestätigung',
  delivery_note: 'Lieferschein',
  credit_note: 'Gutschrift / Storno',
  dunning: 'Mahnung',
};

export const templatePresetIdSchema = z.enum(['klassisch', 'modern', 'kompakt', 'elegant']);
export type TemplatePresetId = z.infer<typeof templatePresetIdSchema>;

export const templateFontSchema = z.enum(['inter', 'serif']);
export type TemplateFont = z.infer<typeof templateFontSchema>;

export const templateSectionIdSchema = z.enum([
  'letterhead',
  'addressBlock',
  'meta',
  'title',
  'intro',
  'items',
  'totals',
  'closing',
  'footer',
]);
export type TemplateSectionId = z.infer<typeof templateSectionIdSchema>;

export const templateColumnIdSchema = z.enum([
  'pos',
  'desc',
  'qty',
  'unit',
  'price',
  'discount',
  'taxRate',
  'total',
  // Dunning claim table
  'date',
  'dueDate',
]);
export type TemplateColumnId = z.infer<typeof templateColumnIdSchema>;

export const templateColumnSchema = z.object({
  id: templateColumnIdSchema,
  label: z.string().max(40),
  visible: z.boolean(),
});
export type TemplateColumn = z.infer<typeof templateColumnSchema>;

export const templateLogoSchema = z.object({
  dataUrl: z.string().startsWith('data:image/').max(200_000),
  position: z.enum(['left', 'right', 'center']),
  widthMm: z.number().min(15).max(80),
});
export type TemplateLogo = z.infer<typeof templateLogoSchema>;

export const documentTemplateBodySchema = z.object({
  schemaVersion: z.literal(1),
  presetId: templatePresetIdSchema,
  accentColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  font: templateFontSchema,
  logo: templateLogoSchema.nullable(),
  din: z.object({ foldMarks: z.boolean(), holeMark: z.boolean() }),
  sections: z.record(templateSectionIdSchema, z.object({ visible: z.boolean() })),
  columns: z.array(templateColumnSchema),
  texts: z.object({
    title: z.string(),
    intro: z.string(),
    closing: z.string(),
    senderLine: z.string(),
    meta: z.array(z.object({ label: z.string(), value: z.string() })).max(10),
    footerColumns: z.array(z.string()).max(4),
  }),
});
export type DocumentTemplateBody = z.infer<typeof documentTemplateBodySchema>;

export const documentTemplateRecordSchema = z.object({
  id: z.string().min(1),
  kind: templateKindSchema,
  name: z.string().min(1).max(120),
  version: z.number().int().positive(),
  body: documentTemplateBodySchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DocumentTemplateRecord = z.infer<typeof documentTemplateRecordSchema>;

type DocumentKindLike =
  | 'invoice'
  | 'order_confirmation'
  | 'delivery_note'
  | 'advance_invoice'
  | 'partial_invoice'
  | 'final_invoice'
  | 'credit_note'
  | 'cancellation_invoice';

/** Which template kind renders a stored document. Offers are their own record type. */
export const templateKindForDocument = (input: { isOffer?: boolean; documentKind?: DocumentKindLike }): TemplateKind => {
  if (input.isOffer) return 'offer';
  switch (input.documentKind) {
    case 'order_confirmation':
      return 'order_confirmation';
    case 'delivery_note':
      return 'delivery_note';
    case 'credit_note':
    case 'cancellation_invoice':
      return 'credit_note';
    default:
      return 'invoice';
  }
};

/** Per-kind default template; a missing kind renders the preset default. */
export const documentTemplateDefaultsSchema = z.record(templateKindSchema, z.string().min(1).nullable());
export type DocumentTemplateDefaults = z.infer<typeof documentTemplateDefaultsSchema>;

/**
 * Stored on the document. `snapshot` is frozen on first issue (Phase 6) and
 * references an append-only template version instead of copying the body,
 * so a logo does not bloat every document row.
 */
export const documentLayoutSchema = z.object({
  templateId: z.string().min(1).optional(),
  texts: z.object({ intro: z.string().optional(), closing: z.string().optional() }).optional(),
  snapshot: z.object({
    templateId: z.string().min(1),
    templateVersion: z.number().int().positive(),
    sender: z.record(z.unknown()),
    frozenAt: z.string(),
  }).optional(),
});
export type DocumentLayout = z.infer<typeof documentLayoutSchema>;
