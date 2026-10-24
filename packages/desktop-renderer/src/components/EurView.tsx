import React from 'react';
import {
  Badge,
  Button,
  Card,
  Checkbox,
  EmptyState,
  ErrorState,
  Input,
  Kbd,
  PageHeader,
  SegmentedControl,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useActionFeedback,
  type BadgeTone,
} from '@billme/ui';
import { LATEST_SUPPORTED_EUR_TAX_YEAR, SUPPORTED_EUR_TAX_YEARS, eurBookingPreview, type LedgerChart } from '@billme/accounting-shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Search, Check, Info, RotateCcw, Save, Ban, Settings2 } from 'lucide-react';
import { getRendererProduct, getRendererRuntime, ipc } from '../runtime-api';
import { Spinner } from '../ui/components/Spinner';
import { EurRulesModal } from './EurRulesModal';
import { useSettingsQuery } from '../hooks/useSettings';
import { LiteCashPanel } from './eur/LiteCashPanel';
import { isNeutralEurKind, isSimpleEurCategory, neutralEurKindLabels, neutralEurKindNotes, simpleEurCategoryLabel, type NeutralEurKind } from './eur/categories';

const DEFAULT_YEAR = LATEST_SUPPORTED_EUR_TAX_YEAR;

type SourceType = 'transaction' | 'invoice' | 'manual';
type VatMode = 'none' | 'default';
type QueueStatus = 'all' | 'unclassified' | 'classified' | 'excluded';
type QueueSort = 'date_desc' | 'amount_desc' | 'counterparty_asc';
/** What the payment is: income/expense with a line, an old exclusion, or (Lite) a neutral kind. */
type Decision = 'flow' | 'excluded' | NeutralEurKind;

type SuggestionLayer = 'rule' | 'counterparty' | 'bayes' | 'keyword';

type EurItem = {
  sourceType: SourceType;
  sourceId: string;
  date: string;
  /** The tax year the payment counts in (10-Tage-Regel can move it out of the year of `date`). */
  taxYear?: number;
  amountGross: number;
  amountNet: number;
  flowType: 'income' | 'expense';
  counterparty: string;
  purpose: string;
  vatWarning?: string;
  suggestedLineId?: string;
  suggestionReason?: string;
  suggestionLayer?: SuggestionLayer;
  suggestedKind?: NeutralEurKind;
  kind?: string;
  transitHint?: string;
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

const LAYER_TONES: Record<SuggestionLayer, BadgeTone> = {
  rule: 'neutral',
  counterparty: 'success',
  bayes: 'info',
  keyword: 'warning',
};

const chipButtonClass = 'rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

const formatDate = (isoDate: string): string =>
  new Date(isoDate).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });

type UndoChange = {
  sourceType: SourceType;
  sourceId: string;
  taxYear: number;
  prevLineId?: string;
  prevExcluded: boolean;
  prevKind?: NeutralEurKind;
  prevVatMode: VatMode;
  prevVatRate?: number;
};

type EurUndo = { label: string; reason: string; changes: UndoChange[] };

const formatCurrency = (amount: number): string =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);

const itemKey = (item: { sourceType: SourceType; sourceId: string }): string =>
  `${item.sourceType}:${item.sourceId}`;

