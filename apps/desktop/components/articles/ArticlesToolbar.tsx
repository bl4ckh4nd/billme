import React from 'react';
import { Search, Plus, Trash2, LayoutGrid, List, ToggleLeft, ToggleRight, X } from 'lucide-react';

interface ArticlesToolbarProps {
  filteredCount: number;
  searchTerm: string;
  onSearchChange: (value: string) => void;
  categories: string[];
  selectedCategory: string;
  onCategoryChange: (category: string) => void;
  isNetPrice: boolean;
  onToggleNetPrice: () => void;
  viewMode: 'grid' | 'list';
  onViewModeChange: (mode: 'grid' | 'list') => void;
  onOpenForm: () => void;
  selectedCount: number;
  isBulkDeleting: boolean;
  onBulkDelete: () => void;
  onClearSelection: () => void;
}

export const ArticlesToolbar: React.FC<ArticlesToolbarProps> = ({
  filteredCount,
  searchTerm,
  onSearchChange,
  categories,
  selectedCategory,
  onCategoryChange,
  isNetPrice,
  onToggleNetPrice,
  viewMode,
  onViewModeChange,
  onOpenForm,
  selectedCount,
  isBulkDeleting,
  onBulkDelete,
  onClearSelection,
}) => {
  return (
    <div className="flex flex-col gap-6 mb-6 shrink-0">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-black text-foreground mb-1">Produkte & Leistungen</h1>
          <p className="text-sm text-muted font-medium tabular-nums">{filteredCount} Einträge</p>
        </div>

        <div className="flex items-center gap-3">
          {/* Net/Gross Switch */}
          <button
            onClick={onToggleNetPrice}
            className="flex items-center gap-2 px-4 py-2 bg-canvas rounded-full hover:bg-border transition-colors duration-150 ease-out"
          >
            <span className={`text-xs font-bold ${isNetPrice ? 'text-foreground' : 'text-muted'}`}>Netto</span>
            {isNetPrice ? <ToggleLeft size={24} /> : <ToggleRight size={24} />}
            <span className={`text-xs font-bold ${!isNetPrice ? 'text-foreground' : 'text-muted'}`}>Brutto</span>
          </button>

          <div className="h-8 w-px bg-border mx-2"></div>

          {/* View Switcher */}
          <div className="bg-canvas p-1 rounded-full flex items-center">
            <button
              onClick={() => onViewModeChange('grid')}
              className={`w-10 h-10 rounded-full flex items-center justify-center transition-[background-color,border-color,color,box-shadow,opacity,transform,width] duration-150 ease-out ${viewMode === 'grid' ? 'bg-surface shadow text-foreground' : 'text-muted hover:text-foreground'}`}
            >
              <LayoutGrid size={18} />
            </button>
            <button
              onClick={() => onViewModeChange('list')}
              className={`w-10 h-10 rounded-full flex items-center justify-center transition-[background-color,border-color,color,box-shadow,opacity,transform,width] duration-150 ease-out ${viewMode === 'list' ? 'bg-surface shadow text-foreground' : 'text-muted hover:text-foreground'}`}
            >
              <List size={18} />
            </button>
          </div>

          <button
            onClick={onOpenForm}
            className="w-12 h-12 bg-foreground text-white rounded-full flex items-center justify-center hover:scale-105 active:scale-95 transition-transform duration-150 ease-out shadow-sm ml-2"
          >
            <Plus size={24} />
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between gap-4">
        {/* Search */}
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-muted" size={18} />
          <input
            type="text"
            placeholder="Artikel suchen..."
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full pl-12 pr-6 py-3 bg-surface-muted border-none rounded-full text-sm font-bold outline-none focus:ring-2 focus:ring-accent transition-shadow duration-150 ease-out"
          />
        </div>

        {/* Category Pills */}
        <div className="flex-1 overflow-x-auto scrollbar-hide flex gap-2 justify-end mask-linear-fade">
          {categories.map(cat => (
            <button
              key={cat}
              onClick={() => onCategoryChange(cat)}
              className={`whitespace-nowrap px-4 py-2 rounded-full text-xs font-bold transition-[background-color,border-color,color,box-shadow,opacity,transform,width] duration-150 ease-out ${
                selectedCategory === cat
                ? 'bg-foreground text-white'
                : 'bg-canvas text-muted hover:bg-border'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Bulk Actions Bar */}
      {selectedCount > 0 && (
        <div className="absolute top-8 left-1/2 -translate-x-1/2 bg-foreground text-white px-6 py-3 rounded-full shadow-2xl z-20 flex items-center gap-6 animate-in slide-in-from-top-4">
          <span className="text-sm font-bold tabular-nums">{selectedCount} ausgewählt</span>
          <div className="h-4 w-px bg-white/20"></div>
          <button
            onClick={onBulkDelete}
            disabled={isBulkDeleting}
            className="flex items-center gap-2 hover:text-error/70 transition-colors duration-150 ease-out text-xs font-bold disabled:opacity-50"
          >
            <Trash2 size={14} /> {isBulkDeleting ? 'Lösche...' : 'Löschen'}
          </button>
          <button onClick={onClearSelection} className="ml-2 hover:text-white/60 transition-colors duration-150 ease-out">
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
};
