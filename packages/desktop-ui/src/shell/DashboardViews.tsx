import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
    TrendingUp, TrendingDown, Plus,
    ArrowUpRight, CheckCircle, CreditCard, Settings2
} from 'lucide-react';
import { Avatar, Badge, Button, EmptyState, ErrorState, IconButton, PageHeader, cn, popoverExitClass, useActionFeedback, useExitTransition, Sparkline } from '@billme/ui';
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
import { SkeletonLoader } from '../components/SkeletonLoader';
import { useAnchoredPosition } from './useAnchoredPosition';

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
  const pos = useAnchoredPosition(buttonRef, open);
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
          style={{ position: 'fixed', top: pos.top, right: pos.right }}
          className={cn(
            'ui-enter-popover [--origin:top_right] z-[var(--z-dropdown)] bg-surface text-foreground rounded-panel shadow-md p-4 min-w-[260px]',
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
                  className="px-2.5 h-8 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm tabular-nums text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                />
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => { onSave(draft); setOpen(false); }}
            className="mt-3 w-full py-2 bg-dark-base text-background rounded-md text-xs font-semibold hover:bg-dark-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
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
    const y = now.getFullYear();
    const m = now.getMonth();

    const periodLabel = now.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
    const dueDate = new Date(y, m + 1, 10);
    const dueLabel = dueDate.toLocaleDateString('de-DE', { day: '2-digit', month: 'long' });
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

    if (taxMethod === 'ist') {
      // Ist: based on payments, capped by invoice gross and split by invoice VAT ratio.
      const byInvoice = new Map<string, number>();
      for (const inv of invoices) {
        const paidInMonth = (inv.payments ?? []).filter((p) => {
          const d = new Date(p.date);
          return d.getFullYear() === y && d.getMonth() === m;
        });
        if (paidInMonth.length === 0) continue;
        const sum = paidInMonth.reduce((acc, p) => acc + (Number(p.amount) || 0), 0);
        const prev = byInvoice.get(inv.id) ?? 0;
        byInvoice.set(inv.id, prev + sum);
      }
      let gross = 0;
      let vat = 0;
      for (const inv of invoices) {
        const paid = byInvoice.get(inv.id) ?? 0;
        if (paid <= 0) continue;
        const snap = snapshotFor(inv);
        const grossCap = Math.max(0, Number(snap.grossAmount) || 0);
        const applied = Math.min(paid, Number.isFinite(grossCap) && grossCap > 0 ? grossCap : paid);
        gross += applied;
        const vatRatio = grossCap > 0 ? Math.max(0, (Number(snap.vatAmount) || 0) / grossCap) : 0;
        vat += applied * vatRatio;
      }
      vat = Math.max(0, vat);
      const net = Math.max(0, gross - vat);
      return { periodLabel, net, vat, gross, dueLabel };
    }

    // Soll: based on issued invoices in month.
    const issued = invoices
      .filter((inv) => inv.status !== 'draft')
      .filter((inv) => {
        const d = new Date(inv.date);
        return d.getFullYear() === y && d.getMonth() === m;
      });

    const net = issued.reduce((acc, inv) => acc + (snapshotFor(inv).netAmount || 0), 0);
    const vat = issued.reduce((acc, inv) => acc + (snapshotFor(inv).vatAmount || 0), 0);
    const gross = issued.reduce((acc, inv) => acc + (snapshotFor(inv).grossAmount || 0), 0);
    return { periodLabel, net, vat, gross, dueLabel };
  }, [invoices, settings, taxMethod]);

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

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-12">

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
                 <p className="text-caption text-inverse-muted">Liquiditätsprognose</p>
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
      <section aria-labelledby="dashboard-revenue" className="lg:col-span-7 flex flex-col rounded-panel bg-surface p-6 shadow-xs">
          <div className="flex items-start justify-between gap-3">
             <div>
                <h2 id="dashboard-revenue" className="text-section">Umsatz im laufenden Monat</h2>
                <p className="text-caption text-muted">Netto, gestellte Rechnungen: <span className="tabular-nums">{kpis.monthIssuedCount}</span></p>
             </div>
             <DashboardSettingsPopover
               fields={[
                 { key: 'monthlyRevenueGoal', label: 'Monatsziel (€)', min: 0, step: 1000 },
                 { key: 'topCategoriesLimit', label: 'Top Kategorien (Anzahl)', min: 1, max: 20 },
               ]}
               values={{ monthlyRevenueGoal: dash.monthlyRevenueGoal, topCategoriesLimit: dash.topCategoriesLimit }}
               onSave={(v) => saveDashboardSettings({ monthlyRevenueGoal: v.monthlyRevenueGoal, topCategoriesLimit: v.topCategoriesLimit })}
             ><span /></DashboardSettingsPopover>
          </div>

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
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-ink-100">
                  <div
                    className="h-full rounded-full bg-ink-950"
                    style={{ width: `${Math.min(100, (kpis.monthRevenueNet / dash.monthlyRevenueGoal) * 100)}%` }}
                  />
              </div>
              <div className="mt-1.5 flex justify-between text-caption text-muted">
                  <span className="tabular-nums">{Math.round(Math.min(100, (kpis.monthRevenueNet / dash.monthlyRevenueGoal) * 100))} % erreicht</span>
                  <span className="tabular-nums">Ziel {formatCurrency(dash.monthlyRevenueGoal)}</span>
              </div>
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
      <section aria-labelledby="dashboard-tax" className="lg:col-span-5 flex flex-col rounded-panel bg-surface p-6 shadow-xs">
           <div className="flex items-start justify-between gap-3">
              <h2 id="dashboard-tax" className="text-section">Steuerschätzung</h2>
              <Badge tone="info">{taxEstimate.periodLabel}</Badge>
          </div>

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
      <section aria-labelledby="dashboard-payments" className="lg:col-span-7 flex flex-col rounded-panel bg-surface p-6 shadow-xs">
          <div className="flex items-start justify-between gap-3">
              <div>
                <h2 id="dashboard-payments" className="text-section">Zahlungseingänge</h2>
                <p className="text-caption text-muted">
                  Dieser Monat <span className="font-medium text-foreground tabular-nums">{formatCurrency(paymentsThisMonthGross)}</span>
                </p>
              </div>
              <div className="flex items-center gap-1">
                  <DashboardSettingsPopover
                    fields={[{ key: 'recentPaymentsLimit', label: 'Angezeigte Zahlungen', min: 1, max: 20 }]}
                    values={{ recentPaymentsLimit: dash.recentPaymentsLimit }}
                    onSave={(v) => saveDashboardSettings({ recentPaymentsLimit: v.recentPaymentsLimit })}
                  ><span /></DashboardSettingsPopover>
                  <IconButton size="sm" aria-label="Zu den Finanzen" onClick={() => onNavigate('finance')}>
                      <ArrowUpRight size={16} aria-hidden="true" />
                  </IconButton>
              </div>
          </div>

          {payments.length === 0 ? (
            <EmptyState
              title="Noch keine Zahlungseingänge"
              description="Erfasste Zahlungen erscheinen hier, sobald du sie an einer Rechnung einträgst."
              className="mt-4 py-6"
            />
          ) : (
            <ul className="mt-3 divide-y divide-border-subtle">
              {payments.slice(0, dash.recentPaymentsLimit).map((item) => (
                <li key={`${item.invoiceId}:${item.date}:${item.amount}`}>
                  <button
                    type="button"
                    className="-mx-2 flex w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-control px-2 py-2.5 text-left transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    onClick={() => onNavigate('documents', { kind: 'invoice', id: item.invoiceId })}
                    title={`${item.invoiceNumber}, ${item.client}`}
                  >
                    <span className="flex min-w-0 items-center gap-3">
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-100 text-accent-800" aria-hidden="true">
                        <CheckCircle size={14} />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-medium">{item.client}</span>
                        <span className="block truncate text-caption text-muted"><span className="tabular-nums">{formatDate(item.date)}</span> · {item.invoiceNumber}</span>
                      </span>
                    </span>
                    <span className="text-right">
                      <span className="block font-medium tabular-nums">{formatCurrency(item.amount)}</span>
                      <span className="inline-flex items-center gap-1 text-caption text-muted">
                        <CreditCard size={12} aria-hidden="true" />
                        {item.method}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
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
        <div className="bg-surface rounded-panel shadow-xs p-6 lg:p-8 min-h-full">
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
                            className="px-4 py-2 rounded-control text-xs font-semibold bg-dark-base text-background hover:bg-surface-inverse-raised transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
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
    );
}
