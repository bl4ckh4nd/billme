import React from 'react';
import { Copy, Edit3, Trash2, Check, CheckSquare } from 'lucide-react';
import { Article } from '../../types';
import { getAvatarColor, getInitials, formatCurrency, calculateDisplayPrice } from './articleHelpers';

interface ArticleListHeaderProps {
  isNetPrice: boolean;
  hasSelection: boolean;
  onSelectAll: () => void;
}

export const ArticleListHeader: React.FC<ArticleListHeaderProps> = ({
  isNetPrice,
  hasSelection,
  onSelectAll,
}) => (
  <div className="grid grid-cols-12 gap-4 px-4 py-2 text-[10px] font-bold text-muted uppercase tracking-wider sticky top-0 bg-surface z-10 border-b border-border-subtle">
    <div className="col-span-1 flex justify-center">
      <button onClick={onSelectAll} className="hover:text-foreground transition-colors duration-150 ease-out">
        <CheckSquare size={16} className={hasSelection ? 'text-foreground fill-foreground/10' : 'text-border'} />
      </button>
    </div>
    <div className="col-span-4">Artikel / Leistung</div>
    <div className="col-span-2">SKU / Kat</div>
    <div className="col-span-1 text-center">USt</div>
    <div className="col-span-2 text-right">Preis ({isNetPrice ? 'Netto' : 'Brutto'})</div>
    <div className="col-span-2 text-right">Aktionen</div>
  </div>
);

interface ArticleListRowProps {
  article: Article;
  idx: number;
  isNetPrice: boolean;
  isSelected: boolean;
  onToggleSelect: (id: string) => void;
  onEdit: (article: Article) => void;
  onDuplicate: (article: Article) => void;
  onDelete: (id: string) => void;
}

export const ArticleListRow: React.FC<ArticleListRowProps> = ({
  article,
  idx,
  isNetPrice,
  isSelected,
  onToggleSelect,
  onEdit,
  onDuplicate,
  onDelete,
}) => {
  return (
    <div
      className={`group rounded-xl p-4 border transition-[background-color,border-color,color,box-shadow,opacity,transform,width] duration-150 ease-out grid grid-cols-12 gap-4 items-center animate-enter ${
        isSelected
        ? 'bg-info-bg/50 border-info'
        : 'bg-surface-muted border-border-subtle hover:border-border hover:bg-surface'
      }`}
      style={{ animationDelay: `${idx * 30}ms` }}
    >
      <div className="col-span-1 flex justify-center">
        <button onClick={() => onToggleSelect(article.id)}>
          <div className={`w-5 h-5 rounded border flex items-center justify-center transition-colors duration-150 ease-out ${
            isSelected ? 'bg-foreground border-foreground text-accent' : 'border-border bg-surface'
          }`}>
            {isSelected && <Check size={12} />}
          </div>
        </button>
      </div>
      <div className="col-span-4 flex items-center gap-4">
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xs font-bold shadow-sm shrink-0 ${getAvatarColor(article.category)}`}>
          {getInitials(article.title)}
        </div>
        <div className="min-w-0">
          <h3 className="font-bold text-sm text-foreground truncate">{article.title}</h3>
          <p className="text-xs text-muted truncate">{article.description || '-'}</p>
        </div>
      </div>
      <div className="col-span-2">
        <div className="flex flex-col items-start gap-1">
          {article.sku && <span className="font-mono text-[10px] text-muted bg-surface px-1.5 rounded border border-border">#{article.sku}</span>}
          <span className="text-[10px] font-bold uppercase bg-canvas text-muted px-2 py-1 rounded-full truncate max-w-full">{article.category}</span>
        </div>
      </div>
      <div className="col-span-1 text-center">
        <span className={`text-[10px] font-bold tabular-nums px-2 py-1 rounded ${article.taxRate === 19 ? 'bg-canvas text-muted' : 'bg-info-bg text-info'}`}>
          {article.taxRate}%
        </span>
      </div>
      <div className="col-span-2 text-right">
        <p className="tabular-nums font-bold text-sm text-foreground">{formatCurrency(calculateDisplayPrice(article, isNetPrice))}</p>
        <p className="text-[10px] text-muted">pro {article.unit}</p>
      </div>
      <div className="col-span-2 flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-150 ease-out">
        <button onClick={() => onDuplicate(article)} className="p-2 bg-surface border border-border-subtle rounded-lg hover:bg-canvas text-muted transition-colors duration-150 ease-out" title="Duplizieren"><Copy size={14}/></button>
        <button onClick={() => onEdit(article)} className="p-2 bg-surface border border-border-subtle rounded-lg hover:bg-foreground hover:text-white transition-colors duration-150 ease-out" title="Bearbeiten"><Edit3 size={14}/></button>
        <button onClick={() => onDelete(article.id)} className="p-2 bg-surface border border-border-subtle text-error rounded-lg hover:bg-error hover:text-white transition-colors duration-150 ease-out" title="Löschen"><Trash2 size={14}/></button>
      </div>
    </div>
  );
};
