
import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
    Euro, TrendingUp, TrendingDown, Users, Clock, Plus, ArrowRight, FileText,
    ArrowUpRight, CheckCircle, CreditCard, MoreHorizontal, ShieldCheck,
    PieChart, ArrowLeft, ArrowDownLeft, Search, Link, X, LayoutTemplate, Settings2
} from 'lucide-react';
import { Button } from '@billme/ui';
import { Account, Transaction, Invoice, AppSettings } from '../types';
import { useInvoicesQuery } from '../hooks/useInvoices';
import { useAccountsQuery, useUpsertAccountMutation } from '../hooks/useAccounts';
import { useQueryClient } from '@tanstack/react-query';
import { ipc } from '../ipc/client';
import { useArticlesQuery } from '../hooks/useArticles';
import { useSettingsQuery, useSetSettingsMutation } from '../hooks/useSettings';
import { useOffersQuery } from '../hooks/useOffers';
import { MOCK_SETTINGS } from '../data/mockData';
import {
  useActiveTemplateQuery,
  useSetActiveTemplateMutation,
  useTemplatesQuery,
  useUpsertTemplateMutation,
} from '../hooks/useTemplates';
import type { DocumentTemplate, InvoiceElement } from '../types';
import { INITIAL_INVOICE_TEMPLATE, INITIAL_OFFER_TEMPLATE } from '../constants';
import { v4 as uuidv4 } from 'uuid';

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
  const [pos, setPos] = useState({ top: 0, right: 0 });

  // Sync draft when opening
  useEffect(() => {
    if (open) setDraft(values);
  }, [open, values]);

  // Compute position from button rect (runs every render while open)
  useEffect(() => {
    if (!open || !buttonRef.current) return;
    const update = () => {
      if (!buttonRef.current) return;
      const rect = buttonRef.current.getBoundingClientRect();
      setPos({
        top: rect.bottom + 8,
        right: window.innerWidth - rect.right,
      });
    };
    update();
    // Reposition on scroll/resize so it stays anchored
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

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
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className={`p-1.5 rounded-lg transition-colors ${dark ? 'hover:bg-white/10 text-white/40 hover:text-white/80' : 'hover:bg-gray-100 text-gray-300 hover:text-gray-600'}`}
        title="Einstellungen"
      >
        <Settings2 size={14} />
      </button>
      {open && createPortal(
        <div
          ref={dropdownRef}
          style={{ position: 'fixed', top: pos.top, right: pos.right, zIndex: 9999 }}
          className="bg-white text-black rounded-2xl shadow-2xl border border-gray-200 p-4 min-w-[260px] animate-scale-in"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="space-y-3">
            {fields.map((f) => (
              <div key={f.key}>
                <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">{f.label}</label>
                <input
                  type="number"
                  min={f.min ?? 1}
                  max={f.max}
                  step={f.step ?? 1}
                  value={draft[f.key] ?? 0}
                  onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })}
                  className="w-full bg-gray-100 border border-gray-300 rounded-xl px-3 py-2 text-sm font-mono font-bold text-gray-900 outline-none focus:ring-2 focus:ring-accent focus:border-accent"
                />
              </div>
            ))}
          </div>
          <button
            onClick={() => { onSave(draft); setOpen(false); }}
            className="mt-3 w-full py-2 bg-black text-white rounded-xl text-xs font-bold hover:bg-gray-800 transition-colors"
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
  onNavigate: (page: string) => void;
}

