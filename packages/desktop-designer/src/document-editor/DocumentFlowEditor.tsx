import React from 'react';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button, Combobox, Input, Kbd } from '@billme/ui';
import { ArrowDown, ArrowUp, GripVertical, LockKeyhole, Plus, RotateCcw, Trash2, UnlockKeyhole, UserRound } from 'lucide-react';
import { getInvoiceTaxModeDefinition } from '@billme/server-core/services';
import type { DocumentViewModel } from '@billme/desktop-utils/document';
import type { ArticleLike, ClientLike, DocumentDraft, DraftItem, ProjectLike } from './types';
import '@fontsource-variable/inter';
import '@fontsource-variable/source-serif-4';
import '../flow/flow.css';

/** A billing row as the editor table shows it: `id` starts with the item index. */
interface TableRow {
  id: string;
  kind?: string;
  cells: string[];
}

interface TableColumn {
  id: string;
  label: string;
  visible: boolean;
  align?: 'left' | 'center' | 'right';
}

export interface DocumentFlowEditorProps {
  /** The view model preview and print render from; supplies texts, columns and totals. */
  model: DocumentViewModel;
  /** Billing rows edited directly on the sheet. Omit for a read-only sheet. */
  items?: DraftItem[];
  onItemsChange?: (items: DraftItem[], options?: { coalesce?: boolean }) => void;
  formatCurrency?: (amount: number) => string;
  taxRateOptions?: number[];
  documentFields?: DocumentFlowDocumentFields;
  /** Catalog source for contextual article suggestions in billing rows. */
  articles?: ArticleLike[];
}

export type DocumentDraftUpdater = (
  next: DocumentDraft | ((previous: DocumentDraft) => DocumentDraft),
  options?: { coalesce?: boolean },
) => void;

export interface DocumentFlowDocumentFields {
  document: DocumentDraft;
  templateType: 'invoice' | 'offer';
  /** Unresolved intro/closing of the template, shown until the document overrides them. */
  templateTexts: { intro: string; closing: string };
  clients: ClientLike[];
  projects: ProjectLike[];
  selectedClientId: string;
  selectedClientLabel: string;
  selectedProjectLabel: string;
  onChange: DocumentDraftUpdater;
  onClientNameChange?: (value: string) => void;
  onAddressChange?: (value: string) => void;
  onStartManualRecipient: () => void;
  onSelectClient: (client: ClientLike) => void;
  onSelectProject: (project: ProjectLike) => void;
  onUnlockNumber?: () => void;
  isNumberLocked?: boolean;
  fieldErrors?: {
    number?: string;
    date?: string;
    client?: string;
    buyerVatId?: string;
    taxRule?: string;
    taxCountry?: string;
    destinationVatRate?: string;
    datevEvidenceType?: string;
    datevEvidenceReference?: string;
    datevSachverhaltLl?: string;
    items?: Record<number, string>;
  };
  taxModeOptions?: Array<{ value: string; label: string }>;
  taxRateOptions?: number[];
  resolvedTaxMode?: string;
  taxRecommendation?: { mode: string; reason: string };
  taxRecommendationLabel?: string;
  /** Legal sentence the rendered document prints for the chosen tax model, if any. */
  taxLegalText?: string;
  buyerCountryCode?: string;
  sellerCountryCode?: string;
  requiresBuyerVatId?: boolean;
  requiresTaxCountry?: boolean;
  requiresDestinationVatRate?: boolean;
  requiresDatevEvidence?: boolean;
  requiresDatevSachverhaltLl?: boolean;
  taxDetailsOpen?: boolean;
  onTaxDetailsOpenChange?: (open: boolean) => void;
  vatValidationPending?: boolean;
  onValidateBuyerVatId?: () => void;
}

