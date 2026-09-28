import type {
  DocumentLayout,
  DocumentTemplateBody,
  TemplateColumn,
  TemplateColumnId,
  TemplateFont,
  TemplateKind,
  TemplatePresetId,
  TemplateSectionId,
} from './documentTemplate.js';

export type TemplatePreset = {
  id: TemplatePresetId;
  label: string;
  description: string;
  accentColor: string;
  font: TemplateFont;
};

export const TEMPLATE_PRESETS: TemplatePreset[] = [
  { id: 'klassisch', label: 'Klassisch', description: 'Serifenschrift, feine Linien, Logo rechts', accentColor: '#1f2328', font: 'serif' },
  { id: 'modern', label: 'Modern', description: 'Klare Sans-Serif mit Akzentfarbe im Kopf', accentColor: '#0f6b5c', font: 'inter' },
  { id: 'kompakt', label: 'Kompakt', description: 'Kleinere Schrift für viele Positionen', accentColor: '#334155', font: 'inter' },
  { id: 'elegant', label: 'Elegant', description: 'Zentrierter Kopf, viel Weißraum', accentColor: '#8a6a3a', font: 'serif' },
];

/** Columns whose content is a price; a delivery note never shows them. */
export const PRICE_COLUMNS: readonly TemplateColumnId[] = ['price', 'discount', 'taxRate', 'total'];

const column = (id: TemplateColumnId, label: string, visible = true): TemplateColumn => ({ id, label, visible });

const ITEM_COLUMNS: TemplateColumn[] = [
  column('pos', 'Pos.'),
  column('desc', 'Bezeichnung'),
  column('qty', 'Menge'),
  column('unit', 'Einheit', false),
  column('price', 'Einzelpreis'),
  column('discount', 'Rabatt', false),
  column('taxRate', 'USt.', false),
  column('total', 'Gesamt'),
];

const DUNNING_COLUMNS: TemplateColumn[] = [
  column('desc', 'Rechnung'),
  column('date', 'Rechnungsdatum'),
  column('dueDate', 'Fällig seit'),
  column('total', 'Betrag'),
];

const SIGNATURE = '\n\nMit freundlichen Grüßen\n{{my.owner}}';

const BASE_META = [
  { label: '{{invoice.numberLabel}}', value: '{{invoice.number}}' },
  { label: 'Datum', value: '{{invoice.date}}' },
  { label: 'Kunden-Nr', value: '{{client.number}}' },
];

type KindTexts = Pick<DocumentTemplateBody['texts'], 'title' | 'intro' | 'closing' | 'meta'>;

