import React from 'react';
import { CheckCircle2, AlertCircle, XCircle, Sparkles, Ban } from 'lucide-react';
import { Spinner } from '../Spinner';
import type { EurTxItem, EurUndo } from './types';
import { keyOf } from './types';
import { formatCurrency } from './formatters';

type BulkResolver = (item: EurTxItem) => { eurLineId?: string; excluded?: boolean; vatMode?: 'none' | 'default' };

interface EurItemListProps {
  eurItems: EurTxItem[];
  eurLoading: boolean;
  eurSelected: Set<string>;
  onEurSelectedChange: (next: Set<string>) => void;
  eurActive: EurTxItem | null;
  onSetEurActive: (item: EurTxItem) => void;
  eurUndo: { label: string; changes: EurUndo[] } | null;
  eurPending: boolean;
  onUndo: () => void;
  onApplyBulk: (label: string, resolver: BulkResolver) => void;
}

export const EurItemList: React.FC<EurItemListProps> = ({
  eurItems,
  eurLoading,
  eurSelected,
  onEurSelectedChange,
  eurActive,
  onSetEurActive,
  eurUndo,
  eurPending,
  onUndo,
  onApplyBulk,
}) => {
  return (
    <div className="w-1/2 border-r border-border overflow-y-auto">
      {eurUndo && (
        <div className="m-4 rounded-xl border border-warning-border bg-warning-bg p-3 flex items-center justify-between gap-2">
          <span className="text-xs text-foreground">{eurUndo.label}</span>
          <button
            onClick={() => void onUndo()}
            disabled={eurPending}
            className="px-2 py-1 rounded-md bg-surface border border-warning-border text-xs font-semibold text-warning"
          >
            Rückgängig
          </button>
        </div>
      )}

      <div className="m-4 rounded-xl border border-border p-3">
        <div className="text-xs text-muted mb-2">Bulk-Aktionen ({eurSelected.size} ausgewählt)</div>
        <div className="grid grid-cols-1 gap-2">
          <button
            onClick={() =>
              void onApplyBulk('Bulk: Vorschlag anwenden', (item) => ({
                eurLineId: item.suggestedLineId,
                excluded: false,
                vatMode: item.classification?.vatMode ?? 'none',
              }))
            }
            disabled={eurSelected.size === 0 || eurPending}
            className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-left hover:bg-canvas transition-colors duration-150 ease-out disabled:opacity-60"
          >
            <Sparkles size={14} className="text-info flex-shrink-0" />
            Vorschlag anwenden
          </button>
          <button
            onClick={() =>
              void onApplyBulk('Bulk: Als privat/Transfer markieren', () => ({
                eurLineId: undefined,
                excluded: true,
                vatMode: 'none',
              }))
            }
            disabled={eurSelected.size === 0 || eurPending}
            className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-left hover:bg-canvas transition-colors duration-150 ease-out disabled:opacity-60"
          >
            <Ban size={14} className="text-error flex-shrink-0" />
            Als privat/Transfer markieren
          </button>
        </div>
      </div>

      {eurLoading ? (
        <div className="flex flex-col items-center justify-center py-12">
          <Spinner size="md" />
          <p className="text-sm text-muted mt-3">Lade EÜR-Elemente...</p>
        </div>
      ) : eurItems.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted">
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
                className={`p-3 rounded-xl border ${isActive ? 'border-foreground bg-surface-muted' : 'border-border hover:border-border'}`}
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
                      onEurSelectedChange(next);
                    }}
                  />
                  <button
                    onClick={() => onSetEurActive(item)}
                    className="flex-1 text-left"
                  >
                    <div className="flex items-center gap-1.5 text-xs text-muted">
                      {item.classification?.excluded ? (
                        <XCircle size={14} className="text-error" />
                      ) : item.classification?.eurLineId ? (
                        <CheckCircle2 size={14} className="text-success" />
                      ) : (
                        <AlertCircle size={14} className="text-warning" />
                      )}
                      <span>{item.date}</span>
                      <span className="text-border">|</span>
                      <span>{item.flowType === 'income' ? 'Einnahme' : 'Ausgabe'}</span>
                    </div>
                    <div className="text-sm font-semibold text-foreground truncate">{item.counterparty}</div>
                    <div className="text-xs text-muted truncate">{item.purpose}</div>
                    <div className={`text-sm tabular-nums font-bold mt-1 ${
                      item.flowType === 'income' ? 'text-success' : 'text-error'
                    }`}>
                      {item.flowType === 'income' ? '+' : '-'}{formatCurrency(item.amountGross)}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-2">
                      {item.classification?.excluded ? (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-error-bg text-error">Ausgeschlossen</span>
                      ) : item.classification?.eurLineId ? (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-success-bg text-success">Klassifiziert</span>
                      ) : (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-warning-bg text-warning">Offen</span>
                      )}
                      {item.suggestedLineId && !item.classification?.eurLineId && !item.classification?.excluded && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-info-bg text-info">Vorschlag</span>
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
  );
};
