import React from 'react';
import {
  Outlet,
  RouterProvider,
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
  useRouterState,
} from '@tanstack/react-router';
import { DashboardLayout } from './components/DashboardLayout';
import {
  DashboardHome,
  TemplatesView,
} from './components/DashboardViews';
import { AccountsView } from './components/AccountsView';
import { DocumentsView } from './components/InvoicesView';
import { ClientsView } from './components/ClientsView';
import { ArticlesView } from './components/ArticlesView';
import { SettingsView } from './components/SettingsView';
import { StatisticsView } from './components/StatisticsView';
import { RecurringView } from './components/RecurringView';
import { ProjectsView } from './components/ProjectsView';
import { ProjectDetailView } from './components/ProjectDetailView';
import { FinanceHubView } from './components/FinanceHubView';
import { InvoiceEditor } from './components/InvoiceEditor';
import { InvoiceDocumentEditor } from './components/InvoiceDocumentEditor';
import { useUiStore } from './state/uiStore';
import { Invoice } from './types';
import { useUpsertInvoiceMutation } from './hooks/useInvoices';
import { useUpsertOfferMutation } from './hooks/useOffers';
import { ipc } from './ipc/client';

const RootLayout: React.FC = () => {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const activePage = (() => {
    if (pathname.startsWith('/finance') || pathname.startsWith('/accounts') || pathname.startsWith('/statistics'))
      return 'finance';
    if (pathname.startsWith('/templates') || pathname.startsWith('/recurring')) return 'documents';
    if (pathname.startsWith('/documents')) return 'documents';
    if (pathname.startsWith('/clients')) return 'clients';
    if (pathname.startsWith('/projects')) return 'projects';
    if (pathname.startsWith('/articles')) return 'articles';
    if (pathname.startsWith('/settings')) return 'settings';
    return 'dashboard';
  })();

  const isEditorActive = pathname.includes('/edit') || pathname.includes('/editor');

  const handleNavigate = (page: string) => {
    const to =
      page === 'dashboard'
        ? '/'
        : `/${page}`;
    navigate({ to });
  };

  return (
    <DashboardLayout
      activePage={activePage}
      onNavigate={handleNavigate}
      isEditorActive={isEditorActive}
    >
      <Outlet />
    </DashboardLayout>
  );
};

const DashboardPage: React.FC = () => {
  const navigate = useNavigate();
  return (
    <DashboardHome
      onNavigate={(page) => {
        const to = page === 'dashboard' ? '/' : `/${page}`;
        navigate({ to });
      }}
    />
  );
};

const StatisticsPage: React.FC = () => <StatisticsView />;
const AccountsPage: React.FC = () => <AccountsView />;
const FinancePage: React.FC = () => <FinanceHubView />;
const ClientsPage: React.FC = () => <ClientsView />;
const ProjectsPage: React.FC = () => <ProjectsView />;
const ArticlesPage: React.FC = () => <ArticlesView />;
const SettingsPage: React.FC = () => <SettingsView />;
const RecurringPage: React.FC = () => <RecurringView />;

const TemplatesPage: React.FC = () => {
  const navigate = useNavigate();
  return (
    <TemplatesView
      onOpenEditor={(type) => navigate({ to: `/templates/${type}/editor` })}
    />
  );
};

const TemplateEditorPage: React.FC<{ templateType: 'invoice' | 'offer' }> = ({
  templateType,
}) => {
  const navigate = useNavigate();
  return (
    <InvoiceEditor
      templateType={templateType}
      onBack={() => navigate({ to: '/templates' })}
    />
  );
};

