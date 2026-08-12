import { useCallback, useEffect, useMemo, useState } from 'react';
import InboxView from './components/InboxView';
import BookingEditor from './components/BookingEditor';
import ReconciliationWorkbench from './components/ReconciliationWorkbench';
import ExceptionCenter from './components/ExceptionCenter';
import AssetManagementView from './components/AssetManagementView';
import ReportsView from './components/ReportsView';
import OposView from './components/OposView';
import {
  configureStoreAdapter,
  configureStorePersistence,
  hydrateMockStore,
  listTransactions,
  type ProAccountingDataAdapter,
} from './services/mockBookingStore';
import { Account, BookingDraft, Transaction, UserRole } from './types';

type AppView = 'inbox' | 'editor' | 'reconciliation' | 'exceptions' | 'assets' | 'reports' | 'opos';

export interface ProAccountingSeed {
  transactions?: Transaction[];
  accounts?: Account[];
  drafts?: BookingDraft[];
  chartFramework?: 'SKR03' | 'SKR04';
  bankAccountNumber?: string;
  bankAccountNumberByTransactionId?: Record<string, string>;
  seedVersion?: string | number;
}

export interface ProAccountingWorkspaceProps {
  seed?: ProAccountingSeed;
  dataAdapter?: ProAccountingDataAdapter;
  role?: UserRole;
  assetsAvailable?: boolean;
  busy?: boolean;
  onPersistEntry?: (entry: { transaction: Transaction; draft: BookingDraft }) => void | Promise<void>;
}

export default function App({ seed, dataAdapter, role = 'admin', assetsAvailable = true, busy = false, onPersistEntry }: ProAccountingWorkspaceProps) {
  const [currentView, setCurrentView] = useState<AppView>('inbox');
  const [selectedTransactionId, setSelectedTransactionId] = useState<string | null>(null);
  const [inboxPreviewTransactionId, setInboxPreviewTransactionId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!seed) return;
    hydrateMockStore({
      transactions: seed.transactions,
      drafts: seed.drafts,
      accounts: seed.accounts,
      chartFramework: seed.chartFramework,
      bankAccountNumber: seed.bankAccountNumber,
      bankAccountNumberByTransactionId: seed.bankAccountNumberByTransactionId,
    });
    setVersion((v) => v + 1);
  }, [seed?.seedVersion, seed?.transactions, seed?.drafts, seed?.accounts, seed?.chartFramework, seed?.bankAccountNumber, seed?.bankAccountNumberByTransactionId]);

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

  const transactions = useMemo(
    () => (dataAdapter ? seed?.transactions ?? [] : listTransactions()),
    [dataAdapter, seed?.seedVersion, seed?.transactions, version],
  );
  const accounts = dataAdapter ? seed?.accounts ?? [] : undefined;

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const handleOpenTransaction = (transactionId: string) => {
    setInboxPreviewTransactionId(null);
    setSelectedTransactionId(transactionId);
    setCurrentView('editor');
  };

  const handleBackToInbox = () => {
    setCurrentView('inbox');
    setSelectedTransactionId(null);
    refresh();
  };

  return (
    <div className="flex flex-col h-full w-full text-foreground">
      <div className="flex items-center gap-1 px-6 pt-2 shrink-0 border-b border-subtle">
        <nav className="flex items-center gap-0.5">
          {(
            [
              { view: 'inbox', label: 'Inbox' },
              { view: 'reconciliation', label: 'Abgleich' },
              { view: 'exceptions', label: 'Exceptions' },
              ...(assetsAvailable ? [{ view: 'assets' as const, label: 'Anlagen' }] : []),
              { view: 'reports', label: 'Auswertungen' },
              { view: 'opos', label: 'OPOS' },
            ] as { view: AppView; label: string }[]
          ).map(({ view, label }) => (
            <button
              key={view}
              onClick={() => setCurrentView(view)}
              aria-current={currentView === view ? 'page' : undefined}
              className={`px-4 py-2 text-sm font-bold transition-colors rounded-t-lg relative ${
                currentView === view
                  ? 'text-foreground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-dark-base'
                  : 'text-muted hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
        </nav>
      </div>

      <main className="flex-1 overflow-hidden">
        {busy ? <div className="sr-only" aria-live="polite">Speichere Änderung…</div> : null}
        <div className="h-full overflow-hidden flex flex-col">
          {currentView === 'inbox' ? (
            <InboxView
              role={role}
              accounts={accounts}
              bankAccountNumber={seed?.bankAccountNumber}
              bankAccountNumberByTransactionId={seed?.bankAccountNumberByTransactionId}
              transactions={transactions}
              onOpenTransaction={handleOpenTransaction}
              onRefresh={refresh}
              forcedPreviewTransactionId={inboxPreviewTransactionId}
            />
          ) : currentView === 'editor' ? (
            <BookingEditor
              transactionId={selectedTransactionId}
              role={role}
              accounts={accounts}
              onBack={handleBackToInbox}
              onStoreChange={refresh}
            />
          ) : currentView === 'reconciliation' ? (
            <ReconciliationWorkbench
              role={role}
              accounts={accounts}
              bankAccountNumber={seed?.bankAccountNumber}
              bankAccountNumberByTransactionId={seed?.bankAccountNumberByTransactionId}
              transactions={transactions}
              onOpenTransaction={handleOpenTransaction}
              onRefresh={refresh}
            />
          ) : currentView === 'exceptions' ? (
            <ExceptionCenter
              role={role}
              canMutateExceptions={!dataAdapter && role !== 'viewer' && role !== 'sales' && role !== 'auditor'}
              transactions={transactions}
              onOpenTransaction={handleOpenTransaction}
              onRefresh={refresh}
            />
          ) : currentView === 'reports' ? (
            <ReportsView
              dataAdapter={dataAdapter}
              chartFramework={seed?.chartFramework}
              role={role}
              onOpenTransaction={handleOpenTransaction}
            />
          ) : currentView === 'opos' ? (
            <OposView dataAdapter={dataAdapter} role={role} />
          ) : currentView === 'assets' && !assetsAvailable ? (
            <div className="p-6 text-sm text-muted">Anlagen sind in dieser Verbindung nicht verfügbar.</div>
          ) : (
            <AssetManagementView dataAdapter={dataAdapter} role={role} />
          )}
        </div>
      </main>
    </div>
  );
}
