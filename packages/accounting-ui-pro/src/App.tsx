import { useCallback, useEffect, useMemo, useState } from 'react';
import InboxView from './components/InboxView';
import BookingEditor from './components/BookingEditor';
import ReconciliationWorkbench from './components/ReconciliationWorkbench';
import ExceptionCenter from './components/ExceptionCenter';
import AssetManagementView from './components/AssetManagementView';
import ReportsView from './components/ReportsView';
import {
  configureStoreAdapter,
  configureStorePersistence,
  hydrateMockStore,
  listTransactions,
  type ProAccountingDataAdapter,
} from './services/mockBookingStore';
import { Account, BookingDraft, Transaction, UserRole } from './types';

type AppView = 'inbox' | 'editor' | 'reconciliation' | 'exceptions' | 'assets' | 'reports';

export interface ProAccountingSeed {
  transactions?: Transaction[];
  accounts?: Account[];
  drafts?: BookingDraft[];
  chartFramework?: 'SKR03' | 'SKR04';
  seedVersion?: string | number;
}

export interface ProAccountingWorkspaceProps {
  seed?: ProAccountingSeed;
  dataAdapter?: ProAccountingDataAdapter;
  onPersistEntry?: (entry: { transaction: Transaction; draft: BookingDraft }) => void | Promise<void>;
}

export default function App({ seed, dataAdapter, onPersistEntry }: ProAccountingWorkspaceProps) {
  const [currentView, setCurrentView] = useState<AppView>('inbox');
  const [selectedTransactionId, setSelectedTransactionId] = useState<string | null>(null);
  const [inboxPreviewTransactionId, setInboxPreviewTransactionId] = useState<string | null>(null);
  const [role, setRole] = useState<UserRole>('bookkeeper');
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!seed) return;
    hydrateMockStore({
      transactions: seed.transactions,
      drafts: seed.drafts,
      accounts: seed.accounts,
      chartFramework: seed.chartFramework,
    });
    setVersion((v) => v + 1);
  }, [seed?.seedVersion, seed?.transactions, seed?.drafts, seed?.accounts, seed?.chartFramework]);

  useEffect(() => {
    configureStorePersistence({
      onPersistEntry,
    });
    return () => {
      configureStorePersistence({});
    };
  }, [onPersistEntry]);

  useEffect(() => {
    configureStoreAdapter(dataAdapter);
    return () => configureStoreAdapter(undefined);
  }, [dataAdapter]);

  const transactions = useMemo(() => listTransactions(), [version]);

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const handleOpenTransaction = (transactionId: string) => {
    setInboxPreviewTransactionId(null);
    setSelectedTransactionId(transactionId);
    setCurrentView('editor');
  };

  const handleOpenInboxTransaction = (transactionId: string) => {
    setSelectedTransactionId(null);
    setInboxPreviewTransactionId(transactionId);
    setCurrentView('inbox');
    refresh();
  };

  const handleBackToInbox = () => {
    setCurrentView('inbox');
    setSelectedTransactionId(null);
    refresh();
  };

  return (
    <div className="flex flex-col h-full w-full text-foreground">
      <div className="flex items-center gap-1 px-6 pt-2 shrink-0 border-b border-border-subtle">
        <nav className="flex items-center gap-0.5">
          {(
            [
              { view: 'inbox', label: 'Inbox' },
              { view: 'reconciliation', label: 'Abgleich' },
              { view: 'exceptions', label: 'Exceptions' },
              { view: 'assets', label: 'Anlagen' },
              { view: 'reports', label: 'Auswertungen' },
            ] as { view: AppView; label: string }[]
          ).map(({ view, label }) => (
            <button
              key={view}
              onClick={() => setCurrentView(view)}
              className={`px-4 py-2 text-sm font-bold transition-colors duration-150 ease-out rounded-t-lg relative ${
                currentView === view
                  ? 'text-foreground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-foreground'
                  : 'text-muted hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="ml-auto pb-2">
          <select
            aria-label="Demo Rolle"
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
            className="px-3 py-1.5 rounded-lg bg-surface border border-border text-sm font-medium text-muted"
          >
            <option value="bookkeeper">Bookkeeper</option>
            <option value="reviewer">Reviewer</option>
            <option value="accountant">Accountant</option>
            <option value="admin">Admin</option>
            <option value="auditor">Auditor</option>
          </select>
        </div>
      </div>

      <main className="flex-1 overflow-hidden">
        <div className="h-full overflow-hidden flex flex-col">
          {currentView === 'inbox' ? (
            <InboxView
              role={role}
              transactions={transactions}
              onOpenTransaction={handleOpenTransaction}
              onRefresh={refresh}
              forcedPreviewTransactionId={inboxPreviewTransactionId}
            />
          ) : currentView === 'editor' ? (
            <BookingEditor
              transactionId={selectedTransactionId}
              role={role}
              onBack={handleBackToInbox}
              onStoreChange={refresh}
            />
          ) : currentView === 'reconciliation' ? (
            <ReconciliationWorkbench
              role={role}
              transactions={transactions}
              onOpenTransaction={handleOpenTransaction}
              onRefresh={refresh}
            />
          ) : currentView === 'exceptions' ? (
            <ExceptionCenter
              role={role}
              transactions={transactions}
              onOpenTransaction={handleOpenTransaction}
              onRefresh={refresh}
            />
          ) : currentView === 'reports' ? (
            <ReportsView
              onOpenTransaction={handleOpenTransaction}
              onOpenReceipt={handleOpenInboxTransaction}
            />
          ) : (
            <AssetManagementView />
          )}
        </div>
      </main>
    </div>
  );
}
