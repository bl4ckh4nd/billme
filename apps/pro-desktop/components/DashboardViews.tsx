
import React, { useMemo, useState, useCallback } from 'react';
import { Plus, CreditCard, ArrowRight, X } from 'lucide-react';
import { Account, AppSettings } from '../types';
import { useInvoicesQuery } from '../hooks/useInvoices';
import { useAccountsQuery, useUpsertAccountMutation } from '../hooks/useAccounts';
import { useArticlesQuery } from '../hooks/useArticles';
import { useSettingsQuery, useSetSettingsMutation } from '../hooks/useSettings';
import { useOffersQuery } from '../hooks/useOffers';
import { MOCK_SETTINGS } from '../data/mockData';
import { v4 as uuidv4 } from 'uuid';

// Dashboard sub-components
import { LiquidityCard } from './dashboard/LiquidityCard';
import { RevenueCard } from './dashboard/RevenueCard';
import { PaymentsCard } from './dashboard/PaymentsCard';
import { TaxEstimateCard } from './dashboard/TaxEstimateCard';
import { AccountDetailView } from './dashboard/AccountDetailView';
import { formatCurrency } from './dashboard/helpers';

// Re-export TemplatesView so the public API of this module is unchanged
export { TemplatesView } from './dashboard/TemplatesView';

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
    const amountFor = (inv: (typeof invoices)[number]) => {
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
      <LiquidityCard
        kpis={kpis}
        dueSoonDays={dash.dueSoonDays}
        paymentTrend={paymentTrend}
        onSaveDueSoonDays={(days) => saveDashboardSettings({ dueSoonDays: days })}
        onNavigate={onNavigate}
      />
      <RevenueCard
        kpis={kpis}
        monthlyRevenueGoal={dash.monthlyRevenueGoal}
        topCategoriesLimit={dash.topCategoriesLimit}
        topCategories={topCategories}
        offerPipeline={offerPipeline}
        onSaveSettings={(v) => saveDashboardSettings({ monthlyRevenueGoal: v.monthlyRevenueGoal, topCategoriesLimit: v.topCategoriesLimit })}
        onNavigate={onNavigate}
      />
      <PaymentsCard
        payments={payments}
        recentPaymentsLimit={dash.recentPaymentsLimit}
        paymentsThisMonthGross={paymentsThisMonthGross}
        onSaveRecentPaymentsLimit={(limit) => saveDashboardSettings({ recentPaymentsLimit: limit })}
        onNavigate={onNavigate}
      />
      <TaxEstimateCard
        taxEstimate={taxEstimate}
        smallBusinessRule={settings.legal.smallBusinessRule}
        taxMethod={taxMethod}
      />
    </div>
  );
};

