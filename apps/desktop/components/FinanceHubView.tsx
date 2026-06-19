import React, { useState } from 'react';
import { BarChart3, Wallet, ReceiptText } from 'lucide-react';
import { StatisticsView } from './StatisticsView';
import { AccountsView } from './AccountsView';
import { EurView } from './EurView';

type Tab = 'statistics' | 'accounts' | 'eur';

const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'statistics', label: 'Statistiken', icon: <BarChart3 size={16} /> },
  { id: 'accounts', label: 'Konten & Transaktionen', icon: <Wallet size={16} /> },
  { id: 'eur', label: 'EÜR', icon: <ReceiptText size={16} /> },
];

export const FinanceHubView: React.FC = () => {
  const [activeTab, setActiveTab] = useState<Tab>('statistics');

  return (
    <div className="flex flex-col gap-6 h-full">
      {/* Sub-nav */}
      <div className="bg-white rounded-2xl p-4 shadow-sm flex items-center gap-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold transition-colors ${
              activeTab === tab.id
                ? 'bg-black text-white'
                : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0">
        {activeTab === 'statistics' && <StatisticsView />}
        {activeTab === 'accounts' && <AccountsView />}
        {activeTab === 'eur' && <EurView />}
      </div>
    </div>
  );
};
