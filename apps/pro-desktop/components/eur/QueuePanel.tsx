import React from 'react';
import {
  CheckCircle2,
  AlertCircle,
  XCircle,
  Search,
  SearchX,
  Sparkles,
  RotateCcw,
  Ban,
  ClipboardList,
} from 'lucide-react';
import { Spinner } from '../Spinner';
import {
  type EurItem,
  type QueueStatus,
  type QueueSort,
  LAYER_LABELS,
  LAYER_COLORS,
  formatCurrency,
  itemKey,
} from './types';

type StatusCounts = {
  all: number;
  unclassified: number;
  classified: number;
  excluded: number;
};

type Props = {
  queueItems: EurItem[];
  selectedItems: EurItem[];
  statusCounts: StatusCounts;
  queueStatus: QueueStatus;
  onQueueStatusChange: (status: QueueStatus) => void;
  query: string;
  onQueryChange: (q: string) => void;
  flowFilter: 'all' | 'income' | 'expense';
  onFlowFilterChange: (f: 'all' | 'income' | 'expense') => void;
  queueSort: QueueSort;
  onQueueSortChange: (s: QueueSort) => void;
  selectedKeys: Set<string>;
  onSelectedKeysChange: (keys: Set<string>) => void;
  isApplying: boolean;
  itemsLoading: boolean;
  activeSource: { sourceType: EurItem['sourceType']; sourceId: string } | null;
  onActiveSourceChange: (source: { sourceType: EurItem['sourceType']; sourceId: string }) => void;
  onApplyBulkSuggestion: () => void;
  onApplyBulkExclude: () => void;
  onApplyBulkReset: () => void;
};

