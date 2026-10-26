import React, { useEffect, useMemo, useState } from 'react';
import {
  Badge, BarList, Card, CardHeader, EmptyState, ErrorState, Metric, SegmentedControl, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
  TimeSeriesChart,
} from '@billme/ui';
import { readAnalysisYear, writeAnalysisYear } from '@billme/accounting-shared';
import type { MoneyAccountYear, ProAccountingDataAdapter, TaxPayments, VatAnalytics } from '../../services/accountingDataAdapter';

void React;

type Tab = 'vat' | 'payments' | 'top';
type TopicKey = TaxPayments['topics'][number]['key'];

const euro = (value: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);
const axis = (value: number) => (Math.abs(value) >= 1000 ? `${(value / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })}k` : String(Math.round(value)));
const date = (iso: string) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
const monthLabel = (period: string, withYear: boolean) => {
  const short = new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1, 1).toLocaleDateString('de-DE', { month: 'short' }).replace('.', '');
  return withYear ? `${short} ${period.slice(2, 4)}` : short;
};
const periodLabel = (key: string, withYear = true) => (/Q\d$/.test(key) ? `${key.slice(5)}${withYear ? ` ${key.slice(0, 4)}` : ''}` : monthLabel(key, withYear));
const periodLongLabel = (key: string) => (/Q\d$/.test(key) ? `${key.slice(5, 6)}. Quartal ${key.slice(0, 4)}` : new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }));
const STATUS: Record<VatAnalytics['periods'][number]['status'], { tone: 'success' | 'warning' | 'error' | 'neutral'; label: string }> = {
  prepared: { tone: 'success', label: 'vorbereitet' },
  due: { tone: 'warning', label: 'fällig' },
  open: { tone: 'error', label: 'offen' },
  past: { tone: 'neutral', label: 'nicht in Billme' },
};
const insetPanel = 'rounded-card border border-border bg-surface-muted p-3.5';

type Props = {
  dataAdapter?: ProAccountingDataAdapter;
  /** A row of the Fristen table: opens the UStVA Kennzahlen of that period below. */
  onSelectPeriod?: (period: { span: 'month' | 'quarter'; month: string }) => void;
  onOpenEntry?: (entryId: string) => void;
};

/**
 * Steuer-Übersicht from the journal: the UStVA per month or quarter as a chart with its Fristen, the payments to and
 * from the tax offices per topic, and the largest tax lines of the year. Reading only; preparing a UStVA stays below.
 */
