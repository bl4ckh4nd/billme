import { Button } from '@billme/ui';

import React, { useState, useMemo } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { 
  TrendingUp, TrendingDown, Calendar, 
  ArrowUpRight, ArrowDownRight, DollarSign, 
  Users, FileText, PieChart, BarChart3, Filter
} from 'lucide-react';
import { Invoice, InvoiceStatus } from '../types';
import { useInvoicesQuery } from '../hooks/useInvoices';
import { useClientsQuery } from '../hooks/useClients';

const formatCurrency = (amount: number) => {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);
};

type TimeRange = 'month' | 'quarter' | 'year' | 'all';

export const StatisticsView: React.FC = () => {
  const navigate = useNavigate();
  const [timeRange, setTimeRange] = useState<TimeRange>('year');
  const { data: invoices = [] } = useInvoicesQuery();
  const { data: clients = [] } = useClientsQuery();

  // Filter Logic
  const filteredData = useMemo(() => {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();

    return invoices.filter(inv => {
      const invDate = new Date(inv.date);
      
      switch (timeRange) {
        case 'month':
          return invDate.getMonth() === currentMonth && invDate.getFullYear() === currentYear;
        case 'quarter':
          const currentQuarter = Math.floor(currentMonth / 3);
          const invQuarter = Math.floor(invDate.getMonth() / 3);
          return invQuarter === currentQuarter && invDate.getFullYear() === currentYear;
        case 'year':
          return invDate.getFullYear() === currentYear;
        default:
          return true;
      }
    });
  }, [timeRange]);

  // KPI Calculations
  const kpis = useMemo(() => {
    const revenue = filteredData
      .filter(i => i.status === 'paid')
      .reduce((acc, curr) => acc + curr.amount, 0);
    
    const outstanding = filteredData
      .filter(i => i.status === 'open' || i.status === 'overdue')
      .reduce((acc, curr) => acc + curr.amount, 0);

    const overdue = filteredData
      .filter(i => i.status === 'overdue')
      .reduce((acc, curr) => acc + curr.amount, 0);

    const paidCount = filteredData.filter(i => i.status === 'paid').length;
    const totalCount = filteredData.length;
    const conversionRate = totalCount > 0 ? (paidCount / totalCount) * 100 : 0;
    const avgTicket = paidCount > 0 ? revenue / paidCount : 0;

    return { revenue, outstanding, overdue, conversionRate, avgTicket, totalCount };
  }, [filteredData, clients]);

  // Chart Data (Mocking monthly distribution based on filtered data)
  const chartData = useMemo(() => {
    const months = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
    const data = new Array(12).fill(0);
    
    filteredData.forEach(inv => {
        if(inv.status === 'paid') {
            const month = new Date(inv.date).getMonth();
            data[month] += inv.amount;
        }
    });

    // Normalize for bar height (max 100%)
    const maxVal = Math.max(...data, 1);
    return months.map((label, i) => ({
        label,
        value: data[i],
        height: (data[i] / maxVal) * 100
    }));
  }, [filteredData]);

  // Top Clients Logic
  const topClients = useMemo(() => {
      const clientMap = new Map<string, number>();
      
      filteredData.filter(i => i.status === 'paid').forEach(inv => {
          const current = clientMap.get(inv.clientId || 'unknown') || 0;
          clientMap.set(inv.clientId || 'unknown', current + inv.amount);
      });

      return Array.from(clientMap.entries())
        .map(([id, amount]) => {
            const clientDetails = clients.find(c => c.id === id);
            return {
                name: clientDetails ? clientDetails.company : 'Unbekannt',
                amount
            };
        })
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 5); // Top 5
  }, [filteredData]);

  return (
    <div className="flex flex-col gap-6 h-full pb-8">
      
      {/* Header & Filter */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-white rounded-[2.5rem] p-6 shadow-sm">
        <div>
           <h1 className="text-3xl font-bold text-gray-900 flex items-center gap-3">
               <BarChart3 className="text-black" />
               Statistiken
           </h1>
           <p className="text-gray-500 font-medium text-sm mt-1">
               Finanzüberblick und Geschäftsentwicklung
           </p>
        </div>
        
        <div className="flex bg-gray-100 p-1.5 rounded-full">
            {[
                { id: 'month', label: 'Monat' },
                { id: 'quarter', label: 'Quartal' },
                { id: 'year', label: 'Jahr' },
                { id: 'all', label: 'Gesamt' },
            ].map((t) => (
                <button
                    key={t.id}
                    onClick={() => setTimeRange(t.id as TimeRange)}
                    className={`px-6 py-2 rounded-full text-xs font-bold transition-all ${
                        timeRange === t.id 
                        ? 'bg-black text-white shadow-md' 
                        : 'text-gray-500 hover:text-black'
                    }`}
                >
                    {t.label}
                </button>
            ))}
        </div>
      </div>

      {/* KPI Cards Row 1 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {/* Revenue */}
          <div className="bg-[#1c1c1c] rounded-[2rem] p-6 text-white flex flex-col justify-between relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-32 h-32 bg-accent rounded-full blur-[60px] opacity-10 group-hover:opacity-20 transition-opacity"></div>
              <div className="relative z-10 flex justify-between items-start">
                  <div className="p-3 bg-white/10 rounded-xl backdrop-blur-md">
                      <DollarSign size={20} className="text-accent" />
                  </div>
                  <span className="bg-accent/20 text-accent text-[10px] font-bold px-2 py-1 rounded-full flex items-center gap-1">
                      <TrendingUp size={10} /> +12.5%
                  </span>
              </div>
              <div className="relative z-10 mt-6">
                  <p className="text-gray-400 text-xs font-bold uppercase tracking-wider mb-1">Umsatz (Bezahlt)</p>
                  <h3 className="text-3xl font-mono font-bold">{formatCurrency(kpis.revenue)}</h3>
              </div>
          </div>

          {/* Outstanding */}
          <div className="bg-white rounded-[2rem] p-6 border border-gray-100 flex flex-col justify-between">
              <div className="flex justify-between items-start">
                  <div className="p-3 bg-error-bg rounded-xl">
                      <FileText size={20} className="text-error" />
                  </div>
              </div>
              <div className="mt-6">
                  <p className="text-gray-400 text-xs font-bold uppercase tracking-wider mb-1">Offene Forderungen</p>
                  <div className="flex items-end gap-2">
                      <h3 className="text-3xl font-mono font-bold text-gray-900">{formatCurrency(kpis.outstanding)}</h3>
                      {kpis.overdue > 0 && (
                          <span className="text-xs font-bold text-error mb-1.5">
                              davon {formatCurrency(kpis.overdue)} überfällig
                          </span>
                      )}
                  </div>
              </div>
          </div>

          {/* Avg Ticket */}
          <div className="bg-accent rounded-[2rem] p-6 text-black flex flex-col justify-between shadow-sm group">
              <div className="flex justify-between items-start">
                  <div className="p-3 bg-black/10 rounded-xl">
                      <PieChart size={20} className="text-black" />
                  </div>
              </div>
              <div className="mt-6">
                  <p className="text-black/60 text-xs font-bold uppercase tracking-wider mb-1">Ø Rechnungswert</p>
                  <h3 className="text-3xl font-mono font-bold">{formatCurrency(kpis.avgTicket)}</h3>
              </div>
          </div>

           {/* Efficiency */}
           <div className="bg-white rounded-[2rem] p-6 border border-gray-100 flex flex-col justify-between">
              <div className="flex justify-between items-start">
                  <div className="p-3 bg-gray-100 rounded-xl">
                      <TrendingUp size={20} className="text-gray-600" />
                  </div>
              </div>
              <div className="mt-6">
                  <p className="text-gray-400 text-xs font-bold uppercase tracking-wider mb-1">Zahlungsquote</p>
                  <div className="flex items-center gap-3">
                    <h3 className="text-3xl font-mono font-bold text-gray-900">{Math.round(kpis.conversionRate)}%</h3>
                    <div className="flex-1 bg-gray-100 h-2 rounded-full overflow-hidden">
                        <div 
                            className="bg-black h-full rounded-full transition-all duration-1000" 
                            style={{ width: `${kpis.conversionRate}%`}}
                        ></div>
                    </div>
                  </div>
              </div>
          </div>
      </div>

      {/* Main Content Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 min-h-[400px]">
          
          {/* Main Chart */}
          <div className="lg:col-span-2 bg-white rounded-[2.5rem] p-8 border border-gray-100 shadow-sm flex flex-col">
              <div className="mb-8 flex justify-between items-center">
                  <h3 className="font-bold text-xl">Umsatzentwicklung</h3>
                  <div className="flex items-center gap-2 text-xs font-bold text-gray-500">
                      <span className="w-2 h-2 rounded-full bg-black"></span>
                      Bezahlte Rechnungen
                  </div>
              </div>

              <div className="flex-1 flex items-end justify-between gap-2 md:gap-4 min-h-[250px] pb-4 px-2">
                  {chartData.map((d, i) => (
                      <div key={i} className="flex flex-col items-center gap-2 flex-1 group">
                          <div className="w-full bg-gray-100 rounded-t-lg relative h-full flex flex-col justify-end overflow-hidden">
                              <div 
                                className="bg-black w-full rounded-t-lg transition-all duration-1000 group-hover:bg-accent relative min-h-[4px]"
                                style={{ height: `${d.height}%` }}
                              >
                                  {/* Tooltip */}
                                  <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-black text-white text-[10px] font-bold py-1 px-2 rounded opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none whitespace-nowrap z-10">
                                      {formatCurrency(d.value)}
                                  </div>
                              </div>
                          </div>
                          <span className="text-[10px] font-bold text-gray-400 uppercase">{d.label}</span>
                      </div>
                  ))}
              </div>
          </div>

          {/* Top Customers List */}
          <div className="bg-white rounded-[2.5rem] p-8 border border-gray-100 shadow-sm flex flex-col">
              <h3 className="font-bold text-xl mb-6">Top Kunden</h3>
              <div className="flex-1 overflow-y-auto pr-2 space-y-4">
                  {topClients.map((client, idx) => (
                      <div key={idx} className="flex items-center gap-4 group">
                          <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-xs font-bold ${idx === 0 ? 'bg-accent text-black' : 'bg-gray-100 text-gray-500'}`}>
                              {idx + 1}
                          </div>
                          <div className="flex-1">
                              <div className="flex justify-between items-center mb-1">
                                  <span className="font-bold text-sm text-gray-900">{client.name}</span>
                                  <span className="font-mono font-bold text-sm">{formatCurrency(client.amount)}</span>
                              </div>
                              <div className="w-full bg-gray-50 h-1.5 rounded-full overflow-hidden">
                                  <div 
                                    className="bg-black h-full rounded-full" 
                                    style={{ width: `${(client.amount / kpis.revenue) * 100}%` }}
                                  ></div>
                              </div>
                          </div>
                      </div>
                  ))}
                  
                  {topClients.length === 0 && (
                      <div className="text-center py-10 text-gray-400">
                          <Users size={32} className="mx-auto mb-2 opacity-20" />
                          <p className="text-xs">Keine Daten für diesen Zeitraum</p>
                      </div>
                  )}
              </div>
              
              <div className="mt-6 pt-6 border-t border-gray-100">
                   <button
                       onClick={() => navigate({ to: '/clients' })}
                       className="w-full py-3 bg-gray-50 rounded-xl text-xs font-bold hover:bg-black hover:text-accent transition-colors flex items-center justify-center gap-2"
                   >
                       Alle Kunden ansehen <ArrowUpRight size={14}/>
                   </button>
              </div>
          </div>

      </div>
    </div>
  );
};
