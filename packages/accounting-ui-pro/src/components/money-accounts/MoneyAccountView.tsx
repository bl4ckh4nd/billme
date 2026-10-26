import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  BarList, Card, CardHeader, EmptyState, ErrorState, IconButton, Metric, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
  TimeSeriesChart,
} from '@billme/ui';
import { readAnalysisYear, writeAnalysisYear } from '@billme/accounting-shared';
import type { MoneyAccountYear, ProAccountingDataAdapter } from '../../services/accountingDataAdapter';

void React;

const euro = (value: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
const axis = (value: number) => (Math.abs(value) >= 1000 ? `${(value / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })}k` : String(Math.round(value)));
const monthDate = (period: string) => new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1, 1);
const insetPanel = 'rounded-card border border-border bg-surface-muted p-3.5';
const tile = 'rounded-tile border border-border bg-surface px-4 py-3.5';

type Props = {
  dataAdapter?: ProAccountingDataAdapter;
  /** Account and year asked for by the route (`?view=money&account=1800&year=2024`). */
  request?: { account?: string; year?: string };
};

/**
 * Geldkonten: one bank, cash or card account over a year, from the journal. Balances at both ends, inflow and
 * outflow per month with the balance as a line, the largest receipts and payments by booking text, and the
 * counter accounts the money came from or went to.
 */
