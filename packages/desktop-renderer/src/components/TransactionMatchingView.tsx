import { Button, EmptyState, ErrorState, Modal, useActionFeedback } from '@billme/ui';
import { isSupportedEurTaxYear, LATEST_SUPPORTED_EUR_TAX_YEAR, SUPPORTED_EUR_TAX_YEARS } from '@billme/accounting-shared';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Link2,
  Unlink,
  CheckCircle2,
  AlertCircle,
  Calendar,
  User,
  Search,
  X,
  Layers,
  Check,
  Ban,
  XCircle,
  TriangleAlert,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getRendererProduct, ipc } from '../runtime-api';
import { Spinner } from '@billme/desktop-ui/components/Spinner';
import type { Transaction, Invoice as InvoiceType } from '@billme/desktop-core/types';

interface InvoiceMatchSuggestion {
  invoice: InvoiceType;
  confidence: 'high' | 'medium' | 'low';
  matchReasons: string[];
  amountDiff: number;
}

interface MatchResult {
  transaction: Transaction;
  suggestions: InvoiceMatchSuggestion[];
}

type MatchingTab = 'matching' | 'eur';
type EurStatus = 'all' | 'unclassified' | 'classified' | 'excluded';

type EurTxItem = {
  sourceType: 'transaction' | 'invoice';
  sourceId: string;
  date: string;
  amountGross: number;
  amountNet: number;
  flowType: 'income' | 'expense';
  accountId?: string;
  linkedViaInvoice?: boolean;
  counterparty: string;
  purpose: string;
  vatWarning?: string;
  suggestedLineId?: string;
  suggestionReason?: string;
  classification?: {
    eurLineId?: string;
    excluded: boolean;
    vatMode: 'none' | 'default';
    vatRate?: number;
    updatedAt: string;
  };
};

type EurUndo = {
  sourceType: 'transaction' | 'invoice';
  sourceId: string;
  taxYear: number;
  prevLineId?: string;
  prevExcluded: boolean;
  prevVatMode: 'none' | 'default';
  prevVatRate?: number;
};

const keyOf = (item: { sourceType: 'transaction' | 'invoice'; sourceId: string }): string =>
  `${item.sourceType}:${item.sourceId}`;

const queryErrorDetail = (error: unknown): string =>
  error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'Unbekannter Fehler beim Laden.';

const selectClass = 'rounded-xl border border-control-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

/** The running year when a bundled EÜR catalog exists for it, else the latest one. */
export const DEFAULT_EUR_TAX_YEAR: number = isSupportedEurTaxYear(new Date().getFullYear())
  ? new Date().getFullYear()
  : LATEST_SUPPORTED_EUR_TAX_YEAR;

