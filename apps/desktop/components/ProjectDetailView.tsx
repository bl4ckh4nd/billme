import React from 'react';
import { ArrowLeft, Euro } from 'lucide-react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useClientsQuery } from '../hooks/useClients';
import { useInvoicesQuery } from '../hooks/useInvoices';
import { useOffersQuery } from '../hooks/useOffers';
import { useProjectsQuery } from '../hooks/useProjects';

export const ProjectDetailView: React.FC = () => {
  const navigate = useNavigate();
  const { projectId } = useParams({ from: '/projects/$projectId' });

  const { data: clients = [] } = useClientsQuery();
  const { data: projects = [] } = useProjectsQuery({ includeArchived: true });
  const { data: invoices = [] } = useInvoicesQuery();
  const { data: offers = [] } = useOffersQuery();

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

  if (!project) {
    return (
      <div className="bg-white rounded-[2.5rem] p-8 min-h-full shadow-sm">
        <button
          onClick={() => navigate({ to: '/projects' })}
          className="flex items-center gap-2 text-gray-400 hover:text-black transition-colors mb-6 text-xs font-bold uppercase tracking-wider"
        >
          <ArrowLeft size={14} /> Zurück
        </button>
        <h2 className="text-xl font-black text-gray-900 mb-2">Projekt nicht gefunden</h2>
        <p className="text-sm text-gray-500">Bitte über die Projektliste erneut öffnen.</p>
      </div>
    );
  }

  const remainingBudget = project.budget - sums.paidApplied;
  const overBudget = remainingBudget < 0;

  return (
    <div className="bg-white rounded-[2.5rem] p-8 min-h-full shadow-sm">
      <button
        onClick={() => navigate({ to: '/projects' })}
        className="flex items-center gap-2 text-gray-400 hover:text-black transition-colors mb-6 text-xs font-bold uppercase tracking-wider"
      >
        <ArrowLeft size={14} /> Zurück zu Projekten
      </button>

      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">{project.code ?? ''}</div>
          <h2 className="text-2xl font-black text-gray-900">{project.name}</h2>
          <div className="text-sm text-gray-500 mt-1">{client ? client.company : 'Unbekannter Kunde'}</div>
        </div>
        <button
          onClick={() => navigate({ to: '/documents' })}
          className="px-5 py-3 rounded-xl font-bold bg-black text-white hover:bg-gray-800 transition-colors"
          title="Dokumente öffnen"
        >
          Zu Dokumenten
        </button>
      </div>

      <div className="grid grid-cols-3 gap-4 mb-8">
        <div className="rounded-2xl border border-gray-200 p-5 bg-gray-50 animate-scale-in" style={{ animationDelay: '0ms' }}>
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Rechnungen</div>
          <div className="text-3xl font-black text-gray-900 mt-2">{projectInvoices.length}</div>
        </div>
        <div className="rounded-2xl border border-gray-200 p-5 bg-gray-50 animate-scale-in" style={{ animationDelay: '50ms' }}>
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Angebote</div>
          <div className="text-3xl font-black text-gray-900 mt-2">{projectOffers.length}</div>
        </div>
        <div className="rounded-2xl border border-gray-200 p-5 bg-gray-50 animate-scale-in" style={{ animationDelay: '100ms' }}>
          <div className="text-xs font-bold text-gray-500 uppercase tracking-wider">Status</div>
          <div className="text-xl font-black text-gray-900 mt-3">{project.status}</div>
        </div>
      </div>

      <div className="rounded-3xl border border-gray-200 bg-gray-50 p-6 mb-8">
        <div className="flex items-center justify-between gap-4 mb-5">
          <h3 className="text-sm font-black text-gray-900 flex items-center gap-2 uppercase tracking-wide">
            <Euro size={16} className="text-gray-500" /> Abrechnung
          </h3>
          {project.budget > 0 && (
            <div className="text-xs font-bold text-gray-500">
              Budget: <span className="font-mono text-gray-900">{formatCurrency(project.budget)}</span>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          <div className="rounded-2xl bg-white border border-gray-200 p-5 animate-scale-in" style={{ animationDelay: '0ms' }}>
            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Rechnungen gestellt</div>
            <div className="text-3xl font-black text-gray-900 mt-2">{issuedInvoices.length}</div>
            <div className="text-xs text-gray-500 mt-2">
              Offen: <span className="font-bold text-gray-900">{openInvoices.length}</span> •
              Überfällig: <span className="font-bold text-gray-900">{overdueInvoices.length}</span> •
              Bezahlt: <span className="font-bold text-gray-900">{paidInvoices.length}</span>
            </div>
          </div>

          <div className="rounded-2xl bg-white border border-gray-200 p-5 animate-scale-in" style={{ animationDelay: '50ms' }}>
            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Offen</div>
            <div className="text-2xl font-black text-gray-900 mt-2 font-mono">{formatCurrency(sums.openRemaining)}</div>
            <div className="text-xs text-gray-500 mt-2">Restbetrag aus offenen Rechnungen</div>
          </div>

          <div className="rounded-2xl bg-white border border-gray-200 p-5 animate-scale-in" style={{ animationDelay: '100ms' }}>
            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Überfällig</div>
            <div className="text-2xl font-black text-gray-900 mt-2 font-mono">{formatCurrency(sums.overdueRemaining)}</div>
            <div className="text-xs text-gray-500 mt-2">Restbetrag aus überfälligen Rechnungen</div>
          </div>

          <div className="rounded-2xl bg-white border border-gray-200 p-5 animate-scale-in" style={{ animationDelay: '150ms' }}>
            <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider">Bezahlt</div>
            <div className="text-2xl font-black text-gray-900 mt-2 font-mono">{formatCurrency(sums.paidApplied)}</div>
            <div className="text-xs text-gray-500 mt-2">Summe erfasster Zahlungen (gedeckelt)</div>
          </div>
        </div>

        <div className="mt-5">
          <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
            <span>Abrechnungsstatus (nur Rechnungen, ohne Entwürfe)</span>
            <span className="font-mono font-bold text-gray-900">{formatCurrency(pipelineTotal)}</span>
          </div>
          <div className="w-full h-3 rounded-full bg-white border border-gray-200 overflow-hidden flex">
            <div className="h-full bg-gray-200" style={{ width: `${Math.round(pctOpen * 100)}%` }} title="Offen" />
            <div className="h-full bg-error/30" style={{ width: `${Math.round(pctOverdue * 100)}%` }} title="Überfällig" />
            <div className="h-full bg-black" style={{ width: `${Math.round(pctPaid * 100)}%` }} title="Bezahlt" />
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-xs font-bold text-gray-600">
            <span>Offen: <span className="font-mono text-gray-900">{formatCurrency(sums.openRemaining)}</span></span>
            <span>Überfällig: <span className="font-mono text-gray-900">{formatCurrency(sums.overdueRemaining)}</span></span>
            <span>Bezahlt: <span className="font-mono text-gray-900">{formatCurrency(sums.paidApplied)}</span></span>
          </div>
        </div>

        {project.budget > 0 && (
          <div className="mt-5">
            <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
              <span>Budget-Fortschritt (bezahlt)</span>
              <span className="font-mono font-bold text-gray-900">
                {formatCurrency(sums.paidApplied)} / {formatCurrency(project.budget)}
              </span>
            </div>
            <div className="w-full h-3 rounded-full bg-white border border-gray-200 overflow-hidden">
              <div
                className="h-full bg-black"
                style={{ width: `${Math.min(100, Math.round((sums.paidApplied / project.budget) * 100))}%` }}
              />
            </div>
            <div className="mt-2 text-xs text-gray-500">
              {overBudget ? 'Über Budget:' : 'Restbudget:'}{' '}
              <span className={`font-mono font-bold ${overBudget ? 'text-error' : 'text-gray-900'}`}>
                {formatCurrency(Math.abs(remainingBudget))}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div className="rounded-2xl border border-gray-200 overflow-hidden">
          <div className="bg-gray-50 px-4 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">
            Rechnungen
          </div>
          {projectInvoices.length === 0 ? (
            <div className="p-6 text-sm text-gray-500">Keine Rechnungen im Projekt.</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {projectInvoices.map((d, idx) => (
                <div key={d.id} className="px-4 py-3 flex items-center justify-between animate-enter" style={{ animationDelay: `${idx * 50}ms` }}>
                  <div>
                    <div className="font-bold text-gray-900">{d.number}</div>
                    <div className="text-xs text-gray-500">{d.date}</div>
                  </div>
                  <button
                    onClick={() => navigate({ to: '/documents' })}
                    className="px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-900 font-bold text-sm"
                  >
                    Öffnen
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-gray-200 overflow-hidden">
          <div className="bg-gray-50 px-4 py-3 text-xs font-bold text-gray-500 uppercase tracking-wider">
            Angebote
          </div>
          {projectOffers.length === 0 ? (
            <div className="p-6 text-sm text-gray-500">Keine Angebote im Projekt.</div>
          ) : (
            <div className="divide-y divide-gray-100">
              {projectOffers.map((d, idx) => (
                <div key={d.id} className="px-4 py-3 flex items-center justify-between animate-enter" style={{ animationDelay: `${idx * 50}ms` }}>
                  <div>
                    <div className="font-bold text-gray-900">{d.number}</div>
                    <div className="text-xs text-gray-500">{d.date}</div>
                  </div>
                  <button
                    onClick={() => navigate({ to: '/documents' })}
                    className="px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 text-gray-900 font-bold text-sm transition-colors"
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
