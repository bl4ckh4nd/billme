import React from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import type { Project } from '@billme/desktop-core/types';
import {
  Button, Card, CardHeader, EmptyState, ErrorState, HatchedProgress, Metric, PageHeader,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@billme/ui';
import { SkeletonLoader } from '../ui/components/SkeletonLoader';
import { useClientsQuery } from '../hooks/useClients';
import { useInvoicesQuery } from '../hooks/useInvoices';
import { billingDocuments } from '../billingDocuments';
import { useOffersQuery } from '../hooks/useOffers';
import { useProjectsQuery } from '../hooks/useProjects';

const kpiTile = 'rounded-tile border border-border bg-surface px-4 py-3.5';

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

  // Sums count billing documents only, lowered by their credit notes; orders and delivery notes are no revenue.
  const issuedInvoices = billingDocuments(projectInvoices).filter((i) => i.status !== 'draft');
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

  const backToProjects = { label: 'Zurück zu Projekten', onClick: () => navigate({ to: '/projects' }) };

  if (isLoading) {
    return (
      <div className="flex flex-col gap-3">
        <PageHeader className="mb-0" title="Projekte" back={backToProjects} />
        <SkeletonLoader variant="table" count={4} />
      </div>
    );
  }

  if (hasQueryError) {
    return (
      <div className="flex flex-col gap-3">
        <PageHeader className="mb-0" title="Projekte" back={backToProjects} />
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
      <div className="flex flex-col gap-3">
        <PageHeader className="mb-0" title="Projekte" back={backToProjects} />
        <Card padding="none">
          <EmptyState
            title="Projekt nicht gefunden"
            description="Das Projekt steht nicht mehr in der Projektliste. Es wurde möglicherweise gelöscht oder archiviert."
            action={
              <Button variant="secondary" size="sm" onClick={() => navigate({ to: '/projects' })}>
                Zur Projektliste
              </Button>
            }
          />
        </Card>
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

  const documentCard = (
    title: string,
    documents: Array<{ id: string; number: string; date: string }>,
    empty: { title: string; description: string; action: string },
  ) => (
    <Card padding="none" className="overflow-hidden">
      <CardHeader className="border-b border-border px-3.5 py-3" title={title} count={documents.length || undefined} />
      {documents.length === 0 ? (
        <EmptyState
          title={empty.title}
          description={empty.description}
          action={
            <Button variant="secondary" size="sm" onClick={() => navigate({ to: '/documents' })}>
              {empty.action}
            </Button>
          }
        />
      ) : (
        <Table aria-label={title} bare>
          <TableHeader>
            <TableRow>
              <TableHead>Nummer</TableHead>
              <TableHead>Datum</TableHead>
              <TableHead className="w-20"><span className="sr-only">Aktionen</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {documents.map((d) => (
              <TableRow key={d.id}>
                <TableCell className="font-medium">{d.number}</TableCell>
                <TableCell muted className="tabular-nums">{d.date}</TableCell>
                <TableCell className="py-1 text-right">
                  <Button variant="secondary" size="sm" onClick={() => navigate({ to: '/documents' })}>
                    Öffnen
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        className="mb-0"
        title={project.name}
        description={[project.code, client ? client.company : 'Unbekannter Kunde'].filter(Boolean).join(' · ')}
        back={backToProjects}
        actions={
          <Button variant="secondary" onClick={() => navigate({ to: '/documents' })} title="Dokumente öffnen">
            Zu Dokumenten
          </Button>
        }
      />

      {/* The question this screen answers is the money still owed, so that figure leads the row. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div className={kpiTile}>
          <Metric
            marker="tick"
            tone={sums.overdueRemaining > 0 ? 'error' : 'neutral'}
            label="Offen"
            value={formatCurrency(sums.openRemaining)}
            hint={`Restbetrag aus ${openInvoices.length} offenen Rechnungen`}
          />
        </div>
        <div className={kpiTile}>
          <Metric
            marker="tick"
            tone={sums.overdueRemaining > 0 ? 'error' : 'neutral'}
            label="Überfällig"
            value={formatCurrency(sums.overdueRemaining)}
            hint="Restbetrag aus überfälligen Rechnungen"
          />
        </div>
        <div className={kpiTile}>
          <Metric
            marker="tick"
            label="Bezahlt"
            value={formatCurrency(sums.paidApplied)}
            hint="Summe erfasster Zahlungen (gedeckelt)"
          />
        </div>
        <div className={kpiTile}>
          <Metric
            marker="tick"
            label="Rechnungen gestellt"
            value={issuedInvoices.length}
            hint={`${openInvoices.length} offen · ${overdueInvoices.length} überfällig · ${paidInvoices.length} bezahlt`}
          />
        </div>
      </div>

      <Card padding="none">
        <CardHeader
          className="border-b border-border px-3.5 py-3"
          title="Abrechnung"
          count={project.budget > 0 ? <>Budget: <span className="tabular-nums text-foreground">{formatCurrency(project.budget)}</span></> : undefined}
        />
        <div className="flex flex-col gap-4 p-3.5">
          <dl className="flex flex-wrap gap-x-6 gap-y-2 text-control">
            <div className="flex items-baseline gap-1.5">
              <dt className="text-caption text-muted">Rechnungen</dt>
              <dd className="font-medium text-foreground tabular-nums">{projectInvoices.length}</dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="text-caption text-muted">Angebote</dt>
              <dd className="font-medium text-foreground tabular-nums">{projectOffers.length}</dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="text-caption text-muted">Status</dt>
              <dd className="font-medium text-foreground">{statusLabel[project.status]}</dd>
            </div>
            <div className="flex items-baseline gap-1.5">
              <dt className="text-caption text-muted">Start</dt>
              <dd className="font-medium text-foreground tabular-nums">{project.startDate}</dd>
            </div>
          </dl>

          <div>
            <div className="mb-2 flex items-center justify-between text-caption text-muted">
              <span>Abrechnungsstatus (nur Rechnungen, ohne Entwürfe)</span>
              <span className="font-semibold text-foreground tabular-nums">{formatCurrency(pipelineTotal)}</span>
            </div>
            <div className="flex h-2.5 w-full overflow-hidden rounded-full border border-border bg-surface-sunken">
              <div className="h-full bg-border-strong" style={{ width: `${Math.round(pctOpen * 100)}%` }} title="Offen" />
              <div className="h-full bg-error" style={{ width: `${Math.round(pctOverdue * 100)}%` }} title="Überfällig" />
              <div className="h-full bg-foreground" style={{ width: `${Math.round(pctPaid * 100)}%` }} title="Bezahlt" />
            </div>
            <div className="mt-2 flex flex-wrap gap-3 text-caption text-muted">
              <span>Offen: <span className="font-medium text-foreground tabular-nums">{formatCurrency(sums.openRemaining)}</span></span>
              <span>Überfällig: <span className="font-medium text-foreground tabular-nums">{formatCurrency(sums.overdueRemaining)}</span></span>
              <span>Bezahlt: <span className="font-medium text-foreground tabular-nums">{formatCurrency(sums.paidApplied)}</span></span>
            </div>
          </div>

          {project.budget > 0 && (
            <div>
              <div className="mb-2 flex items-center justify-between text-caption text-muted">
                <span>Budget-Fortschritt (bezahlt)</span>
                <span className="font-semibold text-foreground tabular-nums">
                  {formatCurrency(sums.paidApplied)} / {formatCurrency(project.budget)}
                </span>
              </div>
              <HatchedProgress
                size="sm"
                value={sums.paidApplied / project.budget}
                label="Budget-Fortschritt (bezahlt)"
                valueText={`${formatCurrency(sums.paidApplied)} von ${formatCurrency(project.budget)}`}
              />
              <div className="mt-2 text-caption text-muted">
                {overBudget ? 'Über Budget:' : 'Restbudget:'}{' '}
                <span className={`font-semibold tabular-nums ${overBudget ? 'text-error-text' : 'text-foreground'}`}>
                  {formatCurrency(Math.abs(remainingBudget))}
                </span>
              </div>
            </div>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2">
        {documentCard('Rechnungen', projectInvoices, {
          title: 'Keine Rechnungen im Projekt',
          description: 'Rechnungen erscheinen hier, sobald du sie diesem Projekt zuordnest.',
          action: 'Zu den Rechnungen',
        })}
        {documentCard('Angebote', projectOffers, {
          title: 'Keine Angebote im Projekt',
          description: 'Angebote erscheinen hier, sobald du sie diesem Projekt zuordnest.',
          action: 'Zu den Angeboten',
        })}
      </div>
    </div>
  );
};
