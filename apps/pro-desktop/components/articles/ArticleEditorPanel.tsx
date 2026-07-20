import React from 'react';
import { Tag, Euro, Archive, Check, Trash2, X } from 'lucide-react';
import { Article } from '../../types';

interface ArticleEditorPanelProps {
  editingArticle: Article | null;
  formData: Partial<Article>;
  formErrors: Partial<Record<'title' | 'price' | 'unit' | 'category' | 'taxRate' | 'sku', string>>;
  isSaving: boolean;
  configuredCategories: string[];
  onFormDataChange: (data: Partial<Article>) => void;
  onSubmit: () => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

export const ArticleEditorPanel: React.FC<ArticleEditorPanelProps> = ({
  editingArticle,
  formData,
  formErrors,
  isSaving,
  configuredCategories,
  onFormDataChange,
  onSubmit,
  onDelete,
  onClose,
}) => {
  return (
    <div className="w-[450px] bg-surface rounded-2xl shadow-2xl border-l border-border-subtle flex flex-col animate-in slide-in-from-right duration-200 ease-out relative z-20">
      <div className="p-8 border-b border-border-subtle flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">{editingArticle ? 'Artikel bearbeiten' : 'Neuer Artikel'}</h2>
          <p className="text-xs text-muted">
            {editingArticle ? `ID: ${editingArticle.id.substring(0,8)}` : 'Neuer Eintrag wird erstellt'}
          </p>
        </div>
        <button onClick={onClose} className="p-2 hover:bg-canvas rounded-full transition-colors duration-150 ease-out"><X size={20} /></button>
      </div>

      <div className="p-8 space-y-6 flex-1 overflow-y-auto">

        {/* Basic Info */}
        <div className="space-y-4">
          <div className="flex gap-4">
            <div className="flex-1">
              <label className="block text-xs font-bold text-muted mb-2 uppercase">Bezeichnung <span className="text-error">*</span></label>
              <input
                type="text"
                value={formData.title}
                onChange={(e) => onFormDataChange({...formData, title: e.target.value})}
                className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-bold focus:ring-2 focus:ring-accent outline-none transition-shadow duration-150 ease-out"
                placeholder="z.B. Webdesign"
                autoFocus
              />
              {formErrors.title && <p className="mt-1 text-xs font-bold text-error">{formErrors.title}</p>}
            </div>
            <div className="w-1/3">
              <label className="block text-xs font-bold text-muted mb-2 uppercase">Artikel-Nr.</label>
              <input
                type="text"
                value={formData.sku}
                onChange={(e) => onFormDataChange({...formData, sku: e.target.value})}
                className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-mono focus:ring-2 focus:ring-accent outline-none transition-shadow duration-150 ease-out"
                placeholder="SKU-001"
              />
              {formErrors.sku && <p className="mt-1 text-xs font-bold text-error">{formErrors.sku}</p>}
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-muted mb-2 uppercase">Kategorie</label>
            <div className="relative">
              <Tag size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"/>
              <select
                value={formData.category}
                onChange={(e) => onFormDataChange({...formData, category: e.target.value})}
                className="w-full bg-surface-muted border border-border rounded-lg p-3 pl-10 text-sm font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow duration-150 ease-out appearance-none"
              >
                {configuredCategories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            {formErrors.category && <p className="mt-1 text-xs font-bold text-error">{formErrors.category}</p>}
          </div>
        </div>

        <hr className="border-border-subtle" />

        {/* Pricing */}
        <div className="space-y-4">
          <h3 className="text-sm font-bold flex items-center gap-2">
            <Euro size={16} /> Preise & Steuer
          </h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-muted mb-2 uppercase">Preis (Netto) <span className="text-error">*</span></label>
              <div className="relative">
                <input
                  type="number"
                  value={formData.price}
                  onChange={(e) => onFormDataChange({...formData, price: Number(e.target.value)})}
                  className={`w-full bg-surface-muted border rounded-lg p-3 text-sm font-bold tabular-nums focus:ring-2 focus:ring-accent outline-none transition-shadow duration-150 ease-out ${Number(formData.price) < 0 ? 'border-error/30 text-error' : 'border-border'}`}
                  step="0.01"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-muted">EUR</span>
              </div>
              {formErrors.price && <p className="mt-1 text-xs font-bold text-error">{formErrors.price}</p>}
            </div>
            <div>
              <label className="block text-xs font-bold text-muted mb-2 uppercase">Einheit</label>
              <select
                value={formData.unit}
                onChange={(e) => onFormDataChange({...formData, unit: e.target.value})}
                className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none appearance-none transition-shadow duration-150 ease-out"
              >
                <option value="Std">Stunde</option>
                <option value="Stk">Stück</option>
                <option value="Pauschale">Pauschale</option>
                <option value="Tag">Tag</option>
                <option value="Monat">Monat</option>
                <option value="km">Kilometer</option>
              </select>
              {formErrors.unit && <p className="mt-1 text-xs font-bold text-error">{formErrors.unit}</p>}
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-muted mb-2 uppercase">Umsatzsteuer (USt)</label>
            <div className="flex bg-surface-muted rounded-lg p-1 border border-border">
              {[19, 7, 0].map((rate) => (
                <button
                  key={rate}
                  onClick={() => onFormDataChange({...formData, taxRate: rate})}
                  className={`flex-1 py-2 rounded-md text-xs font-bold transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-150 ease-out ${
                    formData.taxRate === rate
                    ? 'bg-foreground text-accent shadow-sm'
                    : 'text-muted hover:bg-canvas'
                  }`}
                >
                  {rate}%
                </button>
              ))}
            </div>
            {formErrors.taxRate && <p className="mt-1 text-xs font-bold text-error">{formErrors.taxRate}</p>}
          </div>
        </div>

        <hr className="border-border-subtle" />

        {/* Description */}
        <div>
          <div className="flex justify-between items-center mb-2">
            <label className="block text-xs font-bold text-muted uppercase">Beschreibung</label>
          </div>
          <textarea
            value={formData.description}
            onChange={(e) => onFormDataChange({...formData, description: e.target.value})}
            className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none h-32 resize-none transition-shadow duration-150 ease-out"
            placeholder="Details zum Produkt..."
          />
          <p className="text-[10px] text-muted mt-2 flex items-center gap-1">
            <Archive size={10} /> Wird auf der Rechnung unter dem Titel angezeigt.
          </p>
        </div>
      </div>

      <div className="p-8 border-t border-border-subtle bg-surface-muted rounded-b-2xl">
        <div className="flex gap-4">
          {editingArticle && (
            <button
              onClick={() => onDelete(editingArticle.id)}
              className="px-4 py-4 rounded-lg bg-surface border border-border text-error hover:bg-error-bg hover:border-error/30 transition-colors duration-150 ease-out"
            >
              <Trash2 size={20} />
            </button>
          )}
          <button
            onClick={onSubmit}
            disabled={isSaving}
            className="flex-1 bg-foreground text-accent py-3 rounded-lg font-bold flex items-center justify-center gap-2 hover:bg-dark-1 active:scale-95 transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-150 ease-out disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
          >
            <Check size={18} />
            {isSaving ? 'Speichere...' : editingArticle ? 'Speichern' : 'Erstellen'}
          </button>
        </div>
      </div>
    </div>
  );
};
