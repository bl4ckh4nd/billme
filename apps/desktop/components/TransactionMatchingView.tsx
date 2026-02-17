import { Button } from '@billme/ui';
import React, { useState } from 'react';
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
  Filter,
  ChevronDown,
  X,
} from 'lucide-react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../ipc/client';
import { Toast } from './Toast';
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

export const TransactionMatchingView: React.FC<{ onBack: () => void }> = ({ onBack }) => {
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

  // Fetch unmatched transactions
  const { data: transactions = [] } = useQuery({
    queryKey: ['transactions', { unlinkedOnly: !showLinked }],
    queryFn: async () => {
      return await ipc.transactions.list({
        type: 'income',
        unlinkedOnly: !showLinked
      });
    },
  });

  // Fetch match suggestions for selected transaction
  const { data: matchData, isLoading: isLoadingMatches } = useQuery({
    queryKey: ['transaction-matches', selectedTransaction?.id],
    queryFn: async (): Promise<MatchResult | null> => {
      if (!selectedTransaction) return null;
      return await ipc.transactions.findMatches({ transactionId: selectedTransaction.id });
    },
    enabled: !!selectedTransaction && !selectedTransaction.linkedInvoiceId,
  });

  // Link mutation
  const linkMutation = useMutation({
    mutationFn: async ({ transactionId, invoiceId }: { transactionId: string; invoiceId: string }) => {
      return await ipc.transactions.link({ transactionId, invoiceId });
    },
    onSuccess: (result) => {
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

  // Unlink mutation
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
    // For now, we assume unlinking could make invoice overdue
    // In a real implementation, you'd fetch the invoice and check its due date
    setInvoiceToUnlink({ transactionId, invoiceWillBeOverdue: true });
    setShowUnlinkConfirm(true);
  };

  const confirmUnlink = () => {
    if (invoiceToUnlink) {
      unlinkMutation.mutate(invoiceToUnlink.transactionId);
    }
  };

  const filteredTransactions = transactions.filter((t) =>
    t.counterparty.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.purpose.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.amount.toString().includes(searchQuery)
  );

  const unmatchedCount = transactions.filter((t) => !t.linkedInvoiceId).length;
  const toggleVisibilityClass = showLinked ? 'bg-gray-100 text-gray-700' : 'bg-info-bg text-info';
  const toggleVisibilityLabel = showLinked ? 'Nur unzugeordnete' : 'Alle anzeigen';

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
      {/* Header */}
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
              <h1 className="text-2xl font-bold text-gray-900">Transaktionen zuordnen</h1>
              <p className="text-sm text-gray-500 mt-1">
                {unmatchedCount} offene Transaktion{unmatchedCount !== 1 ? 'en' : ''}
              </p>
            </div>
          </div>

          <button
            onClick={() => setShowLinked(!showLinked)}
            className={`px-4 py-2 rounded-lg font-medium text-sm transition-all ${toggleVisibilityClass}`}
          >
            {toggleVisibilityLabel}
          </button>
        </div>

        {/* Search */}
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
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Transactions List */}
        <div className="w-1/2 border-r border-gray-200 overflow-y-auto">
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

        {/* Right: Match Suggestions or Details */}
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
                      0
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

                        {/* Match Reasons */}
                        <div className="space-y-1 mb-4 pb-4 border-b border-gray-100">
                          {suggestion.matchReasons.map((reason, idx) => (
                            <div key={idx} className="flex items-center gap-2 text-sm text-gray-600">
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
      </div>

      {/* Unlink Confirmation Dialog */}
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

      {/* Toast Notification */}
      <Toast
        message={toastMessage}
        type={toastType}
        isVisible={showToast}
        onClose={() => setShowToast(false)}
      />
    </div>
  );
};
