import React from 'react';
import { Outlet, useBlocker, useNavigate, useRouterState } from '@tanstack/react-router';
import { Button, Card, ConfirmDialog, EmptyState, useActionFeedback } from '@billme/ui';
import type { AppSettings, Invoice, Offer } from '@billme/desktop-core/types';
import { templateKindSchema } from '@billme/server-core/domain';
import { calculateInvoiceTaxSnapshot, resolveInvoiceTaxMode } from '@billme/server-core/services';
import { localIsoDate } from '@billme/desktop-utils';
import { DashboardHome, TemplatesView, shouldShowBusinessOnboarding } from '../ui';
import { ShortcutsModal } from '../ui/components/ShortcutsModal';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import { useSettingsQuery } from '../hooks/useSettings';
import { useUpsertInvoiceMutation } from '../hooks/useInvoices';
import { useUpsertOfferMutation } from '../hooks/useOffers';
import { useCreateIntent } from '../hooks/useCreateIntent';
import { useUiStore } from '../ui-store';
import { ipc } from '../runtime-api';
import { DocumentsView } from './InvoicesView';

// The editors pull in the designer and drag-and-drop; they load when first opened.
const TemplateEditor = React.lazy(() => import('./TemplateEditor').then((module) => ({ default: module.TemplateEditor })));
const InvoiceDocumentEditor = React.lazy(() =>
  import('./InvoiceDocumentEditor').then((module) => ({ default: module.InvoiceDocumentEditor })),
);

// Pages both products mount unchanged. Route trees stay in each app because
// TanStack's `Register` declaration must be unique per program.

type AppLayoutProps = {
  /** Product shell: navigation and title bar. */
  Layout: React.ComponentType<{ isEditorActive: boolean; children: React.ReactNode }>;
  /** Product onboarding; shown until the business profile is complete. */
  Onboarding: React.ComponentType<{ settings: AppSettings; onComplete: () => void }>;
};

export const AppRootLayout: React.FC<AppLayoutProps> = ({ Layout, Onboarding }) => {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [showShortcuts, setShowShortcuts] = React.useState(false);

  const { data: settings } = useSettingsQuery();
  const showOnboarding = shouldShowBusinessOnboarding(settings);

  const isEditorActive = pathname.includes('/edit') || pathname.includes('/editor');

  useKeyboardShortcuts({
    onShowShortcuts: () => setShowShortcuts(true),
  });

  return (
    <>
      <Layout isEditorActive={isEditorActive}>
        <Outlet />
      </Layout>
      {showOnboarding && settings && (
        <Onboarding
          settings={settings}
          onComplete={() => {
            // Settings query will auto-refresh; wizard disappears when onboardingCompleted=true
          }}
        />
      )}
      <ShortcutsModal open={showShortcuts} onClose={() => setShowShortcuts(false)} />
    </>
  );
};

export const DashboardPage: React.FC = () => {
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

export const NotFoundPage: React.FC = () => {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-full items-center justify-center">
      <Card padding="none" className="w-full max-w-md">
        <EmptyState
          title="Seite nicht gefunden"
          description="Die angeforderte Seite konnte nicht gefunden werden."
          action={
            <Button variant="secondary" onClick={() => navigate({ to: '/' })}>
              Zurück zur Übersicht
            </Button>
          }
        />
      </Card>
    </div>
  );
};

export const TemplatesPage: React.FC = () => {
  const navigate = useNavigate();
  return (
    <TemplatesView
      onOpenTemplate={(id) => navigate({ to: '/templates/$id', params: { id } })}
      onCreateTemplate={(kind) => navigate({ to: '/templates/$id', params: { id: 'new' }, search: { kind } })}
    />
  );
};

export const TemplateEditorPage: React.FC<{ templateId: string }> = ({ templateId }) => {
  const navigate = useNavigate();
  const search = useRouterState({ select: (s) => s.location.search }) as Record<string, unknown>;
  const kind = templateKindSchema.safeParse(search.kind);
  return (
    <React.Suspense fallback={null}>
      <TemplateEditor
        templateId={templateId}
        kind={kind.success ? kind.data : 'invoice'}
        onBack={() => navigate({ to: '/templates' })}
        onCreated={(id) => navigate({ to: '/templates/$id', params: { id }, replace: true })}
      />
    </React.Suspense>
  );
};

