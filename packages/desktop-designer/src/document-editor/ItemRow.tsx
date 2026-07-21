import type { DragEvent, KeyboardEvent, Ref } from 'react';
import { Copy, GripVertical, Trash2 } from 'lucide-react';
import { Combobox } from '@billme/ui';
import type { ArticleLike, DraftItem } from './types';

interface ItemRowProps {
  item: DraftItem;
  index: number;
  articles: ArticleLike[];
  categoryOptions: string[];
  formatCurrency: (amount: number) => string;
  descriptionRef: Ref<HTMLInputElement>;
  dragging: boolean;
  dropTarget: boolean;
  descriptionError?: string;
  onChange: (field: keyof DraftItem, value: string | number | undefined) => void;
  onSelectArticle: (article: ArticleLike) => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onEnter: () => void;
  onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
}

const numberInputClassName = 'min-w-0 w-full bg-surface-muted rounded-lg px-1.5 py-1 text-sm outline-none focus:ring-2 focus:ring-accent tabular-nums text-right';
const inputClassName = 'min-w-0 w-full bg-surface-muted rounded-lg px-1.5 py-1 text-sm outline-none focus:ring-2 focus:ring-accent';
const miniLabelClassName = 'block whitespace-normal leading-tight text-[10px] font-medium text-muted mb-0.5';

export function ItemRow({
  item,
  index,
  articles,
  categoryOptions,
  formatCurrency,
  descriptionRef,
  dragging,
  dropTarget,
  descriptionError,
  onChange,
  onSelectArticle,
  onDuplicate,
  onRemove,
  onEnter,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: ItemRowProps) {
  const baseTotal = item.quantity * item.price;
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' || event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    if (!target.matches('input, select')) return;
    event.preventDefault();
    onEnter();
  };

  return (
    <div
      className={`group rounded-lg border bg-surface p-2 space-y-1.5 transition-colors hover:border-accent ${dragging ? 'opacity-50' : ''} ${dropTarget ? 'border-accent' : 'border-border'}`}
      onKeyDown={handleKeyDown}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          draggable
          className="cursor-grab text-muted hover:text-foreground shrink-0"
          aria-label="Position verschieben"
          onDragStart={onDragStart}
          onDragEnd={onDragEnd}
        >
          <GripVertical size={14} />
        </button>
        <span className="w-5 shrink-0 text-[10px] font-bold text-muted tabular-nums text-right">{index + 1}</span>
        <div className="flex-1 min-w-0" data-field-error={descriptionError ? true : undefined}>
          <Combobox
            ref={descriptionRef}
            items={articles}
            value={item.description}
            allowFreeText
            showSearchIcon={false}
            aria-label={`Beschreibung Position ${index + 1}`}
            placeholder="Beschreibung"
            getLabel={(article) => article.title}
            getSublabel={(article) => `${article.sku ? `${article.sku} · ` : ''}${formatCurrency(article.price)} / ${article.unit}`}
            getSearchText={(article) => `${article.title} ${article.sku ?? ''} ${article.category}`}
            onValueChange={(description) => onChange('description', description)}
            onSelect={onSelectArticle}
            inputClassName={`bg-surface-muted border hover:border-border focus:border-accent rounded-lg px-2 py-1 text-sm font-bold ${descriptionError ? 'border-error focus:ring-error' : 'border-transparent'}`}
          />
          {descriptionError ? <p className="mt-1 text-xs text-error">{descriptionError}</p> : null}
        </div>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          <button
            type="button"
            className="p-1 text-muted hover:text-foreground"
            title="Position duplizieren"
            aria-label="Position duplizieren"
            onClick={onDuplicate}
          >
            <Copy size={13} />
          </button>
          <button
            type="button"
            className="p-1 text-muted hover:text-error"
            title="Position löschen"
            aria-label="Position löschen"
            onClick={onRemove}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 pl-[26px] items-end sm:grid-cols-3">
        <label className="min-w-0">
          <span className={miniLabelClassName}>Menge</span>
          <input type="number" min="0" step="any" value={item.quantity} onChange={(event) => onChange('quantity', Number(event.target.value))} className={numberInputClassName} />
        </label>
        <label className="min-w-0">
          <span className={miniLabelClassName}>Einheit</span>
          <input type="text" value={item.unit ?? ''} placeholder="Stk." onChange={(event) => onChange('unit', event.target.value || undefined)} className={inputClassName} />
        </label>
        <label className="min-w-0">
          <span className={miniLabelClassName}>Einzelpreis €</span>
          <input type="number" step="0.01" value={item.price} onChange={(event) => onChange('price', Number(event.target.value))} className={numberInputClassName} />
        </label>
        <label className="min-w-0">
          <span className={miniLabelClassName}>Rabatt %</span>
          <input type="number" min="0" max="100" value={item.discountPercent ?? ''} onChange={(event) => onChange('discountPercent', event.target.value === '' ? undefined : Number(event.target.value))} className={numberInputClassName} />
        </label>
        <label className="min-w-0">
          <span className={miniLabelClassName}>Kategorie</span>
          <select value={item.category ?? ''} onChange={(event) => onChange('category', event.target.value || undefined)} className={inputClassName}>
            <option value="">(Keine)</option>
            {categoryOptions.map((category) => <option key={category} value={category}>{category}</option>)}
            {!categoryOptions.includes('Sonstiges') ? <option value="Sonstiges">Sonstiges</option> : null}
          </select>
        </label>
        <label className="min-w-0">
          <span className={miniLabelClassName}>USt %</span>
          <select
            aria-label={`Umsatzsteuer Position ${index + 1}`}
            value={item.taxRate ?? ''}
            onChange={(event) => onChange('taxRate', event.target.value === '' ? undefined : Number(event.target.value))}
            className={inputClassName}
          >
            <option value="">Standard</option>
            <option value="19">19%</option>
            <option value="7">7%</option>
            <option value="0">0%</option>
          </select>
        </label>
        <div className="min-w-0 pb-1">
          <span className={miniLabelClassName}>Gesamt</span>
          {item.discountPercent ? <div className="text-[10px] text-muted line-through tabular-nums text-right">{formatCurrency(baseTotal)}</div> : null}
          <div className="text-right text-sm font-bold tabular-nums">{formatCurrency(item.total)}</div>
        </div>
      </div>
    </div>
  );
}
