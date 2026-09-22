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
import { RecurringView } from './components/RecurringView';
import { ProjectsView } from './components/ProjectsView';
import { ProjectDetailView } from './components/ProjectDetailView';
import { InvoiceEditor } from './components/InvoiceEditor';
import { InvoiceDocumentEditor } from './components/InvoiceDocumentEditor';
import { useUiStore } from './state/uiStore';
import { Invoice } from './types';
import { useUpsertInvoiceMutation } from './hooks/useInvoices';
import { useUpsertOfferMutation } from './hooks/useOffers';
import { ipc } from './ipc/client';
import { useSettingsQuery } from './hooks/useSettings';
import { OnboardingWizard } from './components/OnboardingWizard';
import { ShortcutsModal } from './components/ShortcutsModal';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { ProAccountingPage } from './components/ProAccountingPage';
import { FinanceHubView } from './components/FinanceHubView';
import { EurView } from './components/EurView';
import { TaxFilingCenter } from './components/TaxFilingCenter';
import { Button, ConfirmDialog, EmptyState, useActionFeedback } from '@billme/ui';
import { shouldShowBusinessOnboarding } from '@billme/desktop-ui';
import { calculateInvoiceTaxSnapshot, resolveInvoiceTaxMode } from '@billme/server-core/services';

const RootLayout: React.FC = () => {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [showShortcuts, setShowShortcuts] = React.useState(false);

  const { data: settings } = useSettingsQuery();
  const showOnboarding = shouldShowBusinessOnboarding(settings);

  const activePage = (() => {
    if (
      pathname.startsWith('/finance')
      || pathname.startsWith('/accounts')
      || pathname.startsWith('/accounting')
      || pathname.startsWith('/eur')
    )
      return 'finance';
    if (pathname.startsWith('/tax-filing')) return 'tax-filing';
    if (pathname.startsWith('/templates') || pathname.startsWith('/recurring')) return 'documents';
    if (pathname.startsWith('/documents')) return 'documents';
    if (pathname.startsWith('/clients')) return 'clients';
    if (pathname.startsWith('/projects')) return 'projects';
    if (pathname.startsWith('/articles')) return 'articles';
    if (pathname.startsWith('/settings')) return 'settings';
    return 'dashboard';
  })();

  const isEditorActive = pathname.includes('/edit') || pathname.includes('/editor');

  const handleNavigate = (page: string, search?: Record<string, string>) => {
    const to =
      page === 'dashboard'
        ? '/'
        : `/${page}`;
    navigate({ to, search });
  };

  useKeyboardShortcuts({
    onShowShortcuts: () => setShowShortcuts(true),
  });

  return (
    <>
      <DashboardLayout
        activePage={activePage}
        onNavigate={handleNavigate}
        isEditorActive={isEditorActive}
      >
        <Outlet />
      </DashboardLayout>
      {showOnboarding && settings && (
        <OnboardingWizard
          settings={settings}
          onComplete={() => {
            // Settings query will auto-refresh; wizard disappears when onboardingCompleted=true
          }}
        />
      )}
      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
    </>
  );
};

const DashboardPage: React.FC = () => {
  const navigate = useNavigate();
  return (
    <DashboardHome
      onNavigate={(page, search) => {
        const to = page === 'dashboard' ? '/' : `/${page}`;
        navigate({ to, search });
      }}
    />
  );
};

const AccountsPage: React.FC = () => <AccountsView />;
const FinancePage: React.FC = () => <FinanceHubView />;
const EurPage: React.FC = () => <EurView />;
const ClientsPage: React.FC = () => <ClientsView />;
const ProjectsPage: React.FC = () => <ProjectsView />;
const ArticlesPage: React.FC = () => <ArticlesView />;
const SettingsPage: React.FC = () => <SettingsView />;
const RecurringPage: React.FC = () => <RecurringView />;
const TaxFilingPage: React.FC = () => <TaxFilingCenter />;