export const DocumentsPage: React.FC = () => {
  const navigate = useNavigate();
  const { notify } = useActionFeedback('documents');
  const setEditingInvoice = useUiStore((s) => s.setEditingInvoice);
  const { data: settings } = useSettingsQuery();
  const locationSearch = useRouterState({ select: (s) => s.location.search }) as Record<string, unknown>;
  const initialDocumentType = locationSearch.kind === 'offer' ? 'offer' : 'invoice';
  const initialSelectedId = typeof locationSearch.id === 'string' ? locationSearch.id : undefined;
  const initialStatus = locationSearch.status === 'overdue' ? 'overdue' as const : undefined;
  const dueWithinDays = Number(locationSearch.due);
  const initialScope = Number.isInteger(dueWithinDays) && dueWithinDays > 0
    ? { dueWithinDays }
    : locationSearch.unpaid !== undefined ? 'unpaid' as const : undefined;

  const handleCreateDocument = (type: 'invoice' | 'offer') => {
    const numbers = ipc.numbers;
    void (async () => {
      // A document cannot be priced without the user's own tax settings, and a
      // fabricated fallback would put demo values on a real invoice.
      if (!settings) {
        notify('error', 'Einstellungen sind noch nicht geladen. Bitte erneut versuchen.');
        return;
      }

      try {
        const reservation = await numbers.reserve({ kind: type });
        if (ipc.numbers !== numbers) return;
        const newInvoice: Invoice = {
          id: Math.random().toString(36).substr(2, 9),
          number: reservation.number,
          numberReservationId: reservation.reservationId,
          client: '',
          clientEmail: '',
          taxMode: resolveInvoiceTaxMode(undefined, settings),
          date: localIsoDate(),
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
        notify('error', `Nummer konnte nicht reserviert werden: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  };

  // The command palette links to /documents?create=invoice|offer; wait for settings, which pricing needs.
  useCreateIntent('/documents', ['invoice', 'offer'] as const, handleCreateDocument, Boolean(settings));

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
      initialScope={initialScope}
    />
  );
};

/**
 * Lite offers one-click reasons for the GoBD change log; Pro asks for a free-text reason.
 * Both wordings are user-facing, so each product keeps its own.
 */
export const DocumentEditorPage: React.FC<{ reasonSuggestions?: readonly string[] }> = ({ reasonSuggestions }) => {
  const navigate = useNavigate();
  const { notify } = useActionFeedback('documents');
  const invoice = useUiStore((s) => s.editingInvoice);
  const clearEditingInvoice = useUiStore((s) => s.clearEditingInvoice);
  const docType = useUiStore((s) => s.editingDocumentType);
  const docMode = useUiStore((s) => s.editingDocumentMode);
  const upsertInvoice = useUpsertInvoiceMutation();
  const upsertOffer = useUpsertOfferMutation();
  const [isReasonOpen, setIsReasonOpen] = React.useState(false);
  const [pendingDoc, setPendingDoc] = React.useState<Invoice | Offer | null>(null);
  const [reason, setReason] = React.useState('');
  // Back navigation (browser back, Alt+Left) with unsaved changes asks first; the editor's own
  // Zurück/Speichern set `leavingRef` because they already confirmed or saved.
  const dirtyRef = React.useRef(false);
  const leavingRef = React.useRef(false);
  const onDirtyChange = React.useCallback((dirty: boolean) => { dirtyRef.current = dirty; }, []);
  const blocker = useBlocker({
    shouldBlockFn: () => dirtyRef.current && !leavingRef.current,
    enableBeforeUnload: false,
    withResolver: true,
  });

  // Leaving a new document without saving or cancelling (back navigation, hash change)
  // gives its reserved number back. The deferred check skips StrictMode's remount.
  const mountedRef = React.useRef(false);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const left = useUiStore.getState();
      const reservationId = left.editingDocumentMode === 'create' ? left.editingInvoice?.numberReservationId : undefined;
      if (!reservationId) return;
      setTimeout(() => {
        if (mountedRef.current || useUiStore.getState().editingInvoice !== left.editingInvoice) return;
        useUiStore.getState().clearEditingInvoice();
        void ipc.numbers.release({ reservationId }).catch(() => undefined);
      });
    };
  }, []);

  if (!invoice) {
    return (
      <div className="flex min-h-full items-center justify-center p-5">
        <Card padding="none" className="w-full max-w-md">
          <EmptyState
            title="Kein Dokument ausgewählt"
            description="Bitte wähle zuerst ein Dokument aus der Liste aus."
            action={
              <Button variant="secondary" onClick={() => navigate({ to: '/documents' })}>
                Zurück zu Dokumenten
              </Button>
            }
          />
        </Card>
      </div>
    );
  }

  const submitSave = () => {
    const trimmed = reason.trim();
    if (!pendingDoc) return;

    const mutation = docType === 'offer' ? upsertOffer : upsertInvoice;
    const vars = docType === 'offer' ? { offer: pendingDoc, reason: trimmed } : { invoice: pendingDoc, reason: trimmed };

    (mutation as any).mutate(vars, {
      onSuccess: () => {
        setIsReasonOpen(false);
        setPendingDoc(null);
        setReason('');
        clearEditingInvoice();
        leavingRef.current = true;
        navigate({ to: '/documents', search: docType === 'offer' ? { kind: 'offer' } : {} });
      },
      onError: (error: unknown) => notify('error', `Speichern fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`),
    });
  };

  return (
    <>
      <React.Suspense fallback={null}>
        <InvoiceDocumentEditor
          invoice={invoice}
          templateType={docType === 'offer' ? 'offer' : 'invoice'}
          mode={docMode ?? 'edit'}
          onSave={(updated, meta) => {
            const numberNote = meta?.numberChangeReason ? `Nummer manuell geändert: ${meta.numberChangeReason}` : undefined;
            if (docMode === 'create') {
              const numbers = ipc.numbers;
              const persistedDoc = { ...updated };

              void (async () => {
                try {
                  const mutation = docType === 'offer' ? upsertOffer : upsertInvoice;
                  const vars =
                    docType === 'offer'
                      ? { offer: persistedDoc, reason: numberNote ? `create; ${numberNote}` : 'create' }
                      : { invoice: persistedDoc, reason: numberNote ? `create; ${numberNote}` : 'create' };
                  await (mutation as any).mutateAsync(vars);
                  if (ipc.numbers !== numbers) return;
                  clearEditingInvoice();
                  leavingRef.current = true;
                  navigate({ to: '/documents', search: docType === 'offer' ? { kind: 'offer' } : {} });
                } catch (error) {
                  notify('error', `Speichern fehlgeschlagen: ${error instanceof Error ? error.message : String(error)}`);
                }
              })();
              return;
            }

            setPendingDoc(updated);
            // The number unlock reason is the audit reason unless the user writes another.
            setReason(numberNote ?? '');
            setIsReasonOpen(true);
          }}
          onDirtyChange={onDirtyChange}
          onCancel={() => {
            const numbers = ipc.numbers;
            void (async () => {
              if (docMode === 'create' && invoice.numberReservationId) {
                try {
                  await numbers.release({ reservationId: invoice.numberReservationId });
                } catch {
                  // Ignore release failures to avoid trapping users in editor.
                }
              }
              if (ipc.numbers !== numbers) return;
              clearEditingInvoice();
              leavingRef.current = true;
              navigate({ to: '/documents', search: { kind: docType } });
            })();
          }}
        />
      </React.Suspense>

      <ConfirmDialog
        open={blocker.status === 'blocked'}
        title="Ungespeicherte Änderungen verwerfen?"
        description="Du verlässt den Editor. Deine bisher eingetragenen Änderungen gehen verloren."
        confirmLabel="Änderungen verwerfen"
        cancelLabel="Weiter bearbeiten"
        destructive
        onConfirm={() => blocker.proceed?.()}
        onCancel={() => blocker.reset?.()}
      />
      <ConfirmDialog
        open={isReasonOpen}
        title="Grund der Änderung"
        description="Bitte gib einen Grund an. Dieser wird im Audit-Log gespeichert (GoBD)."
        confirmLabel="Speichern"
        cancelLabel="Abbrechen"
        reason={{
          label: reasonSuggestions ? 'Eigener Grund' : 'Grund (Pflicht)',
          placeholder: reasonSuggestions ? 'Oder eigenen Grund eingeben…' : 'z. B. Korrektur der Lieferadresse, Preis angepasst …',
          required: true,
          value: reason,
          onChange: setReason,
        }}
        details={reasonSuggestions && (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Vorschläge für den Änderungsgrund">
            {reasonSuggestions.map((chip) => (
              <Button
                key={chip}
                variant="secondary"
                size="sm"
                aria-pressed={reason === chip}
                onClick={() => setReason(chip)}
                className={`rounded-full ${reason === chip ? 'border-foreground bg-foreground text-ground hover:border-foreground hover:bg-foreground' : ''}`}
              >
                {chip}
              </Button>
            ))}
          </div>
        )}
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
