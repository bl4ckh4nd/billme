import { Button } from '@billme/ui';
import React from 'react';
import { Archive, Edit3, FolderOpen, Plus, Search, X } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { v4 as uuidv4 } from 'uuid';
import type { Project } from '../types';
import { useClientsQuery } from '../hooks/useClients';
import { useArchiveProjectMutation, useProjectsQuery, useUpsertProjectMutation } from '../hooks/useProjects';
import { Spinner } from './Spinner';
import { SkeletonLoader } from './SkeletonLoader';

type EditorMode = 'create' | 'edit';

export const ProjectsView: React.FC = () => {
  const navigate = useNavigate();
  const { data: clients = [] } = useClientsQuery();
  const [search, setSearch] = React.useState('');
  const [includeArchived, setIncludeArchived] = React.useState(false);
  const { data: projects = [], isLoading } = useProjectsQuery({ includeArchived });
  const upsertProject = useUpsertProjectMutation();
  const archiveProject = useArchiveProjectMutation();

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
    <div className="bg-surface rounded-xl p-8 min-h-full shadow-sm">
      <div className="flex items-start justify-between gap-4 mb-6">
        <div>
          <h2 className="text-2xl font-black text-foreground">Projekte</h2>
          <p className="text-sm text-muted mt-1">
            Projekte strukturieren alle Dokumente (Rechnungen/Angebote) pro Kunde.
          </p>
        </div>
        <button
          onClick={openCreate}
          className="px-5 py-3 rounded-xl font-bold bg-foreground text-white hover:bg-dark-1 transition-colors duration-150 ease-out inline-flex items-center gap-2"
        >
          <Plus size={18} /> Neues Projekt
        </button>
      </div>

      <div className="flex items-center justify-between gap-4 mb-6">
        <div className="flex items-center gap-3 w-full max-w-xl bg-surface-muted border border-border rounded-lg px-4 py-3">
          <Search size={18} className="text-muted" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-transparent outline-none text-sm font-medium w-full"
            placeholder="Suchen (Code, Projektname, Kunde)..."
          />
        </div>

        <label className="flex items-center gap-2 text-sm font-bold text-foreground select-none">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
            className="h-4 w-4 rounded border-border text-foreground focus:ring-accent"
          />
          Archiviert anzeigen
        </label>
      </div>

      <div className="overflow-hidden rounded-xl border border-border">
        <div className="grid grid-cols-12 bg-surface-muted px-4 py-3 text-xs font-bold text-muted uppercase tracking-wider">
          <div className="col-span-3">Projekt</div>
          <div className="col-span-3">Kunde</div>
          <div className="col-span-2">Status</div>
          <div className="col-span-2">Start</div>
          <div className="col-span-2 text-right">Aktionen</div>
        </div>

        {isLoading ? (
          <SkeletonLoader variant="table" count={5} />
        ) : filtered.length === 0 ? (
          search ? (
            <div className="py-14 flex flex-col items-center gap-3 text-center">
              <Search size={22} className="text-muted" />
              <p className="text-sm text-muted">Keine Projekte für „{search}" gefunden.</p>
            </div>
          ) : (
            <div className="py-16 flex flex-col items-center gap-5 text-center">
              <div className="w-14 h-14 rounded-full bg-surface-muted flex items-center justify-center">
                <FolderOpen size={26} className="text-muted" />
              </div>
              <div>
                <p className="font-bold text-foreground text-sm">Noch keine Projekte angelegt</p>
                <p className="text-muted text-sm mt-1">Projekte strukturieren alle Dokumente pro Kunde.</p>
              </div>
              <button
                onClick={openCreate}
                className="px-5 py-2.5 rounded-xl font-bold bg-foreground text-white hover:bg-dark-1 transition-colors duration-150 ease-out inline-flex items-center gap-2"
              >
                <Plus size={16} /> Neues Projekt
              </button>
            </div>
          )
        ) : (
          <div className="divide-y divide-border-subtle">
            {filtered.map((p) => {
              const clientName = clients.find((c) => c.id === p.clientId)?.company ?? 'Unbekannt';
              return (
                <div
                  key={p.id}
                  className="group grid grid-cols-12 px-4 py-4 items-center hover:bg-surface-muted transition-colors duration-150 ease-out"
                >
                  <button
                    className="col-span-3 text-left"
                    onClick={() => navigate({ to: `/projects/${p.id}` })}
                    title="Projekt öffnen"
                  >
                    <div className="font-black text-foreground">{p.name}</div>
                    <div className="text-xs text-muted">{p.code ?? ''}</div>
                  </button>
                  <div className="col-span-3 text-sm font-bold text-foreground">{clientName}</div>
                  <div className="col-span-2 text-sm font-bold text-foreground">{statusLabel[p.status]}</div>
                  <div className="col-span-2 text-sm text-muted">{p.startDate}</div>
                  <div className="col-span-2 flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity duration-150 ease-out">
                    <button
                      onClick={() => openEdit(p)}
                      className="px-3 py-2 rounded-lg bg-canvas hover:bg-surface-muted text-foreground font-bold text-sm inline-flex items-center gap-2"
                      title="Bearbeiten"
                    >
                      <Edit3 size={16} /> Bearbeiten
                    </button>
                    <button
                      onClick={() => {
                        setArchiveTarget(p);
                        setArchiveReason('');
                        setArchiveError(null);
                      }}
                      className="px-3 py-2 rounded-lg bg-canvas hover:bg-surface-muted text-foreground font-bold text-sm inline-flex items-center gap-2"
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

      {isEditorOpen && draft && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-2xl rounded-3xl bg-surface shadow-xl overflow-hidden">
            <div className="flex items-center justify-between px-6 py-5 border-b border-border-subtle">
              <div>
                <h3 className="text-lg font-black text-foreground">
                  {editorMode === 'create' ? 'Neues Projekt' : 'Projekt bearbeiten'}
                </h3>
                <p className="text-sm text-muted mt-1">Änderungen werden im Audit-Log gespeichert.</p>
              </div>
              <button
                onClick={closeEditor}
                className="w-10 h-10 rounded-full bg-canvas hover:bg-surface-muted flex items-center justify-center"
                title="Schließen"
              >
                <X size={18} />
              </button>
            </div>

            <div className="p-6 grid grid-cols-2 gap-4">
              <div className="col-span-2">
                <label className="block text-xs font-bold text-muted mb-1">Kunde (Pflicht)</label>
                <select
                  value={draft.clientId ?? ''}
                  onChange={(e) => setDraft({ ...draft, clientId: e.target.value })}
                  disabled={editorMode === 'edit'}
                  className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none disabled:opacity-60"
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
                <label className="block text-xs font-bold text-muted mb-1">Projektcode</label>
                <input
                  value={draft.code ?? ''}
                  onChange={(e) => setDraft({ ...draft, code: e.target.value })}
                  placeholder="Leer lassen für automatische Vergabe (z.B. PRJ-2026-001)"
                  className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-muted mb-1">Status</label>
                <select
                  value={draft.status}
                  onChange={(e) => setDraft({ ...draft, status: e.target.value as any })}
                  className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none"
                >
                  <option value="active">Aktiv</option>
                  <option value="planned">Geplant</option>
                  <option value="on_hold">Pausiert</option>
                  <option value="completed">Abgeschlossen</option>
                </select>
              </div>

              <div className="col-span-2">
                <label className="block text-xs font-bold text-muted mb-1">Projektname (Pflicht)</label>
                <input
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                  className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-muted mb-1">Start</label>
                <input
                  type="date"
                  value={draft.startDate}
                  onChange={(e) => setDraft({ ...draft, startDate: e.target.value })}
                  className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-bold text-muted mb-1">Ende (optional)</label>
                <input
                  type="date"
                  value={draft.endDate ?? ''}
                  onChange={(e) => setDraft({ ...draft, endDate: e.target.value || undefined })}
                  className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-muted mb-1">Budget</label>
                <input
                  type="number"
                  value={draft.budget ?? 0}
                  onChange={(e) => setDraft({ ...draft, budget: Number(e.target.value) })}
                  className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none tabular-nums"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-muted mb-1">Archiviert</label>
                <div className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium text-foreground">
                  {draft.archivedAt ? draft.archivedAt : 'Nein'}
                </div>
              </div>

              <div className="col-span-2">
                <label className="block text-xs font-bold text-muted mb-1">Beschreibung (optional)</label>
                <textarea
                  value={draft.description ?? ''}
                  onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                  rows={3}
                  className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none resize-none"
                />
              </div>

              <div className="col-span-2">
                <label className="block text-xs font-bold text-muted mb-1">Grund (Pflicht)</label>
                <textarea
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                    if (reasonError) setReasonError(null);
                  }}
                  rows={3}
                  placeholder="z.B. Projektstart verschoben, Code angepasst, ..."
                  className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none resize-none"
                />
                {reasonError && <div className="mt-2 text-sm font-bold text-error">{reasonError}</div>}
              </div>
            </div>

            <div className="px-6 py-5 border-t border-border-subtle flex items-center justify-end gap-3">
              <button
                onClick={closeEditor}
                className="px-5 py-2.5 rounded-xl font-bold bg-canvas text-foreground hover:bg-surface-muted transition-colors duration-150 ease-out"
              >
                Abbrechen
              </button>
              <button
                onClick={submit}
                className="px-5 py-2.5 rounded-xl font-bold bg-foreground text-white hover:bg-dark-1 transition-colors duration-150 ease-out"
              >
                Speichern
              </button>
            </div>
          </div>
        </div>
      )}

      {archiveTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-3xl bg-surface shadow-xl p-6">
            <h3 className="text-lg font-black text-foreground mb-1">Projekt archivieren</h3>
            <p className="text-sm text-muted mb-4">
              {archiveTarget.name} wird archiviert (nicht gelöscht). Bitte Grund angeben.
            </p>
            <label className="text-xs font-bold text-muted">Grund (Pflicht)</label>
            <textarea
              value={archiveReason}
              onChange={(e) => {
                setArchiveReason(e.target.value);
                if (archiveError) setArchiveError(null);
              }}
              rows={3}
              className="mt-2 w-full rounded-lg border border-border bg-surface-muted px-4 py-3 text-sm outline-none focus:ring-2 focus:ring-accent"
              placeholder="z.B. Projekt abgeschlossen, Kunde gekündigt, ..."
            />
            {archiveError && <div className="mt-2 text-sm font-bold text-error">{archiveError}</div>}
            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                className="px-5 py-2.5 rounded-xl font-bold bg-canvas text-foreground hover:bg-surface-muted transition-colors duration-150 ease-out"
                onClick={() => {
                  setArchiveTarget(null);
                  setArchiveReason('');
                  setArchiveError(null);
                }}
              >
                Abbrechen
              </button>
              <button
                className="px-5 py-2.5 rounded-xl font-bold bg-foreground text-white hover:bg-dark-1 transition-colors duration-150 ease-out"
                onClick={submitArchive}
              >
                Archivieren
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
