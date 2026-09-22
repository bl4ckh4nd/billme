import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
    Euro, TrendingUp, TrendingDown, Clock, Plus,
    ArrowUpRight, CheckCircle, CreditCard, PieChart, Settings2
} from 'lucide-react';
import { EMPTY_VALUE, EmptyState, ErrorState, useActionFeedback } from '@billme/ui';
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
}> = ({ children, onSave, fields, values, dark }) => {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(values);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const pos = useAnchoredPosition(buttonRef, open);

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
        className={`ui-press p-1.5 rounded-md transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 ${dark ? 'text-dark-muted hover:bg-white/10 hover:text-white focus-visible:outline-focus-ring-dark' : 'text-muted hover:bg-surface-muted hover:text-foreground focus-visible:outline-focus-ring'}`}
      >
        <Settings2 size={14} />
      </button>
      {open && createPortal(
        <div
          ref={dropdownRef}
          style={{ position: 'fixed', top: pos.top, right: pos.right }}
          className="ui-enter-popover z-[var(--z-dropdown)] bg-surface text-foreground rounded-xl shadow-2xl p-4 min-w-[260px]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="space-y-3">
            {fields.map((f) => (
              <div key={f.key}>
                <label className="block text-xs font-bold text-muted uppercase tracking-wide mb-1" htmlFor={`dashboardviews-field-${f.key}`}>{f.label}</label>
                <input id={`dashboardviews-field-${f.key}`}
                  type="number"
                  min={f.min ?? 1}
                  max={f.max}
                  step={f.step ?? 1}
                  value={draft[f.key] ?? 0}
                  onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })}
                  className="w-full bg-surface-muted border border-control-border rounded-md px-3 py-2 text-sm font-bold tabular-nums text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                />
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => { onSave(draft); setOpen(false); }}
            className="mt-3 w-full py-2 bg-dark-base text-background rounded-md text-xs font-bold hover:bg-dark-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            Speichern
          </button>
        </div>,
        document.body,
      )}
      {children}
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
    const monthRevenueNet = monthIssued.reduce(
      (acc, inv) => acc + (inv.items ?? []).reduce((s, it) => s + (Number(it.total) || 0), 0),
      0,
    );

    return {
      outstandingTotal,
      overdueCount: overdue.length,
      overdueTotal,
      dueSoonCount: dueSoon.length,
      dueSoonTotal,
      monthRevenueNet,
      monthIssuedCount: monthIssued.length,
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
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pb-8">

      {/* 1. Dark Card - Open Invoices / Liquidity */}
      <div className="bg-dark-3 rounded-2xl p-8 text-white relative overflow-hidden min-h-[420px] flex flex-col justify-between shadow-sm">
         <div className="relative z-10">
             <div className="flex justify-between items-start mb-12">
                 <div className="p-3 bg-white/10 rounded-xl border border-white/10">
                    <Clock size={24} className="text-background" />
                 </div>
                 <div className="flex gap-2 items-center">
                     <DashboardSettingsPopover
                       dark
                       fields={[{ key: 'dueSoonDays', label: 'Fällig in X Tagen', min: 1, max: 90 }]}
                       values={{ dueSoonDays: dash.dueSoonDays }}
                       onSave={(v) => saveDashboardSettings({ dueSoonDays: v.dueSoonDays })}
                     ><span /></DashboardSettingsPopover>
                     <button type="button" onClick={() => onNavigate('documents')} className="px-3 py-1.5 rounded-md border border-white/20 flex items-center gap-2 hover:bg-white/10 transition-colors text-xs font-bold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring-dark">
                         Alle ansehen <ArrowUpRight size={14} />
                     </button>
                 </div>
             </div>

             <div className="mb-4">
                 <p className="text-dark-muted text-sm font-bold uppercase tracking-wide mb-2">Offene Forderungen</p>
                 <h2 className="text-4xl sm:text-5xl font-bold tabular-nums tracking-tight mb-4 break-words">{formatCurrency(kpis.outstandingTotal)}</h2>

                 <div className="flex flex-col gap-3">
                     <div className="flex items-center justify-between bg-white/5 p-3 rounded-xl border border-white/5 hover:bg-white/10 transition-colors">
                        <div className="flex items-center gap-3">
                            <span className="px-2 py-0.5 rounded-full border border-error bg-error-bg text-xs font-bold text-error-text">Überfällig</span>
                            <span className="text-sm font-bold text-white">({kpis.overdueCount})</span>
                        </div>
                        <span className="font-bold tabular-nums text-white">{formatCurrency(kpis.overdueTotal)}</span>
                     </div>
                     <div className="flex items-center justify-between bg-white/5 p-3 rounded-xl border border-white/5 hover:bg-white/10 transition-colors">
                        <div className="flex items-center gap-3">
                            <span className="px-2 py-0.5 rounded-full border border-background/40 bg-white/10 text-xs font-bold text-background">Fällig</span>
                            <span className="text-sm font-bold text-white">in {dash.dueSoonDays} Tagen ({kpis.dueSoonCount})</span>
                        </div>
                        <span className="font-bold tabular-nums text-background">{formatCurrency(kpis.dueSoonTotal)}</span>
                     </div>
                 </div>
             </div>
         </div>

         <div className="relative z-10 pt-6 border-t border-white/10">
             <div className="flex justify-between items-end">
                <div>
                     <p className="text-dark-muted text-xs font-medium">Liquiditätsprognose</p>
                     {paymentTrend !== null ? (
                       <p className="text-white text-sm font-bold flex items-center gap-2 mt-1">
                          <span className={`${paymentTrend >= 0 ? 'bg-success/20 text-white' : 'bg-error/20 text-white'} px-1.5 py-1 rounded text-xs flex items-center gap-0.5`}>
                            {paymentTrend >= 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                            {paymentTrend >= 0 ? '+' : ''}{paymentTrend}%
                          </span>
                          zum Vormonat
                       </p>
                     ) : (
                       <p className="text-dark-muted text-xs mt-1">Keine Vormonatsdaten</p>
                     )}
                </div>
                <button
                    type="button"
                    onClick={() => onNavigate('documents', { kind: 'invoice', status: 'overdue' })}
                    className="bg-accent text-accent-foreground px-6 py-3 rounded-xl font-bold text-sm hover:bg-accent-hover transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring-dark"
                >
                    Mahnung senden
                </button>
             </div>
         </div>
      </div>

      {/* 2. White Card - Revenue / Bestsellers */}
      <div className="bg-surface rounded-2xl p-8 text-foreground relative overflow-hidden min-h-[420px] flex flex-col shadow-sm">
          <div className="flex justify-between items-start mb-8">
             <div>
                <h3 className="text-2xl font-black mb-1">Umsatz (aktueller Monat)</h3>
                <p className="text-muted text-xs font-bold uppercase">Laufendes Geschäftsjahr</p>
             </div>
             <div className="flex items-center gap-2">
                 <DashboardSettingsPopover
                   fields={[
                     { key: 'monthlyRevenueGoal', label: 'Monatsziel (€)', min: 0, step: 1000 },
                     { key: 'topCategoriesLimit', label: 'Top Kategorien (Anzahl)', min: 1, max: 20 },
                   ]}
                   values={{ monthlyRevenueGoal: dash.monthlyRevenueGoal, topCategoriesLimit: dash.topCategoriesLimit }}
                   onSave={(v) => saveDashboardSettings({ monthlyRevenueGoal: v.monthlyRevenueGoal, topCategoriesLimit: v.topCategoriesLimit })}
                 ><span /></DashboardSettingsPopover>
                 <div className="p-3 bg-surface-muted rounded-xl">
                     <Euro size={24} className="text-foreground" />
                 </div>
             </div>
          </div>

          <div className="mb-8">
              <h2 className="text-5xl font-bold tabular-nums mb-2">{formatCurrency(kpis.monthRevenueNet)}</h2>
              <p className="text-xs text-muted font-bold uppercase tracking-wide mt-2">
                Gestellte Rechnungen: {kpis.monthIssuedCount}
              </p>
              {/* The goal is a user setting. A workspace that has not set one gets no
                  progress figure instead of a fabricated target. */}
              {dash.monthlyRevenueGoal > 0 && (
                <>
                  <div className="w-full bg-surface-muted h-3 rounded-full overflow-hidden mt-4">
                      <div
                        className="bg-dark-base h-full rounded-full relative"
                        style={{ width: `${Math.min(100, (kpis.monthRevenueNet / dash.monthlyRevenueGoal) * 100)}%` }}
                      >
                          <div className="absolute right-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-white/50 rounded-full"></div>
                      </div>
                  </div>
                  <div className="flex justify-between mt-2 text-xs font-bold text-muted">
                      <span>0 €</span>
                      <span className="tabular-nums">Ziel: {formatCurrency(dash.monthlyRevenueGoal)}</span>
                  </div>
                </>
              )}
          </div>

          <div className="flex-1 flex flex-col justify-end gap-4">
              <h4 className="font-bold text-sm text-foreground">Wichtigste Einnahmequellen</h4>

              <div className="space-y-3">
                  {topCategories.length === 0 ? (
                    <EmptyState
                      title="Noch keine Umsätze in diesem Monat"
                      description="Sobald eine Rechnung dieses Monats als bezahlt erfasst ist, erscheint ihre Kategorie hier."
                      className="px-3 py-6"
                    />
                  ) : (
                    topCategories.map((row) => {
                      const initials = row.category
                        .split(/\s+/)
                        .filter(Boolean)
                        .slice(0, 2)
                        .map((s) => s[0]!.toUpperCase())
                        .join('');

                      return (
                        <button
                          type="button"
                          key={row.category}
                          onClick={() => onNavigate('articles', { query: row.category })}
                          className="flex w-full items-center justify-between p-3 border border-border rounded-xl hover:bg-surface-muted transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-10 h-10 rounded-md bg-surface-muted text-foreground flex items-center justify-center font-bold text-xs shrink-0">
                              {initials || EMPTY_VALUE}
                            </div>
                            <div className="min-w-0">
                              <span className="font-bold text-sm block truncate">{row.category}</span>
                              <span className="text-xs text-muted font-bold">
                                {row.invoiceCount} {row.invoiceCount === 1 ? 'Rechnung' : 'Rechnungen'}
                              </span>
                            </div>
                          </div>
                          <span className="font-bold tabular-nums text-lg">{formatCurrency(row.amount)}</span>
                        </button>
                      );
                    })
                  )}
              </div>

              <div className="mt-5 p-4 rounded-xl border border-border bg-surface-muted">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="text-xs font-bold text-muted uppercase tracking-wide">Offene Angebote</p>
                    <p className="text-sm font-bold text-foreground">Nettowert</p>
                  </div>
                  <div className="text-lg font-bold tabular-nums text-foreground">{formatCurrency(offerPipeline.potentialNet)}</div>
                </div>
                <div className="text-xs text-muted font-bold">
                  Basis: veröffentlicht/verschickt (Portal) • Offen: {offerPipeline.activeCount} • Angenommen: {offerPipeline.acceptedCount} • Abgelehnt: {offerPipeline.declinedCount}
                </div>
              </div>
          </div>
      </div>

      {/* 3. Lime Card - Recent Payments */}
      <div className="bg-accent rounded-2xl p-8 text-accent-foreground min-h-[350px] flex flex-col shadow-sm">

          <div className="flex justify-between items-center mb-6">
              <h3 className="text-xl font-black flex items-center gap-2">
                 <CheckCircle size={20} className="text-accent-foreground" />
                 Zahlungseingänge
              </h3>
              <div className="flex items-center gap-2">
                  <DashboardSettingsPopover
                    fields={[{ key: 'recentPaymentsLimit', label: 'Angezeigte Zahlungen', min: 1, max: 20 }]}
                    values={{ recentPaymentsLimit: dash.recentPaymentsLimit }}
                    onSave={(v) => saveDashboardSettings({ recentPaymentsLimit: v.recentPaymentsLimit })}
                  ><span /></DashboardSettingsPopover>
                  <button
                    type="button"
                    aria-label="Zu den Finanzen"
                    onClick={() => onNavigate('finance')}
                    className="w-10 h-10 rounded-full bg-black/5 flex items-center justify-center hover:bg-black/10 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  >
                      <ArrowUpRight size={18} />
                  </button>
              </div>
          </div>

          <div className="space-y-2">
              {payments.length === 0 ? (
                <EmptyState
                  title="Noch keine Zahlungseingänge"
                  description="Erfasste Zahlungen erscheinen hier, sobald du sie an einer Rechnung einträgst."
                  className="py-6"
                />
              ) : (
                payments.slice(0, dash.recentPaymentsLimit).map((item) => (
                  <button
                    type="button"
                    key={`${item.invoiceId}:${item.date}:${item.amount}`}
                    className="flex w-full items-center justify-between p-3 bg-white/60 rounded-xl border border-white/40 hover:bg-white/80 transition-colors text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    onClick={() =>
                      onNavigate('documents', { kind: 'invoice', id: item.invoiceId })
                    }
                    title={`${item.invoiceNumber}, ${item.client}`}
                  >
                      <div className="min-w-0">
                          <p className="text-xs font-bold text-black/70 mb-0.5">{formatDate(item.date)}</p>
                          <p className="text-sm font-bold truncate">{item.client}</p>
                          <p className="text-xs font-bold text-black/70 truncate">{item.invoiceNumber}</p>
                      </div>
                      <div className="text-right">
                          <p className="text-base font-bold tabular-nums">{formatCurrency(item.amount)}</p>
                          <div className="flex items-center justify-end gap-1 text-black/70">
                             <CreditCard size={12} aria-hidden="true" />
                             <p className="text-xs font-bold">{item.method}</p>
                          </div>
                      </div>
                  </button>
                ))
              )}
          </div>

          <div className="mt-auto pt-6 flex justify-between items-end">
               <div>
                   <p className="text-xs font-bold text-black/70 uppercase">Dieser Monat (Zahlungen)</p>
                   <p className="text-2xl font-bold tabular-nums">{formatCurrency(paymentsThisMonthGross)}</p>
               </div>
          </div>
      </div>

      {/* 4. Taxes (Umsatzsteuer). Tinted surface plus border marks it as a different
          kind of figure than the two revenue cards above it. */}
      <div className="bg-info-bg rounded-2xl p-6 text-foreground min-h-[350px] flex flex-col border border-info-border">
           <div className="flex justify-between items-center mb-8">
              <h3 className="text-xl font-black flex items-center gap-2">
                 <PieChart size={20} className="text-info-text" aria-hidden="true" />
                 Steuerschätzung
              </h3>
              <div className="bg-info-border/50 px-3 py-1 rounded-full text-xs font-bold text-info-text">
                  {taxEstimate.periodLabel}
              </div>
          </div>

          <div className="flex-1 flex flex-col justify-center">
              <div className="text-center mb-8">
                  <p className="text-xs font-bold text-muted uppercase tracking-wide mb-2">
                    {taxEstimate.vat <= 0 ? 'Keine voraussichtliche Umsatzsteuer' : 'Voraussichtliche Umsatzsteuer'}
                  </p>
                  <h2 className="text-5xl font-bold tabular-nums">{formatCurrency(taxEstimate.vat)}</h2>
                  {taxEstimate.vat > 0 && (
                    <p className="text-xs font-bold mt-2 bg-info-border/50 inline-block px-3 py-1 rounded-full text-info-text">
                      Fällig am {taxEstimate.dueLabel}
                    </p>
                  )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                  <div className="bg-surface rounded-xl p-4 border border-info-border">
                      <p className="text-xs font-bold text-muted uppercase mb-1">Netto-Basis ({taxMethod === 'ist' ? 'Ist' : 'Soll'})</p>
                      <p className="text-lg font-bold tabular-nums">{formatCurrency(taxEstimate.net)}</p>
                  </div>
                  <div className="bg-surface rounded-xl p-4 border border-info-border">
                      <p className="text-xs font-bold text-muted uppercase mb-1">Brutto</p>
                      <p className="text-lg font-bold tabular-nums">{formatCurrency(taxEstimate.gross)}</p>
                  </div>
              </div>
          </div>
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
        <div className="bg-surface rounded-2xl shadow-sm p-8 min-h-[80vh]">
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h3 className="font-bold text-2xl text-foreground mb-1">Vorlagen</h3>
                    <p className="text-sm text-muted">Lege das Layout deiner Geschäftsdokumente fest.</p>
                </div>
                <div className="bg-surface-muted p-1 rounded-full flex items-center">
                    <button
                        type="button"
                        onClick={() => setActiveTab('invoice')}
                        className={`px-6 py-2 rounded-full text-xs font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${activeTab === 'invoice' ? 'bg-surface shadow-sm text-foreground' : 'text-muted hover:text-foreground'}`}
                    >
                        Rechnungen
                    </button>
                    <button
                        type="button"
                        onClick={() => setActiveTab('offer')}
                        className={`px-6 py-2 rounded-full text-xs font-bold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${activeTab === 'offer' ? 'bg-surface shadow-sm text-foreground' : 'text-muted hover:text-foreground'}`}
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
                            className="px-4 py-2 rounded-full text-xs font-bold bg-dark-base text-background hover:bg-dark-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
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
                    <span className="font-bold text-muted group-hover:text-foreground text-center px-4">
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
                    <h4 className="font-bold text-lg text-foreground">{t.name}</h4>
                    <p className="text-xs text-muted">A4 • {t.id === activeTemplate?.id ? 'Aktiv' : 'Vorlage'}</p>

                    <button
                        type="button"
                        onClick={(e) => {
                            e.stopPropagation();
                            void setActiveTemplateMutation.mutateAsync({ kind: activeTab, templateId: t.id });
                        }}
                        className={`absolute top-4 left-4 px-3 py-1 rounded-full text-xs font-bold uppercase border transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
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
                        className="absolute bottom-4 right-4 bg-dark-base text-background w-10 h-10 rounded-full flex items-center justify-center motion-safe:transition-opacity motion-reduce:transition-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100"
                    >
                        <ArrowUpRight size={18} aria-hidden="true" />
                    </button>
                </div>
                ))}
            </div>
            )}
        </div>
    );
}