export const DashboardHome: React.FC<ViewProps> = ({ onNavigate }) => {
  const { data: invoices = [] } = useInvoicesQuery();
  const { data: offers = [] } = useOffersQuery();
  const { data: articles = [] } = useArticlesQuery();
  const { data: settingsFromDb } = useSettingsQuery();
  const settings = settingsFromDb ?? MOCK_SETTINGS;
  const setSettingsMutation = useSetSettingsMutation();
  const dash = settings.dashboard;

  const saveDashboardSettings = useCallback((patch: Partial<AppSettings['dashboard']>) => {
    setSettingsMutation.mutate({ ...settings, dashboard: { ...dash, ...patch } });
  }, [settings, dash, setSettingsMutation]);

  const vatRate = settings.legal.smallBusinessRule ? 0 : Number(settings.legal.defaultVatRate) || 0;
  const taxMethod = settings.legal.taxAccountingMethod ?? 'soll';

  const kpis = useMemo(() => {
    const amountFor = (inv: Invoice) => {
      const stored = Number(inv.amount);
      if (Number.isFinite(stored)) return stored;
      const net = (inv.items ?? []).reduce((acc, it) => acc + (Number(it.total) || 0), 0);
      return net + net * (vatRate / 100);
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
  }, [invoices, vatRate, dash.dueSoonDays]);

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

    if (settings.legal.smallBusinessRule) {
      return { periodLabel: now.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' }), net: 0, vat: 0, gross: 0, dueLabel: '' };
    }

    const periodLabel = now.toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
    const dueDate = new Date(y, m + 1, 10);
    const dueLabel = dueDate.toLocaleDateString('de-DE', { day: '2-digit', month: 'long' });

    if (taxMethod === 'ist') {
      // Ist: based on payments, capped per invoice gross.
      const byInvoice = new Map<string, number>();
      for (const inv of invoices) {
        const invDate = new Date(inv.date);
        // payments can be in month even if invoice date differs
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
      for (const inv of invoices) {
        const paid = byInvoice.get(inv.id) ?? 0;
        if (paid <= 0) continue;
        const grossCap = (inv.items ?? []).reduce((acc, it) => acc + (Number(it.total) || 0), 0) * (1 + vatRate / 100);
        const applied = Math.min(paid, Number.isFinite(grossCap) && grossCap > 0 ? grossCap : paid);
        gross += applied;
      }
      const net = gross / (1 + vatRate / 100);
      const vat = gross - net;
      return { periodLabel, net, vat, gross, dueLabel };
    }

    // Soll: based on issued invoices in month.
    const issued = invoices
      .filter((inv) => inv.status !== 'draft')
      .filter((inv) => {
        const d = new Date(inv.date);
        return d.getFullYear() === y && d.getMonth() === m;
      });

    const net = issued.reduce(
      (acc, inv) => acc + (inv.items ?? []).reduce((s, it) => s + (Number(it.total) || 0), 0),
      0,
    );
    const vat = net * (vatRate / 100);
    const gross = net + vat;
    return { periodLabel, net, vat, gross, dueLabel };
  }, [invoices, settings, taxMethod, vatRate]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 pb-8">
      
      {/* 1. Dark Card - Open Invoices / Liquidity */}
      <div className="bg-[#1c1c1c] rounded-[2.5rem] p-8 text-white relative overflow-hidden min-h-[420px] flex flex-col justify-between group shadow-xl animate-enter premium-hover">
         {/* Decorative elements */}
         <div className="absolute top-0 right-0 w-64 h-64 bg-accent rounded-full blur-[100px] opacity-10 group-hover:opacity-20 transition-opacity duration-700"></div>

         <div className="relative z-10">
             <div className="flex justify-between items-start mb-12">
                 <div className="p-3 bg-white/10 rounded-2xl backdrop-blur-md border border-white/10">
                    <TrendingUp size={24} className="text-accent" />
                 </div>
                 <div className="flex gap-2 items-center">
                     <DashboardSettingsPopover
                       dark
                       fields={[{ key: 'dueSoonDays', label: 'Fällig in X Tagen', min: 1, max: 90 }]}
                       values={{ dueSoonDays: dash.dueSoonDays }}
                       onSave={(v) => saveDashboardSettings({ dueSoonDays: v.dueSoonDays })}
                     ><span /></DashboardSettingsPopover>
                     <button onClick={() => onNavigate('documents')} className="px-3 py-1.5 rounded-lg border border-white/10 flex items-center gap-2 hover:bg-white/10 transition-colors text-xs font-bold">
                         Alle ansehen <ArrowUpRight size={14} />
                     </button>
                 </div>
             </div>

             <div className="mb-4">
                 <p className="text-gray-400 text-sm font-bold uppercase tracking-wider mb-2">Offene Forderungen</p>
                 <h2 className="text-5xl font-mono font-bold tracking-tight mb-4">{formatCurrency(kpis.outstandingTotal)}</h2>
                 
                 <div className="flex flex-col gap-3">
                     <div className="flex items-center justify-between bg-white/5 p-3 rounded-xl border border-white/5 hover:bg-white/10 transition-colors">
                        <div className="flex items-center gap-3">
                            <div className="w-2 h-2 rounded-full bg-error shadow-[0_0_10px_rgba(220,38,38,0.5)]"></div>
                            <span className="text-sm font-bold text-gray-200">Überfällig ({kpis.overdueCount})</span>
                        </div>
                        <span className="font-mono font-bold text-error">{formatCurrency(kpis.overdueTotal)}</span>
                     </div>
                     <div className="flex items-center justify-between bg-white/5 p-3 rounded-xl border border-white/5 hover:bg-white/10 transition-colors">
                        <div className="flex items-center gap-3">
                            <div className="w-2 h-2 rounded-full bg-accent shadow-[0_0_10px_rgba(217,249,68,0.5)]"></div>
                            <span className="text-sm font-bold text-gray-200">Fällig in {dash.dueSoonDays} Tagen ({kpis.dueSoonCount})</span>
                        </div>
                        <span className="font-mono font-bold text-accent">{formatCurrency(kpis.dueSoonTotal)}</span>
                     </div>
                 </div>
             </div>
         </div>

         <div className="relative z-10 pt-6 border-t border-white/10">
             <div className="flex justify-between items-end">
                <div>
                     <p className="text-gray-500 text-xs font-medium">Liquiditätsprognose</p>
                     {paymentTrend !== null ? (
                       <p className="text-white text-sm font-bold flex items-center gap-2 mt-1">
                          <span className={`${paymentTrend >= 0 ? 'bg-success/20 text-success' : 'bg-error/20 text-error'} px-1.5 py-1 rounded text-[10px] flex items-center gap-0.5`}>
                            {paymentTrend >= 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                            {paymentTrend >= 0 ? '+' : ''}{paymentTrend}%
                          </span>
                          zum Vormonat
                       </p>
                     ) : (
                       <p className="text-gray-500 text-xs mt-1">Keine Vormonatsdaten</p>
                     )}
                </div>
                <button
                    onClick={() => onNavigate('documents?kind=invoice')}
                    className="bg-accent text-black px-6 py-3 rounded-xl font-bold text-sm hover:bg-accent-hover hover:scale-105 active:scale-95 transition-all shadow-lg shadow-accent/20"
                >
                    Mahnung senden
                </button>
             </div>
         </div>
      </div>

      {/* 2. White Card - Revenue / Bestsellers */}
      <div className="bg-white rounded-[2.5rem] p-8 text-black relative overflow-hidden min-h-[420px] flex flex-col shadow-sm animate-enter delay-100 premium-hover">
          <div className="flex justify-between items-start mb-8">
             <div>
                <h3 className="text-2xl font-black mb-1">Umsatz (aktueller Monat)</h3>
                <p className="text-gray-400 text-xs font-bold uppercase">Laufendes Geschäftsjahr</p>
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
                 <div className="p-3 bg-gray-50 rounded-2xl">
                     <Euro size={24} className="text-black" />
                 </div>
             </div>
          </div>

          <div className="mb-8">
              <h2 className="text-5xl font-mono font-bold mb-2">{formatCurrency(kpis.monthRevenueNet)}</h2>
              <p className="text-xs text-gray-400 font-bold uppercase tracking-wider mt-2">
                Gestellte Rechnungen: {kpis.monthIssuedCount}
              </p>
              <div className="w-full bg-gray-100 h-3 rounded-full overflow-hidden mt-4">
                  <div
                    className="bg-black h-full rounded-full relative"
                    style={{ width: `${Math.min(100, (kpis.monthRevenueNet / dash.monthlyRevenueGoal) * 100)}%` }}
                  >
                      <div className="absolute right-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-white/50 rounded-full"></div>
                  </div>
              </div>
              <div className="flex justify-between mt-2 text-xs font-bold text-gray-400">
                  <span>0 €</span>
                  <span>Ziel: {formatCurrency(dash.monthlyRevenueGoal)}</span>
              </div>
          </div>

          <div className="flex-1 flex flex-col justify-end gap-4">
              <h4 className="font-bold text-sm text-gray-900">Top Einnahmequellen</h4>
              
              <div className="space-y-3">
                  {topCategories.length === 0 ? (
                    <div className="p-3 border border-gray-100 rounded-2xl text-sm text-gray-400">
                      Noch keine Umsätze in diesem Monat.
                    </div>
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
                          onClick={() => onNavigate(`articles?query=${encodeURIComponent(row.category)}`)}
                          className="flex items-center justify-between p-3 border border-gray-100 rounded-2xl hover:bg-gray-50 transition-colors cursor-pointer"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <div className="w-10 h-10 rounded-xl bg-gray-100 text-gray-700 flex items-center justify-center font-bold text-xs shrink-0">
                              {initials || '—'}
                            </div>
                            <div className="min-w-0">
                              <span className="font-bold text-sm block truncate">{row.category}</span>
                              <span className="text-[10px] text-gray-400 font-bold">
                                {row.invoiceCount} Rechnung(en)
                              </span>
                            </div>
                          </div>
                          <span className="font-mono font-bold text-lg">{formatCurrency(row.amount)}</span>
                        </button>
                      );
                    })
                  )}
              </div>

              <div className="mt-5 p-4 rounded-2xl border border-gray-100 bg-gray-50">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <p className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Pipeline (Angebote)</p>
                    <p className="text-sm font-bold text-gray-900">Potenzial (Netto)</p>
                  </div>
                  <div className="text-lg font-mono font-bold text-gray-900">{formatCurrency(offerPipeline.potentialNet)}</div>
                </div>
                <div className="text-[10px] text-gray-500 font-bold">
                  Basis: veröffentlicht/verschickt (Portal) • Offen: {offerPipeline.activeCount} • Angenommen: {offerPipeline.acceptedCount} • Abgelehnt: {offerPipeline.declinedCount}
                </div>
              </div>
          </div>
      </div>

      {/* 3. Lime Card - Recent Payments */}
      <div className="bg-accent rounded-[2.5rem] p-8 text-black min-h-[350px] flex flex-col shadow-sm relative overflow-hidden group animate-enter delay-200 premium-hover">
          <div className="absolute top-0 right-0 w-48 h-48 bg-white opacity-20 rounded-full blur-[60px] transform translate-x-10 -translate-y-10 group-hover:scale-110 transition-transform duration-700"></div>
          
          <div className="flex justify-between items-center mb-6 relative z-10">
              <h3 className="text-xl font-black flex items-center gap-2">
                 <CheckCircle size={20} className="text-black/80" />
                 Zahlungseingänge
              </h3>
              <div className="flex items-center gap-2">
                  <DashboardSettingsPopover
                    fields={[{ key: 'recentPaymentsLimit', label: 'Angezeigte Zahlungen', min: 1, max: 20 }]}
                    values={{ recentPaymentsLimit: dash.recentPaymentsLimit }}
                    onSave={(v) => saveDashboardSettings({ recentPaymentsLimit: v.recentPaymentsLimit })}
                  ><span /></DashboardSettingsPopover>
                  <button onClick={() => onNavigate('finance')} className="w-10 h-10 rounded-full bg-black/5 flex items-center justify-center hover:bg-black/10 transition-colors">
                      <ArrowUpRight size={18} />
                  </button>
              </div>
          </div>

          <div className="space-y-2 relative z-10">
              {payments.length === 0 ? (
                <div className="p-4 bg-white/40 backdrop-blur-sm rounded-2xl border border-white/20 text-sm font-bold opacity-70">
                  Noch keine Zahlungen erfasst.
                </div>
              ) : (
                payments.slice(0, dash.recentPaymentsLimit).map((item) => (
                  <div
                    key={`${item.invoiceId}:${item.date}:${item.amount}`}
                    className="flex items-center justify-between p-3 bg-white/40 backdrop-blur-sm rounded-2xl border border-white/20 hover:bg-white/60 transition-colors cursor-pointer hover:scale-[1.02]"
                    onClick={() =>
                      onNavigate(`documents?kind=invoice&id=${encodeURIComponent(item.invoiceId)}`)
                    }
                    title={`${item.invoiceNumber} — ${item.client}`}
                  >
                      <div className="min-w-0">
                          <p className="text-xs font-bold opacity-60 mb-0.5">{formatDate(item.date)}</p>
                          <p className="text-sm font-bold truncate">{item.client}</p>
                          <p className="text-[10px] font-bold opacity-50 truncate">{item.invoiceNumber}</p>
                      </div>
                      <div className="text-right">
                          <p className="text-base font-mono font-bold">{formatCurrency(item.amount)}</p>
                          <div className="flex items-center justify-end gap-1 opacity-50">
                             <CreditCard size={10} />
                             <p className="text-[10px] font-bold">{item.method}</p>
                          </div>
                      </div>
                  </div>
                ))
              )}
          </div>
          
          <div className="mt-auto pt-6 flex justify-between items-end relative z-10">
               <div>
                   <p className="text-xs font-bold opacity-50 uppercase">Dieser Monat (Zahlungen)</p>
                   <p className="text-2xl font-mono font-bold">{formatCurrency(paymentsThisMonthGross)}</p>
               </div>
          </div>
      </div>

      {/* 4. Info Card - Taxes (Umsatzsteuer) */}
      <div className="bg-info rounded-[2.5rem] p-6 text-black min-h-[350px] flex flex-col shadow-sm relative overflow-hidden animate-enter delay-300 premium-hover">
           <div className="flex justify-between items-center mb-8">
              <h3 className="text-xl font-black flex items-center gap-2">
                 <PieChart size={20} />
                 Steuerschätzung
              </h3>
              <div className="bg-white/20 px-3 py-1 rounded-full text-xs font-bold text-black/80">
                  {taxEstimate.periodLabel}
              </div>
          </div>

          <div className="flex-1 flex flex-col justify-center">
              <div className="text-center mb-8">
                  <p className="text-xs font-bold opacity-60 uppercase tracking-widest mb-2">
                    {settings.legal.smallBusinessRule ? 'Kleinunternehmerregelung (§19) — keine USt' : 'Voraussichtliche Umsatzsteuer'}
                  </p>
                  <h2 className="text-5xl font-mono font-bold">{formatCurrency(taxEstimate.vat)}</h2>
                  {!settings.legal.smallBusinessRule && (
                    <p className="text-xs font-bold mt-2 bg-black/5 inline-block px-3 py-1 rounded-full text-black/60">
                      Fällig am {taxEstimate.dueLabel}
                    </p>
                  )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                  <div className="bg-white/20 backdrop-blur-sm rounded-2xl p-4 border border-white/10 hover:bg-white/30 transition-colors">
                      <p className="text-[10px] font-bold opacity-60 uppercase mb-1">Netto-Basis ({taxMethod === 'ist' ? 'Ist' : 'Soll'})</p>
                      <p className="text-lg font-mono font-bold">{formatCurrency(taxEstimate.net)}</p>
                  </div>
                  <div className="bg-white/20 backdrop-blur-sm rounded-2xl p-4 border border-white/10 hover:bg-white/30 transition-colors">
                      <p className="text-[10px] font-bold opacity-60 uppercase mb-1">Brutto</p>
                      <p className="text-lg font-mono font-bold">{formatCurrency(taxEstimate.gross)}</p>
                  </div>
              </div>
          </div>
      </div>

    </div>
  );
};

