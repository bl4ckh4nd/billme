import React from 'react';
import { ArrowLeft, Euro, TriangleAlert } from 'lucide-react';
import { useNavigate, useParams } from '@tanstack/react-router';
import type { Project } from '@billme/desktop-core/types';
import { Button, EmptyState, ErrorState } from '@billme/ui';
import { SkeletonLoader } from '@billme/desktop-ui/components/SkeletonLoader';
import { useClientsQuery } from '../hooks/useClients';
import { useInvoicesQuery } from '../hooks/useInvoices';
import { useOffersQuery } from '../hooks/useOffers';
import { useProjectsQuery } from '../hooks/useProjects';

export const ProjectDetailView: React.FC = () => {
  const navigate = useNavigate();
  const { projectId } = useParams({ from: '/projects/$projectId' });

  const {
    data: clients = [],
    isLoading: isLoadingClients,
    isError: isClientsError,
    refetch: refetchClients,
  } = useClientsQuery();
  const {
    data: projects = [],
    isLoading: isLoadingProjects,
    isError: isProjectsError,
    refetch: refetchProjects,
  } = useProjectsQuery({ includeArchived: true });
  const {
    data: invoices = [],
    isLoading: isLoadingInvoices,
    isError: isInvoicesError,
    refetch: refetchInvoices,
  } = useInvoicesQuery();
  const {
    data: offers = [],
    isLoading: isLoadingOffers,
    isError: isOffersError,
    refetch: refetchOffers,
  } = useOffersQuery();

  // Every figure on this screen is derived from these four queries, so a failed
  // query must not fall through to a real-looking zero.
  const isLoading = isLoadingClients || isLoadingProjects || isLoadingInvoices || isLoadingOffers;
  const hasQueryError = isClientsError || isProjectsError || isInvoicesError || isOffersError;
  const retryQueries = () => {
    void refetchClients();
    void refetchProjects();
    void refetchInvoices();
    void refetchOffers();
  };

  const project = projects.find((p) => p.id === projectId) ?? null;
  const client = project?.clientId ? clients.find((c) => c.id === project.clientId) ?? null : null;

  const projectInvoices = invoices.filter((d) => d.projectId === projectId);
  const projectOffers = offers.filter((d) => d.projectId === projectId);

  const currencyFormatter = React.useMemo(
    () => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }),
    [],
  );
  const formatCurrency = (n: number) => currencyFormatter.format(Number.isFinite(n) ? n : 0);

  const paymentAppliedForInvoice = (amount: number, payments: Array<{ amount: number }> | undefined) => {
    const paidRaw = (payments ?? []).reduce((acc, p) => acc + (Number(p.amount) || 0), 0);
    const paidApplied = Math.min(Math.max(0, paidRaw), Math.max(0, Number(amount) || 0));
    const remaining = Math.max(0, (Number(amount) || 0) - paidApplied);
    return { paidApplied, remaining };
  };

  const issuedInvoices = projectInvoices.filter((i) => i.status !== 'draft');
  const openInvoices = issuedInvoices.filter((i) => i.status === 'open');
  const overdueInvoices = issuedInvoices.filter((i) => i.status === 'overdue');
  const paidInvoices = issuedInvoices.filter((i) => i.status === 'paid');

  const sums = issuedInvoices.reduce(
    (acc, inv) => {
      const { paidApplied, remaining } = paymentAppliedForInvoice(inv.amount, inv.payments);
      acc.issuedAmount += Number(inv.amount) || 0;
      acc.paidApplied += paidApplied;

      if (inv.status === 'open') acc.openRemaining += remaining;
      if (inv.status === 'overdue') acc.overdueRemaining += remaining;

      return acc;
    },
    { issuedAmount: 0, paidApplied: 0, openRemaining: 0, overdueRemaining: 0 },
  );

  const pipelineTotal = sums.paidApplied + sums.openRemaining + sums.overdueRemaining;
  const pctPaid = pipelineTotal > 0 ? Math.min(1, sums.paidApplied / pipelineTotal) : 0;
  const pctOpen = pipelineTotal > 0 ? Math.min(1, sums.openRemaining / pipelineTotal) : 0;
  const pctOverdue = pipelineTotal > 0 ? Math.min(1, sums.overdueRemaining / pipelineTotal) : 0;

  if (isLoading) {
    return (
      <div className="bg-white rounded-2xl p-8 min-h-full shadow-sm">
        <button
          onClick={() => navigate({ to: '/projects' })}
          className="flex items-center gap-2 text-muted hover:text-foreground transition-colors mb-6 text-xs font-bold uppercase tracking-wider focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring rounded-sm"
        >
          <ArrowLeft size={14} /> Zurück zu Projekten
        </button>
        <SkeletonLoader variant="table" count={4} />
      </div>
    );
  }

  if (hasQueryError) {
    return (
      <div className="bg-white rounded-2xl p-8 min-h-full shadow-sm">
        <button
          onClick={() => navigate({ to: '/projects' })}
          className="flex items-center gap-2 text-muted hover:text-foreground transition-colors mb-6 text-xs font-bold uppercase tracking-wider focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring rounded-sm"
        >
          <ArrowLeft size={14} /> Zurück zu Projekten
        </button>
        <ErrorState
          title="Projektdetails konnten nicht geladen werden"
          description="Projekt-, Kunden- oder Belegdaten sind nicht verfügbar. Es werden bewusst keine Ersatzwerte angezeigt."
          onRetry={retryQueries}
        />
      </div>
    );
  }

  if (!project) {
    return (
      <div className="bg-white rounded-2xl p-8 min-h-full shadow-sm">
        <button
          onClick={() => navigate({ to: '/projects' })}
          className="flex items-center gap-2 text-muted hover:text-foreground transition-colors mb-6 text-xs font-bold uppercase tracking-wider focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring rounded-sm"
        >
          <ArrowLeft size={14} /> Zurück zu Projekten
        </button>
        <EmptyState
          title="Projekt nicht gefunden"
          description="Das Projekt steht nicht mehr in der Projektliste. Es wurde möglicherweise gelöscht oder archiviert."
          action={
            <Button variant="secondary" size="sm" onClick={() => navigate({ to: '/projects' })}>
              Zur Projektliste
            </Button>
          }
        />
      </div>
    );
  }

  const remainingBudget = project.budget - sums.paidApplied;
  const overBudget = remainingBudget < 0;

  const statusLabel: Record<Project['status'], string> = {
    active: 'Aktiv',
    planned: 'Geplant',
    on_hold: 'Pausiert',
    completed: 'Abgeschlossen',
    inactive: 'Inaktiv',
    archived: 'Archiviert',
  };

  return (
    <div className="bg-white rounded-2xl p-8 min-h-full shadow-sm">
      <button
        onClick={() => navigate({ to: '/projects' })}
        className="flex items-center gap-2 text-muted hover:text-foreground transition-colors mb-6 text-xs font-bold uppercase tracking-wider focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring rounded-sm"
      >
        <ArrowLeft size={14} /> Zurück zu Projekten
      </button>

      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          {project.code && (
            <div className="text-xs font-bold text-muted uppercase tracking-wider">{project.code}</div>
          )}
          <h2 className="text-2xl font-black text-foreground">{project.name}</h2>
          <div className="text-sm text-muted mt-1">{client ? client.company : 'Unbekannter Kunde'}</div>
        </div>
        <button
          onClick={() => navigate({ to: '/documents' })}
          className="px-5 py-3 rounded-xl font-bold bg-black text-white hover:bg-dark-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring-dark transition-colors"
          title="Dokumente öffnen"
        >
          Zu Dokumenten
        </button>
      </div>

      {/* Project identity facts, deliberately quiet: the question this screen
          answers is the money still owed, which gets the focal card below. */}
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 rounded-2xl border border-border bg-surface-muted px-5 py-3 mb-8 text-xs">
        <span className="font-bold text-muted uppercase tracking-wider">
          Rechnungen <span className="ml-1.5 text-sm font-black text-foreground tabular-nums">{projectInvoices.length}</span>
        </span>
        <span className="font-bold text-muted uppercase tracking-wider">
          Angebote <span className="ml-1.5 text-sm font-black text-foreground tabular-nums">{projectOffers.length}</span>
        </span>
        <span className="font-bold text-muted uppercase tracking-wider">
          Status <span className="ml-1.5 text-sm font-black text-foreground">{statusLabel[project.status]}</span>
        </span>
        <span className="font-bold text-muted uppercase tracking-wider">
          Start <span className="ml-1.5 text-sm font-black text-foreground tabular-nums">{project.startDate}</span>
        </span>
      </div>

      <div className="rounded-3xl border border-border bg-surface-muted p-6 mb-8">
        <div className="flex items-center justify-between gap-4 mb-5">
          <h3 className="text-sm font-black text-foreground flex items-center gap-2 uppercase tracking-wide">
            <Euro size={16} className="text-muted" /> Abrechnung
          </h3>
          {project.budget > 0 && (
            <div className="text-xs font-bold text-muted">
              Budget: <span className="tabular-nums text-foreground">{formatCurrency(project.budget)}</span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Focal: what the client still owes on this project */}
          <div className="rounded-2xl bg-dark-3 p-6 text-white">
            <div className="text-xs font-bold uppercase tracking-wider text-dark-muted">Offen</div>
            <div className="text-3xl font-black mt-2 tabular-nums">{formatCurrency(sums.openRemaining)}</div>
            <div className="text-xs mt-2 text-dark-muted">
              Restbetrag aus {openInvoices.length} offenen Rechnungen
            </div>
            {sums.overdueRemaining > 0 && (
              <div className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-error-bg px-3 py-1 text-xs font-bold text-error-text">
                <TriangleAlert size={12} /> {formatCurrency(sums.overdueRemaining)} überfällig
              </div>
            )}
          </div>

          <div className="flex flex-col justify-center gap-2">
            <div className="flex items-baseline justify-between gap-4 rounded-xl bg-surface px-4 py-3">
              <span className="text-xs font-bold text-muted uppercase tracking-wider">Rechnungen gestellt</span>
              <span className="text-right">
                <span className="block text-lg font-black text-foreground tabular-nums">{issuedInvoices.length}</span>
                <span className="block text-xs text-muted tabular-nums">
                  {openInvoices.length} offen · {overdueInvoices.length} überfällig · {paidInvoices.length} bezahlt
                </span>
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-4 rounded-xl bg-surface px-4 py-3">
              <span className="text-xs font-bold text-muted uppercase tracking-wider">Überfällig</span>
              <span className="text-right">
                <span className="block text-lg font-black text-foreground tabular-nums">{formatCurrency(sums.overdueRemaining)}</span>
                <span className="block text-xs text-muted">Restbetrag aus überfälligen Rechnungen</span>
              </span>
            </div>
            <div className="flex items-baseline justify-between gap-4 rounded-xl bg-surface px-4 py-3">
              <span className="text-xs font-bold text-muted uppercase tracking-wider">Bezahlt</span>
              <span className="text-right">
                <span className="block text-lg font-black text-foreground tabular-nums">{formatCurrency(sums.paidApplied)}</span>
                <span className="block text-xs text-muted">Summe erfasster Zahlungen (gedeckelt)</span>
              </span>
            </div>
          </div>
        </div>

        <div className="mt-5">
          <div className="flex items-center justify-between text-xs text-muted mb-2">
            <span>Abrechnungsstatus (nur Rechnungen, ohne Entwürfe)</span>
            <span className="font-bold text-foreground tabular-nums">{formatCurrency(pipelineTotal)}</span>
          </div>
          <div className="w-full h-3 rounded-full bg-white border border-border overflow-hidden flex">
            <div className="h-full bg-border" style={{ width: `${Math.round(pctOpen * 100)}%` }} title="Offen" />
            <div className="h-full bg-error" style={{ width: `${Math.round(pctOverdue * 100)}%` }} title="Überfällig" />
            <div className="h-full bg-black" style={{ width: `${Math.round(pctPaid * 100)}%` }} title="Bezahlt" />
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-xs font-bold text-muted">
            <span>Offen: <span className="text-foreground tabular-nums">{formatCurrency(sums.openRemaining)}</span></span>
            <span>Überfällig: <span className="text-foreground tabular-nums">{formatCurrency(sums.overdueRemaining)}</span></span>
            <span>Bezahlt: <span className="text-foreground tabular-nums">{formatCurrency(sums.paidApplied)}</span></span>
          </div>
        </div>

        {project.budget > 0 && (
          <div className="mt-5">
            <div className="flex items-center justify-between text-xs text-muted mb-2">
              <span>Budget-Fortschritt (bezahlt)</span>
              <span className="font-bold text-foreground tabular-nums">
                {formatCurrency(sums.paidApplied)} / {formatCurrency(project.budget)}
              </span>
            </div>
            <div className="w-full h-3 rounded-full bg-white border border-border overflow-hidden">
              <div
                className="h-full bg-black"
                style={{ width: `${Math.min(100, Math.round((sums.paidApplied / project.budget) * 100))}%` }}
              />
            </div>
            <div className="mt-2 text-xs text-muted">
              {overBudget ? 'Über Budget:' : 'Restbudget:'}{' '}
              <span className={`font-bold tabular-nums ${overBudget ? 'text-error-text' : 'text-foreground'}`}>
                {formatCurrency(Math.abs(remainingBudget))}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div className="rounded-2xl border border-border overflow-hidden">
          <div className="bg-surface-muted px-4 py-3 text-xs font-bold text-muted uppercase tracking-wider">
            Rechnungen
          </div>
          {projectInvoices.length === 0 ? (
            <EmptyState
              className="rounded-none border-0 bg-transparent py-8"
              title="Keine Rechnungen im Projekt"
              description="Rechnungen erscheinen hier, sobald du sie diesem Projekt zuordnest."
              action={
                <Button variant="secondary" size="sm" onClick={() => navigate({ to: '/documents' })}>
                  Zu den Rechnungen
                </Button>
              }
            />
          ) : (
            <div className="divide-y divide-border-subtle">
              {projectInvoices.map((d) => (
                <div key={d.id} className="px-4 py-3 flex items-center justify-between">
                  <div>
                    <div className="font-bold text-foreground">{d.number}</div>
                    <div className="text-xs text-muted tabular-nums">{d.date}</div>
                  </div>
                  <button
                    onClick={() => navigate({ to: '/documents' })}
                    className="px-3 py-2 rounded-xl bg-surface-muted hover:bg-border-subtle text-foreground font-bold text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring transition-colors"
                  >
                    Öffnen
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-border overflow-hidden">
          <div className="bg-surface-muted px-4 py-3 text-xs font-bold text-muted uppercase tracking-wider">
            Angebote
          </div>
          {projectOffers.length === 0 ? (
            <EmptyState
              className="rounded-none border-0 bg-transparent py-8"
              title="Keine Angebote im Projekt"
              description="Angebote erscheinen hier, sobald du sie diesem Projekt zuordnest."
              action={
                <Button variant="secondary" size="sm" onClick={() => navigate({ to: '/documents' })}>
                  Zu den Angeboten
                </Button>
              }
            />
          ) : (
            <div className="divide-y divide-border-subtle">
              {projectOffers.map((d) => (
                <div key={d.id} className="px-4 py-3 flex items-center justify-between">
                  <div>
                    <div className="font-bold text-foreground">{d.number}</div>
                    <div className="text-xs text-muted tabular-nums">{d.date}</div>
                  </div>
                  <button
                    onClick={() => navigate({ to: '/documents' })}
                    className="px-3 py-2 rounded-xl bg-surface-muted hover:bg-border-subtle text-foreground font-bold text-sm transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                  >
                    Öffnen
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
