import React from 'react';
import { Button } from '@billme/ui';
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
  Sparkles,
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
import { ipc } from '../ipc/client';
import { Spinner } from './Spinner';
import { Toast } from './Toast';
import { EurRulesModal } from './EurRulesModal';

const DEFAULT_YEAR = 2025;

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
  suggestedLineId?: string;
  suggestionReason?: string;
  suggestionLayer?: SuggestionLayer;
  classification?: {
    eurLineId?: string;
    excluded: boolean;
    vatMode: VatMode;
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
  rule: 'bg-purple-100 text-purple-700',
  counterparty: 'bg-green-100 text-green-700',
  bayes: 'bg-amber-100 text-amber-700',
  keyword: 'bg-blue-100 text-blue-700',
};

type UndoChange = {
  sourceType: SourceType;
  sourceId: string;
  taxYear: number;
  prevLineId?: string;
  prevExcluded: boolean;
  prevVatMode: VatMode;
};

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

export const EurView: React.FC = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [taxYear, setTaxYear] = React.useState<number>(DEFAULT_YEAR);
  const [activeSource, setActiveSource] = React.useState<{ sourceType: SourceType; sourceId: string } | null>(null);
  const [selectedLineId, setSelectedLineId] = React.useState<string>('');
  const [vatMode, setVatMode] = React.useState<VatMode>('none');
  const [excluded, setExcluded] = React.useState<boolean>(false);

  const [query, setQuery] = React.useState('');
  const [queueStatus, setQueueStatus] = React.useState<QueueStatus>('unclassified');
  const [flowFilter, setFlowFilter] = React.useState<'all' | 'income' | 'expense'>('all');
  const [queueSort, setQueueSort] = React.useState<QueueSort>('date_desc');
  const [selectedKeys, setSelectedKeys] = React.useState<Set<string>>(new Set());
  const [isApplying, setIsApplying] = React.useState(false);
  const [lastUndo, setLastUndo] = React.useState<{ label: string; changes: UndoChange[] } | null>(null);

  const [showRulesModal, setShowRulesModal] = React.useState(false);
  const [showToast, setShowToast] = React.useState(false);
  const [toastMessage, setToastMessage] = React.useState('');
  const [toastType, setToastType] = React.useState<'success' | 'error' | 'warning' | 'info'>('success');

  const showNotification = (message: string, type: 'success' | 'error' | 'warning' | 'info' = 'success') => {
    setToastMessage(message);
    setToastType(type);
    setShowToast(true);
  };

  const { data: report, isLoading: reportLoading } = useQuery({
    queryKey: ['eur', 'report', taxYear],
    queryFn: () => ipc.eur.getReport({ taxYear }),
  });

  const { data: items = [], isLoading: itemsLoading } = useQuery({
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
    setExcluded(activeItem.classification?.excluded ?? false);
  }, [activeItem]);

  const applyBulk = async (
    label: string,
    resolver: (item: EurItem) => { eurLineId?: string; excluded?: boolean; vatMode?: VatMode },
  ) => {
    if (selectedItems.length === 0) return;

    const changes: UndoChange[] = selectedItems.map((item) => ({
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      taxYear,
      prevLineId: item.classification?.eurLineId,
      prevExcluded: item.classification?.excluded ?? false,
      prevVatMode: item.classification?.vatMode ?? 'none',
    }));

    setIsApplying(true);
    try {
      await Promise.all(
        selectedItems.map((item) =>
          upsertClassification.mutateAsync({
            sourceType: item.sourceType,
            sourceId: item.sourceId,
            taxYear,
            ...resolver(item),
          }),
        ),
      );
      setLastUndo({ label, changes });
      setSelectedKeys(new Set());
      await invalidateEur();
      showNotification(`${selectedItems.length} Einträge klassifiziert`, 'success');
    } finally {
      setIsApplying(false);
    }
  };

  const applySingle = async () => {
    if (!activeItem) return;

    const changes: UndoChange[] = [
      {
        sourceType: activeItem.sourceType,
        sourceId: activeItem.sourceId,
        taxYear,
        prevLineId: activeItem.classification?.eurLineId,
        prevExcluded: activeItem.classification?.excluded ?? false,
        prevVatMode: activeItem.classification?.vatMode ?? 'none',
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
      });
      setLastUndo({ label: 'Einzelklassifizierung', changes });
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
    <div className="bg-white rounded-[2.5rem] p-6 min-h-full shadow-sm">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate({ to: '/finance' })}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
          <div className="w-12 h-12 rounded-2xl bg-black text-accent flex items-center justify-center">
            <ReceiptText size={22} />
          </div>
          <div>
            <h2 className="text-2xl font-black text-gray-900">Anlage EÜR</h2>
            <p className="text-sm text-gray-500 mt-1">Klassifizierung und Auswertung für Steuerjahr {taxYear}.</p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <select
            value={taxYear}
            onChange={(e) => setTaxYear(Number(e.target.value))}
            className="rounded-xl border border-gray-300 px-3 py-2 text-sm"
          >
            <option value={2025}>2025</option>
          </select>
          <Button variant="secondary" size="sm" onClick={() => setShowRulesModal(true)}>
            <Settings2 size={16} />
            Regeln
          </Button>
          <Button variant="dark" size="sm" onClick={() => void exportCsv()}>
            <Download size={16} />
            CSV exportieren
          </Button>
          <Button variant="dark" size="sm" onClick={() => void exportPdf()} disabled={isPdfExporting}>
            <Download size={16} />
            {isPdfExporting ? 'PDF...' : 'PDF exportieren'}
          </Button>
        </div>
      </div>

      {/* Undo Banner */}
      {lastUndo && (
        <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-sm text-amber-800">
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
        <div className="rounded-2xl border border-gray-200 p-4 lg:col-span-1">
          <h3 className="font-bold text-gray-900 mb-3 flex items-center gap-2">
            <ClipboardList size={18} className="text-gray-500" />
            Queue
            <span className="text-xs font-normal text-gray-400 ml-auto">{queueItems.length} Einträge</span>
          </h3>

          {/* Filter Tabs */}
          <div className="rounded-lg border border-gray-200 p-1 bg-gray-50 mb-3">
            <div className="grid grid-cols-2 gap-1 text-xs">
              {([
                ['unclassified', 'Offen', statusCounts.unclassified],
                ['classified', 'Klassifiziert', statusCounts.classified],
                ['excluded', 'Ausgeschl.', statusCounts.excluded],
                ['all', 'Alle', statusCounts.all],
              ] as Array<[QueueStatus, string, number]>).map(([status, label, count]) => (
                <button
                  key={status}
                  onClick={() => setQueueStatus(status)}
                  className={`rounded-md px-2 py-1.5 font-medium transition-all ${
                    queueStatus === status
                      ? 'bg-white shadow font-semibold text-gray-900'
                      : 'text-gray-600 hover:text-gray-800'
                  }`}
                >
                  {label} ({count})
                </button>
              ))}
            </div>
          </div>

          {/* Search */}
          <div className="relative mb-3">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Gegenpartei, Zweck oder Datum..."
              className="w-full pl-9 pr-3 py-2 rounded-xl border border-gray-300 text-sm focus:outline-none focus:ring-2 focus:ring-gray-900/10"
            />
          </div>

          {/* Flow & Sort Filters */}
          <div className="grid grid-cols-2 gap-2 mb-3">
            <select
              value={flowFilter}
              onChange={(e) => setFlowFilter(e.target.value as 'all' | 'income' | 'expense')}
              className="rounded-xl border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="all">Alle Typen</option>
              <option value="income">Einnahmen</option>
              <option value="expense">Ausgaben</option>
            </select>
            <select
              value={queueSort}
              onChange={(e) => setQueueSort(e.target.value as QueueSort)}
              className="rounded-xl border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="date_desc">Neueste zuerst</option>
              <option value="amount_desc">Betrag absteigend</option>
              <option value="counterparty_asc">Name A-Z</option>
            </select>
          </div>

          {/* Bulk Actions */}
          <div className="mb-3 rounded-xl border border-gray-200 bg-gray-50 p-3">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-bold text-gray-700 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={queueItems.length > 0 && selectedItems.length === queueItems.length}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setSelectedKeys(new Set(queueItems.map((item) => itemKey(item))));
                    } else {
                      setSelectedKeys(new Set());
                    }
                  }}
                />
                {selectedItems.length} ausgewählt
              </label>
              <button
                onClick={() => setSelectedKeys(new Set())}
                className="text-xs text-gray-500 hover:text-gray-800 transition-colors"
              >
                Auswahl löschen
              </button>
            </div>
            <div className="grid grid-cols-1 gap-1.5">
              <button
                onClick={() =>
                  void applyBulk('Bulk: Vorschlag anwenden', (item) => ({
                    eurLineId: item.suggestedLineId,
                    excluded: false,
                    vatMode: item.classification?.vatMode ?? 'none',
                  }))
                }
                disabled={selectedItems.length === 0 || isApplying}
                className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-left hover:bg-gray-100 transition-colors disabled:opacity-50"
              >
                <Sparkles size={14} className="text-blue-500 flex-shrink-0" />
                Vorschlag anwenden
              </button>
              <button
                onClick={() =>
                  void applyBulk('Bulk: Als privat/Transfer markieren', () => ({
                    eurLineId: undefined,
                    excluded: true,
                    vatMode: 'none',
                  }))
                }
                disabled={selectedItems.length === 0 || isApplying}
                className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-left hover:bg-gray-100 transition-colors disabled:opacity-50"
              >
                <Ban size={14} className="text-red-500 flex-shrink-0" />
                Als privat/Transfer markieren
              </button>
              <button
                onClick={() =>
                  void applyBulk('Bulk: Klassifizierung zurücksetzen', () => ({
                    eurLineId: undefined,
                    excluded: false,
                    vatMode: 'none',
                  }))
                }
                disabled={selectedItems.length === 0 || isApplying}
                className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-left hover:bg-gray-100 transition-colors disabled:opacity-50"
              >
                <RotateCcw size={14} className="text-gray-500 flex-shrink-0" />
                Klassifizierung zurücksetzen
              </button>
            </div>
          </div>

          {/* Queue Items */}
          {itemsLoading ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Spinner size="md" />
              <p className="text-sm text-gray-500 mt-3">Lade Einträge...</p>
            </div>
          ) : queueItems.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-gray-500">
              <CheckCircle2 size={48} className="mb-4 opacity-50" />
              <p className="text-lg font-medium">Keine Einträge</p>
              <p className="text-sm text-center mt-2">
                {queueStatus === 'unclassified'
                  ? 'Alle Einträge sind bereits klassifiziert.'
                  : 'Keine Einträge für diesen Filter.'}
              </p>
            </div>
          ) : (
            <div className="space-y-2 max-h-[460px] overflow-auto pr-1">
              {queueItems.map((item, idx) => {
                const key = itemKey(item);
                const isActive = activeSource?.sourceType === item.sourceType && activeSource.sourceId === item.sourceId;
                return (
                  <div
                    key={key}
                    className={`w-full text-left p-3 rounded-xl border transition-all animate-enter ${
                      isActive ? 'border-black bg-gray-50 shadow-sm' : 'border-gray-200 hover:border-gray-300 hover:shadow-sm'
                    }`}
                    style={{ animationDelay: `${idx * 30}ms` }}
                  >
                    <div className="flex items-start gap-2">
                      <input
                        type="checkbox"
                        className="mt-1"
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
                        <div className="flex items-center gap-1.5 text-xs text-gray-500">
                          {item.classification?.excluded ? (
                            <XCircle size={14} className="text-red-400" />
                          ) : item.classification?.eurLineId ? (
                            <CheckCircle2 size={14} className="text-green-500" />
                          ) : (
                            <AlertCircle size={14} className="text-amber-500" />
                          )}
                          <span>{item.date}</span>
                          <span className="text-gray-300">|</span>
                          <span>{item.sourceType === 'transaction' ? 'Bank' : 'Rechnung'}</span>
                        </div>
                        <div className="text-sm font-semibold text-gray-900 truncate">{item.counterparty}</div>
                        <div className="text-xs text-gray-600 truncate">{item.purpose}</div>
                        <div className={`text-sm font-mono font-bold mt-1 ${
                          item.flowType === 'income' ? 'text-green-600' : 'text-red-600'
                        }`}>
                          {item.flowType === 'income' ? '+' : '-'}{formatCurrency(item.amountGross)}
                        </div>
                        <div className="flex flex-wrap gap-1 mt-2 text-[11px]">
                          {item.classification?.excluded ? (
                            <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700">Ausgeschlossen</span>
                          ) : item.classification?.eurLineId ? (
                            <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-700">Klassifiziert</span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">Offen</span>
                          )}
                          {item.flowType === 'income' ? (
                            <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">Einnahme</span>
                          ) : (
                            <span className="px-2 py-0.5 rounded-full bg-rose-50 text-rose-700">Ausgabe</span>
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
        <div className="rounded-2xl border border-gray-200 p-4 lg:col-span-1">
          <h3 className="font-bold text-gray-900 mb-3 flex items-center gap-2">
            <Tags size={18} className="text-gray-500" />
            Klassifizierung
          </h3>
          {!activeItem ? (
            <div className="flex flex-col items-center justify-center py-16 text-gray-500">
              <Tags size={48} className="mb-4 opacity-50" />
              <p className="text-lg font-medium">Kein Eintrag ausgewählt</p>
              <p className="text-sm text-center mt-2">Wählen Sie links einen Eintrag zur Klassifizierung aus.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {/* Active Item Summary Card */}
              <div className="rounded-xl border border-gray-200 bg-gray-50 p-3">
                <div className="flex items-center gap-2 mb-1">
                  {activeItem.flowType === 'income' ? (
                    <TrendingUp size={16} className="text-green-500" />
                  ) : (
                    <TrendingDown size={16} className="text-red-500" />
                  )}
                  <span className="text-sm font-bold text-gray-900 truncate">{activeItem.counterparty}</span>
                </div>
                <div className="text-xs text-gray-500 truncate">{activeItem.purpose}</div>
                <div className={`text-sm font-mono font-bold mt-1 ${
                  activeItem.flowType === 'income' ? 'text-green-600' : 'text-red-600'
                }`}>
                  {formatCurrency(activeItem.amountGross)}
                </div>
                <div className="text-xs text-gray-400 mt-1">
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
                  className="w-full rounded-xl border border-blue-200 bg-blue-50 px-3 py-2.5 text-left hover:bg-blue-100 transition-colors"
                >
                  <div className="flex items-center gap-2">
                    <Sparkles size={16} className="text-blue-600 flex-shrink-0" />
                    <div className="flex-1">
                      <div className="text-xs text-blue-700 font-semibold flex items-center gap-2">
                        Vorschlag übernehmen
                        {activeItem.suggestionLayer && (
                          <span className={`px-1.5 py-0.5 rounded-full text-[10px] ${LAYER_COLORS[activeItem.suggestionLayer]}`}>
                            {LAYER_LABELS[activeItem.suggestionLayer]}
                          </span>
                        )}
                      </div>
                      {activeItem.suggestionReason && (
                        <div className="text-xs text-blue-600">{activeItem.suggestionReason}</div>
                      )}
                    </div>
                  </div>
                </button>
              )}

              {/* Kennziffer Select */}
              <div>
                <label className="block text-xs font-bold text-gray-700">Kennziffer</label>
                <select
                  value={selectedLineId}
                  onChange={(e) => setSelectedLineId(e.target.value)}
                  disabled={excluded}
                  className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="">Nicht zugeordnet</option>
                  {activeLineOptions.map((line) => (
                    <option key={line.lineId} value={line.lineId}>
                      {line.kennziffer ? `${line.kennziffer} - ` : ''}{line.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* VAT Mode Select */}
              <div>
                <label className="block text-xs font-bold text-gray-700">USt. Modus</label>
                <select
                  value={vatMode}
                  onChange={(e) => setVatMode(e.target.value as VatMode)}
                  className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2 text-sm"
                >
                  <option value="none">Keine USt. Umrechnung</option>
                  <option value="default">Default USt. (Netto)</option>
                </select>
              </div>

              {/* Excluded Checkbox */}
              <label className="flex items-center gap-2 text-sm text-gray-700">
                <input
                  type="checkbox"
                  checked={excluded}
                  onChange={(e) => setExcluded(e.target.checked)}
                />
                Privat/Transfer ausschließen
              </label>

              {/* Action Buttons */}
              <div className="flex items-center gap-2">
                <Button onClick={() => void applySingle()} disabled={isApplying} fullWidth>
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
        <div className="rounded-2xl border border-gray-200 p-4 lg:col-span-1">
          <h3 className="font-bold text-gray-900 mb-3 flex items-center gap-2">
            <Layers size={18} className="text-gray-500" />
            Report
          </h3>
          {reportLoading || !report ? (
            <div className="flex flex-col items-center justify-center py-12">
              <Spinner size="md" />
              <p className="text-sm text-gray-500 mt-3">Report wird geladen...</p>
            </div>
          ) : (
            <>
              {/* Summary Stat Cards */}
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div className="rounded-xl bg-green-50 border border-green-100 p-3">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-green-600">Einnahmen</div>
                  <div className="text-lg font-mono font-bold text-green-700 mt-1">{formatCurrency(report.summary.incomeTotal)}</div>
                </div>
                <div className="rounded-xl bg-red-50 border border-red-100 p-3">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-red-600">Ausgaben</div>
                  <div className="text-lg font-mono font-bold text-red-700 mt-1">{formatCurrency(report.summary.expenseTotal)}</div>
                </div>
                <div className="rounded-xl bg-gray-50 border border-gray-200 p-3">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-gray-500">Überschuss</div>
                  <div className={`text-lg font-mono font-bold mt-1 ${report.summary.surplus >= 0 ? 'text-green-700' : 'text-red-700'}`}>
                    {formatCurrency(report.summary.surplus)}
                  </div>
                </div>
                <div className="rounded-xl bg-amber-50 border border-amber-100 p-3">
                  <div className="text-[11px] font-bold uppercase tracking-wider text-amber-600">Unklassifiziert</div>
                  <div className="text-lg font-mono font-bold text-amber-700 mt-1">{report.unclassifiedCount}</div>
                </div>
              </div>

              {/* Report Table */}
              <div className="max-h-[470px] overflow-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-gray-500 border-b border-gray-200">
                      <th className="py-2 pr-2 font-semibold">Kz</th>
                      <th className="py-2 pr-2 font-semibold">Bezeichnung</th>
                      <th className="py-2 text-right font-semibold">Betrag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((row) => (
                      <tr key={row.lineId} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                        <td className="py-2 pr-2 align-top font-mono text-gray-500">{row.kennziffer ?? '-'}</td>
                        <td className="py-2 pr-2">{row.label}</td>
                        <td className={`py-2 text-right font-mono font-semibold ${
                          row.kind === 'income' ? 'text-green-600' :
                          row.kind === 'expense' ? 'text-red-600' :
                          'text-gray-900'
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

      {showRulesModal && (
        <EurRulesModal
          taxYear={taxYear}
          onClose={() => setShowRulesModal(false)}
          onRulesChanged={() => void invalidateEur()}
        />
      )}

      <Toast
        message={toastMessage}
        type={toastType}
        isVisible={showToast}
        onClose={() => setShowToast(false)}
      />
    </div>
  );
};
