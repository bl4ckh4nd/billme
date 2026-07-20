import React from 'react';
import { Euro, ArrowUpRight } from 'lucide-react';
import { DashboardSettingsPopover } from './DashboardSettingsPopover';
import { formatCurrency } from './helpers';
import { AppSettings } from '../../types';

interface TopCategory {
  category: string;
  amount: number;
  invoiceCount: number;
}

interface OfferPipeline {
  activeCount: number;
  acceptedCount: number;
  declinedCount: number;
  potentialNet: number;
}

interface RevenueCardProps {
  monthRevenueNet: number;
  monthIssuedCount: number;
  monthlyRevenueGoal: number;
  topCategoriesLimit: number;
  topCategories: TopCategory[];
  offerPipeline: OfferPipeline;
  onNavigate: (page: string) => void;
  saveDashboardSettings: (patch: Partial<AppSettings['dashboard']>) => void;
}

export const RevenueCard: React.FC<RevenueCardProps> = ({
  monthRevenueNet,
  monthIssuedCount,
  monthlyRevenueGoal,
  topCategoriesLimit,
  topCategories,
  offerPipeline,
  onNavigate,
  saveDashboardSettings,
}) => {
  return (
    <div className="bg-surface rounded-xl p-8 text-foreground relative overflow-hidden min-h-[420px] flex flex-col shadow-sm animate-enter delay-100 premium-hover">
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
                 values={{ monthlyRevenueGoal, topCategoriesLimit }}
                 onSave={(v) => saveDashboardSettings({ monthlyRevenueGoal: v.monthlyRevenueGoal, topCategoriesLimit: v.topCategoriesLimit })}
               ><span /></DashboardSettingsPopover>
               <div className="p-3 bg-surface-muted rounded-xl">
                   <Euro size={24} className="text-foreground" />
               </div>
           </div>
        </div>

        <div className="mb-8">
            <h2 className="text-5xl tabular-nums font-bold mb-2">{formatCurrency(monthRevenueNet)}</h2>
            <p className="text-xs text-muted font-bold uppercase tracking-wider mt-2 tabular-nums">
              Gestellte Rechnungen: {monthIssuedCount}
            </p>
            <div className="w-full bg-canvas h-3 rounded-full overflow-hidden mt-4">
                <div
                  className="bg-black h-full rounded-full relative"
                  style={{ width: `${Math.min(100, (monthRevenueNet / monthlyRevenueGoal) * 100)}%` }}
                >
                    <div className="absolute right-0 top-1/2 -translate-y-1/2 w-1 h-5 bg-white/50 rounded-full"></div>
                </div>
            </div>
            <div className="flex justify-between mt-2 text-xs font-bold text-muted tabular-nums">
                <span>0 €</span>
                <span>Ziel: {formatCurrency(monthlyRevenueGoal)}</span>
            </div>
        </div>

        <div className="flex-1 flex flex-col justify-end gap-4">
            <h4 className="font-bold text-sm text-foreground">Top Einnahmequellen</h4>

            <div className="space-y-3">
                {topCategories.length === 0 ? (
                  <div className="p-3 border border-border-subtle rounded-xl text-sm text-muted">
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
                        className="flex items-center justify-between p-3 border border-border-subtle rounded-xl hover:bg-surface-muted transition-colors cursor-pointer"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-10 h-10 rounded-xl bg-canvas text-foreground flex items-center justify-center font-bold text-xs shrink-0">
                            {initials || '—'}
                          </div>
                          <div className="min-w-0">
                            <span className="font-bold text-sm block truncate">{row.category}</span>
                            <span className="text-[10px] text-muted font-bold tabular-nums">
                              {row.invoiceCount} Rechnung(en)
                            </span>
                          </div>
                        </div>
                        <span className="tabular-nums font-bold text-lg">{formatCurrency(row.amount)}</span>
                      </button>
                    );
                  })
                )}
            </div>

            <div className="mt-5 p-4 rounded-xl border border-border-subtle bg-surface-muted">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <p className="text-[10px] font-bold text-muted uppercase tracking-wider">Pipeline (Angebote)</p>
                  <p className="text-sm font-bold text-foreground">Potenzial (Netto)</p>
                </div>
                <div className="text-lg tabular-nums font-bold text-foreground">{formatCurrency(offerPipeline.potentialNet)}</div>
              </div>
              <div className="text-[10px] text-muted font-bold tabular-nums">
                Basis: veröffentlicht/verschickt (Portal) • Offen: {offerPipeline.activeCount} • Angenommen: {offerPipeline.acceptedCount} • Abgelehnt: {offerPipeline.declinedCount}
              </div>
            </div>
        </div>
    </div>
  );
};
