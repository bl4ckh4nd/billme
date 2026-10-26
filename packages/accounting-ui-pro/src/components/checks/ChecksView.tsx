import React, { useEffect, useState } from 'react';
import {
  Badge, Button, Card, CardHeader, EmptyState, ErrorState, Input, Metric, SegmentedControl, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, cn,
} from '@billme/ui';
import type { LedgerCheckKey, LedgerChecks, ProAccountingDataAdapter } from '../../services/accountingDataAdapter';

void React;

const euro = (value: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
const date = (iso?: string) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '–');
const SEVERITY: Record<LedgerChecks['checks'][number]['severity'], { tone: 'error' | 'warning' | 'info'; label: string }> = {
  error: { tone: 'error', label: 'Fehler' },
  warning: { tone: 'warning', label: 'Warnung' },
  info: { tone: 'info', label: 'Hinweis' },
};
const tile = 'rounded-tile border border-border bg-surface px-4 py-3.5';

type Props = {
  dataAdapter?: ProAccountingDataAdapter;
  canMutate: boolean;
  onOpenEntry?: (entryId: string) => void;
  /** After a finding is marked OK or opened again (e.g. to refresh the count in the navigation). */
  onChanged?: () => void;
};

/**
 * Prüfungen: checks on the journal with their findings. A finding is fixed in the bookings (Storno and new entry)
 * or marked OK with a reason; marked findings stay listed and can be opened again.
 */
