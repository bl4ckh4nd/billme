import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Info } from 'lucide-react';
import { Badge, ConfirmDialog } from '@billme/ui';
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
import { permissionContextForRole } from './domain/permissions';
import { createAccountingWorkspaceStore } from './services/mockBookingStore';
import type { ProAccountingDataAdapter } from './services/accountingDataAdapter';
import { AccountingWorkspaceContext, useAccountingWorkspace } from './AccountingWorkspaceContext';
import { Account, BookingDraft, Transaction, UserRole } from './types';
import { reportTabsForBusinessProfile, type BusinessReportingProfile } from './domain/reportTypes';

export type AppView = 'inbox' | 'editor' | 'reconciliation' | 'exceptions' | 'assets' | 'reports' | 'opos' | 'special' | 'tax' | 'receipts';

const SAMPLE_DATA_HINT = 'Ohne verbundene Datenquelle zeigen Buchungen, Ausnahmen und Auswertungen einen Demo-Datensatz.';

const ROUTABLE_VIEWS: readonly AppView[] = ['inbox', 'editor', 'reconciliation', 'exceptions', 'assets', 'reports', 'opos', 'special', 'tax', 'receipts'];
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
  /** Opens the rule settings; with a transaction id, prefilled from that bank line. */
  onManageRules?: (transactionId?: string) => void;
  /** Opens the host's ELSTER page from the Steuer area. */
  onOpenTaxFiling?: () => void;
}

export default function App(props: ProAccountingWorkspaceProps) {
  const [store] = useState(() => {
    const instance = createAccountingWorkspaceStore();
    instance.hydrateMockStore(props.seed ?? (props.dataAdapter ? { transactions: [], drafts: [], accounts: [] } : {}));
    instance.configureStoreAdapter(props.dataAdapter);
    instance.configureStorePersistence({ onPersistEntry: props.onPersistEntry });
    return instance;
  });
  useLayoutEffect(() => {
    store.configureStoreAdapter(props.dataAdapter);
    store.hydrateMockStore(props.seed ?? (props.dataAdapter ? { transactions: [], drafts: [], accounts: [] } : {}));
  }, [store, props.dataAdapter, props.seed]);
  useLayoutEffect(() => {
    store.configureStorePersistence({ onPersistEntry: props.onPersistEntry });
  }, [store, props.onPersistEntry]);
  return <AccountingWorkspaceContext.Provider value={store}><Workspace {...props} /></AccountingWorkspaceContext.Provider>;
}

