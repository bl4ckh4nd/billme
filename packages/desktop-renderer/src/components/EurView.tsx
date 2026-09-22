import React from 'react';
import { Button, EMPTY_VALUE, EmptyState, ErrorState, useActionFeedback } from '@billme/ui';
import { LATEST_SUPPORTED_EUR_TAX_YEAR, SUPPORTED_EUR_TAX_YEARS } from '@billme/accounting-shared';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Download,
  ReceiptText,
  CheckCircle2,
  AlertCircle,
  XCircle,
  Search,
  Check,
  RotateCcw,
  Save,
  Ban,
  TrendingUp,
  TrendingDown,
  Layers,
  ClipboardList,
  Tags,
  Settings2,
} from 'lucide-react';
import { getRendererProduct, getRendererRuntime, ipc } from '../runtime-api';
import { Spinner } from '@billme/desktop-ui/components/Spinner';
import { EurRulesModal } from './EurRulesModal';

const DEFAULT_YEAR = LATEST_SUPPORTED_EUR_TAX_YEAR;

type SourceType = 'transaction' | 'invoice';
type VatMode = 'none' | 'default';
type QueueStatus = 'all' | 'unclassified' | 'classified' | 'excluded';
type QueueSort = 'date_desc' | 'amount_desc' | 'counterparty_asc';

type SuggestionLayer = 'rule' | 'counterparty' | 'bayes' | 'keyword';

type EurItem = {
  sourceType: SourceType;
  sourceId: string;
  date: string;
  amountGross: number;
  amountNet: number;
  flowType: 'income' | 'expense';
  counterparty: string;
  purpose: string;
  vatWarning?: string;
  suggestedLineId?: string;
  suggestionReason?: string;
  suggestionLayer?: SuggestionLayer;
  classification?: {
    eurLineId?: string;
    excluded: boolean;
    vatMode: VatMode;
    vatRate?: number;
    note?: string;
    updatedAt: string;
  };
  line?: {
    lineId?: string;
    id?: string;
    kennziffer?: string;
    label: string;
  };
};

const LAYER_LABELS: Record<SuggestionLayer, string> = {
  rule: 'Regel',
  counterparty: 'Gemerkt',
  bayes: 'KI',
  keyword: 'Stichwort',
};

const LAYER_COLORS: Record<SuggestionLayer, string> = {
  rule: 'border border-border bg-surface-muted text-foreground',
  counterparty: 'border border-success-border bg-success-bg text-success-text',
  bayes: 'border border-info-border bg-info-bg text-info-text',
  keyword: 'border border-warning-border bg-warning-bg text-warning-text',
};

type UndoChange = {
  sourceType: SourceType;
  sourceId: string;
  taxYear: number;
  prevLineId?: string;
  prevExcluded: boolean;
  prevVatMode: VatMode;
  prevVatRate?: number;
};

type EurUndo = { label: string; reason: string; changes: UndoChange[] };

const formatCurrency = (amount: number): string =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);

