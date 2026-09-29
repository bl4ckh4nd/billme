import React from 'react';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { Button, ConfirmDialog, EmptyState, useActionFeedback } from '@billme/ui';
import type { AppSettings, Invoice } from '@billme/desktop-core/types';
import { templateKindSchema } from '@billme/server-core/domain';
import { calculateInvoiceTaxSnapshot, resolveInvoiceTaxMode } from '@billme/server-core/services';
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
import { TemplateEditor } from './TemplateEditor';
import { InvoiceDocumentEditor } from './InvoiceDocumentEditor';

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
    <TemplateEditor
      templateId={templateId}
      kind={kind.success ? kind.data : 'invoice'}
      onBack={() => navigate({ to: '/templates' })}
      onCreated={(id) => navigate({ to: '/templates/$id', params: { id }, replace: true })}
    />
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
        onSave={(updated, meta) => {
          const numberNote = meta?.numberChangeReason ? `Nummer manuell geändert: ${meta.numberChangeReason}` : undefined;
          if (docMode === 'create') {
            const numbers = ipc.numbers;
            const reservationId = updated.numberReservationId;
            const persistedDoc = { ...updated };
            delete persistedDoc.numberReservationId;

            void (async () => {
              try {
                const mutation = docType === 'offer' ? upsertOffer : upsertInvoice;
                const vars =
                  docType === 'offer'
                    ? { offer: persistedDoc, reason: numberNote ? `create; ${numberNote}` : 'create' }
                    : { invoice: persistedDoc, reason: numberNote ? `create; ${numberNote}` : 'create' };
                const saved = await (mutation as any).mutateAsync(vars);
                if (reservationId) {
                  await numbers.finalize({
                    reservationId,
                    documentId: saved.id,
                  });
                }
                if (ipc.numbers !== numbers) return;
                clearEditingInvoice();
                navigate({ to: '/documents' });
              } catch (error) {
                notify('error', `Speichern fehlgeschlagen: ${String(error)}`);
              }
            })();
            return;
          }

          setPendingDoc(updated);
          // The number unlock reason is the audit reason unless the user writes another.
          setReason(numberNote ?? '');
          setIsReasonOpen(true);
        }}
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
          label: reasonSuggestions ? 'Eigener Grund' : 'Grund (Pflicht)',
          placeholder: reasonSuggestions ? 'Oder eigenen Grund eingeben…' : 'z. B. Korrektur der Lieferadresse, Preis angepasst …',
          required: true,
          value: reason,
          onChange: setReason,
        }}
        details={reasonSuggestions && (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Vorschläge für den Änderungsgrund">
            {reasonSuggestions.map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => setReason(chip)}
                className={`rounded-control border px-3 py-1.5 text-xs font-semibold transition-colors ${reason === chip ? 'border-dark-base bg-dark-base text-inverse-foreground' : 'border-border bg-surface-muted text-muted hover:bg-surface'}`}
              >
                {chip}
              </button>
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
