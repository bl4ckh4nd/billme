import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
    TrendingUp, TrendingDown, AlertTriangle, ArrowDownLeft, Clock, Landmark, MoreVertical, ReceiptText,
    ArrowUpRight, Settings2
} from 'lucide-react';
import {
  Badge, BarChart, Button, Card, CardHeader, Donut, EmptyState, ErrorState, HatchedProgress, IconButton, Input, ListRow, Menu, Metric,
  PageHeader, SegmentedControl, Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
  cn, initialsOf, popoverExitClass, useAnchoredPosition, useExitTransition, Sparkline,
} from '@billme/ui';
import type { AppSettings, Invoice } from '@billme/desktop-core/types';
import { useInvoicesQuery } from '../../hooks/useInvoices';
import { useArticlesQuery } from '../../hooks/useArticles';
import { useSettingsQuery, useSetSettingsMutation } from '../../hooks/useSettings';
import { useOffersQuery } from '../../hooks/useOffers';
import { calculateInvoiceTaxSnapshot, isCorrectionDocumentKind, isReceivableDocumentKind, resolveInvoiceTaxMode } from '@billme/server-core/services';
import { estimateMonthVat } from './vatEstimate';
import { getRendererProduct } from '../../runtime-api';
import { useLiteVatReport, vatMonthPeriod } from '../../components/eur/LiteVatPanel';
import { SkeletonLoader } from '../components/SkeletonLoader';
import { useDashboardFlows, useMonthResult } from './dashboardFlows';

const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
};

