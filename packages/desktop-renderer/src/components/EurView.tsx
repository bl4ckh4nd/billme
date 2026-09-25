import React from 'react';
import { Button, EmptyState, ErrorState, PageHeader, Select, useActionFeedback } from '@billme/ui';
import { LATEST_SUPPORTED_EUR_TAX_YEAR, SUPPORTED_EUR_TAX_YEARS, eurBookingPreview, type LedgerChart } from '@billme/accounting-shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
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
  ClipboardList,
  Tags,
  Settings2,
} from 'lucide-react';
import { getRendererProduct, getRendererRuntime, ipc } from '../runtime-api';
import { Spinner } from '@billme/desktop-ui/components/Spinner';
import { EurRulesModal } from './EurRulesModal';
import { useSettingsQuery } from '../hooks/useSettings';

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

const itemKey = (item: { sourceType: SourceType; sourceId: string }): string =>
  `${item.sourceType}:${item.sourceId}`;

const queryErrorDetail = (error: unknown): string =>
  error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'Unbekannter Fehler beim Laden.';

/** Ten days either side of the year change (22.12.–10.01.), the § 11 Abs. 1 S. 2 EStG window. */
const inYearEndWindow = (isoDate: string): boolean => {
  const monthDay = isoDate.slice(5, 10);
  return monthDay >= '12-22' || monthDay <= '01-10';
};

/**
 * What saving will record, before it is saved: the EÜR line, the payment date
 * that decides the tax year (Zuflussprinzip), and the gross amount split into
 * net and VAT when a rate is known. Nothing here is invented; an unknown rate
 * is named as unknown.
 */
