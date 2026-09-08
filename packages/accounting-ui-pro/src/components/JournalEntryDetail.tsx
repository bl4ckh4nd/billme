import { useEffect, useState } from 'react';
import { Portal } from '@billme/ui';
import type { JournalEntryEntity } from '@billme/accounting-shared';
import type { ProAccountingDataAdapter } from '../services/mockBookingStore';

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
    return <div className="rounded-xl border border-border bg-surface-muted p-4 text-sm text-muted" role="status">Keine Journalbuchung ausgewählt.</div>;
  }

  if (loading) {
    return <div className="rounded-xl border border-border bg-surface p-4 text-sm text-muted" role="status" aria-busy="true">Journal wird geladen…</div>;
  }

  if (error) {
    return (
      <div className="rounded-xl border border-error-border bg-error-bg p-4 text-sm text-error" role="alert" aria-live="assertive">
        <div>{error}</div>
        <button type="button" className="mt-3 rounded-lg border border-error-border px-3 py-1.5 font-bold" onClick={() => setRetry((value) => value + 1)}>
          Erneut versuchen
        </button>
      </div>
    );
  }

  if (!entry) {
    return <div className="rounded-xl border border-border bg-surface-muted p-4 text-sm text-muted" role="status">Journalbuchung nicht gefunden.</div>;
  }

  return (
    <section className="rounded-xl border border-border bg-surface p-4" aria-labelledby="journal-entry-detail-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="journal-entry-detail-heading" className="text-base font-bold text-foreground">Journal {entry.entryNumber}</h2>
          <p className="mt-1 text-sm text-muted">{entry.bookingText}</p>
        </div>
        <span className="rounded-full border border-border px-2.5 py-1 text-xs font-bold text-muted">
          {entry.status === 'reversed' ? 'Storniert' : 'Gebucht'}
        </span>
      </div>

      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <div><dt className="text-muted">Buchungsdatum</dt><dd className="font-semibold text-foreground">{date.format(new Date(entry.postingDate))}</dd></div>
        <div><dt className="text-muted">Periode</dt><dd className="font-semibold text-foreground">{entry.period}</dd></div>
        <div><dt className="text-muted">Referenz</dt><dd className="font-semibold text-foreground">{entry.reference ?? '—'}</dd></div>
      </dl>

      <div className="mt-4 space-y-2" aria-label="Buchungszeilen">
        {entry.lines.map((line) => {
          const isDebit = line.debitAmount > 0;
          const amount = isDebit ? line.debitAmount : line.creditAmount;
          return (
            <div key={line.id} className="flex items-center justify-between gap-3 rounded-lg border border-border-subtle bg-surface-muted px-3 py-2 text-sm">
              <span className="font-semibold text-foreground">{isDebit ? 'Soll' : 'Haben'} · Konto {line.accountNumber}</span>
              <span className="font-bold tabular-nums text-foreground">{euro.format(amount)}</span>
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
    <Portal>
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-dark-base/20 backdrop-blur-sm p-4 sm:p-8" role="presentation">
      <div className="w-full max-w-3xl rounded-2xl border border-border bg-surface p-4 shadow-xl sm:p-6" role="dialog" aria-modal="true" aria-labelledby="journal-entry-dialog-heading">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="journal-entry-dialog-heading" className="text-lg font-black text-foreground">Journalbuchung</h2>
          <button type="button" className="min-h-10 rounded-lg border border-border px-3 py-2 text-sm font-bold text-foreground hover:bg-surface-muted" aria-label="Journalansicht schließen" onClick={onClose}>Schließen</button>
        </div>
        <JournalEntryDetail entryId={entryId} dataAdapter={dataAdapter} />
      </div>
    </div>
    </Portal>
  );
}
