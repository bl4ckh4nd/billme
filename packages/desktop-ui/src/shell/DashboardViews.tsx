import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
    TrendingUp, TrendingDown, Plus, AlertTriangle, ArrowDownLeft, Clock, Landmark, MoreVertical, ReceiptText,
    ArrowUpRight, Settings2
} from 'lucide-react';
import {
  Avatar, Badge, BarChart, Button, CardHeader, Donut, EmptyState, ErrorState, HatchedProgress, IconButton, ListRow, Menu, Metric,
  PageHeader, SegmentedControl, cn, popoverExitClass, useActionFeedback, useAnchoredPosition, useExitTransition, Sparkline,
} from '@billme/ui';
import type { AppSettings, DocumentTemplate, Invoice, InvoiceElement } from '@billme/desktop-core/types';
import { useInvoicesQuery } from '@billme/desktop-renderer/hooks/useInvoices';
import { useArticlesQuery } from '@billme/desktop-renderer/hooks/useArticles';
import { useSettingsQuery, useSetSettingsMutation } from '@billme/desktop-renderer/hooks/useSettings';
import { useOffersQuery } from '@billme/desktop-renderer/hooks/useOffers';
import {
  useActiveTemplateQuery,
  useSetActiveTemplateMutation,
  useTemplatesQuery,
  useUpsertTemplateMutation,
} from '@billme/desktop-renderer/hooks/useTemplates';
import { INITIAL_INVOICE_TEMPLATE, INITIAL_OFFER_TEMPLATE } from '@billme/desktop-core/constants';
import { v4 as uuidv4 } from 'uuid';
import { calculateInvoiceTaxSnapshot, resolveInvoiceTaxMode } from '@billme/server-core/services';
import { estimateMonthVat } from './vatEstimate';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { useDashboardFlows } from './dashboardFlows';

const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
};

