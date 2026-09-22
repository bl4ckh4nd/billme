import React, { useEffect, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { BarChart3, Wallet, ReceiptText } from 'lucide-react';
import { StatisticsView } from './StatisticsView';
import { AccountsView } from './AccountsView';
import { EurView } from './EurView';

type Tab = 'statistics' | 'accounts' | 'eur';

const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'statistics', label: 'Statistiken', icon: <BarChart3 size={16} aria-hidden="true" /> },
  { id: 'accounts', label: 'Konten & Transaktionen', icon: <Wallet size={16} aria-hidden="true" /> },
  { id: 'eur', label: 'EÜR', icon: <ReceiptText size={16} aria-hidden="true" /> },
];

export const FinanceHubView: React.FC = () => {
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: unknown };
  const initialTab: Tab = search.tab === 'accounts' || search.tab === 'eur' ? search.tab : 'statistics';
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);

  useEffect(() => {
    if (search.tab !== activeTab) {
      navigate({ to: '/finance', search: { tab: activeTab } });
    }
  }, [activeTab, navigate, search.tab]);

  return (
    <div className="flex flex-col gap-6 h-full">
      {/* Sub-nav */}
      <div className="bg-surface rounded-xl p-4 shadow-sm flex items-center gap-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            aria-pressed={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${
              activeTab === tab.id
                ? 'bg-dark-base text-background'
                : 'bg-surface-muted text-muted hover:bg-border'
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
