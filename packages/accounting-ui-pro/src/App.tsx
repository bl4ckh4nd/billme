import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { ConfirmDialog } from '@billme/ui';
import InboxView from './components/InboxView';
import BookingEditor from './components/BookingEditor';
import ReconciliationWorkbench from './components/ReconciliationWorkbench';
import ExceptionCenter from './components/ExceptionCenter';
import AssetManagementView from './components/AssetManagementView';
import ReportsView from './components/ReportsView';
import OposView from './components/OposView';
import ReceiptsInbox from './components/ReceiptsInbox';
import WorkbenchQueue from './components/WorkbenchQueue';
import type { InboxQueueKey } from './domain/selectors';
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

export type AppView = 'inbox' | 'editor' | 'reconciliation' | 'exceptions' | 'assets' | 'reports' | 'opos' | 'special' | 'receipts';

const ROUTABLE_VIEWS: readonly AppView[] = ['inbox', 'reconciliation', 'exceptions', 'assets', 'reports', 'opos', 'special', 'receipts'];
const isAccountingView = (value: unknown): value is AppView =>
  typeof value === 'string' && (ROUTABLE_VIEWS as readonly string[]).includes(value);

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
  /** Area requested by the app route (`?view=`); unknown values fall back to the inbox. */
  view?: unknown;
  onPersistEntry?: (entry: { transaction: Transaction; draft: BookingDraft }) => void | Promise<void>;
  /** Routed hosts move the URL (`?view=`) when one area hands off to another. */
  onViewChange?: (view: AppView) => void;
}

export default function App({ seed, dataAdapter, role = 'admin', assetsAvailable = true, busy = false, view, onPersistEntry, onViewChange }: ProAccountingWorkspaceProps) {
  const [oposInvoiceId, setOposInvoiceId] = useState<string | null>(null);
  const [currentView, setCurrentView] = useState<AppView>(isAccountingView(view) ? view : 'inbox');

  useEffect(() => {
    if (isAccountingView(view)) setCurrentView(view);
  }, [view]);
  const [selectedTransactionId, setSelectedTransactionId] = useState<string | null>(null);
  const [queue, setQueue] = useState<InboxQueueKey>('all');
  const editorDirty = useRef(false);
  const [pendingSwitchId, setPendingSwitchId] = useState<string | null>(null);
  const handleDirtyChange = useCallback((dirty: boolean) => { editorDirty.current = dirty; }, []);
  // Switching from the queue drops unsaved edits, so it asks first.
  const selectFromQueue = useCallback((transactionId: string) => {
    if (transactionId === selectedTransactionId) return;
    if (editorDirty.current) setPendingSwitchId(transactionId);
    else setSelectedTransactionId(transactionId);
  }, [selectedTransactionId]);
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
      {/* Routed (the app shell's sidebar opens each area): no second navigation here.
          Standalone use without a route keeps the tab bar. */}
      {view === undefined ? (
      <div className="shrink-0 overflow-x-auto border-b border-border px-3 pt-2 sm:px-6">
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
                className={`relative min-h-10 rounded-t-lg px-4 py-2 text-sm font-semibold transition-colors ${
                  isActive
                    ? 'text-foreground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-dark-base'
                    : 'text-muted hover:text-foreground'
                }`}
              >
                {label}
              </button>
            );
          })}
          {dataAdapter ? null : (
            <span
              className="ml-2 inline-flex items-center gap-1 rounded-full border border-warning-border bg-warning-bg px-2 py-0.5 text-xs font-semibold text-warning-text"
              role="status"
              title="Ohne verbundene Datenquelle zeigen Buchungen, Ausnahmen und Auswertungen einen Demo-Datensatz."
            >
              <Info size={12} aria-hidden="true" />
              Beispieldaten
            </span>
          )}
        </nav>
      </div>
      ) : dataAdapter ? null : (
        <div className="shrink-0 px-4 pt-3">
          <span
            className="inline-flex items-center gap-1 rounded-full border border-warning-border bg-warning-bg px-2 py-0.5 text-xs font-semibold text-warning-text"
            role="status"
            title="Ohne verbundene Datenquelle zeigen Buchungen, Ausnahmen und Auswertungen einen Demo-Datensatz."
          >
            <Info size={12} aria-hidden="true" />
            Beispieldaten
          </span>
        </div>
      )}

      <div className="min-w-0 flex-1 overflow-hidden">
        {busy ? <div className="sr-only" aria-live="polite">Speichere Änderung…</div> : null}
        <div className="flex h-full min-w-0 flex-col overflow-hidden">
          {currentView === 'inbox' ? (
            <InboxView
              role={role}
              dataAdapter={dataAdapter}
              accounts={accounts}
              bankAccountNumber={seed?.bankAccountNumber}
              bankAccountNumberByTransactionId={seed?.bankAccountNumberByTransactionId}
              transactions={transactions}
              onOpenTransaction={handleOpenTransaction}
              onRefresh={refresh}
              forcedPreviewTransactionId={inboxPreviewTransactionId}
              activeQueue={queue}
              onQueueChange={setQueue}
            />
          ) : currentView === 'editor' ? (
            // Workbench: the queue stays beside the editor (below lg the editor takes the full width).
            <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)] lg:grid-cols-[264px_minmax(0,1fr)]">
              <div className="hidden min-h-0 lg:block">
                <WorkbenchQueue
                  transactions={transactions}
                  queue={queue}
                  onQueueChange={setQueue}
                  selectedId={selectedTransactionId}
                  onSelect={selectFromQueue}
                />
              </div>
              <BookingEditor
                key={selectedTransactionId ?? 'none'}
                transactionId={selectedTransactionId}
                role={role}
                accounts={accounts}
                onBack={handleBackToInbox}
                onStoreChange={refresh}
                onDirtyChange={handleDirtyChange}
              />
              <ConfirmDialog
                open={pendingSwitchId !== null}
                title="Ungespeicherte Änderungen verwerfen?"
                description="Die Buchung hat Änderungen, die noch nicht gespeichert sind. Beim Wechsel zum nächsten Vorgang gehen sie verloren."
                confirmLabel="Verwerfen und wechseln"
                cancelLabel="Weiter bearbeiten"
                destructive
                onConfirm={() => {
                  editorDirty.current = false;
                  setSelectedTransactionId(pendingSwitchId);
                  setPendingSwitchId(null);
                }}
                onCancel={() => setPendingSwitchId(null)}
              />
            </div>
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
            <OposView key={oposInvoiceId ?? 'opos'} dataAdapter={dataAdapter} role={role} initialInvoiceId={oposInvoiceId ?? undefined} />
          ) : currentView === 'receipts' ? (
            <ReceiptsInbox dataAdapter={dataAdapter} onOpenInvoice={(invoiceId) => { setOposInvoiceId(invoiceId); if (onViewChange) onViewChange('opos'); else setCurrentView('opos'); }} />
          ) : currentView === 'special' ? (
            <SonderbuchungenWorkspace dataAdapter={dataAdapter} role={role} />
          ) : currentView === 'assets' && !assetsAvailable ? (
            <div className="p-6 text-sm text-muted">Anlagen sind in dieser Verbindung nicht verfügbar.</div>
          ) : (
            <AssetManagementView dataAdapter={dataAdapter} role={role} />
          )}
        </div>
      </div>
      <JournalEntryDetailModal entryId={selectedJournalEntryId} dataAdapter={dataAdapter} onClose={() => setSelectedJournalEntryId(null)} />
    </div>
  );
}
