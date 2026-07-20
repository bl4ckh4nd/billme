import React, { useState, useMemo } from 'react';
import { Package, Search } from 'lucide-react';
import { Article } from '../types';
import { v4 as uuidv4 } from 'uuid';
import { useArticlesQuery, useDeleteArticleMutation, useUpsertArticleMutation } from '../hooks/useArticles';
import { useSettingsQuery } from '../hooks/useSettings';
import { normalizeCategoryName, buildConfiguredCategories } from './articles/articleHelpers';
import { ArticleGridCard } from './articles/ArticleGridCard';
import { ArticleListHeader, ArticleListRow } from './articles/ArticleListRow';
import { ArticlesToolbar } from './articles/ArticlesToolbar';
import { ArticleEditorPanel } from './articles/ArticleEditorPanel';

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
        <div className="flex-1 bg-surface rounded-xl p-8 min-h-full shadow-sm flex flex-col overflow-hidden relative">

            <ArticlesToolbar
              filteredCount={filteredArticles.length}
              searchTerm={searchTerm}
              onSearchChange={setSearchTerm}
              categories={categories}
              selectedCategory={selectedCategory}
              onCategoryChange={setSelectedCategory}
              isNetPrice={isNetPrice}
              onToggleNetPrice={() => setIsNetPrice(!isNetPrice)}
              viewMode={viewMode}
              onViewModeChange={setViewMode}
              onOpenForm={() => handleOpenForm()}
              selectedCount={selectedArticles.size}
              isBulkDeleting={isBulkDeleting}
              onBulkDelete={() => void handleBulkDelete()}
              onClearSelection={() => setSelectedArticles(new Set())}
            />

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
            {articles.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center py-20 gap-4">
                    <div className="w-16 h-16 rounded-xl bg-canvas flex items-center justify-center">
                        <Package size={28} className="text-muted" />
                    </div>
                    <div className="text-center">
                        <p className="font-bold text-foreground mb-1">Noch keine Artikel angelegt</p>
                        <p className="text-sm text-muted">Erstellen Sie Ihren ersten Artikel oder Ihre erste Leistung.</p>
                    </div>
                    <button
                        onClick={() => handleOpenForm()}
                        className="mt-2 px-6 py-2.5 bg-foreground text-accent rounded-xl font-bold text-sm hover:bg-dark-1 transition-colors duration-150 ease-out"
                    >
                        Ersten Artikel erstellen
                    </button>
                </div>
            ) : filteredArticles.length === 0 ? (
                <div className="flex-1 flex flex-col items-center justify-center py-20 gap-4">
                    <div className="w-16 h-16 rounded-xl bg-canvas flex items-center justify-center">
                        <Search size={28} className="text-muted" />
                    </div>
                    <div className="text-center">
                        <p className="font-bold text-foreground mb-1">Keine Treffer</p>
                        <p className="text-sm text-muted">Keine Artikel für diese Suche oder Kategorie gefunden.</p>
                    </div>
                    <button
                        onClick={() => { setSearchTerm(''); setSelectedCategory('Alle'); }}
                        className="mt-2 px-6 py-2.5 bg-canvas border border-border text-foreground rounded-xl font-bold text-sm hover:bg-border transition-colors duration-150 ease-out"
                    >
                        Filter zurücksetzen
                    </button>
                </div>
            ) : viewMode === 'grid' ? (
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4 overflow-y-auto pr-2 pb-4 scrollbar-hide">
                    {filteredArticles.map((article, idx) => (
                        <ArticleGridCard
                            key={article.id}
                            article={article}
                            idx={idx}
                            isNetPrice={isNetPrice}
                            onEdit={handleOpenForm}
                            onDuplicate={(a) => void handleDuplicate(a)}
                        />
                    ))}
                </div>
            ) : (
                <div className="flex-1 overflow-y-auto pr-2 pb-4 space-y-2 scrollbar-hide">
                    <ArticleListHeader
                        isNetPrice={isNetPrice}
                        hasSelection={selectedArticles.size > 0}
                        onSelectAll={handleSelectAll}
                    />
                    {filteredArticles.map((article, idx) => (
                        <ArticleListRow
                            key={article.id}
                            article={article}
                            idx={idx}
                            isNetPrice={isNetPrice}
                            isSelected={selectedArticles.has(article.id)}
                            onToggleSelect={handleToggleSelect}
                            onEdit={handleOpenForm}
                            onDuplicate={(a) => void handleDuplicate(a)}
                            onDelete={(id) => void handleDelete(id)}
                        />
                    ))}
                </div>
            )}
        </div>

        {/* Slide-over Form */}
        {isFormOpen && (
            <ArticleEditorPanel
                editingArticle={editingArticle}
                formData={formData}
                formErrors={formErrors}
                isSaving={isSaving}
                configuredCategories={configuredCategories}
                onFormDataChange={setFormData}
                onSubmit={() => void handleSubmit()}
                onDelete={(id) => void handleDelete(id)}
                onClose={() => setIsFormOpen(false)}
            />
        )}
    </div>
  );
};