export const AccountsView: React.FC = () => {
    const { data: accounts = [] } = useAccountsQuery();
    const upsertAccount = useUpsertAccountMutation();
    const { data: invoices = [] } = useInvoicesQuery();
    const queryClient = useQueryClient();
    const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
    const [linkingTransactionId, setLinkingTransactionId] = useState<string | null>(null);
    const [isLinkModalOpen, setIsLinkModalOpen] = useState(false);
    const [invoiceSearch, setInvoiceSearch] = useState('');
    const [isAddAccountOpen, setIsAddAccountOpen] = useState(false);
    const [newAccount, setNewAccount] = useState<Account>({
        id: uuidv4(),
        name: '',
        iban: '',
        balance: 0,
        type: 'bank',
        color: 'bg-white',
        transactions: [],
    });

    type ImportProfile = 'auto' | 'fints' | 'paypal' | 'stripe' | 'generic';
    type ImportMapping = {
      dateColumn: string;
      amountColumn: string;
      counterpartyColumn?: string;
      purposeColumn?: string;
      statusColumn?: string;
      externalIdColumn?: string;
      currencyColumn?: string;
      currencyExpected?: string;
    };

    const [isImportOpen, setIsImportOpen] = useState(false);
    const [importPath, setImportPath] = useState<string | null>(null);
    const [importProfile, setImportProfile] = useState<ImportProfile>('auto');
    const [importMapping, setImportMapping] = useState<ImportMapping | null>(null);
    const [importEncoding, setImportEncoding] = useState<'utf8' | 'win1252'>('utf8');
    const [importDelimiter, setImportDelimiter] = useState<string>('');
    const [importPreview, setImportPreview] = useState<any>(null);
    const [importError, setImportError] = useState<string | null>(null);
    const [importResult, setImportResult] = useState<{ imported: number; skipped: number; errors: number } | null>(null);
    const [importPreviewPage, setImportPreviewPage] = useState(0);
    const [showOnlyErrors, setShowOnlyErrors] = useState(false);
    const ROWS_PER_PAGE = 100;
    const [isImportBusy, setIsImportBusy] = useState(false);

    const selectedAccount = accounts.find(a => a.id === selectedAccountId);

    const closeImport = () => {
      setIsImportOpen(false);
      setImportPath(null);
      setImportProfile('auto');
      setImportMapping(null);
      setImportDelimiter('');
      setImportPreview(null);
      setImportError(null);
      setImportResult(null);
      setIsImportBusy(false);
    };

    const refreshImportPreview = async (opts?: { path?: string; profile?: ImportProfile; mapping?: ImportMapping | null }) => {
      if (!selectedAccount) return;
      const filePath = opts?.path ?? importPath;
      if (!filePath) return;
      const profile = opts?.profile ?? importProfile;
      const mapping = opts?.mapping ?? importMapping;
      setImportError(null);
      setIsImportBusy(true);
      try {
        const res = await ipc.finance.importPreview({
          path: filePath,
          profile,
          mapping: mapping ?? undefined,
          encoding: importEncoding,
          delimiter: importDelimiter || undefined,
          maxRows: 50,
          accountIdForDedupHash: selectedAccount.id,
        });
        setImportPreview(res);
        setImportMapping(mapping ?? res.suggestedMapping);
      } catch (e) {
        setImportError(String(e));
      } finally {
        setIsImportBusy(false);
      }
    };

    const openImportWithPicker = async () => {
      if (!selectedAccount) return;
      setImportResult(null);
      const res = await ipc.dialog.pickCsv({ title: 'CSV importieren' });
      if (!res.path) return;
      setIsImportOpen(true);
      setImportPath(res.path);
      setImportProfile('auto');
      setImportMapping(null);
      setImportDelimiter('');
      setImportPreview(null);
      setImportError(null);
      await refreshImportPreview({ path: res.path, profile: 'auto', mapping: null });
    };

    const commitImport = async () => {
      if (!selectedAccount || !importPath || !importMapping) return;
      setIsImportBusy(true);
      setImportError(null);
      try {
        const res = await ipc.finance.importCommit({
          path: importPath,
          accountId: selectedAccount.id,
          profile: importProfile,
          mapping: importMapping,
          encoding: importEncoding,
          delimiter: importDelimiter || undefined,
        });
        setImportResult({ imported: res.imported, skipped: res.skipped, errors: res.errors.length });
        await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      } catch (e) {
        setImportError(String(e));
      } finally {
        setIsImportBusy(false);
      }
    };

    const handleLinkClick = (transactionId: string) => {
        setLinkingTransactionId(transactionId);
        setIsLinkModalOpen(true);
    };

    const handleConfirmLink = (invoiceId: string) => {
        if (!linkingTransactionId || !selectedAccountId) return;
        const acc = accounts.find((a) => a.id === selectedAccountId);
        if (!acc) return;
        upsertAccount.mutate({
            ...acc,
            transactions: acc.transactions.map(t => 
                t.id === linkingTransactionId 
                ? { ...t, linkedInvoiceId: invoiceId } 
                : t
            )
        });

        setIsLinkModalOpen(false);
        setLinkingTransactionId(null);
    };

    const filteredInvoices = invoices.filter(inv => 
        (inv.status === 'open' || inv.status === 'overdue') &&
        (inv.number.toLowerCase().includes(invoiceSearch.toLowerCase()) || 
         inv.client.toLowerCase().includes(invoiceSearch.toLowerCase()))
    );

    // --- Detail View ---
    if (selectedAccount) {
        return (
            <div className="bg-white rounded-[2.5rem] shadow-sm overflow-hidden p-8 min-h-full flex flex-col relative animate-enter">
                
                {/* CSV Import Modal */}
                {isImportOpen && (
                  <div className="absolute inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4 rounded-[2.5rem] animate-fade-in">
                    <div className="bg-white rounded-3xl shadow-2xl w-full max-w-3xl overflow-hidden flex flex-col max-h-[85vh] animate-scale-in">
                      <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50">
                        <div>
                          <h3 className="font-bold text-lg">CSV Import</h3>
                          <p className="text-xs text-gray-500 mt-1">Konto: {selectedAccount.name}</p>
                        </div>
                        <button onClick={closeImport} className="p-2 hover:bg-gray-200 rounded-full transition-colors"><X size={18} /></button>
                      </div>

                      <div className="p-6 overflow-y-auto">
                        <div className="flex flex-wrap gap-3 items-end">
                          <div className="flex-1 min-w-[260px]">
                            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Datei</label>
                            <div className="flex gap-2">
                              <input
                                value={importPath ?? ''}
                                readOnly
                                className="flex-1 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-sm font-mono"
                              />
                              <button
                                disabled={isImportBusy}
                                onClick={openImportWithPicker}
                                className="px-4 py-2 rounded-xl font-bold bg-white border border-gray-200 hover:bg-gray-50 transition-colors text-sm"
                              >
                                Ändern
                              </button>
                            </div>
                          </div>

                          <div>
                            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Profil</label>
                            <select
                              value={importProfile}
                              onChange={async (e) => {
                                const p = e.target.value as ImportProfile;
                                setImportProfile(p);
                                setImportMapping(null);
                                await refreshImportPreview({ profile: p, mapping: null });
                              }}
                              className="bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-sm font-bold"
                            >
                              <option value="auto">Auto</option>
                              <option value="fints">FinTS</option>
                              <option value="paypal">PayPal</option>
                              <option value="stripe">Stripe</option>
                              <option value="generic">Generic</option>
                            </select>
                          </div>

                          <div>
                            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Encoding</label>
                            <select
                              value={importEncoding}
                              onChange={async (e) => {
                                const enc = e.target.value as 'utf8' | 'win1252';
                                setImportEncoding(enc);
                                await refreshImportPreview({});
                              }}
                              className="bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-sm font-bold"
                            >
                              <option value="utf8">UTF-8</option>
                              <option value="win1252">Windows-1252</option>
                            </select>
                          </div>

                          <div>
                            <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Delimiter</label>
                            <input
                              value={importDelimiter}
                              onChange={(e) => setImportDelimiter(e.target.value)}
                              placeholder="(auto)"
                              className="w-28 bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-sm font-mono"
                            />
                          </div>

                          <button
                            disabled={isImportBusy || !importPath}
                            onClick={() => refreshImportPreview({})}
                            className="px-4 py-2 rounded-xl font-bold bg-black text-white hover:bg-gray-800 transition-colors text-sm"
                          >
                            Vorschau
                          </button>
                        </div>

                        {importPreview && importMapping && (
                          <>
                            <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-4">
                              <div>
                                <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Datum</label>
                                <select
                                  value={importMapping.dateColumn}
                                  onChange={(e) => setImportMapping({ ...importMapping, dateColumn: e.target.value })}
                                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-sm font-bold"
                                >
                                  {importPreview.headers.map((h: string) => <option key={h} value={h}>{h}</option>)}
                                </select>
                              </div>
                              <div>
                                <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Betrag</label>
                                <select
                                  value={importMapping.amountColumn}
                                  onChange={(e) => setImportMapping({ ...importMapping, amountColumn: e.target.value })}
                                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-sm font-bold"
                                >
                                  {importPreview.headers.map((h: string) => <option key={h} value={h}>{h}</option>)}
                                </select>
                              </div>
                              <div>
                                <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Gegenpartei</label>
                                <select
                                  value={importMapping.counterpartyColumn ?? ''}
                                  onChange={(e) => setImportMapping({ ...importMapping, counterpartyColumn: e.target.value || undefined })}
                                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-sm font-bold"
                                >
                                  <option value="">(leer)</option>
                                  {importPreview.headers.map((h: string) => <option key={h} value={h}>{h}</option>)}
                                </select>
                              </div>
                              <div>
                                <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Zweck</label>
                                <select
                                  value={importMapping.purposeColumn ?? ''}
                                  onChange={(e) => setImportMapping({ ...importMapping, purposeColumn: e.target.value || undefined })}
                                  className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-2 text-sm font-bold"
                                >
                                  <option value="">(leer)</option>
                                  {importPreview.headers.map((h: string) => <option key={h} value={h}>{h}</option>)}
                                </select>
                              </div>
                            </div>

                            <div className="mt-6 flex items-center justify-between">
                              <div className="text-sm text-gray-600">
                                <span className="font-bold">{importPreview.stats.validRows}</span> ok ·{' '}
                                <span className="font-bold">{importPreview.stats.errorRows}</span> Fehler ·{' '}
                                <span className="font-bold">{importPreview.stats.totalRows}</span> Zeilen
                              </div>
                              <button
                                disabled={isImportBusy || !importMapping}
                                onClick={commitImport}
                                className="px-5 py-3 rounded-2xl font-bold bg-accent text-black hover:bg-accent-hover transition-colors"
                              >
                                Import starten
                              </button>
                            </div>

                            {importError && (
                              <div className="mt-4 p-4 rounded-2xl border border-error/30 bg-error-bg text-error font-mono text-xs">
                                {importError}
                              </div>
                            )}

                            {importResult && (
                              <div className="mt-4 p-4 rounded-2xl border border-success/30 bg-success-bg text-success text-sm">
                                <div className="font-bold mb-1">Import abgeschlossen</div>
                                <div>Importiert: <span className="font-bold">{importResult.imported}</span></div>
                                <div>Übersprungen (Duplikate): <span className="font-bold">{importResult.skipped}</span></div>
                                <div>Fehler: <span className="font-bold">{importResult.errors}</span></div>
                              </div>
                            )}

                            <div className="mt-6">
                              <div className="flex items-center justify-between mb-2">
                                <h4 className="font-bold text-xs uppercase text-gray-400">Vorschau</h4>
                                {importPreview.stats.errorRows > 0 && (
                                  <button
                                    onClick={() => setShowOnlyErrors(!showOnlyErrors)}
                                    className="px-3 py-1 rounded-lg bg-gray-100 hover:bg-gray-200 text-xs font-bold transition-colors"
                                  >
                                    {showOnlyErrors ? 'Alle zeigen' : 'Nur Fehler'}
                                  </button>
                                )}
                              </div>
                              <div className="border border-gray-100 rounded-2xl overflow-hidden">
                                <table className="w-full text-sm">
                                  <thead className="bg-gray-50">
                                    <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500">
                                      <th className="px-4 py-3">Datum</th>
                                      <th className="px-4 py-3">Betrag</th>
                                      <th className="px-4 py-3">Gegenpartei</th>
                                      <th className="px-4 py-3">Zweck</th>
                                      <th className="px-4 py-3">Status</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {(() => {
                                      const filteredRows = showOnlyErrors
                                        ? importPreview.rows.filter((r: any) => r.errors.length > 0)
                                        : importPreview.rows;
                                      const startIndex = importPreviewPage * ROWS_PER_PAGE;
                                      const paginatedRows = filteredRows.slice(startIndex, startIndex + ROWS_PER_PAGE);
                                      return paginatedRows.map((r: any) => (
                                      <tr key={r.rowIndex} className={`border-t ${r.errors.length ? 'bg-error-bg/40' : ''}`}>
                                        <td className="px-4 py-3 font-mono text-xs">{r.parsed.date ?? '-'}</td>
                                        <td className="px-4 py-3 font-mono text-xs">{typeof r.parsed.amount === 'number' ? formatCurrency(r.parsed.amount) : '-'}</td>
                                        <td className="px-4 py-3">{r.parsed.counterparty ?? ''}</td>
                                        <td className="px-4 py-3 text-gray-600">{r.parsed.purpose ?? ''}</td>
                                        <td className="px-4 py-3">
                                          {r.errors.length ? (
                                            <span className="text-[10px] font-bold px-2 py-1 rounded bg-error-bg text-error">Fehler</span>
                                          ) : (
                                            <span className="text-[10px] font-bold px-2 py-1 rounded bg-success-bg text-success">OK</span>
                                          )}
                                        </td>
                                      </tr>
                                    ));
                                    })()}
                                  </tbody>
                                </table>
                              </div>

                              {/* Pagination Controls */}
                              {(() => {
                                const filteredRows = showOnlyErrors
                                  ? importPreview.rows.filter((r: any) => r.errors.length > 0)
                                  : importPreview.rows;
                                const totalPages = Math.ceil(filteredRows.length / ROWS_PER_PAGE);

                                if (totalPages <= 1) return null;

                                return (
                                  <div className="mt-3 flex items-center justify-between text-sm">
                                    <div className="text-gray-600">
                                      Seite {importPreviewPage + 1} von {totalPages} ({filteredRows.length} Zeilen)
                                    </div>
                                    <div className="flex gap-2">
                                      <button
                                        onClick={() => setImportPreviewPage(Math.max(0, importPreviewPage - 1))}
                                        disabled={importPreviewPage === 0}
                                        className="px-3 py-1 rounded-lg bg-gray-100 hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed font-bold transition-colors"
                                      >
                                        Zurück
                                      </button>
                                      <button
                                        onClick={() => setImportPreviewPage(Math.min(totalPages - 1, importPreviewPage + 1))}
                                        disabled={importPreviewPage >= totalPages - 1}
                                        className="px-3 py-1 rounded-lg bg-gray-100 hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed font-bold transition-colors"
                                      >
                                        Weiter
                                      </button>
                                    </div>
                                  </div>
                                );
                              })()}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )}
                
                {/* Linking Modal */}
                {isLinkModalOpen && (
                    <div className="absolute inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4 rounded-[2.5rem] animate-fade-in">
                        <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden flex flex-col max-h-[600px] animate-scale-in">
                            <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50">
                                <h3 className="font-bold text-lg flex items-center gap-2">
                                    <Link size={18} />
                                    Transaktion zuweisen
                                </h3>
                                <button onClick={() => setIsLinkModalOpen(false)} className="p-2 hover:bg-gray-200 rounded-full transition-colors"><X size={18} /></button>
                            </div>
                            
                            <div className="p-4 border-b border-gray-100">
                                <div className="relative">
                                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
                                    <input 
                                        type="text" 
                                        placeholder="Rechnung oder Kunde suchen..."
                                        value={invoiceSearch}
                                        onChange={(e) => setInvoiceSearch(e.target.value)}
                                        className="w-full bg-gray-50 border border-gray-200 rounded-xl pl-10 pr-4 py-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none transition-shadow"
                                    />
                                </div>
                            </div>

                            <div className="overflow-y-auto p-4 space-y-2">
                                {filteredInvoices.length > 0 ? filteredInvoices.map(inv => (
                                    <div 
                                        key={inv.id}
                                        onClick={() => handleConfirmLink(inv.id)}
                                        className="p-4 rounded-xl border border-gray-100 hover:border-black hover:bg-gray-50 cursor-pointer transition-all group"
                                    >
                                        <div className="flex justify-between items-center mb-1">
                                            <span className="font-bold text-sm">{inv.number}</span>
                                            <span className="font-mono font-bold text-sm">{formatCurrency(inv.amount)}</span>
                                        </div>
                                        <div className="flex justify-between items-center">
                                            <span className="text-xs text-gray-500">{inv.client}</span>
                                            <span className={`text-[10px] font-bold px-2 py-1 rounded ${inv.status === 'overdue' ? 'bg-error-bg text-error' : 'bg-success-bg text-success'}`}>
                                                {inv.status.toUpperCase()}
                                            </span>
                                        </div>
                                    </div>
                                )) : (
                                    <div className="text-center py-8 text-gray-400">
                                        <FileText size={32} className="mx-auto mb-2 opacity-20" />
                                        <p className="text-sm">Keine offenen Rechnungen gefunden.</p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* Header */}
                <div className="flex items-center justify-between mb-8 pb-8 border-b border-gray-100">
                    <div className="flex items-center gap-4">
                        <button 
                            onClick={() => setSelectedAccountId(null)}
                            className="w-10 h-10 rounded-full border border-gray-200 flex items-center justify-center hover:bg-black hover:text-white transition-colors"
                        >
                            <ArrowLeft size={18} />
                        </button>
                        <div>
                            <h3 className="font-bold text-2xl text-gray-900">{selectedAccount.name}</h3>
                            <p className="text-gray-400 font-mono text-sm">{selectedAccount.iban}</p>
                        </div>
                    </div>
                    <div className="flex items-end gap-3">
                        <button
                          onClick={openImportWithPicker}
                          className="h-10 px-4 bg-black text-white rounded-full text-xs font-bold hover:bg-gray-800 transition-colors flex items-center gap-2"
                        >
                          CSV importieren
                        </button>
                        <div className="text-right">
                            <p className="text-xs font-bold text-gray-400 uppercase tracking-wide">Aktueller Saldo</p>
                            <p className="text-4xl font-mono font-bold">{formatCurrency(selectedAccount.balance)}</p>
                        </div>
                    </div>
                </div>

                {/* Transactions List */}
                <div className="flex-1 overflow-y-auto">
                    <h4 className="font-bold text-sm mb-4 uppercase text-gray-400">Buchungen</h4>
                    <div className="space-y-3">
                        {selectedAccount.transactions.map((tx, i) => {
                            const linkedInvoice = tx.linkedInvoiceId 
                                ? invoices.find(i => i.id === tx.linkedInvoiceId) 
                                : null;

                            return (
                                <div 
                                    key={tx.id} 
                                    className="group flex items-center justify-between p-4 rounded-2xl border border-gray-100 hover:border-gray-300 hover:shadow-md transition-all bg-white animate-enter"
                                    style={{ animationDelay: `${i * 50}ms` }}
                                >
                                    <div className="flex items-center gap-4">
                                        <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${tx.type === 'income' ? 'bg-accent/20 text-black' : 'bg-gray-100 text-gray-500'}`}>
                                            {tx.type === 'income' ? <ArrowDownLeft size={20} /> : <ArrowUpRight size={20} />}
                                        </div>
                                        <div>
                                            <p className="font-bold text-gray-900">{tx.counterparty}</p>
                                            <div className="flex items-center gap-2">
                                                <span className="text-xs text-gray-400 font-mono">{new Date(tx.date).toLocaleDateString()}</span>
                                                <span className="text-xs text-gray-500 line-clamp-1 max-w-[200px]">{tx.purpose}</span>
                                            </div>
                                        </div>
                                    </div>
                                    
                                    <div className="flex items-center gap-6">
                                        {/* Status / Actions */}
                                        <div className="flex flex-col items-end gap-1">
                                            <p className={`font-mono font-bold text-lg ${tx.type === 'income' ? 'text-success' : 'text-gray-900'}`}>
                                                {tx.type === 'income' ? '+' : ''}{formatCurrency(tx.amount)}
                                            </p>
                                            
                                            {linkedInvoice ? (
                                                <div className="flex items-center gap-1.5 bg-success-bg text-success px-2 py-1 rounded text-[10px] font-bold border border-success/30">
                                                    <Link size={10} />
                                                    <span>{linkedInvoice.number}</span>
                                                </div>
                                            ) : (
                                                tx.type === 'income' && (
                                                    <button 
                                                        onClick={() => handleLinkClick(tx.id)}
                                                        className="flex items-center gap-1.5 bg-black text-accent px-3 py-1 rounded text-[10px] font-bold hover:bg-gray-800 transition-colors opacity-0 group-hover:opacity-100 transform translate-y-1 group-hover:translate-y-0 duration-200"
                                                    >
                                                        <Link size={10} />
                                                        Zuweisen
                                                    </button>
                                                )
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                        {selectedAccount.transactions.length === 0 && (
                             <div className="text-center py-12 text-gray-400">
                                <p>Keine Transaktionen vorhanden.</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    // --- Overview View ---
    return (
        <div className="bg-white rounded-[2.5rem] shadow-sm overflow-hidden p-8 h-full animate-enter">
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h3 className="font-bold text-2xl text-gray-900">Geschäftskonten</h3>
                </div>
                <button
                  onClick={() => {
                    setNewAccount({
                      id: uuidv4(),
                      name: '',
                      iban: '',
                      balance: 0,
                      type: 'bank',
                      color: 'bg-white',
                      transactions: [],
                    });
                    setIsAddAccountOpen(true);
                  }}
                  className="bg-black text-white px-6 py-3 rounded-full text-sm font-bold hover:bg-gray-800 hover:scale-105 active:scale-95 transition-all flex items-center gap-2 shadow-lg"
                >
                    <Plus size={16} />
                    Konto hinzufügen
                </button>
            </div>

            {/* Add Account Modal */}
            {isAddAccountOpen && (
              <div className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm flex items-center justify-center p-4">
                <div className="bg-white rounded-3xl shadow-2xl w-full max-w-lg overflow-hidden">
                  <div className="p-6 border-b border-gray-100 flex justify-between items-center bg-gray-50">
                    <h3 className="font-bold text-lg">Konto hinzufügen</h3>
                    <button onClick={() => setIsAddAccountOpen(false)} className="p-2 hover:bg-gray-200 rounded-full transition-colors"><X size={18} /></button>
                  </div>
                  <div className="p-6 space-y-4">
                    <div>
                      <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Name</label>
                      <input
                        value={newAccount.name}
                        onChange={(e) => setNewAccount({ ...newAccount, name: e.target.value })}
                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm font-bold outline-none focus:ring-2 focus:ring-accent"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Typ</label>
                        <select
                          value={newAccount.type}
                          onChange={(e) => setNewAccount({ ...newAccount, type: e.target.value as any })}
                          className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-3 text-sm font-bold"
                        >
                          <option value="bank">Bank</option>
                          <option value="paypal">PayPal</option>
                          <option value="cash">Cash</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Startsaldo</label>
                        <input
                          type="number"
                          value={newAccount.balance}
                          onChange={(e) => setNewAccount({ ...newAccount, balance: Number(e.target.value) })}
                          className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-3 text-sm font-mono font-bold"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">IBAN / Identifier</label>
                      <input
                        value={newAccount.iban}
                        onChange={(e) => setNewAccount({ ...newAccount, iban: e.target.value })}
                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 text-sm font-mono outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-gray-500 uppercase tracking-wider mb-1">Farbe</label>
                      <select
                        value={newAccount.color}
                        onChange={(e) => setNewAccount({ ...newAccount, color: e.target.value })}
                        className="w-full bg-gray-50 border border-gray-200 rounded-xl px-3 py-3 text-sm font-bold"
                      >
                        <option value="bg-white">Weiß</option>
                        <option value="bg-gray-50">Grau</option>
                        <option value="bg-info-bg">Blau</option>
                        <option value="bg-success-bg">Grün</option>
                        <option value="bg-yellow-50">Gelb</option>
                      </select>
                    </div>
                  </div>
                  <div className="p-6 border-t border-gray-100 flex justify-end gap-2 bg-white">
                    <button
                      onClick={() => setIsAddAccountOpen(false)}
                      className="px-5 py-2.5 rounded-xl font-bold bg-gray-100 hover:bg-gray-200 transition-colors"
                    >
                      Abbrechen
                    </button>
                    <button
                      onClick={() => {
                        if (!newAccount.name.trim()) return;
                        upsertAccount.mutate(newAccount, {
                          onSuccess: () => setIsAddAccountOpen(false),
                        });
                      }}
                      className="px-5 py-2.5 rounded-xl font-bold bg-black text-white hover:bg-gray-800 transition-colors"
                    >
                      Speichern
                    </button>
                  </div>
                </div>
              </div>
            )}
            
             <div className="grid grid-cols-1 gap-4">
                {accounts.map((acc, i) => (
                    <div 
                        key={i} 
                        onClick={() => setSelectedAccountId(acc.id)}
                        className={`p-6 rounded-3xl ${acc.color} flex items-center justify-between cursor-pointer border border-transparent hover:border-black/10 hover:shadow-xl hover:-translate-y-1 transition-all group animate-enter`}
                        style={{ animationDelay: `${i * 100}ms` }}
                    >
                        <div className="flex items-center gap-4">
                            <div className="w-14 h-14 bg-white rounded-2xl flex items-center justify-center shadow-sm group-hover:scale-110 transition-transform duration-300">
                                <CreditCard size={24} className="text-gray-800" />
                            </div>
                            <div>
                                <h4 className="font-bold text-lg group-hover:text-accent group-hover:bg-black group-hover:px-2 group-hover:rounded transition-all">{acc.name}</h4>
                                <p className="text-sm text-gray-500 font-mono mt-1">{acc.iban}</p>
                            </div>
                        </div>
                        <div className="text-right">
                            <p className="font-mono font-bold text-xl">{formatCurrency(acc.balance)}</p>
                            <span className="text-xs font-bold text-success bg-white px-2 py-1 rounded-full shadow-sm border border-success/30">Aktiv</span>
                            <div className="flex items-center justify-end gap-1 mt-2 text-xs font-bold text-gray-400 group-hover:text-black">
                                <span>{acc.transactions.length} Buchungen</span>
                                <ArrowRight size={12} />
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

export const TemplatesView: React.FC<{ onOpenEditor: (type: 'invoice' | 'offer') => void }> = ({ onOpenEditor }) => {
    const [activeTab, setActiveTab] = useState<'invoice' | 'offer'>('invoice');
    const { data: templates = [] } = useTemplatesQuery(activeTab);
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
            alert(`Vorlage anlegen fehlgeschlagen: ${String(e)}`);
        }
    };

    return (
        <div className="bg-white rounded-[2.5rem] shadow-sm p-8 min-h-[80vh] animate-enter">
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h3 className="font-bold text-2xl text-gray-900 mb-1">Vorlagen</h3>
                    <p className="text-sm text-gray-500">Gestalten Sie Ihre Geschäftsdokumente.</p>
                </div>
                <div className="bg-gray-100 p-1 rounded-full flex items-center">
                    <button 
                        onClick={() => setActiveTab('invoice')}
                        className={`px-6 py-2 rounded-full text-xs font-bold transition-all ${activeTab === 'invoice' ? 'bg-white shadow text-black' : 'text-gray-400 hover:text-gray-600'}`}
                    >
                        Rechnungen
                    </button>
                    <button 
                        onClick={() => setActiveTab('offer')}
                        className={`px-6 py-2 rounded-full text-xs font-bold transition-all ${activeTab === 'offer' ? 'bg-white shadow text-black' : 'text-gray-400 hover:text-gray-600'}`}
                    >
                        Angebote
                    </button>
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
                {/* Create New Card */}
                <div 
                    onClick={() => void handleCreateNewTemplate()}
                    className="aspect-[3/4] bg-gray-50 rounded-[2rem] border-2 border-dashed border-gray-200 flex flex-col items-center justify-center gap-4 cursor-pointer hover:border-black hover:bg-gray-100 transition-all group animate-scale-in"
                >
                    <div className="w-16 h-16 bg-white rounded-full flex items-center justify-center shadow-sm group-hover:scale-110 transition-transform">
                        <Plus size={24} className="text-gray-400 group-hover:text-black" />
                    </div>
                    <span className="font-bold text-gray-400 group-hover:text-black text-center px-4">
                        Neue {activeTab === 'invoice' ? 'Rechnungsvorlage' : 'Angebotsvorlage'}
                    </span>
                </div>

                {/* Templates */}
                {templates.map((t, idx) => (
                <div
                    key={t.id}
                    className="aspect-[3/4] bg-surface rounded-[2rem] border border-border p-4 flex flex-col hover:border-border hover:-translate-y-2 transition-all cursor-pointer group relative overflow-hidden animate-scale-in"
                    style={{ animationDelay: `${100 + idx * 50}ms` }}
                    onClick={() => onOpenEditor(activeTab)}
                >
                    <div className="flex-1 bg-gray-50 rounded-2xl mb-4 relative overflow-hidden flex flex-col p-4 gap-2 border border-gray-100">
                         {/* Mini preview abstraction */}
                         <div className="w-1/3 h-2 bg-gray-200 rounded-full self-end"></div>
                         <div className="w-1/2 h-2 bg-gray-200 rounded-full mt-4"></div>
                         <div className="w-full h-1 bg-gray-100 rounded-full mt-2"></div>
                         <div className="w-full h-1 bg-gray-100 rounded-full"></div>
                         
                         <div className="mt-auto bg-white border border-gray-100 p-2 rounded-lg">
                             <div className="w-full h-1 bg-gray-100 rounded-full mb-1"></div>
                             <div className="flex justify-between">
                                 <div className="w-1/4 h-1 bg-gray-100 rounded-full"></div>
                                 <div className="w-1/4 h-1 bg-gray-200 rounded-full"></div>
                             </div>
                         </div>
                    </div>
                    <h4 className="font-bold text-lg">{t.name}</h4>
                    <p className="text-xs text-gray-500">A4 • {t.id === activeTemplate?.id ? 'Aktiv' : 'Vorlage'}</p>

                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            void setActiveTemplateMutation.mutateAsync({ kind: activeTab, templateId: t.id });
                        }}
                        className={`absolute top-4 left-4 px-3 py-1 rounded-full text-[10px] font-bold uppercase border transition-colors ${
                            t.id === activeTemplate?.id
                                ? 'bg-accent text-black border-accent'
                                : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-100'
                        }`}
                    >
                        {t.id === activeTemplate?.id ? 'Aktiv' : 'Aktivieren'}
                    </button>
                    
                    <button onClick={(e) => { e.stopPropagation(); onOpenEditor(activeTab); }} className="absolute bottom-4 right-4 bg-black text-white w-10 h-10 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all translate-y-2 group-hover:translate-y-0">
                        <ArrowUpRight size={18} />
                    </button>
                    
                    <div className="absolute top-4 right-4">
                        {activeTab === 'offer' && (
                            <span className="bg-purple-100 text-purple-600 px-2 py-1 rounded text-[10px] font-bold uppercase">Angebot</span>
                        )}
                    </div>
                </div>
                ))}
            </div>
        </div>
    );
}
