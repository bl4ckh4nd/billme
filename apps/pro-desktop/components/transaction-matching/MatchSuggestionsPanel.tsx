import React from 'react';
import { FileText, AlertCircle, CheckCircle2, User, Calendar, Link2, Unlink } from 'lucide-react';
import type { Transaction } from '../../types';
import type { MatchResult } from './types';
import { formatCurrency, formatDate, getConfidenceBadge } from './formatters';

interface MatchSuggestionsPanelProps {
  selectedTransaction: Transaction | null;
  matchData: MatchResult | null | undefined;
  isLoadingMatches: boolean;
  onLink: (transactionId: string, invoiceId: string) => void;
  onUnlinkClick: (transactionId: string) => void;
  linkIsPending: boolean;
  unlinkIsPending: boolean;
}

export const MatchSuggestionsPanel: React.FC<MatchSuggestionsPanelProps> = ({
  selectedTransaction,
  matchData,
  isLoadingMatches,
  onLink,
  onUnlinkClick,
  linkIsPending,
  unlinkIsPending,
}) => {
  return (
    <div className="w-1/2 overflow-y-auto bg-surface-muted">
      {!selectedTransaction ? (
        <div className="flex flex-col items-center justify-center h-full text-muted p-8">
          <FileText size={48} className="mb-4 opacity-50" />
          <p className="text-lg font-medium">Keine Transaktion ausgewählt</p>
          <p className="text-sm text-center mt-2">
            Wählen Sie eine Transaktion aus, um passende Rechnungen zu sehen
          </p>
        </div>
      ) : selectedTransaction.linkedInvoiceId ? (
        <div className="p-6">
          <div className="bg-surface rounded-lg border border-success/30 p-6">
            <div className="flex items-center gap-3 mb-4">
              <CheckCircle2 size={24} className="text-success" />
              <h2 className="text-xl font-bold text-foreground">Bereits zugeordnet</h2>
            </div>
            <p className="text-muted mb-6">
              Diese Transaktion ist bereits einer Rechnung zugeordnet.
            </p>
            <button
              onClick={() => onUnlinkClick(selectedTransaction.id)}
              disabled={unlinkIsPending}
              className="px-4 py-2 bg-error-bg text-error hover:bg-error-bg/80 rounded-lg font-medium text-sm transition-colors duration-150 ease-out flex items-center gap-2 disabled:opacity-50"
            >
              <Unlink size={16} />
              Zuordnung aufheben
            </button>
          </div>
        </div>
      ) : (
        <div className="p-6">
          <h2 className="text-lg font-bold text-foreground mb-4">Passende Rechnungen</h2>

          {isLoadingMatches ? (
            <div className="flex items-center justify-center h-64">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-info"></div>
            </div>
          ) : !matchData || matchData.suggestions.length === 0 ? (
            <div className="bg-surface rounded-lg border border-border p-8 text-center">
              <AlertCircle size={48} className="mx-auto mb-4 text-muted" />
              <p className="text-foreground font-medium mb-2">Keine passenden Rechnungen gefunden</p>
              <p className="text-sm text-muted">
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
                    className="bg-surface rounded-lg border-2 border-border hover:border-info transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-150 ease-out p-4 animate-enter"
                    style={{ animationDelay: `${idx * 50}ms` }}
                  >
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-2">
                          <span className="font-bold text-foreground">{suggestion.invoice.number}</span>
                          {getConfidenceBadge(suggestion.confidence)}
                        </div>
                        <p className="text-sm text-muted mb-1">
                          <User size={14} className="inline mr-1" />
                          {suggestion.invoice.client}
                        </p>
                        <p className="text-sm text-muted">
                          <Calendar size={14} className="inline mr-1" />
                          Fällig: {formatDate(suggestion.invoice.dueDate)}
                        </p>
                      </div>
                      <div className="text-right ml-4">
                        <div className="text-lg tabular-nums font-bold text-foreground">
                          {formatCurrency(remaining)}
                        </div>
                        <div className="text-xs text-muted">offen</div>
                      </div>
                    </div>

                    <div className="space-y-1 mb-4 pb-4 border-b border-border-subtle">
                      {suggestion.matchReasons.map((reason, reasonIdx) => (
                        <div key={reasonIdx} className="flex items-center gap-2 text-sm text-muted">
                          <CheckCircle2 size={14} className="text-success flex-shrink-0" />
                          <span>{reason}</span>
                        </div>
                      ))}
                    </div>

                    <button
                      onClick={() => onLink(selectedTransaction.id, suggestion.invoice.id)}
                      disabled={linkIsPending}
                      className="w-full px-4 py-2 bg-info hover:bg-info/90 text-white rounded-lg font-medium text-sm transition-colors duration-150 ease-out flex items-center justify-center gap-2 disabled:opacity-50"
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
  );
};