export const AccountsView: React.FC = () => {
    const { data: accounts = [] } = useAccountsQuery();
    const upsertAccount = useUpsertAccountMutation();
    const { data: invoices = [] } = useInvoicesQuery();
    const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
    const [isAddAccountOpen, setIsAddAccountOpen] = useState(false);
    const [newAccount, setNewAccount] = useState<Account>({
        id: uuidv4(),
        name: '',
        iban: '',
        balance: 0,
        defaultSkrAccountNumber: '1200',
        type: 'bank',
        color: 'bg-white',
        transactions: [],
    });

    const selectedAccount = accounts.find(a => a.id === selectedAccountId);

    // --- Detail View ---
    if (selectedAccount) {
        return (
            <AccountDetailView
                account={selectedAccount}
                invoices={invoices}
                onBack={() => setSelectedAccountId(null)}
            />
        );
    }

    // --- Overview View ---
    return (
        <div className="bg-surface rounded-xl shadow-sm overflow-hidden p-8 h-full animate-enter">
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h3 className="font-bold text-2xl text-foreground">Geschäftskonten</h3>
                </div>
                <button
                  onClick={() => {
                    setNewAccount({
                      id: uuidv4(),
                      name: '',
                      iban: '',
                      balance: 0,
                      defaultSkrAccountNumber: '1200',
                      type: 'bank',
                      color: 'bg-white',
                      transactions: [],
                    });
                    setIsAddAccountOpen(true);
                  }}
                  className="bg-foreground text-white px-6 py-3 rounded-full text-sm font-bold hover:bg-dark-1 hover:scale-105 active:scale-95 transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-200 ease-out flex items-center gap-2 shadow-lg"
                >
                    <Plus size={16} />
                    Konto hinzufügen
                </button>
            </div>

            {/* Add Account Modal */}
            {isAddAccountOpen && (
              <div className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm flex items-center justify-center p-4">
                <div className="bg-surface rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden">
                  <div className="p-6 border-b border-border-subtle flex justify-between items-center bg-surface-muted">
                    <h3 className="font-bold text-lg">Konto hinzufügen</h3>
                    <button onClick={() => setIsAddAccountOpen(false)} className="p-2 hover:bg-canvas rounded-full transition-colors duration-200 ease-out"><X size={18} /></button>
                  </div>
                  <div className="p-6 space-y-4">
                    <div>
                      <label className="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">Name</label>
                      <input
                        value={newAccount.name}
                        onChange={(e) => setNewAccount({ ...newAccount, name: e.target.value })}
                        className="w-full bg-surface-muted border border-border rounded-lg px-4 py-3 text-sm font-bold outline-none focus:ring-2 focus:ring-accent"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">Typ</label>
                        <select
                          value={newAccount.type}
                          onChange={(e) => setNewAccount({ ...newAccount, type: e.target.value as any })}
                          className="w-full bg-surface-muted border border-border rounded-lg px-3 py-3 text-sm font-bold"
                        >
                          <option value="bank">Bank</option>
                          <option value="paypal">PayPal</option>
                          <option value="cash">Cash</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">Startsaldo</label>
                        <input
                          type="number"
                          value={newAccount.balance}
                          onChange={(e) => setNewAccount({ ...newAccount, balance: Number(e.target.value) })}
                          className="w-full bg-surface-muted border border-border rounded-lg px-3 py-3 text-sm tabular-nums font-bold"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">IBAN / Identifier</label>
                      <input
                        value={newAccount.iban}
                        onChange={(e) => setNewAccount({ ...newAccount, iban: e.target.value })}
                        className="w-full bg-surface-muted border border-border rounded-lg px-4 py-3 text-sm font-mono outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[10px] font-bold text-muted uppercase tracking-wider mb-1">Farbe</label>
                      <select
                        value={newAccount.color}
                        onChange={(e) => setNewAccount({ ...newAccount, color: e.target.value })}
                        className="w-full bg-surface-muted border border-border rounded-lg px-3 py-3 text-sm font-bold"
                      >
                        <option value="bg-white">Weiß</option>
                        <option value="bg-gray-50">Grau</option>
                        <option value="bg-info-bg">Blau</option>
                        <option value="bg-success-bg">Grün</option>
                        <option value="bg-yellow-50">Gelb</option>
                      </select>
                    </div>
                  </div>
                  <div className="p-6 border-t border-border-subtle flex justify-end gap-2 bg-surface">
                    <button
                      onClick={() => setIsAddAccountOpen(false)}
                      className="px-5 py-2.5 rounded-lg font-bold bg-canvas hover:bg-surface-muted transition-colors duration-200 ease-out"
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
                      className="px-5 py-2.5 rounded-lg font-bold bg-foreground text-white hover:bg-dark-1 transition-colors duration-200 ease-out"
                    >
                      Speichern
                    </button>
                  </div>
                </div>
              </div>
            )}

             <div className="grid grid-cols-1 gap-4">
                {accounts.length === 0 ? (
                    <div className="text-center py-16 text-muted">
                        <CreditCard size={32} className="mx-auto mb-3 opacity-30" />
                        <p className="text-sm font-bold">Noch keine Konten vorhanden.</p>
                        <p className="text-xs mt-1">Fügen Sie Ihr erstes Geschäftskonto hinzu.</p>
                    </div>
                ) : (
                  accounts.map((acc, i) => (
                    <div
                        key={i}
                        onClick={() => setSelectedAccountId(acc.id)}
                        className={`p-6 rounded-xl ${acc.color} flex items-center justify-between cursor-pointer border border-transparent hover:border-black/10 hover:shadow-xl hover:-translate-y-1 transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-200 ease-out group animate-enter`}
                        style={{ animationDelay: `${i * 100}ms` }}
                    >
                        <div className="flex items-center gap-4">
                            <div className="w-14 h-14 bg-surface rounded-lg flex items-center justify-center shadow-sm group-hover:scale-110 transition-transform duration-200 ease-out">
                                <CreditCard size={24} className="text-foreground" />
                            </div>
                            <div>
                                <h4 className="font-bold text-lg group-hover:text-accent group-hover:bg-black group-hover:px-2 group-hover:rounded transition-[background-color,border-color,color,box-shadow,transform,opacity] duration-200 ease-out">{acc.name}</h4>
                                <p className="text-sm text-muted font-mono mt-1">{acc.iban}</p>
                            </div>
                        </div>
                        <div className="text-right">
                            <p className="tabular-nums font-bold text-xl">{formatCurrency(acc.balance)}</p>
                            <span className="text-xs font-bold text-success bg-surface px-2 py-1 rounded-full shadow-sm border border-success/30">Aktiv</span>
                            <div className="flex items-center justify-end gap-1 mt-2 text-xs font-bold text-muted group-hover:text-foreground transition-colors duration-200 ease-out">
                                <span>{acc.transactions.length} Buchungen</span>
                                <ArrowRight size={12} />
                            </div>
                        </div>
                    </div>
                  ))
                )}
            </div>
        </div>
    );
};
