import {
  Badge, Button, Card, CardHeader, Checkbox, ConfirmDialog, EmptyState, ErrorState, IconButton, Input,
  SegmentedControl, Select, useActionFeedback,
} from '@billme/ui';
import { defaultEurTaxYear, eurTaxYearOptions } from '@billme/accounting-shared';
import React, { useEffect, useMemo, useState } from 'react';
import { Link2, Unlink, CheckCircle2, Search, X, Layers, Check, Ban, TriangleAlert } from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getRendererProduct, ipc } from '../runtime-api';
import { Spinner } from '../ui/components/Spinner';
import { isNeutralEurKind, neutralEurKindLabels, type NeutralEurKind } from './eur/categories';
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
  sourceType: 'transaction' | 'invoice' | 'manual';
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
  suggestedKind?: NeutralEurKind;
  kind?: string;
  transitHint?: string;
  classification?: {
    eurLineId?: string;
    excluded: boolean;
    vatMode: 'none' | 'default';
    vatRate?: number;
    updatedAt: string;
  };
};

/** Lite: Privatentnahme, Privateinlage or Geldtransit instead of a line; 'excluded' is the old exclusion. */
type EurDecision = 'flow' | 'excluded' | NeutralEurKind;
const eurKindOf = (item: EurTxItem): NeutralEurKind | undefined => (isNeutralEurKind(item.kind) ? item.kind : undefined);
const eurDecided = (item: EurTxItem): boolean => Boolean(item.classification?.eurLineId || item.classification?.excluded || item.kind);

type EurUndo = {
  sourceType: 'transaction' | 'invoice' | 'manual';
  sourceId: string;
  taxYear: number;
  prevLineId?: string;
  prevExcluded: boolean;
  prevKind?: NeutralEurKind;
  prevVatMode: 'none' | 'default';
  prevVatRate?: number;
};

const keyOf = (item: { sourceType: 'transaction' | 'invoice' | 'manual'; sourceId: string }): string =>
  `${item.sourceType}:${item.sourceId}`;

const queryErrorDetail = (error: unknown): string =>
  error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'Unbekannter Fehler beim Laden.';

const queueRow = 'border-b border-border px-3 py-2.5 transition-colors motion-reduce:transition-none';
const queueRowCurrent = 'bg-accent-50 shadow-[inset_3px_0_0_var(--color-accent)]';
const cardHead = 'border-b border-border px-3.5 py-3';
const banner = 'flex items-start gap-2.5 rounded-control border px-3 py-2.5 text-control';

/** The running year; a year after the newest bundled form is calculated with it (provisional). */
export const DEFAULT_EUR_TAX_YEAR: number = defaultEurTaxYear();

