import React, { useState, useMemo } from 'react';
import {
  Search, Plus, Package, Edit3, Trash2, Tag,
  Euro, LayoutGrid, List, Check, X,
  Copy, Percent, ToggleLeft, ToggleRight, Archive, CheckSquare
} from 'lucide-react';
import { Article } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { useArticlesQuery, useDeleteArticleMutation, useUpsertArticleMutation } from '../hooks/useArticles';
import { useSettingsQuery } from '../hooks/useSettings';

const normalizeCategoryName = (value: string): string => value.trim();

const buildConfiguredCategories = (
  settingsCategories: Array<{ id: string; name: string }> | undefined,
): string[] => {
  const normalized = (settingsCategories ?? [])
    .map((c) => normalizeCategoryName(c.name))
    .filter(Boolean);

  const unique = Array.from(new Set(normalized)).sort((a, b) => a.localeCompare(b, 'de-DE'));
  return unique.length > 0 ? unique : ['Allgemein'];
};

// Category colors - using design system semantic palette + grays
const PASTEL_COLORS = [
    'bg-error-bg text-error',
    'bg-warning-bg text-warning',
    'bg-success-bg text-success',
    'bg-info-bg text-info',
    'bg-surface-muted text-muted',
    'bg-gray-200 text-gray-600',
    'bg-error-bg text-error',
    'bg-warning-bg text-warning',
    'bg-success-bg text-success',
    'bg-info-bg text-info',
    'bg-surface-muted text-muted',
    'bg-gray-200 text-gray-600',
];

const getAvatarColor = (str: string) => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    const index = Math.abs(hash) % PASTEL_COLORS.length;
    return PASTEL_COLORS[index];
};

const getInitials = (str: string) => {
    return str.substring(0, 2).toUpperCase();
};

