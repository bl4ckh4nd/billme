import { useEffect, useState } from 'react';
import { Badge, Button, formatEmptyValue, Modal } from '@billme/ui';
import type { JournalEntryEntity } from '@billme/accounting-shared';
import type { ProAccountingDataAdapter } from '../services/accountingDataAdapter';

const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const date = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' });

export interface JournalEntryDetailProps {
  entryId?: string | null;
  dataAdapter?: ProAccountingDataAdapter;
}

export interface JournalEntryDetailModalProps extends JournalEntryDetailProps {
  onClose: () => void;
}

export default function JournalEntryDetail({ entryId, dataAdapter }: JournalEntryDetailProps) {
  const [entry, setEntry] = useState<JournalEntryEntity | null>(null);
  const [loading, setLoading] = useState(Boolean(entryId));
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!entryId) {
      setEntry(null);
      setError(null);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    setError(null);
    const load = async () => {
      if (!dataAdapter?.getJournalEntryById) {
        throw new Error('Journal-Datenadapter ist nicht vollständig konfiguriert.');
      }
      return dataAdapter.getJournalEntryById(entryId);
    };

    void load()
      .then((nextEntry) => {
        if (cancelled) return;
        setEntry(nextEntry);
      })
      .catch((cause) => {
        if (cancelled) return;
        setEntry(null);
        setError(cause instanceof Error ? cause.message : 'Journalbuchung konnte nicht geladen werden.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [dataAdapter, entryId, retry]);

  if (!entryId) {
    return <div className="text-control text-muted" role="status">Keine Journalbuchung ausgewählt.</div>;
  }

  if (loading) {
    return <div className="text-control text-muted" role="status" aria-busy="true">Journal wird geladen…</div>;
  }

  if (error) {
    return (
      <div className="flex flex-wrap items-center gap-2.5 rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control text-error-text" role="alert" aria-live="assertive">
        <div className="min-w-0 flex-1">{error}</div>
        <Button variant="secondary" size="sm" onClick={() => setRetry((value) => value + 1)}>
          Erneut versuchen
        </Button>
      </div>
    );
  }

  if (!entry) {
    return <div className="text-control text-muted" role="status">Journalbuchung nicht gefunden.</div>;
  }

  return (
    <section aria-labelledby="journal-entry-detail-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="journal-entry-detail-heading" className="text-section text-foreground">Journal {entry.entryNumber}</h2>
          <p className="text-caption text-muted">{entry.bookingText}</p>
        </div>
        <Badge tone={entry.status === 'reversed' ? 'error' : 'success'}>
          {entry.status === 'reversed' ? 'Storniert' : 'Gebucht'}
        </Badge>
      </div>

      <dl className="mt-3 grid gap-3 text-control sm:grid-cols-3">
        <div><dt className="text-caption text-muted">Buchungsdatum</dt><dd className="font-medium text-foreground">{date.format(new Date(entry.postingDate))}</dd></div>
        <div><dt className="text-caption text-muted">Periode</dt><dd className="font-medium text-foreground">{entry.period}</dd></div>
        <div><dt className="text-caption text-muted">Referenz</dt><dd className="font-medium text-foreground">{formatEmptyValue(entry.reference)}</dd></div>
      </dl>

      <div className="mt-3 divide-y divide-border rounded-control border border-border" aria-label="Buchungszeilen">
        {entry.lines.map((line) => {
          const isDebit = line.debitAmount > 0;
          const amount = isDebit ? line.debitAmount : line.creditAmount;
          return (
            <div key={line.id} className="flex items-center justify-between gap-3 px-3 py-2.25 text-control">
              <span className="font-medium text-foreground">{isDebit ? 'Soll' : 'Haben'} · Konto {line.accountNumber}</span>
              <span className="font-mono font-semibold tabular-nums text-foreground">{euro.format(amount)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function JournalEntryDetailModal({ entryId, dataAdapter, onClose }: JournalEntryDetailModalProps) {
  if (!entryId) return null;

  return (
    <Modal
      open
      onClose={onClose}
      titleId="journal-entry-dialog-heading"
      className="max-w-3xl"
    >
      <div className="flex items-start gap-3 px-4.5 pb-2.5 pt-4">
        <h2 id="journal-entry-dialog-heading" className="min-w-0 flex-1 text-title text-foreground">Journalbuchung</h2>
      </div>
      <div className="px-4.5 pb-4 pt-1">
        <JournalEntryDetail entryId={entryId} dataAdapter={dataAdapter} />
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4.5 py-3">
        <Button variant="secondary" aria-label="Journalansicht schließen" onClick={onClose}>Schließen</Button>
      </div>
    </Modal>
  );
}
