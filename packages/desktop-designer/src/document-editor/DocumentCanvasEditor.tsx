import React from 'react';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { DocumentPages } from '../DocumentPages';
import { A4_HEIGHT_PX, A4_WIDTH_PX } from '../constants';
import type { TableColumn, TableRow, InvoiceElement } from '../types';
import { Combobox } from '@billme/ui';
import { LockKeyhole, UnlockKeyhole, UserRound } from 'lucide-react';
import { getInvoiceTaxModeDefinition } from '@billme/server-core/services';
import type { ArticleLike, ClientLike, DocumentDraft, DraftItem, ProjectLike } from './types';

export interface DocumentCanvasEditorProps {
  /** The same resolved elements used by preview and print. */
  elements: InvoiceElement[];
  /** Billing rows edited directly inside the paginated A4 table. */
  items?: DraftItem[];
  onItemsChange?: (items: DraftItem[], options?: { coalesce?: boolean }) => void;
  formatCurrency?: (amount: number) => string;
  taxRateOptions?: number[];
  /** Optional persisted document fields edited as overlays on the first A4 page. */
  documentFields?: DocumentCanvasDocumentFields;
  /** Catalog source for contextual article suggestions in billing rows. */
  articles?: ArticleLike[];
  /** Kept for template-element overlays that are not billing rows. */
  children?: React.ReactNode;
  pageGap?: number;
  onReady?: () => void;
}

export type DocumentDraftUpdater = (
  next: DocumentDraft | ((previous: DocumentDraft) => DocumentDraft),
  options?: { coalesce?: boolean },
) => void;

export interface DocumentCanvasDocumentFields {
  document: DocumentDraft;
  templateElements?: InvoiceElement[];
  templateType: 'invoice' | 'offer';
  clients: ClientLike[];
  projects: ProjectLike[];
  selectedClientId: string;
  selectedClientLabel: string;
  selectedProjectLabel: string;
  onChange: DocumentDraftUpdater;
  onClientNameChange?: (value: string) => void;
  onAddressChange?: (value: string) => void;
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
  };
  taxModeOptions?: Array<{ value: string; label: string }>;
  taxRateOptions?: number[];
  resolvedTaxMode?: string;
  taxRecommendation?: { mode: string; reason: string };
  taxRecommendationLabel?: string;
  buyerCountryCode?: string;
  sellerCountryCode?: string;
  requiresBuyerVatId?: boolean;
  vatValidationPending?: boolean;
  onValidateBuyerVatId?: () => void;
  /** Existing template persistence seam. No callback means template text stays read-only. */
  onTemplateTextChange?: (id: string, content: string) => void;
  /** Existing template persistence seam for table column visibility. */
  onTemplateElementsChange?: (elements: InvoiceElement[]) => void;
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

const controlClass = 'billing-line-control h-4 min-w-0 rounded border-0 bg-transparent px-0 text-inherit outline-none hover:bg-surface-muted/50 focus:bg-accent/10 focus:ring-1 focus:ring-accent/50';

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
  sortable?: SortableBindings;
}

type SortableBindings = Pick<ReturnType<typeof useSortable>, 'setNodeRef' | 'setActivatorNodeRef' | 'attributes' | 'listeners' | 'transform' | 'transition' | 'isDragging'>;

