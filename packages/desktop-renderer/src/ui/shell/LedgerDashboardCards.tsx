import React, { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { MoreVertical } from 'lucide-react';
import {
  Card, CardHeader, Donut, EmptyState, ErrorState, IconButton, Menu, Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
  TimeSeriesChart, cn,
} from '@billme/ui';
import { readAnalysisYear, writeAnalysisYear } from '@billme/accounting-shared';
import { getRendererApi } from '../../runtime-api';
import { SkeletonLoader } from '../components/SkeletonLoader';

/**
 * The overview for double-entry businesses, read from the journal (GET /pro/accounting/analytics/overview): Erträge
 * and Aufwand per month with the result as a line, a year comparison and the Aufwand per BWA cost type. Unlike the
 * bank-line cards it also shows a ledger that came in by journal import. A click on a month or a year opens
 * Auswertungen on that range.
 */

type Navigate = (page: string, search?: Record<string, string>) => void;

/** `6`/`12`: the months up to now; a year (`2024`); `all`: first to last booked month. */
export type LedgerRange = string;

const formatCurrency = (amount: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
const formatAxis = (value: number) => {
  const abs = Math.abs(value);
  if (abs >= 1000) return `${(value / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })}k`;
  return String(Math.round(value));
};
const formatCompact = (amount: number) => {
  const abs = Math.abs(amount);
  if (abs >= 1_000_000) return `${(amount / 1_000_000).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Mio.`;
  if (abs >= 1000) return `${(amount / 1000).toLocaleString('de-DE', { maximumFractionDigits: 0 })} Tsd.`;
  return amount.toLocaleString('de-DE', { maximumFractionDigits: 0 });
};
const percent = new Intl.NumberFormat('de-DE', { style: 'percent', maximumFractionDigits: 1 });
const insetPanel = 'rounded-card border border-border bg-surface-muted p-3.5';

const pad = (value: number) => String(value).padStart(2, '0');
const monthEnd = (period: string) => {
  const [year, month] = period.split('-').map(Number);
  return `${period}-${pad(new Date(year!, month!, 0).getDate())}`;
};
const monthDate = (period: string) => new Date(Number(period.slice(0, 4)), Number(period.slice(5, 7)) - 1, 1);
const monthLabel = (period: string, withYear: boolean) => {
  const short = monthDate(period).toLocaleDateString('de-DE', { month: 'short' }).replace('.', '');
  return withYear ? `${short} ${period.slice(2, 4)}` : short;
};
const monthLongLabel = (period: string) => monthDate(period).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });

