import React from 'react';
import { CheckCircle, ArrowUpRight, CreditCard } from 'lucide-react';
import { DashboardSettingsPopover } from './DashboardSettingsPopover';
import { formatCurrency, formatDate } from './helpers';
import { AppSettings } from '../../types';

interface PaymentRow {
  invoiceId: string;
  invoiceNumber: string;
  client: string;
  date: string;
  amount: number;
  method: string;
}

interface PaymentsCardProps {
  payments: PaymentRow[];
  recentPaymentsLimit: number;
  paymentsThisMonthGross: number;
  onNavigate: (page: string) => void;
  saveDashboardSettings: (patch: Partial<AppSettings['dashboard']>) => void;
}

export const PaymentsCard: React.FC<PaymentsCardProps> = ({
  payments,
  recentPaymentsLimit,
  paymentsThisMonthGross,
  onNavigate,
  saveDashboardSettings,
}) => {
  return (
    <div className="bg-accent rounded-xl p-8 text-black min-h-[350px] flex flex-col shadow-sm relative overflow-hidden group animate-enter delay-200 premium-hover">
        <div className="absolute top-0 right-0 w-48 h-48 bg-white opacity-20 rounded-full blur-[60px] transform translate-x-10 -translate-y-10 group-hover:scale-110 transition-transform duration-700"></div>

        <div className="flex justify-between items-center mb-6 relative z-10">
            <h3 className="text-xl font-black flex items-center gap-2">
               <CheckCircle size={20} className="text-black/80" />
               Zahlungseingänge
            </h3>
            <div className="flex items-center gap-2">
                <DashboardSettingsPopover
                  fields={[{ key: 'recentPaymentsLimit', label: 'Angezeigte Zahlungen', min: 1, max: 20 }]}
                  values={{ recentPaymentsLimit }}
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
              payments.slice(0, recentPaymentsLimit).map((item) => (
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
                        <p className="text-base tabular-nums font-bold">{formatCurrency(item.amount)}</p>
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
                 <p className="text-2xl tabular-nums font-bold">{formatCurrency(paymentsThisMonthGross)}</p>
             </div>
        </div>
    </div>
  );
};