const NotFoundPage: React.FC = () => {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-full items-center justify-center rounded-3xl bg-surface p-8 shadow-sm">
      <EmptyState
        className="w-full max-w-md"
        title="Seite nicht gefunden"
        description="Die angeforderte Seite konnte nicht gefunden werden."
        action={
          <Button variant="dark" onClick={() => navigate({ to: '/' })}>
            Zurück zur Übersicht
          </Button>
        }
      />
    </div>
  );
};

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
  const { notify } = useActionFeedback('documents');
  const setEditingInvoice = useUiStore((s) => s.setEditingInvoice);
  const { data: settings } = useSettingsQuery();
  const locationSearch = useRouterState({ select: (s) => s.location.search }) as Record<string, unknown>;
  const initialDocumentType = locationSearch.kind === 'offer' ? 'offer' : 'invoice';
  const initialSelectedId = typeof locationSearch.id === 'string' ? locationSearch.id : undefined;
  const initialStatus = locationSearch.status === 'overdue' ? 'overdue' as const : undefined;

  const handleCreateDocument = (type: 'invoice' | 'offer') => {
    void (async () => {
      // A document cannot be priced without the user's own tax settings, and a
      // fabricated fallback would put demo values on a real invoice.
      if (!settings) {
        notify('error', 'Einstellungen sind noch nicht geladen. Bitte erneut versuchen.');
        return;
      }

      try {
        const reservation = await ipc.numbers.reserve({ kind: type });
        const newInvoice: Invoice = {
          id: Math.random().toString(36).substr(2, 9),
          number: reservation.number,
          numberReservationId: reservation.reservationId,
          client: '',
          clientEmail: '',
          taxMode: resolveInvoiceTaxMode(undefined, settings),
          date: new Date().toISOString().split('T')[0] ?? '',
          dueDate: '',
          amount: 0,
          status: 'draft',
          items: [],
          payments: [],
          history: [],
        };
        newInvoice.taxSnapshot = calculateInvoiceTaxSnapshot(
          { items: newInvoice.items, taxMode: newInvoice.taxMode },
          settings,
        );
        newInvoice.amount = newInvoice.taxSnapshot.grossAmount;
        setEditingInvoice(newInvoice, type, 'create');
        navigate({ to: '/documents/edit' });
      } catch (error) {
        notify('error', `Nummer konnte nicht reserviert werden: ${String(error)}`);
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
      initialDocumentType={initialDocumentType}
      initialSelectedId={initialSelectedId}
      initialStatus={initialStatus}
    />
  );
};

const DocumentEditorPage: React.FC = () => {
  const navigate = useNavigate();
  const { notify } = useActionFeedback('documents');
  const invoice = useUiStore((s) => s.editingInvoice);
  const clearEditingInvoice = useUiStore((s) => s.clearEditingInvoice);
  const docType = useUiStore((s) => s.editingDocumentType);
  const docMode = useUiStore((s) => s.editingDocumentMode);
  const upsertInvoice = useUpsertInvoiceMutation();
  const upsertOffer = useUpsertOfferMutation();
  const [isReasonOpen, setIsReasonOpen] = React.useState(false);
  const [pendingDoc, setPendingDoc] = React.useState<Invoice | null>(null);
  const [reason, setReason] = React.useState('');

  if (!invoice) {
    return (
      <div className="flex min-h-full items-center justify-center rounded-3xl bg-surface p-8 shadow-sm">
        <EmptyState
          className="w-full max-w-md"
          title="Kein Dokument ausgewählt"
          description="Bitte wähle zuerst ein Dokument aus der Liste aus."
          action={
            <Button variant="dark" onClick={() => navigate({ to: '/documents' })}>
              Zurück zu Dokumenten
            </Button>
          }
        />
      </div>
    );
  }

  const submitSave = () => {
    const trimmed = reason.trim();
    if (!pendingDoc) return;

    const mutation = docType === 'offer' ? upsertOffer : upsertInvoice;
    const vars = docType === 'offer' ? { offer: pendingDoc, reason: trimmed } : { invoice: pendingDoc, reason: trimmed };

    (mutation as any).mutate(vars, {
      onSettled: () => {
        setIsReasonOpen(false);
        setPendingDoc(null);
        setReason('');
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
                notify('error', `Speichern fehlgeschlagen: ${String(error)}`);
              }
            })();
            return;
          }

          setPendingDoc(updated);
          setReason('');
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

      <ConfirmDialog
        open={isReasonOpen}
        title="Grund der Änderung"
        description="Bitte gib einen Grund an. Dieser wird im Audit-Log gespeichert (GoBD)."
        confirmLabel="Speichern"
        cancelLabel="Abbrechen"
        reason={{
          label: 'Grund (Pflicht)',
          placeholder: 'z. B. Korrektur der Lieferadresse, Preis angepasst …',
          required: true,
          value: reason,
          onChange: setReason,
        }}
        onConfirm={submitSave}
        onCancel={() => {
          setIsReasonOpen(false);
          setPendingDoc(null);
          setReason('');
        }}
      />
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

const accountingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/accounting',
  component: ProAccountingPage,
});

const eurRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/eur',
  component: EurPage,
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

const taxFilingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/tax-filing',
  component: TaxFilingPage,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  accountsRoute,
  financeRoute,
  accountingRoute,
  eurRoute,
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
  taxFilingRoute,
]);

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultNotFoundComponent: NotFoundPage,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

export const AppRouterProvider: React.FC = () => <RouterProvider router={router} />;