/** The dates a range asks the server for; `all` and the years need the extent of the journal. */
export const ledgerRangeDates = (range: LedgerRange, now: Date, extent: { firstPeriod?: string; lastPeriod?: string }): { from: string; to: string } | null => {
  if (range === '6' || range === '12') {
    const months = Number(range);
    const start = new Date(now.getFullYear(), now.getMonth() - months + 1, 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { from: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-01`, to: `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}` };
  }
  if (/^\d{4}$/.test(range)) return { from: `${range}-01-01`, to: `${range}-12-31` };
  if (range === 'all' && extent.firstPeriod && extent.lastPeriod) return { from: `${extent.firstPeriod}-01`, to: monthEnd(extent.lastPeriod) };
  return null;
};

const rangeLabel = (range: LedgerRange) => (range === '6' ? 'der letzten 6 Monate' : range === '12' ? 'der letzten 12 Monate' : range === 'all' ? 'aller Jahre' : range);

// Read again whenever the overview opens: an import or a posting elsewhere in the app changes the journal.
const useOverview = (enabled: boolean, range: { from: string; to: string } | null) => useQuery({
  queryKey: ['ledger-overview', range?.from ?? 'default', range?.to ?? 'default'],
  enabled,
  staleTime: 0,
  queryFn: () => getRendererApi('pro').pro.getLedgerOverview(range ?? {}),
});

/**
 * Data of the ledger overview: the twelve months up to now for the KPIs (liquidity, result of the month), the
 * range chosen for the charts, every year for the comparison, and the UStVA Zahllast of the current month.
 */
export const useLedgerDashboard = (enabled: boolean) => {
  const now = useMemo(() => new Date(), []);
  const base = useOverview(enabled, null);
  const extent = { firstPeriod: base.data?.firstPeriod, lastPeriod: base.data?.lastPeriod };
  // A year chosen in another analysis (Steuer, Geldkonten, Partner) opens the charts on it.
  const [range, setRange] = useState<LedgerRange>(() => readAnalysisYear() ?? '12');
  const [rangeTouched, setRangeTouched] = useState(() => Boolean(readAnalysisYear()));
  // Nothing booked in the last twelve months (e.g. a ledger taken over up to last year): open on the last year with bookings.
  useEffect(() => {
    if (rangeTouched || !base.data?.lastPeriod) return;
    if (base.data.months.every((month) => month.revenue === 0 && month.expense === 0)) setRange(base.data.lastPeriod.slice(0, 4));
  }, [base.data, rangeTouched]);
  const chartDates = ledgerRangeDates(range, now, extent);
  const chart = useOverview(enabled && Boolean(chartDates), chartDates);
  const allDates = ledgerRangeDates('all', now, extent);
  const all = useOverview(enabled && Boolean(allDates), allDates);
  const currentMonth = `${now.getFullYear()}-${pad(now.getMonth() + 1)}`;
  const vat = useQuery({
    queryKey: ['ledger-overview-vat', currentMonth],
    enabled,
    staleTime: 0,
    queryFn: () => getRendererApi('pro').pro.getVatSummary({ from: `${currentMonth}-01`, to: monthEnd(currentMonth) }),
  });
  const years = useMemo(() => {
    const byYear = new Map<string, { revenue: number; expense: number }>();
    for (const month of all.data?.months ?? []) {
      const entry = byYear.get(month.period.slice(0, 4)) ?? { revenue: 0, expense: 0 };
      entry.revenue += month.revenue;
      entry.expense += month.expense;
      byYear.set(month.period.slice(0, 4), entry);
    }
    return [...byYear].map(([year, entry]) => ({ year, revenue: Math.round(entry.revenue * 100) / 100, expense: Math.round(entry.expense * 100) / 100, result: Math.round((entry.revenue - entry.expense) * 100) / 100 }));
  }, [all.data]);
  const rangeOptions = useMemo(() => {
    const first = Number(extent.firstPeriod?.slice(0, 4) ?? now.getFullYear());
    const last = Math.max(Number(extent.lastPeriod?.slice(0, 4) ?? now.getFullYear()), first);
    const yearOptions = Array.from({ length: last - first + 1 }, (_, index) => String(last - index));
    return [
      { value: '6', label: 'Letzte 6 Monate' },
      { value: '12', label: 'Letzte 12 Monate' },
      ...yearOptions.map((year) => ({ value: year, label: year })),
      ...(extent.firstPeriod ? [{ value: 'all', label: 'Alle Jahre' }] : []),
    ];
  }, [extent.firstPeriod, extent.lastPeriod, now]);
  return {
    base, chart, all, vat, years, range, rangeOptions,
    setRange: (next: LedgerRange) => { setRangeTouched(true); setRange(next); if (/^(\d{4}|all)$/.test(next)) writeAnalysisYear(next); },
    currentMonth,
    monthResult: base.data?.months.at(-1)?.result,
    monthBooked: Boolean(base.data?.months.at(-1) && (base.data.months.at(-1)!.revenue !== 0 || base.data.months.at(-1)!.expense !== 0)),
    vatPayable: vat.data?.kennzahlen?.payableAmount,
  };
};
export type LedgerDashboard = ReturnType<typeof useLedgerDashboard>;

const openReport = (onNavigate: Navigate, tab: string, from: string, to: string) => onNavigate('accounting', { view: 'reports', tab, from, to });

const RangeSelect: React.FC<{ ledger: LedgerDashboard }> = ({ ledger }) => (
  <Select aria-label="Zeitraum" value={ledger.range} onChange={(event) => ledger.setRange(event.target.value)} className="min-w-[10.5rem]">
    {ledger.rangeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
  </Select>
);

/** Erträge up, Aufwand down, result as a line; one month per column, a click opens the BWA of that month. */
export const LedgerFlowsCard: React.FC<{ ledger: LedgerDashboard; onNavigate: Navigate }> = ({ ledger, onNavigate }) => {
  const [asTable, setAsTable] = useState(false);
  const months = ledger.chart.data?.months ?? [];
  const multiYear = new Set(months.map((month) => month.period.slice(0, 4))).size > 1;
  const revenue = months.reduce((sum, month) => sum + month.revenue, 0);
  const expense = months.reduce((sum, month) => sum + month.expense, 0);
  const highlight = months.some((month) => month.period === ledger.currentMonth) ? ledger.currentMonth : undefined;
  const openMonth = (period: string) => openReport(onNavigate, 'bwa01', `${period}-01`, monthEnd(period));
  return (
    <section aria-labelledby="dashboard-ledger-flows" className="min-w-0">
      <Card radius="2xl" padding="lg" className="pt-4">
        <CardHeader
          size="lg"
          title={<span id="dashboard-ledger-flows">Erträge und Aufwand</span>}
          subtitle="Netto aus der Buchhaltung je Monat, Linie: Ergebnis"
          actions={
            <>
              <RangeSelect ledger={ledger} />
              <Menu
                aria-label="Aktionen Erträge und Aufwand"
                align="end"
                items={[
                  { id: 'table', label: asTable ? 'Als Diagramm anzeigen' : 'Als Tabelle anzeigen', onSelect: () => setAsTable((value) => !value) },
                  ...(ledger.chart.data ? [{ id: 'go', label: 'BWA dieses Zeitraums öffnen', onSelect: () => openReport(onNavigate, 'bwa01', ledger.chart.data!.from, ledger.chart.data!.to) }] : []),
                ]}
                trigger={(props) => (
                  <IconButton size="sm" aria-label="Weitere Aktionen" {...props}>
                    <MoreVertical size={16} aria-hidden="true" />
                  </IconButton>
                )}
              />
            </>
          }
        />
        <div className="mt-3">
          {ledger.chart.isError ? (
            <ErrorState title="Buchhaltung nicht erreichbar" description="Die Monatswerte aus dem Journal konnten nicht geladen werden." onRetry={() => void ledger.chart.refetch()} />
          ) : ledger.chart.isLoading || ledger.base.isLoading ? (
            <SkeletonLoader variant="card" count={1} />
          ) : months.every((month) => month.revenue === 0 && month.expense === 0) ? (
            <EmptyState title="Keine Buchungen im Zeitraum" description="Erträge und Aufwand erscheinen hier, sobald im Journal gebucht ist. Ein anderer Zeitraum zeigt frühere Jahre." />
          ) : asTable ? (
            <Table bare aria-label="Erträge und Aufwand je Monat">
              <TableHeader>
                <TableRow>
                  <TableHead>Monat</TableHead>
                  <TableHead numeric>Erträge</TableHead>
                  <TableHead numeric>Aufwand</TableHead>
                  <TableHead numeric>Ergebnis</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {months.map((month) => (
                  <TableRow key={month.period} className="cursor-pointer" onClick={() => openMonth(month.period)}>
                    <TableCell>{monthLongLabel(month.period)}</TableCell>
                    <TableCell numeric>{formatCurrency(month.revenue)}</TableCell>
                    <TableCell numeric>{formatCurrency(month.expense)}</TableCell>
                    <TableCell numeric className={cn('font-medium', month.result < 0 && 'text-error-text')}>{formatCurrency(month.result)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <>
              <div className={insetPanel}>
                <TimeSeriesChart
                  aria-label="Erträge und Aufwand je Monat"
                  formatValue={formatCurrency}
                  formatAxis={formatAxis}
                  highlightKey={highlight}
                  onSelect={openMonth}
                  selectLabel="BWA öffnen"
                  series={[
                    { key: 'revenue', label: 'Erträge', kind: 'bar', style: 'solid', stack: 'flow' },
                    { key: 'expense', label: 'Aufwand', kind: 'bar', style: 'hatched', stack: 'flow', downward: true },
                    { key: 'result', label: 'Ergebnis', kind: 'line' },
                  ]}
                  data={months.map((month) => ({
                    key: month.period,
                    label: monthLabel(month.period, multiYear),
                    longLabel: monthLongLabel(month.period),
                    values: { revenue: month.revenue, expense: month.expense, result: month.result },
                  }))}
                />
              </div>
              <dl className="mt-3.5 grid grid-cols-[repeat(auto-fit,minmax(9.25rem,1fr))] gap-3.5 border-t border-border pt-3">
                <div>
                  <dt className="text-caption text-muted">Erträge {rangeLabel(ledger.range)}</dt>
                  <dd className="mt-0.5 text-heading font-bold tabular-nums">{formatCurrency(revenue)}</dd>
                </div>
                <div>
                  <dt className="text-caption text-muted">Aufwand {rangeLabel(ledger.range)}</dt>
                  <dd className="mt-0.5 text-heading font-bold tabular-nums">{formatCurrency(expense)}</dd>
                </div>
                <div>
                  <dt className="text-caption text-muted">Ergebnis</dt>
                  <dd className={cn('mt-0.5 text-heading font-bold tabular-nums', revenue - expense >= 0 ? 'text-success-text' : 'text-error-text')}>{formatCurrency(revenue - expense)}</dd>
                </div>
              </dl>
            </>
          )}
        </div>
      </Card>
    </section>
  );
};

/** Aufwand of the chosen range per BWA cost type. */
export const LedgerExpenseCard: React.FC<{ ledger: LedgerDashboard; onNavigate: Navigate }> = ({ ledger, onNavigate }) => {
  const [asTable, setAsTable] = useState(false);
  const lines = (ledger.chart.data?.expenseBreakdown ?? []).filter((line) => line.value > 0);
  const total = lines.reduce((sum, line) => sum + line.value, 0);
  const segments = useMemo(() => {
    const top = lines.slice(0, 4).map((line) => ({ key: line.key, label: line.label, value: line.value, formatted: formatCompact(line.value) }));
    const rest = lines.slice(4).reduce((sum, line) => sum + line.value, 0);
    return rest > 0 ? [...top, { key: 'rest', label: 'Übrige Kostenarten', value: rest, formatted: formatCompact(rest) }] : top;
  }, [lines]);
  return (
    <section aria-labelledby="dashboard-ledger-expenses" className="min-w-0">
      <Card radius="2xl" padding="lg" className="pt-4">
        <CardHeader
          size="lg"
          title={<span id="dashboard-ledger-expenses">Aufwandsstruktur</span>}
          subtitle={<>Aufwand {rangeLabel(ledger.range)} nach BWA-Kostenart{total > 0 && <>, zusammen <span className="tabular-nums">{formatCurrency(total)}</span></>}</>}
          count={lines.length ? `${lines.length} Kostenarten` : undefined}
          actions={
            <Menu
              aria-label="Aktionen Aufwandsstruktur"
              align="end"
              items={[
                { id: 'table', label: asTable ? 'Als Diagramm anzeigen' : 'Als Tabelle anzeigen', onSelect: () => setAsTable((value) => !value) },
                ...(ledger.chart.data ? [{ id: 'go', label: 'BWA dieses Zeitraums öffnen', onSelect: () => openReport(onNavigate, 'bwa01', ledger.chart.data!.from, ledger.chart.data!.to) }] : []),
              ]}
              trigger={(props) => (
                <IconButton size="sm" aria-label="Weitere Aktionen" {...props}>
                  <MoreVertical size={16} aria-hidden="true" />
                </IconButton>
              )}
            />
          }
        />
        <div className="mt-3">
          {segments.length === 0 ? (
            <EmptyState title="Kein Aufwand im Zeitraum" description="Der Aufwand erscheint hier nach BWA-Kostenart, sobald im Journal gebucht ist." />
          ) : asTable ? (
            <Table bare aria-label="Aufwand nach BWA-Kostenart">
              <TableHeader>
                <TableRow>
                  <TableHead>Kostenart</TableHead>
                  <TableHead numeric>Betrag</TableHead>
                  <TableHead numeric>Anteil</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {lines.map((line) => (
                  <TableRow key={line.key}>
                    <TableCell>{line.label}</TableCell>
                    <TableCell numeric>{formatCurrency(line.value)}</TableCell>
                    <TableCell numeric muted>{percent.format(total ? line.value / total : 0)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Donut label="Aufwand nach BWA-Kostenart" segments={segments} total={formatCompact(total)} />
          )}
        </div>
      </Card>
    </section>
  );
};

/** Erträge, Aufwand and result per year over the whole journal; a click opens the GuV of that year. */
export const LedgerYearsCard: React.FC<{ ledger: LedgerDashboard; onNavigate: Navigate }> = ({ ledger, onNavigate }) => {
  if (ledger.years.length < 2) return null;
  const openYear = (year: string) => openReport(onNavigate, 'hgb_guv', `${year}-01-01`, `${year}-12-31`);
  const latest = ledger.years.at(-1)!;
  const previous = ledger.years.at(-2)!;
  const change = previous.revenue ? (latest.revenue - previous.revenue) / Math.abs(previous.revenue) : undefined;
  return (
    <section aria-labelledby="dashboard-ledger-years" className="min-w-0">
      <Card radius="2xl" padding="lg" className="pt-4">
        <CardHeader
          size="lg"
          title={<span id="dashboard-ledger-years">Jahresvergleich</span>}
          subtitle={<>Erträge und Aufwand je Jahr, Linie: Ergebnis{change !== undefined && <>. Erträge {latest.year} gegenüber {previous.year}: <span className="tabular-nums">{change >= 0 ? '+' : ''}{percent.format(change)}</span></>}</>}
          count={`${ledger.years.length} Jahre`}
        />
        <div className={cn(insetPanel, 'mt-3')}>
          <TimeSeriesChart
            aria-label="Erträge und Aufwand je Jahr"
            formatValue={formatCurrency}
            formatAxis={formatAxis}
            onSelect={openYear}
            selectLabel="GuV öffnen"
            height={220}
            series={[
              { key: 'revenue', label: 'Erträge', kind: 'bar', style: 'solid' },
              { key: 'expense', label: 'Aufwand', kind: 'bar', style: 'hatched' },
              { key: 'result', label: 'Ergebnis', kind: 'line' },
            ]}
            data={ledger.years.map((year) => ({ key: year.year, label: year.year, longLabel: `Geschäftsjahr ${year.year}`, values: { revenue: year.revenue, expense: year.expense, result: year.result } }))}
          />
        </div>
      </Card>
    </section>
  );
};
