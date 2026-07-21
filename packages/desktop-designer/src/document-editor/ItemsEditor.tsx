import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { Calculator, Plus } from 'lucide-react';
import { ItemRow } from './ItemRow';
import type { ArticleLike, DraftItem } from './types';

interface ItemsEditorProps {
  items: DraftItem[];
  articles: ArticleLike[];
  categoryOptions: string[];
  defaultCategory: string;
  formatCurrency: (amount: number) => string;
  onItemsChange: (items: DraftItem[], options?: { coalesce?: boolean }) => void;
  itemErrors?: Record<number, string>;
}

const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function ItemsEditor({
  items,
  articles,
  categoryOptions,
  defaultCategory,
  formatCurrency,
  onItemsChange,
  itemErrors = {},
}: ItemsEditorProps) {
  const descriptionRefs = useRef<Array<HTMLInputElement | null>>([]);
  const focusIndexRef = useRef<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  useEffect(() => {
    if (focusIndexRef.current === null) return;
    descriptionRefs.current[focusIndexRef.current]?.focus();
    focusIndexRef.current = null;
  }, [items]);

  const changeItem = (index: number, field: keyof DraftItem, value: string | number | undefined) => {
    const nextItems = [...items];
    const next = { ...nextItems[index], [field]: value };
    if (field === 'description') next.articleId = undefined;
    if (field === 'price' || field === 'quantity' || field === 'discountPercent') {
      next.total = round2(next.quantity * next.price * (1 - (next.discountPercent ?? 0) / 100));
    }
    nextItems[index] = next;
    onItemsChange(nextItems, { coalesce: true });
  };

  const addItem = () => {
    focusIndexRef.current = items.length;
    onItemsChange([...items, { description: '', quantity: 1, price: 0, total: 0, category: defaultCategory }]);
  };

  const handleEnter = (index: number) => {
    if (index === items.length - 1) addItem();
    else descriptionRefs.current[index + 1]?.focus();
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>, index: number) => {
    event.preventDefault();
    if (dragIndex === null || dragIndex === index) {
      setDropIndex(null);
      return;
    }
    const nextItems = [...items];
    const [moved] = nextItems.splice(dragIndex, 1);
    nextItems.splice(index, 0, moved);
    onItemsChange(nextItems);
    setDragIndex(null);
    setDropIndex(null);
  };

  return (
    <>
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-sm font-bold text-foreground uppercase tracking-wide">
          <Calculator size={16} className="text-accent fill-black" />
          Positionen
        </h3>
        <button
          type="button"
          onClick={addItem}
          className="text-xs font-bold bg-foreground text-accent px-2 py-1 rounded-sm hover:bg-dark-1 transition-colors duration-150 ease-out flex items-center gap-1"
        >
          <Plus size={12} /> Neu
        </button>
      </div>
      <div className="space-y-2">
        {items.length === 0 ? (
          <p className="py-5 text-center text-muted text-sm">Noch keine Positionen — füge eine Position hinzu.</p>
        ) : null}
        {items.map((item, index) => (
          <ItemRow
            key={index}
            item={item}
            index={index}
            articles={articles}
            categoryOptions={categoryOptions}
            formatCurrency={formatCurrency}
            descriptionRef={(element) => { descriptionRefs.current[index] = element; }}
            dragging={dragIndex === index}
            dropTarget={dropIndex === index && dragIndex !== index}
            descriptionError={itemErrors[index]}
            onChange={(field, value) => changeItem(index, field, value)}
            onSelectArticle={(article) => {
              const next = {
                ...item,
                description: article.title,
                articleId: article.id,
                price: article.price,
                unit: article.unit,
                category: article.category,
                taxRate: article.taxRate,
                total: round2(item.quantity * article.price * (1 - (item.discountPercent ?? 0) / 100)),
              };
              const nextItems = [...items];
              nextItems[index] = next;
              onItemsChange(nextItems);
            }}
            onDuplicate={() => onItemsChange([...items.slice(0, index + 1), { ...item }, ...items.slice(index + 1)])}
            onRemove={() => onItemsChange(items.filter((_, itemIndex) => itemIndex !== index))}
            onEnter={() => handleEnter(index)}
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = 'move';
              setDragIndex(index);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDropIndex(index);
            }}
            onDrop={(event) => handleDrop(event, index)}
            onDragEnd={() => {
              setDragIndex(null);
              setDropIndex(null);
            }}
          />
        ))}
      </div>
    </>
  );
}
