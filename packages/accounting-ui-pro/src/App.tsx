import { useCallback, useEffect, useMemo, useState } from 'react';
import InboxView from './components/InboxView';
import BookingEditor from './components/BookingEditor';
import ReconciliationWorkbench from './components/ReconciliationWorkbench';
import ExceptionCenter from './components/ExceptionCenter';
import AssetManagementView from './components/AssetManagementView';
import ReportsView from './components/ReportsView';
import OposView from './components/OposView';
import SonderbuchungenWorkspace from './components/SonderbuchungenWorkspace';
import { JournalEntryDetailModal } from './components/JournalEntryDetail';
import {
  configureStoreAdapter,
  configureStorePersistence,
  hydrateMockStore,
  listTransactions,
  type ProAccountingDataAdapter,
} from './services/mockBookingStore';
import { Account, BookingDraft, Transaction, UserRole } from './types';
import { reportTabsForBusinessProfile, type BusinessReportingProfile } from './domain/reportTypes';

type AppView = 'inbox' | 'editor' | 'reconciliation' | 'exceptions' | 'assets' | 'reports' | 'opos' | 'special';

export interface ProAccountingSeed {
  transactions?: Transaction[];
  accounts?: Account[];
  drafts?: BookingDraft[];
  chartFramework?: 'SKR03' | 'SKR04';
  businessReportingProfile?: BusinessReportingProfile;
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
  const [selectedJournalEntryId, setSelectedJournalEntryId] = useState<string | null>(null);
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
    <div className="flex h-full min-w-0 w-full flex-col text-foreground">
      <div className="shrink-0 overflow-x-auto border-b border-subtle px-3 pt-2 sm:px-6">
        <nav className="flex min-w-max items-center gap-0.5" aria-label="Buchhaltungsbereiche">
          {(
            [
              { view: 'inbox', label: 'Inbox' },
              { view: 'reconciliation', label: 'Abgleich' },
              { view: 'exceptions', label: 'Ausnahmen' },
              ...(assetsAvailable ? [{ view: 'assets' as const, label: 'Anlagen' }] : []),
              { view: 'reports', label: 'Auswertungen' },
              { view: 'opos', label: 'OPOS' },
              { view: 'special', label: 'Sonderbuchungen & Abschluss' },
            ] as { view: AppView; label: string }[]
          ).map(({ view, label }) => {
            const isActive = currentView === view || (view === 'inbox' && currentView === 'editor');

            return (
              <button
                key={view}
                onClick={() => setCurrentView(view)}
                aria-current={isActive ? 'page' : undefined}
                className={`relative min-h-10 rounded-t-lg px-4 py-2 text-sm font-bold transition-colors active:scale-[0.96] ${
                  isActive
                    ? 'text-foreground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-dark-base'
                    : 'text-muted hover:text-foreground'
                }`}
              >
                {label}
              </button>
            );
          })}
        </nav>
      </div>

      <main className="min-w-0 flex-1 overflow-hidden">
        {busy ? <div className="sr-only" aria-live="polite">Speichere Änderung…</div> : null}
        <div className="flex h-full min-w-0 flex-col overflow-hidden">
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
              businessReportingProfile={seed?.businessReportingProfile}
              availableTabs={reportTabsForBusinessProfile(seed?.businessReportingProfile)}
              role={role}
              onOpenTransaction={handleOpenTransaction}
              onOpenJournalEntry={setSelectedJournalEntryId}
            />
          ) : currentView === 'opos' ? (
            <OposView dataAdapter={dataAdapter} role={role} />
          ) : currentView === 'special' ? (
            <SonderbuchungenWorkspace dataAdapter={dataAdapter} role={role} />
          ) : currentView === 'assets' && !assetsAvailable ? (
            <div className="p-6 text-sm text-muted">Anlagen sind in dieser Verbindung nicht verfügbar.</div>
          ) : (
            <AssetManagementView dataAdapter={dataAdapter} role={role} />
          )}
        </div>
      </main>
      <JournalEntryDetailModal entryId={selectedJournalEntryId} dataAdapter={dataAdapter} onClose={() => setSelectedJournalEntryId(null)} />
    </div>
  );
}