const defaultCurrency = (amount: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
const lineKinds: Array<NonNullable<DraftItem['kind']>> = ['item', 'time', 'optional', 'text', 'group', 'summary'];
const kindLabels: Record<NonNullable<DraftItem['kind']>, string> = {
  item: 'Position',
  time: 'Zeit',
  optional: 'Optional',
  text: 'Text',
  group: 'Abschnitt',
  summary: 'Zwischensumme',
};

const sourceIndexFromRow = (row: TableRow): number | undefined => {
  const match = /^(\d+)/.exec(row.id);
  if (!match) return undefined;
  const index = Number(match[1]);
  return Number.isInteger(index) ? index : undefined;
};

const lineAmount = (item: DraftItem): number => {
  if (item.kind === 'group' || item.kind === 'summary' || item.kind === 'text') return 0;
  const quantity = Number(item.quantity) || 0;
  const price = Number(item.price) || 0;
  const discount = Math.min(100, Math.max(0, Number(item.discountPercent) || 0));
  return Math.round(quantity * price * (1 - discount / 100) * 100) / 100;
};

const isBillableKind = (kind: DraftItem['kind']): boolean => kind === undefined || kind === 'item' || kind === 'time' || kind === 'optional';

// Page-anchored micro type: the billing rows and the field boxes below are laid out
// on the A4 sheet with authored positions and sizes, so their labels stay at 10-11px
// rather than the 12px floor. Everything outside the page uses text-xs.
const controlClass ='billing-line-control h-4 min-w-0 rounded-sm border-0 bg-transparent px-0 text-inherit hover:bg-surface-muted/50 focus:bg-accent/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

const cellValue = (row: TableRow, column: TableColumn, index: number): string => {
  if (!column.visible) return '';
  return row.cells[index] ?? '';
};

interface InlineRowProps {
  row: TableRow;
  columns: TableColumn[];
  items: DraftItem[];
  onItemsChange: (items: DraftItem[], options?: { coalesce?: boolean }) => void;
  formatCurrency: (amount: number) => string;
  taxRateOptions: number[];
  defaultTaxRate: number;
  forceZeroVat: boolean;
  articles: ArticleLike[];
  fieldErrors?: Record<number, string>;
  sortable?: SortableBindings;
}

type SortableBindings = Pick<ReturnType<typeof useSortable>, 'setNodeRef' | 'setActivatorNodeRef' | 'attributes' | 'listeners' | 'transform' | 'transition' | 'isDragging'>;

const InlineBillingRow: React.FC<InlineRowProps> = ({ row, columns, items, onItemsChange, formatCurrency, taxRateOptions, defaultTaxRate, forceZeroVat, articles, fieldErrors, sortable }) => {
  const sourceIndex = sourceIndexFromRow(row);
  const item = sourceIndex === undefined ? undefined : items[sourceIndex];
  const continuation = row.kind === 'row-continuation' || row.kind === 'group-continuation';

  if (sourceIndex === undefined || !item || continuation) {
    return (
      <tr key={row.id} data-line-kind={row.kind} data-line-row-id={row.id} className="border-b border-border">
        {columns.map((column, index) => column.visible ? (
          <td key={`${row.id}-${column.id}`} style={{ textAlign: column.align || 'left' }} className="p-2 truncate">{cellValue(row, column, index)}</td>
        ) : null)}
      </tr>
    );
  }

  const kind = item.kind ?? 'item';
  const update = (patch: Partial<DraftItem>) => {
    onItemsChange(items.map((candidate, index) => index === sourceIndex ? {
      ...candidate,
      ...patch,
      total: isBillableKind(patch.kind ?? candidate.kind) ? lineAmount({ ...candidate, ...patch }) : 0,
    } : candidate), { coalesce: true });
  };
  const move = (direction: -1 | 1) => {
    const target = sourceIndex + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[sourceIndex], next[target]] = [next[target], next[sourceIndex]];
    onItemsChange(next);
  };
  const duplicate = () => onItemsChange([...items.slice(0, sourceIndex + 1), { ...item }, ...items.slice(sourceIndex + 1)]);
  const remove = () => onItemsChange(items.filter((_, index) => index !== sourceIndex));
  const effectiveTaxRate = item.taxRate ?? defaultTaxRate;
  const showTaxBadge = isBillableKind(kind) && !forceZeroVat && effectiveTaxRate !== defaultTaxRate;
  const descriptionError = fieldErrors?.[sourceIndex];
  const descriptionErrorId = `document-item-${sourceIndex}-description-error`;
  const descriptionFieldId = `document-item-${sourceIndex}-description`;
  const renderDescription = () => (
    <>
      <div id={descriptionFieldId} data-field-block data-field-error={descriptionError ? 'true' : undefined} className="relative min-w-0">
        <div className="flex min-w-0 items-center gap-1">
        {articles.length > 0 && isBillableKind(kind) ? (
          <div className="min-w-0 flex-1">
          <Combobox
            ref={(input) => {
              if (!input) return;
              input.id = `${descriptionFieldId}-input`;
              input.setAttribute('aria-invalid', String(Boolean(descriptionError)));
              input.required = true;
              input.setAttribute('aria-required', 'true');
              if (descriptionError) input.setAttribute('aria-describedby', descriptionErrorId);
              else input.removeAttribute('aria-describedby');
            }}
            items={articles}
            value={item.description}
            onValueChange={(value) => update({ description: value })}
            onSelect={(article) => update({ articleId: article.id, description: article.title, price: article.price, unit: article.unit, taxRate: article.taxRate, category: article.category, total: lineAmount({ ...item, price: article.price, unit: article.unit, taxRate: article.taxRate }) })}
            getLabel={(article) => article.title}
            getSublabel={(article) => `${article.unit} · ${formatCurrency(article.price)}${article.category ? ` · ${article.category}` : ''}`}
            getSearchText={(article) => `${article.title} ${article.sku ?? ''} ${article.description ?? ''} ${article.category}`}
            allowFreeText
            showSearchIcon={false}
            inputClassName={`${controlClass} min-w-0 text-sm font-medium ${descriptionError ? 'border border-error' : ''}`}
            placeholder="Beschreibung"
            aria-label={`Beschreibung Position ${sourceIndex + 1}`}
          />
          </div>
        ) : (
          <input
            id={`${descriptionFieldId}-input`}
            aria-label={`Beschreibung ${sourceIndex + 1}`}
            aria-invalid={Boolean(descriptionError)}
            aria-describedby={descriptionError ? descriptionErrorId : undefined}
            aria-required="true"
            required
            data-line-description={sourceIndex}
            value={item.description}
            onChange={(event) => update({ description: event.target.value })}
            className={`${controlClass} min-w-0 flex-1 font-medium ${descriptionError ? 'border border-error' : ''}`}
            placeholder={kind === 'group' ? 'Bauabschnitt' : kind === 'summary' ? 'Zwischensumme' : 'Beschreibung'}
          />
        )}
        <span aria-hidden="true" className="shrink-0 text-error">*</span>
        {kind === 'optional' ? <span className="shrink-0 rounded-sm bg-warning/15 px-1 text-[10px] font-bold uppercase tracking-wide text-warning-text">optional</span> : null}
        {showTaxBadge ? <span className="ml-auto shrink-0 rounded-sm bg-surface-muted px-1 text-[10px] font-semibold text-muted print:hidden">{effectiveTaxRate} %</span> : null}
      <div className="pointer-events-none absolute -left-12 top-1/2 z-20 flex -translate-y-1/2 items-center gap-0.5 opacity-0 motion-safe:transition-opacity motion-reduce:transition-none group-hover/line:pointer-events-auto group-hover/line:opacity-100 group-focus-within/line:pointer-events-auto group-focus-within/line:opacity-100 print:hidden">
        <button type="button" aria-label={`Zeile ${sourceIndex + 1} nach oben`} onClick={() => move(-1)} className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-sm px-1 text-muted hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"><ArrowUp size={12} aria-hidden="true" /></button>
        <button type="button" aria-label={`Zeile ${sourceIndex + 1} nach unten`} onClick={() => move(1)} className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-sm px-1 text-muted hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"><ArrowDown size={12} aria-hidden="true" /></button>
        </div>
        {descriptionError ? <p id={descriptionErrorId} className="mt-0.5 min-w-0 text-xs text-error-text">{descriptionError}</p> : null}
      </div>
      <div className="pointer-events-none absolute -right-14 top-1/2 z-20 flex -translate-y-1/2 items-center gap-0.5 opacity-0 motion-safe:transition-opacity motion-reduce:transition-none group-hover/line:pointer-events-auto group-hover/line:opacity-100 group-focus-within/line:pointer-events-auto group-focus-within/line:opacity-100 print:hidden">
        <button type="button" aria-label={`Zeile ${sourceIndex + 1} duplizieren`} onClick={duplicate} className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-sm px-1 text-muted hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"><Plus size={12} aria-hidden="true" /></button>
        <button type="button" aria-label={`Zeile ${sourceIndex + 1} löschen`} onClick={remove} className="inline-flex min-h-6 min-w-6 items-center justify-center rounded-sm px-1 text-error-text hover:bg-error-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"><Trash2 size={12} aria-hidden="true" /></button>
      </div>
      </div>
      {/* // ponytail: strip is clipped for a focused row at the very top of a page (DocumentPages.tsx page overflow:hidden); rare, acceptable. */}
      <div className="pointer-events-none absolute bottom-full left-0 z-30 flex items-center gap-1 border border-border bg-white px-1 py-0.5 text-[10px] opacity-0 motion-safe:transition-opacity motion-reduce:transition-none group-focus-within/line:pointer-events-auto group-focus-within/line:opacity-100 print:hidden">
        <label className="flex items-center gap-1 text-muted"><span>Zeilentyp</span><select
          aria-label={`Zeilentyp ${sourceIndex + 1}`}
          value={kind}
          onChange={(event) => update({ kind: event.target.value as DraftItem['kind'] })}
          className={`${controlClass} shrink-0 text-[10px] font-semibold uppercase tracking-wide text-muted`}
        >
          {lineKinds.map((lineKind) => <option key={lineKind} value={lineKind}>{kindLabels[lineKind]}</option>)}
        </select></label>
        {isBillableKind(kind) && !forceZeroVat ? <label className="flex items-center gap-1 text-muted"><span>USt %</span><select
          aria-label={`Umsatzsteuer Position ${sourceIndex + 1}`}
          value={effectiveTaxRate}
          onChange={(event) => update({ taxRate: Number(event.target.value) })}
          className={`${controlClass} w-9 shrink-0 text-right text-[10px]`}
        >
          {taxRateOptions.map((rate) => <option key={rate} value={rate}>{rate}%</option>)}
        </select></label> : null}
        {kind === 'summary' ? <label className="flex items-center gap-1 text-muted"><span>Summenbereich</span><select aria-label={`Summenbereich ${sourceIndex + 1}`} value={item.summaryScope ?? 'running'} onChange={(event) => update({ summaryScope: event.target.value as DraftItem['summaryScope'] })} className={`${controlClass} w-16 shrink-0 text-[10px]`}><option value="running">laufend</option><option value="group">Abschnitt</option></select></label> : null}
        {kind === 'summary' ? <label className="flex items-center gap-1 text-muted"><span>Summenmetrik</span><select aria-label={`Summenmetrik ${sourceIndex + 1}`} value={item.summaryMetric ?? 'amount'} onChange={(event) => update({ summaryMetric: event.target.value as DraftItem['summaryMetric'] })} className={`${controlClass} w-14 shrink-0 text-[10px]`}><option value="amount">Betrag</option><option value="quantity">Menge</option></select></label> : null}
      </div>
    </>
  );

  return (
    <tr ref={sortable?.setNodeRef} key={row.id} data-line-kind={kind} data-line-row-id={row.id} data-line-index={sourceIndex} data-line-dragging={sortable?.isDragging ? 'true' : undefined} tabIndex={-1} onKeyDown={(event) => { if (!(event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown'))) return; event.preventDefault(); move(event.key === 'ArrowUp' ? -1 : 1); }} style={{ transform: CSS.Transform.toString(sortable?.transform ?? null), transition: sortable?.transition }} className={`group/line border-b border-border ${kind === 'group' ? 'bg-accent/10 font-bold' : ''} ${kind === 'summary' ? 'border-t border-black/10 font-bold' : ''} ${kind === 'text' ? 'italic text-muted' : ''} ${kind === 'optional' ? 'text-muted' : ''} ${sortable?.isDragging ? 'opacity-50' : ''}`}>
      {columns.map((column, index) => {
        if (!column.visible) return null;
        const columnId = column.id.toLowerCase();
        const isDescription = columnId.includes('desc') || columnId.includes('bezeich');
        let content: React.ReactNode = cellValue(row, column, index);
        if (isDescription) content = renderDescription();
        else if (columnId.includes('qty') || columnId.includes('menge')) content = kind === 'group' || kind === 'summary' || kind === 'text' ? '' : <input aria-label="Menge" type="number" step="0.01" value={item.quantity} onChange={(event) => update({ quantity: Number(event.target.value) })} className={`${controlClass} w-full text-right`} />;
        else if (columnId.includes('unit') || columnId.includes('einheit')) content = kind === 'group' || kind === 'summary' || kind === 'text' ? '' : <input aria-label={`Einheit ${sourceIndex + 1}`} value={item.unit ?? ''} onChange={(event) => update({ unit: event.target.value })} className={`${controlClass} w-full text-center`} />;
        else if (columnId.includes('price') || columnId.includes('einzel')) content = kind === 'group' || kind === 'summary' || kind === 'text' ? '' : <input aria-label={`Einzelpreis ${sourceIndex + 1}`} type="number" step="0.01" value={item.price} onChange={(event) => update({ price: Number(event.target.value) })} className={`${controlClass} w-full text-right`} />;
        else if (columnId.includes('total') || columnId.includes('gesamt')) content = kind === 'optional' ? '–' : kind === 'group' || kind === 'summary' || kind === 'text' ? cellValue(row, column, index) : formatCurrency(lineAmount(item));
        if (index === 0) {
          const dragHandle = <button ref={sortable?.setActivatorNodeRef} type="button" aria-label={`Zeile ${sourceIndex + 1} verschieben`} data-line-drag-handle={sourceIndex} {...sortable?.attributes} {...sortable?.listeners} className="absolute -left-8 top-1/2 inline-flex min-h-6 min-w-6 -translate-y-1/2 cursor-grab items-center justify-center rounded-sm px-1 text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring print:hidden"><GripVertical size={12} aria-hidden="true" /></button>;
          content = isDescription ? <>{content}{dragHandle}</> : <div className="relative">{content}{dragHandle}</div>;
        }
        return <td key={`${row.id}-${column.id}`} style={{ textAlign: column.align || 'left' }} className="relative p-2 align-middle">{content}</td>;
      })}
    </tr>
  );
};

type SortableInlineRowProps = Omit<InlineRowProps, 'sortable'> & { sortableId: string };

const SortableInlineBillingRow: React.FC<SortableInlineRowProps> = ({ sortableId, ...props }) => {
  const sortable = useSortable({ id: sortableId });
  return <InlineBillingRow {...props} sortable={sortable} />;
};

const makeNewItem = (kind: DraftItem['kind']): DraftItem => ({
  kind,
  description: kind === 'group' ? 'Neuer Bauabschnitt' : kind === 'summary' ? 'Zwischensumme' : kind === 'text' ? 'Hinweis' : 'Neue Position',
  quantity: kind === 'group' || kind === 'summary' || kind === 'text' ? 0 : 1,
  price: kind === 'group' || kind === 'summary' || kind === 'text' ? 0 : 0,
  total: 0,
  unit: kind === 'group' || kind === 'summary' || kind === 'text' ? undefined : 'Stk.',
  summaryScope: kind === 'summary' ? 'running' : undefined,
  summaryMetric: kind === 'summary' ? 'amount' : undefined,
});

const documentInputClass ='w-full border-0 bg-transparent px-0 py-0.5 text-inherit hover:bg-surface-muted/50 focus:bg-accent/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';
// On-page micro type: these labels live inside boxes whose position and size come
// from the A4 template elements, so 10px is kept here instead of the 12px floor.
const documentLabelClass = 'text-[10px] text-muted';

const clientAddressSublabel = (client: ClientLike) => {
  const billingAddress = client.addresses?.find((address) => address.isDefaultBilling);
  if (billingAddress) {
    const city = [billingAddress.zip, billingAddress.city].map((part) => part?.trim()).filter(Boolean).join(' ');
    return [city, billingAddress.street?.trim()].filter(Boolean).join(' · ');
  }
  return client.address?.replace(/\s+/g, ' ').trim() ?? '';
};

const clientSublabel = (client: ClientLike) => [clientAddressSublabel(client), client.customerNumber?.trim()].filter(Boolean).join(' · ') || undefined;

interface InlineDocumentFieldsProps {
  fields: DocumentFlowDocumentFields;
  defaultTaxRate: number;
}

const mm = (value: number) => value * (96 / 25.4);
// DIN 5008 Form B, matching the print layout in flow.css.
const RECIPIENT_BOX = { x: mm(25), y: mm(59), width: mm(80), height: mm(33) };
const META_BOX = { x: mm(125), y: mm(50), width: mm(65), height: mm(42) };

/**
 * Recipient and header fields sit in the DIN address and info fields of the
 * first page, where the printed document shows them.
 */
const InlineDocumentFields: React.FC<InlineDocumentFieldsProps> = ({ fields, defaultTaxRate }) => {
  const { document, templateType } = fields;
  const meta = META_BOX;
  const recipient = RECIPIENT_BOX;
  const error = (id: string, value?: string) => value ? <p id={id} className="mt-0.5 min-w-0 text-[10px] text-error-text">{value}</p> : null;
  // The WYSIWYG inputs are borderless (`border-0`), so a plain `border` class would lose the
  // Tailwind order conflict; the error state uses a bottom rule + tint that always wins.
  const inputClass = (hasError: boolean, additional = '') => `${hasError ? documentInputClass.replace('bg-transparent', 'bg-error-bg/60') : documentInputClass} min-w-0 ${hasError ? 'border-b-2 border-error' : ''} ${additional}`;
  const requiredMark = (required?: boolean) => required ? <span aria-hidden="true" className="text-error"> *</span> : null;
  const set = (updater: (previous: DocumentDraft) => DocumentDraft, coalesce = true) => fields.onChange(updater, { coalesce });
  const address = document.clientAddress ?? '';
  const taxMode = document.taxMode ?? fields.resolvedTaxMode ?? '';
  const datevTaxMeta = document.taxMeta as (typeof document.taxMeta & { destinationVatRate?: number; datevEvidenceType?: string; datevEvidenceReference?: string; datevSachverhaltLl?: string }) | undefined;
  const defaultRate = defaultTaxRate;
  const [uncontrolledTaxDetailsOpen, setUncontrolledTaxDetailsOpen] = React.useState(false);
  const taxDetailsOpen = fields.taxDetailsOpen ?? uncontrolledTaxDetailsOpen;
  const setTaxDetailsOpen = fields.onTaxDetailsOpenChange ?? setUncontrolledTaxDetailsOpen;
  const recipientInputRef = React.useRef<HTMLInputElement>(null);
  const isManualRecipient = !fields.selectedClientId;
  const startManualRecipient = () => {
    fields.onStartManualRecipient();
    recipientInputRef.current?.focus();
  };
  const setInputA11y = (input: HTMLInputElement | null, id: string, invalid: boolean, describedBy?: string, required?: boolean) => {
    if (!input) return;
    input.id = id;
    input.setAttribute('aria-invalid', String(invalid));
    if (describedBy) input.setAttribute('aria-describedby', describedBy);
    else input.removeAttribute('aria-describedby');
    if (required) {
      input.required = true;
      input.setAttribute('aria-required', 'true');
    } else {
      input.required = false;
      input.removeAttribute('aria-required');
    }
  };
  // A service period is one date or "YYYY-MM-DD bis YYYY-MM-DD" (§14 Abs. 4 Nr. 6 UStG allows a period).
  const periodMatch = document.servicePeriod?.match(/^(\d{4}-\d{2}-\d{2}) bis (\d{4}-\d{2}-\d{2})$/);
  const servicePeriod = { start: periodMatch?.[1] ?? document.servicePeriod ?? '', end: periodMatch?.[2] ?? '' };
  const setServicePeriod = (start: string, end: string) =>
    set((previous) => ({ ...previous, servicePeriod: start && end && end > start ? `${start} bis ${end}` : start || end }));
  const dateInput = (value: string | undefined, onChange: (next: string) => void, ariaLabel: string) => (
    <input
      type="date"
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value)}
      aria-label={ariaLabel}
      className={`${documentInputClass} w-auto min-w-0 text-right text-[11px]`}
    />
  );

  return (
    <div className="pointer-events-none absolute inset-0 print:hidden" data-inline-document-fields>
      <div className="pointer-events-auto absolute box-border bg-white px-1 py-1 text-[11px] text-foreground" style={{ left: meta.x, top: meta.y, width: meta.width, height: meta.height }}>
        <div className="space-y-0.5">
          <div id="document-field-number" data-field-block data-field-error={fields.fieldErrors?.number ? 'true' : undefined}>
          <div className="flex items-center justify-end gap-2">
            <label htmlFor="document-input-number" className={documentLabelClass}>{templateType === 'offer' ? 'Angebots-Nr.' : 'Rechnungs-Nr.'}{requiredMark(true)}</label>
            <div className="relative min-w-0 flex-1">
              <input
                id="document-input-number"
                value={document.number}
                readOnly={fields.isNumberLocked}
                aria-label={templateType === 'offer' ? 'Angebots-Nr.' : 'Rechnungs-Nr.'}
                aria-invalid={Boolean(fields.fieldErrors?.number)}
                aria-describedby={fields.fieldErrors?.number ? 'document-input-number-error' : undefined}
                aria-required="true"
                required
                onChange={(event) => set((previous) => ({ ...previous, number: event.target.value }))}
                className={`${inputClass(Boolean(fields.fieldErrors?.number), `text-right ${fields.onUnlockNumber ? 'pr-7' : ''} ${fields.isNumberLocked ? 'text-muted' : ''}`)}`}
              />
              {fields.onUnlockNumber ? <button type="button" onClick={fields.onUnlockNumber} className="absolute right-0 top-1/2 z-10 inline-flex min-h-6 min-w-6 -translate-y-1/2 items-center justify-center rounded-sm bg-white p-0.5 text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring" aria-label={fields.isNumberLocked ? 'Nummer entsperren' : 'Nummer sperren'} title="Nummer bearbeiten (GoBD-Warnung)">{fields.isNumberLocked ? <LockKeyhole size={12} /> : <UnlockKeyhole size={12} />}</button> : null}
            </div>
          </div>
          {error('document-input-number-error', fields.fieldErrors?.number)}
          </div>
          <div id="document-field-date" data-field-block data-field-error={fields.fieldErrors?.date ? 'true' : undefined}>
          <div className="flex items-center justify-end gap-2">
            <label htmlFor="document-input-date" className={documentLabelClass}>Datum{requiredMark(true)}</label>
            <input id="document-input-date" type="date" value={document.date ?? ''} onChange={(event) => set((previous) => ({ ...previous, date: event.target.value }))} aria-label="Datum" aria-invalid={Boolean(fields.fieldErrors?.date)} aria-describedby={fields.fieldErrors?.date ? 'document-input-date-error' : undefined} aria-required="true" required className={inputClass(Boolean(fields.fieldErrors?.date), 'w-auto text-right text-[11px]')} />
          </div>
          {error('document-input-date-error', fields.fieldErrors?.date)}
          </div>
          <div className="flex items-center justify-end gap-2">
            <label className={documentLabelClass}>{templateType === 'offer' ? 'Gültig bis' : 'Fälligkeit'}</label>
            {dateInput(document.dueDate, (dueDate) => set((previous) => ({ ...previous, dueDate })), templateType === 'offer' ? 'Gültig bis' : 'Fälligkeit')}
          </div>
          <div className="flex items-center justify-end gap-2">
            <label className={documentLabelClass}>{templateType === 'offer' ? 'Leistungszeitraum' : 'Leistungsdatum'}</label>
            {dateInput(servicePeriod.start, (start) => setServicePeriod(start, servicePeriod.end), templateType === 'offer' ? 'Leistungszeitraum ab' : 'Leistungsdatum')}
            <span className={documentLabelClass} aria-hidden="true">bis</span>
            {dateInput(servicePeriod.end, (end) => setServicePeriod(servicePeriod.start, end), templateType === 'offer' ? 'Leistungszeitraum bis' : 'Leistungszeitraum bis')}
          </div>
        </div>
      </div>

      <div className="pointer-events-auto absolute box-border bg-white px-1 py-1 text-[11px] text-foreground" style={{ left: recipient.x, top: recipient.y, width: recipient.width, height: recipient.height }}>
        <div id="document-field-client" data-field-block data-field-error={fields.fieldErrors?.client ? 'true' : undefined} className="mb-0.5 min-w-0">
          <div className="min-w-0"><span className={documentLabelClass}>{isManualRecipient ? 'Empfänger' : 'Kunde'}{requiredMark(true)}</span><Combobox key={`recipient-${document.id}`} ref={(input) => { recipientInputRef.current = input; setInputA11y(input, 'document-input-client', Boolean(fields.fieldErrors?.client), fields.fieldErrors?.client ? 'document-input-client-error' : undefined, true); }} items={fields.clients} value={document.client || fields.selectedClientLabel} onValueChange={fields.onClientNameChange ?? ((value) => set((previous) => ({ ...previous, client: value })))} onSelect={fields.onSelectClient} getLabel={(client) => client.company} getSublabel={clientSublabel} getSearchText={(client) => `${client.company} ${client.customerNumber ?? ''} ${client.email ?? ''} ${client.address ?? ''} ${(client.addresses ?? []).map((entry) => Object.values(entry).join(' ')).join(' ')}`} allowFreeText placeholder="Empfänger oder Kunde suchen…" aria-label="Kunde auswählen" showSearchIcon={false} leadingIcon={<UserRound size={14} />} showChevron showAvatar selectedId={fields.selectedClientId} footer={{ label: 'Empfänger ohne Kundenstamm eingeben', onSelect: startManualRecipient }} inputClassName={`${inputClass(Boolean(fields.fieldErrors?.client), 'text-sm font-medium')}`} /></div>
          {isManualRecipient ? <p className="mt-0.5 text-[10px] text-muted" role="status">Nur in diesem Beleg gespeichert</p> : null}
          {error('document-input-client-error', fields.fieldErrors?.client)}
        </div>
        <div className="grid grid-cols-1 gap-y-0.5">
          <div className="col-span-2">
            <textarea rows={2} value={address} onChange={(event) => fields.onAddressChange ? fields.onAddressChange(event.target.value) : set((previous) => ({ ...previous, clientAddress: event.target.value }))} aria-label="Rechnungsadresse" placeholder="Adresse" className={`${documentInputClass} resize-none`} />
          </div>
        </div>
      </div>

      <div className="pointer-events-auto absolute" style={{ left: meta.x, top: meta.y, width: meta.width, height: meta.height }} data-inline-tax-fields>
        <div className="group/tax absolute bottom-0 right-0">
          <button type="button" aria-label="Details bearbeiten" aria-expanded={taxDetailsOpen} onClick={() => setTaxDetailsOpen(!taxDetailsOpen)} className="inline-flex min-h-6 items-center justify-center border-0 bg-white px-1 text-[10px] text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring">Details</button>
          <div className={`absolute right-0 top-full z-30 mt-1 w-80 rounded-card border border-border bg-surface p-2 text-xs text-foreground shadow-lift ${taxDetailsOpen ? 'pointer-events-auto visible opacity-100' : 'pointer-events-none invisible opacity-0 group-hover/tax:pointer-events-auto group-hover/tax:visible group-hover/tax:opacity-100 group-focus-within/tax:pointer-events-auto group-focus-within/tax:visible group-focus-within/tax:opacity-100'}`}>
            <div className="mb-1 space-y-1">
              <label className="flex items-center gap-1"><span className="text-xs text-muted">E-Mail</span><input type="email" value={document.clientEmail} onChange={(event) => set((previous) => ({ ...previous, clientEmail: event.target.value }))} aria-label="E-Mail" placeholder="E-Mail" className={`${documentInputClass} min-w-0 flex-1`} /></label>
              <label className="flex items-center gap-1"><span className="text-xs text-muted">Projekt</span><div className="min-w-0 flex-1"><Combobox items={fields.projects} value={fields.selectedProjectLabel} onSelect={fields.onSelectProject} getLabel={(project) => `${project.code ? `${project.code} – ` : ''}${project.name}`} getSearchText={(project) => `${project.code ?? ''} ${project.name}`} disabled={!fields.selectedClientId} placeholder={fields.selectedClientId ? 'Projekt suchen…' : 'Kunde auswählen'} aria-label="Projekt auswählen" inputClassName={`${documentInputClass} text-sm`} /></div></label>
            </div>
            <div className="grid grid-cols-[1.2fr_.8fr] gap-1">
              <div id="document-field-tax-rule" data-field-block data-field-error={fields.fieldErrors?.taxRule ? 'true' : undefined} className="min-w-0">
                <label htmlFor="document-input-tax-rule" className="flex min-w-0 items-center gap-1"><span className="shrink-0 text-xs text-muted">Modell</span><select id="document-input-tax-rule" aria-label="Steuer-Modell" aria-invalid={Boolean(fields.fieldErrors?.taxRule)} aria-describedby={fields.fieldErrors?.taxRule ? 'document-input-tax-rule-error' : undefined} value={taxMode} onChange={(event) => set((previous) => ({ ...previous, taxMode: event.target.value as DocumentDraft['taxMode'], taxMeta: { ...previous.taxMeta, taxRuleConfirmed: true } }))} className={inputClass(Boolean(fields.fieldErrors?.taxRule))}>{(fields.taxModeOptions ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
                {error('document-input-tax-rule-error', fields.fieldErrors?.taxRule)}
              </div>
              <label className="flex min-w-0 items-center gap-1"><span className="shrink-0 text-xs text-muted">USt</span><select aria-label="Standardsatz" value={defaultRate} onChange={(event) => set((previous) => ({ ...previous, taxMeta: { ...previous.taxMeta, defaultVatRate: Number(event.target.value), taxRuleConfirmed: true } }))} className={inputClass(false)}>{(fields.taxRateOptions?.length ? fields.taxRateOptions : [0, 7, 19]).map((rate) => <option key={rate} value={rate}>{rate}%</option>)}</select></label>
            </div>
            {fields.taxLegalText ? <p className="mt-1 text-xs text-muted" data-tax-legal-text>Auf dem Beleg: „{fields.taxLegalText}“</p> : null}
            {fields.requiresBuyerVatId ? <div id="document-field-buyer-vat-id" data-field-block data-field-error={fields.fieldErrors?.buyerVatId ? 'true' : undefined} className="mt-1 min-w-0"><label htmlFor="document-input-buyer-vat-id" className="block text-xs text-muted">Käufer-USt-IdNr.{requiredMark(fields.requiresBuyerVatId)}</label><div className="flex min-w-0 gap-1"><input id="document-input-buyer-vat-id" value={document.taxMeta?.buyerVatId ?? ''} onChange={(event) => set((previous) => ({ ...previous, taxMeta: { ...previous.taxMeta, buyerVatId: event.target.value, buyerType: 'business', vatIdValidation: undefined, vatIdValidationAt: undefined } }))} aria-label="USt-IdNr. des Kunden" aria-invalid={Boolean(fields.fieldErrors?.buyerVatId)} aria-describedby={fields.fieldErrors?.buyerVatId ? 'document-input-buyer-vat-id-error' : undefined} aria-required={fields.requiresBuyerVatId} required={fields.requiresBuyerVatId} className={inputClass(Boolean(fields.fieldErrors?.buyerVatId), 'flex-1')} />{fields.onValidateBuyerVatId ? <button type="button" aria-label="VIES prüfen" onClick={fields.onValidateBuyerVatId} disabled={fields.vatValidationPending || !document.taxMeta?.buyerVatId} className="inline-flex min-h-6 shrink-0 items-center border border-control-border px-1 text-xs font-bold text-muted disabled:opacity-50">{fields.vatValidationPending ? 'Prüfe…' : 'VIES prüfen'}</button> : null}</div>{document.taxMeta?.vatIdValidation ? <p className="mt-0.5 min-w-0 text-xs text-muted">VIES: {document.taxMeta.vatIdValidation}</p> : null}{error('document-input-buyer-vat-id-error', fields.fieldErrors?.buyerVatId)}</div> : null}
            {templateType !== 'offer' ? <div className="mt-1 min-w-0"><label htmlFor="document-input-buyer-reference" className="flex min-w-0 items-center gap-1"><span className="shrink-0 text-xs text-muted">Käuferreferenz</span><input id="document-input-buyer-reference" value={(document.taxMeta as { buyerReference?: string } | undefined)?.buyerReference ?? ''} onChange={(event) => set((previous) => ({ ...previous, taxMeta: { ...previous.taxMeta, buyerReference: event.target.value || undefined } }))} aria-label="Käuferreferenz (Leitweg-ID)" placeholder="z. B. Leitweg-ID" className={inputClass(false, 'flex-1')} /></label></div> : null}
            {fields.requiresTaxCountry ? <div id="document-field-tax-country" data-field-block data-field-error={fields.fieldErrors?.taxCountry ? 'true' : undefined} className="mt-1 min-w-0"><label htmlFor="document-input-tax-country" className="flex min-w-0 items-center gap-1"><span className="shrink-0 text-xs text-muted">Land{requiredMark(fields.requiresTaxCountry)}</span><input id="document-input-tax-country" maxLength={2} value={document.taxMeta?.buyerCountryCode ?? fields.buyerCountryCode ?? ''} onChange={(event) => set((previous) => ({ ...previous, taxMeta: { ...previous.taxMeta, buyerCountryCode: event.target.value.toUpperCase(), taxRuleConfirmed: true } }))} aria-label="DATEV Land" aria-invalid={Boolean(fields.fieldErrors?.taxCountry)} aria-describedby={fields.fieldErrors?.taxCountry ? 'document-input-tax-country-error' : undefined} aria-required={fields.requiresTaxCountry} required={fields.requiresTaxCountry} className={inputClass(Boolean(fields.fieldErrors?.taxCountry), 'flex-1')} /></label>{error('document-input-tax-country-error', fields.fieldErrors?.taxCountry)}</div> : null}
            {fields.requiresDestinationVatRate ? <div id="document-field-destination-vat-rate" data-field-block data-field-error={fields.fieldErrors?.destinationVatRate ? 'true' : undefined} className="mt-1 min-w-0"><label htmlFor="document-input-destination-vat-rate" className="flex min-w-0 items-center gap-1"><span className="shrink-0 text-xs text-muted">EU-Satz{requiredMark(fields.requiresDestinationVatRate)}</span><input id="document-input-destination-vat-rate" type="number" min="0" max="99.99" step="0.01" value={datevTaxMeta?.destinationVatRate ?? ''} onChange={(event) => set((previous) => ({ ...previous, taxMeta: { ...previous.taxMeta, destinationVatRate: event.target.value === '' ? undefined : Number(event.target.value), taxRuleConfirmed: true } }))} aria-label="EU-Steuersatz im Bestimmungsland" aria-invalid={Boolean(fields.fieldErrors?.destinationVatRate)} aria-describedby={fields.fieldErrors?.destinationVatRate ? 'document-input-destination-vat-rate-error' : undefined} aria-required={fields.requiresDestinationVatRate} required={fields.requiresDestinationVatRate} className={inputClass(Boolean(fields.fieldErrors?.destinationVatRate), 'flex-1')} /></label>{error('document-input-destination-vat-rate-error', fields.fieldErrors?.destinationVatRate)}</div> : null}
            {fields.requiresDatevEvidence ? <div className="mt-1 grid min-w-0 grid-cols-2 gap-1"><div id="document-field-datev-evidence-type" data-field-block data-field-error={fields.fieldErrors?.datevEvidenceType ? 'true' : undefined} className="min-w-0"><label htmlFor="document-input-datev-evidence-type" className="flex min-w-0 items-center gap-1"><span className="shrink-0 text-xs text-muted">Nachweis{requiredMark(fields.requiresDatevEvidence)}</span><input id="document-input-datev-evidence-type" value={datevTaxMeta?.datevEvidenceType ?? ''} onChange={(event) => set((previous) => ({ ...previous, taxMeta: { ...previous.taxMeta, datevEvidenceType: event.target.value } }))} aria-label="DATEV Nachweistyp" aria-invalid={Boolean(fields.fieldErrors?.datevEvidenceType)} aria-describedby={fields.fieldErrors?.datevEvidenceType ? 'document-input-datev-evidence-type-error' : undefined} aria-required={fields.requiresDatevEvidence} required={fields.requiresDatevEvidence} className={inputClass(Boolean(fields.fieldErrors?.datevEvidenceType), 'flex-1')} /></label>{error('document-input-datev-evidence-type-error', fields.fieldErrors?.datevEvidenceType)}</div><div id="document-field-datev-evidence-reference" data-field-block data-field-error={fields.fieldErrors?.datevEvidenceReference ? 'true' : undefined} className="min-w-0"><label htmlFor="document-input-datev-evidence-reference" className="flex min-w-0 items-center gap-1"><span className="shrink-0 text-xs text-muted">Referenz{requiredMark(fields.requiresDatevEvidence)}</span><input id="document-input-datev-evidence-reference" value={datevTaxMeta?.datevEvidenceReference ?? ''} onChange={(event) => set((previous) => ({ ...previous, taxMeta: { ...previous.taxMeta, datevEvidenceReference: event.target.value } }))} aria-label="DATEV Nachweisreferenz" aria-invalid={Boolean(fields.fieldErrors?.datevEvidenceReference)} aria-describedby={fields.fieldErrors?.datevEvidenceReference ? 'document-input-datev-evidence-reference-error' : undefined} aria-required={fields.requiresDatevEvidence} required={fields.requiresDatevEvidence} className={inputClass(Boolean(fields.fieldErrors?.datevEvidenceReference), 'flex-1')} /></label>{error('document-input-datev-evidence-reference-error', fields.fieldErrors?.datevEvidenceReference)}</div></div> : null}
            {fields.requiresDatevSachverhaltLl ? <div id="document-field-datev-sachverhalt-ll" data-field-block data-field-error={fields.fieldErrors?.datevSachverhaltLl ? 'true' : undefined} className="mt-1 min-w-0"><label htmlFor="document-input-datev-sachverhalt-ll" className="flex min-w-0 items-center gap-1"><span className="shrink-0 text-xs text-muted">L+L{requiredMark(fields.requiresDatevSachverhaltLl)}</span><input id="document-input-datev-sachverhalt-ll" inputMode="numeric" maxLength={3} value={datevTaxMeta?.datevSachverhaltLl ?? ''} onChange={(event) => set((previous) => ({ ...previous, taxMeta: { ...previous.taxMeta, datevSachverhaltLl: event.target.value } }))} aria-label="DATEV Sachverhalt L+L" aria-invalid={Boolean(fields.fieldErrors?.datevSachverhaltLl)} aria-describedby={fields.fieldErrors?.datevSachverhaltLl ? 'document-input-datev-sachverhalt-ll-error' : undefined} aria-required={fields.requiresDatevSachverhaltLl} required={fields.requiresDatevSachverhaltLl} className={inputClass(Boolean(fields.fieldErrors?.datevSachverhaltLl), 'flex-1')} /></label>{error('document-input-datev-sachverhalt-ll-error', fields.fieldErrors?.datevSachverhaltLl)}</div> : null}
            {fields.buyerCountryCode && fields.sellerCountryCode && fields.buyerCountryCode !== fields.sellerCountryCode && fields.taxRecommendation && fields.taxRecommendation.mode !== fields.resolvedTaxMode ? <button type="button" aria-label={fields.taxRecommendationLabel ?? fields.taxRecommendation.mode} className="mt-1 text-left text-xs font-bold text-info-text underline" onClick={() => set((previous) => ({ ...previous, taxMode: fields.taxRecommendation?.mode as DocumentDraft['taxMode'], taxMeta: { ...previous.taxMeta, taxRuleConfirmed: true } }))}>{fields.taxRecommendationLabel ?? fields.taxRecommendation.mode} <span className="font-normal no-underline">({fields.taxRecommendation.reason})</span></button> : null}
          </div>
        </div>
      </div>

    </div>
  );
};

interface CommandAction {
  id: string;
  label: string;
  searchText: string;
  run: () => void;
}

const normalizeCommandSearch = (value: string) => value
  .normalize('NFD')
  .replace(/\p{Diacritic}/gu, '')
  .toLocaleLowerCase('de-DE');

const layoutTexts = (document: DocumentDraft) => document.layout?.texts ?? {};

/** Editable intro or closing: the document's own text, falling back to the template text. */
const DocumentText: React.FC<{
  label: string;
  field: 'intro' | 'closing';
  fields: DocumentFlowDocumentFields;
  /** The text as printed, with placeholders resolved; shown while not editing. */
  resolved: string;
  className: string;
}> = ({ label, field, fields, resolved, className }) => {
  const [editing, setEditing] = React.useState(false);
  const override = layoutTexts(fields.document)[field];
  const raw = override ?? fields.templateTexts[field];
  const value = editing ? raw : resolved;
  const setText = (next: string | undefined) => fields.onChange((previous) => {
    const texts = { ...layoutTexts(previous), [field]: next };
    if (next === undefined) delete texts[field];
    return { ...previous, layout: { ...previous.layout, texts } };
  }, { coalesce: true });
  const rows = Math.max(2, value.split('\n').length);
  return (
    <div className={`group/text relative ${className}`} data-document-text={field}>
      <textarea
        aria-label={label}
        value={value}
        rows={rows}
        onChange={(event) => setText(event.target.value)}
        onFocus={() => setEditing(true)}
        onBlur={() => setEditing(false)}
        className="block w-full resize-none border-0 bg-transparent p-0 text-inherit [font:inherit] hover:bg-surface-muted/50 focus:bg-accent/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
      />
      {override !== undefined ? (
        <button
          type="button"
          onClick={() => setText(undefined)}
          className="absolute -right-8 top-0 inline-flex min-h-6 min-w-6 items-center justify-center rounded-sm text-muted hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-focus-ring print:hidden"
          aria-label={`${label}: Text der Vorlage verwenden`}
          title="Text der Vorlage verwenden"
        >
          <RotateCcw size={12} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
};

/**
 * The editing sheet: first-page DIN geometry with the document fields in
 * place, the body in document flow below.
 *
 * ponytail: the sheet is one continuous page while editing; page breaks show
 * in the preview, which paginates exactly like the PDF. Paginating editable
 * rows live needs measured inputs; revisit if users ask for breaks while typing.
 */
export const DocumentFlowEditor: React.FC<DocumentFlowEditorProps> = ({
  model,
  items,
  onItemsChange,
  formatCurrency = defaultCurrency,
  taxRateOptions = [0, 7, 19],
  documentFields,
  articles = [],
}) => {
  const editable = Boolean(items && onItemsChange);
  const defaultTaxRate = documentFields?.document.taxMeta?.defaultVatRate ?? documentFields?.taxRateOptions?.[0] ?? taxRateOptions[0] ?? 19;
  const forceZeroVat = documentFields?.resolvedTaxMode
    ? Boolean(getInvoiceTaxModeDefinition(documentFields.resolvedTaxMode as Parameters<typeof getInvoiceTaxModeDefinition>[0]).forceZeroVat)
    : false;
  const [commandOpen, setCommandOpen] = React.useState(false);
  const [commandQuery, setCommandQuery] = React.useState('');
  const [commandIndex, setCommandIndex] = React.useState(0);
  const commandInputRef = React.useRef<HTMLInputElement>(null);
  const sortableIdsRef = React.useRef(new WeakMap<object, string>());
  const nextSortableIdRef = React.useRef(0);
  const sortableIdFor = React.useCallback((item: DraftItem) => {
    const object = item as object;
    const existing = sortableIdsRef.current.get(object);
    if (existing) return existing;
    const next = `billing-line-${nextSortableIdRef.current++}`;
    sortableIdsRef.current.set(object, next);
    return next;
  }, []);
  const sortableIds = React.useMemo(() => (items ?? []).map(sortableIdFor), [items, sortableIdFor]);
  const sortableIndexById = React.useMemo(() => new Map(sortableIds.map((id, index) => [id, index])), [sortableIds]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const columns = React.useMemo<TableColumn[]>(
    () => model.columns.map((column) => ({ id: column.id, label: column.label, visible: true, align: column.align })),
    [model.columns],
  );
  // The view model has one row per item, in item order.
  const tableRows = React.useMemo<TableRow[]>(
    () => model.rows.map((row, index) => ({
      id: String(index),
      kind: row.kind,
      cells: model.columns.map((column) => row.cells[column.id] ?? ''),
    })),
    [model.columns, model.rows],
  );

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    if (!items || !onItemsChange || !event.over) return;
    const sourceIndex = sortableIndexById.get(String(event.active.id));
    const targetIndex = sortableIndexById.get(String(event.over.id));
    if (sourceIndex === undefined || targetIndex === undefined || sourceIndex === targetIndex) return;
    onItemsChange(arrayMove(items, sourceIndex, targetIndex));
  }, [items, onItemsChange, sortableIndexById]);
  const add = React.useCallback((kind: DraftItem['kind']) => onItemsChange?.([...(items ?? []), makeNewItem(kind)]), [items, onItemsChange]);
  const commandActions = React.useMemo<CommandAction[]>(() => {
    if (!editable || !documentFields) return [];
    const staticActions: CommandAction[] = [
      { id: 'new-item', label: 'Neue Position', searchText: 'position artikel zeile', run: () => add('item') },
      { id: 'new-group', label: 'Neuer Abschnitt', searchText: 'abschnitt gruppe bauabschnitt', run: () => add('group') },
      { id: 'new-text', label: 'Neue Textzeile', searchText: 'text hinweis', run: () => add('text') },
      { id: 'new-summary', label: 'Neue Zwischensumme', searchText: 'zwischensumme laufend abschnitt', run: () => add('summary') },
    ];
    const customerActions = documentFields.clients.map((client) => ({
      id: `customer-${client.id}`,
      label: `Kunde: ${client.company}`,
      searchText: `kunde ${client.company} ${client.customerNumber ?? ''} ${client.email ?? ''} ${client.address ?? ''} ${(client.addresses ?? []).map((address) => Object.values(address).join(' ')).join(' ')}`,
      run: () => documentFields.onSelectClient(client),
    }));
    const articleActions = articles.map((article) => ({
      id: `article-${article.id}`,
      label: `Artikel: ${article.title}`,
      searchText: `artikel ${article.title} ${article.sku ?? ''} ${article.description ?? ''} ${article.category}`,
      run: () => onItemsChange?.([...(items ?? []), { kind: 'item', description: article.title, quantity: 1, price: article.price, total: article.price, articleId: article.id, unit: article.unit, category: article.category, taxRate: article.taxRate }]),
    }));
    return [...customerActions, ...articleActions, ...staticActions];
  }, [add, articles, documentFields, editable, items, onItemsChange]);
  const filteredCommandActions = React.useMemo(() => {
    const query = normalizeCommandSearch(commandQuery.trim());
    return query ? commandActions.filter((action) => normalizeCommandSearch(`${action.label} ${action.searchText}`).includes(query)) : commandActions;
  }, [commandActions, commandQuery]);
  React.useEffect(() => {
    setCommandIndex((index) => Math.min(index, Math.max(0, filteredCommandActions.length - 1)));
  }, [filteredCommandActions.length]);
  React.useEffect(() => {
    if (commandOpen) commandInputRef.current?.focus();
  }, [commandOpen]);
  React.useEffect(() => {
    if (!editable) return;
    const handleCommandShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return;
      event.preventDefault();
      setCommandOpen(true);
    };
    window.addEventListener('keydown', handleCommandShortcut);
    return () => window.removeEventListener('keydown', handleCommandShortcut);
  }, [editable]);
  const executeCommand = (action?: CommandAction) => {
    (action ?? filteredCommandActions[commandIndex])?.run();
    setCommandOpen(false);
    setCommandQuery('');
    setCommandIndex(0);
  };
  const commandShortcut = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)
    ? { keys: ['⌘', 'K'], aria: 'Meta+K' }
    : { keys: ['Strg', 'K'], aria: 'Control+K' };

  const renderRow = (row: TableRow, index: number) => {
    const item = items?.[index];
    if (!items || !onItemsChange || !item) {
      return (
        <tr key={row.id} data-line-kind={row.kind} className="border-b border-[var(--bf-rule)]">
          {columns.map((column, cellIndex) => <td key={column.id} style={{ textAlign: column.align || 'left' }} className="px-1 py-[var(--bf-row-pad)] align-top">{row.cells[cellIndex]}</td>)}
        </tr>
      );
    }
    const rowProps = { row, columns, items, onItemsChange, formatCurrency, taxRateOptions, defaultTaxRate, forceZeroVat, articles, fieldErrors: documentFields?.fieldErrors?.items };
    return <SortableInlineBillingRow key={row.id} {...rowProps} sortableId={sortableIdFor(item)} />;
  };

  const logo = model.letterhead?.logo;
  const docClass = ['bf-doc', `bf-preset-${model.presetId}`, model.font === 'serif' ? 'bf-font-serif' : ''].filter(Boolean).join(' ');
  const docStyle = { '--bf-accent': model.accentColor } as React.CSSProperties;

  return (
    <div className="relative mx-auto w-fit" data-document-flow-editor data-editable={editable ? 'true' : 'false'}>
      {editable && documentFields ? (
        <div className="relative mb-3 flex justify-end print:hidden" data-inline-actions>
          <Button variant="secondary" size="sm" aria-label="Aktionen" aria-keyshortcuts={commandShortcut.aria} onClick={() => setCommandOpen(true)} className="border-border-inverse bg-surface-inverse-overlay text-inverse-muted hover:border-border-inverse hover:bg-surface-inverse-overlay hover:text-inverse-foreground focus-visible:outline-focus-ring-dark">
            Aktionen
            <span className="inline-flex gap-0.5">{commandShortcut.keys.map((key) => <Kbd key={key} className="border-border-inverse bg-surface-inverse text-inverse-muted">{key}</Kbd>)}</span>
          </Button>
          {commandOpen ? <div role="dialog" aria-label="Aktionen" data-command-dialog className="absolute right-0 top-full z-[var(--z-dropdown)] mt-1 w-80 rounded-card border border-border bg-surface p-1.5 text-foreground shadow-lift">
            <Input ref={commandInputRef} fullWidth value={commandQuery} onChange={(event) => { setCommandQuery(event.target.value); setCommandIndex(0); }} onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setCommandIndex((index) => Math.min(index + 1, Math.max(0, filteredCommandActions.length - 1))); }
              else if (event.key === 'ArrowUp') { event.preventDefault(); setCommandIndex((index) => Math.max(0, index - 1)); }
              else if (event.key === 'Enter') { event.preventDefault(); executeCommand(); }
              else if (event.key === 'Escape') { event.preventDefault(); setCommandOpen(false); }
            }} placeholder="Aktion suchen …" aria-label="Aktion suchen …" />
            <div className="mt-1.5 max-h-64 overflow-auto" role="listbox" aria-label="Aktionen">
              {filteredCommandActions.length ? filteredCommandActions.map((action, index) => <button key={action.id} type="button" role="option" aria-selected={index === commandIndex} data-command-action={action.id} onMouseDown={(event) => { event.preventDefault(); executeCommand(action); }} className={`block w-full rounded-control px-2.25 py-2 text-left text-control text-foreground ${index === commandIndex ? 'bg-surface-sunken' : 'hover:bg-surface-sunken'}`}>{action.label}</button>) : <p className="px-2.25 py-2 text-control text-muted">Keine Aktion gefunden</p>}
            </div>
          </div> : null}
        </div>
      ) : null}

      <div className={docClass} style={docStyle} data-theme="light">
        <section className="bf-page bf-page-first bf-edit-sheet shadow-2xl" data-edit-sheet>
          {model.din.foldMarks ? (<><div className="bf-mark" style={{ top: '105mm' }} /><div className="bf-mark" style={{ top: '210mm' }} /></>) : null}
          {model.din.holeMark ? <div className="bf-mark bf-mark-hole" style={{ top: '148.5mm' }} /> : null}
          {model.letterhead ? (
            <>
              <div className={`bf-letterhead${logo ? ` bf-logo-${logo.position}` : ''}`}>
                {logo ? <img src={logo.dataUrl} alt={model.letterhead.companyName} style={{ width: `${logo.widthMm}mm` }} /> : <div className="bf-company">{model.letterhead.companyName}</div>}
              </div>
              <div className="bf-lh-rule" />
            </>
          ) : null}
          {model.senderLine ? <div className="bf-sender-line">{model.senderLine}</div> : null}
          {documentFields ? (
            <InlineDocumentFields fields={documentFields} defaultTaxRate={defaultTaxRate} />
          ) : (
            <>
              <div className="bf-recipient">{model.recipient.map((line, index) => <div key={index}>{line || ' '}</div>)}</div>
              <div className="bf-meta"><dl className="bf-meta-grid">{model.meta.map((entry, index) => <React.Fragment key={index}><dt>{entry.label}</dt><dd>{entry.value}</dd></React.Fragment>)}</dl></div>
            </>
          )}

          <div className="bf-edit-body">
            {model.title ? <div className="bf-title">{model.title}</div> : null}
            {documentFields && model.intro !== '' ? (
              <DocumentText label="Einleitung" field="intro" fields={documentFields} resolved={model.intro} className="bf-text" />
            ) : model.intro ? <div className="bf-text">{model.intro}</div> : null}

            {model.columns.length > 0 ? (
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
                  <table className="bf-edit-table w-full border-collapse" data-items-table>
                    <thead>
                      <tr>
                        {columns.map((column) => <th key={column.id} style={{ textAlign: column.align || 'left' }}>{column.label}</th>)}
                      </tr>
                    </thead>
                    <tbody>{tableRows.map(renderRow)}</tbody>
                  </table>
                </SortableContext>
              </DndContext>
            ) : null}
            {editable ? (
              <div className="mt-2 flex items-center gap-1 rounded-md border border-dashed border-border bg-surface/95 px-2 py-1 text-xs text-muted shadow-sm print:hidden [font-family:var(--font-sans,inherit)]" data-inline-line-add>
                <span className="mr-1 font-semibold">Zeile hinzufügen</span>
                <select aria-label="Neue Zeile hinzufügen" defaultValue="item" className="h-7 rounded-sm border border-control-border bg-surface px-1 text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring" onChange={(event) => add(event.target.value as DraftItem['kind'])}>
                  <option value="item">Position</option>
                  <option value="time">Zeit</option>
                  <option value="optional">Optional</option>
                  <option value="text">Text</option>
                  <option value="group">Abschnitt</option>
                  <option value="summary">Zwischensumme</option>
                </select>
                <button id="document-field-positions" type="button" aria-label="Position hinzufügen" onClick={() => add('item')} className="rounded-sm bg-accent px-2 py-1 font-semibold text-accent-foreground hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring">+ Position</button>
              </div>
            ) : null}

            {model.totals.length > 0 ? (
              <div className="bf-totals" data-document-totals>
                <div className="bf-totals-list">
                  {model.totals.map((line) => (
                    <div key={line.label} className={`bf-total-line${line.emphasis ? ' bf-total-strong' : ''}`}>
                      <span>{line.label}</span>
                      <span className="bf-value">{line.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {model.notice ? <div className="bf-notice">{model.notice}</div> : null}
            {documentFields && model.closing !== '' ? (
              <DocumentText label="Schlusstext" field="closing" fields={documentFields} resolved={model.closing} className="bf-closing" />
            ) : model.closing ? <div className="bf-closing">{model.closing}</div> : null}
          </div>

          {model.footerColumns.length > 0 ? (
            <div className="bf-edit-footer">
              <div className="bf-footer-cols">{model.footerColumns.map((lines, index) => <div key={index}>{lines.join('\n')}</div>)}</div>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
};
