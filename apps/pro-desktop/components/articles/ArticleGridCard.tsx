import React from 'react';
import { Copy, Edit3 } from 'lucide-react';
import { Article } from '../../types';
import { getAvatarColor, getInitials, formatCurrency, calculateDisplayPrice } from './articleHelpers';

interface ArticleGridCardProps {
  article: Article;
  idx: number;
  isNetPrice: boolean;
  onEdit: (article: Article) => void;
  onDuplicate: (article: Article) => void;
}

export const ArticleGridCard: React.FC<ArticleGridCardProps> = ({
  article,
  idx,
  isNetPrice,
  onEdit,
  onDuplicate,
}) => {
  return (
    <div
      className="group bg-surface-muted rounded-xl p-6 border border-border-subtle hover:border-border hover:bg-surface hover:-translate-y-1 transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-150 ease-out relative flex flex-col animate-scale-in"
      style={{ animationDelay: `${idx * 50}ms` }}
    >
      <div className="flex justify-between items-start mb-4">
        <div className={`w-12 h-12 rounded-lg flex items-center justify-center text-sm font-bold shadow-sm transition-transform duration-150 ease-out group-hover:scale-110 ${getAvatarColor(article.category)}`}>
          {getInitials(article.title)}
        </div>
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity duration-150 ease-out">
          <button
            onClick={() => onDuplicate(article)}
            className="p-2 bg-surface rounded-lg hover:bg-canvas text-muted transition-colors duration-150 ease-out"
            title="Duplizieren"
          >
            <Copy size={14}/>
          </button>
          <button
            onClick={() => onEdit(article)}
            className="p-2 bg-surface rounded-lg hover:bg-foreground hover:text-surface transition-colors duration-150 ease-out"
            title="Bearbeiten"
          >
            <Edit3 size={14}/>
          </button>
        </div>
      </div>

      <div className="mb-auto">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] font-bold uppercase bg-canvas text-muted px-2 py-1 rounded-full line-clamp-1">
            {article.category}
          </span>
          {article.taxRate !== 19 && (
            <span className="text-[10px] font-bold uppercase bg-info-bg text-info px-2 py-1 rounded-full">
              {article.taxRate}% USt
            </span>
          )}
        </div>
        <h3 className="font-bold text-lg leading-tight mb-2 line-clamp-2">{article.title}</h3>
        {article.sku && (
          <p className="text-[10px] font-mono text-muted mb-2">#{article.sku}</p>
        )}
      </div>

      <div className="mt-4 pt-4 border-t border-border flex items-end justify-between">
        <div className="flex flex-col">
          <span className="text-[10px] font-bold text-muted uppercase">Preis ({isNetPrice ? 'Netto' : 'Brutto'})</span>
          <span className="text-2xl tabular-nums font-bold tracking-tight text-foreground">
            {formatCurrency(calculateDisplayPrice(article, isNetPrice))}
          </span>
        </div>
        <span className="text-xs font-bold text-muted mb-1.5">/ {article.unit}</span>
      </div>
    </div>
  );
};
