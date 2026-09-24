import {
  Badge, Button, Checkbox, EmptyState, ErrorState, IconButton, Input, Menu, Modal, PageHeader,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@billme/ui';
import React from 'react';
import { Archive, Edit3, MoreHorizontal, Plus, Search, X } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { v4 as uuidv4 } from 'uuid';
import type { Project } from '@billme/desktop-core/types';
import { useClientsQuery } from '../hooks/useClients';
import { useArchiveProjectMutation, useProjectsQuery, useUpsertProjectMutation } from '../hooks/useProjects';
import { useCreateIntent } from '../hooks/useCreateIntent';
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
  // Linked from the command palette (?create=project); the draft preselects the first client.
  useCreateIntent('/projects', ['project'] as const, () => openCreate(), !isLoadingView);
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

  const statusTone: Record<Project['status'], 'success' | 'info' | 'warning' | 'neutral'> = {
    active: 'success',
    planned: 'info',
    on_hold: 'warning',
    completed: 'neutral',
    inactive: 'neutral',
    archived: 'neutral',
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
    <div className="bg-surface rounded-panel p-6 lg:p-8 min-h-full shadow-xs">
      <PageHeader
        title="Projekte"
        description="Projekte bündeln alle Rechnungen und Angebote eines Kunden."
        actions={
          <Button onClick={openCreate}>
            <Plus size={16} aria-hidden="true" /> Neues Projekt
          </Button>
        }
        toolbar={
          <>
            <div className="w-full sm:w-80">
              <Input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Projekte durchsuchen"
                placeholder="Code, Projekt oder Kunde suchen"
                prefix={<Search size={14} aria-hidden="true" />}
                fullWidth
              />
            </div>
            <Checkbox
              className="ml-auto"
              label="Archivierte anzeigen"
              checked={includeArchived}
              onChange={(e) => setIncludeArchived(e.target.checked)}
            />
          </>
        }
      />

      {isLoadingView ? (
        <SkeletonLoader variant="table" count={5} />
      ) : hasQueryError ? (
        <ErrorState
          title="Projekte konnten nicht geladen werden"
          description="Projekt- oder Kundendaten sind nicht verfügbar. Es werden bewusst keine Ersatzdaten angezeigt."
          onRetry={retryQueries}
        />
      ) : filtered.length === 0 ? (
        projects.length === 0 ? (
          <EmptyState
            title={includeArchived ? 'Noch keine Projekte angelegt' : 'Noch keine aktiven Projekte'}
            description={
              includeArchived
                ? 'Ein Projekt bündelt alle Dokumente eines Kunden, damit Rechnungen und Angebote zuordenbar bleiben. Lege das erste Projekt über "Neues Projekt" oben rechts an.'
                : 'Archivierte Projekte sind ausgeblendet. Aktiviere "Archivierte anzeigen" oder lege über "Neues Projekt" ein neues an.'
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
        )
      ) : (
        <Table aria-label="Projekte">
          <TableHeader>
            <TableRow>
              <TableHead>Projekt</TableHead>
              <TableHead>Kunde</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden md:table-cell">Start</TableHead>
              <TableHead className="w-12"><span className="sr-only">Aktionen</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((p) => {
              const clientName = clients.find((c) => c.id === p.clientId)?.company ?? 'Unbekannt';
              return (
                <TableRow key={p.id} interactive onClick={() => navigate({ to: `/projects/${p.id}` })} title="Projekt öffnen">
                  <TableCell>
                    <div className="font-medium">{p.name}</div>
                    {p.code && <div className="text-caption text-muted">{p.code}</div>}
                  </TableCell>
                  <TableCell className="max-w-64 truncate">{clientName}</TableCell>
                  <TableCell>
                    <Badge tone={statusTone[p.status]}>
                      {statusLabel[p.status]}
                    </Badge>
                  </TableCell>
                  <TableCell muted className="hidden tabular-nums md:table-cell">{p.startDate}</TableCell>
                  <TableCell className="text-right" onClick={(event) => event.stopPropagation()}>
                    <Menu
                      aria-label={`Aktionen für ${p.name}`}
                      align="end"
                      trigger={(props) => (
                        <IconButton {...props} size="sm" tooltip="Aktionen" aria-label={`Aktionen für ${p.name}`}>
                          <MoreHorizontal size={16} aria-hidden="true" />
                        </IconButton>
                      )}
                      items={[
                        { id: 'edit', label: 'Bearbeiten', icon: <Edit3 size={14} />, onSelect: () => openEdit(p) },
                        {
                          id: 'archive',
                          label: 'Archivieren',
                          icon: <Archive size={14} />,
                          disabled: Boolean(p.archivedAt),
                          onSelect: () => {
                            setArchiveTarget(p);
                            setArchiveReason('');
                            setArchiveError(null);
                          },
                        },
                      ]}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

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
                <h3 id="project-editor-title" className="text-lg font-semibold text-foreground">
                  {editorMode === 'create' ? 'Neues Projekt' : 'Projekt bearbeiten'}
                </h3>
                <p id="project-editor-description" className="text-sm text-muted mt-1">Änderungen werden im Audit-Log gespeichert.</p>
              </div>
              <button
                type="button"
                onClick={closeEditor}
                aria-label="Dialog schließen"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-control text-muted transition-colors hover:bg-surface-sunken hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              >
                <X size={16} />
              </button>
            </div>

            <div className="p-6 grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className="block text-xs font-semibold text-muted mb-1" htmlFor="projectsview-kunde-pflicht">Kunde (Pflicht)</label>
                <select id="projectsview-kunde-pflicht"
                  value={draft.clientId ?? ''}
                  onChange={(e) => setDraft({ ...draft, clientId: e.target.value })}
                  disabled={editorMode === 'edit'}
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring disabled:opacity-60"
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
                <label className="block text-xs font-semibold text-muted mb-1" htmlFor="projectsview-projektcode">Projektcode</label>
                <input id="projectsview-projektcode"
                  value={draft.code ?? ''}
                  onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                  placeholder="Leer lassen für automatische Vergabe (z.B. PRJ-2026-001)"
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-muted mb-1" htmlFor="projectsview-status">Status</label>
                <select id="projectsview-status"
                  value={draft.status}
                  onChange={(e) => setDraft({ ...draft, status: e.target.value as any })}
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                >
                  <option value="active">Aktiv</option>
                  <option value="planned">Geplant</option>
                  <option value="on_hold">Pausiert</option>
                  <option value="completed">Abgeschlossen</option>
                </select>
              </div>

              <div className="col-span-2">
                <label className="block text-xs font-semibold text-muted mb-1" htmlFor="projectsview-projektname-pflicht">Projektname (Pflicht)</label>
                <input id="projectsview-projektname-pflicht"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-muted mb-1" htmlFor="projectsview-start">Start</label>
                <input id="projectsview-start"
                  type="date"
                  value={draft.startDate}
                  onChange={(e) => setDraft({ ...draft, startDate: e.target.value })}
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-muted mb-1" htmlFor="projectsview-ende-optional">Ende (optional)</label>
                <input id="projectsview-ende-optional"
                  type="date"
                  value={draft.endDate ?? ''}
                  onChange={(e) => setDraft({ ...draft, endDate: e.target.value || undefined })}
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-muted mb-1" htmlFor="projectsview-budget">Budget</label>
                <input id="projectsview-budget"
                  type="number"
                  value={draft.budget ?? 0}
                  onChange={(e) => setDraft({ ...draft, budget: Number(e.target.value) })}
 className="px-3 h-10 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-muted mb-1">Archiviert</label>
                <div className="w-full bg-surface-muted border border-border rounded-xl p-3 text-sm font-medium text-foreground">
                  {draft.archivedAt ? draft.archivedAt : 'Nein'}
                </div>
              </div>

              <div className="col-span-2">
                <label className="block text-xs font-semibold text-muted mb-1" htmlFor="projectsview-beschreibung-optional">Beschreibung (optional)</label>
                <textarea id="projectsview-beschreibung-optional"
                  value={draft.description ?? ''}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  rows={3}
 className="px-3 py-2.5 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring resize-none"
                />
              </div>

              <div className="col-span-2">
                <label className="block text-xs font-semibold text-muted mb-1" htmlFor="projectsview-grund-pflicht">Grund (Pflicht)</label>
                <textarea id="projectsview-grund-pflicht"
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                    if (reasonError) setReasonError(null);
                  }}
                  rows={3}
                  placeholder="z.B. Projektstart verschoben, Code angepasst, ..."
 className="px-3 py-2.5 hover:border-ink-500 w-full bg-surface border border-control-border rounded-control text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring resize-none"
                />
                {reasonError && <div className="mt-2 text-sm font-semibold text-error-text">{reasonError}</div>}
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
            <h3 id="project-archive-title" className="text-lg font-semibold text-foreground mb-1">Projekt archivieren</h3>
            <p id="project-archive-description" className="text-sm text-muted mb-4">
              {archiveTarget.name} wird archiviert (nicht gelöscht). Bitte Grund angeben.
            </p>
            <label htmlFor="project-archive-reason" className="text-xs font-semibold text-muted">Grund (Pflicht)</label>
            <textarea
              id="project-archive-reason"
              value={archiveReason}
              onChange={(e) => {
                setArchiveReason(e.target.value);
                if (archiveError) setArchiveError(null);
              }}
              rows={3}
              className="px-3 py-2.5 hover:border-ink-500 mt-2 w-full rounded-control border border-control-border bg-surface text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
              placeholder="z.B. Projekt abgeschlossen, Kunde gekündigt, ..."
            />
            {archiveError && <div className="mt-2 text-sm font-semibold text-error-text">{archiveError}</div>}
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