export default function ChecksView({ dataAdapter, canMutate, onOpenEntry, onChanged }: Props) {
  const [data, setData] = useState<LedgerChecks | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [selected, setSelected] = useState<LedgerCheckKey | null>(null);
  const [filter, setFilter] = useState<'open' | 'dismissed' | 'all'>('open');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  useEffect(() => {
    if (!dataAdapter?.getLedgerChecks) return;
    let current = true;
    dataAdapter.getLedgerChecks({})
      .then((next) => {
        if (!current) return;
        setData(next);
        setSelected((value) => value ?? next.checks.find((check) => check.openCount > 0)?.key ?? next.checks[0]?.key ?? null);
      })
      .catch((loadError) => { if (current) setError(loadError instanceof Error ? loadError.message : 'Prüfungen nicht erreichbar.'); });
    return () => { current = false; };
  }, [dataAdapter, retry]);

  if (!dataAdapter?.getLedgerChecks) return null;
  if (error) return <ErrorState title="Prüfungen nicht erreichbar" description={error} onRetry={() => { setError(null); setRetry((value) => value + 1); }} />;
  if (!data) return <p className="text-caption text-muted" role="status">Wird geladen…</p>;

  const check = data.checks.find((entry) => entry.key === selected);
  const findings = (check?.findings ?? []).filter((finding) => filter === 'all' || (filter === 'open' ? !finding.dismissed : Boolean(finding.dismissed)));
  const setDismissal = async (subjectKey: string, dismissed: boolean) => {
    if (!check || !dataAdapter.setLedgerCheckDismissal) return;
    const written = reason.trim() || (dismissed ? '' : 'Wieder geöffnet');
    if (!written) { setFeedback('Bitte eine Begründung eingeben, warum der Fund in Ordnung ist.'); return; }
    setBusy(subjectKey);
    setFeedback(null);
    try {
      await dataAdapter.setLedgerCheckDismissal({ checkKey: check.key, subjectKey, dismissed, reason: written });
      setRetry((value) => value + 1);
      onChanged?.();
    } catch (saveError) {
      setFeedback(saveError instanceof Error ? saveError.message : 'Nicht gespeichert.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3.5" data-testid="checks-view">
      <h2 className="sr-only">Prüfungen</h2>
      <section aria-label="Offene Funde" className="grid grid-cols-[repeat(auto-fit,minmax(min(12rem,100%),1fr))] gap-3">
        <div className={tile}><Metric marker="tick" label="Fehler" value={String(data.openErrors)} tone={data.openErrors ? 'error' : 'neutral'} hint="Wirken auf UStVA oder Abschluss" /></div>
        <div className={tile}><Metric marker="tick" label="Warnungen" value={String(data.openWarnings)} tone={data.openWarnings ? 'warning' : 'neutral'} hint="Bitte prüfen" /></div>
        <div className={tile}><Metric marker="tick" label="Hinweise" value={String(data.openInfos)} hint="Zur Kenntnis" /></div>
      </section>

      <ul aria-label="Prüfungen" className="grid grid-cols-[repeat(auto-fit,minmax(min(17rem,100%),1fr))] gap-3">
        {data.checks.map((entry) => (
          <li key={entry.key}>
            <button
              type="button"
              aria-pressed={entry.key === selected}
              onClick={() => { setSelected(entry.key); setFilter('open'); setFeedback(null); }}
              className={cn('flex h-full w-full flex-col gap-1.5 rounded-tile border bg-surface px-4 py-3.5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring', entry.key === selected ? 'border-foreground' : 'border-border hover:bg-surface-muted')}
            >
              <span className="flex items-center justify-between gap-2">
                <Badge tone={SEVERITY[entry.severity].tone}>{SEVERITY[entry.severity].label}</Badge>
                <span className="text-heading font-bold tabular-nums">{entry.openCount}</span>
              </span>
              <span className="text-control font-semibold text-foreground">{entry.label}</span>
              <span className="text-caption text-muted">{entry.dismissedCount ? `${entry.dismissedCount} als OK markiert` : entry.openCount ? 'offen' : 'nichts gefunden'}</span>
            </button>
          </li>
        ))}
      </ul>

      {check ? (
        <section aria-label={`Funde: ${check.label}`} data-testid="check-findings">
        <Card padding="none" className="overflow-hidden">
          <CardHeader
            className="border-b border-border px-3.5 py-3"
            title={check.label}
            subtitle={check.description}
            actions={<SegmentedControl size="sm" aria-label="Funde filtern" value={filter} onChange={setFilter} options={[{ value: 'open', label: `Offen (${check.openCount})` }, { value: 'dismissed', label: `OK (${check.dismissedCount})` }, { value: 'all', label: 'Alle' }]} />}
          />
          {canMutate && dataAdapter.setLedgerCheckDismissal ? (
            <div className="flex flex-wrap items-end gap-3 border-b border-border px-3.5 py-3">
              <Input label="Begründung für „OK“" aria-label="Begründung für OK" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="z. B. Rechnung mit deutscher USt-IdNr., kein § 13b" className="min-w-[22rem] flex-1" />
              {feedback ? <p className="text-control text-error-text" role="alert">{feedback}</p> : null}
            </div>
          ) : null}
          {findings.length === 0 ? (
            <EmptyState title={filter === 'open' ? 'Nichts offen' : 'Keine Funde'} description={filter === 'open' ? 'Diese Prüfung hat keine offenen Funde.' : 'In dieser Auswahl gibt es keine Funde.'} />
          ) : (
            <Table bare aria-label={`Funde ${check.label}`} containerClassName="max-h-[30rem]">
              <TableHeader>
                <TableRow>
                  <TableHead>Datum</TableHead>
                  <TableHead>Beleg</TableHead>
                  <TableHead>Buchungstext</TableHead>
                  <TableHead>Befund</TableHead>
                  <TableHead numeric>Betrag</TableHead>
                  <TableHead><span className="sr-only">Aktion</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {findings.map((finding) => (
                  <TableRow key={finding.subjectKey}>
                    <TableCell className="tabular-nums">{date(finding.postingDate)}</TableCell>
                    <TableCell>
                      {finding.entryId && onOpenEntry ? (
                        <button type="button" className="underline underline-offset-2" onClick={() => onOpenEntry(finding.entryId!)}>{finding.reference ?? finding.entryNumber}</button>
                      ) : finding.reference ?? finding.entryNumber ?? finding.accountNumber ?? '–'}
                    </TableCell>
                    <TableCell>{finding.bookingText ?? '–'}</TableCell>
                    <TableCell>
                      {finding.detail}
                      {finding.dismissed ? <div className="text-caption text-muted">OK: {finding.dismissed.reason}{finding.dismissed.by ? ` (${finding.dismissed.by})` : ''}</div> : null}
                    </TableCell>
                    <TableCell numeric>{finding.amount === undefined ? '–' : euro(finding.amount)}</TableCell>
                    <TableCell>
                      {canMutate && dataAdapter.setLedgerCheckDismissal ? (
                        <Button type="button" size="sm" variant="secondary" disabled={busy === finding.subjectKey} onClick={() => void setDismissal(finding.subjectKey, !finding.dismissed)}>
                          {finding.dismissed ? 'Wieder öffnen' : 'Als OK markieren'}
                        </Button>
                      ) : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </Card>
        </section>
      ) : null}
    </div>
  );
}
