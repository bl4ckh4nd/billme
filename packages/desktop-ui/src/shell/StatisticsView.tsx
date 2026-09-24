import React, { useState, useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { TrendingUp, TrendingDown, ArrowUpRight } from 'lucide-react';
import { BarChart, Button, EmptyState, ErrorState, Metric, PageHeader, SegmentedControl } from '@billme/ui';
import type { AppSettings, Client, Invoice } from '@billme/desktop-core/types';
import { useInvoicesQuery } from '@billme/desktop-renderer/hooks/useInvoices';
import { useClientsQuery } from '@billme/desktop-renderer/hooks/useClients';
import { useSettingsQuery } from '@billme/desktop-renderer/hooks/useSettings';
import { SkeletonLoader } from '../components/SkeletonLoader';

const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
};

/** Axis ticks: no cents, the scale only has to be readable. */
const formatAxisValue = (amount: number) =>
  `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(amount)} €`;

type TimeRange = 'month' | 'quarter' | 'year' | 'all';

/**
 * Statistiken answer "how much did we actually earn". The revenue figure is the
 * answer, so it carries the focal card; open items, average invoice and payment
 * ratio stay a compact row underneath. All three queries are gated: a failed
 * query must not render as a zero statistic.
 */
export const StatisticsView: React.FC = () => {
  const invoicesQuery = useInvoicesQuery();
  const clientsQuery = useClientsQuery();
  const settingsQuery = useSettingsQuery();

  if (invoicesQuery.isError || clientsQuery.isError || settingsQuery.isError) {
    return (
      <ErrorState
        title="Statistiken konnten nicht geladen werden"
        description="Rechnungen, Kunden oder Einstellungen sind nicht verfügbar. Ohne sie lassen sich keine Kennzahlen berechnen."
        onRetry={() => {
          void invoicesQuery.refetch();
          void clientsQuery.refetch();
          void settingsQuery.refetch();
        }}
      />
    );
  }

  if (invoicesQuery.isPending || clientsQuery.isPending || !settingsQuery.data) {
    return <SkeletonLoader variant="card" count={3} />;
  }

  return (
    <StatisticsContent
      invoices={invoicesQuery.data}
      clients={clientsQuery.data}
      settings={settingsQuery.data}
    />
  );
};

