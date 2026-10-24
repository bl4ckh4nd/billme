import React, { useState, useMemo } from 'react';
import { Search, Plus, Edit3, Trash2, LayoutGrid, List, Check, X, Copy, FileUp } from 'lucide-react';
import type { Article } from '@billme/desktop-core/types';
import { v4 as uuidv4 } from 'uuid';
import { useArticlesQuery, useDeleteArticleMutation, useUpsertArticleMutation } from '../hooks/useArticles';
import { useCreateIntent } from '../hooks/useCreateIntent';
import { useDeferredDelete } from '../hooks/useDeferredDelete';
import { useSettingsQuery } from '../hooks/useSettings';
import {
  Badge, Button, Card, Checkbox, EMPTY_VALUE, EmptyState, ErrorState, IconButton, Input, Modal, PageHeader, SegmentedControl, Select,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea,
} from '@billme/ui';
import { SkeletonLoader } from '../ui/components/SkeletonLoader';
import { useRouterState } from '@tanstack/react-router';
import { CsvImportDialog } from './masterdata/CsvImportDialog';

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
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const locationSearch = useRouterState({ select: (s) => s.location.search }) as Record<string, unknown>;
  const [selectedCategory, setSelectedCategory] = useState<string>('Alle');
  const [isNetPrice, setIsNetPrice] = useState(true); // Toggle Net/Gross
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('list');

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
  const titleInputRef = React.useRef<HTMLInputElement>(null);

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
        setOperationMessage(`Duplizieren fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
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
        setOperationMessage(`Speichern fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setIsSaving(false);
      }
  };

  const banner = operationMessage && (
    <div
      className={`rounded-control border px-3 py-2.5 text-control ${
        operationTone === 'success'
          ? 'border-success-border bg-success-bg text-success-text'
          : 'border-error-border bg-error-bg text-error-text'
      }`}
    >
      {operationMessage}
    </div>
  );

  const emptyState = (
    <Card padding="none">
      <EmptyState
        title={isFiltered ? 'Keine Artikel passen zu dieser Auswahl' : 'Noch keine Artikel angelegt'}
        description={
          isFiltered
            ? `Suche und Kategorie-Filter schließen alle ${visibleArticles.length} vorhandenen Artikel aus.`
            : 'Artikel sind die Positionen, die du in Rechnungen und Angeboten auswählst. Lege den ersten über das + oben rechts an.'
        }
        action={
          isFiltered ? (
            <Button variant="secondary" size="sm" onClick={resetFilters}>
              Filter zurücksetzen
            </Button>
          ) : undefined
        }
      />
    </Card>
  );

  const allSelected = filteredArticles.length > 0 && selectedArticles.size === filteredArticles.length;

  return (
    <div className="flex flex-col">
      {isImportOpen && <CsvImportDialog kind="articles" existing={articles} onClose={() => setIsImportOpen(false)} />}
      <div className="relative">
        <PageHeader
          title="Leistungen"
          description={isLoadingView
            ? 'Wird geladen …'
            : hasQueryError
              ? 'Nicht verfügbar'
              : `${filteredArticles.length} Einträge`}
          actions={
            <>
              <Button variant="secondary" onClick={() => setIsImportOpen(true)}>
                <FileUp size={16} aria-hidden="true" /> Importieren (CSV)
              </Button>
              <Button onClick={() => handleOpenForm()}>
                <Plus size={16} aria-hidden="true" /> Neuer Artikel
              </Button>
            </>
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
              <div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto p-0.5 scrollbar-hide" role="group" aria-label="Kategorie">
                {categories.map(cat => (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setSelectedCategory(cat)}
                    aria-pressed={selectedCategory === cat}
                    className={`shrink-0 whitespace-nowrap rounded-full border px-1.75 py-0.5 text-micro transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                      selectedCategory === cat
                        ? 'border-foreground bg-foreground font-semibold text-ground'
                        : 'border-border bg-surface-sunken font-medium text-foreground-secondary hover:text-foreground'
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

        {selectedArticles.size > 0 && (
          <div className="absolute left-1/2 top-0 z-[var(--z-dropdown)] flex -translate-x-1/2 items-center gap-3 rounded-card border border-border bg-surface py-1 pl-3 pr-1 text-control shadow-lift">
            <span className="font-medium tabular-nums">{selectedArticles.size} ausgewählt</span>
            <Button variant="danger" size="sm" onClick={() => void handleBulkDelete()}>
              <Trash2 size={14} aria-hidden="true" /> Löschen
            </Button>
            <IconButton size="sm" aria-label="Auswahl aufheben" onClick={() => setSelectedArticles(new Set())}>
              <X size={16} aria-hidden="true" />
            </IconButton>
          </div>
        )}
      </div>

      {banner && !isFormOpen && <div className="mb-3">{banner}</div>}

      {isLoadingView ? (
        <SkeletonLoader variant={viewMode === 'grid' ? 'card' : 'table'} count={6} />
      ) : hasQueryError ? (
        <Card padding="none">
          <ErrorState
            title="Artikel konnten nicht geladen werden"
            description="Die Artikel oder die Kategorien aus den Einstellungen sind nicht verfügbar. Es werden bewusst keine Ersatzdaten angezeigt."
            onRetry={retryQueries}
          />
        </Card>
      ) : filteredArticles.length === 0 ? (
        emptyState
      ) : viewMode === 'grid' ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {filteredArticles.map((article) => (
            <div key={article.id} data-leaving={leavingIds.has(article.id) || undefined} className="group">
              <Card className="flex h-full flex-col transition-colors hover:border-control-border-hover">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-caption text-muted">{article.category}</span>
                      {article.taxRate !== 19 && <Badge tone="info">{article.taxRate} % USt</Badge>}
                    </div>
                    <h3 className="mt-1 line-clamp-2 text-sm font-semibold text-foreground">{article.title}</h3>
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

                <div className="mt-auto flex items-baseline justify-between gap-3 pt-4">
                  <span className="text-section font-bold tabular-nums">
                    {formatCurrency(calculateDisplayPrice(article))}
                  </span>
                  <span className="text-caption text-muted">{isNetPrice ? 'netto' : 'brutto'} / {article.unit}</span>
                </div>
              </Card>
            </div>
          ))}
        </div>
      ) : (
        <Table aria-label="Leistungen">
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  aria-label="Alle auswählen"
                  checked={allSelected}
                  indeterminate={selectedArticles.size > 0 && !allSelected}
                  onChange={handleSelectAll}
                />
              </TableHead>
              <TableHead>Nummer</TableHead>
              <TableHead>Bezeichnung</TableHead>
              <TableHead className="hidden xl:table-cell">Beschreibung</TableHead>
              <TableHead className="hidden md:table-cell">Kategorie</TableHead>
              <TableHead>Einheit</TableHead>
              <TableHead numeric>Preis ({isNetPrice ? 'Netto' : 'Brutto'})</TableHead>
              <TableHead>USt</TableHead>
              <TableHead className="w-28"><span className="sr-only">Aktionen</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filteredArticles.map((article) => (
              <TableRow
                key={article.id}
                data-leaving={leavingIds.has(article.id) || undefined}
                selected={selectedArticles.has(article.id)}
              >
                <TableCell>
                  <Checkbox
                    aria-label={`${article.title} auswählen`}
                    checked={selectedArticles.has(article.id)}
                    onChange={() => handleToggleSelect(article.id)}
                  />
                </TableCell>
                <TableCell className="font-mono font-semibold">
                  {article.sku || <span className="font-normal text-muted">{EMPTY_VALUE}</span>}
                </TableCell>
                <TableCell className="font-medium">{article.title}</TableCell>
                <TableCell muted className="hidden max-w-64 truncate xl:table-cell">{article.description || EMPTY_VALUE}</TableCell>
                <TableCell className="hidden md:table-cell"><Badge tone="neutral">{article.category}</Badge></TableCell>
                <TableCell>{article.unit}</TableCell>
                <TableCell numeric>{formatCurrency(calculateDisplayPrice(article))}</TableCell>
                <TableCell className="tabular-nums">{article.taxRate} %</TableCell>
                <TableCell className="py-0.5">
                  <div className="ui-reveal flex items-center justify-end gap-0.5">
                    <IconButton size="sm" tooltip="Duplizieren" aria-label={`${article.title} duplizieren`} onClick={() => void handleDuplicate(article)}>
                      <Copy size={14} aria-hidden="true" />
                    </IconButton>
                    <IconButton size="sm" tooltip="Bearbeiten" aria-label={`${article.title} bearbeiten`} onClick={() => handleOpenForm(article)}>
                      <Edit3 size={14} aria-hidden="true" />
                    </IconButton>
                    <IconButton size="sm" tooltip="Löschen" aria-label={`${article.title} löschen`} onClick={() => void handleDelete(article.id)}>
                      <Trash2 size={14} aria-hidden="true" />
                    </IconButton>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Modal
        open={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        titleId="articlesview-form-title"
        initialFocusRef={titleInputRef}
      >
        <div className="flex items-start gap-3 px-4.5 pb-2.5 pt-4">
          <div className="min-w-0 flex-1">
            <h2 id="articlesview-form-title" className="text-title text-foreground">{editingArticle ? 'Artikel bearbeiten' : 'Neuer Artikel'}</h2>
            <p className="text-caption text-muted">
              {editingArticle ? `ID: ${editingArticle.id.substring(0,8)}` : 'Neuer Eintrag wird erstellt'}
            </p>
          </div>
          <IconButton size="sm" aria-label="Schließen" onClick={() => setIsFormOpen(false)}>
            <X size={16} aria-hidden="true" />
          </IconButton>
        </div>

        <div className="flex flex-col gap-3 px-4.5 pb-4 pt-1">
          {operationTone === 'error' && banner}
          <div className="flex gap-3">
            <div className="min-w-0 flex-1">
              <Input
                ref={titleInputRef}
                id="articlesview-bezeichnung"
                label="Bezeichnung"
                required
                value={formData.title}
                onChange={(e) => setFormData({...formData, title: e.target.value})}
                placeholder="z.B. Webdesign"
                error={formErrors.title}
                fullWidth
              />
            </div>
            <div className="w-1/3">
              <Input
                id="articlesview-artikel-nr"
                label="Artikel-Nr."
                value={formData.sku}
                onChange={(e) => setFormData({...formData, sku: e.target.value})}
                placeholder="SKU-001"
                error={formErrors.sku}
                className="font-mono"
                fullWidth
              />
            </div>
          </div>

          <Select
            id="articlesview-kategorie"
            label="Kategorie"
            value={formData.category}
            onChange={(e) => setFormData({...formData, category: e.target.value})}
            error={formErrors.category}
            fullWidth
          >
            {configuredCategories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>

          <h3 className="mt-1 text-eyebrow uppercase text-muted">Preise & Steuer</h3>
          <div className="grid grid-cols-2 gap-3">
            <Input
              id="articlesview-preis"
              type="number"
              step="0.01"
              label="Preis (Netto)"
              required
              value={formData.price}
              onChange={(e) => setFormData({...formData, price: Number(e.target.value)})}
              suffix="EUR"
              error={formErrors.price}
              className={`tabular-nums ${Number(formData.price) < 0 ? 'border-error text-error-text' : ''}`}
              fullWidth
            />
            <Select
              id="articlesview-einheit"
              label="Einheit"
              value={formData.unit}
              onChange={(e) => setFormData({...formData, unit: e.target.value})}
              error={formErrors.unit}
              fullWidth
            >
              <option value="Std">Stunde</option>
              <option value="Stk">Stück</option>
              <option value="Pauschale">Pauschale</option>
              <option value="Tag">Tag</option>
              <option value="Monat">Monat</option>
              <option value="km">Kilometer</option>
            </Select>
          </div>

          <div>
            <p className="mb-1 text-caption font-medium text-foreground-secondary" id="articlesview-ust">Umsatzsteuer (USt)</p>
            <div role="group" aria-labelledby="articlesview-ust" className="inline-flex gap-0.5 rounded-control border border-border bg-surface-sunken p-0.5">
              {[19, 7, 0].map((rate) => (
                <button
                  key={rate}
                  type="button"
                  aria-pressed={formData.taxRate === rate}
                  onClick={() => setFormData({...formData, taxRate: rate})}
                  className={`h-6.5 rounded-sm px-2.5 text-caption tabular-nums transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                    formData.taxRate === rate
                      ? 'bg-surface font-semibold text-foreground shadow-thumb'
                      : 'font-medium text-muted hover:text-foreground'
                  }`}
                >
                  {rate}%
                </button>
              ))}
            </div>
            {formErrors.taxRate && <p className="mt-1 text-caption text-error-text">{formErrors.taxRate}</p>}
          </div>

          <Textarea
            id="articlesview-beschreibung"
            label="Beschreibung"
            rows={4}
            value={formData.description}
            onChange={(e) => setFormData({...formData, description: e.target.value})}
            placeholder="Details zum Produkt..."
            hint="Wird auf der Rechnung unter dem Titel angezeigt."
            fullWidth
          />
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4.5 py-3">
          {editingArticle && (
            <Button variant="danger" className="mr-auto" aria-label="Artikel löschen" onClick={() => void handleDelete(editingArticle.id)}>
              <Trash2 size={16} aria-hidden="true" /> Löschen
            </Button>
          )}
          <Button onClick={() => void handleSubmit()} disabled={isSaving}>
            <Check size={16} aria-hidden="true" />
            {isSaving ? 'Speichere...' : editingArticle ? 'Speichern' : 'Erstellen'}
          </Button>
        </div>
      </Modal>
    </div>
  );
};