export const ArticlesView: React.FC = () => {
  const { data: articles = [] } = useArticlesQuery();
  const { data: settings } = useSettingsQuery();
  const upsertArticle = useUpsertArticleMutation();
  const deleteArticle = useDeleteArticleMutation();
  const [searchTerm, setSearchTerm] = useState('');
  const locationSearch = window.location.search;
  const [selectedCategory, setSelectedCategory] = useState<string>('Alle');
  const [isNetPrice, setIsNetPrice] = useState(true); // Toggle Net/Gross
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  
  // Selection
  const [selectedArticles, setSelectedArticles] = useState<Set<string>>(new Set());
  const [operationMessage, setOperationMessage] = useState<string | null>(null);
  const [operationTone, setOperationTone] = useState<'success' | 'error'>('success');

  // Form
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingArticle, setEditingArticle] = useState<Article | null>(null);

  const [formData, setFormData] = useState<Partial<Article>>({
      title: '',
      description: '',
      price: 0,
      unit: 'Std',
      category: 'Allgemein',
      taxRate: 19,
      sku: ''
  });
  const [formErrors, setFormErrors] = useState<Partial<Record<'title' | 'price' | 'unit' | 'category' | 'taxRate' | 'sku', string>>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const configuredCategories = useMemo(
    () => buildConfiguredCategories(settings?.catalog?.categories),
    [settings],
  );

  const categories = useMemo(
    () => ['Alle', ...configuredCategories],
    [configuredCategories],
  );

  const filteredArticles = articles.filter(a => {
      const matchesSearch = a.title.toLowerCase().includes(searchTerm.toLowerCase()) || 
                            a.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
                            (a.sku && a.sku.toLowerCase().includes(searchTerm.toLowerCase()));
      const matchesCategory = selectedCategory === 'Alle' || a.category === selectedCategory;
      return matchesSearch && matchesCategory;
  });

  React.useEffect(() => {
    const params = new URLSearchParams(locationSearch);
    const query = params.get('query')?.trim() ?? '';
    setSearchTerm(query);
  }, [locationSearch]);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
  };

  const calculateDisplayPrice = (article: Article) => {
      if (isNetPrice) return article.price;
      return article.price * (1 + article.taxRate / 100);
  };

  const handleOpenForm = (article?: Article) => {
      setFormErrors({});
      setOperationMessage(null);
      if (article) {
          const normalizedCategory = normalizeCategoryName(article.category);
          const category = configuredCategories.includes(normalizedCategory)
            ? normalizedCategory
            : configuredCategories[0] ?? 'Allgemein';

          setEditingArticle(article);
          setFormData({ ...article, category });
      } else {
          setEditingArticle(null);
          setFormData({
              title: '',
              description: '',
              price: 0,
              unit: 'Std',
              category: configuredCategories[0] ?? 'Allgemein',
              taxRate: 19,
              sku: ''
          });
      }
      setIsFormOpen(true);
  };

  const handleDuplicate = async (article: Article) => {
      const newArticle: Article = {
          ...article,
          id: uuidv4(),
          title: `${article.title} (Kopie)`,
          sku: article.sku ? `${article.sku}-COPY` : undefined
      };
      try {
        await upsertArticle.mutateAsync(newArticle);
        setOperationTone('success');
        setOperationMessage(`Artikel "${newArticle.title}" dupliziert.`);
      } catch (error) {
        setOperationTone('error');
        setOperationMessage(`Duplizieren fehlgeschlagen: ${String(error)}`);
      }
  };

  const handleDelete = async (id: string) => {
      if (confirm('Artikel wirklich löschen?')) {
          try {
            await deleteArticle.mutateAsync(id);
            if (selectedArticles.has(id)) {
                const newSelected = new Set(selectedArticles);
                newSelected.delete(id);
                setSelectedArticles(newSelected);
            }
            setOperationTone('success');
            setOperationMessage('Artikel gelöscht.');
          } catch (error) {
            setOperationTone('error');
            setOperationMessage(`Löschen fehlgeschlagen: ${String(error)}`);
          }
      }
  };
  
  const handleBulkDelete = async () => {
      if (selectedArticles.size === 0) return;
      if (!confirm(`${selectedArticles.size} Artikel löschen?`)) return;
      setIsBulkDeleting(true);
      const ids = Array.from(selectedArticles);
      let deleted = 0;
      const failedIds: string[] = [];
      for (const id of ids) {
        try {
          await deleteArticle.mutateAsync(id);
          deleted++;
        } catch {
          failedIds.push(id);
        }
      }

      setSelectedArticles(new Set(failedIds));
      if (failedIds.length === 0) {
        setOperationTone('success');
        setOperationMessage(`${deleted} Artikel erfolgreich gelöscht.`);
      } else {
        setOperationTone('error');
        setOperationMessage(
          `${deleted} gelöscht, ${failedIds.length} fehlgeschlagen. Fehlgeschlagene Auswahl bleibt markiert.`,
        );
      }
      setIsBulkDeleting(false);
  };

  const handleToggleSelect = (id: string) => {
      const newSelected = new Set(selectedArticles);
      if (newSelected.has(id)) newSelected.delete(id);
      else newSelected.add(id);
      setSelectedArticles(newSelected);
  };

  const handleSelectAll = () => {
      if (selectedArticles.size === filteredArticles.length) {
          setSelectedArticles(new Set());
      } else {
          setSelectedArticles(new Set(filteredArticles.map(a => a.id)));
      }
  };

  const validateForm = () => {
      const nextErrors: Partial<Record<'title' | 'price' | 'unit' | 'category' | 'taxRate' | 'sku', string>> = {};
      const title = (formData.title ?? '').trim();
      const unit = (formData.unit ?? '').trim();
      const category = normalizeCategoryName(formData.category ?? '');
      const price = Number(formData.price);
      const taxRate = Number(formData.taxRate);
      const sku = (formData.sku ?? '').trim();

      if (!title) nextErrors.title = 'Bezeichnung ist erforderlich.';
      if (!Number.isFinite(price) || price < 0) nextErrors.price = 'Preis muss >= 0 sein.';
      if (!unit) nextErrors.unit = 'Einheit ist erforderlich.';
      if (!category) nextErrors.category = 'Kategorie ist erforderlich.';
      if (![0, 7, 19].includes(taxRate)) nextErrors.taxRate = 'Steuersatz muss 0, 7 oder 19 sein.';
      if (sku && !/^[A-Za-z0-9._-]+$/.test(sku)) nextErrors.sku = 'SKU darf nur Buchstaben, Zahlen, Punkt, Unterstrich und Bindestrich enthalten.';

      setFormErrors(nextErrors);
      return Object.keys(nextErrors).length === 0;
  };

  const handleSubmit = async () => {
      if (!validateForm()) return;
      setIsSaving(true);
      const normalizedCategory = normalizeCategoryName(formData.category ?? '');
      const safeCategory = configuredCategories.includes(normalizedCategory)
        ? normalizedCategory
        : configuredCategories[0] ?? 'Allgemein';

      try {
        if (editingArticle) {
            await upsertArticle.mutateAsync({
              ...editingArticle,
              ...formData,
              title: (formData.title ?? '').trim(),
              sku: (formData.sku ?? '').trim() || undefined,
              unit: (formData.unit ?? 'Stk').trim(),
              category: safeCategory,
              taxRate: Number(formData.taxRate) || 19,
              price: Number(formData.price),
              description: formData.description ?? '',
            } as Article);
        } else {
            const newArticle: Article = {
                id: uuidv4(),
                title: (formData.title ?? '').trim(),
                description: formData.description || '',
                price: Number(formData.price),
                unit: (formData.unit ?? 'Stk').trim(),
                category: safeCategory,
                taxRate: Number(formData.taxRate) || 19,
                sku: (formData.sku ?? '').trim() || undefined
            };
            await upsertArticle.mutateAsync(newArticle);
        }
        setOperationTone('success');
        setOperationMessage(editingArticle ? 'Artikel gespeichert.' : 'Artikel erstellt.');
        setIsFormOpen(false);
      } catch (error) {
        setOperationTone('error');
        setOperationMessage(`Speichern fehlgeschlagen: ${String(error)}`);
      } finally {
        setIsSaving(false);
      }
  };

  return (
    <div className="flex gap-6 h-full animate-enter">
        {/* Main Content */}
        <div className="flex-1 bg-white rounded-[2.5rem] p-8 min-h-full shadow-sm flex flex-col overflow-hidden relative">
            
            {/* Header Area */}
            <div className="flex flex-col gap-6 mb-6 shrink-0">
                <div className="flex items-center justify-between">
                    <div>
                        <h1 className="text-3xl font-black text-gray-900 mb-1">Produkte & Leistungen</h1>
                        <p className="text-sm text-gray-500 font-medium">{filteredArticles.length} Einträge</p>
                    </div>
                    
                    <div className="flex items-center gap-3">
                        {/* Net/Gross Switch */}
                        <button 
                            onClick={() => setIsNetPrice(!isNetPrice)}
                            className="flex items-center gap-2 px-4 py-2 bg-gray-100 rounded-full hover:bg-gray-200 transition-colors"
                        >
                            <span className={`text-xs font-bold ${isNetPrice ? 'text-black' : 'text-gray-400'}`}>Netto</span>
                            {isNetPrice ? <ToggleLeft size={24} /> : <ToggleRight size={24} />}
                            <span className={`text-xs font-bold ${!isNetPrice ? 'text-black' : 'text-gray-400'}`}>Brutto</span>
                        </button>

                        <div className="h-8 w-px bg-gray-200 mx-2"></div>

                        {/* View Switcher */}
                        <div className="bg-gray-100 p-1 rounded-full flex items-center">
                            <button 
                                onClick={() => setViewMode('grid')}
                                className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${viewMode === 'grid' ? 'bg-white shadow text-black' : 'text-gray-400 hover:text-gray-600'}`}
                            >
                                <LayoutGrid size={18} />
                            </button>
                            <button 
                                onClick={() => setViewMode('list')}
                                className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${viewMode === 'list' ? 'bg-white shadow text-black' : 'text-gray-400 hover:text-gray-600'}`}
                            >
                                <List size={18} />
                            </button>
                        </div>

                        <button
                            onClick={() => handleOpenForm()}
                            className="w-12 h-12 bg-black text-white rounded-full flex items-center justify-center hover:scale-105 active:scale-95 transition-transform shadow-sm ml-2"
                        >
                            <Plus size={24} />
                        </button>
                    </div>
                </div>

                <div className="flex items-center justify-between gap-4">
                     {/* Search */}
                    <div className="relative flex-1 max-w-md">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
                        <input 
                            type="text" 
                            placeholder="Artikel suchen..." 
                            value={searchTerm}
                            onChange={(e) => setSearchTerm(e.target.value)}
                            className="w-full pl-12 pr-6 py-3 bg-gray-50 border-none rounded-full text-sm font-bold outline-none focus:ring-2 focus:ring-accent transition-shadow"
                        />
                    </div>

                    {/* Category Pills */}
                    <div className="flex-1 overflow-x-auto scrollbar-hide flex gap-2 justify-end mask-linear-fade">
                        {categories.map(cat => (
                            <button
                                key={cat}
                                onClick={() => setSelectedCategory(cat)}
                                className={`whitespace-nowrap px-4 py-2 rounded-full text-xs font-bold transition-all ${
                                    selectedCategory === cat 
                                    ? 'bg-black text-white' 
                                    : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                                }`}
                            >
                                {cat}
                            </button>
                        ))}
                    </div>
                </div>

                {/* Bulk Actions Bar */}
                {selectedArticles.size > 0 && (
                    <div className="absolute top-8 left-1/2 -translate-x-1/2 bg-black text-white px-6 py-3 rounded-full shadow-2xl z-20 flex items-center gap-6 animate-in slide-in-from-top-4">
                        <span className="text-sm font-bold">{selectedArticles.size} ausgewählt</span>
                        <div className="h-4 w-px bg-white/20"></div>
                        <button
                          onClick={() => void handleBulkDelete()}
                          disabled={isBulkDeleting}
                          className="flex items-center gap-2 hover:text-error/70 transition-colors text-xs font-bold disabled:opacity-50"
                        >
                            <Trash2 size={14} /> {isBulkDeleting ? 'Lösche...' : 'Löschen'}
                        </button>
                        <button onClick={() => setSelectedArticles(new Set())} className="ml-2 hover:text-gray-400 transition-colors">
                            <X size={16} />
                        </button>
                    </div>
                )}
            </div>

            {operationMessage && (
              <div
                className={`mb-4 rounded-xl border px-4 py-3 text-sm font-medium ${
                  operationTone === 'success'
                    ? 'border-success/30 bg-success-bg text-success'
                    : 'border-error/30 bg-error-bg text-error'
                }`}
              >
                {operationMessage}
              </div>
            )}

            {/* List Content */}
            {viewMode === 'grid' ? (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4 overflow-y-auto pr-2 pb-4 scrollbar-hide">
                    {filteredArticles.map((article, idx) => (
                        <div
                            key={article.id}
                            className="group bg-gray-50 rounded-[2rem] p-6 border border-gray-100 hover:border-border hover:bg-white hover:-translate-y-1 transition-all relative flex flex-col animate-scale-in"
                            style={{ animationDelay: `${idx * 50}ms` }}
                        >
                            <div className="flex justify-between items-start mb-4">
                                <div className={`w-12 h-12 rounded-2xl flex items-center justify-center text-sm font-bold shadow-sm transition-transform group-hover:scale-110 ${getAvatarColor(article.category)}`}>
                                    {getInitials(article.title)}
                                </div>
                                <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                    <button 
                                        onClick={() => void handleDuplicate(article)} 
                                        className="p-2 bg-white rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"
                                        title="Duplizieren"
                                    >
                                        <Copy size={14}/>
                                    </button>
                                    <button 
                                        onClick={() => handleOpenForm(article)} 
                                        className="p-2 bg-white rounded-lg hover:bg-black hover:text-white transition-colors"
                                        title="Bearbeiten"
                                    >
                                        <Edit3 size={14}/>
                                    </button>
                                </div>
                            </div>
                            
                            <div className="mb-auto">
                                <div className="flex items-center gap-2 mb-1">
                                    <span className="text-[10px] font-bold uppercase bg-gray-200 text-gray-600 px-2 py-1 rounded-full line-clamp-1">
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
                                    <p className="text-[10px] font-mono text-gray-400 mb-2">#{article.sku}</p>
                                )}
                            </div>

                            <div className="mt-4 pt-4 border-t border-gray-200/50 flex items-end justify-between">
                                <div className="flex flex-col">
                                    <span className="text-[10px] font-bold text-gray-400 uppercase">Preis ({isNetPrice ? 'Netto' : 'Brutto'})</span>
                                    <span className="text-2xl font-mono font-bold tracking-tight text-black">
                                        {formatCurrency(calculateDisplayPrice(article))}
                                    </span>
                                </div>
                                <span className="text-xs font-bold text-gray-400 mb-1.5">/ {article.unit}</span>
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="flex-1 overflow-y-auto pr-2 pb-4 space-y-2 scrollbar-hide">
                     <div className="grid grid-cols-12 gap-4 px-4 py-2 text-[10px] font-bold text-gray-400 uppercase tracking-wider sticky top-0 bg-white z-10 border-b border-gray-100">
                        <div className="col-span-1 flex justify-center">
                            <button onClick={handleSelectAll} className="hover:text-black">
                                <CheckSquare size={16} className={selectedArticles.size > 0 ? 'text-black fill-black/10' : 'text-gray-300'} />
                            </button>
                        </div>
                        <div className="col-span-4">Artikel / Leistung</div>
                        <div className="col-span-2">SKU / Kat</div>
                        <div className="col-span-1 text-center">USt</div>
                        <div className="col-span-2 text-right">Preis ({isNetPrice ? 'Netto' : 'Brutto'})</div>
                        <div className="col-span-2 text-right">Aktionen</div>
                    </div>
                    {filteredArticles.map((article, idx) => (
                        <div 
                            key={article.id} 
                            className={`group rounded-2xl p-4 border transition-all grid grid-cols-12 gap-4 items-center animate-enter ${
                                selectedArticles.has(article.id)
                                ? 'bg-info-bg/50 border-info'
                                : 'bg-gray-50 border-gray-100 hover:border-border hover:bg-white'
                            }`}
                            style={{ animationDelay: `${idx * 30}ms` }}
                        >
                             <div className="col-span-1 flex justify-center">
                                 <button onClick={() => handleToggleSelect(article.id)}>
                                     <div className={`w-5 h-5 rounded border flex items-center justify-center transition-colors ${
                                         selectedArticles.has(article.id) ? 'bg-black border-black text-accent' : 'border-gray-300 bg-white'
                                     }`}>
                                         {selectedArticles.has(article.id) && <Check size={12} />}
                                     </div>
                                 </button>
                             </div>
                             <div className="col-span-4 flex items-center gap-4">
                                <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xs font-bold shadow-sm shrink-0 ${getAvatarColor(article.category)}`}>
                                    {getInitials(article.title)}
                                </div>
                                <div className="min-w-0">
                                    <h3 className="font-bold text-sm text-gray-900 truncate">{article.title}</h3>
                                    <p className="text-xs text-gray-500 truncate">{article.description || '-'}</p>
                                </div>
                             </div>
                             <div className="col-span-2">
                                 <div className="flex flex-col items-start gap-1">
                                    {article.sku && <span className="font-mono text-[10px] text-gray-500 bg-white px-1.5 rounded border border-gray-200">#{article.sku}</span>}
                                    <span className="text-[10px] font-bold uppercase bg-gray-200 text-gray-600 px-2 py-1 rounded-full truncate max-w-full">{article.category}</span>
                                 </div>
                             </div>
                             <div className="col-span-1 text-center">
                                 <span className={`text-[10px] font-bold px-2 py-1 rounded ${article.taxRate === 19 ? 'bg-gray-100 text-gray-500' : 'bg-info-bg text-info'}`}>
                                     {article.taxRate}%
                                 </span>
                             </div>
                             <div className="col-span-2 text-right">
                                 <p className="font-mono font-bold text-sm text-black">{formatCurrency(calculateDisplayPrice(article))}</p>
                                 <p className="text-[10px] text-gray-400">pro {article.unit}</p>
                             </div>
                             <div className="col-span-2 flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                <button onClick={() => void handleDuplicate(article)} className="p-2 bg-white border border-gray-100 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors"><Copy size={14}/></button>
                                <button onClick={() => handleOpenForm(article)} className="p-2 bg-white border border-gray-100 rounded-lg hover:bg-black hover:text-white transition-colors"><Edit3 size={14}/></button>
                                <button onClick={() => void handleDelete(article.id)} className="p-2 bg-white border border-gray-100 text-error rounded-lg hover:bg-error hover:text-white transition-colors"><Trash2 size={14}/></button>
                             </div>
                        </div>
                    ))}
                </div>
            )}
        </div>

        {/* Slide-over Form */}
        {isFormOpen && (
            <div className="w-[450px] bg-white rounded-[2.5rem] shadow-2xl border-l border-gray-100 flex flex-col animate-in slide-in-from-right duration-300 relative z-20">
                <div className="p-8 border-b border-gray-100 flex items-center justify-between">
                    <div>
                        <h2 className="text-xl font-bold">{editingArticle ? 'Artikel bearbeiten' : 'Neuer Artikel'}</h2>
                        <p className="text-xs text-gray-500">
                            {editingArticle ? `ID: ${editingArticle.id.substring(0,8)}` : 'Neuer Eintrag wird erstellt'}
                        </p>
                    </div>
                    <button onClick={() => setIsFormOpen(false)} className="p-2 hover:bg-gray-100 rounded-full transition-colors"><X size={20} /></button>
                </div>

                <div className="p-8 space-y-6 flex-1 overflow-y-auto">
                    
                    {/* Basic Info */}
                    <div className="space-y-4">
                        <div className="flex gap-4">
                            <div className="flex-1">
                                <label className="block text-xs font-bold text-gray-500 mb-2 uppercase">Bezeichnung <span className="text-error">*</span></label>
                                <input 
                                    type="text" 
                                    value={formData.title}
                                    onChange={(e) => setFormData({...formData, title: e.target.value})}
                                    className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm font-bold focus:ring-2 focus:ring-accent outline-none transition-shadow"
                                    placeholder="z.B. Webdesign"
                                    autoFocus
                                />
                                {formErrors.title && <p className="mt-1 text-xs font-bold text-error">{formErrors.title}</p>}
                            </div>
                             <div className="w-1/3">
                                <label className="block text-xs font-bold text-gray-500 mb-2 uppercase">Artikel-Nr.</label>
                                <input 
                                    type="text" 
                                    value={formData.sku}
                                    onChange={(e) => setFormData({...formData, sku: e.target.value})}
                                    className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm font-mono focus:ring-2 focus:ring-accent outline-none transition-shadow"
                                    placeholder="SKU-001"
                                />
                                {formErrors.sku && <p className="mt-1 text-xs font-bold text-error">{formErrors.sku}</p>}
                            </div>
                        </div>

                        <div>
                             <label className="block text-xs font-bold text-gray-500 mb-2 uppercase">Kategorie</label>
                             <div className="relative">
                                <Tag size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"/>
                                <select 
                                    value={formData.category}
                                    onChange={(e) => setFormData({...formData, category: e.target.value})}
                                    className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 pl-10 text-sm font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow appearance-none"
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

                    <hr className="border-gray-100" />

                    {/* Pricing */}
                    <div className="space-y-4">
                        <h3 className="text-sm font-bold flex items-center gap-2">
                            <Euro size={16} /> Preise & Steuer
                        </h3>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="block text-xs font-bold text-gray-500 mb-2 uppercase">Preis (Netto) <span className="text-error">*</span></label>
                                <div className="relative">
                                    <input 
                                        type="number" 
                                        value={formData.price}
                                        onChange={(e) => setFormData({...formData, price: Number(e.target.value)})}
                                        className={`w-full bg-gray-50 border rounded-xl p-3 text-sm font-bold focus:ring-2 focus:ring-accent outline-none transition-shadow ${Number(formData.price) < 0 ? 'border-error/30 text-error' : 'border-gray-200'}`}
                                        step="0.01"
                                    />
                                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-bold text-gray-400">EUR</span>
                                </div>
                                {formErrors.price && <p className="mt-1 text-xs font-bold text-error">{formErrors.price}</p>}
                            </div>
                            <div>
                                <label className="block text-xs font-bold text-gray-500 mb-2 uppercase">Einheit</label>
                                <select 
                                    value={formData.unit}
                                    onChange={(e) => setFormData({...formData, unit: e.target.value})}
                                    className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none appearance-none transition-shadow"
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
                            <label className="block text-xs font-bold text-gray-500 mb-2 uppercase">Umsatzsteuer (USt)</label>
                            <div className="flex bg-gray-50 rounded-xl p-1 border border-gray-200">
                                {[19, 7, 0].map((rate) => (
                                    <button
                                        key={rate}
                                        onClick={() => setFormData({...formData, taxRate: rate})}
                                        className={`flex-1 py-2 rounded-lg text-xs font-bold transition-all ${
                                            formData.taxRate === rate 
                                            ? 'bg-black text-accent shadow-sm' 
                                            : 'text-gray-500 hover:bg-gray-200'
                                        }`}
                                    >
                                        {rate}%
                                    </button>
                                ))}
                            </div>
                            {formErrors.taxRate && <p className="mt-1 text-xs font-bold text-error">{formErrors.taxRate}</p>}
                        </div>
                    </div>

                    <hr className="border-gray-100" />

                    {/* Description */}
                    <div>
                        <div className="flex justify-between items-center mb-2">
                            <label className="block text-xs font-bold text-gray-500 uppercase">Beschreibung</label>
                        </div>
                        <textarea 
                            value={formData.description}
                            onChange={(e) => setFormData({...formData, description: e.target.value})}
                            className="w-full bg-gray-50 border border-gray-200 rounded-xl p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none h-32 resize-none transition-shadow"
                            placeholder="Details zum Produkt..."
                        />
                         <p className="text-[10px] text-gray-400 mt-2 flex items-center gap-1">
                            <Archive size={10} /> Wird auf der Rechnung unter dem Titel angezeigt.
                        </p>
                    </div>
                </div>

                <div className="p-8 border-t border-gray-100 bg-gray-50 rounded-b-[2.5rem]">
                    <div className="flex gap-4">
                         {editingArticle && (
                            <button 
                                onClick={() => void handleDelete(editingArticle.id)}
                                className="px-4 py-4 rounded-xl bg-white border border-gray-200 text-error hover:bg-error-bg hover:border-error/30 transition-colors"
                            >
                                <Trash2 size={20} />
                            </button>
                         )}
                         <button
                            onClick={() => void handleSubmit()}
                            disabled={isSaving}
                            className="flex-1 bg-black text-accent py-3 rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-gray-900 active:scale-95 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                        >
                            <Check size={18} />
                            {isSaving ? 'Speichere...' : editingArticle ? 'Speichern' : 'Erstellen'}
                        </button>
                    </div>
                </div>
            </div>
        )}
    </div>
  );
};