const EurEntryPreview: React.FC<{
  item: EurItem;
  line?: { lineId: string; kennziffer?: string; label: string };
  excluded: boolean;
  vatMode: VatMode;
  vatRate?: number;
  chart: LedgerChart;
}> = ({ item, line, excluded, vatMode, vatRate, chart }) => {
  const flow = item.flowType === 'income' ? 'Zufluss' : 'Abfluss';
  const gross = Math.abs(item.amountGross);
  const rate = vatMode === 'default' ? vatRate : 0;
  const net = rate === undefined ? undefined : gross / (1 + rate / 100);
  const booking = !excluded && line && rate !== undefined
    ? eurBookingPreview({ kennziffer: line.kennziffer, flow: item.flowType === 'income' ? 'income' : 'expense', gross, vatRate: rate, chart })
    : null;
  return (
    <section aria-label="Erfassung vor dem Speichern" className="rounded-xl border border-border p-3">
      <div className="text-caption font-semibold uppercase tracking-[0.04em] text-muted">Wird erfasst als</div>
      {excluded ? (
        <p className="mt-1.5 text-sm text-foreground">Nicht in der EÜR: privat oder Transfer.</p>
      ) : (
        <>
          <p className="mt-1.5 text-sm text-foreground">
            {line ? <>{line.kennziffer ? <span className="tabular-nums">Kz {line.kennziffer} · </span> : null}{line.label}</> : <span className="text-warning-text">Noch keine Kennziffer gewählt</span>}
          </p>
          <p className="mt-0.5 text-caption text-muted">
            {flow} am <span className="tabular-nums">{new Date(item.date).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}</span>, zählt damit zum Steuerjahr <span className="tabular-nums">{item.date.slice(0, 4)}</span>
          </p>
          <div className="mt-3 grid grid-cols-[1fr_1px_1fr] border-t border-control-border pt-2">
            <div className="pr-3">
              <div className="text-caption text-muted">Netto</div>
              <div className="text-sm font-semibold tabular-nums text-foreground">{net === undefined ? '–' : formatCurrency(net)}</div>
            </div>
            <div className="bg-control-border" aria-hidden="true" />
            <div className="pl-3 text-right">
              <div className="text-caption text-muted">USt{rate ? ` ${rate} %` : ''}</div>
              <div className="text-sm font-semibold tabular-nums text-foreground">{net === undefined ? '–' : formatCurrency(gross - net)}</div>
            </div>
          </div>
          {net === undefined && <p className="mt-1.5 text-caption text-muted">Ohne Steuersatz lässt sich Netto hier nicht berechnen; gespeichert wird dann der Bruttobetrag mit einem Prüfhinweis.</p>}
          {line && net !== undefined && (
            <details className="mt-2 border-t border-border pt-2" data-eur-booking-preview>
              <summary className="cursor-pointer text-caption font-medium text-muted hover:text-foreground">Entspricht dem Buchungssatz ({chart})</summary>
              {booking ? (
                <table className="mt-1.5 w-full text-caption">
                  <tbody>
                    {booking.map((entry) => (
                      <tr key={`${entry.side}-${entry.account}`}>
                        <td className="w-12 py-0.5 text-muted">{entry.side === 'soll' ? 'Soll' : 'Haben'}</td>
                        <td className="w-12 py-0.5 tabular-nums text-foreground">{entry.account}</td>
                        <td className="py-0.5 text-foreground">{entry.label}</td>
                        <td className="py-0.5 text-right tabular-nums text-foreground">{formatCurrency(entry.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="mt-1.5 text-caption text-muted">Für diese Kennziffer gibt es keine Standardzuordnung.</p>
              )}
              <p className="mt-1 text-caption text-muted">Nur zur Orientierung. Bei der EÜR wird nichts doppelt gebucht.</p>
            </details>
          )}
        </>
      )}
      {!excluded && inYearEndWindow(item.date) && (
        <p role="note" className="mt-2 rounded-control border border-info-border bg-info-bg px-2.5 py-1.5 text-caption text-info-text">
          Zahlung nahe am Jahreswechsel. Regelmäßig wiederkehrende Zahlungen (z. B. Miete, Versicherung) gehören nach § 11 EStG in das Jahr, zu dem sie wirtschaftlich gehören, wenn sie innerhalb von zehn Tagen um den Jahreswechsel fällig und bezahlt sind.
        </p>
      )}
    </section>
  );
};

export const EurView: React.FC = () => {
  const isProProduct = getRendererProduct() === 'pro';
  const isWebShell = getRendererRuntime().shell === 'web';
  const queryClient = useQueryClient();
  const { data: settings } = useSettingsQuery();
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

  // The report lives under Auswertungen; here it only supplies the selectable EÜR lines.
  const { data: report } = useQuery({
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

  // j / k step through the queue like the Pro booking workbench, unless the user is typing.
  React.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.key !== 'j' && event.key !== 'k') || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      if (queueItems.length === 0) return;
      const index = queueItems.findIndex((item) => item.sourceType === activeSource?.sourceType && item.sourceId === activeSource?.sourceId);
      const next = queueItems[Math.max(0, Math.min(queueItems.length - 1, index + (event.key === 'j' ? 1 : -1)))];
      if (!next) return;
      event.preventDefault();
      setActiveSource({ sourceType: next.sourceType, sourceId: next.sourceId });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [queueItems, activeSource]);

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
    <div className="min-h-full px-1 pt-2 flex flex-col">
      <PageHeader
        title="Buchen"
        description={`Klassifizierung für Steuerjahr ${taxYear}. Die Anlage EÜR steht unter Auswertungen.`}
        actions={
          <>
            <Select
              value={taxYear}
              aria-label="Steuerjahr"
              onChange={(e) => setTaxYear(Number(e.target.value))}
            >
              {SUPPORTED_EUR_TAX_YEARS.map((year) => (
                <option key={year} value={year}>{year}</option>
              ))}
            </Select>
            {!isWebShell && (
              <Button variant="secondary" onClick={() => setShowRulesModal(true)}>
                <Settings2 size={16} aria-hidden="true" />
                Regeln
              </Button>
            )}
          </>
        }
      />
      <div className="min-h-0 flex-1">

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
        <div className="rounded-card border border-border bg-surface p-4 lg:col-span-1">
          <h3 className="font-semibold text-foreground mb-3 flex items-center gap-2">
            <ClipboardList size={16} className="text-muted" />
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
 className="px-2.5 h-8 hover:border-control-border-hover w-full pl-9 pr-3 rounded-control border border-control-border bg-surface text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            />
          </div>

          {/* Flow & Sort Filters */}
          <div className="grid grid-cols-2 gap-2 mb-3">
            <select
              value={flowFilter}
              aria-label="Zahlungsrichtung filtern"
              onChange={(e) => setFlowFilter(e.target.value as 'all' | 'income' | 'expense')}
              className="px-2.5 h-8 hover:border-control-border-hover rounded-control border border-control-border bg-surface text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              <option value="all">Alle Typen</option>
              <option value="income">Einnahmen</option>
              <option value="expense">Ausgaben</option>
            </select>
            <select
              value={queueSort}
              aria-label="Einträge sortieren"
              onChange={(e) => setQueueSort(e.target.value as QueueSort)}
              className="px-2.5 h-8 hover:border-control-border-hover rounded-control border border-control-border bg-surface text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              <option value="date_desc">Neueste zuerst</option>
              <option value="amount_desc">Betrag absteigend</option>
              <option value="counterparty_asc">Name A-Z</option>
            </select>
          </div>

          {/* Bulk Actions */}
          <div className="mb-3 rounded-xl border border-border bg-surface-muted p-3">
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-foreground flex items-center gap-2">
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
              <label className="text-xs font-semibold text-foreground">
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
                ? 'Für dieses Steuerjahr ist nichts mehr offen. Der Report rechts zeigt die Summen.'
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
                        <div className={`text-sm font-semibold tabular-nums mt-1 ${
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
        <div className="rounded-card border border-border bg-surface p-4 lg:col-span-2">
          <h3 className="font-semibold text-foreground mb-3 flex items-center gap-2">
            <Tags size={16} className="text-muted" />
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
                  <span className="text-sm font-semibold text-foreground truncate">{activeItem.counterparty}</span>
                </div>
                <div className="text-xs text-muted truncate">{activeItem.purpose}</div>
                <div className={`text-sm font-semibold tabular-nums mt-1 ${
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
                <label className="block text-xs font-semibold text-foreground" htmlFor="eur-line">Kennziffer</label>
                <select
                  id="eur-line"
                  value={selectedLineId}
                  onChange={(e) => setSelectedLineId(e.target.value)}
                  disabled={excluded}
                  className="px-2.5 h-8 hover:border-control-border-hover mt-1 w-full rounded-control border border-control-border bg-surface text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                >
                  <option value="">Nicht zugeordnet</option>
                  {activeLineOptions.map((line) => (
                    <option key={line.lineId} value={line.lineId}>
                      {line.kennziffer ? `${line.kennziffer} - ` : ''}{line.label}
                    </option>
                  ))}
                </select>
              </div>

              <label className="block text-xs font-semibold text-foreground">Steuerliche Korrektur / Begründung
                <input aria-label="Steuerliche Korrektur" value={taxNote} onChange={(event) => setTaxNote(event.target.value)} className="px-2.5 h-8 hover:border-control-border-hover mt-1 w-full rounded-control border border-control-border bg-surface text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring" placeholder="z. B. privater Anteil" />
              </label>

              <label className="block text-xs font-semibold text-foreground">
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
                <label className="block text-xs font-semibold text-foreground" htmlFor="eur-vat-mode">USt. Modus</label>
                <select
                  id="eur-vat-mode"
                  value={vatMode}
                  onChange={(e) => setVatMode(e.target.value as VatMode)}
                  className="px-2.5 h-8 hover:border-control-border-hover mt-1 w-full rounded-control border border-control-border bg-surface text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                >
                  <option value="none">Keine USt. Umrechnung</option>
                  <option value="default">Default USt. (Netto)</option>
                </select>
              </div>

              {isProProduct && vatMode === 'default' && (
                <div>
                  <label className="block text-xs font-semibold text-foreground" htmlFor="eur-vat-rate">USt.-Satz (%)</label>
                  <input
                    id="eur-vat-rate"
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={vatRate ?? ''}
                    onChange={(e) => setVatRate(e.target.value === '' ? undefined : Number(e.target.value))}
                    className="px-2.5 h-8 hover:border-control-border-hover mt-1 w-full rounded-control border border-control-border bg-surface text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
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

              <EurEntryPreview
                item={activeItem}
                line={activeLineOptions.find((line) => line.lineId === selectedLineId)}
                excluded={excluded}
                vatMode={vatMode}
                vatRate={vatRate}
                // ponytail: Lite has no accounting policy row; the profile chart (default SKR03) only labels the preview.
                chart={settings?.businessReportingProfile?.chart ?? 'SKR03'}
              />

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

      </div>

      {showRulesModal && !isWebShell && (
        <EurRulesModal
          taxYear={taxYear}
          onClose={() => setShowRulesModal(false)}
          onRulesChanged={() => void invalidateEur()}
        />
      )}

    </div>
    </div>
  );
};