const DocumentsPage: React.FC = () => {
  const navigate = useNavigate();
  const setEditingInvoice = useUiStore((s) => s.setEditingInvoice);
  const locationSearch = window.location.search;
  const deepLink = React.useMemo(() => {
    const params = new URLSearchParams(locationSearch);
    const id = params.get('id');
    if (!id) return null;
    const kind = params.get('kind') === 'offer' ? 'offer' : 'invoice';
    return { kind, id } as const;
  }, [locationSearch]);

  const handleCreateDocument = (type: 'invoice' | 'offer') => {
    void (async () => {
      try {
        const reservation = await ipc.numbers.reserve({ kind: type });
        const newInvoice: Invoice = {
          id: Math.random().toString(36).substr(2, 9),
          number: reservation.number,
          numberReservationId: reservation.reservationId,
          client: '',
          clientEmail: '',
          date: new Date().toISOString().split('T')[0] ?? '',
          dueDate: '',
          amount: 0,
          status: 'draft',
          items: [],
          payments: [],
          history: [],
        };
        setEditingInvoice(newInvoice, type, 'create');
        navigate({ to: '/documents/edit' });
      } catch (error) {
        alert(`Nummer konnte nicht reserviert werden: ${String(error)}`);
      }
    })();
  };

  return (
    <DocumentsView
      onOpenTemplates={() => navigate({ to: '/templates' })}
      onOpenRecurring={() => navigate({ to: '/recurring' })}
      onEditInvoice={(invoice, type) => {
        setEditingInvoice(invoice, type, 'edit');
        navigate({ to: '/documents/edit' });
      }}
      onCreateInvoice={handleCreateDocument}
      initialDocumentType={deepLink?.kind}
      initialSelectedId={deepLink?.id}
    />
  );
};

const DocumentEditorPage: React.FC = () => {
  const navigate = useNavigate();
  const invoice = useUiStore((s) => s.editingInvoice);
  const clearEditingInvoice = useUiStore((s) => s.clearEditingInvoice);
  const docType = useUiStore((s) => s.editingDocumentType);
  const docMode = useUiStore((s) => s.editingDocumentMode);
  const upsertInvoice = useUpsertInvoiceMutation();
  const upsertOffer = useUpsertOfferMutation();
  const [isReasonOpen, setIsReasonOpen] = React.useState(false);
  const [pendingDoc, setPendingDoc] = React.useState<Invoice | null>(null);
  const [reason, setReason] = React.useState('');
  const [reasonError, setReasonError] = React.useState<string | null>(null);

  if (!invoice) {
    return (
      <div className="bg-white rounded-[2.5rem] p-8 min-h-full shadow-sm">
        <h2 className="text-xl font-bold text-gray-900 mb-2">Kein Dokument ausgewählt</h2>
        <p className="text-sm text-gray-500 mb-6">
          Bitte wähle zuerst ein Dokument aus der Liste aus.
        </p>
        <button
          onClick={() => navigate({ to: '/documents' })}
          className="px-6 py-3 rounded-xl font-bold bg-black text-white hover:bg-gray-800 transition-colors"
        >
          Zurück zu Dokumenten
        </button>
      </div>
    );
  }

  const submitSave = () => {
    const trimmed = reason.trim();
    if (!trimmed) {
      setReasonError('Grund der Änderung ist Pflicht.');
      return;
    }
    if (!pendingDoc) return;

    const mutation = docType === 'offer' ? upsertOffer : upsertInvoice;
    const vars = docType === 'offer' ? { offer: pendingDoc, reason: trimmed } : { invoice: pendingDoc, reason: trimmed };

    (mutation as any).mutate(vars, {
      onSettled: () => {
        setIsReasonOpen(false);
        setPendingDoc(null);
        setReason('');
        setReasonError(null);
        clearEditingInvoice();
        navigate({ to: '/documents' });
      },
    });
  };

  return (
    <>
      <InvoiceDocumentEditor
        invoice={invoice}
        templateType={docType === 'offer' ? 'offer' : 'invoice'}
        mode={docMode ?? 'edit'}
        onSave={(updated) => {
          if (docMode === 'create') {
            const reservationId = updated.numberReservationId;
            const persistedDoc = { ...updated };
            delete persistedDoc.numberReservationId;

            void (async () => {
              try {
                const mutation = docType === 'offer' ? upsertOffer : upsertInvoice;
                const vars =
                  docType === 'offer'
                    ? { offer: persistedDoc, reason: 'create' }
                    : { invoice: persistedDoc, reason: 'create' };
                const saved = await (mutation as any).mutateAsync(vars);
                if (reservationId) {
                  await ipc.numbers.finalize({
                    reservationId,
                    documentId: saved.id,
                  });
                }
                clearEditingInvoice();
                navigate({ to: '/documents' });
              } catch (error) {
                alert(`Speichern fehlgeschlagen: ${String(error)}`);
              }
            })();
            return;
          }

          setPendingDoc(updated);
          setReason('');
          setReasonError(null);
          setIsReasonOpen(true);
        }}
        onCancel={() => {
          void (async () => {
            if (docMode === 'create' && invoice.numberReservationId) {
              try {
                await ipc.numbers.release({ reservationId: invoice.numberReservationId });
              } catch {
                // Ignore release failures to avoid trapping users in editor.
              }
            }
            clearEditingInvoice();
            navigate({ to: '/documents' });
          })();
        }}
      />

      {isReasonOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setIsReasonOpen(false);
              setPendingDoc(null);
              setReason('');
              setReasonError(null);
            }
          }}
        >
          <div className="w-full max-w-lg rounded-3xl bg-white shadow-xl p-6">
            <h3 className="text-lg font-bold text-gray-900 mb-2">Grund der Änderung</h3>
            <p className="text-sm text-gray-500 mb-4">
              Bitte gib einen Grund an. Dieser wird im Audit-Log gespeichert (GoBD).
            </p>

            <label className="text-xs font-bold text-gray-700">Grund (Pflicht)</label>
            <textarea
              autoFocus
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (reasonError) setReasonError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setIsReasonOpen(false);
                  setPendingDoc(null);
                  setReason('');
                  setReasonError(null);
                  return;
                }
                if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                  e.preventDefault();
                  submitSave();
                }
              }}
              rows={4}
              className="mt-2 w-full rounded-2xl border border-gray-200 bg-gray-50 px-4 py-3 text-sm outline-none focus:border-black"
              placeholder="z.B. Korrektur der Lieferadresse, Preis angepasst, ..."
            />
            {reasonError && <div className="mt-2 text-sm font-bold text-red-600">{reasonError}</div>}

            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                className="px-5 py-2.5 rounded-xl font-bold bg-gray-100 text-gray-900 hover:bg-gray-200 transition-colors"
                onClick={() => {
                  setIsReasonOpen(false);
                  setPendingDoc(null);
                  setReason('');
                  setReasonError(null);
                }}
              >
                Abbrechen
              </button>
              <button
                className="px-5 py-2.5 rounded-xl font-bold bg-black text-white hover:bg-gray-800 transition-colors"
                onClick={submitSave}
              >
                Speichern
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