const KIND_TEXTS: Record<TemplateKind, KindTexts> = {
  invoice: {
    title: '{{invoice.documentLabel}} {{invoice.number}}',
    intro: 'Sehr geehrte Damen und Herren,\n\nvielen Dank für Ihren Auftrag. Wir berechnen Ihnen folgende Leistungen:',
    closing: `Bitte überweisen Sie den Gesamtbetrag bis zum {{invoice.dueDate}} ohne Abzug unter Angabe der Rechnungsnummer auf das unten genannte Konto.${SIGNATURE}`,
    meta: [
      ...BASE_META,
      { label: 'Leistungsdatum', value: '{{invoice.servicePeriod}}' },
      { label: 'Fällig am', value: '{{invoice.dueDate}}' },
      // Required for reverse charge and intra-EU supplies; dropped when empty.
      { label: 'Ihre USt-IdNr', value: '{{invoice.buyerVatId}}' },
    ],
  },
  offer: {
    title: 'Angebot {{invoice.number}}',
    intro: 'Sehr geehrte Damen und Herren,\n\nvielen Dank für Ihre Anfrage. Gerne bieten wir Ihnen folgende Leistungen an:',
    closing: `Dieses Angebot gilt bis zum {{offer.validUntil}}. Wir freuen uns auf Ihren Auftrag und stehen für Rückfragen gern zur Verfügung.${SIGNATURE}`,
    meta: [
      { label: 'Angebots-Nr', value: '{{invoice.number}}' },
      { label: 'Datum', value: '{{invoice.date}}' },
      { label: 'Kunden-Nr', value: '{{client.number}}' },
      { label: 'Gültig bis', value: '{{offer.validUntil}}' },
    ],
  },
  order_confirmation: {
    title: 'Auftragsbestätigung {{invoice.number}}',
    intro: 'Sehr geehrte Damen und Herren,\n\nvielen Dank für Ihren Auftrag. Wir bestätigen Ihnen die folgenden Leistungen:',
    closing: `Die Leistung erbringen wir wie vereinbart zum {{invoice.servicePeriod}}. Die Rechnung erhalten Sie nach Abschluss.${SIGNATURE}`,
    meta: [...BASE_META, { label: 'Leistungsdatum', value: '{{invoice.servicePeriod}}' }],
  },
  delivery_note: {
    title: 'Lieferschein {{invoice.number}}',
    intro: 'Sehr geehrte Damen und Herren,\n\nwir liefern Ihnen heute die folgenden Positionen:',
    closing: 'Ware vollständig und in einwandfreiem Zustand erhalten.\n\n\n\n________________________________\nDatum, Unterschrift Empfänger',
    meta: [...BASE_META, { label: 'Lieferdatum', value: '{{invoice.servicePeriod}}' }],
  },
  credit_note: {
    title: '{{invoice.documentLabel}} {{invoice.number}}',
    intro: 'Sehr geehrte Damen und Herren,\n\nhiermit erhalten Sie die folgende Korrektur:',
    closing: `Den Betrag verrechnen wir mit offenen Forderungen oder erstatten ihn auf Ihr Konto.${SIGNATURE}`,
    meta: [...BASE_META, { label: 'Bezug', value: '{{source.label}} {{source.number}} vom {{source.date}}' }],
  },
  dunning: {
    title: '{{dunning.levelName}}',
    intro: 'Sehr geehrte Damen und Herren,\n\nsicher ist Ihrer Aufmerksamkeit entgangen, dass die folgende Rechnung noch nicht beglichen ist. Bitte überweisen Sie den offenen Betrag bis zum {{dunning.payUntil}}.',
    closing: `Sollten Sie die Zahlung inzwischen veranlasst haben, betrachten Sie dieses Schreiben bitte als gegenstandslos.${SIGNATURE}`,
    meta: [
      { label: 'Datum', value: '{{dunning.date}}' },
      { label: 'Kunden-Nr', value: '{{client.number}}' },
      { label: 'Rechnungs-Nr', value: '{{invoice.number}}' },
    ],
  },
};

const ALL_SECTIONS: TemplateSectionId[] = ['letterhead', 'addressBlock', 'meta', 'title', 'intro', 'items', 'totals', 'closing', 'footer'];

export const DEFAULT_FOOTER_COLUMNS = [
  '{{my.name}}\n{{my.street}}\n{{my.zip}} {{my.city}}',
  'Tel. {{my.phone}}\n{{my.email}}\n{{my.website}}',
  '{{my.bank}}\nIBAN {{my.iban}}\nBIC {{my.bic}}',
  'Inhaber: {{my.owner}}\nSteuer-Nr. {{my.taxId}}\nUSt-IdNr. {{my.vatId}}\n{{my.registerCourt}}',
];

export const createDefaultTemplateBody = (kind: TemplateKind, presetId: TemplatePresetId = 'modern'): DocumentTemplateBody => {
  const preset = TEMPLATE_PRESETS.find((entry) => entry.id === presetId) ?? TEMPLATE_PRESETS[0]!;
  const texts = KIND_TEXTS[kind];
  const columns = (kind === 'dunning' ? DUNNING_COLUMNS : ITEM_COLUMNS).map((entry) => ({
    ...entry,
    visible: kind === 'delivery_note' && PRICE_COLUMNS.includes(entry.id) ? false : entry.visible,
  }));
  return {
    schemaVersion: 1,
    presetId: preset.id,
    accentColor: preset.accentColor,
    font: preset.font,
    logo: null,
    din: { foldMarks: true, holeMark: true },
    sections: Object.fromEntries(
      ALL_SECTIONS.map((id) => [id, { visible: !(kind === 'delivery_note' && id === 'totals') }]),
    ) as DocumentTemplateBody['sections'],
    columns,
    texts: {
      title: texts.title,
      intro: texts.intro,
      closing: texts.closing,
      senderLine: '{{my.name}} · {{my.street}} · {{my.zip}} {{my.city}}',
      meta: texts.meta,
      footerColumns: DEFAULT_FOOTER_COLUMNS,
    },
  };
};

