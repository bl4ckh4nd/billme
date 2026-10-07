import React, { useState, useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { TrendingUp, TrendingDown, ArrowUpRight } from 'lucide-react';
import { BarChart, Button, Card, CardHeader, EmptyState, ErrorState, Metric, PageHeader, SegmentedControl, cn } from '@billme/ui';
import type { AppSettings, Client, Invoice } from '@billme/desktop-core/types';
import { useInvoicesQuery } from '../../hooks/useInvoices';
import { useClientsQuery } from '../../hooks/useClients';
import { useSettingsQuery } from '../../hooks/useSettings';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { billingDocuments } from '../../billingDocuments';

const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
};

/** Axis ticks: no cents, the scale only has to be readable. */
const formatAxisValue = (amount: number) =>
  `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(amount)} €`;

type TimeRange = 'month' | 'quarter' | 'year' | 'all';

/**
 * Statistiken answer "how much did we actually earn". The revenue figure leads
 * the KPI row; open items, average invoice and payment ratio follow it. All
 * three queries are gated: a failed query must not render as a zero statistic.
 */
export interface StatisticsViewProps {
  /** Hosts that group several reports (Lite Auswertungen) pass their own title and tab row. */
  title?: string;
  toolbar?: React.ReactNode;
}

export const StatisticsView: React.FC<StatisticsViewProps> = ({ title, toolbar }) => {
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
      invoices={billingDocuments(invoicesQuery.data)}
      clients={clientsQuery.data}
      settings={settingsQuery.data}
      title={title}
      toolbar={toolbar}
    />
  );
};

const StatisticsContent: React.FC<{
  invoices: Invoice[];
  clients: Client[];
  settings: AppSettings;
} & StatisticsViewProps> = ({ invoices, clients, settings, title = 'Statistiken', toolbar }) => {
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
        title={title}
        description="Finanzüberblick und Geschäftsentwicklung"
        toolbar={toolbar}
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

      <section aria-label="Kennzahlen" className="grid grid-cols-[repeat(auto-fit,minmax(min(13.25rem,100%),1fr))] gap-3">
        <div className="rounded-tile border border-border bg-surface px-4 py-3.5">
          <Metric
            marker="tick"
            label="Umsatz, bezahlt"
            value={formatCurrency(kpis.revenue)}
            hint={revenueTrend !== null ? (
              <span className={cn('inline-flex items-center gap-1 tabular-nums', revenueTrend >= 0 ? 'text-success-text' : 'text-error-text')}>
                {revenueTrend >= 0 ? <TrendingUp size={14} aria-hidden="true" /> : <TrendingDown size={14} aria-hidden="true" />}
                {revenueTrend >= 0 ? '+' : ''}{revenueTrend}% zum Vorzeitraum
              </span>
            ) : undefined}
          />
        </div>
        <div className="rounded-tile border border-border bg-surface px-4 py-3.5">
          <Metric
            marker="tick"
            label="Offene Forderungen"
            value={formatCurrency(kpis.outstanding)}
            tone={kpis.overdue > 0 ? 'error' : 'neutral'}
            hint={kpis.overdue > 0 ? <span className="text-error-text tabular-nums">davon {formatCurrency(kpis.overdue)} überfällig</span> : undefined}
          />
        </div>
        <div className="rounded-tile border border-border bg-surface px-4 py-3.5">
          <Metric marker="tick" label="Ø Rechnungswert" value={formatCurrency(kpis.avgTicket)} />
        </div>
        <div className="rounded-tile border border-border bg-surface px-4 py-3.5">
          <Metric
            marker="tick"
            label="Zahlungsquote"
            value={`${Math.round(kpis.conversionRate)} %`}
            hint={kpis.totalCount > 0
              ? `${kpis.paidCount} von ${kpis.totalCount} ${kpis.totalCount === 1 ? 'Rechnung' : 'Rechnungen'} bezahlt`
              : undefined}
          />
        </div>
      </section>

      <div className="mt-3.5 grid grid-cols-1 items-start gap-3.5 lg:grid-cols-3">
        <section aria-labelledby="statistics-chart" className="min-w-0 lg:col-span-2">
          <Card padding="none">
            <CardHeader
              className="border-b border-border px-3.5 py-3"
              title={<span id="statistics-chart">Umsatzentwicklung</span>}
              subtitle="Bezahlte Rechnungen, Monatssumme"
            />
            <div className="p-3.5">
              {chartMax <= 0 ? (
                <EmptyState
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
            </div>
          </Card>
        </section>

        <section aria-labelledby="statistics-clients" className="min-w-0">
          <Card padding="none">
            <CardHeader
              className="border-b border-border px-3.5 py-3"
              title={<span id="statistics-clients">Kunden mit dem höchsten Umsatz</span>}
            />
            <div className="flex flex-col p-3.5">
              {topClients.length === 0 ? (
                <EmptyState
                  title="Keine bezahlten Rechnungen in diesem Zeitraum"
                  description="Wähle einen größeren Zeitraum oder markiere Rechnungen als bezahlt."
                  action={<Button variant="secondary" size="sm" onClick={() => setTimeRange('all')}>Gesamten Zeitraum anzeigen</Button>}
                />
              ) : (
                <ol className="space-y-3.5">
                  {topClients.map((client, idx) => (
                    <li key={`${client.name}:${idx}`} className="flex items-center gap-3">
                      <span className="w-5 shrink-0 text-caption font-medium text-muted tabular-nums">{idx + 1}</span>
                      <div className="min-w-0 flex-1">
                        <div className="mb-1.5 flex items-center justify-between gap-3 text-control font-medium">
                          <span className="truncate">{client.name}</span>
                          <span className="tabular-nums">{formatCurrency(client.amount)}</span>
                        </div>
                        <div className="h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
                          <div
                            className={`h-full rounded-full ${idx === 0 ? 'bg-selected' : 'bg-muted'}`}
                            style={{ width: `${kpis.revenue > 0 ? Math.min(100, (client.amount / kpis.revenue) * 100) : 0}%` }}
                          />
                        </div>
                      </div>
                    </li>
                  ))}
                </ol>
              )}

              <Button variant="ghost" size="sm" className="mt-3 -ml-2.25 self-start" onClick={() => navigate({ to: '/clients' })}>
                Alle Kunden ansehen <ArrowUpRight size={14} aria-hidden="true" />
              </Button>
            </div>
          </Card>
        </section>
      </div>
    </div>
  );
};
