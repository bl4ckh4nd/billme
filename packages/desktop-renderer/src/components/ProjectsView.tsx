import { Button, EmptyState, ErrorState, Modal } from '@billme/ui';
import React from 'react';
import { Archive, Edit3, Plus, Search, X } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { v4 as uuidv4 } from 'uuid';
import type { Project } from '@billme/desktop-core/types';
import { useClientsQuery } from '../hooks/useClients';
import { useArchiveProjectMutation, useProjectsQuery, useUpsertProjectMutation } from '../hooks/useProjects';
import { SkeletonLoader } from '@billme/desktop-ui/components/SkeletonLoader';

type EditorMode = 'create' | 'edit';

export const ProjectsView: React.FC = () => {
  const navigate = useNavigate();
  const {
    data: clients = [],
    isLoading: isLoadingClients,
    isError: isClientsError,
    refetch: refetchClients,
  } = useClientsQuery();
  const [search, setSearch] = React.useState('');
  const [includeArchived, setIncludeArchived] = React.useState(false);
  const {
    data: projects = [],
    isLoading: isLoadingProjects,
    isError: isProjectsError,
    refetch: refetchProjects,
  } = useProjectsQuery({ includeArchived });
  const upsertProject = useUpsertProjectMutation();
  const archiveProject = useArchiveProjectMutation();

  // The rows show the client name and the status filter reads the project list,
  // so a failed clients query would render "Unbekannt" for every row.
  const isLoadingView = isLoadingProjects || isLoadingClients;
  const hasQueryError = isProjectsError || isClientsError;
  const retryQueries = () => {
    void refetchProjects();
    void refetchClients();
  };

  const [isEditorOpen, setIsEditorOpen] = React.useState(false);
  const [editorMode, setEditorMode] = React.useState<EditorMode>('create');
  const [draft, setDraft] = React.useState<Project | null>(null);
  const [reason, setReason] = React.useState('');
  const [reasonError, setReasonError] = React.useState<string | null>(null);

  const [archiveTarget, setArchiveTarget] = React.useState<Project | null>(null);
  const [archiveReason, setArchiveReason] = React.useState('');
  const [archiveError, setArchiveError] = React.useState<string | null>(null);

  const filtered = projects.filter((p) => {
    const clientName = clients.find((c) => c.id === p.clientId)?.company ?? '';
    const hay = `${p.code ?? ''} ${p.name} ${clientName}`.toLowerCase();
    return hay.includes(search.toLowerCase());
  });

  const openCreate = () => {
    const today = new Date().toISOString().split('T')[0] ?? '';
    setEditorMode('create');
    setDraft({
      id: uuidv4(),
      clientId: clients[0]?.id ?? '',
      code: '',
      name: '',
      status: 'active',
      budget: 0,
      startDate: today,
      endDate: undefined,
      description: '',
    });
    setReason('Erstellung');
    setReasonError(null);
    setIsEditorOpen(true);
  };

  const openEdit = (p: Project) => {
    setEditorMode('edit');
    setDraft({ ...p });
    setReason('');
    setReasonError(null);
    setIsEditorOpen(true);
  };

  const closeEditor = () => {
    setIsEditorOpen(false);
    setDraft(null);
    setReason('');
    setReasonError(null);
  };

  const submit = () => {
    const trimmed = reason.trim();
    if (!trimmed) {
      setReasonError('Grund ist Pflicht (Audit).');
      return;
    }
    if (!draft) return;
    if (!draft.clientId) {
      setReasonError('Bitte einen Kunden auswählen.');
      return;
    }
    if (!draft.name.trim()) {
      setReasonError('Bitte einen Projektnamen eingeben.');
      return;
    }

    upsertProject.mutate(
      { project: draft, reason: trimmed },
      {
        onSuccess: () => closeEditor(),
      },
    );
  };

  const submitArchive = () => {
    if (!archiveTarget) return;
    const trimmed = archiveReason.trim();
    if (!trimmed) {
      setArchiveError('Grund ist Pflicht (Audit).');
      return;
    }
    archiveProject.mutate(
      { id: archiveTarget.id, reason: trimmed },
      {
        onSuccess: () => {
          setArchiveTarget(null);
          setArchiveReason('');
          setArchiveError(null);
        },
      },
    );
  };

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
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-black text-foreground">Projekte</h2>
          <p className="text-sm text-muted mt-1">
            Projekte strukturieren alle Dokumente (Rechnungen/Angebote) pro Kunde.
          </p>
        </div>
        <button
          onClick={openCreate}
          className="px-5 py-3 rounded-xl font-bold bg-black text-white hover:bg-dark-2 transition-colors inline-flex items-center gap-2"
        >
          <Plus size={18} /> Neues Projekt
        </button>
      </div>

      <div className="flex items-center justify-between gap-4 mb-6">
        {/* The wrapper is the label so a click anywhere on the field, including its
            padding, focuses the input. */}
        <label className="flex items-center gap-3 w-full max-w-xl bg-surface-muted border border-control-border rounded-xl px-4 py-3">
          <Search size={18} className="text-muted shrink-0" aria-hidden="true" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Projekte durchsuchen"
            className="bg-transparent text-sm font-medium w-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring rounded-sm"
            placeholder="Suchen (Code, Projektname, Kunde)..."
          />
        </label>

        <label className="flex items-center gap-2 text-sm font-bold text-foreground select-none">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
            className="h-6 w-6 rounded-sm border-control-border accent-black focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          />
          Archiviert anzeigen
        </label>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border">
        <div className="hidden grid-cols-12 bg-surface-muted px-4 py-3 text-xs font-bold text-muted uppercase tracking-wider md:grid">
          <div className="col-span-3">Projekt</div>
          <div className="col-span-2">Kunde</div>
          <div className="col-span-2">Status</div>
          <div className="col-span-2">Start</div>
          <div className="col-span-3 text-right">Aktionen</div>
        </div>

        {isLoadingView ? (
          <SkeletonLoader variant="table" count={5} />
        ) : hasQueryError ? (
          <div className="p-6">
            <ErrorState
              title="Projekte konnten nicht geladen werden"
              description="Projekt- oder Kundendaten sind nicht verfügbar. Es werden bewusst keine Ersatzdaten angezeigt."
              onRetry={retryQueries}
            />
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-6">
            {projects.length === 0 ? (
              <EmptyState
                title={includeArchived ? 'Noch keine Projekte angelegt' : 'Noch keine aktiven Projekte'}
                description={
                  includeArchived
                    ? 'Ein Projekt bündelt alle Dokumente eines Kunden, damit Rechnungen und Angebote zuordenbar bleiben. Lege das erste Projekt über "Neues Projekt" oben rechts an.'
                    : 'Archivierte Projekte sind ausgeblendet. Aktiviere "Archiviert anzeigen" oben rechts oder lege über "Neues Projekt" ein neues an.'
                }
              />
            ) : (
              <EmptyState
                title="Kein Projekt passt zu dieser Suche"
                description={`Die Suche "${search.trim()}" schließt alle ${projects.length} geladenen Projekte aus.`}
                action={
                  <Button variant="secondary" size="sm" onClick={() => setSearch('')}>
                    Suche zurücksetzen
                  </Button>
                }
              />
            )}
          </div>
        ) : (
          <div className="divide-y divide-border-subtle">
            {filtered.map((p) => {
              const clientName = clients.find((c) => c.id === p.clientId)?.company ?? 'Unbekannt';
              return (
                <div
                  key={p.id}
                  className="grid grid-cols-1 gap-1 px-4 py-4 hover:bg-surface-muted transition-colors md:grid-cols-12 md:items-center md:gap-0"
                >
                  <button
                    className="min-w-0 text-left md:col-span-3"
                    onClick={() => navigate({ to: `/projects/${p.id}` })}
                    title="Projekt öffnen"
                  >
                    <div className="font-black text-foreground">{p.name}</div>
                    <div className="text-xs text-muted">{p.code ?? ''}</div>
                  </button>
                  <div className="min-w-0 truncate text-sm font-bold text-foreground md:col-span-2">{clientName}</div>
                  <div className="flex flex-wrap items-center gap-x-3 text-sm md:contents">
                    <div className="font-bold text-foreground md:col-span-2">{statusLabel[p.status]}</div>
                    <div className="text-muted tabular-nums md:col-span-2">{p.startDate}</div>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 md:col-span-3 md:mt-0 md:justify-end">
                    <button
                      onClick={() => openEdit(p)}
                      className="px-3 py-2 rounded-xl bg-surface-muted hover:bg-border-subtle text-foreground font-bold text-sm inline-flex items-center gap-2"
                    >
                      <Edit3 size={16} /> Bearbeiten
                    </button>
                    <button
                      onClick={() => {
                        setArchiveTarget(p);
                        setArchiveReason('');
                        setArchiveError(null);
                      }}
                      className="px-3 py-2 rounded-xl bg-surface-muted hover:bg-border-subtle text-foreground font-bold text-sm inline-flex items-center gap-2"
                      disabled={Boolean(p.archivedAt)}
                      title={p.archivedAt ? 'Bereits archiviert' : 'Archivieren'}
                    >
                      <Archive size={16} /> Archivieren
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Modal
        open={isEditorOpen && Boolean(draft)}
        onClose={closeEditor}
        titleId="project-editor-title"
        descriptionId="project-editor-description"
        className="max-w-2xl overflow-hidden"
      >
        {draft && (
          <>
            <div className="flex items-center justify-between px-6 py-5 border-b border-border">
              <div>
                <h3 id="project-editor-title" className="text-lg font-black text-foreground">
                  {editorMode === 'create' ? 'Neues Projekt' : 'Projekt bearbeiten'}
                </h3>
                <p id="project-editor-description" className="text-sm text-muted mt-1">Änderungen werden im Audit-Log gespeichert.</p>
              </div>
              <button
                type="button"
                onClick={closeEditor}
                aria-label="Dialog schließen"
                className="w-10 h-10 rounded-full bg-surface-muted hover:bg-border-subtle flex items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-6 grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className="block text-xs font-bold text-muted mb-1" htmlFor="projectsview-kunde-pflicht">Kunde (Pflicht)</label>
                <select id="projectsview-kunde-pflicht"
                  value={draft.clientId ?? ''}
                  onChange={(e) => setDraft({ ...draft, clientId: e.target.value })}
                  disabled={editorMode === 'edit'}
 className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:opacity-60"
                >
                  <option value="">(Bitte auswählen)</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.company}
                    </option>
                  ))}
                </select>
                {editorMode === 'edit' && (
                  <div className="mt-1 text-xs text-muted">
                    Kunden-Zuordnung ist nachträglich nicht änderbar.
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-bold text-muted mb-1" htmlFor="projectsview-projektcode">Projektcode</label>
                <input id="projectsview-projektcode"
                  value={draft.code ?? ''}
                  onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                  placeholder="Leer lassen für automatische Vergabe (z.B. PRJ-2026-001)"
 className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-muted mb-1" htmlFor="projectsview-status">Status</label>
                <select id="projectsview-status"
                  value={draft.status}
                  onChange={(e) => setDraft({ ...draft, status: e.target.value as any })}
 className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                >
                  <option value="active">Aktiv</option>
                  <option value="planned">Geplant</option>
                  <option value="on_hold">Pausiert</option>
                  <option value="completed">Abgeschlossen</option>
                </select>
              </div>

              <div className="col-span-2">
                <label className="block text-xs font-bold text-muted mb-1" htmlFor="projectsview-projektname-pflicht">Projektname (Pflicht)</label>
                <input id="projectsview-projektname-pflicht"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
 className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-muted mb-1" htmlFor="projectsview-start">Start</label>
                <input id="projectsview-start"
                  type="date"
                  value={draft.startDate}
                  onChange={(e) => setDraft({ ...draft, startDate: e.target.value })}
 className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-muted mb-1" htmlFor="projectsview-ende-optional">Ende (optional)</label>
                <input id="projectsview-ende-optional"
                  type="date"
                  value={draft.endDate ?? ''}
                  onChange={(e) => setDraft({ ...draft, endDate: e.target.value || undefined })}
 className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-muted mb-1" htmlFor="projectsview-budget">Budget</label>
                <input id="projectsview-budget"
                  type="number"
                  value={draft.budget ?? 0}
                  onChange={(e) => setDraft({ ...draft, budget: Number(e.target.value) })}
 className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-muted mb-1">Archiviert</label>
                <div className="w-full bg-surface-muted border border-border rounded-xl p-3 text-sm font-medium text-foreground">
                  {draft.archivedAt ? draft.archivedAt : 'Nein'}
                </div>
              </div>

              <div className="col-span-2">
                <label className="block text-xs font-bold text-muted mb-1" htmlFor="projectsview-beschreibung-optional">Beschreibung (optional)</label>
                <textarea id="projectsview-beschreibung-optional"
                  value={draft.description ?? ''}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  rows={3}
 className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring resize-none"
                />
              </div>

              <div className="col-span-2">
                <label className="block text-xs font-bold text-muted mb-1" htmlFor="projectsview-grund-pflicht">Grund (Pflicht)</label>
                <textarea id="projectsview-grund-pflicht"
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                    if (reasonError) setReasonError(null);
                  }}
                  rows={3}
                  placeholder="z.B. Projektstart verschoben, Code angepasst, ..."
 className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring resize-none"
                />
                {reasonError && <div className="mt-2 text-sm font-bold text-error-text">{reasonError}</div>}
              </div>
            </div>

            <div className="px-6 py-5 border-t border-border flex items-center justify-end gap-3">
              <Button variant="secondary" onClick={closeEditor}>
                Abbrechen
              </Button>
              <Button variant="dark" onClick={submit}>
                Speichern
              </Button>
            </div>
          </>
        )}
      </Modal>

      <Modal
        open={Boolean(archiveTarget)}
        onClose={() => {
          setArchiveTarget(null);
          setArchiveReason('');
          setArchiveError(null);
        }}
        titleId="project-archive-title"
        descriptionId="project-archive-description"
        className="p-6"
      >
        {archiveTarget && (
          <>
            <h3 id="project-archive-title" className="text-lg font-black text-foreground mb-1">Projekt archivieren</h3>
            <p id="project-archive-description" className="text-sm text-muted mb-4">
              {archiveTarget.name} wird archiviert (nicht gelöscht). Bitte Grund angeben.
            </p>
            <label htmlFor="project-archive-reason" className="text-xs font-bold text-muted">Grund (Pflicht)</label>
            <textarea
              id="project-archive-reason"
              value={archiveReason}
              onChange={(e) => {
                setArchiveReason(e.target.value);
                if (archiveError) setArchiveError(null);
              }}
              rows={3}
              className="mt-2 w-full rounded-2xl border border-control-border bg-surface-muted px-4 py-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              placeholder="z.B. Projekt abgeschlossen, Kunde gekündigt, ..."
            />
            {archiveError && <div className="mt-2 text-sm font-bold text-error-text">{archiveError}</div>}
            <div className="mt-6 flex items-center justify-end gap-3">
              <Button
                variant="secondary"
                onClick={() => {
                  setArchiveTarget(null);
                  setArchiveReason('');
                  setArchiveError(null);
                }}
              >
                Abbrechen
              </Button>
              <Button variant="dark" onClick={submitArchive}>
                Archivieren
              </Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
};