const rootRoute = createRootRoute({
  component: RootLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: DashboardPage,
});

const statisticsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/statistics',
  component: StatisticsPage,
});

const accountsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accounts',
  component: AccountsPage,
});

const financeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/finance',
  component: FinancePage,
});

const templatesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/templates',
  component: TemplatesPage,
});

const templateEditorRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/templates/$type/editor',
  component: () => {
    const params = templateEditorRoute.useParams();
    const type = params.type === 'offer' ? 'offer' : 'invoice';
    return <TemplateEditorPage templateType={type} />;
  },
});

const documentsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/documents',
  component: DocumentsPage,
});

const documentsEditRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/documents/edit',
  component: DocumentEditorPage,
});

const recurringRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/recurring',
  component: RecurringPage,
});

const clientsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/clients',
  component: ClientsPage,
});

const projectsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects',
  component: ProjectsPage,
});

const projectDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/projects/$projectId',
  component: ProjectDetailView,
});

const articlesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/articles',
  component: ArticlesPage,
});

const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  component: SettingsPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  statisticsRoute,
  accountsRoute,
  financeRoute,
  templatesRoute,
  templateEditorRoute,
  documentsRoute,
  documentsEditRoute,
  recurringRoute,
  clientsRoute,
  projectsRoute,
  projectDetailRoute,
  articlesRoute,
  settingsRoute,
]);

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export const AppRouterProvider: React.FC = () => <RouterProvider router={router} />;
