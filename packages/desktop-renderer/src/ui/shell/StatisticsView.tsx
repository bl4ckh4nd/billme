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

  // Revenue follows the money like the EÜR (Zuflussprinzip): payments by payment date, net of the invoice's VAT
  // share; partial payments and refunds count, Skonto is no money. Open items are a stock, independent of the range.
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth();
  const monthOf = (date: string) => ({ year: Number(date.slice(0, 4)), month: Number(date.slice(5, 7)) - 1 });
  /** `shift` moves the range back by whole periods (1 = the period before). */
  const inRange = (date: string, shift = 0) => {
    const { year, month } = monthOf(date);
    switch (timeRange) {
      case 'month': {
        const target = new Date(currentYear, currentMonth - shift, 1);
        return year === target.getFullYear() && month === target.getMonth();
      }
      case 'quarter': {
        const target = new Date(currentYear, Math.floor(currentMonth / 3) * 3 - 3 * shift, 1);
        return year === target.getFullYear() && Math.floor(month / 3) === Math.floor(target.getMonth() / 3);
      }
      case 'year':
        return year === currentYear - shift;
      default:
        return shift === 0;
    }
  };

  const payments = useMemo(() => invoices.filter((inv) => inv.status !== 'draft').flatMap((inv) => {
    const snapshot = inv.taxSnapshot;
    const netShare = snapshot && snapshot.grossAmount > 0 ? snapshot.netAmount / snapshot.grossAmount : 1;
    return (inv.payments ?? [])
      .filter((payment) => !payment.id.startsWith('skonto:'))
      .map((payment) => ({ invoice: inv, date: payment.date, net: (Number(payment.amount) || 0) * netShare }));
  }), [invoices]);

  const filteredPayments = payments.filter((payment) => inRange(payment.date));
  const filteredInvoices = invoices.filter((inv) => inv.status !== 'draft' && inRange(inv.date));

  const kpis = useMemo(() => {
    const paidOf = (inv: Invoice) => (inv.payments ?? []).reduce((sum, payment) => sum + (Number(payment.amount) || 0), 0);
    const openOf = (inv: Invoice) => Math.max(0, Math.round((inv.amount - paidOf(inv)) * 100) / 100);
    const open = invoices.filter((inv) => inv.status === 'open' || inv.status === 'overdue');
    const outstanding = open.reduce((acc, inv) => acc + openOf(inv), 0);
    const overdue = open.filter((inv) => inv.status === 'overdue').reduce((acc, inv) => acc + openOf(inv), 0);
    const revenue = filteredPayments.reduce((acc, payment) => acc + payment.net, 0);
    const paidCount = filteredInvoices.filter((inv) => inv.status === 'paid').length;
    const totalCount = filteredInvoices.length;
    const conversionRate = totalCount > 0 ? (paidCount / totalCount) * 100 : 0;
    // Average of what was invoiced in the range (net, by invoice date), not of what has been paid so far.
    const invoiced = filteredInvoices.filter((inv) => inv.amount > 0);
    const invoicedNet = invoiced.reduce((acc, inv) => acc + (inv.taxSnapshot?.netAmount ?? inv.amount), 0);
    const avgTicket = invoiced.length > 0 ? invoicedNet / invoiced.length : 0;
    return { revenue, outstanding, overdue, conversionRate, avgTicket, totalCount, paidCount };
  }, [invoices, filteredPayments, filteredInvoices]);

  const revenueTrend = useMemo(() => {
    if (timeRange === 'all') return null;
    const prev = payments.filter((payment) => inRange(payment.date, 1)).reduce((acc, payment) => acc + payment.net, 0);
    if (prev <= 0) return null;
    return Math.round(((kpis.revenue - prev) / prev) * 100 * 10) / 10;
  }, [payments, kpis.revenue, timeRange]);

  // Monthly distribution of the payments in the selected range, by payment month.
  const chartData = useMemo(() => {
    const months = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
    const data = new Array(12).fill(0);
    filteredPayments.forEach((payment) => { data[monthOf(payment.date).month] += payment.net; });
    return months.map((label, i) => ({ label, value: data[i] }));
  }, [filteredPayments]);

  const hasChartValues = chartData.some((d) => d.value !== 0);

  const topClients = useMemo(() => {
      const clientMap = new Map<string, number>();
      filteredPayments.forEach((payment) => {
          const id = payment.invoice.clientId || 'unknown';
          clientMap.set(id, (clientMap.get(id) || 0) + payment.net);
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
  }, [filteredPayments, clients, dash.topClientsLimit]);

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
            label="Umsatz netto, bezahlt"
            value={formatCurrency(kpis.revenue)}
            hint={revenueTrend !== null ? (
              <span className={cn('inline-flex items-center gap-1 tabular-nums', revenueTrend >= 0 ? 'text-success-text' : 'text-error-text')}>
                {revenueTrend >= 0 ? <TrendingUp size={14} aria-hidden="true" /> : <TrendingDown size={14} aria-hidden="true" />}
                {revenueTrend >= 0 ? '+' : ''}{revenueTrend}% zum Vorzeitraum
              </span>
            ) : 'Zahlungseingänge nach Zahlungsdatum'}
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
          <Metric marker="tick" label="Ø Rechnungswert netto" hint="Gestellte Rechnungen im Zeitraum" value={formatCurrency(kpis.avgTicket)} />
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
              subtitle="Zahlungseingänge netto, nach Zahlungsdatum"
            />
            <div className="p-3.5">
              {!hasChartValues ? (
                <EmptyState
                  title="Keine Zahlungseingänge"
                  description="In diesem Zeitraum ist keine Zahlung eingegangen. Wähle einen größeren Zeitraum oder erfasse eine Zahlung an der Rechnung."
                  action={<Button variant="secondary" size="sm" onClick={() => setTimeRange('all')}>Gesamten Zeitraum anzeigen</Button>}
                />
              ) : (
                <BarChart
                  aria-label="Umsatzentwicklung, Zahlungseingänge netto je Monat"
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
                  title="Keine Zahlungseingänge in diesem Zeitraum"
                  description="Wähle einen größeren Zeitraum oder erfasse eine Zahlung an der Rechnung."
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
