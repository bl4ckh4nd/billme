import { Button } from '@billme/ui';
import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Search,
  X,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../ipc/client';
import { Toast } from './Toast';
import type { Transaction } from '../types';
import type { MatchingTab, EurStatus, EurTxItem, EurUndo } from './transaction-matching/types';
import { keyOf } from './transaction-matching/types';
import { TransactionList } from './transaction-matching/TransactionList';
import { MatchSuggestionsPanel } from './transaction-matching/MatchSuggestionsPanel';
import { EurItemList } from './transaction-matching/EurItemList';
import { EurClassifyPanel } from './transaction-matching/EurClassifyPanel';
import { UnlinkConfirmModal } from './transaction-matching/UnlinkConfirmModal';

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
    queryFn: async () => {
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

  return (
    <div className="h-full flex flex-col bg-surface">
      <div className="border-b border-border p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <button
              onClick={onBack}
              className="p-2 hover:bg-canvas rounded-lg transition-colors duration-150 ease-out"
            >
              <ArrowLeft size={20} />
            </button>
            <div>
              <h1 className="text-2xl font-black text-foreground">Transaktionen bearbeiten</h1>
              <p className="text-sm text-muted mt-1">
                {activeTab === 'matching'
                  ? `${unmatchedCount} offene Transaktion${unmatchedCount !== 1 ? 'en' : ''}`
                  : `${eurCounts.unclassified} offene EÜR-Klassifizierungen`}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 rounded-lg border border-border p-1 bg-surface-muted">
            <button
              onClick={() => setActiveTab('matching')}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors duration-150 ease-out ${activeTab === 'matching' ? 'bg-surface shadow font-semibold text-foreground' : 'text-muted'}`}
            >
              Rechnungen zuordnen
            </button>
            <button
              onClick={() => setActiveTab('eur')}
              className={`px-3 py-1.5 text-sm rounded-md transition-colors duration-150 ease-out ${activeTab === 'eur' ? 'bg-surface shadow font-semibold text-foreground' : 'text-muted'}`}
            >
              EÜR klassifizieren
            </button>
          </div>
        </div>

        {activeTab === 'matching' ? (
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" size={18} />
            <input
              type="text"
              placeholder="Transaktion suchen..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-accent"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-foreground"
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
              className="rounded-lg border border-border px-3 py-2 text-sm"
            >
              <option value={2025}>2025</option>
            </select>
            <input
              value={eurQuery}
              onChange={(e) => setEurQuery(e.target.value)}
              placeholder="Suche Gegenpartei/Zweck"
              className="rounded-lg border border-border px-3 py-2 text-sm min-w-[220px]"
            />
            <select
              value={eurStatus}
              onChange={(e) => setEurStatus(e.target.value as EurStatus)}
              className="rounded-lg border border-border px-3 py-2 text-sm"
            >
              <option value="unclassified">Unklassifiziert</option>
              <option value="classified">Klassifiziert</option>
              <option value="excluded">Ausgeschlossen</option>
              <option value="all">Alle</option>
            </select>
            <select
              value={eurFlow}
              onChange={(e) => setEurFlow(e.target.value as 'all' | 'income' | 'expense')}
              className="rounded-lg border border-border px-3 py-2 text-sm"
            >
              <option value="all">Alle Typen</option>
              <option value="income">Einnahmen</option>
              <option value="expense">Ausgaben</option>
            </select>
            <select
              value={eurSort}
              onChange={(e) => setEurSort(e.target.value as 'date_desc' | 'amount_desc' | 'counterparty_asc')}
              className="rounded-lg border border-border px-3 py-2 text-sm"
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
            <TransactionList
              filteredTransactions={filteredTransactions}
              selectedTransaction={selectedTransaction}
              onSelect={setSelectedTransaction}
              showLinked={showLinked}
              onToggleShowLinked={() => setShowLinked(!showLinked)}
              searchQuery={searchQuery}
            />
            <MatchSuggestionsPanel
              selectedTransaction={selectedTransaction}
              matchData={matchData}
              isLoadingMatches={isLoadingMatches}
              onLink={(transactionId, invoiceId) => linkMutation.mutate({ transactionId, invoiceId })}
              onUnlinkClick={handleUnlinkClick}
              linkIsPending={linkMutation.isPending}
              unlinkIsPending={unlinkMutation.isPending}
            />
          </>
        ) : (
          <>
            <EurItemList
              eurItems={eurItems}
              eurLoading={eurLoading}
              eurSelected={eurSelected}
              onEurSelectedChange={setEurSelected}
              eurActive={eurActive}
              onSetEurActive={setEurActive}
              eurUndo={eurUndo}
              eurPending={eurPending}
              onUndo={() => void undoEur()}
              onApplyBulk={(label, resolver) => void applyEurBulk(label, resolver)}
            />
            <EurClassifyPanel
              eurActive={eurActive}
              eurLineId={eurLineId}
              onEurLineIdChange={setEurLineId}
              eurVatMode={eurVatMode}
              onEurVatModeChange={setEurVatMode}
              eurExcluded={eurExcluded}
              onEurExcludedChange={setEurExcluded}
              eurPending={eurPending}
              eurActiveLineOptions={eurActiveLineOptions}
              onApplySingle={() => void applyEurSingle()}
              onReset={() => {
                setEurLineId('');
                setEurExcluded(false);
                setEurVatMode('none');
              }}
            />
          </>
        )}
      </div>

      {showUnlinkConfirm && (
        <UnlinkConfirmModal
          isPending={unlinkMutation.isPending}
          invoiceWillBeOverdue={invoiceToUnlink?.invoiceWillBeOverdue ?? false}
          onConfirm={confirmUnlink}
          onCancel={() => {
            setShowUnlinkConfirm(false);
            setInvoiceToUnlink(null);
          }}
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