const StatisticsContent: React.FC<{
  invoices: Invoice[];
  clients: Client[];
  settings: AppSettings;
}> = ({ invoices, clients, settings }) => {
  const navigate = useNavigate();
  const [timeRange, setTimeRange] = useState<TimeRange>('year');
  const dash = settings.dashboard;

  const filteredData = useMemo(() => {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();

    return invoices.filter(inv => {
      const invDate = new Date(inv.date);

      switch (timeRange) {
        case 'month':
          return invDate.getMonth() === currentMonth && invDate.getFullYear() === currentYear;
        case 'quarter': {
          const currentQuarter = Math.floor(currentMonth / 3);
          const invQuarter = Math.floor(invDate.getMonth() / 3);
          return invQuarter === currentQuarter && invDate.getFullYear() === currentYear;
        }
        case 'year':
          return invDate.getFullYear() === currentYear;
        default:
          return true;
      }
    });
  }, [invoices, timeRange]);

  const kpis = useMemo(() => {
    const revenue = filteredData
      .filter(i => i.status === 'paid')
      .reduce((acc, curr) => acc + curr.amount, 0);

    const outstanding = filteredData
      .filter(i => i.status === 'open' || i.status === 'overdue')
      .reduce((acc, curr) => acc + curr.amount, 0);

    const overdue = filteredData
      .filter(i => i.status === 'overdue')
      .reduce((acc, curr) => acc + curr.amount, 0);

    const paidCount = filteredData.filter(i => i.status === 'paid').length;
    const totalCount = filteredData.length;
    const conversionRate = totalCount > 0 ? (paidCount / totalCount) * 100 : 0;
    const avgTicket = paidCount > 0 ? revenue / paidCount : 0;

    return { revenue, outstanding, overdue, conversionRate, avgTicket, totalCount, paidCount };
  }, [filteredData]);

  const revenueTrend = useMemo(() => {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();

    const getPrevPeriodRevenue = () => {
      const prevInvoices = invoices.filter(i => i.status === 'paid');
      switch (timeRange) {
        case 'month': {
          const prev = new Date(currentYear, currentMonth - 1, 1);
          return prevInvoices
            .filter(inv => {
              const d = new Date(inv.date);
              return d.getFullYear() === prev.getFullYear() && d.getMonth() === prev.getMonth();
            })
            .reduce((acc, inv) => acc + inv.amount, 0);
        }
        case 'quarter': {
          const currentQ = Math.floor(currentMonth / 3);
          const prevQ = currentQ - 1;
          const prevYear = prevQ < 0 ? currentYear - 1 : currentYear;
          const prevQNorm = prevQ < 0 ? 3 : prevQ;
          return prevInvoices
            .filter(inv => {
              const d = new Date(inv.date);
              return d.getFullYear() === prevYear && Math.floor(d.getMonth() / 3) === prevQNorm;
            })
            .reduce((acc, inv) => acc + inv.amount, 0);
        }
        case 'year': {
          return prevInvoices
            .filter(inv => new Date(inv.date).getFullYear() === currentYear - 1)
            .reduce((acc, inv) => acc + inv.amount, 0);
        }
        default:
          return 0;
      }
    };

    const prev = getPrevPeriodRevenue();
    if (prev <= 0) return null;
    return Math.round(((kpis.revenue - prev) / prev) * 100 * 10) / 10;
  }, [invoices, kpis.revenue, timeRange]);

  // Monthly distribution of the paid invoices in the selected range.
  const chartData = useMemo(() => {
    const months = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
    const data = new Array(12).fill(0);

    filteredData.forEach(inv => {
        if (inv.status === 'paid') {
            const month = new Date(inv.date).getMonth();
            data[month] += inv.amount;
        }
    });

    const maxVal = Math.max(...data, 0);
    return months.map((label, i) => ({
        label,
        value: data[i],
        height: maxVal > 0 ? (data[i] / maxVal) * 100 : 0
    }));
  }, [filteredData]);

  const chartMax = useMemo(
    () => chartData.reduce((max, d) => Math.max(max, d.value), 0),
    [chartData],
  );

  const topClients = useMemo(() => {
      const clientMap = new Map<string, number>();

      filteredData.filter(i => i.status === 'paid').forEach(inv => {
          const current = clientMap.get(inv.clientId || 'unknown') || 0;
          clientMap.set(inv.clientId || 'unknown', current + inv.amount);
      });

      return Array.from(clientMap.entries())
        .map(([id, amount]) => {
            const clientDetails = clients.find(c => c.id === id);
            return {
                name: clientDetails ? clientDetails.company : 'Unbekannt',
                amount
            };
        })
        .sort((a, b) => b.amount - a.amount)
        .slice(0, dash.topClientsLimit);
  }, [filteredData, clients, dash.topClientsLimit]);

  const MONTH_NAMES = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  const currentMonthIndex = new Date().getMonth();
  const bars = chartData.map((d, i) => ({
    key: String(i),
    label: d.label,
    longLabel: MONTH_NAMES[i],
    value: d.value,
    highlight: i === currentMonthIndex && timeRange !== 'all',
  }));

  return (
    <div className="flex flex-col pb-4">
      <PageHeader
        title="Statistiken"
        description="Finanzüberblick und Geschäftsentwicklung"
        className="px-1 pt-2"
        actions={
          <SegmentedControl
            aria-label="Zeitraum"
            value={timeRange}
            onChange={setTimeRange}
            options={[
              { value: 'month', label: 'Monat' },
              { value: 'quarter', label: 'Quartal' },
              { value: 'year', label: 'Jahr' },
              { value: 'all', label: 'Gesamt' },
            ]}
          />
        }
      />

      {/* Revenue is the answer this screen exists for: the one inverse figure. */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <section className="flex flex-col justify-between gap-6 rounded-panel bg-surface-inverse p-6 text-inverse-foreground">
              <div className="flex items-start justify-between gap-3">
                  <h2 className="text-label text-inverse-muted">Umsatz, bezahlt</h2>
                  {revenueTrend !== null && (
                    <span className={`inline-flex items-center gap-1 text-caption font-medium tabular-nums ${revenueTrend >= 0 ? 'text-accent' : 'text-error-inverse'}`}>
                        {revenueTrend >= 0 ? <TrendingUp size={14} aria-hidden="true" /> : <TrendingDown size={14} aria-hidden="true" />}
                        {revenueTrend >= 0 ? '+' : ''}{revenueTrend}% zum Vorzeitraum
                    </span>
                  )}
              </div>
              <p className="text-4xl font-semibold tracking-[-0.02em] tabular-nums">{formatCurrency(kpis.revenue)}</p>
          </section>

          <section className="lg:col-span-2 grid grid-cols-1 divide-y divide-border-subtle rounded-panel bg-surface shadow-xs sm:grid-cols-3 sm:divide-x sm:divide-y-0">
              <Metric
                className="p-6"
                label="Offene Forderungen"
                value={formatCurrency(kpis.outstanding)}
                tone={kpis.overdue > 0 ? 'error' : 'neutral'}
                hint={kpis.overdue > 0 ? <span className="text-error-text tabular-nums">davon {formatCurrency(kpis.overdue)} überfällig</span> : undefined}
              />
              <Metric className="p-6" label="Ø Rechnungswert" value={formatCurrency(kpis.avgTicket)} />
              <Metric
                className="p-6"
                label="Zahlungsquote"
                value={`${Math.round(kpis.conversionRate)} %`}
                hint={kpis.totalCount > 0
                  ? `${kpis.paidCount} von ${kpis.totalCount} ${kpis.totalCount === 1 ? 'Rechnung' : 'Rechnungen'} bezahlt`
                  : undefined}
              />
          </section>
      </div>

      <div className="mt-3 grid flex-1 grid-cols-1 gap-3 lg:grid-cols-3">
          <section aria-labelledby="statistics-chart" className="lg:col-span-2 flex flex-col rounded-panel bg-surface p-6 shadow-xs">
              <div className="mb-6 flex items-baseline justify-between gap-4">
                  <h2 id="statistics-chart" className="text-section">Umsatzentwicklung</h2>
                  <span className="shrink-0 text-caption text-muted">Bezahlte Rechnungen, Monatssumme</span>
              </div>
              {chartMax <= 0 ? (
                <EmptyState
                  className="flex-1"
                  title="Keine bezahlten Rechnungen"
                  description="In diesem Zeitraum ist keine bezahlte Rechnung enthalten. Wähle einen größeren Zeitraum oder markiere Rechnungen als bezahlt."
                  action={<Button variant="secondary" size="sm" onClick={() => setTimeRange('all')}>Gesamten Zeitraum anzeigen</Button>}
                />
              ) : (
                <BarChart
                  aria-label="Umsatzentwicklung, bezahlte Rechnungen je Monat"
                  valueHeader="Umsatz"
                  data={bars}
                  formatValue={formatCurrency}
                  formatAxis={formatAxisValue}
                  height={260}
                />
              )}
          </section>

          <section aria-labelledby="statistics-clients" className="flex flex-col rounded-panel bg-surface p-6 shadow-xs">
              <h2 id="statistics-clients" className="mb-4 text-section">Kunden mit dem höchsten Umsatz</h2>
              {topClients.length === 0 ? (
                <EmptyState
                  className="flex-1"
                  title="Keine bezahlten Rechnungen in diesem Zeitraum"
                  description="Wähle einen größeren Zeitraum oder markiere Rechnungen als bezahlt."
                  action={<Button variant="secondary" size="sm" onClick={() => setTimeRange('all')}>Gesamten Zeitraum anzeigen</Button>}
                />
              ) : (
                <ol className="flex-1 space-y-4 overflow-y-auto">
                  {topClients.map((client, idx) => (
                    <li key={`${client.name}:${idx}`} className="flex items-center gap-3">
                      <span className="w-5 shrink-0 text-caption font-medium text-muted tabular-nums">{idx + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="mb-1.5 flex items-center justify-between gap-3">
                          <span className="truncate text-sm font-medium">{client.name}</span>
                          <span className="text-sm font-medium tabular-nums">{formatCurrency(client.amount)}</span>
                        </div>
                        <div className="h-1 w-full overflow-hidden rounded-full bg-ink-100">
                          <div
                            className={`h-full rounded-full ${idx === 0 ? 'bg-ink-950' : 'bg-ink-400'}`}
                            style={{ width: `${kpis.revenue > 0 ? Math.min(100, (client.amount / kpis.revenue) * 100) : 0}%` }}
                          />
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}

              <Button variant="ghost" size="sm" className="mt-4 self-start -ml-3" onClick={() => navigate({ to: '/clients' })}>
                  Alle Kunden ansehen <ArrowUpRight size={14} aria-hidden="true" />
              </Button>
          </section>
      </div>
    </div>
  );
};
