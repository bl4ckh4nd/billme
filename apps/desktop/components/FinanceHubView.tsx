import { Button } from '@billme/ui';
import React from 'react';
import { ArrowRight, BarChart3, Wallet } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';

export const FinanceHubView: React.FC = () => {
  const navigate = useNavigate();

  return (
    <div className="bg-white rounded-[2.5rem] p-6 min-h-full shadow-sm">
      <div className="mb-8">
        <h2 className="text-2xl font-black text-gray-900">Finanzen</h2>
        <p className="text-sm text-gray-500 mt-1">Konten, Transaktionen und Auswertungen.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <button
          onClick={() => navigate({ to: '/accounts' })}
          className="text-left p-6 rounded-3xl border border-gray-200 bg-gray-50 hover:bg-gray-100 transition-colors"
        >
          <div className="flex items-center justify-between mb-4">
            <div className="w-12 h-12 rounded-2xl bg-black text-accent flex items-center justify-center">
              <Wallet size={22} />
            </div>
            <ArrowRight className="text-gray-400" />
          </div>
          <div className="text-lg font-black text-gray-900">Konten &amp; Transaktionen</div>
          <div className="text-sm text-gray-500 mt-1">CSV-Import, Zuordnung zu Rechnungen, Kontenverwaltung.</div>
        </button>

        <button
          onClick={() => navigate({ to: '/statistics' })}
          className="text-left p-6 rounded-3xl border border-gray-200 bg-gray-50 hover:bg-gray-100 transition-colors"
        >
          <div className="flex items-center justify-between mb-4">
            <div className="w-12 h-12 rounded-2xl bg-black text-accent flex items-center justify-center">
              <BarChart3 size={22} />
            </div>
            <ArrowRight className="text-gray-400" />
          </div>
          <div className="text-lg font-black text-gray-900">Statistiken</div>
          <div className="text-sm text-gray-500 mt-1">Umsätze, Kategorien, Zeiträume, Trends.</div>
        </button>
      </div>
    </div>
  );
};