const neutralKindOf = (item: EurItem): NeutralEurKind | undefined => (isNeutralEurKind(item.kind) ? item.kind : undefined);
/** Decided: a line, an exclusion, or any typed kind (cash fact), like the server's list filter. */
const isDecided = (item: EurItem): boolean => Boolean(item.classification?.eurLineId || item.classification?.excluded || item.kind);
const decisionOf = (item: EurItem): Decision => neutralKindOf(item) ?? (item.classification?.excluded ? 'excluded' : 'flow');

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
  decision: Decision;
  vatMode: VatMode;
  vatRate?: number;
  chart: LedgerChart;
  showLedger: boolean;
}> = ({ item, line, decision, vatMode, vatRate, chart, showLedger }) => {
  const excluded = decision !== 'flow';
  const flow = item.flowType === 'income' ? 'Zufluss' : 'Abfluss';
  const gross = item.amountGross;
  const rate = vatMode === 'default' ? vatRate : 0;
  const net = rate === undefined ? undefined : gross / (1 + rate / 100);
  const booking = !excluded && line && rate !== undefined
    ? eurBookingPreview({ kennziffer: line.kennziffer, flow: item.flowType === 'income' ? 'income' : 'expense', gross, vatRate: rate, chart })
    : null;
  return (
    <section aria-label="Erfassung vor dem Speichern">
      <div className="text-eyebrow uppercase text-muted">Wird erfasst als</div>
      {excluded ? (
        <p className="mt-1 text-control text-foreground">{decision === 'excluded' ? 'Nicht in der EÜR: privat oder Transfer.' : neutralEurKindNotes[decision as NeutralEurKind]}</p>
      ) : (
        <>
          <p className="mt-1 text-control text-foreground">
            {line ? <>{showLedger && line.kennziffer ? <span className="tabular-nums">Kz {line.kennziffer} · </span> : null}{showLedger ? line.label : simpleEurCategoryLabel(line)}</> : <span className="text-warning-text">Noch keine Kategorie gewählt</span>}
          </p>
          <p className="mt-0.5 text-caption text-muted">
            {flow} am <span className="tabular-nums">{formatDate(item.date)}</span>, zählt damit zum Steuerjahr <span className="tabular-nums">{item.taxYear ?? item.date.slice(0, 4)}</span>
          </p>
          <div className="mt-3 grid grid-cols-[1fr_1px_1fr] border-t border-border-strong pt-2.5">
            <div className="min-w-0 pr-3.5">
              <div className="text-eyebrow uppercase text-muted">Netto</div>
              <div className="text-heading font-bold tabular-nums text-foreground">{net === undefined ? '–' : formatCurrency(net)}</div>
              <div className="text-caption text-muted">
                USt{rate ? ` ${rate} %` : ''} <span className="tabular-nums">{net === undefined ? '–' : formatCurrency(gross - net)}</span>
              </div>
            </div>
            <div className="bg-border-strong" aria-hidden="true" />
            <div className="min-w-0 pl-3.5 text-right">
              <div className="text-eyebrow uppercase text-muted">Brutto</div>
              <div className="text-heading font-bold tabular-nums text-foreground">{formatCurrency(gross)}</div>
              <div className="truncate text-caption text-muted">{line?.label ?? flow}</div>
            </div>
          </div>
          {net === undefined && <p className="mt-1.5 text-caption text-muted">Ohne Steuersatz lässt sich Netto hier nicht berechnen; gespeichert wird dann der Bruttobetrag mit einem Prüfhinweis.</p>}
          {showLedger && line && net !== undefined && (
            <details className="mt-3.5 rounded-card border border-border" data-eur-booking-preview>
              <summary className="cursor-pointer px-3.5 py-2.75 text-label text-foreground">Entspricht dem Buchungssatz ({chart})</summary>
              <div className="border-t border-border p-3.5">
                {booking ? (
                  <Table bare density="compact">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-20">S/H</TableHead>
                        <TableHead>Konto</TableHead>
                        <TableHead numeric>Betrag</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {booking.map((entry) => (
                        <TableRow key={`${entry.side}-${entry.account}`}>
                          <TableCell><Badge tone="neutral">{entry.side === 'soll' ? 'Soll' : 'Haben'}</Badge></TableCell>
                          <TableCell><span className="font-medium tabular-nums">{entry.account}</span> {entry.label}</TableCell>
                          <TableCell numeric>{formatCurrency(entry.amount)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                ) : (
                  <p className="text-caption text-muted">Für diese Kennziffer gibt es keine Standardzuordnung.</p>
                )}
                <p className="mt-2.5 text-caption text-muted">Nur zur Orientierung. Bei der EÜR wird nichts doppelt gebucht.</p>
              </div>
            </details>
          )}
        </>
      )}
      {!excluded && inYearEndWindow(item.date) && (
        <p role="note" className="mt-3.5 rounded-control border border-info-border bg-info-bg px-3 py-2.5 text-control text-info-text">
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
  const [decision, setDecision] = React.useState<Decision>('flow');
  const excluded = decision !== 'flow';
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
  const [showAllCategories, setShowAllCategories] = React.useState(false);
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
      kind?: NeutralEurKind;
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
            ? !isDecided(item)
            : queueStatus === 'classified'
              ? isDecided(item) && !item.classification?.excluded
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
      unclassified: all.filter((item) => !isDecided(item)).length,
      classified: all.filter((item) => isDecided(item) && !item.classification?.excluded).length,
      excluded: all.filter((item) => item.classification?.excluded).length,
    };
  }, [items]);

  React.useEffect(() => {
    if (!activeItem) return;
    setSelectedLineId(activeItem.classification?.eurLineId ?? activeItem.suggestedLineId ?? '');
    setVatMode(activeItem.classification?.vatMode ?? 'none');
    setVatRate(activeItem.classification?.vatRate);
    // Pro keeps its own fact workflow (Auswertungen); here it only knows a line or the exclusion.
    setDecision(isProProduct ? (activeItem.classification?.excluded ? 'excluded' : 'flow') : decisionOf(activeItem));
    setTaxNote(activeItem.classification?.note ?? '');
  }, [activeItem]);

  const applyBulk = async (
    label: string,
    resolver: (item: EurItem) => { eurLineId?: string; excluded?: boolean; kind?: NeutralEurKind; vatMode?: VatMode; vatRate?: number },
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
      prevKind: neutralKindOf(item),
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
        prevKind: neutralKindOf(activeItem),
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
        eurLineId: excluded ? undefined : selectedLineId || undefined,
        excluded: decision === 'excluded',
        kind: isNeutralEurKind(decision) ? decision : undefined,
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
            kind: change.prevKind,
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

  const activeLine = activeLineOptions.find((line) => line.lineId === selectedLineId);
  const bulkDisabled = selectedItems.length === 0 || isApplying || auditReason.trim().length === 0;
  const checks = activeItem
    ? [
        !excluded && !activeLine ? 'Noch keine Kategorie gewählt' : undefined,
        auditReason.trim().length === 0 ? 'Bitte eine Begründung für den Audit-Eintrag eingeben.' : undefined,
        isProProduct && vatMode === 'default' ? activeItem.vatWarning : undefined,
        activeItem.transitHint,
      ].filter((text): text is string => Boolean(text))
    : [];

  return (
    <div className="@container">
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
            {(
              <Button variant="secondary" onClick={() => setShowRulesModal(true)}>
                <Settings2 size={16} aria-hidden="true" />
                Regeln
              </Button>
            )}
          </>
        }
      />

      {!isProProduct && <LiteCashPanel />}

      {lastUndo && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-control border border-warning-border bg-warning-bg px-3 py-2.5 text-control text-warning-text">
          <div className="flex items-center gap-2">
            <RotateCcw size={16} className="shrink-0" aria-hidden="true" />
            <span>Aktion gespeichert: <span className="font-semibold">{lastUndo.label}</span></span>
          </div>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void undoLast()}
            disabled={isApplying}
          >
            <RotateCcw size={14} aria-hidden="true" />
            Rückgängig
          </Button>
        </div>
      )}

      <div className="grid items-start gap-3 @2xl:grid-cols-[260px_minmax(0,1fr)] @5xl:grid-cols-[264px_minmax(0,1fr)_312px]">
        <Card padding="none" className="flex min-w-0 flex-col overflow-hidden">
          <div className="flex flex-col gap-2 border-b border-border px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-foreground">Warteschlange</h2>
              <span className="flex items-center gap-1 text-caption text-muted"><Kbd>J</Kbd><Kbd>K</Kbd> blättern</span>
            </div>
            <div className="flex flex-wrap gap-1.25">
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
                  className={chipButtonClass}
                >
                  <Badge tone={queueStatus === status ? 'inverse' : 'neutral'}>
                    {label} <span className="tabular-nums">{count}</span>
                  </Badge>
                </button>
              ))}
            </div>
            <Input
              value={query}
              aria-label="Einträge durchsuchen"
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Gegenpartei, Zweck oder Datum..."
              prefix={<Search size={14} />}
              fullWidth
            />
            <div className="grid grid-cols-2 gap-2">
              <Select
                value={flowFilter}
                aria-label="Zahlungsrichtung filtern"
                onChange={(e) => setFlowFilter(e.target.value as 'all' | 'income' | 'expense')}
                fullWidth
              >
                <option value="all">Alle Typen</option>
                <option value="income">Einnahmen</option>
                <option value="expense">Ausgaben</option>
              </Select>
              <Select
                value={queueSort}
                aria-label="Einträge sortieren"
                onChange={(e) => setQueueSort(e.target.value as QueueSort)}
                fullWidth
              >
                <option value="date_desc">Neueste zuerst</option>
                <option value="amount_desc">Betrag absteigend</option>
                <option value="counterparty_asc">Name A-Z</option>
              </Select>
            </div>
          </div>

          <div className="flex flex-col gap-2 border-b border-border bg-surface-muted px-3 py-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Checkbox
                label={<><span className="tabular-nums">{selectedItems.length}</span> ausgewählt</>}
                checked={queueItems.length > 0 && selectedItems.length === queueItems.length}
                onChange={(e) => {
                  if (e.target.checked) {
                    setSelectedKeys(new Set(queueItems.map((item) => itemKey(item))));
                  } else {
                    setSelectedKeys(new Set());
                  }
                }}
              />
              <span className="text-caption text-muted"><span className="tabular-nums">{queueItems.length}</span> Einträge</span>
            </div>
            {/* Bulk tools appear with a selection; the editor carries the same audit reason. */}
            {selectedItems.length > 0 && (<>
            <Input
              label="Begründung (Audit)"
              required
              aria-label="Begründung für EÜR-Änderung"
              value={auditReason}
              onChange={(event) => setAuditReason(event.target.value)}
              placeholder="z. B. Beleg geprüft und Kontierung bestätigt"
              fullWidth
            />
            <div className="flex flex-wrap gap-1.5">
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  void applyBulk('Bulk: Vorschlag anwenden', (item) => ({
                    eurLineId: item.suggestedKind ? undefined : item.suggestedLineId,
                    kind: item.suggestedKind,
                    excluded: false,
                    vatMode: item.classification?.vatMode ?? 'none',
                    vatRate: item.classification?.vatRate,
                  }))
                }
                disabled={bulkDisabled}
              >
                <Check size={14} aria-hidden="true" />
                Vorschlag anwenden
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  void applyBulk(isProProduct ? 'Bulk: Als privat/Transfer markieren' : 'Bulk: Als Geldtransit markieren', () => ({
                    eurLineId: undefined,
                    excluded: isProProduct,
                    kind: isProProduct ? undefined : 'transit',
                    vatMode: 'none',
                    vatRate: undefined,
                  }))
                }
                disabled={bulkDisabled}
              >
                <Ban size={14} aria-hidden="true" />
                {isProProduct ? 'Als privat/Transfer markieren' : 'Als Geldtransit markieren'}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  void applyBulk('Bulk: Klassifizierung zurücksetzen', () => ({
                    eurLineId: undefined,
                    excluded: false,
                    vatMode: 'none',
                    vatRate: undefined,
                  }))
                }
                disabled={bulkDisabled}
              >
                <RotateCcw size={14} aria-hidden="true" />
                Klassifizierung zurücksetzen
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelectedKeys(new Set())}>
                Auswahl löschen
              </Button>
            </div>
            </>)}
          </div>

          {itemsIsError ? (
            <ErrorState
              title="Einträge konnten nicht geladen werden"
              description={queryErrorDetail(itemsQueryError)}
              onRetry={() => void refetchItems()}
            />
          ) : itemsLoading ? (
            <div className="flex flex-col items-center justify-center gap-3 py-10">
              <Spinner size="md" />
              <p className="text-control text-muted">Lade Einträge …</p>
            </div>
          ) : queueItems.length === 0 ? (
            <EmptyState
              title={queueStatus === 'unclassified' && statusCounts.unclassified === 0
                ? 'Alle Einträge sind klassifiziert'
                : 'Keine Einträge für diesen Filter'}
              description={queueStatus === 'unclassified' && statusCounts.unclassified === 0
                ? 'Für dieses Steuerjahr ist nichts mehr offen. Der Report rechts zeigt die Summen.'
                : 'Wähle einen anderen Status oder leere die Suche, um weitere Einträge zu sehen.'}
            />
          ) : (
            <div className="max-h-[min(62vh,560px)] overflow-y-auto">
              {queueItems.map((item) => {
                const key = itemKey(item);
                const isActive = activeSource?.sourceType === item.sourceType && activeSource.sourceId === item.sourceId;
                return (
                  <div
                    key={key}
                    className={`flex items-start gap-2 border-b border-l-3 border-border py-2.5 pl-2.25 pr-3 transition-colors last:border-b-0 ${
                      isActive ? 'border-l-accent bg-accent-50' : 'border-l-transparent hover:bg-surface-muted'
                    }`}
                  >
                    <span className="mt-px flex">
                      <Checkbox
                        aria-label={`${item.counterparty} auswählen`}
                        checked={selectedKeys.has(key)}
                        onChange={(e) => {
                          const next = new Set(selectedKeys);
                          if (e.target.checked) next.add(key);
                          else next.delete(key);
                          setSelectedKeys(next);
                        }}
                      />
                    </span>
                    <button
                      type="button"
                      onClick={() => setActiveSource({ sourceType: item.sourceType, sourceId: item.sourceId })}
                      aria-current={isActive ? 'true' : undefined}
                      className="min-w-0 flex-1 rounded-xs text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    >
                      <span className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 truncate text-control font-semibold text-foreground">{item.counterparty}</span>
                        <span className={`text-control font-semibold tabular-nums ${
                          item.flowType === 'income' ? 'text-success-text' : 'text-foreground'
                        }`}>
                          {item.flowType === 'income' ? '+' : '-'}{formatCurrency(item.amountGross)}
                        </span>
                      </span>
                      <span className="mt-0.75 flex flex-wrap items-center gap-1.5">
                        <span className="text-caption tabular-nums text-muted">{item.date}</span>
                        {item.classification?.excluded ? (
                          <Badge tone="error">Ausgeschlossen</Badge>
                        ) : neutralKindOf(item) ? (
                          <Badge tone="neutral">{neutralKindOf(item) === 'transit' ? 'Geldtransit' : neutralEurKindLabels[neutralKindOf(item)!]}</Badge>
                        ) : isDecided(item) ? (
                          <Badge tone="success">Klassifiziert</Badge>
                        ) : (
                          <Badge tone="warning">Offen</Badge>
                        )}
                        <Badge tone="neutral">{item.sourceType === 'transaction' ? 'Bank' : item.sourceType === 'manual' ? 'Manuell' : 'Rechnung'}</Badge>
                        <Badge tone="neutral">{item.flowType === 'income' ? 'Einnahme' : 'Ausgabe'}</Badge>
                        {item.suggestionLayer && !isDecided(item) && (
                          <Badge tone={LAYER_TONES[item.suggestionLayer]}>{LAYER_LABELS[item.suggestionLayer]}</Badge>
                        )}
                      </span>
                      <span className="mt-0.75 block truncate text-caption text-muted">{item.purpose}</span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </Card>

        <Card padding="none" className={`min-w-0 ${activeItem ? '' : '@5xl:col-span-2'}`}>
          <section aria-label="Klassifizierung" className="flex flex-col">
            {!activeItem ? (
              <EmptyState
                title="Kein Eintrag ausgewählt"
                description="Wähle links einen Eintrag aus, um seine Kategorie auszuwählen."
              />
            ) : (
              <>
                <div className="flex flex-wrap items-start justify-between gap-2.5 border-b border-border px-3 py-2.5">
                  <div className="min-w-0">
                    <h2 className="truncate text-section text-foreground">{activeItem.counterparty}</h2>
                    <div className="truncate text-caption text-muted">
                      <span className="tabular-nums">{formatDate(activeItem.date)}</span> · {activeItem.purpose}
                    </div>
                  </div>
                  <div className={`text-heading font-bold tabular-nums ${
                    activeItem.flowType === 'income' ? 'text-success-text' : 'text-foreground'
                  }`}>
                    {formatCurrency(activeItem.amountGross)}
                  </div>
                </div>

                <div className="flex flex-col gap-3.5 p-3">
                  <div className="flex flex-wrap items-start gap-2.5 rounded-control border border-info-border bg-info-bg px-3 py-2.5 text-control text-info-text">
                    <Info size={16} className="mt-px shrink-0" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <strong className="font-semibold">Einnahmen-Überschuss-Rechnung.</strong> Erfasst wird die Zahlung, nicht die Rechnung.
                      {(activeItem.suggestedLineId || activeItem.suggestedKind || activeItem.suggestionReason) && (
                        <div className="mt-1 flex flex-wrap items-center gap-1.5 text-caption">
                          {activeItem.suggestionLayer && (
                            <Badge tone={LAYER_TONES[activeItem.suggestionLayer]}>{LAYER_LABELS[activeItem.suggestionLayer]}</Badge>
                          )}
                          {activeItem.suggestionReason}
                        </div>
                      )}
                    </div>
                    {(activeItem.suggestedLineId || (!isProProduct && activeItem.suggestedKind)) && (
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          if (activeItem.suggestedKind) { setDecision(activeItem.suggestedKind); return; }
                          setSelectedLineId(activeItem.suggestedLineId!);
                          setDecision('flow');
                        }}
                      >
                        <Check size={14} aria-hidden="true" />
                        Vorschlag übernehmen
                      </Button>
                    )}
                  </div>

                  <div>
                    <div className="mb-1.5 text-eyebrow uppercase text-muted">Art des Vorgangs</div>
                    <SegmentedControl<Decision>
                      aria-label="Art des Vorgangs"
                      value={decision}
                      onChange={(value) => setDecision(value as Decision)}
                      options={[
                        { value: 'flow', label: activeItem.flowType === 'income' ? 'Einnahme' : 'Ausgabe' },
                        ...(isProProduct
                          ? [{ value: 'excluded' as const, label: 'Privat/Transfer ausschließen' }]
                          : [
                            activeItem.flowType === 'expense'
                              ? { value: 'private-withdrawal' as const, label: 'Privatentnahme' }
                              : { value: 'private-contribution' as const, label: 'Privateinlage' },
                            { value: 'transit' as const, label: 'Geldtransit' },
                            // Exclusions saved before Privat and Geldtransit existed stay visible until reassigned.
                            ...(activeItem.classification?.excluded ? [{ value: 'excluded' as const, label: 'Ausgeschlossen (alt)' }] : []),
                          ]),
                      ]}
                    />
                  </div>

                  <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3.5">
                    <div className="col-span-full">
                      <Select
                        id="eur-line"
                        label={isProProduct ? 'Kennziffer' : 'Kategorie'}
                        value={selectedLineId}
                        onChange={(e) => setSelectedLineId(e.target.value)}
                        disabled={excluded}
                        fullWidth
                      >
                        <option value="">Nicht zugeordnet</option>
                        {activeLineOptions.filter((line) => isProProduct || showAllCategories || isSimpleEurCategory(line) || line.lineId === selectedLineId).map((line) => (
                          <option key={line.lineId} value={line.lineId}>
                            {isProProduct ? `${line.kennziffer ? `${line.kennziffer} - ` : ''}${line.label}` : simpleEurCategoryLabel(line)}
                          </option>
                        ))}
                      </Select>
                      {!isProProduct && <Checkbox className="mt-2" label="Weitere Kategorien anzeigen" checked={showAllCategories} onChange={(e) => setShowAllCategories(e.target.checked)} />}
                    </div>
                    <Input
                      label="Betrag brutto"
                      value={formatCurrency(activeItem.amountGross)}
                      readOnly
                      fullWidth
                      className="text-right tabular-nums"
                    />
                    <Select
                      id="eur-vat-mode"
                      label="USt. Modus"
                      value={vatMode}
                      onChange={(e) => setVatMode(e.target.value as VatMode)}
                      fullWidth
                    >
                      <option value="none">Keine USt. Umrechnung</option>
                      <option value="default">Default USt. (Netto)</option>
                    </Select>
                    {vatMode === 'default' && (
                      <Input
                        id="eur-vat-rate"
                        label="USt.-Satz (%)"
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        value={vatRate ?? ''}
                        onChange={(e) => setVatRate(e.target.value === '' ? undefined : Number(e.target.value))}
                        placeholder="z. B. 19"
                        fullWidth
                      />
                    )}
                    <Input
                      label="Zahlungsdatum"
                      value={formatDate(activeItem.date)}
                      readOnly
                      fullWidth
                      className="tabular-nums"
                    />
                    <div className="col-span-full">
                      <Input
                        label="Steuerliche Korrektur / Begründung"
                        aria-label="Steuerliche Korrektur"
                        value={taxNote}
                        onChange={(event) => setTaxNote(event.target.value)}
                        placeholder="z. B. privater Anteil"
                        fullWidth
                      />
                    </div>
                    <div className="col-span-full">
                      <Input
                        label="Begründung (Audit)"
                        required
                        aria-label="Begründung für EÜR-Änderung"
                        value={auditReason}
                        onChange={(event) => setAuditReason(event.target.value)}
                        placeholder="z. B. Beleg geprüft und Kontierung bestätigt"
                        fullWidth
                      />
                    </div>
                  </div>

                  <EurEntryPreview
                    item={activeItem}
                    line={activeLine}
                    decision={decision}
                    vatMode={vatMode}
                    vatRate={vatRate}
                    // ponytail: Lite has no accounting policy row; the profile chart (default SKR03) only labels the preview.
                    chart={settings?.businessReportingProfile?.chart ?? 'SKR03'}
                    showLedger={isProProduct}
                  />

                  <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-3">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setSelectedLineId('');
                        setDecision('flow');
                        setVatMode('none');
                      }}
                    >
                      Zurücksetzen
                    </Button>
                    <Button onClick={() => void applySingle()} disabled={isApplying || auditReason.trim().length === 0}>
                      <Save size={16} aria-hidden="true" />
                      {isApplying ? 'Speichern...' : 'Klassifizierung speichern'}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </section>
        </Card>

        {activeItem && (
          <Card padding="sm" className="flex min-w-0 flex-col gap-3.5 @2xl:col-span-full @5xl:col-auto">
            {checks.length > 0 && (
              <div>
                <div className="mb-2 text-eyebrow uppercase text-muted">Prüfungen</div>
                <div className="flex flex-col gap-1.5">
                  {checks.map((text) => (
                    <div key={text} className="flex items-start gap-2 rounded-control border border-warning-border bg-warning-bg px-2.25 py-1.75 text-caption text-warning-text">
                      <AlertCircle size={14} className="mt-px shrink-0" aria-hidden="true" />
                      <span>{text}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <div>
              <div className="mb-2 text-eyebrow uppercase text-muted">Verlauf</div>
              <ol className="flex flex-col gap-3">
                <li className="flex gap-2.25">
                  <span
                    aria-hidden="true"
                    className={`ml-0.75 mt-1.25 size-1.75 shrink-0 rounded-full ${
                      activeItem.classification?.eurLineId && !activeItem.classification.excluded ? 'bg-success' : 'bg-border-strong'
                    }`}
                  />
                  <div className="min-w-0">
                    <div className="text-caption text-foreground">
                      {activeItem.classification?.updatedAt
                        ? `Zuletzt: ${new Date(activeItem.classification.updatedAt).toLocaleString('de-DE')}`
                        : 'Noch nicht klassifiziert'}
                    </div>
                    {activeItem.line && (
                      <div className="text-micro text-muted">
                        {isProProduct ? `${activeItem.line.kennziffer ? `Kz ${activeItem.line.kennziffer} · ` : ''}${activeItem.line.label}` : simpleEurCategoryLabel(activeItem.line)}
                      </div>
                    )}
                  </div>
                </li>
                <li className="flex gap-2.25">
                  <span aria-hidden="true" className="ml-0.75 mt-1.25 size-1.75 shrink-0 rounded-full bg-border-strong" />
                  <div className="min-w-0">
                    <div className="text-caption text-foreground">{activeItem.sourceType === 'transaction' ? 'Bank' : activeItem.sourceType === 'manual' ? 'Manuell' : 'Rechnung'}</div>
                    <div className="text-micro text-muted">
                      <span className="tabular-nums">{formatDate(activeItem.date)}</span> · {activeItem.purpose}
                    </div>
                  </div>
                </li>
              </ol>
            </div>
          </Card>
        )}
      </div>

      {showRulesModal && (
        <EurRulesModal
          taxYear={taxYear}
          onClose={() => setShowRulesModal(false)}
          onRulesChanged={() => void invalidateEur()}
        />
      )}
    </div>
  );
};
