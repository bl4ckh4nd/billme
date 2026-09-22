import { X } from 'lucide-react';
import { formatEmptyValue } from '@billme/ui';
import { ReportDrilldownEntry, ReportDrilldownSelection, ReportDrilldownSourceType } from '../../domain/reportTypes';

function euro(value: number) {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
}

/** The drilldown carries report and source ids from the domain; the panel shows their German names. */
const REPORT_TYPE_LABEL: Record<ReportDrilldownSelection['reportType'], string> = {
  susa: 'Summen- und Saldenliste',
  guv: 'Gewinn- und Verlustrechnung',
  bilanz: 'Bilanz nach HGB',
};

const SOURCE_TYPE_LABEL: Record<ReportDrilldownSourceType, string> = {
  bank_transaction: 'Banktransaktion',
  invoice: 'Rechnung',
  incoming_invoice: 'Eingangsrechnung',
  receipt: 'Beleg',
  payment: 'Zahlung',
  journal_entry: 'Journalbuchung',
};

interface ReportDrilldownPanelProps {
  selection: ReportDrilldownSelection | null;
  entries: ReportDrilldownEntry[];
  loading?: boolean;
  onClose: () => void;
  onOpenTransaction?: (transactionId: string) => void;
  onOpenInvoice?: (invoiceId: string) => void;
  onOpenIncomingInvoice?: (invoiceId: string) => void;
  onOpenJournalEntry?: (journalEntryId: string) => void;
}

export default function ReportDrilldownPanel({
  selection,
  entries,
  loading,
  onClose,
  onOpenTransaction,
  onOpenInvoice,
  onOpenIncomingInvoice,
  onOpenJournalEntry,
}: ReportDrilldownPanelProps) {
  if (!selection) return null;

  return (
    <aside className="w-full xl:w-96 shrink-0 rounded-2xl border border-border bg-surface flex flex-col min-h-[20rem]">
      <div className="px-4 h-12 border-b border-subtle flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-bold text-muted">{REPORT_TYPE_LABEL[selection.reportType]}</div>
          <div className="text-sm font-bold text-foreground truncate">{selection.targetLabel}</div>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-lg border border-control-border text-muted hover:bg-surface-muted flex items-center justify-center transition-colors"
          aria-label="Drilldown schließen"
        >
          <X size={14} />
        </button>
      </div>

      <div className="px-4 py-3 border-b border-subtle text-xs text-muted">
        Konten: {formatEmptyValue(selection.accountNumbers.join(', '))}
      </div>

      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          <div className="text-sm text-muted">Lade Drilldown…</div>
        ) : entries.length === 0 ? (
          <div className="text-sm text-muted">Keine Drilldown-Daten verfügbar.</div>
        ) : (
          <div className="space-y-2">
            {entries.map((entry) => (
              <div key={entry.id} className="rounded-xl border border-subtle p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-bold text-foreground">{entry.bookingText}</div>
                    <div className="text-xs text-muted mt-0.5">
                      {new Date(entry.date).toLocaleDateString('de-DE')} • {formatEmptyValue(entry.reference)} • {entry.source}
                    </div>
                  </div>
                  <div className={`text-sm font-bold tabular-nums whitespace-nowrap ${entry.amount >= 0 ? 'text-success-text' : 'text-error-text'}`}>
                    {euro(entry.amount)}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 mt-2 text-xs">
                  <div><span className="text-muted">Konto</span><div className="font-bold text-foreground">{entry.accountNumber}</div></div>
                  <div><span className="text-muted">Soll</span><div className="font-bold tabular-nums text-foreground">{euro(entry.debit)}</div></div>
                  <div><span className="text-muted">Haben</span><div className="font-bold tabular-nums text-foreground">{euro(entry.credit)}</div></div>
                </div>
                <div className="mt-2 rounded-lg bg-surface-muted px-2.5 py-2 text-xs text-muted" data-testid={`drilldown-source-${entry.id}`}>
                  <div>Quelle: <span className="font-semibold">{SOURCE_TYPE_LABEL[entry.sourceType]}</span> · {entry.sourceId}</div>
                  <div>Journalbuchung: <span className="font-mono">{entry.journalEntryId}</span></div>
                </div>
                {((entry.sourceType === 'bank_transaction' && onOpenTransaction) ||
                  (entry.sourceType === 'invoice' && onOpenInvoice) ||
                  (entry.sourceType === 'incoming_invoice' && onOpenIncomingInvoice) ||
                  ((entry.sourceType === 'payment' || entry.sourceType === 'journal_entry') && onOpenJournalEntry)) ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {entry.sourceType === 'bank_transaction' && onOpenTransaction ? (
                      <button
                        onClick={() => onOpenTransaction(entry.sourceId)}
                        className="h-8 px-2.5 rounded-lg border border-control-border text-xs font-bold text-foreground hover:bg-surface-muted transition-colors"
                      >
                        Transaktion öffnen
                      </button>
                    ) : null}
                    {entry.sourceType === 'invoice' && onOpenInvoice ? (
                      <button
                        onClick={() => onOpenInvoice(entry.sourceId)}
                        className="h-8 px-2.5 rounded-lg border border-control-border text-xs font-bold text-foreground hover:bg-surface-muted transition-colors"
                      >
                        Rechnung öffnen
                      </button>
                    ) : null}
                    {entry.sourceType === 'incoming_invoice' && onOpenIncomingInvoice ? (
                      <button
                        onClick={() => onOpenIncomingInvoice(entry.sourceId)}
                        className="h-8 px-2.5 rounded-lg border border-control-border text-xs font-bold text-foreground hover:bg-surface-muted transition-colors"
                      >
                        Eingangsrechnung öffnen
                      </button>
                    ) : null}
                    {(entry.sourceType === 'payment' || entry.sourceType === 'journal_entry') && onOpenJournalEntry ? (
                      <button
                        onClick={() => onOpenJournalEntry(entry.journalEntryId)}
                        className="h-8 px-2.5 rounded-lg border border-control-border text-xs font-bold text-foreground hover:bg-surface-muted transition-colors"
                      >
                        Journal öffnen
                      </button>
                    ) : null}
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
