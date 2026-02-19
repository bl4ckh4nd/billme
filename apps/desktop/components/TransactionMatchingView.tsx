import { Button } from '@billme/ui';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Link2,
  Unlink,
  CheckCircle2,
  AlertCircle,
  TrendingUp,
  Calendar,
  User,
  FileText,
  Search,
  X,
  Tags,
  Layers,
  Sparkles,
  Ban,
  XCircle,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../ipc/client';
import { Toast } from './Toast';
import { Spinner } from './Spinner';
import type { Transaction, Invoice as InvoiceType } from '../types';

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
  suggestedLineId?: string;
  suggestionReason?: string;
  classification?: {
    eurLineId?: string;
    excluded: boolean;
    vatMode: 'none' | 'default';
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
};

const keyOf = (item: { sourceType: 'transaction' | 'invoice'; sourceId: string }): string =>
  `${item.sourceType}:${item.sourceId}`;

export const TransactionMatchingView: React.FC<{ onBack: () => void; initialTab?: MatchingTab }> = ({
  onBack,
  initialTab = 'matching',
}) => {
  const [activeTab, setActiveTab] = useState<MatchingTab>(initialTab);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showLinked, setShowLinked] = useState(false);
  const [showToast, setShowToast] = useState(false);
  const [toastMessage, setToastMessage] = useState('');
  const [toastType, setToastType] = useState<'success' | 'error' | 'warning' | 'info'>('success');
  const [showUnlinkConfirm, setShowUnlinkConfirm] = useState(false);
  const [invoiceToUnlink, setInvoiceToUnlink] = useState<{ transactionId: string; invoiceWillBeOverdue: boolean } | null>(null);
  const queryClient = useQueryClient();

  const showNotification = (message: string, type: 'success' | 'error' | 'warning' | 'info' = 'success') => {
    setToastMessage(message);
    setToastType(type);
    setShowToast(true);
  };

  // Existing invoice matching flow
  const { data: transactions = [] } = useQuery({
    queryKey: ['transactions', { unlinkedOnly: !showLinked }],
    enabled: activeTab === 'matching',
    queryFn: async () => {
      return await ipc.transactions.list({
        type: 'income',
        unlinkedOnly: !showLinked,
      });
    },
  });

  const { data: matchData, isLoading: isLoadingMatches } = useQuery({
    queryKey: ['transaction-matches', selectedTransaction?.id],
    queryFn: async (): Promise<MatchResult | null> => {
      if (!selectedTransaction) return null;
      return await ipc.transactions.findMatches({ transactionId: selectedTransaction.id });
    },
    enabled: activeTab === 'matching' && !!selectedTransaction && !selectedTransaction.linkedInvoiceId,
  });

  const linkMutation = useMutation({
    mutationFn: async ({ transactionId, invoiceId }: { transactionId: string; invoiceId: string }) => {
      return await ipc.transactions.link({ transactionId, invoiceId });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['transactions'] });
      queryClient.invalidateQueries({ queryKey: ['invoices'] });
      queryClient.invalidateQueries({ queryKey: ['transaction-matches'] });
      setSelectedTransaction(null);
      showNotification('✓ Transaktion erfolgreich zugeordnet und Rechnung als bezahlt markiert', 'success');
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
  const toggleVisibilityClass = showLinked ? 'bg-gray-100 text-gray-700' : 'bg-info-bg text-info';
  const toggleVisibilityLabel = showLinked ? 'Nur unzugeordnete' : 'Alle anzeigen';

  // New inline EÜR classification flow
  const [taxYear, setTaxYear] = useState(2025);
  const [eurQuery, setEurQuery] = useState('');
  const [eurStatus, setEurStatus] = useState<EurStatus>('unclassified');
  const [eurFlow, setEurFlow] = useState<'all' | 'income' | 'expense'>('all');
  const [eurSelected, setEurSelected] = useState<Set<string>>(new Set());
  const [eurActive, setEurActive] = useState<EurTxItem | null>(null);
  const [eurLineId, setEurLineId] = useState('');
  const [eurVatMode, setEurVatMode] = useState<'none' | 'default'>('none');
  const [eurExcluded, setEurExcluded] = useState(false);
  const [eurUndo, setEurUndo] = useState<{ label: string; changes: EurUndo[] } | null>(null);
  const [eurPending, setEurPending] = useState(false);
  const [eurSort, setEurSort] = useState<'date_desc' | 'amount_desc' | 'counterparty_asc'>('date_desc');

  const { data: eurReport } = useQuery({
    queryKey: ['eur', 'report', taxYear],
    enabled: activeTab === 'eur',
    queryFn: () => ipc.eur.getReport({ taxYear }),
  });

  const { data: eurItemsRaw = [], isLoading: eurLoading } = useQuery({
    queryKey: ['eur', 'items', 'transaction', taxYear],
    enabled: activeTab === 'eur',
    queryFn: () =>
      ipc.eur.listItems({
        taxYear,
        sourceType: 'transaction',
        status: 'all',
      }),
  });

  const eurUpsert = useMutation({
    mutationFn: (payload: {
      sourceType: 'transaction' | 'invoice';
      sourceId: string;
      taxYear: number;
      eurLineId?: string;
      excluded?: boolean;
      vatMode?: 'none' | 'default';
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
    setEurExcluded(eurActive.classification?.excluded ?? false);
  }, [eurActive]);

  const applyEurSingle = async () => {
    if (!eurActive) return;
    const change: EurUndo = {
      sourceType: eurActive.sourceType,
      sourceId: eurActive.sourceId,
      taxYear,
      prevLineId: eurActive.classification?.eurLineId,
      prevExcluded: eurActive.classification?.excluded ?? false,
      prevVatMode: eurActive.classification?.vatMode ?? 'none',
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
      });
      setEurUndo({ label: 'Einzelklassifizierung', changes: [change] });
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
    resolver: (item: EurTxItem) => { eurLineId?: string; excluded?: boolean; vatMode?: 'none' | 'default' },
  ) => {
    if (selectedEurItems.length === 0) return;

    const changes: EurUndo[] = selectedEurItems.map((item) => ({
      sourceType: item.sourceType,
      sourceId: item.sourceId,
      taxYear,
      prevLineId: item.classification?.eurLineId,
      prevExcluded: item.classification?.excluded ?? false,
      prevVatMode: item.classification?.vatMode ?? 'none',
    }));

    setEurPending(true);
    try {
      await Promise.all(
        selectedEurItems.map((item) =>
          eurUpsert.mutateAsync({
            sourceType: item.sourceType,
            sourceId: item.sourceId,
            taxYear,
            ...resolver(item),
          }),
        ),
      );
      setEurUndo({ label, changes });
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
    const styles = {
      high: 'bg-success-bg text-success border-success/30',
      medium: 'bg-yellow-100 text-yellow-700 border-yellow-200',
      low: 'bg-gray-100 text-gray-600 border-gray-200',
    };
    const labels = {
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

  return (
    <div className="h-full flex flex-col bg-white">
      <div className="border-b border-gray-200 p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <button
              onClick={onBack}
              className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <ArrowLeft size={20} />
            </button>
            <div>
              <h1 className="text-2xl font-black text-gray-900">Transaktionen bearbeiten</h1>
              <p className="text-sm text-gray-500 mt-1">
                {activeTab === 'matching'
                  ? `${unmatchedCount} offene Transaktion${unmatchedCount !== 1 ? 'en' : ''}`
                  : `${eurCounts.unclassified} offene EÜR-Klassifizierungen`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 rounded-lg border border-gray-200 p-1 bg-gray-50">
            <button
              onClick={() => setActiveTab('matching')}
              className={`px-3 py-1.5 text-sm rounded-md ${activeTab === 'matching' ? 'bg-white shadow font-semibold text-gray-900' : 'text-gray-600'}`}
            >
              Rechnungen zuordnen
            </button>
            <button
              onClick={() => setActiveTab('eur')}
              className={`px-3 py-1.5 text-sm rounded-md ${activeTab === 'eur' ? 'bg-white shadow font-semibold text-gray-900' : 'text-gray-600'}`}
            >
              EÜR klassifizieren
            </button>
          </div>
        </div>

        {activeTab === 'matching' ? (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={18} />
            <input
              type="text"
              placeholder="Transaktion suchen..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <X size={18} />
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={taxYear}
              onChange={(e) => setTaxYear(Number(e.target.value))}
              className="rounded-xl border border-gray-300 px-3 py-2 text-sm"
            >
              <option value={2025}>2025</option>
            </select>
            <input
              value={eurQuery}
              onChange={(e) => setEurQuery(e.target.value)}
              placeholder="Suche Gegenpartei/Zweck"
              className="rounded-xl border border-gray-300 px-3 py-2 text-sm min-w-[220px]"
            />
            <select
              value={eurStatus}
              onChange={(e) => setEurStatus(e.target.value as EurStatus)}
              className="rounded-xl border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="unclassified">Unklassifiziert</option>
              <option value="classified">Klassifiziert</option>
              <option value="excluded">Ausgeschlossen</option>
              <option value="all">Alle</option>
            </select>
            <select
              value={eurFlow}
              onChange={(e) => setEurFlow(e.target.value as 'all' | 'income' | 'expense')}
              className="rounded-xl border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="all">Alle Typen</option>
              <option value="income">Einnahmen</option>
              <option value="expense">Ausgaben</option>
            </select>
            <select
              value={eurSort}
              onChange={(e) => setEurSort(e.target.value as 'date_desc' | 'amount_desc' | 'counterparty_asc')}
              className="rounded-xl border border-gray-300 px-3 py-2 text-sm"
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
            <div className="w-1/2 border-r border-gray-200 overflow-y-auto">
              <div className="p-4">
                <button
                  onClick={() => setShowLinked(!showLinked)}
                  className={`px-4 py-2 rounded-lg font-medium text-sm transition-all ${toggleVisibilityClass}`}
                >
                  {toggleVisibilityLabel}
                </button>
              </div>
              {filteredTransactions.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-gray-500 p-8">
                  <TrendingUp size={48} className="mb-4 opacity-50" />
                  <p className="text-lg font-medium">Keine Transaktionen gefunden</p>
                  <p className="text-sm text-center mt-2">
                    {searchQuery
                      ? 'Versuchen Sie eine andere Suche'
                      : 'Importieren Sie Transaktionen über die CSV-Import-Funktion'}
                  </p>
                </div>
              ) : (
                <div className="p-4 space-y-2">
                  {filteredTransactions.map((transaction, idx) => {
                    const isSelected = selectedTransaction?.id === transaction.id;
                    const isLinked = Boolean(transaction.linkedInvoiceId);

                    let rowClass = 'border-gray-200 hover:border-gray-300 hover:shadow-sm';
                    if (isSelected) {
                      rowClass = 'border-info bg-info-bg';
                    } else if (isLinked) {
                      rowClass = 'border-success/30 bg-success-bg hover:border-success';
                    }

                    return (
                      <div
                        key={transaction.id}
                        onClick={() => setSelectedTransaction(transaction)}
                        className={`p-4 rounded-lg border-2 cursor-pointer transition-all animate-enter ${rowClass}`}
                        style={{ animationDelay: `${idx * 50}ms` }}
                      >
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 mb-1">
                              {isLinked ? (
                                <CheckCircle2 size={16} className="text-success flex-shrink-0" />
                              ) : (
                                <AlertCircle size={16} className="text-amber-500 flex-shrink-0" />
                              )}
                              <span className="font-semibold text-gray-900 truncate">
                                {transaction.counterparty}
                              </span>
                            </div>
                            <p className="text-sm text-gray-600 line-clamp-2">{transaction.purpose}</p>
                          </div>
                          <div className="text-right ml-4 flex-shrink-0">
                            <div className="text-lg font-bold text-success">
                              {formatCurrency(transaction.amount)}
                            </div>
                            <div className="text-xs text-gray-500">{formatDate(transaction.date)}</div>
                          </div>
                        </div>
                        {isLinked && (
                          <div className="flex items-center gap-2 mt-2 pt-2 border-t border-success/30">
                            <Link2 size={14} className="text-success" />
                            <span className="text-xs text-success font-medium">Zugeordnet</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="w-1/2 overflow-y-auto bg-gray-50">
              {!selectedTransaction ? (
                <div className="flex flex-col items-center justify-center h-full text-gray-500 p-8">
                  <FileText size={48} className="mb-4 opacity-50" />
                  <p className="text-lg font-medium">Keine Transaktion ausgewählt</p>
                  <p className="text-sm text-center mt-2">
                    Wählen Sie eine Transaktion aus, um passende Rechnungen zu sehen
                  </p>
                </div>
              ) : selectedTransaction.linkedInvoiceId ? (
                <div className="p-6">
                  <div className="bg-white rounded-lg border border-success/30 p-6">
                    <div className="flex items-center gap-3 mb-4">
                      <CheckCircle2 size={24} className="text-success" />
                      <h2 className="text-xl font-bold text-gray-900">Bereits zugeordnet</h2>
                    </div>
                    <p className="text-gray-600 mb-6">
                      Diese Transaktion ist bereits einer Rechnung zugeordnet.
                    </p>
                    <button
                      onClick={() => handleUnlinkClick(selectedTransaction.id)}
                      disabled={unlinkMutation.isPending}
                      className="px-4 py-2 bg-error-bg text-error hover:bg-error-bg/80 rounded-lg font-medium text-sm transition-colors flex items-center gap-2 disabled:opacity-50"
                    >
                      <Unlink size={16} />
                      Zuordnung aufheben
                    </button>
                  </div>
                </div>
              ) : (
                <div className="p-6">
                  <h2 className="text-lg font-bold text-gray-900 mb-4">Passende Rechnungen</h2>

                  {isLoadingMatches ? (
                    <div className="flex items-center justify-center h-64">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
                    </div>
                  ) : !matchData || matchData.suggestions.length === 0 ? (
                    <div className="bg-white rounded-lg border border-gray-200 p-8 text-center">
                      <AlertCircle size={48} className="mx-auto mb-4 text-gray-400" />
                      <p className="text-gray-600 font-medium mb-2">Keine passenden Rechnungen gefunden</p>
                      <p className="text-sm text-gray-500">
                        Es gibt keine offenen Rechnungen, die zu dieser Transaktion passen.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      {matchData.suggestions.map((suggestion, idx) => {
                        const alreadyPaid = suggestion.invoice.payments?.reduce(
                          (sum, p) => sum + p.amount,
                          0,
                        ) || 0;
                        const remaining = suggestion.invoice.amount - alreadyPaid;

                        return (
                          <div
                            key={suggestion.invoice.id}
                            className="bg-white rounded-lg border-2 border-gray-200 hover:border-blue-300 transition-all p-4 animate-enter"
                            style={{ animationDelay: `${idx * 50}ms` }}
                          >
                            <div className="flex items-start justify-between mb-3">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-2">
                                  <span className="font-bold text-gray-900">{suggestion.invoice.number}</span>
                                  {getConfidenceBadge(suggestion.confidence)}
                                </div>
                                <p className="text-sm text-gray-600 mb-1">
                                  <User size={14} className="inline mr-1" />
                                  {suggestion.invoice.client}
                                </p>
                                <p className="text-sm text-gray-600">
                                  <Calendar size={14} className="inline mr-1" />
                                  Fällig: {formatDate(suggestion.invoice.dueDate)}
                                </p>
                              </div>
                              <div className="text-right ml-4">
                                <div className="text-lg font-bold text-gray-900">
                                  {formatCurrency(remaining)}
                                </div>
                                <div className="text-xs text-gray-500">offen</div>
                              </div>
                            </div>

                            <div className="space-y-1 mb-4 pb-4 border-b border-gray-100">
                              {suggestion.matchReasons.map((reason, reasonIdx) => (
                                <div key={reasonIdx} className="flex items-center gap-2 text-sm text-gray-600">
                                  <CheckCircle2 size={14} className="text-success flex-shrink-0" />
                                  <span>{reason}</span>
                                </div>
                              ))}
                            </div>

                            <button
                              onClick={() =>
                                linkMutation.mutate({
                                  transactionId: selectedTransaction.id,
                                  invoiceId: suggestion.invoice.id,
                                })
                              }
                              disabled={linkMutation.isPending}
                              className="w-full px-4 py-2 bg-info hover:bg-info/90 text-white rounded-lg font-medium text-sm transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
                            >
                              <Link2 size={16} />
                              Zuordnen und als bezahlt markieren
                            </button>
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
            <div className="w-1/2 border-r border-gray-200 overflow-y-auto">
              {eurUndo && (
                <div className="m-4 rounded-xl border border-amber-200 bg-amber-50 p-3 flex items-center justify-between gap-2">
                  <span className="text-xs text-amber-900">{eurUndo.label}</span>
                  <button
                    onClick={() => void undoEur()}
                    disabled={eurPending}
                    className="px-2 py-1 rounded-md bg-white border border-amber-300 text-xs font-semibold text-amber-800"
                  >
                    Rückgängig
                  </button>
                </div>
              )}

              <div className="m-4 rounded-xl border border-gray-200 p-3">
                <div className="text-xs text-gray-500 mb-2">Bulk-Aktionen ({eurSelected.size} ausgewählt)</div>
                <div className="grid grid-cols-1 gap-2">
                  <button
                    onClick={() =>
                      void applyEurBulk('Bulk: Vorschlag anwenden', (item) => ({
                        eurLineId: item.suggestedLineId,
                        excluded: false,
                        vatMode: item.classification?.vatMode ?? 'none',
                      }))
                    }
                    disabled={eurSelected.size === 0 || eurPending}
                    className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-left hover:bg-gray-100 transition-colors disabled:opacity-60"
                  >
                    <Sparkles size={14} className="text-blue-500 flex-shrink-0" />
                    Vorschlag anwenden
                  </button>
                  <button
                    onClick={() =>
                      void applyEurBulk('Bulk: Als privat/Transfer markieren', () => ({
                        eurLineId: undefined,
                        excluded: true,
                        vatMode: 'none',
                      }))
                    }
                    disabled={eurSelected.size === 0 || eurPending}
                    className="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs text-left hover:bg-gray-100 transition-colors disabled:opacity-60"
                  >
                    <Ban size={14} className="text-red-500 flex-shrink-0" />
                    Als privat/Transfer markieren
                  </button>
                </div>
              </div>

              {eurLoading ? (
                <div className="flex flex-col items-center justify-center py-12">
                  <Spinner size="md" />
                  <p className="text-sm text-gray-500 mt-3">Lade EÜR-Elemente...</p>
                </div>
              ) : eurItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-gray-500">
                  <CheckCircle2 size={48} className="mb-4 opacity-50" />
                  <p className="text-lg font-medium">Keine Einträge</p>
                  <p className="text-sm text-center mt-2">Alle Transaktionen für diesen Filter sind bearbeitet.</p>
                </div>
              ) : (
                <div className="p-4 space-y-2">
                  {eurItems.map((item) => {
                    const key = keyOf(item);
                    const isActive = eurActive?.sourceType === item.sourceType && eurActive.sourceId === item.sourceId;
                    return (
                      <div
                        key={key}
                        className={`p-3 rounded-xl border ${isActive ? 'border-black bg-gray-50' : 'border-gray-200 hover:border-gray-300'}`}
                      >
                        <div className="flex items-start gap-2">
                          <input
                            type="checkbox"
                            className="mt-1"
                            checked={eurSelected.has(key)}
                            onChange={(e) => {
                              const next = new Set(eurSelected);
                              if (e.target.checked) next.add(key);
                              else next.delete(key);
                              setEurSelected(next);
                            }}
                          />
                          <button
                            onClick={() => setEurActive(item)}
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
                              <span>{item.flowType === 'income' ? 'Einnahme' : 'Ausgabe'}</span>
                            </div>
                            <div className="text-sm font-semibold text-gray-900 truncate">{item.counterparty}</div>
                            <div className="text-xs text-gray-600 truncate">{item.purpose}</div>
                            <div className={`text-sm font-mono font-bold mt-1 ${
                              item.flowType === 'income' ? 'text-green-600' : 'text-red-600'
                            }`}>
                              {item.flowType === 'income' ? '+' : '-'}{formatCurrency(item.amountGross)}
                            </div>
                            <div className="flex flex-wrap gap-1 mt-2">
                              {item.classification?.excluded ? (
                                <span className="text-[11px] px-2 py-0.5 rounded-full bg-red-100 text-red-700">Ausgeschlossen</span>
                              ) : item.classification?.eurLineId ? (
                                <span className="text-[11px] px-2 py-0.5 rounded-full bg-green-100 text-green-700">Klassifiziert</span>
                              ) : (
                                <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">Offen</span>
                              )}
                              {item.suggestedLineId && !item.classification?.eurLineId && !item.classification?.excluded && (
                                <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">Vorschlag</span>
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

            <div className="w-1/2 overflow-y-auto bg-gray-50 p-6">
              {!eurActive ? (
                <div className="h-full flex flex-col items-center justify-center text-gray-500">
                  <Tags size={42} className="mb-3 opacity-50" />
                  <p className="font-medium">Kein Eintrag ausgewählt</p>
                  <p className="text-sm">Wählen Sie links eine Transaktion zur EÜR-Klassifizierung.</p>
                </div>
              ) : (
                <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
                  <div>
                    <h2 className="text-lg font-bold text-gray-900">EÜR-Klassifizierung</h2>
                    <p className="text-sm text-gray-500">Direkt in der Bank-Ansicht klassifizieren.</p>
                  </div>

                  <div className="text-sm text-gray-700">
                    <div className="font-semibold">{eurActive.counterparty}</div>
                    <div className="text-gray-500">{eurActive.purpose}</div>
                    <div className="font-semibold mt-1">{formatCurrency(eurActive.amountGross)}</div>
                  </div>

                  {eurActive.suggestedLineId && (
                    <button
                      onClick={() => {
                        setEurLineId(eurActive.suggestedLineId ?? '');
                        setEurExcluded(false);
                      }}
                      className="w-full rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-left"
                    >
                      <div className="text-xs text-blue-700 font-semibold">Vorschlag übernehmen</div>
                      <div className="text-xs text-blue-600">{eurActive.suggestionReason ?? 'Automatischer Vorschlag'}</div>
                    </button>
                  )}

                  <div>
                    <label className="text-xs font-semibold text-gray-600">Kennziffer</label>
                    <select
                      value={eurLineId}
                      onChange={(e) => setEurLineId(e.target.value)}
                      disabled={eurExcluded}
                      className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2 text-sm"
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
                    <label className="text-xs font-semibold text-gray-600">USt. Modus</label>
                    <select
                      value={eurVatMode}
                      onChange={(e) => setEurVatMode(e.target.value as 'none' | 'default')}
                      className="mt-1 w-full rounded-xl border border-gray-300 px-3 py-2 text-sm"
                    >
                      <option value="none">Keine USt. Umrechnung</option>
                      <option value="default">Default USt. (Netto)</option>
                    </select>
                  </div>

                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input
                      type="checkbox"
                      checked={eurExcluded}
                      onChange={(e) => setEurExcluded(e.target.checked)}
                    />
                    Privat/Transfer ausschließen
                  </label>

                  <div className="flex items-center gap-2">
                    <Button onClick={() => void applyEurSingle()} disabled={eurPending}>
                      {eurPending ? 'Speichern...' : 'Klassifizierung speichern'}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setEurLineId('');
                        setEurExcluded(false);
                        setEurVatMode('none');
                      }}
                    >
                      Zurücksetzen
                    </Button>
                  </div>

                  <div className="pt-3 border-t border-gray-100 text-xs text-gray-500 flex items-center gap-1">
                    <Layers size={14} />
                    Änderungen sind sofort in EÜR-Report und Export sichtbar.
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {showUnlinkConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-2xl shadow-2xl w-[90%] max-w-md p-6">
            <div className="flex items-start gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-orange-100 flex items-center justify-center flex-shrink-0">
                <AlertCircle size={20} className="text-orange-600" />
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-bold text-gray-900 mb-2">
                  Zuordnung wirklich aufheben?
                </h3>
                <p className="text-sm text-gray-600 mb-2">
                  Diese Rechnung wird wieder als unbezahlt markiert.
                </p>
                {invoiceToUnlink?.invoiceWillBeOverdue && (
                  <p className="text-sm text-orange-700 font-medium">
                    ⚠️ Die Rechnung könnte dadurch wieder überfällig werden.
                  </p>
                )}
              </div>
            </div>

            <div className="flex gap-3 mt-6">
              <button
                onClick={confirmUnlink}
                disabled={unlinkMutation.isPending}
                className="flex-1 px-4 py-2 bg-error text-white rounded-lg hover:bg-error/90 disabled:opacity-50 transition-colors font-medium"
              >
                {unlinkMutation.isPending ? 'Wird aufgehoben...' : 'Ja, aufheben'}
              </button>
              <button
                onClick={() => {
                  setShowUnlinkConfirm(false);
                  setInvoiceToUnlink(null);
                }}
                disabled={unlinkMutation.isPending}
                className="flex-1 px-4 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 transition-colors font-medium"
              >
                Abbrechen
              </button>
            </div>
          </div>
        </div>
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
