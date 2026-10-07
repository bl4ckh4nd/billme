import { X } from 'lucide-react';
import { Button, formatEmptyValue, IconButton } from '@billme/ui';
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
    <aside className="flex min-h-80 w-full shrink-0 flex-col rounded-card border border-border bg-surface xl:w-96">
      <div className="flex items-center justify-between gap-3 border-b border-border px-3.5 py-2.5">
        <div className="min-w-0">
          <div className="text-caption text-muted">{REPORT_TYPE_LABEL[selection.reportType]}</div>
          <div className="truncate text-sm font-semibold text-foreground">{selection.targetLabel}</div>
        </div>
        <IconButton onClick={onClose} aria-label="Drilldown schließen">
          <X size={16} aria-hidden="true" />
        </IconButton>
      </div>

      <div className="border-b border-border px-3.5 py-2.5 text-caption text-muted">
        Konten: {formatEmptyValue(selection.accountNumbers.join(', '))}
      </div>

      <div className="flex-1 overflow-auto px-3.5">
        {loading ? (
          <div className="py-3 text-control text-muted">Lade Drilldown…</div>
        ) : entries.length === 0 ? (
          <div className="py-3 text-control text-muted">Keine Drilldown-Daten verfügbar.</div>
        ) : (
          <div className="divide-y divide-border">
            {entries.map((entry) => (
              <div key={entry.id} className="py-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-foreground">{entry.bookingText}</div>
                    <div className="mt-0.5 text-caption text-muted">
                      {new Date(entry.date).toLocaleDateString('de-DE')} • {formatEmptyValue(entry.reference)} • {entry.source}
                    </div>
                  </div>
                  <div className={`whitespace-nowrap text-sm font-bold tabular-nums ${entry.amount >= 0 ? 'text-success-text' : 'text-error-text'}`}>
                    {euro(entry.amount)}
                  </div>
                </div>
                <div className="mt-2 grid grid-cols-3 gap-2 text-caption">
                  <div><span className="text-muted">Konto</span><div className="font-semibold text-foreground">{entry.accountNumber}</div></div>
                  <div><span className="text-muted">Soll</span><div className="font-semibold tabular-nums text-foreground">{euro(entry.debit)}</div></div>
                  <div><span className="text-muted">Haben</span><div className="font-semibold tabular-nums text-foreground">{euro(entry.credit)}</div></div>
                </div>
                <div className="mt-2 rounded-control bg-surface-sunken px-2.5 py-2 text-caption text-muted" data-testid={`drilldown-source-${entry.id}`}>
                  <div>Quelle: <span className="font-semibold">{SOURCE_TYPE_LABEL[entry.sourceType]}</span> · {entry.sourceId}</div>
                  <div>Journalbuchung: <span className="font-mono">{entry.journalEntryId}</span></div>
                </div>
                {((entry.sourceType === 'bank_transaction' && onOpenTransaction) ||
                  (entry.sourceType === 'invoice' && onOpenInvoice) ||
                  (entry.sourceType === 'incoming_invoice' && onOpenIncomingInvoice) ||
                  ((entry.sourceType === 'payment' || entry.sourceType === 'journal_entry') && onOpenJournalEntry)) ? (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {entry.sourceType === 'bank_transaction' && onOpenTransaction ? (
                      <Button size="sm" variant="secondary" onClick={() => onOpenTransaction(entry.sourceId)}>
                        Transaktion öffnen
                      </Button>
                    ) : null}
                    {entry.sourceType === 'invoice' && onOpenInvoice ? (
                      <Button size="sm" variant="secondary" onClick={() => onOpenInvoice(entry.sourceId)}>
                        Rechnung öffnen
                      </Button>
                    ) : null}
                    {entry.sourceType === 'incoming_invoice' && onOpenIncomingInvoice ? (
                      <Button size="sm" variant="secondary" onClick={() => onOpenIncomingInvoice(entry.sourceId)}>
                        Eingangsrechnung öffnen
                      </Button>
                    ) : null}
                    {(entry.sourceType === 'payment' || entry.sourceType === 'journal_entry') && onOpenJournalEntry ? (
                      <Button size="sm" variant="secondary" onClick={() => onOpenJournalEntry(entry.journalEntryId)}>
                        Journal öffnen
                      </Button>
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