export default function MoneyAccountView({ dataAdapter, request }: Props) {
  const [selection, setSelection] = useState<{ accountNumber?: string; year?: number }>(() => ({
    ...(request?.account && /^\d{4,8}$/.test(request.account) ? { accountNumber: request.account } : {}),
    ...(request?.year && /^\d{4}$/.test(request.year) ? { year: Number(request.year) } : /^\d{4}$/.test(readAnalysisYear() ?? '') ? { year: Number(readAnalysisYear()) } : {}),
  }));
  const showYear = (year: number) => { setSelection({ accountNumber: data?.accountNumber, year }); writeAnalysisYear(String(year)); };
  const [data, setData] = useState<MoneyAccountYear | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    if (!dataAdapter?.getMoneyAccountYear) return;
    let current = true;
    setError(null);
    dataAdapter.getMoneyAccountYear(selection)
      .then((next) => { if (current) setData(next); })
      .catch((loadError) => { if (current) setError(loadError instanceof Error ? loadError.message.replace(/^[A-Z_]+:?\s*/, '') : 'Geldkonto nicht erreichbar.'); });
    return () => { current = false; };
  }, [dataAdapter, selection, retry]);

  if (!dataAdapter?.getMoneyAccountYear) return null;
  if (error) return <ErrorState title="Geldkonto nicht erreichbar" description={error} onRetry={() => setRetry((value) => value + 1)} />;
  if (!data) return <p className="text-caption text-muted" role="status">Wird geladen…</p>;

  const account = data.accounts.find((entry) => entry.accountNumber === data.accountNumber);
  const canPrevious = Boolean(account && data.year > account.firstYear);
  const canNext = Boolean(account && data.year < account.lastYear);
  const flowTotal = data.counterAccounts.reduce((sum, entry) => sum + entry.inflow + entry.outflow, 0);

  return (
    <div className="flex flex-col gap-3.5" data-testid="money-account-view">
      <h2 className="sr-only">Geldkonten</h2>
      <div className="flex flex-wrap items-end gap-3">
        <Select label="Geldkonto" aria-label="Geldkonto" value={data.accountNumber} onChange={(event) => setSelection({ accountNumber: event.target.value })} className="min-w-[16rem]">
          {data.accounts.map((entry) => <option key={entry.accountNumber} value={entry.accountNumber}>{entry.accountNumber}{entry.name ? ` ${entry.name}` : ''}</option>)}
        </Select>
        <div className="flex items-center gap-1">
          <IconButton aria-label="Vorjahr" disabled={!canPrevious} onClick={() => showYear(data.year - 1)}><ChevronLeft size={16} aria-hidden="true" /></IconButton>
          <span className="min-w-[3.5rem] text-center text-heading font-semibold tabular-nums" aria-live="polite">{data.year}</span>
          <IconButton aria-label="Folgejahr" disabled={!canNext} onClick={() => showYear(data.year + 1)}><ChevronRight size={16} aria-hidden="true" /></IconButton>
        </div>
        <p className="text-caption text-muted">{data.entryCount} Buchungen{account ? `, Buchungen ${account.firstYear}–${account.lastYear}` : ''}</p>
      </div>

      <section aria-label="Kennzahlen Geldkonto" className="grid grid-cols-[repeat(auto-fit,minmax(min(12rem,100%),1fr))] gap-3">
        <div className={tile}><Metric marker="tick" label={`Bestand 1.1.${data.year}`} value={euro(data.openingBalance)} tone={data.openingBalance < 0 ? 'error' : 'neutral'} /></div>
        <div className={tile}><Metric marker="tick" label="Eingänge" value={euro(data.inflow)} /></div>
        <div className={tile}><Metric marker="tick" label="Ausgänge" value={euro(data.outflow)} /></div>
        <div className={tile}><Metric marker="tick" label={`Bestand 31.12.${data.year}`} value={euro(data.closingBalance)} tone={data.closingBalance < 0 ? 'error' : 'neutral'} hint={`Veränderung ${euro(data.closingBalance - data.openingBalance)}`} /></div>
      </section>

      <Card radius="2xl" padding="lg" className="pt-4">
        <CardHeader size="lg" title={`${data.accountNumber}${data.name ? ` ${data.name}` : ''} ${data.year}`} subtitle="Eingänge nach oben, Ausgänge nach unten, Linie: Kontostand am Monatsende" />
        {data.entryCount === 0 ? (
          <EmptyState title="Keine Buchungen im Jahr" description="Auf diesem Konto ist in diesem Jahr nichts gebucht." />
        ) : (
          <div className={`${insetPanel} mt-3`}>
            <TimeSeriesChart
              aria-label={`Ein- und Ausgänge ${data.accountNumber} ${data.year}`}
              formatValue={euro}
              formatAxis={axis}
              series={[
                { key: 'inflow', label: 'Eingänge', kind: 'bar', style: 'solid', stack: 'flow' },
                { key: 'outflow', label: 'Ausgänge', kind: 'bar', style: 'hatched', stack: 'flow', downward: true },
                { key: 'balance', label: 'Kontostand', kind: 'line', axis: 'right' },
              ]}
              data={data.months.map((month) => ({
                key: month.period,
                label: monthDate(month.period).toLocaleDateString('de-DE', { month: 'short' }).replace('.', ''),
                longLabel: monthDate(month.period).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }),
                values: { inflow: month.inflow, outflow: month.outflow, balance: month.balance },
              }))}
            />
          </div>
        )}
      </Card>

      {data.entryCount > 0 ? (
        <>
          <div className="grid grid-cols-1 items-start gap-3.5 lg:grid-cols-2">
            <Card radius="2xl" padding="lg" className="pt-4">
              <CardHeader size="lg" title="Größte Eingänge" subtitle="Nach Buchungstext, Summe im Jahr" />
              {data.topInflows.length ? (
                <BarList className="mt-3" aria-label="Größte Eingänge" formatValue={euro} items={data.topInflows.map((entry) => ({ key: entry.label, label: entry.label, hint: `${entry.count}×`, value: entry.amount }))} />
              ) : <p className="mt-3 text-caption text-muted">Keine Eingänge.</p>}
            </Card>
            <Card radius="2xl" padding="lg" className="pt-4">
              <CardHeader size="lg" title="Größte Ausgänge" subtitle="Nach Buchungstext, Summe im Jahr" />
              {data.topOutflows.length ? (
                <BarList className="mt-3" aria-label="Größte Ausgänge" tone="muted" formatValue={euro} items={data.topOutflows.map((entry) => ({ key: entry.label, label: entry.label, hint: `${entry.count}×`, value: entry.amount }))} />
              ) : <p className="mt-3 text-caption text-muted">Keine Ausgänge.</p>}
            </Card>
          </div>

          <Card padding="none" className="overflow-hidden">
            <CardHeader className="border-b border-border px-3.5 py-3" title="Gegenkonten" subtitle="Woher das Geld kam und wohin es ging: die anderen Konten der Buchungen, ohne Vor- und Umsatzsteuer" />
            <Table bare aria-label="Gegenkonten">
              <TableHeader>
                <TableRow>
                  <TableHead>Konto</TableHead>
                  <TableHead>BWA-Position</TableHead>
                  <TableHead numeric>Eingänge</TableHead>
                  <TableHead numeric>Ausgänge</TableHead>
                  <TableHead numeric>Anteil</TableHead>
                  <TableHead numeric>Buchungen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.counterAccounts.map((entry) => {
                  const share = flowTotal ? (entry.inflow + entry.outflow) / flowTotal : 0;
                  return (
                    <TableRow key={entry.accountNumber}>
                      <TableCell><span className="tabular-nums">{entry.accountNumber}</span>{entry.name ? <span className="ml-2 text-muted">{entry.name}</span> : null}</TableCell>
                      <TableCell muted>{entry.position ?? '–'}</TableCell>
                      <TableCell numeric>{entry.inflow ? euro(entry.inflow) : '–'}</TableCell>
                      <TableCell numeric>{entry.outflow ? euro(entry.outflow) : '–'}</TableCell>
                      <TableCell numeric>
                        <span className="inline-flex items-center gap-2">
                          <span aria-hidden="true" className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-sunken"><span className="block h-full bg-foreground" style={{ width: `${Math.max(share * 100, 2)}%` }} /></span>
                          <span className="tabular-nums">{new Intl.NumberFormat('de-DE', { style: 'percent', maximumFractionDigits: 0 }).format(share)}</span>
                        </span>
                      </TableCell>
                      <TableCell numeric muted>{entry.count}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        </>
      ) : null}
    </div>
  );
}
