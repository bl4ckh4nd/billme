import {
  Badge, Button, Card, Checkbox, EmptyState, ErrorState, IconButton, Input, Menu, Modal, PageHeader, Select,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Textarea,
} from '@billme/ui';
import React from 'react';
import { Archive, Edit3, MoreHorizontal, Plus, Search, X } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { v4 as uuidv4 } from 'uuid';
import type { Project } from '@billme/desktop-core/types';
import { useClientsQuery } from '../hooks/useClients';
import { useArchiveProjectMutation, useProjectsQuery, useUpsertProjectMutation } from '../hooks/useProjects';
import { useCreateIntent } from '../hooks/useCreateIntent';
import { SkeletonLoader } from '../ui/components/SkeletonLoader';
import { localIsoDate } from '@billme/desktop-utils';

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
    const today = localIsoDate();
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

  const closeArchive = () => {
    setArchiveTarget(null);
    setArchiveReason('');
    setArchiveError(null);
  };

  return (
    <div className="flex flex-col gap-3">
      <PageHeader
        className="mb-0"
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
        <Card padding="none">
          {projects.length === 0 ? (
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
          )}
        </Card>
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
                    <span className="font-medium">{p.name}</span>
                    {p.code && <span className="ml-2 text-caption text-muted">{p.code}</span>}
                  </TableCell>
                  <TableCell className="max-w-64 truncate">{clientName}</TableCell>
                  <TableCell>
                    <Badge tone={statusTone[p.status]}>
                      {statusLabel[p.status]}
                    </Badge>
                  </TableCell>
                  <TableCell muted className="hidden tabular-nums md:table-cell">{p.startDate}</TableCell>
                  <TableCell className="py-1 text-right" onClick={(event) => event.stopPropagation()}>
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
      >
        {draft && (
          <>
            <div className="flex items-start gap-3 px-4.5 pt-4 pb-2.5">
              <div className="min-w-0 flex-1">
                <h3 id="project-editor-title" className="text-title text-foreground">
                  {editorMode === 'create' ? 'Neues Projekt' : 'Projekt bearbeiten'}
                </h3>
                <p id="project-editor-description" className="text-caption text-muted">Änderungen werden im Audit-Log gespeichert.</p>
              </div>
              <IconButton aria-label="Dialog schließen" tooltip={false} onClick={closeEditor}>
                <X size={16} aria-hidden="true" />
              </IconButton>
            </div>

            <div className="grid grid-cols-2 gap-3 px-4.5 pt-1 pb-4">
              <div className="col-span-2">
                <Select
                  id="projectsview-kunde-pflicht"
                  label="Kunde (Pflicht)"
                  value={draft.clientId ?? ''}
                  onChange={(e) => setDraft({ ...draft, clientId: e.target.value })}
                  disabled={editorMode === 'edit'}
                  hint={editorMode === 'edit' ? 'Kunden-Zuordnung ist nachträglich nicht änderbar.' : undefined}
                  fullWidth
                >
                  <option value="">(Bitte auswählen)</option>
                  {clients.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.company}
                    </option>
                  ))}
                </Select>
              </div>

              <Input
                id="projectsview-projektcode"
                label="Projektcode"
                value={draft.code ?? ''}
                onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                placeholder="Leer lassen für automatische Vergabe (z.B. PRJ-2026-001)"
                fullWidth
              />

              <Select
                id="projectsview-status"
                label="Status"
                value={draft.status}
                onChange={(e) => setDraft({ ...draft, status: e.target.value as any })}
                fullWidth
              >
                <option value="active">Aktiv</option>
                <option value="planned">Geplant</option>
                <option value="on_hold">Pausiert</option>
                <option value="completed">Abgeschlossen</option>
              </Select>

              <div className="col-span-2">
                <Input
                  id="projectsview-projektname-pflicht"
                  label="Projektname (Pflicht)"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  fullWidth
                />
              </div>

              <Input
                id="projectsview-start"
                label="Start"
                type="date"
                value={draft.startDate}
                onChange={(e) => setDraft({ ...draft, startDate: e.target.value })}
                fullWidth
              />
              <Input
                id="projectsview-ende-optional"
                label="Ende (optional)"
                type="date"
                value={draft.endDate ?? ''}
                onChange={(e) => setDraft({ ...draft, endDate: e.target.value || undefined })}
                fullWidth
              />

              <Input
                id="projectsview-budget"
                label="Budget"
                type="number"
                value={draft.budget ?? 0}
                onChange={(e) => setDraft({ ...draft, budget: Number(e.target.value) })}
                fullWidth
              />

              <Input label="Archiviert" readOnly value={draft.archivedAt ? draft.archivedAt : 'Nein'} fullWidth />

              <div className="col-span-2">
                <Textarea
                  id="projectsview-beschreibung-optional"
                  label="Beschreibung (optional)"
                  value={draft.description ?? ''}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  rows={3}
                  fullWidth
                />
              </div>

              <div className="col-span-2">
                <Textarea
                  id="projectsview-grund-pflicht"
                  label="Grund (Pflicht)"
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                    if (reasonError) setReasonError(null);
                  }}
                  rows={3}
                  placeholder="z.B. Projektstart verschoben, Code angepasst, ..."
                  error={reasonError}
                  fullWidth
                />
              </div>
            </div>

            <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4.5 py-3">
              <Button variant="secondary" onClick={closeEditor}>
                Abbrechen
              </Button>
              <Button onClick={submit}>
                Speichern
              </Button>
            </div>
          </>
        )}
      </Modal>

      <Modal
        open={Boolean(archiveTarget)}
        onClose={closeArchive}
        titleId="project-archive-title"
        descriptionId="project-archive-description"
      >
        {archiveTarget && (
          <>
            <div className="px-4.5 pt-4 pb-2.5">
              <h3 id="project-archive-title" className="text-title text-foreground">Projekt archivieren</h3>
              <p id="project-archive-description" className="text-caption text-muted">
                {archiveTarget.name} wird archiviert (nicht gelöscht). Bitte Grund angeben.
              </p>
            </div>
            <div className="px-4.5 pt-1 pb-4">
              <Textarea
                id="project-archive-reason"
                label="Grund (Pflicht)"
                value={archiveReason}
                onChange={(e) => {
                  setArchiveReason(e.target.value);
                  if (archiveError) setArchiveError(null);
                }}
                rows={3}
                placeholder="z.B. Projekt abgeschlossen, Kunde gekündigt, ..."
                error={archiveError}
                fullWidth
              />
            </div>
            <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4.5 py-3">
              <Button variant="secondary" onClick={closeArchive}>
                Abbrechen
              </Button>
              <Button onClick={submitArchive}>
                Archivieren
              </Button>
            </div>
          </>
        )}
      </Modal>
    </div>
  );
};