/** Shape of the retired canvas templates (`templates.elements_json`). */
export type LegacyCanvasElement = {
  type: string;
  x?: number;
  label?: string;
  content?: string;
  src?: string;
  style?: { width?: number | string; color?: string };
};

// Texts the canvas defaults shipped with. Unchanged defaults give way to the
// new preset texts; anything the user edited is carried over.
const LEGACY_DEFAULT_TEXTS = new Set([
  '{{invoice.documentLabel}} {{invoice.number}}',
  'Angebot {{invoice.number}}',
  'Guten Tag,\n\nvielen Dank für Ihren Auftrag. Hier finden Sie die Rechnung für unsere Leistungen:',
  'Guten Tag,\n\nhier ist unser freibleibendes Angebot für die angefragten Leistungen:',
  'Bitte überweisen Sie den Betrag bis spätestens {{invoice.dueDate}} ohne Abzug auf das unten genannte Konto.\nEs gelten unsere AGB.',
  'Wenn Sie das Angebot annehmen möchten oder Fragen haben, melden Sie sich bitte.',
]);

const LEGACY_TEXT_TARGETS = { invoice_title: 'title', intro_text: 'intro', payment_terms: 'closing' } as const;
const PX_PER_MM = 3.78;

/** Converts a canvas template into the flow body: logo and edited texts survive, positions do not. */
export const migrateCanvasTemplate = (kind: TemplateKind, elements: LegacyCanvasElement[]): DocumentTemplateBody => {
  const body = createDefaultTemplateBody(kind);
  for (const element of elements) {
    const target = element.label ? LEGACY_TEXT_TARGETS[element.label as keyof typeof LEGACY_TEXT_TARGETS] : undefined;
    const content = element.content?.trim();
    if (target && content && !LEGACY_DEFAULT_TEXTS.has(content)) body.texts[target] = content;
  }
  const image = elements.find((element) =>
    element.type === 'IMAGE' && element.src?.startsWith('data:image/') && element.src.length <= 200_000);
  if (image?.src) {
    const widthPx = Number(image.style?.width) || 50 * PX_PER_MM;
    body.logo = {
      dataUrl: image.src,
      position: (image.x ?? 0) > 105 * PX_PER_MM ? 'right' : 'left',
      widthMm: Math.min(80, Math.max(15, Math.round(widthPx / PX_PER_MM))),
    };
  }
  return body;
};

export type ResolvedDocumentTemplate = { id?: string; version?: number; name?: string; body: DocumentTemplateBody };

/**
 * Picks the template a document renders with: its own choice, else the
 * default of its kind, else the preset. A template of another kind is never
 * used (an invoice template on a credit note). Frozen snapshots are resolved
 * by the caller before this, because they need the version log.
 */
export const resolveDocumentTemplate = (
  kind: TemplateKind,
  input: {
    templateId?: string;
    templates: ReadonlyArray<{ id: string; kind: string; version: number; name: string; body: DocumentTemplateBody }>;
    defaults: Partial<Record<TemplateKind, string | null>>;
  },
): ResolvedDocumentTemplate => {
  const chosen = [input.templateId, input.defaults[kind]]
    .map((id) => (id ? input.templates.find((template) => template.id === id && template.kind === kind) : undefined))
    .find(Boolean);
  return chosen
    ? { id: chosen.id, version: chosen.version, name: chosen.name, body: chosen.body }
    : { body: createDefaultTemplateBody(kind) };
};

/**
 * Freezes the layout of a document when it leaves draft: the template version
 * and the sender data (company, bank) it was issued with. An existing snapshot
 * is never replaced, so a reprint looks like the original.
 */
export const freezeDocumentLayout = (
  layout: DocumentLayout | undefined,
  template: { id: string; version: number },
  sender: Record<string, unknown>,
  frozenAt: string,
): DocumentLayout => (layout?.snapshot
  ? layout
  : { ...layout, snapshot: { templateId: template.id, templateVersion: template.version, sender, frozenAt } });
