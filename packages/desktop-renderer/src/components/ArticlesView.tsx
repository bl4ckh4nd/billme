import React, { useState, useMemo } from 'react';
import {
  Search, Plus, Edit3, Trash2, Tag,
  Euro, LayoutGrid, List, Check, X,
  Copy, ToggleLeft, ToggleRight, Archive, CheckSquare
} from 'lucide-react';
import type { Article } from '@billme/desktop-core/types';
import { v4 as uuidv4 } from 'uuid';
import { useArticlesQuery, useDeleteArticleMutation, useUpsertArticleMutation } from '../hooks/useArticles';
import { useCreateIntent } from '../hooks/useCreateIntent';
import { useDeferredDelete } from '../hooks/useDeferredDelete';
import { useSettingsQuery } from '../hooks/useSettings';
import { Badge, Button, EmptyState, ErrorState, IconButton, Input, PageHeader, SegmentedControl } from '@billme/ui';
import { SkeletonLoader } from '@billme/desktop-ui/components/SkeletonLoader';
import { useRouterState } from '@tanstack/react-router';

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

// Category avatars stay neutral so no semantic hue implies a category meaning.
const PASTEL_COLORS = [
    'bg-surface-muted text-foreground',
    'bg-border-subtle text-foreground',
    'bg-surface-muted text-muted',
    'bg-border-subtle text-muted',
    'bg-surface-muted text-foreground',
    'bg-border-subtle text-foreground',
    'bg-surface-muted text-muted',
    'bg-border-subtle text-muted',
    'bg-surface-muted text-foreground',
    'bg-border-subtle text-foreground',
    'bg-surface-muted text-muted',
    'bg-border-subtle text-muted',
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
  const {
    data: articles = [],
    isLoading: isLoadingArticles,
    isError: isArticlesError,
    refetch: refetchArticles,
  } = useArticlesQuery();
  const {
    data: settings,
    isLoading: isLoadingSettings,
    isError: isSettingsError,
    refetch: refetchSettings,
  } = useSettingsQuery();
  const upsertArticle = useUpsertArticleMutation();
  const deleteArticle = useDeleteArticleMutation();
  const { pendingIds, leavingIds, requestDelete } = useDeferredDelete({
    scope: 'articles',
    commit: (id) => deleteArticle.mutateAsync(id),
    label: (count) => count === 1 ? 'Artikel gelöscht' : `${count} Artikel gelöscht`,
  });
  const [searchTerm, setSearchTerm] = useState('');
  const locationSearch = useRouterState({ select: (s) => s.location.search }) as Record<string, unknown>;
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

  const configuredCategories = useMemo(
    () => buildConfiguredCategories(settings?.catalog?.categories),
    [settings],
  );

  const categories = useMemo(
    () => ['Alle', ...configuredCategories],
    [configuredCategories],
  );

  const visibleArticles = articles.filter((article) => !pendingIds.has(article.id) || leavingIds.has(article.id));
  // Linked from the command palette (?create=article).
  useCreateIntent('/articles', ['article'] as const, () => handleOpenForm());
  const filteredArticles = visibleArticles.filter(a => {
      const matchesSearch = a.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
                            a.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
                            (a.sku && a.sku.toLowerCase().includes(searchTerm.toLowerCase()));
      const matchesCategory = selectedCategory === 'Alle' || a.category === selectedCategory;
      return matchesSearch && matchesCategory;
  });

  React.useEffect(() => {
    const query = typeof locationSearch.query === 'string' ? locationSearch.query.trim() : '';
    setSearchTerm(query);
  }, [locationSearch]);

  // The category filter is configuration from settings, so a failed settings
  // query would silently narrow the list to a default category. Both queries
  // gate the view together.
  const isLoadingView = isLoadingArticles || isLoadingSettings;
  const hasQueryError = isArticlesError || isSettingsError;
  const isFiltered = searchTerm.trim().length > 0 || selectedCategory !== 'Alle';

  const retryQueries = () => {
    void refetchArticles();
    void refetchSettings();
  };

  const resetFilters = () => {
    setSearchTerm('');
    setSelectedCategory('Alle');
  };

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

  const handleDelete = (id: string) => {
      requestDelete([id]);
      setSelectedArticles((current) => {
          if (!current.has(id)) return current;
          const next = new Set(current);
          next.delete(id);
          return next;
      });
      if (editingArticle?.id === id) {
          setIsFormOpen(false);
          setEditingArticle(null);
      }
  };

  const handleBulkDelete = () => {
      const ids = Array.from(selectedArticles).filter((id) => !pendingIds.has(id));
      if (ids.length === 0) return;
      requestDelete(ids);
      setSelectedArticles((current) => {
          const next = new Set(current);
          ids.forEach((id) => next.delete(id));
          return next;
      });
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
              taxRate: Number(formData.taxRate),
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
                taxRate: Number(formData.taxRate),
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
    <div className="flex gap-6 h-full">
        {/* Main Content */}
        <div className="flex-1 bg-surface rounded-panel p-6 lg:p-8 min-h-full shadow-xs flex flex-col overflow-hidden relative">

            {/* Header Area */}
            <div className="relative shrink-0">
                <PageHeader
                    title="Produkte & Leistungen"
                    description={isLoadingView
                        ? 'Wird geladen …'
                        : hasQueryError
                          ? 'Nicht verfügbar'
                          : `${filteredArticles.length} Einträge`}
                    actions={
                        <Button onClick={() => handleOpenForm()}>
                            <Plus size={16} aria-hidden="true" /> Neuer Artikel
                        </Button>
                    }
                    toolbar={
                        <>
                            <div className="w-full sm:w-64">
                                <Input
                                    type="search"
                                    aria-label="Artikel durchsuchen"
                                    placeholder="Artikel suchen"
                                    value={searchTerm}
                                    onChange={(e) => setSearchTerm(e.target.value)}
                                    prefix={<Search size={14} aria-hidden="true" />}
                                    fullWidth
                                />
                            </div>
                            <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto scrollbar-hide" role="group" aria-label="Kategorie">
                                {categories.map(cat => (
                                    <button
                                        key={cat}
                                        type="button"
                                        onClick={() => setSelectedCategory(cat)}
                                        aria-pressed={selectedCategory === cat}
                                        className={`h-7 shrink-0 whitespace-nowrap rounded-full px-3 text-label transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                                            selectedCategory === cat
                                            ? 'bg-surface-inverse text-inverse-foreground'
                                            : 'bg-surface-sunken text-muted hover:text-foreground'
                                        }`}
                                    >
                                        {cat}
                                    </button>
                                ))}
                            </div>
                            <SegmentedControl
                                aria-label="Preisangabe"
                                value={isNetPrice ? 'net' : 'gross'}
                                onChange={(value) => setIsNetPrice(value === 'net')}
                                options={[{ value: 'net', label: 'Netto' }, { value: 'gross', label: 'Brutto' }]}
                            />
                            <SegmentedControl
                                aria-label="Ansicht"
                                value={viewMode}
                                onChange={setViewMode}
                                options={[
                                    { value: 'grid', label: <LayoutGrid size={16} aria-hidden="true" />, ariaLabel: 'Rasteransicht' },
                                    { value: 'list', label: <List size={16} aria-hidden="true" />, ariaLabel: 'Listenansicht' },
                                ]}
                            />
                        </>
                    }
                />

                {/* Bulk Actions Bar */}
                {selectedArticles.size > 0 && (
                    <div className="absolute top-0 left-1/2 -translate-x-1/2 z-[var(--z-dropdown)] flex items-center gap-3 rounded-card bg-surface-inverse px-4 py-2 text-inverse-foreground shadow-lg">
                        <span className="text-sm font-medium tabular-nums">{selectedArticles.size} ausgewählt</span>
                        <div className="h-4 w-px bg-border-inverse" aria-hidden="true" />
                        <button
                          type="button"
                          onClick={() => void handleBulkDelete()}
                          className="inline-flex h-8 items-center gap-1.5 rounded-control px-2.5 text-label text-error-inverse transition-colors hover:bg-surface-inverse-overlay disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring-dark"
                        >
                            <Trash2 size={14} aria-hidden="true" /> Löschen
                        </button>
                        <IconButton variant="inverse" size="sm" aria-label="Auswahl aufheben" onClick={() => setSelectedArticles(new Set())}>
                            <X size={16} aria-hidden="true" />
                        </IconButton>
                    </div>
                )}
            </div>

            {operationMessage && (
              <div
                className={`mb-4 rounded-xl border px-4 py-3 text-sm font-medium ${
                  operationTone === 'success'
                    ? 'border-success-border bg-success-bg text-success-text'
                    : 'border-error-border bg-error-bg text-error-text'
                }`}
              >
                {operationMessage}
              </div>
            )}

            {/* List Content */}
            {isLoadingView ? (
                <SkeletonLoader variant="card" count={6} />
            ) : hasQueryError ? (
                <ErrorState
                    title="Artikel konnten nicht geladen werden"
                    description="Die Artikel oder die Kategorien aus den Einstellungen sind nicht verfügbar. Es werden bewusst keine Ersatzdaten angezeigt."
                    onRetry={retryQueries}
                />
            ) : viewMode === 'grid' ? (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3 overflow-y-auto p-0.5 pb-4 scrollbar-hide">
                    {filteredArticles.length === 0 ? (
                        <EmptyState
                            className="col-span-full"
                            title={isFiltered ? 'Keine Artikel passen zu dieser Auswahl' : 'Noch keine Artikel angelegt'}
                            description={
                                isFiltered
                                    ? `Suche und Kategorie-Filter schließen alle ${visibleArticles.length} vorhandenen Artikel aus.`
                                    : 'Artikel sind die Positionen, die du in Rechnungen und Angeboten auswählst. Lege den ersten über das + oben rechts an.'
                            }
                            action={
                                isFiltered ? (
                                    <button
                                        onClick={resetFilters}
                                        className="px-4 py-2 rounded-control bg-surface-muted text-foreground font-semibold text-xs hover:bg-border-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                                    >
                                        Filter zurücksetzen
                                    </button>
                                ) : undefined
                            }
                        />
                    ) : filteredArticles.map((article) => (
                        <div
                            key={article.id}
                            data-leaving={leavingIds.has(article.id) || undefined}
                            className="group relative flex flex-col rounded-card bg-surface p-5 shadow-xs transition-shadow hover:shadow-md"
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <div className="flex items-center gap-1.5">
                                        <span className="truncate text-caption text-muted">{article.category}</span>
                                        {article.taxRate !== 19 && <Badge tone="info">{article.taxRate} % USt</Badge>}
                                    </div>
                                    <h3 className="mt-1 text-section leading-snug line-clamp-2">{article.title}</h3>
                                    {article.sku && <p className="mt-0.5 font-mono text-caption text-muted">#{article.sku}</p>}
                                </div>
                                <div className="ui-reveal flex shrink-0 gap-0.5">
                                    <IconButton size="sm" tooltip="Duplizieren" aria-label={`${article.title} duplizieren`} onClick={() => void handleDuplicate(article)}>
                                        <Copy size={14} aria-hidden="true" />
                                    </IconButton>
                                    <IconButton size="sm" tooltip="Bearbeiten" aria-label={`${article.title} bearbeiten`} onClick={() => handleOpenForm(article)}>
                                        <Edit3 size={14} aria-hidden="true" />
                                    </IconButton>
                                </div>
                            </div>

                            <div className="mt-auto flex items-baseline justify-between gap-3 pt-5">
                                <span className="text-xl font-semibold tracking-[-0.01em] tabular-nums">
                                    {formatCurrency(calculateDisplayPrice(article))}
                                </span>
                                <span className="text-caption text-muted">{isNetPrice ? 'netto' : 'brutto'} / {article.unit}</span>
                            </div>
                        </div>
                    ))}
                </div>
            ) : (
                <div className="flex-1 overflow-y-auto pr-2 pb-4 space-y-2 scrollbar-hide">
                     <div className="grid grid-cols-12 gap-4 px-4 py-2 text-xs font-semibold text-muted uppercase tracking-wider sticky top-0 bg-surface z-10 border-b border-border">
                        <div className="col-span-1 flex justify-center">
                            <button onClick={handleSelectAll} className="hover:text-foreground">
                                <CheckSquare size={16} className={selectedArticles.size > 0 ? 'text-foreground fill-black/10' : 'text-muted'} />
                            </button>
                        </div>
                        <div className="col-span-4">Artikel / Leistung</div>
                        <div className="col-span-2">SKU / Kat</div>
                        <div className="col-span-1 text-center">USt</div>
                        <div className="col-span-2 text-right">Preis ({isNetPrice ? 'Netto' : 'Brutto'})</div>
                        <div className="col-span-2 text-right">Aktionen</div>
                    </div>
                    {filteredArticles.length === 0 ? (
                        <EmptyState
                            title={isFiltered ? 'Keine Artikel passen zu dieser Auswahl' : 'Noch keine Artikel angelegt'}
                            description={
                                isFiltered
                                    ? `Suche und Kategorie-Filter schließen alle ${visibleArticles.length} vorhandenen Artikel aus.`
                                    : 'Artikel sind die Positionen, die du in Rechnungen und Angeboten auswählst. Lege den ersten über das + oben rechts an.'
                            }
                            action={
                                isFiltered ? (
                                    <button
                                        onClick={resetFilters}
                                        className="px-4 py-2 rounded-control bg-surface-muted text-foreground font-semibold text-xs hover:bg-border-subtle focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                                    >
                                        Filter zurücksetzen
                                    </button>
                                ) : undefined
                            }
                        />
                    ) : filteredArticles.map((article) => (
                        <div
                            key={article.id}
                            data-leaving={leavingIds.has(article.id) || undefined}
                            className={`group rounded-2xl p-4 border transition-colors grid grid-cols-12 gap-4 items-center ${
                                selectedArticles.has(article.id)
                                ? 'bg-info-bg border-info'
                                : 'bg-surface-muted border-border-subtle hover:border-border hover:bg-surface'
                            }`}
                        >
                             <div className="col-span-1 flex justify-center">
                                 <button onClick={() => handleToggleSelect(article.id)} title={selectedArticles.has(article.id) ? 'Auswahl entfernen' : 'Auswählen'}>
                                     <div className={`w-5 h-5 rounded-sm border flex items-center justify-center transition-colors ${
                                         selectedArticles.has(article.id) ? 'bg-surface-inverse border-surface-inverse text-inverse-foreground' : 'border-control-border bg-surface'
                                     }`}>
                                         {selectedArticles.has(article.id) && <Check size={12} />}
                                     </div>
                                 </button>
                             </div>
                             <div className="col-span-4 flex items-center gap-4">
                                <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xs font-semibold shadow-sm shrink-0 ${getAvatarColor(article.category)}`}>
                                    {getInitials(article.title)}
                                </div>
                                <div className="min-w-0">
                                    <h3 className="font-semibold text-sm text-foreground truncate">{article.title}</h3>
                                    <p className="text-xs text-muted truncate">{article.description || 'Keine Beschreibung'}</p>
                                </div>
                             </div>
                             <div className="col-span-2">
                                 <div className="flex flex-col items-start gap-1">
                                    {article.sku && <span className="font-mono text-xs text-muted bg-surface px-1.5 rounded-sm border border-border">#{article.sku}</span>}
                                    <span className="text-xs font-semibold uppercase bg-border-subtle text-muted px-2 py-1 rounded-full truncate max-w-full">{article.category}</span>
                                 </div>
                             </div>
                             <div className="col-span-1 text-center">
                                 <span className={`text-xs font-semibold px-2 py-1 rounded-sm tabular-nums ${article.taxRate === 19 ? 'bg-surface-muted text-muted' : 'bg-info-bg text-info-text'}`}>
                                     {article.taxRate}%
                                 </span>
                             </div>
                             <div className="col-span-2 text-right">
                                 <p className="font-semibold text-sm text-foreground tabular-nums">{formatCurrency(calculateDisplayPrice(article))}</p>
                                 <p className="text-xs text-muted">pro {article.unit}</p>
                             </div>
                             <div className="ui-reveal col-span-2 flex items-center justify-end gap-2 focus-within:opacity-100">
                                <button onClick={() => void handleDuplicate(article)} title="Duplizieren" className="ui-press p-2 bg-surface border border-control-border rounded-lg hover:bg-border-subtle text-muted transition-colors"><Copy size={14}/></button>
                                <button onClick={() => handleOpenForm(article)} title="Bearbeiten" className="ui-press p-2 bg-surface border border-control-border rounded-lg hover:bg-surface-inverse hover:text-inverse-foreground transition-colors"><Edit3 size={14}/></button>
                                <button onClick={() => void handleDelete(article.id)} title="Löschen" className="ui-press p-2 bg-surface border border-control-border text-error-text rounded-lg hover:bg-error hover:text-inverse-foreground transition-colors"><Trash2 size={14}/></button>
                             </div>
                        </div>
                    ))}
                </div>
            )}
        </div>

        {/* Slide-over Form */}
        {isFormOpen && (
            <div className="w-[450px] bg-surface rounded-2xl shadow-2xl flex flex-col relative">
                <div className="p-8 border-b border-border flex items-center justify-between">
                    <div>
                        <h2 className="text-xl font-semibold">{editingArticle ? 'Artikel bearbeiten' : 'Neuer Artikel'}</h2>
                        <p className="text-xs text-muted">
                            {editingArticle ? `ID: ${editingArticle.id.substring(0,8)}` : 'Neuer Eintrag wird erstellt'}
                        </p>
                    </div>
                    <button onClick={() => setIsFormOpen(false)} className="p-2 hover:bg-border-subtle rounded-full transition-colors"><X size={20} /></button>
                </div>

                <div className="p-8 space-y-6 flex-1 overflow-y-auto">

                    {/* Basic Info */}
                    <div className="space-y-4">
                        <div className="flex gap-4">
                            <div className="flex-1">
                                <label className="block mb-1.5 text-label text-foreground" htmlFor="articlesview-bezeichnung">Bezeichnung <span className="text-error-text" aria-hidden="true">*</span></label>
                                <input id="articlesview-bezeichnung" aria-required="true"
                                    type="text"
                                    value={formData.title}
                                    onChange={(e) => setFormData({...formData, title: e.target.value})}
                                    className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                                    placeholder="z.B. Webdesign"
                                    autoFocus
                                />
                                {formErrors.title && <p className="mt-1 text-xs font-semibold text-error-text">{formErrors.title}</p>}
                            </div>
                             <div className="w-1/3">
                                <label className="block mb-1.5 text-label text-foreground" htmlFor="articlesview-artikel-nr">Artikel-Nr.</label>
                                <input id="articlesview-artikel-nr"
                                    type="text"
                                    value={formData.sku}
                                    onChange={(e) => setFormData({...formData, sku: e.target.value})}
                                    className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm font-mono focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                                    placeholder="SKU-001"
                                />
                                {formErrors.sku && <p className="mt-1 text-xs font-semibold text-error-text">{formErrors.sku}</p>}
                            </div>
                        </div>

                        <div>
                             <label className="block mb-1.5 text-label text-foreground" htmlFor="articlesview-kategorie">Kategorie</label>
                             <div className="relative">
                                <Tag size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted"/>
                                <select id="articlesview-kategorie"
                                    value={formData.category}
                                    onChange={(e) => setFormData({...formData, category: e.target.value})}
                                    className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control pl-10 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors appearance-none"
                                >
                                    {configuredCategories.map((c) => (
                                      <option key={c} value={c}>
                                        {c}
                                      </option>
                                    ))}
                                </select>
                             </div>
                             {formErrors.category && <p className="mt-1 text-xs font-semibold text-error-text">{formErrors.category}</p>}
                        </div>
                    </div>

                    <hr className="border-border" />

                    {/* Pricing */}
                    <div className="space-y-4">
                        <h3 className="text-sm font-semibold flex items-center gap-2">
                            <Euro size={16} /> Preise & Steuer
                        </h3>
                        <div className="grid grid-cols-2 gap-4">
                            <div>
                                <label className="block mb-1.5 text-label text-foreground" htmlFor="articlesview-preis">Preis (Netto) <span className="text-error-text" aria-hidden="true">*</span></label>
                                <div className="relative">
                                    <input id="articlesview-preis" aria-required="true"
                                        type="number"
                                        value={formData.price}
                                        onChange={(e) => setFormData({...formData, price: Number(e.target.value)})}
                                        className={`w-full bg-surface-muted border rounded-xl p-3 text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-shadow ${Number(formData.price) < 0 ? 'border-error-border text-error-text' : 'border-control-border'}`}
                                        step="0.01"
                                    />
                                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted">EUR</span>
                                </div>
                                {formErrors.price && <p className="mt-1 text-xs font-semibold text-error-text">{formErrors.price}</p>}
                            </div>
                            <div>
                                <label className="block mb-1.5 text-label text-foreground" htmlFor="articlesview-einheit">Einheit</label>
                                <select id="articlesview-einheit"
                                    value={formData.unit}
                                    onChange={(e) => setFormData({...formData, unit: e.target.value})}
                                    className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring appearance-none transition-colors"
                                >
                                    <option value="Std">Stunde</option>
                                    <option value="Stk">Stück</option>
                                    <option value="Pauschale">Pauschale</option>
                                    <option value="Tag">Tag</option>
                                    <option value="Monat">Monat</option>
                                    <option value="km">Kilometer</option>
                                </select>
                                {formErrors.unit && <p className="mt-1 text-xs font-semibold text-error-text">{formErrors.unit}</p>}
                            </div>
                        </div>

                        <div>
                            <p className="block mb-1.5 text-label text-foreground" id="articlesview-ust">Umsatzsteuer (USt)</p>
                            <div role="group" aria-labelledby="articlesview-ust" className="flex bg-surface-muted rounded-xl p-1 border border-border">
                                {[19, 7, 0].map((rate) => (
                                    <button
                                        key={rate}
                                        onClick={() => setFormData({...formData, taxRate: rate})}
                                        className={`flex-1 py-2 rounded-lg text-xs font-semibold transition-colors ${
                                            formData.taxRate === rate
                                            ? 'bg-surface-inverse text-inverse-foreground'
                                            : 'text-muted hover:bg-border-subtle'
                                        }`}
                                    >
                                        {rate}%
                                    </button>
                                ))}
                            </div>
                            {formErrors.taxRate && <p className="mt-1 text-xs font-semibold text-error-text">{formErrors.taxRate}</p>}
                        </div>
                    </div>

                    <hr className="border-border" />

                    {/* Description */}
                    <div>
                        <div className="flex justify-between items-center mb-2">
                            <label className="block text-label text-foreground" htmlFor="articlesview-beschreibung">Beschreibung</label>
                        </div>
                        <textarea id="articlesview-beschreibung"
                            value={formData.description}
                            onChange={(e) => setFormData({...formData, description: e.target.value})}
                            className="px-3 py-2.5 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring h-32 resize-none transition-colors"
                            placeholder="Details zum Produkt..."
                        />
                         <p className="text-xs text-muted mt-2 flex items-center gap-1">
                            <Archive size={12} /> Wird auf der Rechnung unter dem Titel angezeigt.
                        </p>
                    </div>
                </div>

                <div className="p-8 border-t border-border bg-surface-muted rounded-b-2xl">
                    <div className="flex gap-4">
                         {editingArticle && (
                            <button
                                onClick={() => void handleDelete(editingArticle.id)}
                                title="Artikel löschen"
                                className="px-4 py-4 rounded-xl bg-surface border border-control-border text-error-text hover:bg-error-bg hover:border-error-border transition-colors"
                            >
                                <Trash2 size={20} />
                            </button>
                         )}
                         <button
                            onClick={() => void handleSubmit()}
                            disabled={isSaving}
                            className="flex-1 bg-surface-inverse text-inverse-foreground py-3 rounded-xl font-semibold flex items-center justify-center gap-2 hover:bg-dark-1 motion-safe:transition-transform motion-safe:active:scale-95 motion-reduce:transition-none disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            <Check size={16} />
                            {isSaving ? 'Speichere...' : editingArticle ? 'Speichern' : 'Erstellen'}
                        </button>
                    </div>
                </div>
            </div>
        )}
    </div>
  );
};
