import React from 'react';
import { TrendingUp, TrendingDown, ArrowUpRight } from 'lucide-react';
import { DashboardSettingsPopover } from './DashboardSettingsPopover';
import { formatCurrency } from './helpers';
import { AppSettings } from '../../types';

interface LiquidityCardProps {
  outstandingTotal: number;
  overdueCount: number;
  overdueTotal: number;
  dueSoonCount: number;
  dueSoonTotal: number;
  dueSoonDays: number;
  paymentTrend: number | null;
  onNavigate: (page: string) => void;
  saveDashboardSettings: (patch: Partial<AppSettings['dashboard']>) => void;
}

export const LiquidityCard: React.FC<LiquidityCardProps> = ({
  outstandingTotal,
  overdueCount,
  overdueTotal,
  dueSoonCount,
  dueSoonTotal,
  dueSoonDays,
  paymentTrend,
  onNavigate,
  saveDashboardSettings,
}) => {
  return (
    <div className="bg-dark-3 rounded-xl p-8 text-white relative overflow-hidden min-h-[420px] flex flex-col justify-between group shadow-xl animate-enter premium-hover">
       {/* Decorative elements */}
       <div className="absolute top-0 right-0 w-64 h-64 bg-accent rounded-full blur-[100px] opacity-10 group-hover:opacity-20 transition-opacity duration-700"></div>

       <div className="relative z-10">
           <div className="flex justify-between items-start mb-12">
               <div className="p-3 bg-white/10 rounded-xl backdrop-blur-md border border-white/10">
                  <TrendingUp size={24} className="text-accent" />
               </div>
               <div className="flex gap-2 items-center">
                   <DashboardSettingsPopover
                     dark
                     fields={[{ key: 'dueSoonDays', label: 'Fällig in X Tagen', min: 1, max: 90 }]}
                     values={{ dueSoonDays }}
                     onSave={(v) => saveDashboardSettings({ dueSoonDays: v.dueSoonDays })}
                   ><span /></DashboardSettingsPopover>
                   <button onClick={() => onNavigate('documents')} className="px-3 py-1.5 rounded-lg border border-white/10 flex items-center gap-2 hover:bg-white/10 transition-colors text-xs font-bold">
                       Alle ansehen <ArrowUpRight size={14} />
                   </button>
               </div>
           </div>

           <div className="mb-4">
               <p className="text-dark-muted text-sm font-bold uppercase tracking-wider mb-2">Offene Forderungen</p>
               <h2 className="text-5xl tabular-nums font-bold tracking-tight mb-4">{formatCurrency(outstandingTotal)}</h2>

               <div className="flex flex-col gap-3">
                   <div className="flex items-center justify-between bg-white/5 p-3 rounded-xl border border-white/5 hover:bg-white/10 transition-colors">
                      <div className="flex items-center gap-3">
                          <div className="w-2 h-2 rounded-full bg-error shadow-[0_0_10px_rgba(220,38,38,0.5)]"></div>
                          <span className="text-sm font-bold text-white">Überfällig ({overdueCount})</span>
                      </div>
                      <span className="tabular-nums font-bold text-error">{formatCurrency(overdueTotal)}</span>
                   </div>
                   <div className="flex items-center justify-between bg-white/5 p-3 rounded-xl border border-white/5 hover:bg-white/10 transition-colors">
                      <div className="flex items-center gap-3">
                          <div className="w-2 h-2 rounded-full bg-accent shadow-[0_0_10px_rgba(217,249,68,0.5)]"></div>
                          <span className="text-sm font-bold text-white">Fällig in {dueSoonDays} Tagen ({dueSoonCount})</span>
                      </div>
                      <span className="tabular-nums font-bold text-accent">{formatCurrency(dueSoonTotal)}</span>
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
                        <span className={`${paymentTrend >= 0 ? 'bg-success/20 text-success' : 'bg-error/20 text-error'} px-1.5 py-1 rounded text-[10px] flex items-center gap-0.5`}>
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
                  onClick={() => onNavigate('documents?kind=invoice')}
                  className="bg-accent text-black px-6 py-3 rounded-xl font-bold text-sm hover:bg-accent-hover hover:scale-105 active:scale-95 transition-[background-color,border-color,color,box-shadow,opacity,transform,width] shadow-lg shadow-accent/20"
              >
                  Mahnung senden
              </button>
           </div>
       </div>
    </div>
  );
};
