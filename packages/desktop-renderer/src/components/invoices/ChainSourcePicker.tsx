import React from 'react';
import { Search } from 'lucide-react';
import { Button, EmptyState, Input, Modal } from '@billme/ui';
import { getInvoiceDocumentLabel, type Invoice, type Offer } from '@billme/desktop-core/types';
import { formatCurrency } from '@billme/desktop-utils';

/** Follow-up documents the "Neu" menu can start; each needs its source document. */
export type ChainStartAction = 'order_confirmation' | 'delivery_note' | 'advance_invoice' | 'partial_invoice' | 'final_invoice' | 'credit_note' | 'cancellation_invoice';

export const CHAIN_START_LABELS: Record<ChainStartAction, string> = {
  order_confirmation: 'Auftragsbestätigung',
  delivery_note: 'Lieferschein',
  advance_invoice: 'Abschlagsrechnung',
  partial_invoice: 'Teilrechnung',
  final_invoice: 'Schlussrechnung',
  credit_note: 'Gutschrift',
  cancellation_invoice: 'Stornorechnung',
};

const SOURCE_TEXT: Record<ChainStartAction, { question: string; empty: string }> = {
  order_confirmation: {
    question: 'Aus welchem angenommenen Angebot?',
    empty: 'Eine Auftragsbestätigung entsteht aus einem angenommenen Angebot. Markiere zuerst ein Angebot als angenommen.',
  },
  delivery_note: {
    question: 'Zu welcher Auftragsbestätigung?',
    empty: 'Ein Lieferschein gehört zu einer Auftragsbestätigung. Lege zuerst eine aus einem angenommenen Angebot an.',
  },
  advance_invoice: {
    question: 'Zu welcher Auftragsbestätigung?',
    empty: 'Eine Abschlagsrechnung gehört zu einer Auftragsbestätigung. Lege zuerst eine aus einem angenommenen Angebot an.',
  },
  partial_invoice: {
    question: 'Zu welcher Auftragsbestätigung?',
    empty: 'Eine Teilrechnung gehört zu einer Auftragsbestätigung mit offenem Restbetrag.',
  },
  final_invoice: {
    question: 'Welcher Auftrag wird abgerechnet? Die Schlussrechnung zieht alle Abschläge und Teilrechnungen ab.',
    empty: 'Eine Schlussrechnung gehört zu einer Auftragsbestätigung mit offenem Restbetrag.',
  },
  credit_note: {
    question: 'Für welche gestellte Rechnung?',
    empty: 'Eine Gutschrift korrigiert eine gestellte Rechnung. Es gibt noch keine.',
  },
  cancellation_invoice: {
    question: 'Welche gestellte Rechnung wird storniert?',
    empty: 'Eine Stornorechnung hebt eine gestellte Rechnung auf. Es gibt noch keine.',
  },
};

/**
 * Picks the source document for a follow-up document started from the "Neu"
 * menu. Only documents the chain accepts as a source are offered, so the
 * GoBD document chain stays intact.
 */
export const ChainSourcePicker: React.FC<{
  action: ChainStartAction | null;
  sources: ReadonlyArray<Invoice | Offer>;
  onPick: (source: Invoice | Offer) => void;
  onClose: () => void;
}> = ({ action, sources, onPick, onClose }) => {
  const titleId = React.useId();
  const descriptionId = React.useId();
  const [search, setSearch] = React.useState('');
  React.useEffect(() => setSearch(''), [action]);
  const term = search.trim().toLowerCase();
  const shown = sources.filter((doc) => !term || doc.number.toLowerCase().includes(term) || doc.client.toLowerCase().includes(term));
  return (
    <Modal open={action !== null} onClose={onClose} titleId={titleId} descriptionId={descriptionId} className="max-w-lg p-6">
      {action ? (
        <div className="grid gap-4">
          <div className="grid gap-1">
            <h2 id={titleId} className="text-lg font-semibold tracking-tight">{CHAIN_START_LABELS[action]} erstellen</h2>
            <p id={descriptionId} className="text-sm text-muted">{SOURCE_TEXT[action].question}</p>
          </div>
          {sources.length === 0 ? (
            <EmptyState title={`Noch keine ${CHAIN_START_LABELS[action]} möglich`} description={SOURCE_TEXT[action].empty} />
          ) : (
            <>
              <Input type="search" aria-label="Belege durchsuchen" placeholder="Nummer oder Kunde" fullWidth value={search}
                onChange={(event) => setSearch(event.target.value)} prefix={<Search size={14} aria-hidden="true" />} />
              <ul className="grid max-h-80 gap-1 overflow-y-auto" aria-label="Mögliche Ausgangsbelege">
                {shown.map((doc) => (
                  <li key={doc.id}>
                    <button
                      type="button"
                      onClick={() => onPick(doc)}
                      className="flex w-full items-center gap-3 rounded-control border border-border px-3 py-2 text-left hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-control font-semibold text-foreground">
                          {'documentKind' in doc ? getInvoiceDocumentLabel(doc.documentKind) : 'Angebot'} {doc.number}
                        </span>
                        <span className="block truncate text-micro text-muted">{doc.client} · {doc.date}</span>
                      </span>
                      <span className="shrink-0 text-control tabular-nums text-foreground">{formatCurrency(doc.amount)}</span>
                    </button>
                  </li>
                ))}
                {shown.length === 0 ? <li className="px-1 py-2 text-sm text-muted">Kein Beleg passt zur Suche.</li> : null}
              </ul>
            </>
          )}
          <div className="flex justify-end">
            <Button variant="secondary" onClick={onClose}>Abbrechen</Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
};