function Workspace({ seed, dataAdapter, role = 'admin', assetsAvailable = true, busy = false, view, onViewChange, onManageRules, onOpenTaxFiling }: ProAccountingWorkspaceProps) {
  const [oposInvoiceId, setOposInvoiceId] = useState<string | null>(null);
  const [requestedView, setCurrentView] = useState<AppView>(isAccountingView(view) ? view : 'inbox');

  useEffect(() => {
    if (isAccountingView(view)) setCurrentView(view);
  }, [view]);
  const [selectedTransactionId, setSelectedTransactionId] = useState<string | null>(null);
  // The editor works on one bank line; without one (a reload of `?view=editor`) it is the inbox.
  const currentView: AppView = requestedView === 'editor' && !selectedTransactionId ? 'inbox' : requestedView;
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
  const [, setVersion] = useState(0);

  const store = useAccountingWorkspace();
  const transactions = dataAdapter ? seed?.transactions ?? [] : store.listTransactions();
  const accounts = seed?.accounts ?? store.listAccounts();

  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  /** Routed hosts own the area (`?view=`): a handoff moves the URL, otherwise reload and the navigation disagree with the screen. */
  const showView = (next: AppView) => {
    if (onViewChange) onViewChange(next);
    else setCurrentView(next);
  };

  const handleOpenTransaction = (transactionId: string) => {
    setInboxPreviewTransactionId(null);
    setSelectedTransactionId(transactionId);
    showView('editor');
  };

  const handleBackToInbox = () => {
    showView('inbox');
    setSelectedTransactionId(null);
    refresh();
  };

  return (
    <div className="flex min-w-0 w-full flex-col text-foreground">
      {/* Routed (the app shell's sidebar opens each area): no second navigation here.
          Standalone use without a route keeps the tab bar. */}
      {view === undefined ? (
      <div className="mb-3 shrink-0 overflow-x-auto border-b border-border">
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
              { view: 'tax', label: 'Steuer' },
            ] as { view: AppView; label: string }[]
          ).map(({ view, label }) => {
            const isActive = currentView === view || (view === 'inbox' && currentView === 'editor');

            return (
              <button
                key={view}
                onClick={() => showView(view)}
                aria-current={isActive ? 'page' : undefined}
                className={`relative h-8.5 px-3 text-label transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring ${
                  isActive
                    ? 'text-foreground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-foreground'
                    : 'text-muted hover:text-foreground'
                }`}
              >
                {label}
              </button>
            );
          })}
          {dataAdapter ? null : (
            <span className="ml-2 inline-flex" role="status" title={SAMPLE_DATA_HINT}>
              <Badge tone="warning"><Info size={12} aria-hidden="true" /> Beispieldaten</Badge>
            </span>
          )}
        </nav>
      </div>
      ) : dataAdapter ? null : (
        <div className="mb-3 shrink-0">
          <span className="inline-flex" role="status" title={SAMPLE_DATA_HINT}>
            <Badge tone="warning"><Info size={12} aria-hidden="true" /> Beispieldaten</Badge>
          </span>
        </div>
      )}

      <div className="min-w-0">
        {busy ? <div className="sr-only" aria-live="polite">Speichere Änderung…</div> : null}
        <div className="flex min-w-0 flex-col">
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
            // Workbench: queue, editor and aside as three panes on the ground, sized by the content
            // width beside the rail. Narrower, the aside moves under them, then the queue is hidden.
            <div className="@container">
            <div className="grid items-start gap-3 @2xl:grid-cols-[264px_minmax(0,1fr)] @5xl:grid-cols-[264px_minmax(0,1fr)_312px]">
              <div className="hidden min-w-0 @2xl:block">
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
                corporation={seed?.businessReportingProfile?.legalForm === 'gmbh' || seed?.businessReportingProfile?.legalForm === 'ug'}
                onBack={handleBackToInbox}
                onStoreChange={refresh}
                onDirtyChange={handleDirtyChange}
                receiptApi={dataAdapter}
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
              dataAdapter={dataAdapter}
              onManageRules={onManageRules}
              onOpenInvoice={(invoiceId) => { setOposInvoiceId(invoiceId); showView('opos'); }}
            />
          ) : currentView === 'exceptions' ? (
            <ExceptionCenter
              role={role}
              canMutateExceptions={(!dataAdapter || Boolean(dataAdapter.updateExceptionCase)) && role !== 'viewer' && role !== 'sales' && role !== 'auditor'}
              transactions={transactions}
              dataAdapter={dataAdapter}
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
            <ReceiptsInbox dataAdapter={dataAdapter} onOpenInvoice={(invoiceId) => { setOposInvoiceId(invoiceId); showView('opos'); }} />
          ) : currentView === 'special' ? (
            <SonderbuchungenWorkspace dataAdapter={dataAdapter} role={role} accounts={accounts} chart={seed?.chartFramework} businessReportingProfile={seed?.businessReportingProfile} />
          ) : currentView === 'tax' ? (
            <SonderbuchungenWorkspace area="tax" onOpenTaxFiling={onOpenTaxFiling} dataAdapter={dataAdapter} role={role} accounts={accounts} chart={seed?.chartFramework} businessReportingProfile={seed?.businessReportingProfile} />
          ) : currentView === 'assets' && !assetsAvailable ? (
            <div className="text-control text-muted">Anlagen sind in dieser Verbindung nicht verfügbar.</div>
          ) : (
            <AssetManagementView dataAdapter={dataAdapter} role={role} />
          )}
        </div>
      </div>
      <JournalEntryDetailModal entryId={selectedJournalEntryId} dataAdapter={dataAdapter} accounts={accounts} canMutate={permissionContextForRole(role).canMutate} onClose={() => setSelectedJournalEntryId(null)} />
    </div>
  );
}
