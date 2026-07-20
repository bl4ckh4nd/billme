import {
  CheckSquare,
  Filter,
  Inbox,
  PanelRightClose,
  PanelRightOpen,
  Wand2,
} from 'lucide-react';
import { InboxQueueKey } from '../../domain/selectors';
import { mockAccounts } from '../../mocks/accounts';
import AccountCombobox from '../AccountCombobox';
import InboxQueueTabs from '../InboxQueueTabs';
import { Account, BookingAction } from '../../types';

interface InboxHeaderProps {
  activeQueue: InboxQueueKey;
  queueCounts: Record<InboxQueueKey, number>;
  onQueueChange: (queue: InboxQueueKey) => void;
  selectedIds: string[];
  allVisibleSelected: boolean;
  onToggleSelectAll: () => void;
  previewTxExists: boolean;
  onSelectSimilar: () => void;
  batchAccountSelection: { id: string; name: string } | null;
  onBatchAccountSelect: (account: Account) => void;
  onAssignBatchAccount: () => void;
  onBatchAction: (action: BookingAction) => void;
  batchMessage: string;
  filteredCount: number;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
}

export default function InboxHeader({
  activeQueue,
  queueCounts,
  onQueueChange,
  selectedIds,
  allVisibleSelected,
  onToggleSelectAll,
  previewTxExists,
  onSelectSimilar,
  batchAccountSelection,
  onBatchAccountSelect,
  onAssignBatchAccount,
  onBatchAction,
  batchMessage,
  filteredCount,
  sidebarCollapsed,
  onToggleSidebar,
}: InboxHeaderProps) {
  return (
    <>
      {/* Header — compact two-row layout */}
      <div className="px-6 pt-3 pb-0 border-b border-border-subtle shrink-0">
        {/* Row 1: icon + title + Filter + Bankabgleich */}
        <div className="flex items-center gap-3 pb-3">
          <div className="w-8 h-8 bg-foreground rounded-lg flex items-center justify-center text-accent-lime shrink-0">
            <Inbox size={15} />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-sm font-black text-foreground leading-tight">Buchungs-Inbox</h1>
            <p className="text-xs text-muted font-medium leading-tight">
              Workflow-Queues, Validierungen und Freigaben.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button className="h-8 flex items-center gap-1.5 px-3 bg-surface border border-border rounded-full text-xs font-bold text-muted hover:bg-surface-muted transition-colors duration-150 ease-out">
              <Filter size={13} />
              Filter
            </button>
            <button className="h-8 px-4 bg-foreground rounded-full text-xs font-bold text-white hover:bg-foreground transition-colors duration-150 ease-out">
              Bankabgleich (n/a)
            </button>
          </div>
        </div>

        {/* Row 2: queue tabs + select tools */}
        <div className="flex items-center gap-3 pb-2">
          <InboxQueueTabs activeQueue={activeQueue} counts={queueCounts} onChange={onQueueChange} />
          <div className="ml-auto flex items-center gap-1.5 shrink-0">
            <button
              onClick={onToggleSelectAll}
              className="h-7 px-2.5 rounded-full border border-border bg-surface text-[11px] font-bold text-muted hover:bg-surface-muted inline-flex items-center gap-1 transition-colors duration-150 ease-out"
            >
              <CheckSquare size={11} />
              {allVisibleSelected ? 'Auswahl aufheben' : 'Sichtbare markieren'}
            </button>
            <button
              onClick={onSelectSimilar}
              disabled={!previewTxExists}
              className="h-7 px-2.5 rounded-full border border-border bg-surface text-[11px] font-bold text-muted hover:bg-surface-muted disabled:opacity-40 inline-flex items-center gap-1 transition-colors duration-150 ease-out"
            >
              <Wand2 size={11} />
              Ähnliche markieren
            </button>
          </div>
        </div>

        {selectedIds.length > 0 && (
          <div className="rounded-xl border border-border bg-surface-muted/60 p-3 mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-medium text-muted">
              <span className="font-bold">{selectedIds.length}</span> Vorgänge markiert für Sammelverarbeitung
            </div>
            <div className="flex flex-wrap gap-2">
              <div className="min-w-[16rem] max-w-[18rem]">
                <AccountCombobox
                  accounts={mockAccounts}
                  valueAccountId={batchAccountSelection?.id ?? ''}
                  valueAccountName={batchAccountSelection?.name ?? ''}
                  placeholder="Sammel-Konto wählen..."
                  onSelect={onBatchAccountSelect}
                />
              </div>
              <button
                onClick={onAssignBatchAccount}
                className="h-9 px-3 rounded-full border border-border text-xs font-bold text-muted hover:bg-surface-muted transition-colors duration-150 ease-out"
              >
                Konto zuweisen
              </button>
              <button
                onClick={() => onBatchAction('request_receipt')}
                className="h-9 px-3 rounded-full border border-border text-xs font-bold text-muted hover:bg-surface-muted transition-colors duration-150 ease-out"
              >
                Beleg anfordern
              </button>
              <button
                onClick={() => onBatchAction('submit_for_review')}
                className="h-9 px-3 rounded-full border border-border text-xs font-bold text-muted hover:bg-surface-muted transition-colors duration-150 ease-out"
              >
                Zur Prüfung
              </button>
              <button
                onClick={() => onBatchAction('approve')}
                className="h-9 px-3 rounded-full border border-border text-xs font-bold text-muted hover:bg-surface-muted transition-colors duration-150 ease-out"
              >
                Freigeben
              </button>
              <button
                onClick={() => onBatchAction('post')}
                className="h-9 px-3 rounded-full bg-foreground text-white text-xs font-bold hover:bg-foreground transition-colors duration-150 ease-out"
              >
                Sammel-Buchen
              </button>
            </div>
          </div>
        )}

        {batchMessage && (
          <div className="rounded-xl border border-border bg-surface-muted px-4 py-2 text-sm text-muted">
            {batchMessage}
          </div>
        )}
      </div>

      {/* Toolbar row with count + Einklappen */}
      <div className="flex items-center justify-between px-6 py-2.5 border-b border-border-subtle bg-surface-muted/40 shrink-0">
        <span className="text-xs font-bold text-muted uppercase tracking-wide">
          {filteredCount} Vorgänge
        </span>
        <button
          onClick={onToggleSidebar}
          className="h-8 px-3 rounded-full border border-border bg-surface text-xs font-bold text-muted hover:bg-surface-muted inline-flex items-center gap-1.5 transition-colors duration-150 ease-out"
        >
          {sidebarCollapsed ? <PanelRightOpen size={13} /> : <PanelRightClose size={13} />}
          {sidebarCollapsed ? 'Einblenden' : 'Einklappen'}
        </button>
      </div>
    </>
  );
}