export const TransactionMatchingView: React.FC<{ onBack: () => void; initialTab?: MatchingTab }> = ({
  onBack,
  initialTab = 'matching',
}) => {
  const isProProduct = getRendererProduct() === 'pro';
  const [activeTab, setActiveTab] = useState<MatchingTab>(initialTab);
  const unlinkTitleId = React.useId();

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showLinked, setShowLinked] = useState(false);
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState(false);
  const [invoiceToUnlink, setInvoiceToUnlink] = useState<{ transactionId: string; invoiceWillBeOverdue: boolean } | null>(null);
  const queryClient = useQueryClient();
  const { notify } = useActionFeedback('transaction-matching');

  const showNotification = (message: string, type: 'success' | 'error' | 'warning' | 'info' = 'success') => {
    notify(type === 'warning' ? 'info' : type, message);
  };

  // Existing invoice matching flow
  const transactionsQuery = useQuery({
    queryKey: ['transactions', { unlinkedOnly: !showLinked }],
    enabled: activeTab === 'matching',
    queryFn: async () => {
      return await ipc.transactions.list({
        type: 'income',
        unlinkedOnly: !showLinked,
      });
    },
  });
  const transactions = transactionsQuery.data ?? [];

  const matchesQuery = useQuery({
    queryKey: ['transaction-matches', selectedTransaction?.id],
    queryFn: async (): Promise<MatchResult | null> => {
      if (!selectedTransaction) return null;
      return await ipc.transactions.findMatches({ transactionId: selectedTransaction.id });
    },
    enabled: activeTab === 'matching' && !!selectedTransaction && !selectedTransaction.linkedInvoiceId,
  });
  const matchData = matchesQuery.data;

  const linkMutation = useMutation({
    mutationFn: async ({ transactionId, invoiceId }: { transactionId: string; invoiceId: string }) => {
      return await ipc.transactions.link({ transactionId, invoiceId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['transaction-matches'] });
      setSelectedTransaction(null);
      showNotification('Transaktion zugeordnet und Rechnung als bezahlt markiert', 'success');
    },
    onError: (error) => {
      showNotification(`Fehler beim Zuordnen: ${String(error)}`, 'error');
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: async (transactionId: string) => {
      return await ipc.transactions.unlink({ transactionId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      setSelectedTransaction(null);
      setShowUnlinkConfirm(false);
      setInvoiceToUnlink(null);
      showNotification('Zuordnung erfolgreich aufgehoben', 'info');
    },
    onError: (error) => {
      showNotification(`Fehler beim Aufheben: ${String(error)}`, 'error');
    },
  });

  const handleUnlinkClick = (transactionId: string) => {
    setInvoiceToUnlink({ transactionId, invoiceWillBeOverdue: true });
    setShowUnlinkConfirm(true);
  };

  const confirmUnlink = () => {
    if (invoiceToUnlink) {
      unlinkMutation.mutate(invoiceToUnlink.transactionId);
    }
  };

  const filteredTransactions = transactions.filter((t) =>
    t.counterparty.toLowerCase().includes(searchQuery.toLowerCase())
    || t.purpose.toLowerCase().includes(searchQuery.toLowerCase())
    || t.amount.toString().includes(searchQuery),
  );

  const unmatchedCount = transactions.filter((t) => !t.linkedInvoiceId).length;
  const toggleVisibilityClass = showLinked ? 'bg-surface-muted text-muted' : 'bg-info-bg text-info-text border border-info-border';
  const toggleVisibilityLabel = showLinked ? 'Nur unzugeordnete' : 'Alle anzeigen';

  // New inline EÜR classification flow
  const [taxYear, setTaxYear] = useState<number>(DEFAULT_EUR_TAX_YEAR);
  const [eurQuery, setEurQuery] = useState('');
  const [eurStatus, setEurStatus] = useState<EurStatus>('unclassified');
  const [eurFlow, setEurFlow] = useState<'all' | 'income' | 'expense'>('all');
  const [eurSelected, setEurSelected] = useState<Set<string>>(new Set());
  const [eurActive, setEurActive] = useState<EurTxItem | null>(null);
  const [eurLineId, setEurLineId] = useState('');
  const [eurVatMode, setEurVatMode] = useState<'none' | 'default'>('none');
  const [eurVatRate, setEurVatRate] = useState<number | undefined>(undefined);
  const [eurExcluded, setEurExcluded] = useState(false);
  const [eurReason, setEurReason] = useState('');
  const [eurUndo, setEurUndo] = useState<{ label: string; reason: string; changes: EurUndo[] } | null>(null);
  const [eurPending, setEurPending] = useState(false);
  const [eurSort, setEurSort] = useState<'date_desc' | 'amount_desc' | 'counterparty_asc'>('date_desc');

  const eurReportQuery = useQuery({
    queryKey: ['eur', 'report', taxYear],
    enabled: activeTab === 'eur',
    queryFn: () => ipc.eur.getReport({ taxYear }),
  });
  const eurReport = eurReportQuery.data;

  const eurItemsQuery = useQuery({
    queryKey: ['eur', 'items', 'transaction', taxYear],
    enabled: activeTab === 'eur',
    queryFn: () =>
      ipc.eur.listItems({
        taxYear,
        sourceType: 'transaction',
        status: 'all',
      }),
  });
  const eurItemsRaw = eurItemsQuery.data ?? [];

  const eurUpsert = useMutation({
    mutationFn: (payload: {
      sourceType: 'transaction' | 'invoice';
      sourceId: string;
      taxYear: number;
      eurLineId?: string;
      excluded?: boolean;
      vatMode?: 'none' | 'default';
      vatRate?: number;
      reason: string;
    }) => ipc.eur.upsertClassification(payload),
  });

  const invalidateEur = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['eur', 'items', 'transaction', taxYear] }),
      queryClient.invalidateQueries({ queryKey: ['eur', 'report', taxYear] }),
      queryClient.invalidateQueries({ queryKey: ['eur', 'items', taxYear] }),
    ]);
  };

  const eurItems = useMemo(() => {
    const rows = eurItemsRaw as EurTxItem[];
    return rows
      .filter((item) => (eurFlow === 'all' ? true : item.flowType === eurFlow))
      .filter((item) => {
        if (eurStatus === 'all') return true;
        if (eurStatus === 'unclassified') return !item.classification?.eurLineId && !item.classification?.excluded;
        if (eurStatus === 'classified') return Boolean(item.classification?.eurLineId) && !item.classification?.excluded;
        return Boolean(item.classification?.excluded);
      })
      .filter((item) => {
        const q = eurQuery.trim().toLowerCase();
        if (!q) return true;
        return (
          item.counterparty.toLowerCase().includes(q)
          || item.purpose.toLowerCase().includes(q)
          || item.date.includes(q)
        );
      })
      .sort((a, b) => {
        if (eurSort === 'date_desc') return b.date.localeCompare(a.date);
        if (eurSort === 'amount_desc') return b.amountGross - a.amountGross;
        return a.counterparty.localeCompare(b.counterparty, 'de');
      });
  }, [eurItemsRaw, eurFlow, eurStatus, eurQuery, eurSort]);

  const eurCounts = useMemo(() => {
    const all = eurItemsRaw as EurTxItem[];
    return {
      all: all.length,
      unclassified: all.filter((item) => !item.classification?.eurLineId && !item.classification?.excluded).length,
      classified: all.filter((item) => item.classification?.eurLineId && !item.classification?.excluded).length,
      excluded: all.filter((item) => item.classification?.excluded).length,
    };
  }, [eurItemsRaw]);

  const eurLineOptions = useMemo(
    () => (eurReport?.rows ?? []).filter((row) => row.kind === 'income' || row.kind === 'expense'),
    [eurReport],
  );

  const eurActiveLineOptions = useMemo(() => {
    if (!eurActive) return eurLineOptions;
    return eurLineOptions.filter((row) => row.kind === eurActive.flowType);
  }, [eurLineOptions, eurActive]);

  useEffect(() => {
    if (!eurActive) return;
    setEurLineId(eurActive.classification?.eurLineId ?? eurActive.suggestedLineId ?? '');
    setEurVatMode(eurActive.classification?.vatMode ?? 'none');
    setEurVatRate(eurActive.classification?.vatRate);
    setEurExcluded(eurActive.classification?.excluded ?? false);
  }, [eurActive]);

  const applyEurSingle = async () => {
    if (!eurActive) return;
    const reason = eurReason.trim();
    if (!reason) {
      showNotification('Bitte eine Begründung für den Audit-Eintrag eingeben.', 'warning');
      return;
    }
    const change: EurUndo = {
      sourceType: eurActive.sourceType,
      sourceId: eurActive.sourceId,
      taxYear,
      prevLineId: eurActive.classification?.eurLineId,
      prevExcluded: eurActive.classification?.excluded ?? false,
      prevVatMode: eurActive.classification?.vatMode ?? 'none',
      prevVatRate: eurActive.classification?.vatRate,
    };

    setEurPending(true);
    try {
      await eurUpsert.mutateAsync({
        sourceType: eurActive.sourceType,
        sourceId: eurActive.sourceId,
        taxYear,
        eurLineId: eurLineId || undefined,
        excluded: eurExcluded,
        vatMode: eurVatMode,
        vatRate: isProProduct ? eurVatRate : undefined,
        reason,
      });
      setEurUndo({ label: 'Einzelklassifizierung', reason, changes: [change] });
      await invalidateEur();
      showNotification('EÜR-Klassifizierung gespeichert', 'success');
    } finally {
      setEurPending(false);
    }
  };

  const selectedEurItems = useMemo(
    () => eurItems.filter((item) => eurSelected.has(keyOf(item))),
    [eurItems, eurSelected],
  );

  const applyEurBulk = async (
    label: string,
    resolver: (item: EurTxItem) => { eurLineId?: string; excluded?: boolean; vatMode?: 'none' | 'default'; vatRate?: number },
  ) => {
    if (selectedEurItems.length === 0) return;
    const reason = eurReason.trim();
    if (!reason) {
      showNotification('Bitte eine Begründung für den Audit-Eintrag eingeben.', 'warning');
      return;
    }

    const changes: EurUndo[] = selectedEurItems.map((item) => ({
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      taxYear,
      prevLineId: item.classification?.eurLineId,
      prevExcluded: item.classification?.excluded ?? false,
      prevVatMode: item.classification?.vatMode ?? 'none',
      prevVatRate: item.classification?.vatRate,
    }));

    setEurPending(true);
    try {
      await Promise.all(
        selectedEurItems.map((item) => {
          const resolved = resolver(item);
          return eurUpsert.mutateAsync({
            sourceType: item.sourceType,
            sourceId: item.sourceId,
            taxYear,
            ...resolved,
            vatRate: isProProduct ? resolved.vatRate : undefined,
            reason,
          });
        }),
      );
      setEurUndo({ label, reason, changes });
      setEurSelected(new Set());
      await invalidateEur();
      showNotification(`${selectedEurItems.length} Einträge klassifiziert`, 'success');
    } finally {
      setEurPending(false);
    }
  };

  const undoEur = async () => {
    if (!eurUndo) return;
    setEurPending(true);
    try {
      await Promise.all(
        eurUndo.changes.map((item) =>
          eurUpsert.mutateAsync({
            sourceType: item.sourceType,
            sourceId: item.sourceId,
            taxYear: item.taxYear,
            eurLineId: item.prevLineId,
            excluded: item.prevExcluded,
            vatMode: item.prevVatMode,
            vatRate: isProProduct ? item.prevVatRate : undefined,
            reason: `Undo: ${eurUndo.label}; ursprüngliche Begründung: ${eurUndo.reason}`,
          }),
        ),
      );
      setEurUndo(null);
      await invalidateEur();
      showNotification('Letzte Aktion rückgängig gemacht', 'info');
    } finally {
      setEurPending(false);
    }
  };

  const getConfidenceBadge = (confidence: 'high' | 'medium' | 'low') => {
    const styles: Record<'high' | 'medium' | 'low', string> = {
      high: 'bg-success-bg text-success-text border-success-border',
      medium: 'bg-warning-bg text-warning-text border-warning-border',
      low: 'bg-surface-muted text-muted border-border',
    };
    const labels: Record<'high' | 'medium' | 'low', string> = {
      high: 'Hohe Übereinstimmung',
      medium: 'Mittlere Übereinstimmung',
      low: 'Geringe Übereinstimmung',
    };
    return (
      <span className={`px-2 py-1 rounded-full text-xs font-medium border ${styles[confidence]}`}>
        {labels[confidence]}
      </span>
    );
  };

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('de-DE', {
      style: 'currency',
      currency: 'EUR',
    }).format(amount);
  };

  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('de-DE', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    });
  };

  const listSummary = activeTab === 'matching'
    ? transactionsQuery.isError
      ? 'Transaktionen nicht verfügbar'
      : transactionsQuery.isLoading
        ? 'Transaktionen werden geladen'
        : `${unmatchedCount} offene Transaktion${unmatchedCount !== 1 ? 'en' : ''}`
    : eurItemsQuery.isError
      ? 'EÜR-Klassifizierungen nicht verfügbar'
      : eurItemsQuery.isLoading
        ? 'EÜR-Klassifizierungen werden geladen'
        : `${eurCounts.unclassified} offene EÜR-Klassifizierungen`;

  return (
    <div className="h-full flex flex-col bg-surface">
      <div className="border-b border-border p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              aria-label="Zurück zur Übersicht"
              className="p-2 rounded-lg text-muted transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              <ArrowLeft size={20} aria-hidden="true" />
            </button>
            <div>
              <h1 className="text-2xl font-black text-foreground">Transaktionen bearbeiten</h1>
              <p className="text-sm text-muted mt-1 tabular-nums">{listSummary}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 rounded-lg border border-border p-1 bg-surface-muted">
            <button
              type="button"
              onClick={() => setActiveTab('matching')}
              aria-pressed={activeTab === 'matching'}
              className={`px-3 py-1.5 text-sm rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${activeTab === 'matching' ? 'bg-surface shadow-sm font-semibold text-foreground' : 'text-muted'}`}
            >
              Rechnungen zuordnen
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('eur')}
              aria-pressed={activeTab === 'eur'}
              className={`px-3 py-1.5 text-sm rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${activeTab === 'eur' ? 'bg-surface shadow-sm font-semibold text-foreground' : 'text-muted'}`}
            >
              EÜR klassifizieren
            </button>
          </div>
        </div>

        {activeTab === 'matching' ? (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={18} aria-hidden="true" />
            <input
              type="text"
              placeholder="Transaktion suchen"
              aria-label="Transaktion suchen"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-control-border bg-surface rounded-lg text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                aria-label="Suche zurücksetzen"
                className="absolute right-3 top-1/2 -translate-y-1/2 rounded-sm p-1 text-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              >
                <X size={18} aria-hidden="true" />
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={taxYear}
              aria-label="Steuerjahr"
              onChange={(e) => setTaxYear(Number(e.target.value))}
              className={selectClass}
            >
              {SUPPORTED_EUR_TAX_YEARS.map((year) => <option key={year} value={year}>{year}</option>)}
            </select>
            <input
              value={eurQuery}
              onChange={(e) => setEurQuery(e.target.value)}
              placeholder="Suche Gegenpartei/Zweck"
              aria-label="EÜR-Einträge durchsuchen"
              className="rounded-xl border border-control-border bg-surface px-3 py-2 text-sm min-w-[220px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            />
            <select
              value={eurStatus}
              aria-label="EÜR-Status filtern"
              onChange={(e) => setEurStatus(e.target.value as EurStatus)}
              className={selectClass}
            >
              <option value="unclassified">Unklassifiziert</option>
              <option value="classified">Klassifiziert</option>
              <option value="excluded">Ausgeschlossen</option>
              <option value="all">Alle</option>
            </select>
            <select
              value={eurFlow}
              aria-label="Zahlungsrichtung filtern"
              onChange={(e) => setEurFlow(e.target.value as 'all' | 'income' | 'expense')}
              className={selectClass}
            >
              <option value="all">Alle Typen</option>
              <option value="income">Einnahmen</option>
              <option value="expense">Ausgaben</option>
            </select>
            <select
              value={eurSort}
              aria-label="EÜR-Einträge sortieren"
              onChange={(e) => setEurSort(e.target.value as 'date_desc' | 'amount_desc' | 'counterparty_asc')}
              className={selectClass}
            >
              <option value="date_desc">Neueste zuerst</option>
              <option value="amount_desc">Betrag absteigend</option>
              <option value="counterparty_asc">Name A-Z</option>
            </select>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                if (eurItems.length === 0) return;
                setEurSelected(new Set(eurItems.map((item) => keyOf(item))));
              }}
            >
              Alle wählen
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setEurSelected(new Set())}>
              Auswahl löschen
            </Button>
          </div>
        )}
      </div>

      <div className="flex-1 flex overflow-hidden">
        {activeTab === 'matching' ? (
          <>
            <div className="w-1/2 border-r border-border overflow-y-auto">
              <div className="p-4">
                <button
                  type="button"
                  onClick={() => setShowLinked(!showLinked)}
                  aria-pressed={showLinked}
                  className={`px-4 py-2 rounded-lg font-medium text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${toggleVisibilityClass}`}
                >
                  {toggleVisibilityLabel}
                </button>
              </div>
              {transactionsQuery.isError ? (
                <div className="p-4">
                  <ErrorState
                    title="Transaktionen konnten nicht geladen werden"
                    description={queryErrorDetail(transactionsQuery.error)}
                    onRetry={() => void transactionsQuery.refetch()}
                  />
                </div>
              ) : transactionsQuery.isLoading ? (
                <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted">
                  <Spinner size="md" />
                  <p role="status" className="text-sm font-medium">Transaktionen werden geladen …</p>
                </div>
              ) : filteredTransactions.length === 0 ? (
                <div className="p-4">
                  <EmptyState
                    title={searchQuery ? 'Keine Transaktion passt zur Suche' : 'Keine offenen Transaktionen'}
                    description={searchQuery
                      ? 'Prüfe den Suchbegriff oder setze die Suche zurück, um alle Transaktionen zu sehen.'
                      : 'Importiere einen Kontoauszug als CSV, danach kannst du hier Rechnungen zuordnen.'}
                  />
                </div>
              ) : (
                <div className="p-4 space-y-2">
                  {filteredTransactions.map((transaction) => {
                    const isSelected = selectedTransaction?.id === transaction.id;
                    const isLinked = Boolean(transaction.linkedInvoiceId);

                    let rowClass = 'border-border hover:border-control-border';
                    if (isSelected) {
                      rowClass = 'border-info bg-info-bg';
                    } else if (isLinked) {
                      rowClass = 'border-success-border bg-success-bg hover:border-success';
                    }

                    return (
                      <button
                        type="button"
                        key={transaction.id}
                        onClick={() => setSelectedTransaction(transaction)}
                        aria-pressed={isSelected}
                        className={`w-full text-left p-4 rounded-lg border-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${rowClass}`}
                      >
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              {isLinked ? (
                                <CheckCircle2 size={16} className="text-success-text flex-shrink-0" aria-hidden="true" />
                              ) : (
                                <AlertCircle size={16} className="text-warning-text flex-shrink-0" aria-hidden="true" />
                              )}
                              <span className="font-semibold text-foreground truncate">
                                {transaction.counterparty}
                              </span>
                            </div>
                            <p className="text-sm text-muted line-clamp-2">{transaction.purpose}</p>
                          </div>
                          <div className="text-right ml-4 flex-shrink-0">
                            <div className="text-lg font-bold tabular-nums text-success-text">
                              {formatCurrency(transaction.amount)}
                            </div>
                            <div className="text-xs text-muted tabular-nums">{formatDate(transaction.date)}</div>
                          </div>
                        </div>
                        {isLinked && (
                          <div className="flex items-center gap-2 mt-2 pt-2 border-t border-success-border">
                            <Link2 size={14} className="text-success-text" aria-hidden="true" />
                            <span className="text-xs text-success-text font-medium">Zugeordnet</span>
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="w-1/2 overflow-y-auto bg-surface-muted">
              {!selectedTransaction ? (
                <div className="flex flex-col items-center justify-center h-full p-8">
                  <EmptyState
                    title="Keine Transaktion ausgewählt"
                    description="Wähle links eine Transaktion aus, um passende offene Rechnungen zu sehen."
                    className="border-0 bg-transparent"
                  />
                </div>
              ) : selectedTransaction.linkedInvoiceId ? (
                <div className="p-6">
                  <div className="bg-surface rounded-lg border border-success-border p-6">
                    <div className="flex items-center gap-3 mb-4">
                      <CheckCircle2 size={24} className="text-success-text" aria-hidden="true" />
                      <h2 className="text-xl font-bold text-foreground">Bereits zugeordnet</h2>
                    </div>
                    <p className="text-muted mb-6">
                      Diese Transaktion ist bereits einer Rechnung zugeordnet.
                    </p>
                    <button
                      type="button"
                      onClick={() => handleUnlinkClick(selectedTransaction.id)}
                      disabled={unlinkMutation.isPending}
                      className="px-4 py-2 rounded-lg font-medium text-sm transition-colors flex items-center gap-2 border border-error-border bg-error-bg text-error-text hover:bg-error-bg/80 disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    >
                      <Unlink size={16} aria-hidden="true" />
                      Zuordnung aufheben
                    </button>
                  </div>
                </div>
              ) : (
                <div className="p-6">
                  <h2 className="text-lg font-bold text-foreground mb-4">Passende Rechnungen</h2>

                  {matchesQuery.isError ? (
                    <ErrorState
                      title="Rechnungsvorschläge konnten nicht geladen werden"
                      description={queryErrorDetail(matchesQuery.error)}
                      onRetry={() => void matchesQuery.refetch()}
                    />
                  ) : matchesQuery.isLoading ? (
                    <div className="flex items-center justify-center h-64">
                      <Spinner size="md" />
                    </div>
                  ) : !matchData || matchData.suggestions.length === 0 ? (
                    <div className="bg-surface rounded-lg border border-border p-8">
                      <EmptyState
                        title="Keine passende Rechnung gefunden"
                        description="Es gibt keine offenen Rechnungen mit passendem Betrag oder Verwendungszweck zu dieser Transaktion."
                        className="border-0 bg-transparent px-0 py-0"
                      />
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {matchData.suggestions.map((suggestion) => {
                        const alreadyPaid = suggestion.invoice.payments?.reduce(
                          (sum, p) => sum + p.amount,
                          0,
                        ) || 0;
                        const remaining = suggestion.invoice.amount - alreadyPaid;

                        return (
                          <div
                            key={suggestion.invoice.id}
                            className="bg-surface rounded-lg border-2 border-border hover:border-info-border transition-colors p-4"
                          >
                            <div className="flex items-start justify-between mb-3">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-2">
                                  <span className="font-bold text-foreground">{suggestion.invoice.number}</span>
                                  {getConfidenceBadge(suggestion.confidence)}
                                </div>
                                <p className="text-sm text-muted mb-1">
                                  <User size={14} className="inline mr-1" aria-hidden="true" />
                                  {suggestion.invoice.client}
                                </p>
                                <p className="text-sm text-muted">
                                  <Calendar size={14} className="inline mr-1" aria-hidden="true" />
                                  Fällig: <span className="tabular-nums">{formatDate(suggestion.invoice.dueDate)}</span>
                                </p>
                              </div>
                              <div className="text-right ml-4">
                                <div className="text-lg font-bold tabular-nums text-foreground">
                                  {formatCurrency(remaining)}
                                </div>
                                <div className="text-xs text-muted">offen</div>
                              </div>
                            </div>

                            <div className="space-y-1 mb-4 pb-4 border-b border-border-subtle">
                              {suggestion.matchReasons.map((reason, reasonIdx) => (
                                <div key={reasonIdx} className="flex items-center gap-2 text-sm text-muted">
                                  <CheckCircle2 size={14} className="text-success-text flex-shrink-0" aria-hidden="true" />
                                  <span>{reason}</span>
                                </div>
                              ))}
                            </div>

                            <Button
                              fullWidth
                              onClick={() => linkMutation.mutate({
                                transactionId: selectedTransaction.id,
                                invoiceId: suggestion.invoice.id,
                              })}
                              disabled={linkMutation.isPending}
                            >
                              <Link2 size={16} aria-hidden="true" />
                              Zuordnen und als bezahlt markieren
                            </Button>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="w-1/2 border-r border-border overflow-y-auto">
              {eurUndo && (
                <div className="m-4 rounded-xl border border-warning-border bg-warning-bg p-3 flex items-center justify-between gap-2">
                  <span className="text-xs text-warning-text">{eurUndo.label}</span>
                  <button
                    type="button"
                    onClick={() => void undoEur()}
                    disabled={eurPending}
                    className="px-2 py-1 rounded-md border border-warning-border bg-surface text-xs font-semibold text-warning-text hover:bg-warning-bg disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  >
                    Rückgängig
                  </button>
                </div>
              )}

              <div className="m-4 rounded-xl border border-border p-3">
                <div className="text-xs text-muted mb-2 tabular-nums">Bulk-Aktionen ({eurSelected.size} ausgewählt)</div>
                <div className="grid grid-cols-1 gap-2">
                  <label className="text-xs font-semibold text-foreground">
                    Begründung (Audit) <span className="text-error-text">*</span>
                    <input
                      aria-label="Begründung für EÜR-Änderung"
                      value={eurReason}
                      onChange={(event) => setEurReason(event.target.value)}
                      className="mt-1 w-full rounded-lg border border-control-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                      placeholder="z. B. Beleg geprüft und Kontierung bestätigt"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      void applyEurBulk('Bulk: Vorschlag anwenden', (item) => ({
                        eurLineId: item.suggestedLineId,
                        excluded: false,
                        vatMode: item.classification?.vatMode ?? 'none',
                        vatRate: item.classification?.vatRate,
                      }))
                    }
                    disabled={eurSelected.size === 0 || eurPending || eurReason.trim().length === 0}
                    className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-left text-foreground hover:bg-surface-muted transition-colors disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  >
                    <Check size={14} className="text-info-text flex-shrink-0" aria-hidden="true" />
                    Vorschlag anwenden
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void applyEurBulk('Bulk: Als privat/Transfer markieren', () => ({
                        eurLineId: undefined,
                        excluded: true,
                        vatMode: 'none',
                        vatRate: undefined,
                      }))
                    }
                    disabled={eurSelected.size === 0 || eurPending || eurReason.trim().length === 0}
                    className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-left text-foreground hover:bg-surface-muted transition-colors disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  >
                    <Ban size={14} className="text-error-text flex-shrink-0" aria-hidden="true" />
                    Als privat/Transfer markieren
                  </button>
                </div>
              </div>

              {eurItemsQuery.isError ? (
                <div className="p-4">
                  <ErrorState
                    title="EÜR-Einträge konnten nicht geladen werden"
                    description={queryErrorDetail(eurItemsQuery.error)}
                    onRetry={() => void eurItemsQuery.refetch()}
                  />
                </div>
              ) : eurItemsQuery.isLoading ? (
                <div className="flex flex-col items-center justify-center gap-3 py-16 text-muted">
                  <Spinner size="md" />
                  <p role="status" className="text-sm font-medium">EÜR-Einträge werden geladen …</p>
                </div>
              ) : eurItems.length === 0 ? (
                <div className="p-4">
                  <EmptyState
                    title="Keine EÜR-Einträge für diesen Filter"
                    description="Alle Transaktionen dieses Filters sind bereits bearbeitet. Wähle oben einen anderen Status."
                    className="border-0 bg-transparent"
                  />
                </div>
              ) : (
                <div className="p-4 space-y-2">
                  {eurItems.map((item) => {
                    const key = keyOf(item);
                    const isActive = eurActive?.sourceType === item.sourceType && eurActive.sourceId === item.sourceId;
                    return (
                      <div
                        key={key}
                        className={`p-3 rounded-xl border ${isActive ? 'border-foreground bg-surface-muted' : 'border-border hover:border-control-border'}`}
                      >
                        <div className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            className="mt-1"
                            aria-label={`${item.counterparty} auswählen`}
                            checked={eurSelected.has(key)}
                            onChange={(e) => {
                              const next = new Set(eurSelected);
                              if (e.target.checked) next.add(key);
                              else next.delete(key);
                              setEurSelected(next);
                            }}
                          />
                          <button
                            type="button"
                            onClick={() => setEurActive(item)}
                            aria-pressed={isActive}
                            className="flex-1 text-left rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                          >
                            <div className="flex items-center gap-1.5 text-xs text-muted">
                              {item.classification?.excluded ? (
                                <XCircle size={14} className="text-error-text" aria-hidden="true" />
                              ) : item.classification?.eurLineId ? (
                                <CheckCircle2 size={14} className="text-success-text" aria-hidden="true" />
                              ) : (
                                <AlertCircle size={14} className="text-warning-text" aria-hidden="true" />
                              )}
                              <span className="tabular-nums">{item.date}</span>
                              <span aria-hidden="true">·</span>
                              <span>{item.flowType === 'income' ? 'Einnahme' : 'Ausgabe'}</span>
                            </div>
                            <div className="text-sm font-semibold text-foreground truncate">{item.counterparty}</div>
                            <div className="text-xs text-muted truncate">{item.purpose}</div>
                            <div className={`text-sm font-bold mt-1 tabular-nums ${
                              item.flowType === 'income' ? 'text-success-text' : 'text-error-text'
                            }`}>
                              {item.flowType === 'income' ? '+' : '-'}{formatCurrency(item.amountGross)}
                            </div>
                            <div className="flex flex-wrap gap-1 mt-2">
                              {item.classification?.excluded ? (
                                <span className="text-xs px-2 py-0.5 rounded-full border border-error-border bg-error-bg text-error-text">Ausgeschlossen</span>
                              ) : item.classification?.eurLineId ? (
                                <span className="text-xs px-2 py-0.5 rounded-full border border-success-border bg-success-bg text-success-text">Klassifiziert</span>
                              ) : (
                                <span className="text-xs px-2 py-0.5 rounded-full border border-warning-border bg-warning-bg text-warning-text">Offen</span>
                              )}
                              {item.suggestedLineId && !item.classification?.eurLineId && !item.classification?.excluded && (
                                <span className="text-xs px-2 py-0.5 rounded-full border border-info-border bg-info-bg text-info-text">Vorschlag</span>
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

            <div className="w-1/2 overflow-y-auto bg-surface-muted p-6">
              {!eurActive ? (
                <div className="h-full flex items-center justify-center">
                  <EmptyState
                    title="Kein Eintrag ausgewählt"
                    description="Wähle links eine Transaktion aus, um sie einer EÜR-Kennziffer zuzuordnen."
                    className="border-0 bg-transparent"
                  />
                </div>
              ) : (
                <div className="bg-surface rounded-xl border border-border p-5 space-y-4">
                  <div>
                    <label className="text-xs font-semibold text-foreground">
                      Begründung (Audit) <span className="text-error-text">*</span>
                      <input
                        aria-label="Begründung für EÜR-Änderung"
                        value={eurReason}
                        onChange={(event) => setEurReason(event.target.value)}
                        className="mt-1 w-full rounded-xl border border-control-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                        placeholder="z. B. Beleg geprüft und Kontierung bestätigt"
                      />
                    </label>
                  </div>

                  <div>
                    <h2 className="text-lg font-bold text-foreground">EÜR-Klassifizierung</h2>
                    <p className="text-sm text-muted">Direkt in der Bank-Ansicht klassifizieren.</p>
                  </div>

                  <div className="text-sm text-muted">
                    <div className="font-semibold text-foreground">{eurActive.counterparty}</div>
                    <div>{eurActive.purpose}</div>
                    <div className="font-semibold mt-1 tabular-nums text-foreground">{formatCurrency(eurActive.amountGross)}</div>
                  </div>

                  {eurReportQuery.isError && (
                    <div className="flex items-start gap-2 rounded-lg border border-warning-border bg-warning-bg p-3 text-xs text-warning-text">
                      <TriangleAlert size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                      Kennziffern konnten nicht geladen werden. Die Auswahl ist deshalb leer.
                    </div>
                  )}

                  {eurActive.suggestedLineId && (
                    <button
                      type="button"
                      onClick={() => {
                        setEurLineId(eurActive.suggestedLineId ?? '');
                        setEurExcluded(false);
                      }}
                      className="w-full rounded-lg border border-info-border bg-info-bg px-3 py-2 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    >
                      <div className="text-xs text-info-text font-semibold">Vorschlag übernehmen</div>
                      <div className="text-xs text-info-text">{eurActive.suggestionReason ?? 'Automatischer Vorschlag'}</div>
                    </button>
                  )}

                  <div>
                    <label className="text-xs font-semibold text-foreground" htmlFor="tm-eur-line">Kennziffer</label>
                    <select
                      id="tm-eur-line"
                      value={eurLineId}
                      onChange={(e) => setEurLineId(e.target.value)}
                      disabled={eurExcluded}
                      className="mt-1 w-full rounded-xl border border-control-border bg-surface px-3 py-2 text-sm disabled:bg-surface-muted disabled:text-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    >
                      <option value="">Nicht zugeordnet</option>
                      {eurActiveLineOptions.map((line) => (
                        <option key={line.lineId} value={line.lineId}>
                          {line.kennziffer ? `${line.kennziffer} - ` : ''}{line.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-xs font-semibold text-foreground" htmlFor="tm-eur-vat-mode">USt. Modus</label>
                    <select
                      id="tm-eur-vat-mode"
                      value={eurVatMode}
                      onChange={(e) => setEurVatMode(e.target.value as 'none' | 'default')}
                      className="mt-1 w-full rounded-xl border border-control-border bg-surface px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    >
                      <option value="none">Keine USt. Umrechnung</option>
                      <option value="default">Default USt. (Netto)</option>
                    </select>
                  </div>

                  {isProProduct && eurVatMode === 'default' && (
                    <div>
                      <label className="text-xs font-semibold text-foreground" htmlFor="tm-eur-vat-rate">USt.-Satz (%)</label>
                      <input
                        id="tm-eur-vat-rate"
                        type="number"
                        min="0"
                        max="100"
                        step="0.01"
                        value={eurVatRate ?? ''}
                        onChange={(e) => setEurVatRate(e.target.value === '' ? undefined : Number(e.target.value))}
                        className="mt-1 w-full rounded-xl border border-control-border bg-surface px-3 py-2 text-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                        placeholder="z. B. 19"
                      />
                      {eurActive.vatWarning && <p className="mt-1 text-xs text-warning-text">{eurActive.vatWarning}</p>}
                    </div>
                  )}

                  <label className="flex items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={eurExcluded}
                      onChange={(e) => setEurExcluded(e.target.checked)}
                    />
                    Privat/Transfer ausschließen
                  </label>

                  <div className="flex items-center gap-2">
                    <Button onClick={() => void applyEurSingle()} disabled={eurPending || eurReason.trim().length === 0}>
                      {eurPending ? 'Speichern...' : 'Klassifizierung speichern'}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setEurLineId('');
                        setEurExcluded(false);
                        setEurVatMode('none');
                        setEurVatRate(undefined);
                      }}
                    >
                      Zurücksetzen
                    </Button>
                  </div>

                  <div className="pt-3 border-t border-border-subtle text-xs text-muted flex items-center gap-1">
                    <Layers size={14} aria-hidden="true" />
                    Änderungen sind sofort in EÜR-Report und Export sichtbar.
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <Modal
        open={showUnlinkConfirm}
        onClose={() => {
          setShowUnlinkConfirm(false);
          setInvoiceToUnlink(null);
        }}
        titleId={unlinkTitleId}
        className="max-w-md p-6"
      >
        <div className="flex items-start gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-warning-bg flex items-center justify-center flex-shrink-0">
            <TriangleAlert size={20} className="text-warning-text" aria-hidden="true" />
          </div>
          <div className="flex-1">
            <h3 id={unlinkTitleId} className="text-lg font-bold text-foreground mb-2">
              Zuordnung wirklich aufheben?
            </h3>
            <p className="text-sm text-muted mb-2">
              Diese Rechnung wird wieder als unbezahlt markiert.
            </p>
            {invoiceToUnlink?.invoiceWillBeOverdue && (
              <p className="flex items-start gap-2 text-sm text-warning-text font-medium">
                <TriangleAlert size={16} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                Die Rechnung könnte dadurch wieder überfällig werden.
              </p>
            )}
          </div>
        </div>

        <div className="flex gap-3 mt-6">
          <Button
            variant="danger"
            fullWidth
            onClick={confirmUnlink}
            loading={unlinkMutation.isPending}
          >
            Ja, aufheben
          </Button>
          <Button
            variant="ghost"
            fullWidth
            onClick={() => {
              setShowUnlinkConfirm(false);
              setInvoiceToUnlink(null);
            }}
            disabled={unlinkMutation.isPending}
          >
            Abbrechen
          </Button>
        </div>
      </Modal>

    </div>
  );
};
