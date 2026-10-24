import React, { useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, CardHeader, ConfirmDialog, Select } from '@billme/ui';
import { localToday } from '../domain/reportDates';
import type { AccountingPeriodRow, AccountingPeriodStatus, ProAccountingDataAdapter } from '../services/accountingDataAdapter';

void React;

const statusLabel: Record<AccountingPeriodStatus, string> = { open: 'Offen', soft_locked: 'Vorläufig gesperrt', closed: 'Festgeschrieben' };
const statusTone = { open: 'neutral', soft_locked: 'warning', closed: 'inverse' } as const;
const monthName = (period: string): string =>
  new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1, 1)).toLocaleDateString('de-DE', { month: 'long', year: 'numeric', timeZone: 'UTC' });

type PendingChange = { period: string; status: AccountingPeriodStatus };

const dialogCopy = (change: PendingChange): { title: string; description: string; confirm: string } => {
  const month = monthName(change.period);
  if (change.status === 'closed') {
    return {
      title: `Bis ${month} festschreiben?`,
      description: `Festschreiben ist endgültig: ${month} und alle Monate davor nehmen keine Buchung mehr an und lassen sich nicht wieder öffnen. Korrekturen laufen danach nur über Buchungen in einem offenen Monat.`,
      confirm: 'Endgültig festschreiben',
    };
  }
  if (change.status === 'soft_locked') {
    return {
      title: `${month} vorläufig sperren?`,
      description: 'Buchungen in diesem Monat brauchen danach eine Freigabe mit Begründung. Die Sperre lässt sich mit Begründung wieder aufheben.',
      confirm: 'Sperren',
    };
  }
  return {
    title: `Sperre für ${month} aufheben?`,
    description: 'Der Monat nimmt danach wieder Buchungen ohne Freigabe an. Die Aufhebung wird mit Begründung protokolliert.',
    confirm: 'Sperre aufheben',
  };
};

type Props = { dataAdapter?: ProAccountingDataAdapter; canMutate: boolean; refreshToken?: number };

/** Month list with soft lock, reopening and Festschreibung; the status comes from the server. */
export default function PeriodLockPanel({ dataAdapter, canMutate, refreshToken = 0 }: Props) {
  const currentYear = Number(localToday().slice(0, 4));
  const [year, setYear] = useState(currentYear);
  const [rows, setRows] = useState<AccountingPeriodRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingChange | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);

  const load = async () => {
    const id = ++requestId.current;
    if (!dataAdapter?.listAccountingPeriods) return;
    try {
      const next = await dataAdapter.listAccountingPeriods(year);
      if (id === requestId.current) { setRows(next); setError(null); }
    } catch (loadError) {
      if (id === requestId.current) setError(loadError instanceof Error ? loadError.message : 'Perioden konnten nicht geladen werden.');
    }
  };

  useEffect(() => { void load(); }, [dataAdapter, year, refreshToken]);

  if (!dataAdapter?.listAccountingPeriods) return null;
  const canChange = canMutate && Boolean(dataAdapter.setAccountingPeriodStatus);

  const confirm = async () => {
    if (!pending || !dataAdapter.setAccountingPeriodStatus) return;
    setBusy(true);
    try {
      await dataAdapter.setAccountingPeriodStatus({ ...pending, reason: reason.trim() });
      setPending(null);
      setReason('');
      await load();
    } catch (changeError) {
      setPending(null);
      setError(changeError instanceof Error ? changeError.message : 'Status konnte nicht geändert werden.');
    } finally {
      setBusy(false);
    }
  };

  const copy = pending ? dialogCopy(pending) : null;
  return (
    <section aria-labelledby="period-lock-heading">
      <Card padding="none" className="overflow-hidden">
        <CardHeader
          className="border-b border-border px-3.5 py-3"
          title={<span id="period-lock-heading">Perioden sperren und festschreiben</span>}
          subtitle="Eine UStVA-Vorbereitung und der Jahresabschluss sperren ihre Monate vorläufig."
          actions={(
            <Select aria-label="Jahr" value={String(year)} onChange={(event) => setYear(Number(event.target.value))}>
              {[currentYear - 2, currentYear - 1, currentYear, currentYear + 1].map((option) => <option key={option} value={option}>{option}</option>)}
            </Select>
          )}
        />
        {error ? <p className="border-b border-border px-3.5 py-2.5 text-control text-error-text" role="alert">{error}</p> : null}
        <ul className="divide-y divide-border" data-testid="period-lock-list">
          {rows.map((row) => (
            <li key={row.period} className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2 text-control" data-period={row.period}>
              <span className="flex min-w-0 items-center gap-3">
                <span className="w-36 font-semibold text-foreground">{monthName(row.period)}</span>
                <span className="text-caption tabular-nums text-muted">{row.entryCount === 1 ? '1 Buchung' : `${row.entryCount} Buchungen`}</span>
                <Badge tone={statusTone[row.status]}>{statusLabel[row.status]}</Badge>
              </span>
              {canChange && row.status !== 'closed' ? (
                <span className="flex gap-2">
                  {row.status === 'open'
                    ? <Button type="button" size="sm" variant="secondary" onClick={() => setPending({ period: row.period, status: 'soft_locked' })}>Sperren</Button>
                    : <Button type="button" size="sm" variant="secondary" onClick={() => setPending({ period: row.period, status: 'open' })}>Entsperren</Button>}
                  <Button type="button" size="sm" variant="secondary" onClick={() => setPending({ period: row.period, status: 'closed' })}>Festschreiben</Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
      {pending && copy ? (
        <ConfirmDialog
          open
          title={copy.title}
          description={copy.description}
          confirmLabel={copy.confirm}
          destructive={pending.status === 'closed'}
          busy={busy}
          reason={{ label: 'Begründung (Pflicht)', required: true, value: reason, onChange: setReason, placeholder: 'z. B. UStVA Januar abgegeben' }}
          onConfirm={() => void confirm()}
          onCancel={() => { setPending(null); setReason(''); }}
        />
      ) : null}
    </section>
  );
}