/** Legend and ring centre: thousands as "Tsd.", millions as "Mio."; the exact sum stays in the card subtitle and the table view. */
const formatCompact = (amount: number) => {
  const abs = Math.abs(amount);
  const num = (value: number, digits: number) => value.toLocaleString('de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  if (abs >= 1_000_000) return `${num(amount / 1_000_000, 1)} Mio.`;
  if (abs >= 1000) return `${num(amount / 1000, 0)} Tsd.`;
  return num(amount, 0);
};

const percent = new Intl.NumberFormat('de-DE', { style: 'percent', maximumFractionDigits: 1 });

const insetPanel = 'rounded-card border border-border bg-surface-muted p-3.5';
const twoColumns = 'grid grid-cols-1 items-start gap-3.5 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]';

const formatDate = (dateString: string) => {
  return new Date(dateString).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

/** Whole days from local `today` to a date-only string, read as local midnight; NaN when missing. */
const daysUntil = (dateString: string | undefined, today: Date) =>
  dateString ? Math.round((new Date(`${dateString.slice(0, 10)}T00:00:00`).getTime() - today.getTime()) / 86_400_000) : Number.NaN;

// --- Dashboard Settings Popover (portal to body with fixed positioning) ---
const DashboardSettingsPopover: React.FC<{
  children: React.ReactNode;
  onSave: (values: Record<string, number>) => void;
  fields: Array<{ key: string; label: string; min?: number; max?: number; step?: number }>;
  values: Record<string, number>;
}> = ({ onSave, fields, values }) => {
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
      <IconButton
        ref={buttonRef}
        size="sm"
        aria-label="Dashboard-Kennzahlen anpassen"
        tooltip="Kennzahlen anpassen"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
      >
        <Settings2 size={16} aria-hidden="true" />
      </IconButton>
      {panel.mounted && createPortal(
        <div
          ref={dropdownRef}
          style={pos.style}
          className={cn(
            'ui-enter-popover z-[var(--z-dropdown)] min-w-65 rounded-card border border-border bg-surface p-3.5 text-foreground shadow-lift',
            panel.closing && popoverExitClass,
          )}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="space-y-3">
            {fields.map((f) => (
              <Input
                key={f.key}
                id={`dashboardviews-field-${f.key}`}
                label={f.label}
                type="number"
                min={f.min ?? 1}
                max={f.max}
                step={f.step ?? 1}
                value={draft[f.key] ?? 0}
                onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })}
                className="tabular-nums"
                fullWidth
              />
            ))}
          </div>
          <Button size="sm" className="mt-3 w-full" onClick={() => { onSave(draft); setOpen(false); }}>
            Speichern
          </Button>
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
  const isLite = getRendererProduct() === 'lite';
  const nowForVat = new Date();
  const vatQuery = useLiteVatReport(vatMonthPeriod(nowForVat.getFullYear(), nowForVat.getMonth()), isLite && settings.onboardingCompleted === true);
  const invoicesQuery = useInvoicesQuery();
  const { data: invoices = [] } = invoicesQuery;
  const { data: offers = [] } = useOffersQuery();
  const { data: articles = [] } = useArticlesQuery();
  const setSettingsMutation = useSetSettingsMutation();
  const dash = settings.dashboard;
  const profitDetermination = settings.onboardingCompleted ? settings.businessReportingProfile?.profitDetermination : undefined;
  const flowsQuery = useDashboardFlows(profitDetermination);
  const flows = flowsQuery.data;
  const monthResultQuery = useMonthResult(profitDetermination, settings.businessReportingProfile?.chart);
  const monthResult = monthResultQuery.isError ? undefined : monthResultQuery.data;
  const [chartRange, setChartRange] = useState<'6' | '12'>('12');
  const [chartAsTable, setChartAsTable] = useState(false);
  const [expensesAsTable, setExpensesAsTable] = useState(false);

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

    // Receivables are billing documents only; an order confirmation or delivery note is no claim, and
    // payments and issued credit notes lower what is still open.
    const creditedFor = (inv: Invoice) => invoices
      .filter((doc) => doc.sourceDocumentId === inv.id && isCorrectionDocumentKind(doc.documentKind) && doc.status !== 'draft')
      .reduce((acc, doc) => acc + doc.amount, 0);
    const paidFor = (inv: Invoice) => (inv.payments ?? []).reduce((acc, payment) => acc + (Number(payment.amount) || 0), 0);
    const openAmountFor = (inv: Invoice) => Math.max(0, Math.round((amountFor(inv) - paidFor(inv) - creditedFor(inv)) * 100) / 100);
    const outstanding = invoices.filter((i) => (i.status === 'open' || i.status === 'overdue') && isReceivableDocumentKind(i.documentKind) && openAmountFor(i) > 0);
    const overdue = outstanding.filter((i) => i.status === 'overdue');

    const outstandingTotal = outstanding.reduce((acc, inv) => acc + openAmountFor(inv), 0);
    const overdueTotal = overdue.reduce((acc, inv) => acc + openAmountFor(inv), 0);

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dueSoon = outstanding
      .map((inv) => ({ inv, days: daysUntil(inv.dueDate, today), amount: openAmountFor(inv) }))
      .filter((row) => row.days >= 0 && row.days <= dash.dueSoonDays)
      .sort((a, b) => a.days - b.days);
    const dueSoonTotal = dueSoon.reduce((acc, row) => acc + row.amount, 0);

    // Aging by due date; a missing due date counts as not yet due.
    const aging = [
      { key: 'current', label: 'nicht fällig', fill: 'bg-muted', amount: 0 },
      { key: 'd30', label: '1–30 Tage', fill: 'bg-warning', amount: 0 },
      { key: 'd60', label: '31–60 Tage', fill: 'bg-warning-text', amount: 0 },
      { key: 'd60plus', label: 'über 60 Tage', fill: 'bg-error', amount: 0 },
    ];
    for (const inv of outstanding) {
      const late = -daysUntil(inv.dueDate, today);
      aging[!(late > 0) ? 0 : late <= 30 ? 1 : late <= 60 ? 2 : 3].amount += openAmountFor(inv);
    }

    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    // Only billing documents and their corrections; an order confirmation or delivery note is no revenue.
    const monthIssued = invoices
      .filter((inv) => inv.status !== 'draft' && (isReceivableDocumentKind(inv.documentKind) || isCorrectionDocumentKind(inv.documentKind)))
      .filter((inv) => {
        const d = new Date(inv.date);
        return d.getFullYear() === currentYear && d.getMonth() === currentMonth;
      });
    // Net revenue: billing documents count, credit notes and Stornos subtract, orders and delivery notes are zero.
    const netOf = (inv: (typeof invoices)[number]) => {
      const sign = isReceivableDocumentKind(inv.documentKind) ? 1 : isCorrectionDocumentKind(inv.documentKind) ? -1 : 0;
      if (sign === 0) return 0;
      const net = inv.taxSnapshot?.netAmount ?? (inv.items ?? []).reduce((s, it) => s + (Number(it.total) || 0), 0);
      return sign * net;
    };
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
      dueSoon,
      dueSoonCount: dueSoon.length,
      dueSoonTotal,
      aging,
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
    const estimate = estimateMonthVat(invoices, settings, taxMethod, now.getFullYear(), now.getMonth());
    return isLite ? { ...estimate, vat: (vatQuery.data?.payableCents ?? 0) / 100, net: (vatQuery.data?.outputVatCents ?? 0) / 100, gross: (vatQuery.data?.inputVatCents ?? 0) / 100 } : estimate;
  }, [invoices, settings, taxMethod, isLite, vatQuery.data]);

  const nowMonthLabel = new Date().toLocaleDateString('de-DE', { month: 'long' });
  const taxDueDays = Math.ceil((new Date(new Date().getFullYear(), new Date().getMonth() + 1, 10).getTime() - Date.now()) / 86_400_000);
  const shownMonths = flows ? flows.months.slice(chartRange === '6' ? -6 : -12) : [];
  const incomeShown = shownMonths.reduce((sum, month) => sum + month.income, 0);
  const expenseShown = shownMonths.reduce((sum, month) => sum + month.expense, 0);
  const incomeAverage = shownMonths.length > 0 ? incomeShown / shownMonths.length : 0;
  const donutSegments = useMemo(() => {
    const lines = flows?.expenseBreakdown ?? [];
    const top = lines.slice(0, 4).map((line) => ({ key: line.key, label: line.label, value: line.value, formatted: formatCompact(line.value) }));
    const rest = lines.slice(4).reduce((sum, line) => sum + line.value, 0);
    return rest > 0 ? [...top, { key: 'rest', label: flows?.breakdownBasis === 'eur-line' ? 'Übrige Kostenarten' : 'Übrige Empfänger', value: rest, formatted: formatCompact(rest) }] : top;
  }, [flows]);
  const expenseTotal = (flows?.expenseBreakdown ?? []).reduce((sum, line) => sum + line.value, 0);
  const goalShare = dash.monthlyRevenueGoal > 0 ? kpis.monthRevenueNet / dash.monthlyRevenueGoal : 0;

  const tasks = [
    { key: 'overdue', count: kpis.overdueCount, title: 'Überfällige Rechnungen mahnen', subtitle: `${formatCurrency(kpis.overdueTotal)} seit Fälligkeit offen`, tone: 'error' as const, icon: <AlertTriangle size={16} />, go: () => onNavigate('documents', { kind: 'invoice', status: 'overdue' }) },
    // One backlog counter: for EÜR businesses the "Offen" queue of "Buchen" (same number as the nav badge), which
    // also holds the unmatched incoming payments; double-entry businesses only match incoming payments.
    profitDetermination === 'eur'
      ? { key: 'unclassified', count: flows?.unclassifiedCount ?? 0, title: 'Zahlungen in „Buchen“ zuordnen', subtitle: 'Offen in „Buchen“: Rechnung zuordnen, Kategorie, Privat oder Geldtransit wählen', tone: 'info' as const, icon: <ReceiptText size={16} />, go: () => onNavigate('eur') }
      : { key: 'open', count: flows?.openTransactionCount ?? 0, title: 'Zahlungseingänge abgleichen', subtitle: 'Eingänge auf dem Konto ohne zugeordnete Rechnung', tone: 'info' as const, icon: <Landmark size={16} />, go: () => onNavigate('accounts') },
    { key: 'due', count: kpis.dueSoonCount, title: `Fällig in ${dash.dueSoonDays} Tagen`, subtitle: `${formatCurrency(kpis.dueSoonTotal)} erwartete Eingänge`, tone: 'warning' as const, icon: <Clock size={16} />, go: () => onNavigate('documents', { kind: 'invoice', due: String(dash.dueSoonDays) }) },
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
    <div className="flex flex-col gap-3.5 pb-4">
      <PageHeader
        title="Übersicht"
        description={new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
      />

      {/* KPI row: the tick carries state, the label carries meaning. */}
      <section aria-label="Kennzahlen" className="grid grid-cols-[repeat(auto-fit,minmax(min(13.25rem,100%),1fr))] gap-3">
        <div className="rounded-tile border border-border bg-surface px-4 py-3.5">
          <Metric
            marker="tick"
            label="Liquidität"
            value={flows?.liquidity == null ? '–' : formatCurrency(flows.liquidity)}
            hint={flowsQuery.isError ? 'Konten nicht erreichbar' : !profitDetermination ? 'Nach der Einrichtung verfügbar' : !flows ? 'Wird geladen' : flows.liquidity == null ? (
              <span>
                Noch kein Konto angelegt.{' '}
                <button type="button" className="font-medium text-foreground underline underline-offset-2" onClick={() => onNavigate('accounts')}>Bankkonto anlegen</button>
              </span>
            ) : `Anfangssaldo plus Kontoumsätze${flows.accountCount === 1 ? '' : `, ${flows.accountCount} Konten`}`}
            tone={flows?.liquidity != null && flows.liquidity < 0 ? 'error' : 'neutral'}
          />
        </div>
        <div className="rounded-tile border border-border bg-surface px-4 py-3.5">
          <Metric
            marker="tick"
            label="Offene Forderungen"
            value={formatCurrency(kpis.outstandingTotal)}
            hint={kpis.overdueCount > 0 ? `${formatCurrency(kpis.overdueTotal)} überfällig` : 'Nichts überfällig'}
            tone={kpis.overdueCount > 0 ? 'error' : 'neutral'}
          />
        </div>
        <div className="rounded-tile border border-border bg-surface px-4 py-3.5">
          <Metric
            marker="tick"
            label={`Ergebnis ${nowMonthLabel}`}
            value={monthResult == null ? '–' : formatCurrency(monthResult)}
            hint={monthResultQuery.isError ? (/REPORT_CHART_MISMATCH/.test(String(monthResultQuery.error)) ? 'Kontenrahmen in Profil und Buchhaltung weichen ab' : /REPORT_MAPPING_BLOCKED/.test(String(monthResultQuery.error)) ? 'Berichtskontenzuordnung unvollständig' : 'Auswertung nicht erreichbar') : !profitDetermination ? 'Nach der Einrichtung verfügbar' : monthResult == null ? 'Wird geladen' : 'Umsatz minus Aufwand'}
            tone={monthResult == null ? 'neutral' : monthResult >= 0 ? 'success' : 'error'}
          />
        </div>
        <div className="rounded-tile border border-border bg-surface px-4 py-3.5">
          <Metric
            marker="tick"
            label="Umsatzsteuer"
            value={isLite && !vatQuery.data ? '–' : formatCurrency(taxEstimate.vat)}
            hint={isLite ? vatQuery.isError ? 'Steuerdaten nicht erreichbar' : vatQuery.data?.preparationComplete ? `Vorbereitung ${taxEstimate.periodLabel}` : 'Vorbereitung enthält offene Prüfpunkte' : taxEstimate.vat > 0 ? `fällig am ${taxEstimate.dueLabel}, in ${taxDueDays} Tagen` : `Keine Zahllast für ${taxEstimate.periodLabel}`}
            tone={taxEstimate.vat > 0 && taxDueDays <= 7 ? 'warning' : 'neutral'}
          />
        </div>
      </section>

      <div className={twoColumns}>

      {/* Income against expense, twelve months. */}
      <section aria-labelledby="dashboard-flows" className="min-w-0">
        <Card radius="2xl" padding="lg" className="pt-4">
          <CardHeader
            size="lg"
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
          <div className="mt-3">
            {flowsQuery.isError ? (
              <ErrorState
                title="Zahlungsdaten konnten nicht geladen werden"
                description="Konten und Kontoumsätze sind gerade nicht erreichbar. Die übrigen Karten rechnen aus den Rechnungen."
                onRetry={() => void flowsQuery.refetch()}
              />
            ) : flowsQuery.isLoading ? (
              <SkeletonLoader variant="card" count={1} />
            ) : shownMonths.every((month) => month.income === 0 && month.expense === 0) ? (
              <EmptyState title="Noch keine Zahlungen" description="Sobald Kontoumsätze importiert oder Zahlungen erfasst sind, erscheinen sie hier nach Monat." />
            ) : chartAsTable ? (
              <Table bare aria-label="Einnahmen und Ausgaben je Monat">
                <TableHeader>
                  <TableRow>
                    <TableHead>Monat</TableHead>
                    <TableHead numeric>Einnahmen</TableHead>
                    <TableHead numeric>Ausgaben</TableHead>
                    <TableHead numeric>Ergebnis</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shownMonths.map((month) => (
                    <TableRow key={month.key}>
                      <TableCell>{month.longLabel}</TableCell>
                      <TableCell numeric>{formatCurrency(month.income)}</TableCell>
                      <TableCell numeric>{formatCurrency(month.expense)}</TableCell>
                      <TableCell numeric className={cn('font-medium', month.income - month.expense < 0 && 'text-error-text')}>{formatCurrency(month.income - month.expense)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <>
                <div className={insetPanel}>
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
                </div>
                <dl className="mt-3.5 grid grid-cols-[repeat(auto-fit,minmax(9.25rem,1fr))] gap-3.5 border-t border-border pt-3">
                  <div>
                    <dt className="text-caption text-muted">Einnahmen, {shownMonths.length} Monate</dt>
                    <dd className="mt-0.5 text-heading font-bold tabular-nums">{formatCurrency(incomeShown)}</dd>
                  </div>
                  <div>
                    <dt className="text-caption text-muted">Ausgaben, {shownMonths.length} Monate</dt>
                    <dd className="mt-0.5 text-heading font-bold tabular-nums">{formatCurrency(expenseShown)}</dd>
                  </div>
                  <div>
                    <dt className="text-caption text-muted">Ergebnis</dt>
                    <dd className={cn('mt-0.5 text-heading font-bold tabular-nums', incomeShown - expenseShown >= 0 ? 'text-success-text' : 'text-error-text')}>{formatCurrency(incomeShown - expenseShown)}</dd>
                  </div>
                </dl>
              </>
            )}
          </div>
        </Card>
      </section>

      {/* Expense structure */}
      <section aria-labelledby="dashboard-expenses" className="min-w-0">
        <Card radius="2xl" padding="lg" className="pt-4">
          <CardHeader
            size="lg"
            title={<span id="dashboard-expenses">Aufwandsstruktur</span>}
            subtitle={<>
              {flows?.breakdownBasis === 'eur-line' ? 'Ausgaben der letzten zwölf Monate nach EÜR-Zeile' : 'Ausgaben der letzten zwölf Monate nach Empfänger'}
              {donutSegments.length > 0 && <>, zusammen <span className="tabular-nums">{formatCurrency(expenseTotal)}</span></>}
            </>}
            count={donutSegments.length > 0 ? `${flows?.expenseBreakdown.length ?? 0} ${flows?.breakdownBasis === 'eur-line' ? 'Kostenarten' : 'Empfänger'}` : undefined}
            actions={
              <Menu
                aria-label="Aktionen Aufwandsstruktur"
                align="end"
                items={[
                  { id: 'table', label: expensesAsTable ? 'Als Diagramm anzeigen' : 'Als Tabelle anzeigen', onSelect: () => setExpensesAsTable((value) => !value) },
                  { id: 'go', label: 'Zu den Kontoumsätzen', onSelect: () => onNavigate('accounts') },
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
            {donutSegments.length === 0 ? (
              <EmptyState title="Noch keine Ausgaben" description="Ausgaben erscheinen hier, sobald Kontoumsätze importiert sind." />
            ) : expensesAsTable ? (
              <Table bare aria-label={flows?.breakdownBasis === 'eur-line' ? 'Ausgaben nach Kostenart' : 'Ausgaben nach Empfänger'}>
                <TableHeader>
                  <TableRow>
                    <TableHead>{flows?.breakdownBasis === 'eur-line' ? 'Kostenart' : 'Empfänger'}</TableHead>
                    <TableHead numeric>Betrag</TableHead>
                    <TableHead numeric>Anteil</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(flows?.expenseBreakdown ?? []).map((line) => (
                    <TableRow key={line.key}>
                      <TableCell>{line.label}</TableCell>
                      <TableCell numeric>{formatCurrency(line.value)}</TableCell>
                      <TableCell numeric muted>{percent.format(expenseTotal ? line.value / expenseTotal : 0)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <Donut label={flows?.breakdownBasis === 'eur-line' ? 'Ausgaben nach Kostenart' : 'Ausgaben nach Empfänger'} segments={donutSegments} total={formatCompact(expenseTotal)} />
            )}
          </div>
        </Card>
      </section>

      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(21.25rem,100%),1fr))] items-start gap-3.5">

      {/* What needs doing, ordered by consequence. */}
      <section aria-labelledby="dashboard-tasks" className="min-w-0">
        <Card radius="2xl" padding="lg" className="pt-4">
          <CardHeader
            size="lg"
            title={<span id="dashboard-tasks">Was jetzt ansteht</span>}
            subtitle="Reihenfolge nach Fristwirkung"
            count={tasks.length > 0 ? `${tasks.reduce((sum, task) => sum + task.count, 0)} Vorgänge` : undefined}
          />
          <div className="mt-1">
            {tasks.length === 0 ? (
              <EmptyState title="Keine offenen Vorgänge" description="Nichts ist überfällig und kein Kontoumsatz wartet auf eine Zuordnung." />
            ) : (
              tasks.map((task) => (
                <ListRow key={task.key} icon={task.icon} tone={task.tone} title={task.title} subtitle={task.subtitle} value={task.count} onClick={task.go} />
              ))
            )}
          </div>
        </Card>
      </section>

      {/* Expected money of the next days. */}
      <section aria-labelledby="dashboard-due-soon" className="min-w-0">
        <Card radius="2xl" padding="lg" className="pt-4">
          <CardHeader
            size="lg"
            title={<span id="dashboard-due-soon">Fällig in {dash.dueSoonDays} Tagen</span>}
            subtitle="Erwartete Eingänge aus offenen Rechnungen"
            count={kpis.dueSoonCount > 0 ? `${kpis.dueSoonCount} Posten` : undefined}
            actions={
              <DashboardSettingsPopover
                fields={[{ key: 'dueSoonDays', label: 'Fällig in X Tagen', min: 1, max: 90 }]}
                values={{ dueSoonDays: dash.dueSoonDays }}
                onSave={(v) => saveDashboardSettings({ dueSoonDays: v.dueSoonDays })}
              ><span /></DashboardSettingsPopover>
            }
          />
          {/* ponytail: inflows only; recurring expenses are not loaded on the overview.
              Add them as outflows once a recurring-expense hook exists here. */}
          {kpis.dueSoon.length === 0 ? (
            <EmptyState title="Nichts fällig" description={`In den nächsten ${dash.dueSoonDays} Tagen wird keine offene Rechnung fällig.`} />
          ) : (
            <>
              <div role="list" aria-label={`Fällig in ${dash.dueSoonDays} Tagen`} className="mt-1">
                {kpis.dueSoon.map(({ inv, amount }) => (
                  <div role="listitem" key={inv.id} className="border-b border-dashed border-border last:border-b-0">
                    <ListRow
                      className="border-b-0"
                      icon={<ArrowDownLeft size={16} />}
                      tone="success"
                      title={inv.client}
                      subtitle={<><span className="tabular-nums">{formatDate(inv.dueDate)}</span> · {inv.number}</>}
                      value={formatCurrency(amount)}
                      valueTone="success"
                      onClick={() => onNavigate('documents', { kind: 'invoice', id: inv.id })}
                    />
                  </div>
                ))}
              </div>
              <div className={cn(insetPanel, 'mt-3.5 flex items-center justify-between gap-3')}>
                <span className="text-label">Saldo der {dash.dueSoonDays} Tage</span>
                <span className={cn('text-heading font-bold tabular-nums', kpis.dueSoonTotal >= 0 ? 'text-success-text' : 'text-error-text')}>{formatCurrency(kpis.dueSoonTotal)}</span>
              </div>
            </>
          )}
        </Card>
      </section>

      </div>

      <div className={twoColumns}>

      {/* Revenue this month */}
      <section aria-labelledby="dashboard-revenue" className="min-w-0">
        <Card radius="2xl" padding="lg" className="pt-4">
            <CardHeader
              size="lg"
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
              <div className={cn(insetPanel, 'mt-3.5')}>
                <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
                  <span className="text-3xl font-bold tracking-tight tabular-nums">{Math.round(Math.min(1, goalShare) * 100)} %</span>
                  <span className="text-caption text-muted">
                    {goalShare >= 1 ? 'Ziel erreicht' : <>noch <span className="tabular-nums">{formatCurrency(dash.monthlyRevenueGoal - kpis.monthRevenueNet)}</span> bis zum Ziel von <span className="tabular-nums">{formatCurrency(dash.monthlyRevenueGoal)}</span></>}
                  </span>
                </div>
                <HatchedProgress className="mt-3" value={goalShare} label="Umsatzziel dieses Monats" valueText={`${Math.round(Math.min(1, goalShare) * 100)} Prozent von ${formatCurrency(dash.monthlyRevenueGoal)}`} />
              </div>
            )}

            <h3 className="mt-3.5 text-eyebrow uppercase text-muted">Wichtigste Einnahmequellen</h3>
            {topCategories.length === 0 ? (
              <EmptyState
                title="Noch keine Umsätze in diesem Monat"
                description="Sobald eine Rechnung dieses Monats als bezahlt erfasst ist, erscheint ihre Kategorie hier."
              />
            ) : (
              <div>
                {topCategories.map((row) => (
                  <ListRow
                    key={row.category}
                    icon={<span className="text-caption font-semibold">{initialsOf(row.category)}</span>}
                    title={row.category}
                    subtitle={<span className="tabular-nums">{row.invoiceCount} {row.invoiceCount === 1 ? 'Rechnung' : 'Rechnungen'}</span>}
                    value={formatCurrency(row.amount)}
                    onClick={() => onNavigate('articles', { query: row.category })}
                  />
                ))}
              </div>
            )}

            <div className="mt-3.5 flex flex-wrap items-end justify-between gap-3 border-t border-border pt-3">
              <div>
                <p className="text-label text-muted">Offene Angebote, netto</p>
                <p className="mt-0.5 text-caption text-muted tabular-nums">
                  Offen {offerPipeline.activeCount} · Angenommen {offerPipeline.acceptedCount} · Abgelehnt {offerPipeline.declinedCount}
                </p>
              </div>
              <p className="text-heading font-bold tabular-nums">{formatCurrency(offerPipeline.potentialNet)}</p>
            </div>
        </Card>
      </section>

      {/* Receivables by age */}
      <section aria-labelledby="dashboard-receivables" className="min-w-0">
        <Card radius="2xl" padding="lg" className="pt-4">
           <CardHeader
             size="lg"
             title={<span id="dashboard-receivables">Offene Forderungen</span>}
             subtitle={kpis.overdueCount > 0 ? <>davon <span className="tabular-nums">{formatCurrency(kpis.overdueTotal)}</span> überfällig ({kpis.overdueCount})</> : 'Nichts überfällig'}
             actions={
               <Button variant="ghost" size="sm" onClick={() => onNavigate('documents', { kind: 'invoice', unpaid: '1' })}>
                 Alle ansehen <ArrowUpRight size={14} aria-hidden="true" />
               </Button>
             }
           />

           <p className="mt-3 text-figure tabular-nums break-words">{formatCurrency(kpis.outstandingTotal)}</p>

           <h3 className="mt-3.5 text-eyebrow uppercase text-muted">Altersstruktur nach Fälligkeit</h3>
           <ul aria-label="Altersstruktur der Forderungen" className="mt-2 flex flex-col gap-2.25">
               {kpis.aging.map((bucket, index) => (
                   <li key={bucket.key} className="grid grid-cols-[6.5rem_minmax(0,1fr)_auto] items-center gap-2.5 text-caption">
                       <span>{bucket.label}</span>
                       <span className="h-4 overflow-hidden rounded-xs bg-surface-sunken" aria-hidden="true">
                           <span className={cn('block h-full rounded-xs', bucket.fill)} style={{ width: `${bucket.amount > 0 ? Math.max(2, (bucket.amount / (kpis.outstandingTotal || 1)) * 100) : 0}%` }} />
                       </span>
                       <span className={cn('text-right tabular-nums', index > 0 && bucket.amount > 0 && 'text-error-text')}>{formatCurrency(bucket.amount)}</span>
                   </li>
               ))}
           </ul>

           <div className="mt-3.5 flex flex-wrap items-end justify-between gap-3 border-t border-border pt-3">
              <div>
                   <p className="text-caption text-muted">Zahlungseingänge</p>
                   {paymentTrend !== null ? (
                     <p className="mt-0.5 flex items-center gap-1.5 text-control">
                        <span className={cn('inline-flex items-center gap-0.5 font-medium tabular-nums', paymentTrend >= 0 ? 'text-success-text' : 'text-error-text')}>
                          {paymentTrend >= 0 ? <TrendingUp size={14} aria-hidden="true" /> : <TrendingDown size={14} aria-hidden="true" />}
                          {paymentTrend >= 0 ? '+' : ''}{paymentTrend}%
                        </span>
                        <span className="text-muted">zum Vormonat</span>
                     </p>
                   ) : (
                     <p className="mt-0.5 text-control text-muted">Keine Vormonatsdaten</p>
                   )}
              </div>
              <Button variant="secondary" size="sm" onClick={() => onNavigate('documents', { kind: 'invoice', status: 'overdue' })}>
                  Mahnung senden
              </Button>
           </div>
        </Card>
      </section>

      </div>

      <div className={twoColumns}>

      {/* Recent payments */}
      <section aria-labelledby="dashboard-payments" className="min-w-0">
        <Card radius="2xl" padding="lg" className="pt-4">
            <CardHeader
              size="lg"
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
              />
            ) : (
              <div className="mt-1">
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
        </Card>
      </section>

      {/* VAT estimate */}
      <section aria-labelledby="dashboard-tax" className="min-w-0">
        <Card radius="2xl" padding="lg" className="pt-4">
            <CardHeader
              size="lg"
              title={<span id="dashboard-tax">{isLite ? 'Umsatzsteuer-Vorbereitung' : 'Steuerschätzung'}</span>}
              subtitle={`Voranmeldung ${taxEstimate.periodLabel}, ${taxMethod === 'ist' ? 'Ist' : 'Soll'}-Versteuerung`}
              actions={<Badge tone={taxEstimate.vat > 0 && taxDueDays <= 7 ? 'warning' : 'info'}>{taxEstimate.vat > 0 ? `in ${taxDueDays} Tagen` : taxEstimate.periodLabel}</Badge>}
            />

            <p className="mt-3 text-label text-muted">
              {isLite ? 'Voraussichtliche Zahllast / Erstattung' : taxEstimate.vat <= 0 ? 'Keine voraussichtliche Umsatzsteuer' : 'Voraussichtliche Umsatzsteuer'}
            </p>
            <p className="mt-1 text-figure tabular-nums">{isLite && !vatQuery.data ? '–' : formatCurrency(taxEstimate.vat)}</p>
            {isLite && <Button variant="secondary" className="mt-3" onClick={() => onNavigate('statistics', { view: 'ust' })}>{vatQuery.data?.preparationComplete ? 'Steuervorbereitung öffnen' : 'Steuerdaten und Prüfpunkte öffnen'}</Button>}
            {!isLite && taxEstimate.vat > 0 && (
              <p className="mt-1 text-caption text-muted">Fällig am <span className="tabular-nums">{taxEstimate.dueLabel}</span></p>
            )}

            <dl className="mt-3.5 grid grid-cols-2 gap-3.5 border-t border-border pt-3">
                <div>
                    <dt className="text-caption text-muted">{isLite ? 'Umsatzsteuer' : `Netto-Basis (${taxMethod === 'ist' ? 'Ist' : 'Soll'})`}</dt>
                    <dd className="mt-0.5 text-heading font-bold tabular-nums">{formatCurrency(taxEstimate.net)}</dd>
                </div>
                <div>
                    <dt className="text-caption text-muted">{isLite ? 'Abziehbare Vorsteuer' : 'Brutto'}</dt>
                    <dd className="mt-0.5 text-heading font-bold tabular-nums">{formatCurrency(taxEstimate.gross)}</dd>
                </div>
            </dl>
        </Card>
      </section>

      </div>
    </div>
  );
};