const formatDate = (dateString: string) => {
  return new Date(dateString).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

// --- Dashboard Settings Popover (portal to body with fixed positioning) ---
const DashboardSettingsPopover: React.FC<{
  children: React.ReactNode;
  onSave: (values: Record<string, number>) => void;
  fields: Array<{ key: string; label: string; min?: number; max?: number; step?: number }>;
  values: Record<string, number>;
  dark?: boolean;
}> = ({ onSave, fields, values, dark }) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(values);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPosition(buttonRef, dropdownRef, open, { align: 'end', offset: 8 });
  const panel = useExitTransition(open);

  // Sync draft when opening
  useEffect(() => {
    if (open) setDraft(values);
  }, [open, values]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (buttonRef.current?.contains(target) || dropdownRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label="Dashboard-Kennzahlen anpassen"
        title="Kennzahlen anpassen"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className={`ui-press inline-flex size-8 items-center justify-center rounded-control transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 ${dark ? 'text-inverse-muted hover:bg-surface-inverse-overlay hover:text-inverse-foreground focus-visible:outline-focus-ring-dark' : 'text-muted hover:bg-surface-sunken hover:text-foreground focus-visible:outline-focus-ring'}`}
      >
        <Settings2 size={14} />
      </button>
      {panel.mounted && createPortal(
        <div
          ref={dropdownRef}
          style={pos.style}
          className={cn(
            'ui-enter-popover z-[var(--z-dropdown)] bg-surface text-foreground rounded-panel shadow-md p-4 min-w-[260px]',
            panel.closing && popoverExitClass,
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="space-y-3">
            {fields.map((f) => (
              <div key={f.key}>
                <label className="block mb-1 text-label text-foreground" htmlFor={`dashboardviews-field-${f.key}`}>{f.label}</label>
                <input id={`dashboardviews-field-${f.key}`}
                  type="number"
                  min={f.min ?? 1}
                  max={f.max}
                  step={f.step ?? 1}
                  value={draft[f.key] ?? 0}
                  onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })}
                  className="px-2.5 h-8 hover:border-control-border-hover w-full bg-surface border border-control-border rounded-control text-sm tabular-nums text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                />
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => { onSave(draft); setOpen(false); }}
            className="mt-3 w-full py-2 bg-dark-base text-inverse-foreground rounded-md text-xs font-semibold hover:bg-dark-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            Speichern
          </button>
        </div>,
        document.body,
      )}
    </>
  );
};

interface ViewProps {
  onNavigate: (page: string, search?: Record<string, string>) => void;
}

export const DashboardHome: React.FC<ViewProps> = ({ onNavigate }) => {
  const settingsQuery = useSettingsQuery();

  if (settingsQuery.isError) {
    return (
      <ErrorState
        title="Übersicht konnte nicht geladen werden"
        description="Die Einstellungen deines Arbeitsbereichs sind nicht verfügbar. Ohne sie lassen sich Umsatz, Fälligkeiten und Steuerschätzung nicht berechnen."
        onRetry={() => void settingsQuery.refetch()}
      />
    );
  }

  if (!settingsQuery.data) {
    return <SkeletonLoader variant="card" count={4} />;
  }

  return <DashboardHomeContent onNavigate={onNavigate} settings={settingsQuery.data} />;
};

const DashboardHomeContent: React.FC<ViewProps & { settings: AppSettings }> = ({ onNavigate, settings }) => {
  const invoicesQuery = useInvoicesQuery();
  const { data: invoices = [] } = invoicesQuery;
  const { data: offers = [] } = useOffersQuery();
  const { data: articles = [] } = useArticlesQuery();
  const setSettingsMutation = useSetSettingsMutation();
  const dash = settings.dashboard;
  const profitDetermination = settings.businessReportingProfile?.profitDetermination;
  const flowsQuery = useDashboardFlows(profitDetermination);
  const flows = flowsQuery.data;
  const [chartRange, setChartRange] = useState<'6' | '12'>('12');
  const [chartAsTable, setChartAsTable] = useState(false);

  const saveDashboardSettings = useCallback((patch: Partial<AppSettings['dashboard']>) => {
    setSettingsMutation.mutate({ ...settings, dashboard: { ...dash, ...patch } });
  }, [settings, dash, setSettingsMutation]);

  const taxMethod = settings.legal.taxAccountingMethod ?? 'soll';

  const kpis = useMemo(() => {
    const snapshotFor = (inv: Invoice) =>
      inv.taxSnapshot ??
      calculateInvoiceTaxSnapshot(
        {
          items: inv.items ?? [],
          taxMode: resolveInvoiceTaxMode(inv.taxMode, settings),
          taxMeta: inv.taxMeta,
        },
        settings,
      );

    const amountFor = (inv: Invoice) => {
      const stored = Number(inv.amount);
      if (Number.isFinite(stored)) return stored;
      return snapshotFor(inv).grossAmount;
    };

    const outstanding = invoices.filter((i) => i.status === 'open' || i.status === 'overdue');
    const overdue = outstanding.filter((i) => i.status === 'overdue');

    const outstandingTotal = outstanding.reduce((acc, inv) => acc + amountFor(inv), 0);
    const overdueTotal = overdue.reduce((acc, inv) => acc + amountFor(inv), 0);

    const now = new Date();
    const dueSoon = outstanding.filter((inv) => {
      if (!inv.dueDate) return false;
      const due = new Date(inv.dueDate);
      if (Number.isNaN(due.getTime())) return false;
      const days = (due.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      return days >= 0 && days <= dash.dueSoonDays;
    });
    const dueSoonTotal = dueSoon.reduce((acc, inv) => acc + amountFor(inv), 0);

    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const monthIssued = invoices
      .filter((inv) => inv.status !== 'draft')
      .filter((inv) => {
        const d = new Date(inv.date);
        return d.getFullYear() === currentYear && d.getMonth() === currentMonth;
      });
    const netOf = (inv: (typeof invoices)[number]) => (inv.items ?? []).reduce((s, it) => s + (Number(it.total) || 0), 0);
    const monthRevenueNet = monthIssued.reduce((acc, inv) => acc + netOf(inv), 0);
    // The same measure for the five months before, oldest first, for the trend line.
    const revenueTrend = Array.from({ length: 6 }, (_, index) => {
      const month = new Date(currentYear, currentMonth - 5 + index, 1);
      return invoices
        .filter((inv) => inv.status !== 'draft')
        .filter((inv) => {
          const d = new Date(inv.date);
          return d.getFullYear() === month.getFullYear() && d.getMonth() === month.getMonth();
        })
        .reduce((acc, inv) => acc + netOf(inv), 0);
    });

    return {
      outstandingTotal,
      overdueCount: overdue.length,
      overdueTotal,
      dueSoonCount: dueSoon.length,
      dueSoonTotal,
      monthRevenueNet,
      monthIssuedCount: monthIssued.length,
      revenueTrend,
    };
  }, [invoices, settings, dash.dueSoonDays]);

  const topCategories = useMemo(() => {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();

    const paidThisMonth = invoices
      .filter((inv) => inv.status === 'paid')
      .filter((inv) => {
        const d = new Date(inv.date);
        return d.getFullYear() === currentYear && d.getMonth() === currentMonth;
      });

    const byTitle = new Map<string, { category: string }>();
    for (const a of articles) {
      if (a.title) byTitle.set(a.title.trim(), { category: a.category });
    }

    const bucket = new Map<string, { amount: number; invoiceIds: Set<string> }>();

    const fallback = (settings?.catalog?.categories?.[0]?.name ?? 'Sonstiges').trim() || 'Sonstiges';

    for (const inv of paidThisMonth) {
      for (const item of inv.items ?? []) {
        const key = (item.description ?? '').trim();
        const match = byTitle.get(key);
        const category = (item.category ?? match?.category ?? fallback).trim() || fallback;
        const entry = bucket.get(category) ?? { amount: 0, invoiceIds: new Set<string>() };
        entry.amount += Number(item.total ?? 0);
        entry.invoiceIds.add(inv.id);
        bucket.set(category, entry);
      }
    }

    const list = Array.from(bucket.entries()).map(([category, data]) => ({
      category,
      amount: data.amount,
      invoiceCount: data.invoiceIds.size,
    }));

    list.sort((a, b) => b.amount - a.amount);
    return list.slice(0, dash.topCategoriesLimit);
  }, [invoices, articles, settings, dash.topCategoriesLimit]);

  const payments = useMemo(() => {
    const rows: Array<{
      invoiceId: string;
      invoiceNumber: string;
      client: string;
      date: string;
      amount: number;
      method: string;
    }> = [];

    for (const inv of invoices) {
      for (const p of inv.payments ?? []) {
        rows.push({
          invoiceId: inv.id,
          invoiceNumber: inv.number,
          client: inv.client,
          date: p.date,
          amount: Number(p.amount) || 0,
          method: p.method,
        });
      }
    }

    rows.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
    return rows;
  }, [invoices]);

  const paymentsThisMonth = useMemo(() => {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    return payments.filter((p) => {
      const d = new Date(p.date);
      return d.getFullYear() === y && d.getMonth() === m;
    });
  }, [payments]);

  const paymentsThisMonthGross = useMemo(
    () => paymentsThisMonth.reduce((acc, p) => acc + (Number(p.amount) || 0), 0),
    [paymentsThisMonth],
  );

  const paymentsLastMonthGross = useMemo(() => {
    const now = new Date();
    const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const y = lastMonth.getFullYear();
    const m = lastMonth.getMonth();
    return payments
      .filter((p) => {
        const d = new Date(p.date);
        return d.getFullYear() === y && d.getMonth() === m;
      })
      .reduce((acc, p) => acc + (Number(p.amount) || 0), 0);
  }, [payments]);

  const paymentTrend = useMemo(() => {
    if (paymentsLastMonthGross <= 0) return null;
    const change = ((paymentsThisMonthGross - paymentsLastMonthGross) / paymentsLastMonthGross) * 100;
    return Math.round(change);
  }, [paymentsThisMonthGross, paymentsLastMonthGross]);

  const offerPipeline = useMemo(() => {
    const published = offers.filter((o) => Boolean(o.sharePublishedAt || o.shareToken));
    const declined = published.filter((o) => o.shareDecision === 'declined');
    const accepted = published.filter((o) => o.shareDecision === 'accepted');
    const active = published.filter((o) => o.shareDecision !== 'declined');

    const potentialNet = active.reduce(
      (acc, o) => acc + (o.items ?? []).reduce((s, it) => s + (Number(it.total) || 0), 0),
      0,
    );

    return {
      publishedCount: published.length,
      activeCount: active.length,
      acceptedCount: accepted.length,
      declinedCount: declined.length,
      potentialNet,
    };
  }, [offers]);

  const taxEstimate = useMemo(() => {
    const now = new Date();
    return estimateMonthVat(invoices, settings, taxMethod, now.getFullYear(), now.getMonth());
  }, [invoices, settings, taxMethod]);

  const nowMonthLabel = new Date().toLocaleDateString('de-DE', { month: 'long' });
  const currentFlow = flows?.months[flows.months.length - 1];
  const monthResult = currentFlow ? currentFlow.income - currentFlow.expense : null;
  const taxDueDays = Math.ceil((new Date(new Date().getFullYear(), new Date().getMonth() + 1, 10).getTime() - Date.now()) / 86_400_000);
  const shownMonths = flows ? flows.months.slice(chartRange === '6' ? -6 : -12) : [];
  const incomeAverage = shownMonths.length > 0 ? shownMonths.reduce((sum, month) => sum + month.income, 0) / shownMonths.length : 0;
  const donutSegments = useMemo(() => {
    const lines = flows?.expenseBreakdown ?? [];
    const top = lines.slice(0, 4).map((line) => ({ key: line.key, label: line.label, value: line.value, formatted: formatCurrency(line.value) }));
    const rest = lines.slice(4).reduce((sum, line) => sum + line.value, 0);
    return rest > 0 ? [...top, { key: 'rest', label: flows?.breakdownBasis === 'eur-line' ? 'Übrige Kostenarten' : 'Übrige Empfänger', value: rest, formatted: formatCurrency(rest) }] : top;
  }, [flows]);
  const expenseTotal = (flows?.expenseBreakdown ?? []).reduce((sum, line) => sum + line.value, 0);
  const goalShare = dash.monthlyRevenueGoal > 0 ? kpis.monthRevenueNet / dash.monthlyRevenueGoal : 0;

  const tasks = [
    { key: 'overdue', count: kpis.overdueCount, title: 'Überfällige Rechnungen mahnen', subtitle: `${formatCurrency(kpis.overdueTotal)} seit Fälligkeit offen`, tone: 'error' as const, icon: <AlertTriangle size={16} />, go: () => onNavigate('documents', { kind: 'invoice', status: 'overdue' }) },
    { key: 'unclassified', count: flows?.unclassifiedCount ?? 0, title: 'Kontoumsätze der EÜR zuordnen', subtitle: 'Abgerufen, aber noch keiner EÜR-Zeile zugeordnet', tone: 'info' as const, icon: <ReceiptText size={16} />, go: () => onNavigate('eur') },
    { key: 'open', count: flows?.openTransactionCount ?? 0, title: 'Zahlungseingänge abgleichen', subtitle: 'Eingänge auf dem Konto ohne zugeordnete Rechnung', tone: 'info' as const, icon: <Landmark size={16} />, go: () => onNavigate('accounts') },
    { key: 'due', count: kpis.dueSoonCount, title: `Fällig in ${dash.dueSoonDays} Tagen`, subtitle: `${formatCurrency(kpis.dueSoonTotal)} erwartete Eingänge`, tone: 'warning' as const, icon: <Clock size={16} />, go: () => onNavigate('documents', { kind: 'invoice', status: 'open' }) },
  ].filter((task) => task.count > 0);

  if (invoicesQuery.isError) {
    return (
      <ErrorState
        title="Rechnungen konnten nicht geladen werden"
        description="Ohne die Rechnungsliste lassen sich offene Forderungen und Steuerschätzung nicht berechnen."
        onRetry={() => void invoicesQuery.refetch()}
      />
    );
  }

  if (invoicesQuery.isPending) {
    return <SkeletonLoader variant="card" count={4} />;
  }

  return (
    <div className="pb-4">
      <PageHeader
        title="Übersicht"
        description={new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
        className="px-1 pt-2"
      />

      {/* KPI row: the tick carries state, the label carries meaning. */}
      <section aria-label="Kennzahlen" className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-panel bg-surface p-4 shadow-xs">
          <Metric
            marker="tick"
            label="Liquidität"
            value={flows?.liquidity == null ? '–' : formatCurrency(flows.liquidity)}
            hint={flowsQuery.isError ? 'Konten nicht erreichbar' : !flows ? 'Wird geladen' : flows.liquidity == null ? 'Noch kein Konto angelegt' : flows.accountCount === 1 ? 'Bestand des Kontos' : `Bestand aller ${flows.accountCount} Konten`}
            tone={flows?.liquidity != null && flows.liquidity < 0 ? 'error' : 'neutral'}
          />
        </div>
        <div className="rounded-panel bg-surface p-4 shadow-xs">
          <Metric
            marker="tick"
            label="Offene Forderungen"
            value={formatCurrency(kpis.outstandingTotal)}
            hint={kpis.overdueCount > 0 ? `${formatCurrency(kpis.overdueTotal)} überfällig` : 'Nichts überfällig'}
            tone={kpis.overdueCount > 0 ? 'error' : 'neutral'}
          />
        </div>
        <div className="rounded-panel bg-surface p-4 shadow-xs">
          <Metric
            marker="tick"
            label={`Kontobewegung ${nowMonthLabel}`}
            value={monthResult == null ? '–' : formatCurrency(monthResult)}
            hint="Kontoeingänge minus Kontoausgänge, brutto"
            tone={monthResult == null || monthResult === 0 ? 'neutral' : monthResult > 0 ? 'success' : 'error'}
          />
        </div>
        <div className="rounded-panel bg-surface p-4 shadow-xs">
          <Metric
            marker="tick"
            label="Umsatzsteuer"
            value={formatCurrency(taxEstimate.vat)}
            hint={taxEstimate.vat > 0 ? `fällig am ${taxEstimate.dueLabel}, in ${taxDueDays} Tagen` : `Keine Zahllast für ${taxEstimate.periodLabel}`}
            tone={taxEstimate.vat > 0 && taxDueDays <= 7 ? 'warning' : 'neutral'}
          />
        </div>
      </section>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">

      {/* Income against expense, twelve months. */}
      <section aria-labelledby="dashboard-flows" className="lg:col-span-8 flex flex-col rounded-panel bg-surface p-5 shadow-xs">
        <CardHeader
          title={<span id="dashboard-flows">Einnahmen und Ausgaben</span>}
          subtitle="Brutto nach Buchungstag, aus den Kontoumsätzen"
          actions={
            <>
              <SegmentedControl
                size="sm"
                aria-label="Zeitraum"
                value={chartRange}
                onChange={setChartRange}
                options={[{ value: '6', label: '6 Monate' }, { value: '12', label: '12 Monate' }]}
              />
              <Menu
                aria-label="Aktionen Einnahmen und Ausgaben"
                align="end"
                items={[
                  { id: 'table', label: chartAsTable ? 'Als Diagramm anzeigen' : 'Als Tabelle anzeigen', onSelect: () => setChartAsTable((value) => !value) },
                  { id: 'go', label: 'Zu den Kontoumsätzen', onSelect: () => onNavigate('accounts') },
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
        <div className="mt-4">
          {flowsQuery.isError ? (
            <ErrorState
              title="Zahlungsdaten konnten nicht geladen werden"
              description="Konten und Kontoumsätze sind gerade nicht erreichbar. Die übrigen Karten rechnen aus den Rechnungen."
              onRetry={() => void flowsQuery.refetch()}
            />
          ) : flowsQuery.isPending ? (
            <SkeletonLoader variant="card" count={1} />
          ) : shownMonths.every((month) => month.income === 0 && month.expense === 0) ? (
            <EmptyState title="Noch keine Zahlungen" description="Sobald Kontoumsätze importiert oder Zahlungen erfasst sind, erscheinen sie hier nach Monat." className="py-8" />
          ) : chartAsTable ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-caption text-muted">
                  <th className="py-2 font-medium">Monat</th>
                  <th className="py-2 text-right font-medium">Einnahmen</th>
                  <th className="py-2 text-right font-medium">Ausgaben</th>
                  <th className="py-2 text-right font-medium">Ergebnis</th>
                </tr>
              </thead>
              <tbody>
                {shownMonths.map((month) => (
                  <tr key={month.key} className="border-b border-border-subtle last:border-0">
                    <td className="py-2">{month.longLabel}</td>
                    <td className="py-2 text-right tabular-nums">{formatCurrency(month.income)}</td>
                    <td className="py-2 text-right tabular-nums">{formatCurrency(month.expense)}</td>
                    <td className={cn('py-2 text-right font-medium tabular-nums', month.income - month.expense < 0 && 'text-error-text')}>{formatCurrency(month.income - month.expense)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <BarChart
              aria-label="Einnahmen und Ausgaben je Monat"
              valueHeader="Einnahmen"
              compareHeader="Ausgaben"
              reference={{ value: incomeAverage, label: `Ø Einnahmen ${formatCurrency(incomeAverage)}` }}
              formatValue={formatCurrency}
              formatAxis={(value) => (value >= 1000 ? `${(value / 1000).toLocaleString('de-DE', { maximumFractionDigits: 1 })}k` : String(Math.round(value)))}
              data={shownMonths.map((month, index) => ({
                key: month.key,
                label: month.label,
                longLabel: month.longLabel,
                value: month.income,
                compare: month.expense,
                highlight: index === shownMonths.length - 1,
              }))}
            />
          )}
        </div>
      </section>

      {/* Expense structure */}
      <section aria-labelledby="dashboard-expenses" className="lg:col-span-4 flex flex-col rounded-panel bg-surface p-5 shadow-xs">
        <CardHeader
          title={<span id="dashboard-expenses">Aufwandsstruktur</span>}
          subtitle={flows?.breakdownBasis === 'eur-line' ? 'Ausgaben der letzten zwölf Monate nach EÜR-Zeile' : 'Ausgaben der letzten zwölf Monate nach Empfänger'}
          count={donutSegments.length > 0 ? `${flows?.expenseBreakdown.length ?? 0} ${flows?.breakdownBasis === 'eur-line' ? 'Kostenarten' : 'Empfänger'}` : undefined}
        />
        <div className="mt-4">
          {donutSegments.length === 0 ? (
            <EmptyState title="Noch keine Ausgaben" description="Ausgaben erscheinen hier, sobald Kontoumsätze importiert sind." className="py-8" />
          ) : (
            <Donut label={flows?.breakdownBasis === 'eur-line' ? 'Ausgaben nach Kostenart' : 'Ausgaben nach Empfänger'} segments={donutSegments} total={formatCurrency(expenseTotal)} />
          )}
        </div>
      </section>

      {/* What needs doing, ordered by consequence. */}
      <section aria-labelledby="dashboard-tasks" className="lg:col-span-7 flex flex-col rounded-panel bg-surface p-5 shadow-xs">
        <CardHeader
          title={<span id="dashboard-tasks">Was jetzt ansteht</span>}
          subtitle="Reihenfolge nach Fristwirkung"
          count={tasks.length > 0 ? `${tasks.reduce((sum, task) => sum + task.count, 0)} Vorgänge` : undefined}
        />
        <div className="mt-2">
          {tasks.length === 0 ? (
            <EmptyState title="Keine offenen Vorgänge" description="Nichts ist überfällig und jeder Kontoumsatz ist zugeordnet." className="py-8" />
          ) : (
            tasks.map((task) => (
              <ListRow key={task.key} icon={task.icon} tone={task.tone} title={task.title} subtitle={task.subtitle} value={task.count} onClick={task.go} />
            ))
          )}
        </div>
      </section>

      {/* Focal card: the one inverse surface on this view (DESIGN.md contrast budget). */}
      <section aria-labelledby="dashboard-receivables" className="lg:col-span-5 flex flex-col rounded-panel bg-surface-inverse p-6 text-inverse-foreground">
         <div className="flex items-center justify-between gap-3">
             <h2 id="dashboard-receivables" className="text-label text-inverse-muted">Offene Forderungen</h2>
             <div className="flex items-center gap-1">
                 <DashboardSettingsPopover
                   dark
                   fields={[{ key: 'dueSoonDays', label: 'Fällig in X Tagen', min: 1, max: 90 }]}
                   values={{ dueSoonDays: dash.dueSoonDays }}
                   onSave={(v) => saveDashboardSettings({ dueSoonDays: v.dueSoonDays })}
                 ><span /></DashboardSettingsPopover>
                 <button type="button" onClick={() => onNavigate('documents')} className="inline-flex h-8 items-center gap-1.5 rounded-control px-2.5 text-label text-inverse-muted transition-colors hover:bg-surface-inverse-overlay hover:text-inverse-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring-dark">
                     Alle ansehen <ArrowUpRight size={14} aria-hidden="true" />
                 </button>
             </div>
         </div>

         <p className="mt-3 text-4xl font-semibold tracking-[-0.02em] tabular-nums break-words">{formatCurrency(kpis.outstandingTotal)}</p>

         <dl className="mt-6 divide-y divide-border-inverse rounded-card bg-surface-inverse-raised">
             <div className="flex items-center justify-between gap-3 px-4 py-3">
                <dt className="flex items-center gap-2 text-sm">
                    <span className="size-1.5 rounded-full bg-error-inverse" aria-hidden="true" />
                    Überfällig <span className="text-inverse-muted tabular-nums">({kpis.overdueCount})</span>
                </dt>
                <dd className="font-medium tabular-nums">{formatCurrency(kpis.overdueTotal)}</dd>
             </div>
             <div className="flex items-center justify-between gap-3 px-4 py-3">
                <dt className="flex items-center gap-2 text-sm">
                    <span className="size-1.5 rounded-full bg-inverse-muted" aria-hidden="true" />
                    Fällig in {dash.dueSoonDays} Tagen <span className="text-inverse-muted tabular-nums">({kpis.dueSoonCount})</span>
                </dt>
                <dd className="font-medium tabular-nums">{formatCurrency(kpis.dueSoonTotal)}</dd>
             </div>
         </dl>

         <div className="mt-auto flex items-end justify-between gap-4 pt-6">
            <div>
                 <p className="text-caption text-inverse-muted">Zahlungseingänge</p>
                 {paymentTrend !== null ? (
                   <p className="mt-1 flex items-center gap-1.5 text-sm">
                      <span className={`inline-flex items-center gap-0.5 font-medium tabular-nums ${paymentTrend >= 0 ? 'text-accent' : 'text-error-inverse'}`}>
                        {paymentTrend >= 0 ? <TrendingUp size={14} aria-hidden="true" /> : <TrendingDown size={14} aria-hidden="true" />}
                        {paymentTrend >= 0 ? '+' : ''}{paymentTrend}%
                      </span>
                      <span className="text-inverse-muted">zum Vormonat</span>
                   </p>
                 ) : (
                   <p className="mt-1 text-sm text-inverse-muted">Keine Vormonatsdaten</p>
                 )}
            </div>
            <Button onClick={() => onNavigate('documents', { kind: 'invoice', status: 'overdue' })}>
                Mahnung senden
            </Button>
         </div>
      </section>

      {/* Revenue this month */}
      <section aria-labelledby="dashboard-revenue" className="lg:col-span-7 flex flex-col rounded-panel bg-surface p-5 shadow-xs">
          <CardHeader
            title={<span id="dashboard-revenue">Umsatz im laufenden Monat</span>}
            subtitle={<>Netto, gestellte Rechnungen: <span className="tabular-nums">{kpis.monthIssuedCount}</span></>}
            actions={
              <DashboardSettingsPopover
                fields={[
                  { key: 'monthlyRevenueGoal', label: 'Monatsziel (€)', min: 0, step: 1000 },
                  { key: 'topCategoriesLimit', label: 'Top Kategorien (Anzahl)', min: 1, max: 20 },
                ]}
                values={{ monthlyRevenueGoal: dash.monthlyRevenueGoal, topCategoriesLimit: dash.topCategoriesLimit }}
                onSave={(v) => saveDashboardSettings({ monthlyRevenueGoal: v.monthlyRevenueGoal, topCategoriesLimit: v.topCategoriesLimit })}
              ><span /></DashboardSettingsPopover>
            }
          />

          <div className="mt-3 flex items-end justify-between gap-4">
            <p className="text-figure tabular-nums">{formatCurrency(kpis.monthRevenueNet)}</p>
            {kpis.revenueTrend.some((value) => value > 0) && (
              <Sparkline values={kpis.revenueTrend} aria-label="Netto-Umsatz der letzten 6 Monate" className="w-32" />
            )}
          </div>
          {/* The goal is a user setting. A workspace that has not set one gets no
              progress figure instead of a fabricated target. */}
          {dash.monthlyRevenueGoal > 0 && (
            <div className="mt-4">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <span className="text-xl font-bold tabular-nums">{Math.round(Math.min(1, goalShare) * 100)} %</span>
                <span className="text-caption text-muted">
                  {goalShare >= 1 ? 'Ziel erreicht' : <>noch <span className="tabular-nums">{formatCurrency(dash.monthlyRevenueGoal - kpis.monthRevenueNet)}</span> bis zum Ziel von <span className="tabular-nums">{formatCurrency(dash.monthlyRevenueGoal)}</span></>}
                </span>
              </div>
              <HatchedProgress value={goalShare} label="Umsatzziel dieses Monats" valueText={`${Math.round(Math.min(1, goalShare) * 100)} Prozent von ${formatCurrency(dash.monthlyRevenueGoal)}`} />
            </div>
          )}

          <h3 className="mt-6 text-label text-muted">Wichtigste Einnahmequellen</h3>
          {topCategories.length === 0 ? (
            <EmptyState
              title="Noch keine Umsätze in diesem Monat"
              description="Sobald eine Rechnung dieses Monats als bezahlt erfasst ist, erscheint ihre Kategorie hier."
              className="mt-2 px-3 py-6"
            />
          ) : (
            <ul className="mt-1 divide-y divide-border-subtle">
              {topCategories.map((row) => (
                <li key={row.category}>
                  <button
                    type="button"
                    onClick={() => onNavigate('articles', { query: row.category })}
                    className="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-control px-2 py-2.5 text-left transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <Avatar name={row.category} size="sm" />
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{row.category}</span>
                        <span className="text-caption text-muted tabular-nums">
                          {row.invoiceCount} {row.invoiceCount === 1 ? 'Rechnung' : 'Rechnungen'}
                        </span>
                      </span>
                    </span>
                    <span className="font-medium tabular-nums">{formatCurrency(row.amount)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-auto flex items-end justify-between gap-4 border-t border-border-subtle pt-4">
            <div>
              <p className="text-label text-muted">Offene Angebote, netto</p>
              <p className="mt-0.5 text-caption text-muted tabular-nums">
                Offen {offerPipeline.activeCount} · Angenommen {offerPipeline.acceptedCount} · Abgelehnt {offerPipeline.declinedCount}
              </p>
            </div>
            <p className="text-xl font-semibold tabular-nums">{formatCurrency(offerPipeline.potentialNet)}</p>
          </div>
      </section>

      {/* VAT estimate */}
      <section aria-labelledby="dashboard-tax" className="lg:col-span-5 flex flex-col rounded-panel bg-surface p-5 shadow-xs">
          <CardHeader
            title={<span id="dashboard-tax">Steuerschätzung</span>}
            subtitle={`Voranmeldung ${taxEstimate.periodLabel}, ${taxMethod === 'ist' ? 'Ist' : 'Soll'}-Versteuerung`}
            actions={<Badge tone={taxEstimate.vat > 0 && taxDueDays <= 7 ? 'warning' : 'info'}>{taxEstimate.vat > 0 ? `in ${taxDueDays} Tagen` : taxEstimate.periodLabel}</Badge>}
          />

          <p className="mt-3 text-label text-muted">
            {taxEstimate.vat <= 0 ? 'Keine voraussichtliche Umsatzsteuer' : 'Voraussichtliche Umsatzsteuer'}
          </p>
          <p className="mt-1 text-figure tabular-nums">{formatCurrency(taxEstimate.vat)}</p>
          {taxEstimate.vat > 0 && (
            <p className="mt-1 text-caption text-muted">Fällig am <span className="tabular-nums">{taxEstimate.dueLabel}</span></p>
          )}

          <dl className="mt-auto grid grid-cols-2 gap-4 border-t border-border-subtle pt-4">
              <div>
                  <dt className="text-caption text-muted">Netto-Basis ({taxMethod === 'ist' ? 'Ist' : 'Soll'})</dt>
                  <dd className="mt-0.5 font-medium tabular-nums">{formatCurrency(taxEstimate.net)}</dd>
              </div>
              <div>
                  <dt className="text-caption text-muted">Brutto</dt>
                  <dd className="mt-0.5 font-medium tabular-nums">{formatCurrency(taxEstimate.gross)}</dd>
              </div>
          </dl>
      </section>

      {/* Recent payments */}
      <section aria-labelledby="dashboard-payments" className="lg:col-span-12 flex flex-col rounded-panel bg-surface p-5 shadow-xs">
          <CardHeader
            title={<span id="dashboard-payments">Zahlungseingänge</span>}
            subtitle={<>Dieser Monat <span className="font-medium text-foreground tabular-nums">{formatCurrency(paymentsThisMonthGross)}</span></>}
            count={payments.length > 0 ? `${Math.min(payments.length, dash.recentPaymentsLimit)} von ${payments.length}` : undefined}
            actions={
              <>
                <DashboardSettingsPopover
                  fields={[{ key: 'recentPaymentsLimit', label: 'Angezeigte Zahlungen', min: 1, max: 20 }]}
                  values={{ recentPaymentsLimit: dash.recentPaymentsLimit }}
                  onSave={(v) => saveDashboardSettings({ recentPaymentsLimit: v.recentPaymentsLimit })}
                ><span /></DashboardSettingsPopover>
                <IconButton size="sm" aria-label="Zu den Rechnungen" onClick={() => onNavigate('documents', { kind: 'invoice', status: 'paid' })}>
                    <ArrowUpRight size={16} aria-hidden="true" />
                </IconButton>
              </>
            }
          />

          {payments.length === 0 ? (
            <EmptyState
              title="Noch keine Zahlungseingänge"
              description="Erfasste Zahlungen erscheinen hier, sobald du sie an einer Rechnung einträgst."
              className="mt-4 py-6"
            />
          ) : (
            <div className="mt-2">
              {payments.slice(0, dash.recentPaymentsLimit).map((item) => (
                <ListRow
                  key={`${item.invoiceId}:${item.date}:${item.amount}`}
                  icon={<ArrowDownLeft size={16} />}
                  tone="success"
                  title={item.client}
                  subtitle={<><span className="tabular-nums">{formatDate(item.date)}</span> · {item.invoiceNumber} · {item.method}</>}
                  value={formatCurrency(item.amount)}
                  valueTone="success"
                  onClick={() => onNavigate('documents', { kind: 'invoice', id: item.invoiceId })}
                />
              ))}
            </div>
          )}
      </section>

      </div>
    </div>
  );
};

export const TemplatesView: React.FC<{ onOpenEditor: (type: 'invoice' | 'offer') => void }> = ({ onOpenEditor }) => {
    const [activeTab, setActiveTab] = useState<'invoice' | 'offer'>('invoice');
    const { notify } = useActionFeedback('templates');
    const templatesQuery = useTemplatesQuery(activeTab);
    const { data: templates = [] } = templatesQuery;
    const { data: activeTemplate } = useActiveTemplateQuery(activeTab);
    const setActiveTemplateMutation = useSetActiveTemplateMutation();
    const upsertTemplateMutation = useUpsertTemplateMutation();

    const handleCreateNewTemplate = async () => {
        const baseElements =
            activeTemplate?.elements ??
            (activeTab === 'offer' ? INITIAL_OFFER_TEMPLATE : INITIAL_INVOICE_TEMPLATE);

        const now = new Date();
        const ts = now.toISOString();
        const template: DocumentTemplate = {
            id: uuidv4(),
            kind: activeTab,
            name:
                activeTab === 'offer'
                    ? `Angebotsvorlage ${now.toLocaleDateString('de-DE')}`
                    : `Rechnungsvorlage ${now.toLocaleDateString('de-DE')}`,
            elements: baseElements as unknown as InvoiceElement[],
            createdAt: ts,
            updatedAt: ts,
        };

        try {
            const saved = await upsertTemplateMutation.mutateAsync(template);
            await setActiveTemplateMutation.mutateAsync({ kind: activeTab, templateId: saved.id });
            onOpenEditor(activeTab);
        } catch (e) {
            notify('error', `Vorlage anlegen fehlgeschlagen: ${String(e)}`);
        }
    };

    return (
        <div className="min-h-full px-1 pt-2 flex flex-col">
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h3 className="font-semibold text-2xl text-foreground mb-1">Vorlagen</h3>
                    <p className="text-sm text-muted">Lege das Layout deiner Geschäftsdokumente fest.</p>
                </div>
                <div className="bg-surface-muted p-1 rounded-full flex items-center">
                    <button
                        type="button"
                        onClick={() => setActiveTab('invoice')}
                        className={`px-6 py-2 rounded-control text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${activeTab === 'invoice' ? 'bg-surface shadow-sm text-foreground' : 'text-muted hover:text-foreground'}`}
                    >
                        Rechnungen
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveTab('offer')}
                        className={`px-6 py-2 rounded-control text-xs font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${activeTab === 'offer' ? 'bg-surface shadow-sm text-foreground' : 'text-muted hover:text-foreground'}`}
                    >
                        Angebote
                    </button>
                </div>
            </div>
      <div className="min-h-0 flex-1 rounded-card border border-border bg-surface p-5 lg:p-6">

            {templatesQuery.isError ? (
                <ErrorState
                    title="Vorlagen konnten nicht geladen werden"
                    description="Die Liste der Vorlagen ist nicht verfügbar. Bereits gespeicherte Vorlagen sind nicht verloren."
                    onRetry={() => void templatesQuery.refetch()}
                />
            ) : templatesQuery.isPending ? (
                <SkeletonLoader variant="card" count={4} />
            ) : templates.length === 0 ? (
                <EmptyState
                    title="Noch keine eigenen Vorlagen"
                    description="Du arbeitest mit den mitgelieferten Standardlayouts. Lege eine eigene Vorlage an, um das Layout deiner Dokumente anzupassen."
                    action={(
                        <button
                            type="button"
                            onClick={() => void handleCreateNewTemplate()}
                            className="px-4 py-2 rounded-control text-xs font-semibold bg-dark-base text-inverse-foreground hover:bg-surface-inverse-raised transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                        >
                            Neue Vorlage anlegen
                        </button>
                    )}
                />
            ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                {/* Create New Card */}
                <button
                    type="button"
                    onClick={() => void handleCreateNewTemplate()}
                    className="aspect-[3/4] bg-surface-muted rounded-xl border-2 border-dashed border-control-border flex flex-col items-center justify-center gap-4 hover:border-foreground hover:bg-surface transition-colors group focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                >
                    <div className="w-16 h-16 bg-surface border border-border rounded-full flex items-center justify-center">
                        <Plus size={24} className="text-muted group-hover:text-foreground" aria-hidden="true" />
                    </div>
                    <span className="font-semibold text-muted group-hover:text-foreground text-center px-4">
                        Neue {activeTab === 'invoice' ? 'Rechnungsvorlage' : 'Angebotsvorlage'}
                    </span>
                </button>

                {/* Templates */}
                {templates.map((t) => (
                <div
                    key={t.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Vorlage ${t.name} bearbeiten`}
                    className="aspect-[3/4] bg-surface rounded-xl border border-border p-4 flex flex-col hover:border-control-border transition-colors cursor-pointer group relative overflow-hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    onClick={() => onOpenEditor(activeTab)}
                    onKeyDown={(e) => {
                        if (e.target !== e.currentTarget) return;
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onOpenEditor(activeTab);
                        }
                    }}
                >
                    <div className="flex-1 bg-surface-muted rounded-md mb-4 relative overflow-hidden flex flex-col p-4 gap-2 border border-border">
                         {/* Mini preview abstraction */}
                         <div className="w-1/3 h-2 bg-border rounded-full self-end"></div>
                         <div className="w-1/2 h-2 bg-border rounded-full mt-4"></div>
                         <div className="w-full h-1 bg-border-subtle rounded-full mt-2"></div>
                         <div className="w-full h-1 bg-border-subtle rounded-full"></div>

                         <div className="mt-auto bg-surface border border-border p-2 rounded-sm">
                             <div className="w-full h-1 bg-border-subtle rounded-full mb-1"></div>
                             <div className="flex justify-between">
                                 <div className="w-1/4 h-1 bg-border-subtle rounded-full"></div>
                                 <div className="w-1/4 h-1 bg-border rounded-full"></div>
                             </div>
                         </div>
                    </div>
                    <h4 className="font-semibold text-lg text-foreground">{t.name}</h4>
                    <p className="text-xs text-muted">A4 • {t.id === activeTemplate?.id ? 'Aktiv' : 'Vorlage'}</p>

                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            void setActiveTemplateMutation.mutateAsync({ kind: activeTab, templateId: t.id });
                        }}
                        className={`absolute top-4 left-4 px-3 py-1 rounded-control text-xs font-semibold uppercase border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
                            t.id === activeTemplate?.id
                                ? 'bg-accent text-accent-foreground border-accent'
                                : 'bg-surface text-muted border-control-border hover:bg-surface-muted'
                        }`}
                    >
                        {t.id === activeTemplate?.id ? 'Aktiv' : 'Aktivieren'}
                    </button>

                    <button
                        type="button"
                        aria-label={`Vorlage ${t.name} öffnen`}
                        onClick={(e) => { e.stopPropagation(); onOpenEditor(activeTab); }}
                        className="inline-flex size-8 shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-sunken hover:text-foreground absolute bottom-4 right-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                    >
                        <ArrowUpRight size={16} aria-hidden="true" />
                    </button>
                </div>
                ))}
            </div>
            )}
        </div>
    </div>
    );
}