const InlineBillingRow: React.FC<InlineRowProps> = ({ row, columns, items, onItemsChange, formatCurrency, taxRateOptions, defaultTaxRate, forceZeroVat, articles, sortable }) => {
  const sourceIndex = sourceIndexFromRow(row);
  const item = sourceIndex === undefined ? undefined : items[sourceIndex];
  const continuation = row.kind === 'row-continuation' || row.kind === 'group-continuation';

  if (sourceIndex === undefined || !item || continuation) {
    return (
      <tr key={row.id} data-line-kind={row.kind} data-line-row-id={row.id} className="border-b border-gray-100">
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
  const renderDescription = () => (
    <>
      <div className="relative flex min-w-0 items-center gap-1">
      {articles.length > 0 && isBillableKind(kind) ? (
        <div className="min-w-0 flex-1">
          <Combobox
            items={articles}
            value={item.description}
            onValueChange={(value) => update({ description: value })}
            onSelect={(article) => update({ articleId: article.id, description: article.title, price: article.price, unit: article.unit, taxRate: article.taxRate, category: article.category, total: lineAmount({ ...item, price: article.price, unit: article.unit, taxRate: article.taxRate }) })}
            getLabel={(article) => article.title}
            getSublabel={(article) => `${article.unit} · ${formatCurrency(article.price)}${article.category ? ` · ${article.category}` : ''}`}
            getSearchText={(article) => `${article.title} ${article.sku ?? ''} ${article.description ?? ''} ${article.category}`}
            allowFreeText
            showSearchIcon={false}
            inputClassName={`${controlClass} min-w-0 font-medium`}
            placeholder="Beschreibung"
            aria-label={`Beschreibung Position ${sourceIndex + 1}`}
          />
        </div>
      ) : (
        <input
          aria-label={`Beschreibung ${sourceIndex + 1}`}
          data-line-description={sourceIndex}
          value={item.description}
          onChange={(event) => update({ description: event.target.value })}
          className={`${controlClass} min-w-0 flex-1 font-medium`}
          placeholder={kind === 'group' ? 'Bauabschnitt' : kind === 'summary' ? 'Zwischensumme' : 'Beschreibung'}
        />
      )}
      {kind === 'optional' ? <span className="shrink-0 rounded bg-warning/15 px-1 text-[9px] font-bold uppercase tracking-wide text-warning">optional</span> : null}
      {showTaxBadge ? <span className="ml-auto shrink-0 rounded bg-surface-muted px-1 text-[9px] font-semibold text-muted print:hidden">{effectiveTaxRate} %</span> : null}
      <div className="pointer-events-none absolute -left-12 top-1/2 z-20 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/line:pointer-events-auto group-hover/line:opacity-100 print:hidden">
        <button type="button" aria-label={`Zeile ${sourceIndex + 1} nach oben`} onClick={() => move(-1)} className="rounded px-1 text-xs text-muted hover:bg-surface-muted">↑</button>
        <button type="button" aria-label={`Zeile ${sourceIndex + 1} nach unten`} onClick={() => move(1)} className="rounded px-1 text-xs text-muted hover:bg-surface-muted">↓</button>
      </div>
      <div className="pointer-events-none absolute -right-14 top-1/2 z-20 flex -translate-y-1/2 -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-hover/line:pointer-events-auto group-hover/line:opacity-100 print:hidden">
        <button type="button" aria-label={`Zeile ${sourceIndex + 1} duplizieren`} onClick={duplicate} className="rounded px-1 text-xs text-muted hover:bg-surface-muted">＋</button>
        <button type="button" aria-label={`Zeile ${sourceIndex + 1} löschen`} onClick={remove} className="rounded px-1 text-xs text-error hover:bg-error-bg">×</button>
      </div>
      </div>
      {/* // ponytail: strip is clipped for a focused row at the very top of a page (DocumentPages.tsx page overflow:hidden); rare, acceptable. */}
      <div className="pointer-events-none absolute bottom-full left-0 z-30 flex items-center gap-1 border border-border bg-white px-1 py-0.5 text-[10px] shadow-lg opacity-0 transition-opacity group-focus-within/line:pointer-events-auto group-focus-within/line:opacity-100 print:hidden">
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
    <tr ref={sortable?.setNodeRef} key={row.id} data-line-kind={kind} data-line-row-id={row.id} data-line-index={sourceIndex} data-line-dragging={sortable?.isDragging ? 'true' : undefined} tabIndex={-1} onKeyDown={(event) => { if (!(event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown'))) return; event.preventDefault(); move(event.key === 'ArrowUp' ? -1 : 1); }} style={{ transform: CSS.Transform.toString(sortable?.transform ?? null), transition: sortable?.transition }} className={`group/line border-b border-gray-100 ${kind === 'group' ? 'bg-accent/10 font-bold' : ''} ${kind === 'summary' ? 'border-t border-black/10 font-bold' : ''} ${kind === 'text' ? 'italic text-gray-500' : ''} ${kind === 'optional' ? 'text-gray-500' : ''} ${sortable?.isDragging ? 'opacity-50' : ''}`}>
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
          const dragHandle = <button ref={sortable?.setActivatorNodeRef} type="button" aria-label={`Zeile ${sourceIndex + 1} verschieben`} data-line-drag-handle={sourceIndex} {...sortable?.attributes} {...sortable?.listeners} className="absolute -left-8 top-1/2 block cursor-grab px-1 text-muted opacity-40 hover:text-foreground hover:opacity-100 print:hidden">⋮⋮</button>;
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

const documentInputClass = 'w-full border-0 bg-transparent px-0 py-0.5 text-inherit outline-none hover:bg-surface-muted/50 focus:bg-accent/10 focus:ring-1 focus:ring-accent/50';
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

const anchorFor = (elements: InvoiceElement[], label: string, fallback: { x: number; y: number; width: number; height: number }) => {
  const element = elements.find((candidate) => candidate.label === label);
  return { x: element?.x ?? fallback.x, y: element?.y ?? fallback.y, width: element?.style?.width ?? fallback.width, height: element?.style?.height ?? fallback.height };
};

interface InlineDocumentFieldsProps {
  elements: InvoiceElement[];
  fields: DocumentCanvasDocumentFields;
  defaultTaxRate: number;
}

/**
 * Document metadata is deliberately positioned over the existing template
 * elements. The inputs have no layout flow, so the same measured page plan is
 * used by edit, preview and PDF while the authored document remains the visual
 * surface (not a surrounding form).
 */
const InlineDocumentFields: React.FC<InlineDocumentFieldsProps> = ({ elements, fields, defaultTaxRate }) => {
  const { document, templateType } = fields;
  const meta = anchorFor(elements, 'invoice_meta', { x: 470, y: 190, width: 250, height: 150 });
  const recipient = anchorFor(elements, 'recipient_block', { x: 76, y: 190, width: 320, height: 150 });
  const intro = anchorFor(elements, 'intro_text', { x: 76, y: 435, width: 700, height: 50 });
  const payment = anchorFor(elements, 'payment_terms', { x: 76, y: 756, width: 700, height: 50 });
  const authoredTemplate = fields.templateElements ?? elements;
  const authored = (label: string) => authoredTemplate.find((candidate) => candidate.label === label);
  const error = (value?: string) => value ? <span className="mt-0.5 block text-[9px] text-error">{value}</span> : null;
  const set = (updater: (previous: DocumentDraft) => DocumentDraft, coalesce = true) => fields.onChange(updater, { coalesce });
  const address = document.clientAddress ?? '';
  const taxMode = document.taxMode ?? fields.resolvedTaxMode ?? '';
  const defaultRate = defaultTaxRate;
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
        <div className="space-y-0.5" data-field-error={fields.fieldErrors?.number || fields.fieldErrors?.date ? true : undefined}>
          <div className="flex items-center justify-end gap-2">
            <label className={documentLabelClass}>{templateType === 'offer' ? 'Angebots-Nr.' : 'Rechnungs-Nr.'}</label>
            <div className="relative min-w-0 flex-1">
              <input
                value={document.number}
                readOnly={fields.isNumberLocked}
                aria-label={templateType === 'offer' ? 'Angebots-Nr.' : 'Rechnungs-Nr.'}
                onChange={(event) => set((previous) => ({ ...previous, number: event.target.value }))}
                className={`${documentInputClass} text-right ${fields.isNumberLocked ? 'pr-5 text-muted' : ''}`}
              />
              {fields.onUnlockNumber ? <button type="button" onClick={fields.onUnlockNumber} className="absolute right-0 top-1/2 -translate-y-1/2 p-0.5 text-muted hover:text-foreground" aria-label={fields.isNumberLocked ? 'Nummer entsperren' : 'Nummer sperren'} title="Nummer bearbeiten (GoBD-Warnung)">{fields.isNumberLocked ? <LockKeyhole size={11} /> : <UnlockKeyhole size={11} />}</button> : null}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2">
            <label className={documentLabelClass}>Datum</label>
            {dateInput(document.date, (date) => set((previous) => ({ ...previous, date })), 'Datum')}
          </div>
          <div className="flex items-center justify-end gap-2">
            <label className={documentLabelClass}>{templateType === 'offer' ? 'Gültig bis' : 'Fälligkeit'}</label>
            {dateInput(document.dueDate, (dueDate) => set((previous) => ({ ...previous, dueDate })), templateType === 'offer' ? 'Gültig bis' : 'Fälligkeit')}
          </div>
          <div className="flex items-center justify-end gap-2">
            <label className={documentLabelClass}>{templateType === 'offer' ? 'Leistungszeitraum' : 'Leistungsdatum'}</label>
            {dateInput(document.servicePeriod, (servicePeriod) => set((previous) => ({ ...previous, servicePeriod })), templateType === 'offer' ? 'Leistungszeitraum' : 'Leistungsdatum')}
          </div>
        </div>
        {error(fields.fieldErrors?.number)}
        {error(fields.fieldErrors?.date)}
      </div>

      <div className="pointer-events-auto absolute box-border bg-white px-1 py-1 text-[11px] text-foreground" style={{ left: recipient.x, top: recipient.y, width: recipient.width, height: recipient.height }}>
        <div data-field-error={fields.fieldErrors?.client ? true : undefined} className="mb-0.5">
          <Combobox key={`recipient-${document.id}`} items={fields.clients} value={document.client || fields.selectedClientLabel} onValueChange={fields.onClientNameChange ?? ((value) => set((previous) => ({ ...previous, client: value })))} onSelect={fields.onSelectClient} getLabel={(client) => client.company} getSublabel={clientSublabel} getSearchText={(client) => `${client.company} ${client.customerNumber ?? ''} ${client.email ?? ''} ${client.address ?? ''} ${(client.addresses ?? []).map((entry) => Object.values(entry).join(' ')).join(' ')}`} allowFreeText placeholder="Empfänger oder Kunde suchen…" aria-label="Kunde auswählen" showSearchIcon={false} leadingIcon={<UserRound size={13} />} showChevron showAvatar selectedId={fields.selectedClientId} footer={{ label: 'Neuen Empfänger manuell anlegen', onSelect: () => { if (fields.onClientNameChange) fields.onClientNameChange(''); else set((previous) => ({ ...previous, client: '' })); } }} inputClassName={`${documentInputClass} font-medium`} />
          {error(fields.fieldErrors?.client)}
        </div>
        <div className="grid grid-cols-1 gap-y-0.5">
          <div className="col-span-2">
            <textarea rows={2} value={address} onChange={(event) => fields.onAddressChange ? fields.onAddressChange(event.target.value) : set((previous) => ({ ...previous, clientAddress: event.target.value }))} aria-label="Rechnungsadresse" placeholder="Adresse" className={`${documentInputClass} resize-none`} />
          </div>
        </div>
      </div>

      <div className="pointer-events-auto absolute" style={{ left: meta.x, top: meta.y, width: meta.width, height: meta.height }} data-inline-tax-fields>
        <div className="group/tax absolute bottom-0 right-0">
          <button type="button" aria-label="Details bearbeiten" className="border-0 bg-white px-1 text-[9px] text-muted opacity-60 hover:opacity-100 focus:opacity-100">Details</button>
          <div className="pointer-events-none invisible absolute right-0 top-full z-30 mt-1 w-64 border border-border bg-white p-2 text-[10px] text-foreground opacity-0 shadow-lg group-hover/tax:pointer-events-auto group-hover/tax:visible group-hover/tax:opacity-100 group-focus-within/tax:pointer-events-auto group-focus-within/tax:visible group-focus-within/tax:opacity-100">
            <div className="mb-1 space-y-1">
              <label className="flex items-center gap-1"><span className={documentLabelClass}>E-Mail</span><input type="email" value={document.clientEmail} onChange={(event) => set((previous) => ({ ...previous, clientEmail: event.target.value }))} aria-label="E-Mail" placeholder="E-Mail" className={`${documentInputClass} min-w-0 flex-1`} /></label>
              <label className="flex items-center gap-1"><span className={documentLabelClass}>Projekt</span><div className="min-w-0 flex-1"><Combobox items={fields.projects} value={fields.selectedProjectLabel} onSelect={fields.onSelectProject} getLabel={(project) => `${project.code ? `${project.code} – ` : ''}${project.name}`} getSearchText={(project) => `${project.code ?? ''} ${project.name}`} disabled={!fields.selectedClientId} placeholder={fields.selectedClientId ? 'Projekt suchen…' : 'Kunde auswählen'} aria-label="Projekt auswählen" inputClassName={documentInputClass} /></div></label>
            </div>
            <div className="grid grid-cols-[1.2fr_.8fr] gap-1">
              <label className="flex items-center gap-1"><span className="text-muted">Modell</span><select aria-label="Steuer-Modell" value={taxMode} onChange={(event) => set((previous) => ({ ...previous, taxMode: event.target.value as DocumentDraft['taxMode'], taxMeta: { ...previous.taxMeta, taxRuleConfirmed: true } }))} className={documentInputClass}>{(fields.taxModeOptions ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              <label className="flex items-center gap-1"><span className="text-muted">USt</span><select aria-label="Standardsatz" value={defaultRate} onChange={(event) => set((previous) => ({ ...previous, taxMeta: { ...previous.taxMeta, defaultVatRate: Number(event.target.value), taxRuleConfirmed: true } }))} className={documentInputClass}>{(fields.taxRateOptions?.length ? fields.taxRateOptions : [0, 7, 19]).map((rate) => <option key={rate} value={rate}>{rate}%</option>)}</select></label>
            </div>
            {fields.requiresBuyerVatId ? <div className="mt-1" data-field-error={fields.fieldErrors?.buyerVatId ? true : undefined}><label className="text-[10px] text-muted">Käufer-USt-IdNr.</label><div className="flex gap-1"><input value={document.taxMeta?.buyerVatId ?? ''} onChange={(event) => set((previous) => ({ ...previous, taxMeta: { ...previous.taxMeta, buyerVatId: event.target.value, buyerType: 'business', vatIdValidation: undefined, vatIdValidationAt: undefined } }))} aria-label="USt-IdNr. des Kunden" className={documentInputClass} />{fields.onValidateBuyerVatId ? <button type="button" aria-label="VIES prüfen" onClick={fields.onValidateBuyerVatId} disabled={fields.vatValidationPending || !document.taxMeta?.buyerVatId} className="shrink-0 border border-border px-1 text-[9px] font-bold text-muted disabled:opacity-50">{fields.vatValidationPending ? 'Prüfe…' : 'VIES prüfen'}</button> : null}</div>{document.taxMeta?.vatIdValidation ? <p className="mt-0.5 text-[9px] text-muted">VIES: {document.taxMeta.vatIdValidation}</p> : null}{error(fields.fieldErrors?.buyerVatId)}</div> : null}
            {fields.fieldErrors?.taxRule ? <p className="mt-1 text-[9px] text-error">{fields.fieldErrors.taxRule}</p> : null}
            {fields.buyerCountryCode && fields.sellerCountryCode && fields.buyerCountryCode !== fields.sellerCountryCode && fields.taxRecommendation && fields.taxRecommendation.mode !== fields.resolvedTaxMode ? <button type="button" aria-label={fields.taxRecommendationLabel ?? fields.taxRecommendation.mode} className="mt-1 text-left text-[9px] font-bold text-accent underline" onClick={() => set((previous) => ({ ...previous, taxMode: fields.taxRecommendation?.mode as DocumentDraft['taxMode'], taxMeta: { ...previous.taxMeta, taxRuleConfirmed: true } }))}>{fields.taxRecommendationLabel ?? fields.taxRecommendation.mode} <span className="font-normal no-underline">({fields.taxRecommendation.reason})</span></button> : null}
          </div>
        </div>
      </div>

      {/* The current document model persists intro/payment text as template
          elements, not draft fields. They are intentionally left authored here
          unless the host supplies its existing template persistence callback. */}
      {fields.onTemplateTextChange ? (
        <TemplateTextOverlay element={authored('intro_text')} value={authored('intro_text')?.content ?? ''} onCommit={fields.onTemplateTextChange} />
      ) : null}
      {fields.onTemplateTextChange ? (
        <TemplateTextOverlay element={authored('payment_terms')} value={authored('payment_terms')?.content ?? ''} onCommit={fields.onTemplateTextChange} />
      ) : null}
      {fields.onTemplateTextChange ? (
        <TemplateTextOverlay element={authored('outro_text')} value={authored('outro_text')?.content ?? ''} onCommit={fields.onTemplateTextChange} />
      ) : null}
      <span aria-hidden="true" className="absolute h-0 w-0 overflow-hidden" style={{ left: intro.x, top: intro.y, width: payment.width, height: payment.height }} />
    </div>
  );
};

const TemplateTextOverlay: React.FC<{ element?: InvoiceElement; value: string; onCommit: (id: string, content: string) => void }> = ({ element, value, onCommit }) => {
  if (!element) return null;
  const label = element.label === 'intro_text' ? 'Einleitung' : element.label === 'payment_terms' ? 'Zahlungsbedingungen' : element.label === 'outro_text' ? 'Outro' : 'Dokumenttitel';
  return <textarea aria-label={label} defaultValue={value} onBlur={(event) => { if (event.currentTarget.value !== value) onCommit(element.id, event.currentTarget.value); }} className="pointer-events-auto absolute resize-none border-0 bg-white px-1 py-0.5 text-foreground outline-none hover:bg-surface-muted/50 focus:bg-accent/10" style={{ left: element.x, top: element.y, width: element.style?.width ?? 700, height: element.style?.height ?? 50, fontSize: element.style?.fontSize, fontWeight: element.style?.fontWeight, textAlign: element.style?.textAlign, color: element.style?.color, boxSizing: 'border-box' }} />;
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

/**
 * Public A4 editing seam. The document pages remain the layout authority; only
 * the table rows get compact inline controls when `items` is supplied.
 */
export const DocumentCanvasEditor: React.FC<DocumentCanvasEditorProps> = ({
  elements,
  items,
  onItemsChange,
  formatCurrency = defaultCurrency,
  taxRateOptions = [0, 7, 19],
  documentFields,
  articles = [],
  children,
  pageGap = 24,
  onReady,
}) => {
  const editable = Boolean(items && onItemsChange);
  const defaultTaxRate = documentFields?.document.taxMeta?.defaultVatRate ?? documentFields?.taxRateOptions?.[0] ?? taxRateOptions[0] ?? 19;
  const forceZeroVat = documentFields?.resolvedTaxMode
    ? Boolean(getInvoiceTaxModeDefinition(documentFields.resolvedTaxMode as Parameters<typeof getInvoiceTaxModeDefinition>[0]).forceZeroVat)
    : false;
  const table = elements.find((element) => element.label === 'items_table' || element.type === 'TABLE');
  const [columnMenuOpen, setColumnMenuOpen] = React.useState(false);
  const [columnVisibility, setColumnVisibility] = React.useState<Record<string, boolean>>({});
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
  const suppressedLabels = React.useMemo(() => new Set([
    ...(editable && documentFields ? ['recipient_block', 'invoice_meta'] : []),
    ...(editable && documentFields?.onTemplateTextChange ? ['intro_text', 'payment_terms', 'outro_text'] : []),
  ]), [documentFields, editable]);
  const sourceElements = React.useMemo(
    () => elements.map((element) => suppressedLabels.has(element.label ?? '') ? { ...element, hidden: true } : element),
    [elements, suppressedLabels],
  );
  React.useEffect(() => {
    const columns = table?.tableData?.columns ?? [];
    setColumnVisibility((current) => Object.fromEntries(columns.map((column) => [column.id, current[column.id] ?? column.visible])));
    setColumnMenuOpen(false);
  }, [table?.id]);
  const renderedElements = React.useMemo(() => {
    if (!table || Object.keys(columnVisibility).length === 0) return sourceElements;
    return sourceElements.map((element) => element.id !== table.id ? element : {
      ...element,
      tableData: element.tableData ? {
        ...element.tableData,
        columns: element.tableData.columns.map((column) => ({ ...column, visible: columnVisibility[column.id] ?? column.visible })),
      } : element.tableData,
    });
  }, [columnVisibility, sourceElements, table]);
  const setColumnVisible = (columnId: string, visible: boolean) => {
    setColumnVisibility((current) => ({ ...current, [columnId]: visible }));
    const source = documentFields?.templateElements;
    if (!source || !documentFields.onTemplateElementsChange || !table) return;
    documentFields.onTemplateElementsChange(source.map((element) => element.id !== table.id ? element : {
      ...element,
      tableData: element.tableData ? { ...element.tableData, columns: element.tableData.columns.map((column) => column.id === columnId ? { ...column, visible } : column) } : element.tableData,
    }));
  };
  const renderTableRow = React.useCallback((row: TableRow, columns: TableColumn[]) => {
    if (!items || !onItemsChange) return null;
    const sourceIndex = sourceIndexFromRow(row);
    const continuation = row.kind === 'row-continuation' || row.kind === 'group-continuation';
    const item = sourceIndex === undefined ? undefined : items[sourceIndex];
    const rowProps = { row, columns, items, onItemsChange, formatCurrency, taxRateOptions, defaultTaxRate, forceZeroVat, articles };
    if (sourceIndex === undefined || !item || continuation) return <InlineBillingRow key={row.id} {...rowProps} />;
    return <SortableInlineBillingRow key={row.id} {...rowProps} sortableId={sortableIdFor(item)} />;
  }, [articles, defaultTaxRate, forceZeroVat, formatCurrency, items, onItemsChange, sortableIdFor, taxRateOptions]);
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
  const actionBar = editable && documentFields ? (
    <div className="relative mb-2 flex justify-end print:hidden" data-inline-actions>
      <button type="button" aria-label="Aktionen ⌘K" onClick={() => setCommandOpen(true)} className="border border-border bg-white px-2 py-1 text-[11px] font-semibold text-muted hover:bg-surface-muted hover:text-foreground">Aktionen <span className="ml-1 text-[10px] opacity-60">⌘K</span></button>
      {commandOpen ? <div role="dialog" aria-label="Aktionen" data-command-dialog className="absolute right-0 top-full z-50 mt-1 w-80 border border-border bg-white p-2 text-foreground shadow-xl">
        <input ref={commandInputRef} value={commandQuery} onChange={(event) => { setCommandQuery(event.target.value); setCommandIndex(0); }} onKeyDown={(event) => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setCommandIndex((index) => Math.min(index + 1, Math.max(0, filteredCommandActions.length - 1))); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setCommandIndex((index) => Math.max(0, index - 1)); }
          else if (event.key === 'Enter') { event.preventDefault(); executeCommand(); }
          else if (event.key === 'Escape') { event.preventDefault(); setCommandOpen(false); }
        }} placeholder="Aktion suchen …" aria-label="Aktion suchen …" className="w-full border border-border px-2 py-1.5 text-sm outline-none focus:ring-1 focus:ring-accent" />
        <div className="mt-1 max-h-64 overflow-auto" role="listbox" aria-label="Aktionen">
          {filteredCommandActions.length ? filteredCommandActions.map((action, index) => <button key={action.id} type="button" role="option" aria-selected={index === commandIndex} data-command-action={action.id} onMouseDown={(event) => { event.preventDefault(); executeCommand(action); }} className={`block w-full px-2 py-1.5 text-left text-xs ${index === commandIndex ? 'bg-surface-muted font-semibold' : 'hover:bg-surface-muted'}`}>{action.label}</button>) : <p className="px-2 py-2 text-xs text-muted">Keine Aktion gefunden</p>}
        </div>
      </div> : null}
    </div>
  ) : null;
  const tableFooter = editable ? (
    <div className="flex items-center gap-1 rounded-md border border-dashed border-border bg-surface/95 px-2 py-1 text-xs text-muted shadow-sm print:hidden" data-inline-line-add>
      <span className="mr-1 font-semibold">Zeile hinzufügen</span>
      <select aria-label="Neue Zeile hinzufügen" defaultValue="item" className="h-7 rounded border border-border bg-surface px-1 text-xs" onChange={(event) => add(event.target.value as DraftItem['kind'])}>
        <option value="item">Position</option>
        <option value="time">Zeit</option>
        <option value="optional">Optional</option>
        <option value="text">Text</option>
        <option value="group">Abschnitt</option>
        <option value="summary">Zwischensumme</option>
      </select>
      <button type="button" aria-label="Position hinzufügen" onClick={() => add('item')} className="rounded bg-accent px-2 py-1 font-semibold text-accent-foreground hover:bg-accent-hover">+ Position</button>
    </div>
  ) : undefined;
  const tableHeaderOverlay = editable && table ? (
    <div className="relative">
      <button type="button" aria-label="Spalten ein- oder ausblenden" aria-expanded={columnMenuOpen} onClick={(event) => { event.stopPropagation(); setColumnMenuOpen((open) => !open); }} className="rounded bg-white/90 px-1 text-[10px] font-bold text-muted shadow-sm hover:text-foreground">⋮</button>
      {columnMenuOpen ? <div role="dialog" aria-label="Spalten anzeigen" className="absolute right-0 top-full z-40 mt-1 min-w-36 rounded-lg border border-border bg-surface p-2 text-left text-[10px] font-normal normal-case tracking-normal text-foreground shadow-xl" onClick={(event) => event.stopPropagation()}>
        <p className="mb-1 font-bold">Spalten</p>
        {(table.tableData?.columns ?? []).map((column) => <label key={column.id} className="flex items-center gap-1 py-0.5"><input type="checkbox" checked={columnVisibility[column.id] ?? column.visible} onChange={(event) => setColumnVisible(column.id, event.target.checked)} />{column.label}</label>)}
      </div> : null}
    </div>
  ) : undefined;

  return (
    <div className="relative mx-auto w-fit min-w-[min(100%,794px)]" data-document-canvas-editor data-editable={editable ? 'true' : 'false'}>
      {actionBar}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          <DocumentPages
            elements={renderedElements}
            pageWidth={A4_WIDTH_PX}
            pageHeight={A4_HEIGHT_PX}
            pageClassName="bg-white shadow-2xl"
            pageGap={pageGap}
            onReady={onReady}
            renderTableRow={editable ? renderTableRow : undefined}
            tableFooter={tableFooter}
            tableHeaderOverlay={tableHeaderOverlay}
            pageOverlay={documentFields ? (pageIndex) => pageIndex === 0 ? <InlineDocumentFields elements={renderedElements} fields={documentFields} defaultTaxRate={defaultTaxRate} /> : null : undefined}
          />
        </SortableContext>
      </DndContext>
      {children ? <div className="pointer-events-none absolute inset-0">{children}</div> : null}
    </div>
  );
};
