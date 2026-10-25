import { useEffect, useState } from 'react';
import { Badge, Button, formatEmptyValue, Input, Modal } from '@billme/ui';
import { accountingErrorText, type JournalEntryEntity } from '@billme/accounting-shared';
import { localToday } from '../domain/reportDates';
import { userFacingReference } from '../domain/references';
import type { ProAccountingDataAdapter } from '../services/accountingDataAdapter';
import type { Account } from '../types';

const euro = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const date = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' });

export interface JournalEntryDetailProps {
  entryId?: string | null;
  dataAdapter?: ProAccountingDataAdapter;
  accounts?: Account[];
  canMutate?: boolean;
  onReversed?: (entryId: string) => void;
}

/** Entries the generic Storno must not touch name the screen that corrects them instead. */
const reversalElsewhere = (entry: JournalEntryEntity): string | undefined => {
  switch (entry.sourceType) {
    case 'outgoing_invoice': return 'Rechnungen werden über eine Stornorechnung in der Rechnungsliste storniert.';
    case 'incoming_invoice': return 'Eingangsrechnungen werden im Eingangsbeleg storniert.';
    case 'payment': case 'payment_vat': return 'Zahlungen werden unter Offene Posten über „Zahlung stornieren“ zurückgenommen.';
    case 'asset_activation': case 'asset_depreciation': case 'asset_disposal': return 'Anlagenbuchungen werden in der Anlagenverwaltung korrigiert.';
    case 'reversal': return 'Dies ist bereits eine Stornobuchung.';
    case 'fiscal_close': case 'carry_forward': case 'provision': case 'accrual': case 'inventory_closing': case 'fx_valuation': case 'loan_schedule': case 'payroll_batch':
      return 'Abschluss- und Sonderbuchungen werden unter Sonderbuchungen mit einer Korrektur geändert.';
    default:
      return entry.sourceType === 'standalone_source' && /^(correction|settlement):/.test(entry.sourceKey ?? '') ? 'Abschluss- und Sonderbuchungen werden unter Sonderbuchungen mit einer Korrektur geändert.' : undefined;
  }
};

export interface JournalEntryDetailModalProps extends JournalEntryDetailProps {
  onClose: () => void;
}

export default function JournalEntryDetail({ entryId, dataAdapter, accounts = [], canMutate = true, onReversed }: JournalEntryDetailProps) {
  const [entry, setEntry] = useState<JournalEntryEntity | null>(null);
  const [reversing, setReversing] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [reverseError, setReverseError] = useState<string | null>(null);
  const [overrideLock, setOverrideLock] = useState(false);
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

  const nameOf = (number: string) => accounts.find((account) => account.number === number)?.name;
  const elsewhere = reversalElsewhere(entry);
  const canReverse = entry.status === 'posted' && !elsewhere && Boolean(dataAdapter?.reverseJournalEntry);
  const softLocked = Boolean(reverseError && /vorläufig gesperrt/.test(reverseError));
  const reverse = async () => {
    if (!dataAdapter?.reverseJournalEntry || !reason.trim()) return;
    setBusy(true);
    setReverseError(null);
    try {
      await dataAdapter.reverseJournalEntry({ entryId: entry.id, reason: reason.trim(), postingDate: localToday(), ...(overrideLock ? { softLockOverride: true, overrideReason: reason.trim() } : {}) });
      setReversing(false);
      setReason('');
      setOverrideLock(false);
      onReversed?.(entry.id);
      setRetry((value) => value + 1);
    } catch (cause) {
      setReverseError(accountingErrorText(cause instanceof Error ? cause.message : String(cause)));
    } finally {
      setBusy(false);
    }
  };

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
        <div><dt className="text-caption text-muted">Referenz</dt><dd className="font-medium text-foreground">{formatEmptyValue(userFacingReference(entry.reference))}</dd></div>
      </dl>

      <div className="mt-3 divide-y divide-border rounded-control border border-border" aria-label="Buchungszeilen">
        {entry.lines.map((line) => {
          const isDebit = line.debitAmount > 0;
          const amount = isDebit ? line.debitAmount : line.creditAmount;
          return (
            <div key={line.id} className="flex items-center justify-between gap-3 px-3 py-2.25 text-control">
              <span className="min-w-0 font-medium text-foreground">{isDebit ? 'Soll' : 'Haben'} · Konto {line.accountNumber}{nameOf(line.accountNumber) ? <span className="font-normal text-muted"> {nameOf(line.accountNumber)}</span> : null}</span>
              <span className="font-mono font-semibold tabular-nums text-foreground">{euro.format(amount)}</span>
            </div>
          );
        })}
      </div>

      {entry.status === 'posted' && elsewhere ? <p className="mt-3 text-caption text-muted">{elsewhere}</p> : null}
      {canReverse && canMutate ? (
        <div className="mt-3 flex flex-col gap-2.5 rounded-control border border-border p-3" data-testid="journal-reverse">
          {reversing ? (
            <>
              <p className="text-control text-foreground">Die Stornobuchung kehrt alle Zeilen um und wird mit heutigem Datum gebucht. Die ursprüngliche Buchung bleibt im Journal sichtbar.</p>
              <Input label="Grund für das Storno (Pflicht)" aria-label="Grund für das Storno" value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy} placeholder="z. B. falsches Konto gebucht" />
              {reverseError ? <p className="text-control text-error-text" role="alert">{reverseError}</p> : null}
              {softLocked ? (
                <label className="flex items-center gap-2 text-control text-foreground">
                  <input type="checkbox" checked={overrideLock} onChange={(event) => setOverrideLock(event.target.checked)} />
                  Trotz vorläufiger Sperre buchen (der Grund wird protokolliert)
                </label>
              ) : null}
              <div className="flex flex-wrap justify-end gap-2">
                <Button variant="secondary" size="sm" onClick={() => { setReversing(false); setReverseError(null); }} disabled={busy}>Abbrechen</Button>
                <Button variant="dark" size="sm" onClick={() => void reverse()} disabled={busy || !reason.trim()} aria-busy={busy}>Storno buchen</Button>
              </div>
            </>
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-caption text-muted">Falsch gebucht? Ein Storno bucht die Gegenbuchung, gelöscht wird nichts.</p>
              <Button variant="secondary" size="sm" onClick={() => setReversing(true)}>Buchung stornieren</Button>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}

export function JournalEntryDetailModal({ entryId, dataAdapter, accounts, canMutate, onReversed, onClose }: JournalEntryDetailModalProps) {
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
        <JournalEntryDetail entryId={entryId} dataAdapter={dataAdapter} accounts={accounts} canMutate={canMutate} onReversed={onReversed} />
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4.5 py-3">
        <Button variant="secondary" aria-label="Journalansicht schließen" onClick={onClose}>Schließen</Button>
      </div>
    </Modal>
  );
}
