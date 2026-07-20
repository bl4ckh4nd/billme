import React from 'react';
import { PieChart } from 'lucide-react';
import { formatCurrency } from './helpers';

interface TaxEstimate {
  periodLabel: string;
  net: number;
  vat: number;
  gross: number;
  dueLabel: string;
}

interface TaxEstimateCardProps {
  taxEstimate: TaxEstimate;
  smallBusinessRule: boolean;
  taxMethod: string;
}

export const TaxEstimateCard: React.FC<TaxEstimateCardProps> = ({
  taxEstimate,
  smallBusinessRule,
  taxMethod,
}) => {
  return (
    <div className="bg-info rounded-xl p-6 text-black min-h-[350px] flex flex-col shadow-sm relative overflow-hidden animate-enter delay-300 premium-hover">
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
                  {smallBusinessRule ? 'Kleinunternehmerregelung (§19) — keine USt' : 'Voraussichtliche Umsatzsteuer'}
                </p>
                <h2 className="text-5xl tabular-nums font-bold">{formatCurrency(taxEstimate.vat)}</h2>
                {!smallBusinessRule && (
                  <p className="text-xs font-bold mt-2 bg-black/5 inline-block px-3 py-1 rounded-full text-black/60">
                    Fällig am {taxEstimate.dueLabel}
                  </p>
                )}
            </div>

            <div className="grid grid-cols-2 gap-4">
                <div className="bg-white/20 backdrop-blur-sm rounded-xl p-4 border border-white/10 hover:bg-white/30 transition-colors">
                    <p className="text-[10px] font-bold opacity-60 uppercase mb-1">Netto-Basis ({taxMethod === 'ist' ? 'Ist' : 'Soll'})</p>
                    <p className="text-lg tabular-nums font-bold">{formatCurrency(taxEstimate.net)}</p>
                </div>
                <div className="bg-white/20 backdrop-blur-sm rounded-xl p-4 border border-white/10 hover:bg-white/30 transition-colors">
                    <p className="text-[10px] font-bold opacity-60 uppercase mb-1">Brutto</p>
                    <p className="text-lg tabular-nums font-bold">{formatCurrency(taxEstimate.gross)}</p>
                </div>
            </div>
        </div>
    </div>
  );
};
