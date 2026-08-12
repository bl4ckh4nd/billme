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
    <aside className="w-full xl:w-[25rem] shrink-0 rounded-2xl border border-gray-200 bg-white flex flex-col min-h-[20rem]">
      <div className="px-4 h-12 border-b border-gray-100 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] uppercase tracking-wide font-bold text-gray-400">{selection.reportType}</div>
          <div className="text-sm font-bold text-gray-900 truncate">{selection.targetLabel}</div>
        </div>
        <button
          onClick={onClose}
          className="w-8 h-8 rounded-full border border-gray-200 text-gray-600 hover:bg-gray-50 flex items-center justify-center transition-colors"
          aria-label="Drilldown schließen"
        >
          <X size={14} />
        </button>
      </div>

      <div className="px-4 py-3 border-b border-gray-100 text-xs text-gray-500">
        Konten: {selection.accountNumbers.length > 0 ? selection.accountNumbers.join(', ') : '—'}
      </div>

      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          <div className="text-sm text-gray-500">Lade Drilldown…</div>
        ) : entries.length === 0 ? (
          <div className="text-sm text-gray-500">Keine Drilldown-Daten verfügbar.</div>
        ) : (
          <div className="space-y-2">
            {entries.map((entry) => (
              <div key={entry.id} className="rounded-xl border border-gray-100 p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-bold text-gray-800">{entry.bookingText}</div>
                    <div className="text-xs text-gray-500 mt-0.5">
                      {new Date(entry.date).toLocaleDateString('de-DE')} • {entry.reference ?? '—'} • {entry.source}
                    </div>
                  </div>
                  <div className={`text-sm font-bold whitespace-nowrap ${entry.amount >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                    {euro(entry.amount)}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 mt-2 text-xs">
                  <div><span className="text-gray-400">Konto</span><div className="font-bold text-gray-700">{entry.accountNumber}</div></div>
                  <div><span className="text-gray-400">Soll</span><div className="font-bold text-gray-700">{euro(entry.debit)}</div></div>
                  <div><span className="text-gray-400">Haben</span><div className="font-bold text-gray-700">{euro(entry.credit)}</div></div>
                </div>
                <div className="mt-2 rounded-lg bg-gray-50 px-2.5 py-2 text-[11px] text-gray-600" data-testid={`drilldown-source-${entry.id}`}>
                  <div>Quelle: <span className="font-semibold">{entry.sourceType}</span> · {entry.sourceId}</div>
                  <div>Journal-ID: <span className="font-mono">{entry.journalEntryId}</span></div>
                </div>
                {((entry.sourceType === 'bank_transaction' && onOpenTransaction) ||
                  (entry.sourceType === 'invoice' && onOpenInvoice) ||
                  (entry.sourceType === 'incoming_invoice' && onOpenIncomingInvoice) ||
                  ((entry.sourceType === 'payment' || entry.sourceType === 'journal_entry') && onOpenJournalEntry)) ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {entry.sourceType === 'bank_transaction' && onOpenTransaction ? (
                      <button
                        onClick={() => onOpenTransaction(entry.sourceId)}
                        className="h-8 px-2.5 rounded-full border border-gray-200 text-xs font-bold text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        Transaktion öffnen
                      </button>
                    ) : null}
                    {entry.sourceType === 'invoice' && onOpenInvoice ? (
                      <button
                        onClick={() => onOpenInvoice(entry.sourceId)}
                        className="h-8 px-2.5 rounded-full border border-gray-200 text-xs font-bold text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        Rechnung öffnen
                      </button>
                    ) : null}
                    {entry.sourceType === 'incoming_invoice' && onOpenIncomingInvoice ? (
                      <button
                        onClick={() => onOpenIncomingInvoice(entry.sourceId)}
                        className="h-8 px-2.5 rounded-full border border-gray-200 text-xs font-bold text-gray-700 hover:bg-gray-50 transition-colors"
                      >
                        Eingangsrechnung öffnen
                      </button>
                    ) : null}
                    {(entry.sourceType === 'payment' || entry.sourceType === 'journal_entry') && onOpenJournalEntry ? (
                      <button
                        onClick={() => onOpenJournalEntry(entry.journalEntryId)}
                        className="h-8 px-2.5 rounded-full border border-gray-200 text-xs font-bold text-gray-700 hover:bg-gray-50 transition-colors"
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