export default function TaxAnalyticsPanel({ dataAdapter, onSelectPeriod, onOpenEntry }: Props) {
  const [years, setYears] = useState<number[]>([]);
  const [year, setYear] = useState<string>('');
  const [tab, setTab] = useState<Tab>('vat');
  const [granularity, setGranularity] = useState<'month' | 'quarter'>('month');
  const [topic, setTopic] = useState<TopicKey>('vat');
  const [vat, setVat] = useState<VatAnalytics | null>(null);
  const [payments, setPayments] = useState<TaxPayments | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);

  // The years with bookings on a money account; the latest opens first.
  useEffect(() => {
    if (!dataAdapter?.getMoneyAccountYear) return;
    let current = true;
    dataAdapter.getMoneyAccountYear({})
      .then((account: MoneyAccountYear) => {
        if (!current) return;
        const first = Math.min(...account.accounts.map((entry) => entry.firstYear));
        const last = Math.max(...account.accounts.map((entry) => entry.lastYear));
        const list = Number.isFinite(first) ? Array.from({ length: last - first + 1 }, (_, index) => last - index) : [new Date().getFullYear()];
        setYears(list);
        // The year chosen in another analysis, when this account history has it.
        const shared = readAnalysisYear();
        const preferred = shared === 'all' && list.length > 1 ? 'all' : shared && list.includes(Number(shared)) ? shared : String(list[0]);
        setYear((value) => value || preferred);
      })
      .catch(() => { if (current) { const now = new Date().getFullYear(); setYears([now]); setYear((value) => value || String(now)); } });
    return () => { current = false; };
  }, [dataAdapter]);

  const range = useMemo(() => {
    if (!year) return null;
    if (year === 'all') return years.length ? { from: `${years.at(-1)}-01-01`, to: `${years[0]}-12-31` } : null;
    return { from: `${year}-01-01`, to: `${year}-12-31` };
  }, [year, years]);

  useEffect(() => {
    if (!range || !dataAdapter?.getVatAnalytics || !dataAdapter.getTaxPayments) return;
    let current = true;
    setError(null);
    Promise.all([dataAdapter.getVatAnalytics({ ...range, granularity }), dataAdapter.getTaxPayments(range)])
      .then(([nextVat, nextPayments]) => { if (current) { setVat(nextVat); setPayments(nextPayments); } })
      .catch((loadError) => { if (current) setError(loadError instanceof Error ? loadError.message : 'Steuerdaten nicht erreichbar.'); });
    return () => { current = false; };
  }, [range, granularity, dataAdapter, retry]);

  if (!dataAdapter?.getVatAnalytics || !dataAdapter.getTaxPayments) return null;
  const multiYear = year === 'all';
  const activeTopic = payments?.topics.find((entry) => entry.key === topic);
  // One year: all twelve months on the axis, also those without a payment.
  const topicMonths = activeTopic && !multiYear && /^\d{4}$/.test(year)
    ? Array.from({ length: 12 }, (_, index) => {
      const period = `${year}-${String(index + 1).padStart(2, '0')}`;
      return activeTopic.months.find((month) => month.period === period) ?? { period, paid: 0, refunded: 0 };
    })
    : activeTopic?.months ?? [];

  return (
    <section aria-labelledby="tax-analytics-heading" data-testid="tax-analytics-panel">
      <Card padding="none" className="overflow-hidden">
        <CardHeader
          className="border-b border-border px-3.5 py-3"
          title={<span id="tax-analytics-heading">Steuer-Übersicht</span>}
          subtitle="Aus dem Journal: Umsatzsteuer je Zeitraum mit Fristen, Zahlungen ans Finanzamt, größte Steuerposten. Nur lesend."
          actions={
            <Select aria-label="Steuerjahr" value={year} onChange={(event) => { setYear(event.target.value); writeAnalysisYear(event.target.value); }}>
              {years.map((entry) => <option key={entry} value={String(entry)}>{entry}</option>)}
              {years.length > 1 ? <option value="all">Alle Jahre</option> : null}
            </Select>
          }
        />
        <div className="flex flex-col gap-3.5 p-3.5">
          <SegmentedControl
            aria-label="Steuer-Bereich"
            value={tab}
            onChange={setTab}
            options={[{ value: 'vat', label: 'Umsatzsteuer' }, { value: 'payments', label: 'Zahlungen ans Finanzamt' }, { value: 'top', label: 'Größte USt-Posten' }]}
          />
          {error ? (
            <ErrorState title="Steuerdaten nicht erreichbar" description={error} onRetry={() => setRetry((value) => value + 1)} />
          ) : !vat || !payments ? (
            <p className="text-caption text-muted" role="status">Wird geladen…</p>
          ) : tab === 'vat' ? (
            <div className="flex flex-col gap-3.5" data-testid="tax-analytics-vat">
              <div className="grid grid-cols-[repeat(auto-fit,minmax(min(12rem,100%),1fr))] gap-3">
                <div className="rounded-tile border border-border px-4 py-3.5"><Metric marker="tick" label="Umsatzsteuer" value={euro(vat.totals.outputTax)} /></div>
                <div className="rounded-tile border border-border px-4 py-3.5"><Metric marker="tick" label="Vorsteuer" value={euro(vat.totals.inputTax)} /></div>
                <div className="rounded-tile border border-border px-4 py-3.5"><Metric marker="tick" label={vat.totals.payable >= 0 ? 'Zahllast' : 'Erstattung'} value={euro(Math.abs(vat.totals.payable))} tone={vat.totals.payable > 0 ? 'neutral' : 'success'} hint={vat.permanentExtension ? 'Mit Dauerfristverlängerung' : 'Ohne Dauerfristverlängerung'} /></div>
              </div>
              <div className="flex items-center justify-between gap-3">
                <p className="text-caption text-muted">Balken: Umsatzsteuer nach oben, Vorsteuer nach unten. Linie: Zahllast.</p>
                <SegmentedControl size="sm" aria-label="Voranmeldungszeitraum" value={granularity} onChange={setGranularity} options={[{ value: 'month', label: 'Monat' }, { value: 'quarter', label: 'Quartal' }]} />
              </div>
              {vat.periods.every((period) => period.lineCount === 0) ? (
                <EmptyState title="Keine Umsatzsteuer im Zeitraum" description="Buchungen mit Steuerfall erscheinen hier je Voranmeldungszeitraum." />
              ) : (
                <div className={insetPanel}>
                  <TimeSeriesChart
                    aria-label="Umsatzsteuer und Vorsteuer je Zeitraum"
                    formatValue={euro}
                    formatAxis={axis}
                    onSelect={onSelectPeriod ? (key) => { const period = vat.periods.find((entry) => entry.key === key); if (period) onSelectPeriod({ span: granularity, month: period.from.slice(0, 7) }); } : undefined}
                    selectLabel="Kennzahlen zeigen"
                    series={[
                      { key: 'output', label: 'Umsatzsteuer', kind: 'bar', style: 'solid', stack: 'vat' },
                      { key: 'input', label: 'Vorsteuer', kind: 'bar', style: 'hatched', stack: 'vat', downward: true },
                      { key: 'payable', label: 'Zahllast', kind: 'line' },
                    ]}
                    data={vat.periods.map((period) => ({ key: period.key, label: periodLabel(period.key, multiYear), longLabel: periodLongLabel(period.key), values: { output: period.outputTax, input: period.inputTax, payable: period.payable } }))}
                  />
                </div>
              )}
              <Table bare aria-label="Voranmeldungen und Fristen" containerClassName="max-h-[26rem]">
                <TableHeader>
                  <TableRow>
                    <TableHead>Zeitraum</TableHead>
                    <TableHead>Frist</TableHead>
                    <TableHead numeric>Umsatzsteuer</TableHead>
                    <TableHead numeric>Vorsteuer</TableHead>
                    <TableHead numeric>Zahllast</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {[...vat.periods].reverse().map((period) => (
                    <TableRow key={period.key} className={onSelectPeriod ? 'cursor-pointer' : undefined} onClick={onSelectPeriod ? () => onSelectPeriod({ span: granularity, month: period.from.slice(0, 7) }) : undefined}>
                      <TableCell>{periodLongLabel(period.key)}</TableCell>
                      <TableCell className="tabular-nums">{date(period.deadline)}</TableCell>
                      <TableCell numeric>{euro(period.outputTax)}</TableCell>
                      <TableCell numeric>{euro(period.inputTax)}</TableCell>
                      <TableCell numeric className={period.payable < 0 ? 'text-success-text font-medium' : 'font-medium'}>{euro(period.payable)}</TableCell>
                      <TableCell><Badge tone={STATUS[period.status].tone}>{STATUS[period.status].label}</Badge></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <p className="text-caption text-muted">Frist: der 10. des Folgemonats{vat.permanentExtension ? ' plus ein Monat (Dauerfristverlängerung)' : ''}, nach einem Wochenende der nächste Werktag; Feiertage sind nicht berücksichtigt. „Nicht in Billme“: der Zeitraum wurde hier nicht vorbereitet, etwa weil er im bisherigen Programm abgegeben wurde.</p>
            </div>
          ) : tab === 'payments' ? (
            <div className="flex flex-col gap-3.5" data-testid="tax-analytics-payments">
              <BarList
                aria-label="Zahlungen ans Finanzamt nach Steuerart"
                formatValue={euro}
                onSelect={(key) => setTopic(key as TopicKey)}
                items={payments.topics.map((entry) => ({ key: entry.key, label: entry.key === topic ? `${entry.label} ✓` : entry.label, hint: `${entry.entries.length} ${entry.entries.length === 1 ? 'Buchung' : 'Buchungen'}`, value: entry.net }))}
              />
              {activeTopic ? (
                <>
                  <div className="grid grid-cols-[repeat(auto-fit,minmax(min(12rem,100%),1fr))] gap-3">
                    <div className="rounded-tile border border-border px-4 py-3.5"><Metric marker="tick" label={`${activeTopic.label}: gezahlt`} value={euro(activeTopic.paid)} /></div>
                    <div className="rounded-tile border border-border px-4 py-3.5"><Metric marker="tick" label="Erstattet" value={euro(activeTopic.refunded)} /></div>
                    <div className="rounded-tile border border-border px-4 py-3.5"><Metric marker="tick" label="Saldo" value={euro(activeTopic.net)} hint={activeTopic.accounts.map((account) => account.accountNumber).join(', ') || 'Keine Konten bebucht'} /></div>
                  </div>
                  {activeTopic.months.length ? (
                    <div className={insetPanel}>
                      <TimeSeriesChart
                        aria-label={`${activeTopic.label} je Monat`}
                        formatValue={euro}
                        formatAxis={axis}
                        height={200}
                        series={[
                          { key: 'paid', label: 'Gezahlt', kind: 'bar', style: 'solid', stack: 'tax' },
                          { key: 'refunded', label: 'Erstattet', kind: 'bar', style: 'hatched', stack: 'tax', downward: true },
                        ]}
                        data={topicMonths.map((month) => ({ key: month.period, label: monthLabel(month.period, multiYear), longLabel: periodLongLabel(month.period), values: { paid: month.paid, refunded: month.refunded } }))}
                      />
                    </div>
                  ) : null}
                  {activeTopic.entries.length === 0 ? (
                    <EmptyState title="Keine Zahlungen im Zeitraum" description={`Zahlungen auf ${activeTopic.label} erscheinen hier, sobald eine Buchung das Konto zusammen mit einem Geldkonto bebucht.`} />
                  ) : (
                    <Table bare aria-label={`Zahlungen ${activeTopic.label}`} containerClassName="max-h-[24rem]">
                      <TableHeader>
                        <TableRow>
                          <TableHead>Datum</TableHead>
                          <TableHead>Beleg</TableHead>
                          <TableHead>Buchungstext</TableHead>
                          <TableHead>Konto</TableHead>
                          <TableHead numeric>Betrag</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {activeTopic.entries.map((entry) => (
                          <TableRow key={`${entry.entryId}-${entry.accountNumber}`} className={onOpenEntry ? 'cursor-pointer' : undefined} onClick={onOpenEntry ? () => onOpenEntry(entry.entryId) : undefined}>
                            <TableCell className="tabular-nums">{date(entry.postingDate)}</TableCell>
                            <TableCell>{entry.reference ?? entry.entryNumber}</TableCell>
                            <TableCell>{entry.bookingText}</TableCell>
                            <TableCell className="tabular-nums">{entry.accountNumber}</TableCell>
                            <TableCell numeric className={entry.amount < 0 ? 'text-success-text' : undefined}>{euro(entry.amount)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                  <p className="text-caption text-muted">Gezählt werden Buchungen, die ein Steuerkonto zusammen mit einem Bank-, Kassen- oder Kartenkonto bebuchen; Rückstellungen und Abgrenzungen ohne Geldfluss nicht. Eine Erstattung ist negativ.</p>
                </>
              ) : null}
            </div>
          ) : (
            <div data-testid="tax-analytics-top">
              {vat.topLines.length === 0 ? (
                <EmptyState title="Keine Steuerposten im Zeitraum" description="Hier stehen die 20 Buchungen mit der höchsten Umsatz- oder Vorsteuer." />
              ) : (
                <Table bare aria-label="Größte Umsatzsteuer-Posten">
                  <TableHeader>
                    <TableRow>
                      <TableHead>Datum</TableHead>
                      <TableHead>Beleg</TableHead>
                      <TableHead>Kennzahl</TableHead>
                      <TableHead>Steuerfall</TableHead>
                      <TableHead numeric>Bemessung</TableHead>
                      <TableHead numeric>Steuer</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {vat.topLines.map((line, index) => (
                      <TableRow key={`${line.entryId ?? index}-${line.kennziffer}-${index}`} className={onOpenEntry && line.entryId ? 'cursor-pointer' : undefined} onClick={onOpenEntry && line.entryId ? () => onOpenEntry(line.entryId!) : undefined}>
                        <TableCell className="tabular-nums">{date(line.postingDate)}</TableCell>
                        <TableCell>{line.reference ?? line.entryNumber ?? '–'}</TableCell>
                        <TableCell className="tabular-nums">Kz {line.kennziffer}{line.direction === 'input' ? ' (Vorsteuer)' : ''}</TableCell>
                        <TableCell>{line.taxCaseKey}</TableCell>
                        <TableCell numeric>{euro(line.netAmount)}</TableCell>
                        <TableCell numeric className="font-medium">{euro(line.taxAmount)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          )}
        </div>
      </Card>
    </section>
  );
}