const triggerCsvDownload = (content: string, fileName: string): void => {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

const itemKey = (item: { sourceType: SourceType; sourceId: string }): string =>
  `${item.sourceType}:${item.sourceId}`;

const queryErrorDetail = (error: unknown): string =>
  error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'Unbekannter Fehler beim Laden.';

export const EurView: React.FC = () => {
  const isProProduct = getRendererProduct() === 'pro';
  const isWebShell = getRendererRuntime().shell === 'web';
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [taxYear, setTaxYear] = React.useState<number>(DEFAULT_YEAR);
  const [activeSource, setActiveSource] = React.useState<{ sourceType: SourceType; sourceId: string } | null>(null);
  const [selectedLineId, setSelectedLineId] = React.useState<string>('');
  const [vatMode, setVatMode] = React.useState<VatMode>('none');
  const [vatRate, setVatRate] = React.useState<number | undefined>(undefined);
  const [excluded, setExcluded] = React.useState<boolean>(false);
  const [taxNote, setTaxNote] = React.useState('');
  const [auditReason, setAuditReason] = React.useState('');

  const [query, setQuery] = React.useState('');
  const [queueStatus, setQueueStatus] = React.useState<QueueStatus>('unclassified');
  const [flowFilter, setFlowFilter] = React.useState<'all' | 'income' | 'expense'>('all');
  const [queueSort, setQueueSort] = React.useState<QueueSort>('date_desc');
  const [selectedKeys, setSelectedKeys] = React.useState<Set<string>>(new Set());
  const [isApplying, setIsApplying] = React.useState(false);
  const [lastUndo, setLastUndo] = React.useState<EurUndo | null>(null);

  const [showRulesModal, setShowRulesModal] = React.useState(false);
  const { notify } = useActionFeedback('eur');

  const showNotification = (message: string, type: 'success' | 'error' | 'warning' | 'info' = 'success') => {
    notify(type === 'warning' ? 'info' : type, message);
  };

  const {
    data: report,
    isLoading: reportLoading,
    isError: reportIsError,
    error: reportQueryError,
    refetch: refetchReport,
  } = useQuery({
    queryKey: ['eur', 'report', taxYear],
    queryFn: () => ipc.eur.getReport({ taxYear }),
  });

  const {
    data: items = [],
    isLoading: itemsLoading,
    isError: itemsIsError,
    error: itemsQueryError,
    refetch: refetchItems,
  } = useQuery({
    queryKey: ['eur', 'items', taxYear],
    queryFn: () => ipc.eur.listItems({ taxYear }),
  });

  const upsertClassification = useMutation({
    mutationFn: (payload: {
      sourceType: SourceType;
      sourceId: string;
      taxYear: number;
      eurLineId?: string;
      excluded?: boolean;
      vatMode?: VatMode;
      vatRate?: number;
      note?: string;
      reason: string;
    }) => ipc.eur.upsertClassification(payload),
  });

  const invalidateEur = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['eur', 'items', taxYear] }),
      queryClient.invalidateQueries({ queryKey: ['eur', 'report', taxYear] }),
    ]);
  };

  const exportCsv = async () => {
    const csv = await ipc.eur.exportCsv({ taxYear });
    triggerCsvDownload(csv, `anlage-euer-${taxYear}.csv`);
  };

  const [isPdfExporting, setIsPdfExporting] = React.useState(false);
  const exportPdf = async () => {
    setIsPdfExporting(true);
    try {
      const res = await ipc.eur.exportPdf({ taxYear });
      showNotification(`PDF gespeichert: ${res.path}`, 'success');
    } catch {
      showNotification('PDF-Export fehlgeschlagen', 'error');
    } finally {
      setIsPdfExporting(false);
    }
  };

  const lineOptions = React.useMemo(
    () => (report?.rows ?? []).filter((line) => line.kind === 'income' || line.kind === 'expense'),
    [report],
  );

  const activeItem = React.useMemo(
    () => (items as EurItem[]).find((item) => item.sourceType === activeSource?.sourceType && item.sourceId === activeSource?.sourceId),
    [items, activeSource],
  );

  const activeLineOptions = React.useMemo(() => {
    if (!activeItem) return lineOptions;
    return lineOptions.filter((line) => line.kind === activeItem.flowType);
  }, [activeItem, lineOptions]);

  const queueItems = React.useMemo(() => {
    const base = (items as EurItem[]).filter((item) => {
      const statusMatch =
        queueStatus === 'all'
          ? true
          : queueStatus === 'unclassified'
            ? !item.classification?.eurLineId && !item.classification?.excluded
            : queueStatus === 'classified'
              ? Boolean(item.classification?.eurLineId) && !item.classification?.excluded
              : Boolean(item.classification?.excluded);
      const flowMatch = flowFilter === 'all' || item.flowType === flowFilter;
      const needle = query.trim().toLowerCase();
      const searchMatch =
        needle.length === 0 ||
        item.counterparty.toLowerCase().includes(needle) ||
        item.purpose.toLowerCase().includes(needle) ||
        item.date.includes(needle);
      return statusMatch && flowMatch && searchMatch;
    });

    const sorted = [...base];
    sorted.sort((a, b) => {
      if (queueSort === 'date_desc') return b.date.localeCompare(a.date);
      if (queueSort === 'amount_desc') return b.amountGross - a.amountGross;
      return a.counterparty.localeCompare(b.counterparty, 'de');
    });
    return sorted;
  }, [items, queueStatus, flowFilter, query, queueSort]);

  const selectedItems = React.useMemo(
    () => queueItems.filter((item) => selectedKeys.has(itemKey(item))),
    [queueItems, selectedKeys],
  );

  const statusCounts = React.useMemo(() => {
    const all = (items as EurItem[]);
    return {
      all: all.length,
      unclassified: all.filter((item) => !item.classification?.eurLineId && !item.classification?.excluded).length,
      classified: all.filter((item) => item.classification?.eurLineId && !item.classification?.excluded).length,
      excluded: all.filter((item) => item.classification?.excluded).length,
    };
  }, [items]);

  React.useEffect(() => {
    if (!activeItem) return;
    setSelectedLineId(activeItem.classification?.eurLineId ?? activeItem.suggestedLineId ?? '');
    setVatMode(activeItem.classification?.vatMode ?? 'none');
    setVatRate(activeItem.classification?.vatRate);
    setExcluded(activeItem.classification?.excluded ?? false);
    setTaxNote(activeItem.classification?.note ?? '');
  }, [activeItem]);

  const applyBulk = async (
    label: string,
    resolver: (item: EurItem) => { eurLineId?: string; excluded?: boolean; vatMode?: VatMode; vatRate?: number },
  ) => {
    if (selectedItems.length === 0) return;
    const reason = auditReason.trim();
    if (!reason) {
      showNotification('Bitte eine Begründung für den Audit-Eintrag eingeben.', 'warning');
      return;
    }

    const changes: UndoChange[] = selectedItems.map((item) => ({
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      taxYear,
      prevLineId: item.classification?.eurLineId,
      prevExcluded: item.classification?.excluded ?? false,
      prevVatMode: item.classification?.vatMode ?? 'none',
      prevVatRate: item.classification?.vatRate,
    }));

    setIsApplying(true);
    try {
      await Promise.all(
        selectedItems.map((item) => {
          const resolved = resolver(item);
          return upsertClassification.mutateAsync({
            sourceType: item.sourceType,
            sourceId: item.sourceId,
            taxYear,
            ...resolved,
            vatRate: isProProduct ? resolved.vatRate : undefined,
            reason,
          });
        }),
      );
      setLastUndo({ label, reason, changes });
      setSelectedKeys(new Set());
      await invalidateEur();
      showNotification(`${selectedItems.length} Einträge klassifiziert`, 'success');
    } finally {
      setIsApplying(false);
    }
  };

  const applySingle = async () => {
    if (!activeItem) return;
    const reason = auditReason.trim();
    if (!reason) {
      showNotification('Bitte eine Begründung für den Audit-Eintrag eingeben.', 'warning');
      return;
    }

    const changes: UndoChange[] = [
      {
        sourceType: activeItem.sourceType,
        sourceId: activeItem.sourceId,
        taxYear,
        prevLineId: activeItem.classification?.eurLineId,
        prevExcluded: activeItem.classification?.excluded ?? false,
        prevVatMode: activeItem.classification?.vatMode ?? 'none',
        prevVatRate: activeItem.classification?.vatRate,
      },
    ];

    setIsApplying(true);
    try {
      await upsertClassification.mutateAsync({
        sourceType: activeItem.sourceType,
        sourceId: activeItem.sourceId,
        taxYear,
        eurLineId: selectedLineId || undefined,
        excluded,
        vatMode,
        vatRate: isProProduct ? vatRate : undefined,
        note: taxNote.trim() || undefined,
        reason,
      });
      setLastUndo({ label: 'Einzelklassifizierung', reason, changes });
      await invalidateEur();
      showNotification('Klassifizierung gespeichert', 'success');
    } finally {
      setIsApplying(false);
    }
  };

  const undoLast = async () => {
    if (!lastUndo) return;
    setIsApplying(true);
    try {
      await Promise.all(
        lastUndo.changes.map((change) =>
          upsertClassification.mutateAsync({
            sourceType: change.sourceType,
            sourceId: change.sourceId,
            taxYear: change.taxYear,
            eurLineId: change.prevLineId,
            excluded: change.prevExcluded,
            vatMode: change.prevVatMode,
            vatRate: isProProduct ? change.prevVatRate : undefined,
            reason: `Undo: ${lastUndo.label}; ursprüngliche Begründung: ${lastUndo.reason}`,
          }),
        ),
      );
      await invalidateEur();
      setLastUndo(null);
      showNotification('Letzte Aktion rückgängig gemacht', 'info');
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <div className="bg-surface rounded-2xl p-6 min-h-full shadow-sm">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate({ to: '/finance' })}
            aria-label="Zurück zu Finanzen"
            className="rounded-lg p-2 text-muted transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
          <div className="w-12 h-12 rounded-xl bg-dark-base text-accent flex items-center justify-center">
            <ReceiptText size={22} />
          </div>
          <div>
            <h2 className="text-2xl font-black text-foreground">Anlage EÜR</h2>
            <p className="text-sm text-muted mt-1">Klassifizierung und Auswertung für Steuerjahr {taxYear}.</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <select
            value={taxYear}
            aria-label="Steuerjahr"
            onChange={(e) => setTaxYear(Number(e.target.value))}
            className="rounded-xl border border-control-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            {SUPPORTED_EUR_TAX_YEARS.map((year) => (
              <option key={year} value={year}>{year}</option>
            ))}
          </select>
          {!isWebShell && (
            <Button variant="secondary" size="sm" onClick={() => setShowRulesModal(true)}>
              <Settings2 size={16} />
              Regeln
            </Button>
          )}
          <Button variant="dark" size="sm" onClick={() => void exportCsv()}>
            <Download size={16} />
            CSV exportieren
          </Button>
          {!isWebShell && (
            <Button variant="dark" size="sm" onClick={() => void exportPdf()} disabled={isPdfExporting}>
              <Download size={16} />
              {isPdfExporting ? 'PDF...' : 'PDF exportieren'}
            </Button>
          )}
        </div>
      </div>

      {/* Undo Banner */}
      {lastUndo && (
        <div className="mb-4 rounded-2xl border border-warning-border bg-warning-bg p-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-warning-text">
            <RotateCcw size={16} className="flex-shrink-0" />
            <span>Aktion gespeichert: <span className="font-semibold">{lastUndo.label}</span></span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void undoLast()}
            disabled={isApplying}
          >
            <RotateCcw size={14} />
            Rückgängig
          </Button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Queue Panel */}
        <div className="rounded-2xl border border-border p-4 lg:col-span-1">
          <h3 className="font-bold text-foreground mb-3 flex items-center gap-2">
            <ClipboardList size={18} className="text-muted" />
            Warteschlange
            <span className="text-xs font-normal text-muted ml-auto tabular-nums">{queueItems.length} Einträge</span>
          </h3>

          {/* Filter Tabs */}
          <div className="rounded-lg border border-border p-1 bg-surface-muted mb-3">
            <div className="grid grid-cols-2 gap-1 text-xs">
              {([
                ['unclassified', 'Offen', statusCounts.unclassified],
                ['classified', 'Klassifiziert', statusCounts.classified],
                ['excluded', 'Ausgeschl.', statusCounts.excluded],
                ['all', 'Alle', statusCounts.all],
              ] as Array<[QueueStatus, string, number]>).map(([status, label, count]) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => setQueueStatus(status)}
                  aria-pressed={queueStatus === status}
                  className={`rounded-md px-2 py-1.5 font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                    queueStatus === status
                      ? 'bg-surface shadow-sm font-semibold text-foreground'
                      : 'text-muted hover:text-foreground'
                  }`}
                >
                  {label} ({count})
                </button>
              ))}
            </div>
          </div>

          {/* Search */}
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={16} />
            <input
              value={query}
              aria-label="Einträge durchsuchen"
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Gegenpartei, Zweck oder Datum..."
 className="w-full pl-9 pr-3 py-2 rounded-xl border border-control-border bg-surface text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            />
          </div>

          {/* Flow & Sort Filters */}
          <div className="grid grid-cols-2 gap-2 mb-3">
            <select
              value={flowFilter}
              aria-label="Zahlungsrichtung filtern"
              onChange={(e) => setFlowFilter(e.target.value as 'all' | 'income' | 'expense')}
              className="rounded-xl border border-control-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              <option value="all">Alle Typen</option>
              <option value="income">Einnahmen</option>
              <option value="expense">Ausgaben</option>
            </select>
            <select
              value={queueSort}
              aria-label="Einträge sortieren"
              onChange={(e) => setQueueSort(e.target.value as QueueSort)}
              className="rounded-xl border border-control-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              <option value="date_desc">Neueste zuerst</option>
              <option value="amount_desc">Betrag absteigend</option>
              <option value="counterparty_asc">Name A-Z</option>
            </select>
          </div>

          {/* Bulk Actions */}
          <div className="mb-3 rounded-xl border border-border bg-surface-muted p-3">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-bold text-foreground flex items-center gap-2">
                <input
                  type="checkbox"
                  className="h-6 w-6 accent-black"
                  checked={queueItems.length > 0 && selectedItems.length === queueItems.length}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedKeys(new Set(queueItems.map((item) => itemKey(item))));
                    } else {
                      setSelectedKeys(new Set());
                    }
                  }}
                />
                <span className="tabular-nums">{selectedItems.length}</span> ausgewählt
              </label>
              <button
                type="button"
                onClick={() => setSelectedKeys(new Set())}
                className="min-h-6 rounded-sm px-2 text-xs text-muted transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              >
                Auswahl löschen
              </button>
            </div>
            <div className="grid grid-cols-1 gap-1.5">
              <label className="text-xs font-bold text-foreground">
                Begründung (Audit) <span className="text-error-text">*</span>
                <input
                  aria-label="Begründung für EÜR-Änderung"
                  value={auditReason}
                  onChange={(event) => setAuditReason(event.target.value)}
                  className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm"
                  placeholder="z. B. Beleg geprüft und Kontierung bestätigt"
                />
              </label>
              <button
                onClick={() =>
                  void applyBulk('Bulk: Vorschlag anwenden', (item) => ({
                    eurLineId: item.suggestedLineId,
                    excluded: false,
                    vatMode: item.classification?.vatMode ?? 'none',
                    vatRate: item.classification?.vatRate,
                  }))
                }
                disabled={selectedItems.length === 0 || isApplying || auditReason.trim().length === 0}
                className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-left text-foreground transition-colors hover:bg-surface-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              >
                <Check size={14} className="text-info-text flex-shrink-0" aria-hidden="true" />
                Vorschlag anwenden
              </button>
              <button
                onClick={() =>
                  void applyBulk('Bulk: Als privat/Transfer markieren', () => ({
                    eurLineId: undefined,
                    excluded: true,
                    vatMode: 'none',
                    vatRate: undefined,
                  }))
                }
                disabled={selectedItems.length === 0 || isApplying || auditReason.trim().length === 0}
                className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-left text-foreground transition-colors hover:bg-surface-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              >
                <Ban size={14} className="text-error-text flex-shrink-0" />
                Als privat/Transfer markieren
              </button>
              <button
                onClick={() =>
                  void applyBulk('Bulk: Klassifizierung zurücksetzen', () => ({
                    eurLineId: undefined,
                    excluded: false,
                    vatMode: 'none',
                    vatRate: undefined,
                  }))
                }
                disabled={selectedItems.length === 0 || isApplying || auditReason.trim().length === 0}
                className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-left text-foreground transition-colors hover:bg-surface-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              >
                <RotateCcw size={14} className="text-muted flex-shrink-0" />
                Klassifizierung zurücksetzen
              </button>
            </div>
          </div>

          {/* Queue Items */}
          {itemsIsError ? (
            <ErrorState
              title="Einträge konnten nicht geladen werden"
              description={queryErrorDetail(itemsQueryError)}
              onRetry={() => void refetchItems()}
            />
          ) : itemsLoading ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Spinner size="md" />
              <p className="text-sm text-muted mt-3">Lade Einträge …</p>
            </div>
          ) : queueItems.length === 0 ? (
            <EmptyState
              title={queueStatus === 'unclassified' && statusCounts.unclassified === 0
                ? 'Alle Einträge sind klassifiziert'
                : 'Keine Einträge für diesen Filter'}
              description={queueStatus === 'unclassified' && statusCounts.unclassified === 0
                ? 'Für dieses Steuerjahr ist nichts mehr offen. Der Report links zeigt die Summen.'
                : 'Wähle einen anderen Status oder leere die Suche, um weitere Einträge zu sehen.'}
              className="border-0 bg-transparent"
            />
          ) : (
            <div className="space-y-2 max-h-[460px] overflow-auto pr-1">
              {queueItems.map((item) => {
                const key = itemKey(item);
                const isActive = activeSource?.sourceType === item.sourceType && activeSource.sourceId === item.sourceId;
                return (
                  <div
                    key={key}
                    className={`w-full text-left p-3 rounded-xl border transition-colors ${
                      isActive ? 'border-foreground bg-surface-muted' : 'border-border hover:border-control-border'
                    }`}
                  >
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1 h-6 w-6 accent-black"
                        aria-label={`${item.counterparty} auswählen`}
                        checked={selectedKeys.has(key)}
                        onChange={(e) => {
                          const next = new Set(selectedKeys);
                          if (e.target.checked) next.add(key);
                          else next.delete(key);
                          setSelectedKeys(next);
                        }}
                      />
                      <button
                        onClick={() => setActiveSource({ sourceType: item.sourceType, sourceId: item.sourceId })}
                        className="flex-1 text-left"
                      >
                        <div className="flex items-center gap-1.5 text-xs text-muted">
                          {item.classification?.excluded ? (
                            <XCircle size={14} className="text-error-text" />
                          ) : item.classification?.eurLineId ? (
                            <CheckCircle2 size={14} className="text-success-text" />
                          ) : (
                            <AlertCircle size={14} className="text-warning-text" />
                          )}
                          <span>{item.date}</span>
                          <span className="text-muted">|</span>
                          <span>{item.sourceType === 'transaction' ? 'Bank' : 'Rechnung'}</span>
                        </div>
                        <div className="text-sm font-semibold text-foreground truncate">{item.counterparty}</div>
                        <div className="text-xs text-muted truncate">{item.purpose}</div>
                        <div className={`text-sm font-bold tabular-nums mt-1 ${
                          item.flowType === 'income' ? 'text-success-text' : 'text-error-text'
                        }`}>
                          {item.flowType === 'income' ? '+' : '-'}{formatCurrency(item.amountGross)}
                        </div>
                        <div className="flex flex-wrap gap-1 mt-2 text-xs">
                          {item.classification?.excluded ? (
                            <span className="px-2 py-0.5 rounded-full bg-error-bg text-error-text">Ausgeschlossen</span>
                          ) : item.classification?.eurLineId ? (
                            <span className="px-2 py-0.5 rounded-full bg-success-bg text-success-text">Klassifiziert</span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full bg-warning-bg text-warning-text">Offen</span>
                          )}
                          {item.flowType === 'income' ? (
                            <span className="px-2 py-0.5 rounded-full bg-success-bg text-success-text">Einnahme</span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full bg-error-bg text-error-text">Ausgabe</span>
                          )}
                          {item.suggestionLayer && !item.classification?.eurLineId && !item.classification?.excluded && (
                            <span className={`px-2 py-0.5 rounded-full ${LAYER_COLORS[item.suggestionLayer]}`}>
                              {LAYER_LABELS[item.suggestionLayer]}
                            </span>
                          )}
                        </div>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Classification Panel */}
        <div className="rounded-2xl border border-border p-4 lg:col-span-1">
          <h3 className="font-bold text-foreground mb-3 flex items-center gap-2">
            <Tags size={18} className="text-muted" />
            Klassifizierung
          </h3>
          {!activeItem ? (
            <EmptyState
              title="Kein Eintrag ausgewählt"
              description="Wähle links einen Eintrag aus, um ihn einer EÜR-Kennziffer zuzuordnen."
              className="border-0 bg-transparent"
            />
          ) : (
            <div className="space-y-3">
              {/* Active Item Summary Card */}
              <div className="rounded-xl border border-border bg-surface-muted p-3">
                <div className="flex items-center gap-2 mb-1">
                  {activeItem.flowType === 'income' ? (
                    <TrendingUp size={16} className="text-success-text" />
                  ) : (
                    <TrendingDown size={16} className="text-error-text" />
                  )}
                  <span className="text-sm font-bold text-foreground truncate">{activeItem.counterparty}</span>
                </div>
                <div className="text-xs text-muted truncate">{activeItem.purpose}</div>
                <div className={`text-sm font-bold tabular-nums mt-1 ${
                  activeItem.flowType === 'income' ? 'text-success-text' : 'text-error-text'
                }`}>
                  {formatCurrency(activeItem.amountGross)}
                </div>
                <div className="text-xs text-muted mt-1">
                  {activeItem.classification?.updatedAt
                    ? `Zuletzt: ${new Date(activeItem.classification.updatedAt).toLocaleString('de-DE')}`
                    : 'Noch nicht klassifiziert'}
                </div>
              </div>

              {/* Suggestion Button */}
              {activeItem.suggestedLineId && (
                <button
                  onClick={() => {
                    setSelectedLineId(activeItem.suggestedLineId!);
                    setExcluded(false);
                  }}
                  className="w-full rounded-xl border border-info-border bg-info-bg px-3 py-2.5 text-left hover:bg-info-bg transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <Check size={16} className="text-info-text flex-shrink-0" aria-hidden="true" />
                    <div className="flex-1">
                      <div className="text-xs text-info-text font-semibold flex items-center gap-2">
                        Vorschlag übernehmen
                        {activeItem.suggestionLayer && (
                          <span className={`px-1.5 py-0.5 rounded-full text-xs ${LAYER_COLORS[activeItem.suggestionLayer]}`}>
                            {LAYER_LABELS[activeItem.suggestionLayer]}
                          </span>
                        )}
                      </div>
                      {activeItem.suggestionReason && (
                        <div className="text-xs text-info-text">{activeItem.suggestionReason}</div>
                      )}
                    </div>
                  </div>
                </button>
              )}

              {/* Kennziffer Select */}
              <div>
                <label className="block text-xs font-bold text-foreground" htmlFor="eur-line">Kennziffer</label>
                <select
                  id="eur-line"
                  value={selectedLineId}
                  onChange={(e) => setSelectedLineId(e.target.value)}
                  disabled={excluded}
                  className="mt-1 w-full rounded-xl border border-control-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                >
                  <option value="">Nicht zugeordnet</option>
                  {activeLineOptions.map((line) => (
                    <option key={line.lineId} value={line.lineId}>
                      {line.kennziffer ? `${line.kennziffer} - ` : ''}{line.label}
                    </option>
                  ))}
                </select>
              </div>

              <label className="block text-xs font-bold text-foreground">Steuerliche Korrektur / Begründung
                <input aria-label="Steuerliche Korrektur" value={taxNote} onChange={(event) => setTaxNote(event.target.value)} className="mt-1 w-full rounded-xl border border-control-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring" placeholder="z. B. privater Anteil" />
              </label>

              <label className="block text-xs font-bold text-foreground">
                Begründung (Audit) <span className="text-error-text">*</span>
                <input
                  aria-label="Begründung für EÜR-Änderung"
                  value={auditReason}
                  onChange={(event) => setAuditReason(event.target.value)}
                  className="mt-1 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm"
                  placeholder="z. B. Beleg geprüft und Kontierung bestätigt"
                />
              </label>

              {/* VAT Mode Select */}
              <div>
                <label className="block text-xs font-bold text-foreground" htmlFor="eur-vat-mode">USt. Modus</label>
                <select
                  id="eur-vat-mode"
                  value={vatMode}
                  onChange={(e) => setVatMode(e.target.value as VatMode)}
                  className="mt-1 w-full rounded-xl border border-control-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                >
                  <option value="none">Keine USt. Umrechnung</option>
                  <option value="default">Default USt. (Netto)</option>
                </select>
              </div>

              {isProProduct && vatMode === 'default' && (
                <div>
                  <label className="block text-xs font-bold text-foreground" htmlFor="eur-vat-rate">USt.-Satz (%)</label>
                  <input
                    id="eur-vat-rate"
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={vatRate ?? ''}
                    onChange={(e) => setVatRate(e.target.value === '' ? undefined : Number(e.target.value))}
                    className="mt-1 w-full rounded-xl border border-control-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    placeholder="z. B. 19"
                  />
                  {activeItem.vatWarning && <p className="mt-1 text-xs text-warning-text">{activeItem.vatWarning}</p>}
                </div>
              )}

              {/* Excluded Checkbox */}
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  className="h-6 w-6 accent-black"
                  checked={excluded}
                  onChange={(e) => setExcluded(e.target.checked)}
                />
                Privat/Transfer ausschließen
              </label>

              {/* Action Buttons */}
              <div className="flex items-center gap-2">
                <Button onClick={() => void applySingle()} disabled={isApplying || auditReason.trim().length === 0} fullWidth>
                  <Save size={16} />
                  {isApplying ? 'Speichern...' : 'Klassifizierung speichern'}
                </Button>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setSelectedLineId('');
                  setExcluded(false);
                  setVatMode('none');
                }}
              >
                Zurücksetzen
              </Button>
            </div>
          )}
        </div>

        {/* Report Panel */}
        <div className="rounded-2xl border border-border p-4 lg:col-span-1">
          <h3 className="font-bold text-foreground mb-3 flex items-center gap-2">
            <Layers size={18} className="text-muted" />
            Report
          </h3>
          {reportIsError ? (
            <ErrorState
              title="Report konnte nicht geladen werden"
              description={queryErrorDetail(reportQueryError)}
              onRetry={() => void refetchReport()}
            />
          ) : reportLoading ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Spinner size="md" />
              <p className="text-sm text-muted mt-3">Report wird geladen …</p>
            </div>
          ) : !report ? (
            <EmptyState
              title="Für dieses Steuerjahr liegt noch kein Report vor"
              description="Sobald Buchungen importiert oder Rechnungen gestellt sind, entsteht hier die Auswertung."
              className="border-0 bg-transparent"
            />
          ) : (
            <>
              {/* Summary Stat Cards */}
              <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-xl bg-success-bg border border-success-border p-3">
                  <div className="text-xs font-bold uppercase tracking-wider text-success-text">Einnahmen</div>
                  <div className="text-lg font-bold tabular-nums text-success-text mt-1">{formatCurrency(report.summary.incomeTotal)}</div>
                </div>
                <div className="rounded-xl bg-error-bg border border-error-border p-3">
                  <div className="text-xs font-bold uppercase tracking-wider text-error-text">Ausgaben</div>
                  <div className="text-lg font-bold tabular-nums text-error-text mt-1">{formatCurrency(report.summary.expenseTotal)}</div>
                </div>
                <div className="rounded-xl bg-surface-muted border border-border p-3">
                  <div className="text-xs font-bold uppercase tracking-wider text-muted">Überschuss</div>
                  <div className={`text-lg font-bold tabular-nums mt-1 ${report.summary.surplus >= 0 ? 'text-success-text' : 'text-error-text'}`}>
                    {formatCurrency(report.summary.surplus)}
                  </div>
                </div>
                <div className="rounded-xl bg-warning-bg border border-warning-border p-3">
                  <div className="text-xs font-bold uppercase tracking-wider text-warning-text">Unklassifiziert</div>
                  <div className="text-lg font-bold tabular-nums text-warning-text mt-1">{report.unclassifiedCount}</div>
                </div>
              </div>

              {/* Report Table */}
              <div className="max-h-[470px] overflow-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted border-b border-border">
                      <th className="py-2 pr-2 font-semibold">Kz</th>
                      <th className="py-2 pr-2 font-semibold">Bezeichnung</th>
                      <th className="py-2 text-right font-semibold">Betrag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((row) => (
                      <tr key={row.lineId} className="border-b border-border-subtle hover:bg-surface-muted transition-colors">
                        <td className="py-2 pr-2 align-top font-mono text-muted">{row.kennziffer ?? EMPTY_VALUE}</td>
                        <td className="py-2 pr-2">{row.label}</td>
                        <td className={`py-2 text-right font-semibold tabular-nums ${
                          row.kind === 'income' ? 'text-success-text' :
                          row.kind === 'expense' ? 'text-error-text' :
                          'text-foreground'
                        }`}>
                          {formatCurrency(row.total)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>

      {showRulesModal && !isWebShell && (
        <EurRulesModal
          taxYear={taxYear}
          onClose={() => setShowRulesModal(false)}
          onRulesChanged={() => void invalidateEur()}
        />
      )}

    </div>
  );
};
