import { X } from 'lucide-react';
import { ReportDrilldownEntry, ReportDrilldownSelection } from '../../domain/reportTypes';

function euro(value: number) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
}

interface ReportDrilldownPanelProps {
  selection: ReportDrilldownSelection | null;
  entries: ReportDrilldownEntry[];
  loading?: boolean;
  onClose: () => void;
  onOpenJournalEntry?: (transactionId: string) => void;
  onOpenReceipt?: (transactionId: string) => void;
}

export default function ReportDrilldownPanel({
  selection,
  entries,
  loading,
  onClose,
  onOpenJournalEntry,
  onOpenReceipt,
}: ReportDrilldownPanelProps) {
  if (!selection) return null;

  return (
    <aside className="w-full xl:w-[25rem] shrink-0 rounded-xl border border-border bg-surface flex flex-col min-h-[20rem]">
      <div className="px-4 h-12 border-b border-border-subtle flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide font-bold text-muted">{selection.reportType}</div>
          <div className="text-sm font-bold text-foreground truncate">{selection.targetLabel}</div>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-full border border-border text-muted hover:bg-surface-muted flex items-center justify-center transition-colors duration-150 ease-out"
          aria-label="Drilldown schließen"
        >
          <X size={14} />
        </button>
      </div>

      <div className="px-4 py-3 border-b border-border-subtle text-xs text-muted">
        Konten: {selection.accountNumbers.length > 0 ? selection.accountNumbers.join(', ') : '—'}
      </div>

      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          <div className="text-sm text-muted">Lade Drilldown…</div>
        ) : entries.length === 0 ? (
          <div className="text-sm text-muted">Keine Drilldown-Daten verfügbar.</div>
        ) : (
          <div className="space-y-2">
            {entries.map((entry) => (
              <div key={entry.id} className="rounded-xl border border-border-subtle p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-bold text-foreground">{entry.bookingText}</div>
                    <div className="text-xs text-muted mt-0.5">
                      {new Date(entry.date).toLocaleDateString('de-DE')} • {entry.reference ?? '—'} • {entry.source}
                    </div>
                  </div>
                  <div className={`text-sm font-bold tabular-nums whitespace-nowrap ${entry.amount >= 0 ? 'text-success' : 'text-error'}`}>
                    {euro(entry.amount)}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 mt-2 text-xs">
                  <div><span className="text-muted">Konto</span><div className="font-bold text-muted">{entry.accountNumber}</div></div>
                  <div><span className="text-muted">Soll</span><div className="font-bold tabular-nums text-muted">{euro(entry.debit)}</div></div>
                  <div><span className="text-muted">Haben</span><div className="font-bold tabular-nums text-muted">{euro(entry.credit)}</div></div>
                </div>
                {entry.transactionId ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      onClick={() => onOpenJournalEntry?.(entry.transactionId!)}
                      className="h-8 px-2.5 rounded-full border border-border text-xs font-bold text-muted hover:bg-surface-muted transition-colors duration-150 ease-out"
                    >
                      Journal öffnen
                    </button>
                    <button
                      onClick={() => onOpenReceipt?.(entry.transactionId!)}
                      className="h-8 px-2.5 rounded-full border border-border text-xs font-bold text-muted hover:bg-surface-muted transition-colors duration-150 ease-out"
                    >
                      Beleg öffnen
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