/** Invoice matching and EÜR classification of bank transactions: a queue next to its detail. */
export const TransactionMatchingView: React.FC<{ initialTab?: MatchingTab }> = ({
  initialTab = 'matching',
}) => {
  const isProProduct = getRendererProduct() === 'pro';
  const [activeTab, setActiveTab] = useState<MatchingTab>(initialTab);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [allocationInputs, setAllocationInputs] = useState<Record<string, string>>({});
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
  const transactions = (transactionsQuery.data ?? []).filter((transaction) => !transaction.matchedManualEntryId);

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
    mutationFn: async ({ transactionId, invoiceId, appliedAmountCents }: { transactionId: string; invoiceId: string; appliedAmountCents: number }) => {
      return await ipc.transactions.link({ transactionId, invoiceId, appliedAmountCents });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['transaction-matches'] });
      setSelectedTransaction(null);
      void queryClient.invalidateQueries({ queryKey: ['eur'] });
      void queryClient.invalidateQueries({ queryKey: ['lite-vat'] });
      showNotification('Zahlung zugeordnet. Ein Restbetrag bleibt in den Buchungen sichtbar.', 'success');
    },
    onError: (error) => {
      showNotification(`Fehler beim Zuordnen: ${error instanceof Error ? error.message : String(error)}`, 'error');
    },
  });

  const unlinkMutation = useMutation({
    mutationFn: async (transactionId: string) => {
      return await ipc.transactions.unlink({ transactionId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['transaction-matches'] });
      setSelectedTransaction(null);
      setShowUnlinkConfirm(false);
      setInvoiceToUnlink(null);
      showNotification('Zuordnung erfolgreich aufgehoben', 'info');
    },
    onError: (error) => {
      showNotification(`Fehler beim Aufheben: ${error instanceof Error ? error.message : String(error)}`, 'error');
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
  const [eurDecision, setEurDecision] = useState<EurDecision>('flow');
  const eurExcluded = eurDecision !== 'flow';
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
      sourceType: 'transaction' | 'invoice' | 'manual';
      sourceId: string;
      taxYear: number;
      eurLineId?: string;
      excluded?: boolean;
      kind?: NeutralEurKind;
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
      // The open count in the progress card above the queue (AccountsView).
      queryClient.invalidateQueries({ queryKey: ['eur', 'accounts-unclassified-transactions'] }),
    ]);
  };

  const eurItems = useMemo(() => {
    const rows = eurItemsRaw as EurTxItem[];
    return rows
      .filter((item) => (eurFlow === 'all' ? true : item.flowType === eurFlow))
      .filter((item) => {
        if (eurStatus === 'all') return true;
        if (eurStatus === 'unclassified') return !eurDecided(item);
        if (eurStatus === 'classified') return eurDecided(item) && !item.classification?.excluded;
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
      unclassified: all.filter((item) => !eurDecided(item)).length,
      classified: all.filter((item) => eurDecided(item) && !item.classification?.excluded).length,
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
    setEurDecision((isProProduct ? undefined : eurKindOf(eurActive)) ?? (eurActive.classification?.excluded ? 'excluded' : 'flow'));
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
      prevKind: eurKindOf(eurActive),
      prevVatMode: eurActive.classification?.vatMode ?? 'none',
      prevVatRate: eurActive.classification?.vatRate,
    };

    setEurPending(true);
    try {
      await eurUpsert.mutateAsync({
        sourceType: eurActive.sourceType,
        sourceId: eurActive.sourceId,
        taxYear,
        eurLineId: eurExcluded ? undefined : eurLineId || undefined,
        excluded: eurDecision === 'excluded',
        kind: isNeutralEurKind(eurDecision) ? eurDecision : undefined,
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
    resolver: (item: EurTxItem) => { eurLineId?: string; excluded?: boolean; kind?: NeutralEurKind; vatMode?: 'none' | 'default'; vatRate?: number },
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
      prevKind: eurKindOf(item),
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
            kind: item.prevKind,
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
    const tones = { high: 'success', medium: 'warning', low: 'neutral' } as const;
    const labels: Record<'high' | 'medium' | 'low', string> = {
      high: 'Hohe Übereinstimmung',
      medium: 'Mittlere Übereinstimmung',
      low: 'Geringe Übereinstimmung',
    };
    return <Badge tone={tones[confidence]}>{labels[confidence]}</Badge>;
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


  const reasonInput = (
    <Input
      label="Begründung (Audit)"
      required
      aria-label="Begründung für EÜR-Änderung"
      value={eurReason}
      onChange={(event) => setEurReason(event.target.value)}
      placeholder="z. B. Beleg geprüft und Kontierung bestätigt"
      fullWidth
    />
  );

  return (
    <div className="flex flex-col gap-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          aria-label="Bearbeitungsart"
          value={activeTab}
          onChange={setActiveTab}
          options={[
            { value: 'matching', label: 'Rechnungen zuordnen' },
            { value: 'eur', label: 'EÜR klassifizieren' },
          ]}
        />
        {activeTab === 'matching' ? (
          <div className="relative min-w-56 flex-1">
            <Input
              type="text"
              placeholder="Transaktion suchen"
              aria-label="Transaktion suchen"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              prefix={<Search size={14} />}
              className="pr-8"
              fullWidth
            />
            {searchQuery && (
              <IconButton
                size="sm"
                tooltip={false}
                aria-label="Suche zurücksetzen"
                onClick={() => setSearchQuery('')}
                className="absolute right-0.5 top-0.5"
              >
                <X size={14} aria-hidden="true" />
              </IconButton>
            )}
          </div>
        ) : (
          <>
            <Select value={taxYear} aria-label="Steuerjahr" onChange={(e) => setTaxYear(Number(e.target.value))}>
              {eurTaxYearOptions().map((year) => <option key={year} value={year}>{year}</option>)}
            </Select>
            <Input
              value={eurQuery}
              onChange={(e) => setEurQuery(e.target.value)}
              placeholder="Suche Gegenpartei/Zweck"
              aria-label="EÜR-Einträge durchsuchen"
              className="min-w-56"
            />
            <Select value={eurStatus} aria-label="EÜR-Status filtern" onChange={(e) => setEurStatus(e.target.value as EurStatus)}>
              <option value="unclassified">Unklassifiziert</option>
              <option value="classified">Klassifiziert</option>
              <option value="excluded">Ausgeschlossen</option>
              <option value="all">Alle</option>
            </Select>
            <Select
              value={eurFlow}
              aria-label="Zahlungsrichtung filtern"
              onChange={(e) => setEurFlow(e.target.value as 'all' | 'income' | 'expense')}
            >
              <option value="all">Alle Typen</option>
              <option value="income">Einnahmen</option>
              <option value="expense">Ausgaben</option>
            </Select>
            <Select
              value={eurSort}
              aria-label="EÜR-Einträge sortieren"
              onChange={(e) => setEurSort(e.target.value as 'date_desc' | 'amount_desc' | 'counterparty_asc')}
            >
              <option value="date_desc">Neueste zuerst</option>
              <option value="amount_desc">Betrag absteigend</option>
              <option value="counterparty_asc">Name A-Z</option>
            </Select>
          </>
        )}
      </div>

      <div className="grid gap-3.5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        {activeTab === 'matching' ? (
          <>
            <Card padding="none" className="overflow-hidden">
              <CardHeader
                title={listSummary}
                actions={
                  <Button variant="secondary" size="sm" onClick={() => setShowLinked(!showLinked)} aria-pressed={showLinked}>
                    {toggleVisibilityLabel}
                  </Button>
                }
                className={cardHead}
              />
              {transactionsQuery.isError ? (
                <ErrorState
                  title="Transaktionen konnten nicht geladen werden"
                  description={queryErrorDetail(transactionsQuery.error)}
                  onRetry={() => void transactionsQuery.refetch()}
                  className="m-3.5"
                />
              ) : transactionsQuery.isLoading ? (
                <div className="flex flex-col items-center justify-center gap-3 py-10 text-muted">
                  <Spinner size="md" />
                  <p role="status" className="text-control">Transaktionen werden geladen …</p>
                </div>
              ) : filteredTransactions.length === 0 ? (
                <EmptyState
                  title={searchQuery ? 'Keine Transaktion passt zur Suche' : 'Keine offenen Transaktionen'}
                  description={searchQuery
                    ? 'Prüfe den Suchbegriff oder setze die Suche zurück, um alle Transaktionen zu sehen.'
                    : 'Importiere einen Kontoauszug als CSV, danach kannst du hier Rechnungen zuordnen.'}
                />
              ) : (
                <div className="max-h-128 overflow-y-auto">
                  {filteredTransactions.map((transaction) => {
                    const isSelected = selectedTransaction?.id === transaction.id;
                    return (
                      <button
                        type="button"
                        key={transaction.id}
                        onClick={() => setSelectedTransaction(transaction)}
                        aria-pressed={isSelected}
                        className={`block w-full text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring ${queueRow} ${isSelected ? queueRowCurrent : 'hover:bg-surface-muted'}`}
                      >
                        <span className="flex items-baseline gap-2">
                          <span className="min-w-0 flex-1 truncate text-label font-semibold text-foreground">{transaction.counterparty}</span>
                          <span className="shrink-0 text-label font-semibold tabular-nums text-foreground">{formatCurrency(transaction.amount)}</span>
                        </span>
                        <span className="mt-1 flex flex-wrap items-center gap-1.5">
                          <span className="text-caption tabular-nums text-muted">{formatDate(transaction.date)}</span>
                          {transaction.linkedInvoiceId && (
                            <Badge tone="success"><Link2 size={12} aria-hidden="true" />Zugeordnet</Badge>
                          )}
                        </span>
                        <span className="mt-1 block truncate text-caption text-muted">{transaction.purpose}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </Card>

            <Card padding="none">
              {!selectedTransaction ? (
                <EmptyState
                  title="Keine Transaktion ausgewählt"
                  description="Wähle links eine Transaktion aus, um passende offene Rechnungen zu sehen."
                />
              ) : (
                <>
                  <CardHeader
                    title={selectedTransaction.counterparty}
                    count={<span className="font-bold tabular-nums text-foreground">{formatCurrency(selectedTransaction.amount)}</span>}
                    className={cardHead}
                  />
                  <div className="flex flex-col gap-2.5 p-3.5">
                    <p className="text-caption text-muted">
                      <span className="tabular-nums">{formatDate(selectedTransaction.date)}</span> · {selectedTransaction.purpose}
                    </p>
                    {selectedTransaction.linkedInvoiceId ? (
                      <>
                        <div className={`${banner} border-success-border bg-success-bg text-success-text`}>
                          <CheckCircle2 size={16} className="mt-px shrink-0" aria-hidden="true" />
                          <span className="min-w-0 flex-1">
                            <strong className="font-semibold">Bereits zugeordnet.</strong> {formatCurrency((selectedTransaction.appliedAmountCents ?? Math.round(selectedTransaction.amount * 100)) / 100)} für die Rechnung; Rest {formatCurrency((selectedTransaction.unallocatedAmountCents ?? 0) / 100)}.
                          </span>
                        </div>
                        <div>
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => handleUnlinkClick(selectedTransaction.id)}
                            disabled={unlinkMutation.isPending}
                          >
                            <Unlink size={14} aria-hidden="true" />
                            Zuordnung aufheben
                          </Button>
                        </div>
                      </>
                    ) : (
                      <>
                        <h3 className="text-caption font-medium text-foreground-secondary">Passende Rechnungen</h3>
                        {matchesQuery.isError ? (
                          <ErrorState
                            title="Rechnungsvorschläge konnten nicht geladen werden"
                            description={queryErrorDetail(matchesQuery.error)}
                            onRetry={() => void matchesQuery.refetch()}
                          />
                        ) : matchesQuery.isLoading ? (
                          <div className="flex items-center justify-center py-10">
                            <Spinner size="md" />
                          </div>
                        ) : !matchData || matchData.suggestions.length === 0 ? (
                          !isProProduct && selectedTransaction.amount < 0 ? (
                            <EmptyState
                              title="Keine Rechnung zu dieser Ausgabe"
                              description="Ausgaben gehören zu keiner offenen Rechnung. Ordne die Zahlung einer EÜR-Kategorie zu. Nur eine Rückzahlung an einen Kunden wird hier mit seiner bezahlten Rechnung verknüpft."
                            />
                          ) : (
                            <EmptyState
                              title="Keine passende Rechnung gefunden"
                              description="Es gibt keine offenen Rechnungen mit passendem Betrag oder Verwendungszweck zu dieser Transaktion."
                            />
                          )
                        ) : (
                          matchData.suggestions.map((suggestion, index) => {
                            const alreadyPaid = suggestion.invoice.payments?.reduce(
                              (sum, p) => sum + p.amount,
                              0,
                            ) || 0;
                            const remaining = suggestion.invoice.amount - alreadyPaid;
                            // Lite: an outgoing line is a refund or Rücklastschrift of at most the money received.
                            const refund = !isProProduct && selectedTransaction.amount < 0;
                            const received = (suggestion.invoice.payments ?? []).filter((p) => !p.id.startsWith('skonto:')).reduce((sum, p) => sum + p.amount, 0);
                            const lineAmount = Math.abs(selectedTransaction.amount);
                            const maximum = refund ? Math.min(received, lineAmount) : Math.min(remaining, selectedTransaction.amount);
                            const allocationValue = allocationInputs[suggestion.invoice.id] ?? String(maximum);
                            const allocationAmount = Number(allocationValue.replace(',', '.'));
                            const appliedAmountCents = Math.round(allocationAmount * 100);

                            return (
                              <Card
                                key={suggestion.invoice.id}
                                padding="sm"
                                className={index === 0 && suggestion.confidence === 'high' ? 'border-foreground' : undefined}
                              >
                                <div className="flex items-start justify-between gap-3">
                                  <div className="min-w-0">
                                    <div className="text-label text-foreground">{suggestion.invoice.number}</div>
                                    <div className="text-caption text-muted">
                                      {suggestion.invoice.client} · Fällig: <span className="tabular-nums">{formatDate(suggestion.invoice.dueDate)}</span>
                                    </div>
                                  </div>
                                  <div className="shrink-0 text-right">
                                    <div className="text-label tabular-nums text-foreground">
                                      {formatCurrency(refund ? received : remaining)} <span className="text-caption font-normal text-muted">{refund ? 'erhalten' : 'offen'}</span>
                                    </div>
                                    {getConfidenceBadge(suggestion.confidence)}
                                  </div>
                                </div>
                                <ul className="mt-1.5 text-caption text-muted">
                                  {suggestion.matchReasons.map((reason, reasonIdx) => (
                                    <li key={reasonIdx} className="flex items-center gap-1.5">
                                      <Check size={12} className="shrink-0 text-success-text" aria-hidden="true" />
                                      <span>{reason}</span>
                                    </li>
                                  ))}
                                </ul>
                                <div className="mt-2.25">
                                  <Input label={`${refund ? 'Erstattungsbetrag' : 'Zuordnungsbetrag'} ${suggestion.invoice.number} in EUR`} inputMode="decimal" value={allocationValue} onChange={(event) => setAllocationInputs({ ...allocationInputs, [suggestion.invoice.id]: event.target.value })} />
                                  <p className="my-2 text-caption text-muted">
                                    {refund ? 'Die Rechnung wird um diesen Betrag wieder offen. ' : ''}Rest aus dieser Bankzahlung: {formatCurrency((refund ? lineAmount : selectedTransaction.amount) - allocationAmount)}
                                  </p>
                                  <Button
                                    size="sm"
                                    onClick={() => linkMutation.mutate({
                                      transactionId: selectedTransaction.id,
                                      invoiceId: suggestion.invoice.id,
                                      appliedAmountCents: appliedAmountCents,
                                    })}
                                    disabled={linkMutation.isPending || !Number.isFinite(allocationAmount) || allocationAmount <= 0 || allocationAmount > maximum}
                                  >
                                    <Link2 size={14} aria-hidden="true" />
                                    {refund ? 'Als Erstattung zuordnen' : 'Zahlung zuordnen'}
                                  </Button>
                                </div>
                              </Card>
                            );
                          })
                        )}
                      </>
                    )}
                  </div>
                </>
              )}
            </Card>
          </>
        ) : (
          <>
            <Card padding="none" className="overflow-hidden">
              <CardHeader
                title={listSummary}
                actions={
                  <>
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
                  </>
                }
                className={cardHead}
              />

              <div className="flex flex-col gap-2.5 border-b border-border p-3.5">
                {eurUndo && (
                  <div className={`${banner} items-center border-warning-border bg-warning-bg text-warning-text`}>
                    <span className="min-w-0 flex-1">{eurUndo.label}</span>
                    <Button variant="secondary" size="sm" onClick={() => void undoEur()} disabled={eurPending}>
                      Rückgängig
                    </Button>
                  </div>
                )}
                <div className="text-caption text-muted tabular-nums">Bulk-Aktionen ({eurSelected.size} ausgewählt)</div>
                {reasonInput}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      void applyEurBulk('Bulk: Vorschlag anwenden', (item) => ({
                        eurLineId: item.suggestedKind ? undefined : item.suggestedLineId,
                        kind: item.suggestedKind,
                        excluded: false,
                        vatMode: item.classification?.vatMode ?? 'none',
                        vatRate: item.classification?.vatRate,
                      }))
                    }
                    disabled={eurSelected.size === 0 || eurPending || eurReason.trim().length === 0}
                  >
                    <Check size={14} aria-hidden="true" />
                    Vorschlag anwenden
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      void applyEurBulk(isProProduct ? 'Bulk: Als privat/Transfer markieren' : 'Bulk: Als Geldtransit markieren', () => ({
                        eurLineId: undefined,
                        excluded: isProProduct,
                        kind: isProProduct ? undefined : 'transit',
                        vatMode: 'none',
                        vatRate: undefined,
                      }))
                    }
                    disabled={eurSelected.size === 0 || eurPending || eurReason.trim().length === 0}
                  >
                    <Ban size={14} aria-hidden="true" />
                    {isProProduct ? 'Als privat/Transfer markieren' : 'Als Geldtransit markieren'}
                  </Button>
                </div>
              </div>

              {eurItemsQuery.isError ? (
                <ErrorState
                  title="EÜR-Einträge konnten nicht geladen werden"
                  description={queryErrorDetail(eurItemsQuery.error)}
                  onRetry={() => void eurItemsQuery.refetch()}
                  className="m-3.5"
                />
              ) : eurItemsQuery.isLoading ? (
                <div className="flex flex-col items-center justify-center gap-3 py-10 text-muted">
                  <Spinner size="md" />
                  <p role="status" className="text-control">EÜR-Einträge werden geladen …</p>
                </div>
              ) : eurItems.length === 0 ? (
                <EmptyState
                  title="Keine EÜR-Einträge für diesen Filter"
                  description="Alle Transaktionen dieses Filters sind bereits bearbeitet. Wähle oben einen anderen Status."
                />
              ) : (
                <div className="max-h-128 overflow-y-auto">
                  {eurItems.map((item) => {
                    const key = keyOf(item);
                    const isActive = eurActive?.sourceType === item.sourceType && eurActive.sourceId === item.sourceId;
                    return (
                      <div key={key} className={`flex items-start gap-2.5 ${queueRow} ${isActive ? queueRowCurrent : 'hover:bg-surface-muted'}`}>
                        <span className="mt-0.5">
                          <Checkbox
                            aria-label={`${item.counterparty} auswählen`}
                            checked={eurSelected.has(key)}
                            onChange={(e) => {
                              const next = new Set(eurSelected);
                              if (e.target.checked) next.add(key);
                              else next.delete(key);
                              setEurSelected(next);
                            }}
                          />
                        </span>
                        <button
                          type="button"
                          onClick={() => setEurActive(item)}
                          aria-pressed={isActive}
                          className="min-w-0 flex-1 rounded-xs text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                        >
                          <span className="flex items-baseline gap-2">
                            <span className="min-w-0 flex-1 truncate text-label font-semibold text-foreground">{item.counterparty}</span>
                            <span className="shrink-0 text-label font-semibold tabular-nums text-foreground">
                              {item.flowType === 'income' ? '+' : '-'}{formatCurrency(item.amountGross)}
                            </span>
                          </span>
                          <span className="mt-1 flex flex-wrap items-center gap-1.5">
                            <span className="text-caption tabular-nums text-muted">{item.date}</span>
                            <span className="text-caption text-muted">{item.flowType === 'income' ? 'Einnahme' : 'Ausgabe'}</span>
                            {item.classification?.excluded ? (
                              <Badge tone="error">Ausgeschlossen</Badge>
                            ) : eurKindOf(item) ? (
                              <Badge tone="neutral">{eurKindOf(item) === 'transit' ? 'Geldtransit' : neutralEurKindLabels[eurKindOf(item)!]}</Badge>
                            ) : eurDecided(item) ? (
                              <Badge tone="success">Klassifiziert</Badge>
                            ) : (
                              <Badge tone="warning">Offen</Badge>
                            )}
                            {(item.suggestedLineId || item.suggestedKind) && !eurDecided(item) && (
                              <Badge tone="info">Vorschlag</Badge>
                            )}
                          </span>
                          <span className="mt-1 block truncate text-caption text-muted">{item.purpose}</span>
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>

            <Card padding="none">
              {!eurActive ? (
                <EmptyState
                  title="Kein Eintrag ausgewählt"
                  description="Wähle links eine Transaktion aus, um sie einer EÜR-Kennziffer zuzuordnen."
                />
              ) : (
                <>
                  <CardHeader
                    title="EÜR-Klassifizierung"
                    subtitle="Direkt in der Bank-Ansicht klassifizieren."
                    className={cardHead}
                  />
                  <div className="flex flex-col gap-3 p-3.5">
                    <div>
                      <div className="flex items-baseline gap-2">
                        <span className="min-w-0 flex-1 text-label font-semibold text-foreground">{eurActive.counterparty}</span>
                        <span className="shrink-0 text-label font-bold tabular-nums text-foreground">{formatCurrency(eurActive.amountGross)}</span>
                      </div>
                      <p className="text-caption text-muted">{eurActive.purpose}</p>
                    </div>

                    {eurReportQuery.isError && (
                      <div className={`${banner} border-warning-border bg-warning-bg text-warning-text`}>
                        <TriangleAlert size={16} className="mt-px shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1">Kennziffern konnten nicht geladen werden. Die Auswahl ist deshalb leer.</span>
                      </div>
                    )}

                    {eurActive.transitHint && (
                      <div className={`${banner} border-warning-border bg-warning-bg text-warning-text`}>
                        <TriangleAlert size={16} className="mt-px shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1">{eurActive.transitHint}</span>
                      </div>
                    )}

                    {(eurActive.suggestedLineId || (!isProProduct && eurActive.suggestedKind)) && (
                      <div className={`${banner} items-center border-info-border bg-info-bg text-info-text`}>
                        <span className="min-w-0 flex-1">{eurActive.suggestionReason ?? 'Automatischer Vorschlag'}</span>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => {
                            if (eurActive.suggestedKind) { setEurDecision(eurActive.suggestedKind); return; }
                            setEurLineId(eurActive.suggestedLineId ?? '');
                            setEurDecision('flow');
                          }}
                        >
                          Vorschlag übernehmen
                        </Button>
                      </div>
                    )}

                    <Select
                      id="tm-eur-line"
                      label="Kennziffer"
                      value={eurLineId}
                      onChange={(e) => setEurLineId(e.target.value)}
                      disabled={eurExcluded}
                      fullWidth
                    >
                      <option value="">Nicht zugeordnet</option>
                      {eurActiveLineOptions.map((line) => (
                        <option key={line.lineId} value={line.lineId}>
                          {line.kennziffer ? `${line.kennziffer} - ` : ''}{line.label}
                        </option>
                      ))}
                    </Select>

                    <Select
                      id="tm-eur-vat-mode"
                      label="USt. Modus"
                      value={eurVatMode}
                      onChange={(e) => setEurVatMode(e.target.value as 'none' | 'default')}
                      fullWidth
                    >
                      <option value="none">Keine USt. Umrechnung</option>
                      <option value="default">Default USt. (Netto)</option>
                    </Select>

                    {isProProduct && eurVatMode === 'default' && (
                      <div>
                        <Input
                          id="tm-eur-vat-rate"
                          label="USt.-Satz (%)"
                          type="number"
                          min="0"
                          max="100"
                          step="0.01"
                          value={eurVatRate ?? ''}
                          onChange={(e) => setEurVatRate(e.target.value === '' ? undefined : Number(e.target.value))}
                          className="tabular-nums"
                          placeholder="z. B. 19"
                          fullWidth
                        />
                        {eurActive.vatWarning && <p className="mt-1 text-caption text-warning-text">{eurActive.vatWarning}</p>}
                      </div>
                    )}

                    {isProProduct ? (
                      <Checkbox
                        label="Privat/Transfer ausschließen"
                        checked={eurExcluded}
                        onChange={(e) => setEurDecision(e.target.checked ? 'excluded' : 'flow')}
                      />
                    ) : (
                      <Select
                        id="tm-eur-kind"
                        label="Art"
                        value={eurDecision}
                        onChange={(e) => setEurDecision(e.target.value as EurDecision)}
                        fullWidth
                      >
                        <option value="flow">{eurActive.flowType === 'income' ? 'Betriebseinnahme' : 'Betriebsausgabe'} (Kategorie oben)</option>
                        {eurActive.flowType === 'expense'
                          ? <option value="private-withdrawal">{neutralEurKindLabels['private-withdrawal']}</option>
                          : <option value="private-contribution">{neutralEurKindLabels['private-contribution']}</option>}
                        <option value="transit">{neutralEurKindLabels.transit}</option>
                        {eurActive.classification?.excluded && <option value="excluded">Ausgeschlossen (alt): bitte neu zuordnen</option>}
                      </Select>
                    )}

                    {reasonInput}

                    <div className="flex flex-wrap items-center gap-2">
                      <Button onClick={() => void applyEurSingle()} disabled={eurPending || eurReason.trim().length === 0}>
                        {eurPending ? 'Speichern...' : 'Klassifizierung speichern'}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          setEurLineId('');
                          setEurDecision('flow');
                          setEurVatMode('none');
                          setEurVatRate(undefined);
                        }}
                      >
                        Zurücksetzen
                      </Button>
                    </div>

                    <div className="flex items-center gap-1.5 border-t border-border pt-2.5 text-caption text-muted">
                      <Layers size={14} aria-hidden="true" />
                      Änderungen sind sofort in EÜR-Report und Export sichtbar.
                    </div>
                  </div>
                </>
              )}
            </Card>
          </>
        )}
      </div>

      <ConfirmDialog
        open={showUnlinkConfirm}
        title="Zuordnung wirklich aufheben?"
        description="Diese Rechnung wird wieder als unbezahlt markiert."
        details={invoiceToUnlink?.invoiceWillBeOverdue ? (
          <p className="flex items-start gap-2 text-warning-text">
            <TriangleAlert size={16} className="mt-px shrink-0" aria-hidden="true" />
            Die Rechnung könnte dadurch wieder überfällig werden.
          </p>
        ) : undefined}
        confirmLabel="Ja, aufheben"
        cancelLabel="Abbrechen"
        destructive
        busy={unlinkMutation.isPending}
        onConfirm={confirmUnlink}
        onCancel={() => {
          if (unlinkMutation.isPending) return;
          setShowUnlinkConfirm(false);
          setInvoiceToUnlink(null);
        }}
      />
    </div>
  );
};
