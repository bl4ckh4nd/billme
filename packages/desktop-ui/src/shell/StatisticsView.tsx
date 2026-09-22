import React, { useState, useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import {
  TrendingUp, TrendingDown, Euro,
  ArrowUpRight, FileText, PieChart, BarChart3, Percent
} from 'lucide-react';
import { EmptyState, ErrorState } from '@billme/ui';
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

  return (
    <div className="flex flex-col gap-6 h-full pb-8">

      {/* Header & Filter */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-surface rounded-xl p-6 shadow-sm">
        <div>
           <h1 className="text-3xl font-black text-foreground flex items-center gap-3">
               <BarChart3 className="text-foreground" aria-hidden="true" />
               Statistiken
           </h1>
           <p className="text-muted font-medium text-sm mt-1">
               Finanzüberblick und Geschäftsentwicklung
           </p>
        </div>

        <div className="flex bg-surface-muted p-1.5 rounded-full">
            {[
                { id: 'month', label: 'Monat' },
                { id: 'quarter', label: 'Quartal' },
                { id: 'year', label: 'Jahr' },
                { id: 'all', label: 'Gesamt' },
            ].map((t) => (
                <button
                    key={t.id}
                    type="button"
                    onClick={() => setTimeRange(t.id as TimeRange)}
                    aria-pressed={timeRange === t.id}
                    className={`px-6 py-2 rounded-full text-xs font-bold motion-safe:transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                        timeRange === t.id
                        ? 'bg-dark-base text-background'
                        : 'text-muted hover:text-foreground'
                    }`}
                >
                    {t.label}
                </button>
            ))}
        </div>
      </div>

      {/* Revenue is the answer this screen exists for; the rest is a compact row. */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="bg-dark-3 rounded-xl p-6 text-white flex flex-col justify-between shadow-sm">
              <div className="flex justify-between items-start">
                  <div className="p-3 bg-white/10 rounded-xl border border-white/10">
                      <Euro size={20} className="text-accent" aria-hidden="true" />
                  </div>
                  {revenueTrend !== null && (
                    <span className="bg-white/10 text-white text-xs font-bold px-2 py-1 rounded-full flex items-center gap-1 tabular-nums">
                        {revenueTrend >= 0 ? <TrendingUp size={12} aria-hidden="true" /> : <TrendingDown size={12} aria-hidden="true" />}
                        {revenueTrend >= 0 ? '+' : ''}{revenueTrend}% zum Vormonat
                    </span>
                  )}
              </div>
              <div className="mt-6">
                  <p className="text-dark-muted text-xs font-bold uppercase tracking-wide mb-1">Umsatz (Bezahlt)</p>
                  <h3 className="text-4xl font-bold tabular-nums">{formatCurrency(kpis.revenue)}</h3>
              </div>
          </div>

          <div className="lg:col-span-2 bg-surface rounded-xl border border-border grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-border">
              <div className="p-5 flex flex-col justify-between gap-4">
                  <div className="p-2 bg-error-bg rounded-md w-fit">
                      <FileText size={18} className="text-error-text" aria-hidden="true" />
                  </div>
                  <div>
                      <p className="text-muted text-xs font-bold uppercase tracking-wide mb-1">Offene Forderungen</p>
                      <h3 className="text-xl font-bold tabular-nums text-foreground">{formatCurrency(kpis.outstanding)}</h3>
                      {kpis.overdue > 0 && (
                          <p className="text-xs font-bold text-error-text mt-1 tabular-nums">
                              davon {formatCurrency(kpis.overdue)} überfällig
                          </p>
                      )}
                  </div>
              </div>

              <div className="p-5 flex flex-col justify-between gap-4">
                  <div className="p-2 bg-accent rounded-md w-fit">
                      <PieChart size={18} className="text-accent-foreground" aria-hidden="true" />
                  </div>
                  <div>
                      <p className="text-muted text-xs font-bold uppercase tracking-wide mb-1">Ø Rechnungswert</p>
                      <h3 className="text-xl font-bold tabular-nums text-foreground">{formatCurrency(kpis.avgTicket)}</h3>
                  </div>
              </div>

              <div className="p-5 flex flex-col justify-between gap-4">
                  <div className="p-2 bg-surface-muted rounded-md w-fit">
                      <Percent size={18} className="text-foreground" aria-hidden="true" />
                  </div>
                  <div>
                      <p className="text-muted text-xs font-bold uppercase tracking-wide mb-1">Zahlungsquote</p>
                      <div className="flex items-center gap-3">
                        <h3 className="text-xl font-bold tabular-nums text-foreground">{Math.round(kpis.conversionRate)}%</h3>
                        <div className="flex-1 bg-surface-muted h-2 rounded-full overflow-hidden">
                            <div
                                className="bg-dark-base h-full w-full origin-left rounded-full motion-safe:transition-transform motion-safe:duration-200 motion-safe:ease-out motion-reduce:transition-none"
                                style={{ transform: `scaleX(${Math.min(Math.max(kpis.conversionRate, 0), 100) / 100})` }}
                            ></div>
                        </div>
                      </div>
                      {kpis.totalCount > 0 && (
                        <p className="text-xs text-muted font-medium mt-1.5 tabular-nums">
                          {kpis.paidCount} von {kpis.totalCount} {kpis.totalCount === 1 ? 'Rechnung' : 'Rechnungen'} bezahlt
                        </p>
                      )}
                  </div>
              </div>
          </div>
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 min-h-[400px]">

          {/* Main Chart */}
          <div className="lg:col-span-2 bg-surface rounded-xl p-8 border border-border flex flex-col">
              <div className="mb-8 flex justify-between items-baseline gap-4">
                  <h3 className="font-bold text-xl">Umsatzentwicklung (bezahlte Rechnungen)</h3>
                  <span className="text-xs font-bold text-muted shrink-0">Monatssumme in €</span>
              </div>

              <div className="flex-1 flex flex-col min-h-[250px]">
                  <div className="flex-1 flex gap-3">
                      <div className="w-20 shrink-0 flex flex-col justify-between items-end pb-1 text-xs font-bold text-muted tabular-nums">
                          <span>{formatAxisValue(chartMax)}</span>
                          <span>{formatAxisValue(chartMax / 2)}</span>
                          <span>0 €</span>
                      </div>
                      <div className="relative flex-1 flex items-end justify-between gap-2 md:gap-4 border-b border-l border-border px-1">
                          {chartMax <= 0 && (
                              <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center px-4">
                                  <p className="text-sm font-bold text-foreground">Keine bezahlten Rechnungen</p>
                                  <p className="text-xs text-muted">In diesem Zeitraum ist keine bezahlte Rechnung enthalten. Wähle einen größeren Zeitraum oder markiere Rechnungen als bezahlt.</p>
                                  <button
                                      type="button"
                                      onClick={() => setTimeRange('all')}
                                      className="mt-1 px-4 py-2 rounded-full text-xs font-bold bg-surface-muted text-foreground hover:bg-border motion-safe:transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                                  >
                                      Gesamten Zeitraum anzeigen
                                  </button>
                              </div>
                          )}
                          {chartData.map((d, i) => (
                              <div key={i} className="group relative h-full flex-1 flex flex-col justify-end">
                                  <div
                                    className="w-full bg-foreground rounded-t-sm relative min-h-[2px]"
                                    style={{ height: `${d.height}%` }}
                                  >
                                      {/* Value on hover, the axis carries the scale. */}
                                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-dark-base text-background text-xs font-bold py-1 px-2 rounded-sm opacity-0 group-hover:opacity-100 motion-safe:transition-opacity motion-reduce:transition-none pointer-events-none whitespace-nowrap z-[var(--z-dropdown)] tabular-nums">
                                          {formatCurrency(d.value)}
                                      </div>
                                  </div>
                              </div>
                          ))}
                      </div>
                  </div>
                  <div className="flex gap-3 mt-2">
                      <div className="w-20 shrink-0" />
                      <div className="flex-1 flex items-end justify-between gap-2 md:gap-4 px-1">
                          {chartData.map((d, i) => (
                              <span key={i} className="flex-1 text-center text-xs font-bold text-muted uppercase">{d.label}</span>
                          ))}
                      </div>
                  </div>
              </div>
          </div>

          {/* Top Customers List */}
          <div className="bg-surface rounded-xl p-8 border border-border flex flex-col">
              <h3 className="font-bold text-xl mb-6">Kunden mit dem höchsten Umsatz</h3>
              <div className="flex-1 overflow-y-auto pr-2 space-y-4">
                  {topClients.map((client, idx) => (
                      <div key={`${client.name}:${idx}`} className="flex items-center gap-4">
                          <div className={`w-10 h-10 rounded-md flex items-center justify-center text-xs font-bold ${idx === 0 ? 'bg-accent text-accent-foreground' : 'bg-surface-muted text-muted'}`}>
                              {idx + 1}
                          </div>
                          <div className="flex-1">
                              <div className="flex justify-between items-center mb-1">
                                  <span className="font-bold text-sm text-foreground">{client.name}</span>
                                  <span className="font-bold text-sm tabular-nums">{formatCurrency(client.amount)}</span>
                              </div>
                              <div className="w-full bg-surface-muted h-1.5 rounded-full overflow-hidden">
                                  <div
                                    className="bg-dark-base h-full rounded-full"
                                    style={{ width: `${kpis.revenue > 0 ? Math.min(100, (client.amount / kpis.revenue) * 100) : 0}%` }}
                                  ></div>
                              </div>
                          </div>
                      </div>
                  ))}

                  {topClients.length === 0 && (
                      <EmptyState
                          title="Keine bezahlten Rechnungen in diesem Zeitraum"
                          description="Wähle einen größeren Zeitraum oder markiere Rechnungen als bezahlt."
                          action={(
                            <button
                              type="button"
                              onClick={() => setTimeRange('all')}
                              className="px-4 py-2 rounded-full text-xs font-bold bg-surface-muted text-foreground hover:bg-border motion-safe:transition-colors motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                            >
                              Gesamten Zeitraum anzeigen
                            </button>
                          )}
                      />
                  )}
              </div>

              <div className="mt-6 pt-6 border-t border-border">
                   <button
                       type="button"
                       onClick={() => navigate({ to: '/clients' })}
                       className="w-full py-3 bg-surface-muted rounded-md text-xs font-bold hover:bg-dark-base hover:text-background motion-safe:transition-colors motion-reduce:transition-none flex items-center justify-center gap-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                   >
                       Alle Kunden ansehen <ArrowUpRight size={14} aria-hidden="true" />
                   </button>
              </div>
          </div>

      </div>
    </div>
  );
};