export const QueuePanel: React.FC<Props> = ({
  queueItems,
  selectedItems,
  statusCounts,
  queueStatus,
  onQueueStatusChange,
  query,
  onQueryChange,
  flowFilter,
  onFlowFilterChange,
  queueSort,
  onQueueSortChange,
  selectedKeys,
  onSelectedKeysChange,
  isApplying,
  itemsLoading,
  activeSource,
  onActiveSourceChange,
  onApplyBulkSuggestion,
  onApplyBulkExclude,
  onApplyBulkReset,
}) => {
  return (
    <div className="rounded-xl border border-border p-4 lg:col-span-1">
      <h3 className="font-bold text-foreground mb-3 flex items-center gap-2">
        <ClipboardList size={18} className="text-muted" />
        Queue
        <span className="text-xs font-normal text-muted ml-auto">{queueItems.length} Einträge</span>
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
              onClick={() => onQueueStatusChange(status)}
              className={`rounded-md px-2 py-1.5 font-medium transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-150 ease-out ${
                queueStatus === status
                  ? 'bg-surface shadow font-semibold text-foreground'
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
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Gegenpartei, Zweck oder Datum..."
          className="w-full pl-9 pr-3 py-2 rounded-lg border border-border text-sm focus:outline-none focus:ring-2 focus:ring-accent"
        />
      </div>

      {/* Flow & Sort Filters */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <select
          value={flowFilter}
          onChange={(e) => onFlowFilterChange(e.target.value as 'all' | 'income' | 'expense')}
          className="rounded-lg border border-border px-3 py-2 text-sm"
        >
          <option value="all">Alle Typen</option>
          <option value="income">Einnahmen</option>
          <option value="expense">Ausgaben</option>
        </select>
        <select
          value={queueSort}
          onChange={(e) => onQueueSortChange(e.target.value as QueueSort)}
          className="rounded-lg border border-border px-3 py-2 text-sm"
        >
          <option value="date_desc">Neueste zuerst</option>
          <option value="amount_desc">Betrag absteigend</option>
          <option value="counterparty_asc">Name A-Z</option>
        </select>
      </div>

      {/* Bulk Actions */}
      <div className="mb-3 rounded-lg border border-border bg-surface-muted p-3">
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs font-bold text-foreground flex items-center gap-2">
            <input
              type="checkbox"
              checked={queueItems.length > 0 && selectedItems.length === queueItems.length}
              onChange={(e) => {
                if (e.target.checked) {
                  onSelectedKeysChange(new Set(queueItems.map((item) => itemKey(item))));
                } else {
                  onSelectedKeysChange(new Set());
                }
              }}
            />
            {selectedItems.length} ausgewählt
          </label>
          <button
            onClick={() => onSelectedKeysChange(new Set())}
            className="text-xs text-muted hover:text-foreground transition-colors duration-150 ease-out"
          >
            Auswahl löschen
          </button>
        </div>
        <div className="grid grid-cols-1 gap-1.5">
          <button
            onClick={onApplyBulkSuggestion}
            disabled={selectedItems.length === 0 || isApplying}
            className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-left hover:bg-canvas transition-colors duration-150 ease-out disabled:opacity-50"
          >
            <Sparkles size={14} className="text-info flex-shrink-0" />
            Vorschlag anwenden
          </button>
          <button
            onClick={onApplyBulkExclude}
            disabled={selectedItems.length === 0 || isApplying}
            className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-left hover:bg-canvas transition-colors duration-150 ease-out disabled:opacity-50"
          >
            <Ban size={14} className="text-error flex-shrink-0" />
            Als privat/Transfer markieren
          </button>
          <button
            onClick={onApplyBulkReset}
            disabled={selectedItems.length === 0 || isApplying}
            className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs text-left hover:bg-canvas transition-colors duration-150 ease-out disabled:opacity-50"
          >
            <RotateCcw size={14} className="text-muted flex-shrink-0" />
            Klassifizierung zurücksetzen
          </button>
        </div>
      </div>

      {/* Queue Items */}
      {itemsLoading ? (
        <div className="flex flex-col items-center justify-center py-12">
          <Spinner size="md" />
          <p className="text-sm text-muted mt-3">Lade Einträge...</p>
        </div>
      ) : queueItems.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-muted">
          {query.trim().length > 0 ? (
            <>
              <SearchX size={40} className="mb-3 opacity-50" />
              <p className="text-sm font-medium">Keine Treffer</p>
              <p className="text-xs text-center mt-1">Keine Einträge für «{query.trim()}».</p>
            </>
          ) : (
            <>
              <CheckCircle2 size={40} className="mb-3 opacity-50" />
              <p className="text-sm font-medium">
                {queueStatus === 'unclassified' ? 'Alle klassifiziert' : 'Keine Einträge'}
              </p>
              <p className="text-xs text-center mt-1">
                {queueStatus === 'unclassified'
                  ? 'Alle Einträge sind bereits klassifiziert.'
                  : 'Keine Einträge für diesen Filter.'}
              </p>
            </>
          )}
        </div>
      ) : (
        <div className="space-y-2 max-h-[460px] overflow-auto pr-1">
          {queueItems.map((item, idx) => {
            const key = itemKey(item);
            const isActive = activeSource?.sourceType === item.sourceType && activeSource.sourceId === item.sourceId;
            return (
              <div
                key={key}
                className={`w-full text-left p-3 rounded-lg border transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-150 ease-out animate-enter ${
                  isActive ? 'border-foreground bg-surface-muted shadow-sm' : 'border-border hover:shadow-sm'
                }`}
                style={{ animationDelay: `${idx * 30}ms` }}
              >
                <div className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selectedKeys.has(key)}
                    onChange={(e) => {
                      const next = new Set(selectedKeys);
                      if (e.target.checked) next.add(key);
                      else next.delete(key);
                      onSelectedKeysChange(next);
                    }}
                  />
                  <button
                    onClick={() => onActiveSourceChange({ sourceType: item.sourceType, sourceId: item.sourceId })}
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
                      <span>{item.sourceType === 'transaction' ? 'Bank' : 'Rechnung'}</span>
                    </div>
                    <div className="text-sm font-semibold text-foreground truncate">{item.counterparty}</div>
                    <div className="text-xs text-muted truncate">{item.purpose}</div>
                    <div className={`text-sm tabular-nums font-bold mt-1 ${
                      item.flowType === 'income' ? 'text-success' : 'text-error'
                    }`}>
                      {item.flowType === 'income' ? '+' : '-'}{formatCurrency(item.amountGross)}
                    </div>
                    <div className="flex flex-wrap gap-1 mt-2 text-[11px]">
                      {item.classification?.excluded ? (
                        <span className="px-2 py-0.5 rounded-full bg-error-bg text-error">Ausgeschlossen</span>
                      ) : item.classification?.eurLineId ? (
                        <span className="px-2 py-0.5 rounded-full bg-success-bg text-success">Klassifiziert</span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full bg-warning-bg text-warning">Offen</span>
                      )}
                      {item.flowType === 'income' ? (
                        <span className="px-2 py-0.5 rounded-full bg-success-bg text-success">Einnahme</span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full bg-error-bg text-error">Ausgabe</span>
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
  );
};
