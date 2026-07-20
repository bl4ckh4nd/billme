import React from 'react';
import { TrendingUp, CheckCircle2, AlertCircle, Link2 } from 'lucide-react';
import type { Transaction } from '../../types';
import { formatCurrency, formatDate } from './formatters';

interface TransactionListProps {
  filteredTransactions: Transaction[];
  selectedTransaction: Transaction | null;
  onSelect: (transaction: Transaction) => void;
  showLinked: boolean;
  onToggleShowLinked: () => void;
  searchQuery: string;
}

export const TransactionList: React.FC<TransactionListProps> = ({
  filteredTransactions,
  selectedTransaction,
  onSelect,
  showLinked,
  onToggleShowLinked,
  searchQuery,
}) => {
  const toggleVisibilityClass = showLinked ? 'bg-canvas text-foreground' : 'bg-info-bg text-info';
  const toggleVisibilityLabel = showLinked ? 'Nur unzugeordnete' : 'Alle anzeigen';

  return (
    <div className="w-1/2 border-r border-border overflow-y-auto">
      <div className="p-4">
        <button
          onClick={onToggleShowLinked}
          className={`px-4 py-2 rounded-lg font-medium text-sm transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-150 ease-out ${toggleVisibilityClass}`}
        >
          {toggleVisibilityLabel}
        </button>
      </div>
      {filteredTransactions.length === 0 ? (
        <div className="flex flex-col items-center justify-center h-full text-muted p-8">
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

            let rowClass = 'border-border hover:border-border hover:shadow-sm';
            if (isSelected) {
              rowClass = 'border-info bg-info-bg';
            } else if (isLinked) {
              rowClass = 'border-success/30 bg-success-bg hover:border-success';
            }

            return (
              <div
                key={transaction.id}
                onClick={() => onSelect(transaction)}
                className={`p-4 rounded-lg border-2 cursor-pointer transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-150 ease-out animate-enter ${rowClass}`}
                style={{ animationDelay: `${idx * 50}ms` }}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      {isLinked ? (
                        <CheckCircle2 size={16} className="text-success flex-shrink-0" />
                      ) : (
                        <AlertCircle size={16} className="text-warning flex-shrink-0" />
                      )}
                      <span className="font-semibold text-foreground truncate">
                        {transaction.counterparty}
                      </span>
                    </div>
                    <p className="text-sm text-muted line-clamp-2">{transaction.purpose}</p>
                  </div>
                  <div className="text-right ml-4 flex-shrink-0">
                    <div className="text-lg tabular-nums font-bold text-success">
                      {formatCurrency(transaction.amount)}
                    </div>
                    <div className="text-xs text-muted">{formatDate(transaction.date)}</div>
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
  );
};
