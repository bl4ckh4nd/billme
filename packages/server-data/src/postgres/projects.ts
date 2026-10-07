import { buildNextProjectCode } from '@billme/server-core/services';
import { clientProjectSchema, type ClientProject, type TenantScope } from '@billme/server-core';
import type { Pool } from 'pg';
import type { ServerDatabase } from '../database.js';
import { withSerializablePostgresTransaction } from './connection.js';
import { createPostgresAuditLogPort } from './audit.js';
import type { AuditActor } from '@billme/server-core/ports';

class ProjectError extends Error {
  constructor(public readonly statusCode: number, message: string) {
    super(message);
  }
}

type ProjectQueryResult<Row> = { rows: Row[]; rowCount?: number | null; affectedRows?: number };
type ProjectQueryable = {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<ProjectQueryResult<Row>>;
};
type ProjectDatabase = ProjectQueryable | ServerDatabase;

type ClientProjectRow = {
  id: string;
  projects_json: string | null;
};

type StoredProject = Record<string, unknown> & {
  id?: unknown;
};

export interface ServerProjectRepository {
  list(scope: TenantScope, options?: { clientId?: string; includeArchived?: boolean }): Promise<ClientProject[]>;
  get(scope: TenantScope, id: string): Promise<ClientProject | null>;
  upsert(scope: TenantScope, project: ClientProject, reason: string): Promise<ClientProject>;
  archive(scope: TenantScope, id: string, reason: string): Promise<ClientProject>;
}

const parseStoredProjects = (value: string | null): StoredProject[] => {
  if (!value) return [];
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error('Client project snapshot is not an array');
  return parsed.filter((entry): entry is StoredProject => typeof entry === 'object' && entry !== null && !Array.isArray(entry));
};

const toProject = (project: StoredProject, clientId: string): ClientProject =>
  clientProjectSchema.parse({ ...project, clientId });

const readRows = async (db: ProjectQueryable, scope: TenantScope, lock = false): Promise<ClientProjectRow[]> => {
  const result = await db.query<ClientProjectRow>(
    `SELECT id, projects_json
       FROM clients
      WHERE tenant_id = $1
      ${lock ? 'FOR UPDATE' : ''}`,
    [scope.tenantId],
  );
  return result.rows;
};

const projectEntries = (rows: ClientProjectRow): Array<{ raw: StoredProject; project: ClientProject }> =>
  parseStoredProjects(rows.projects_json).flatMap((raw) => {
    try {
      return [{ raw, project: toProject(raw, rows.id) }];
    } catch {
      return [];
    }
  });

const allProjects = (rows: ClientProjectRow[]): Array<{ clientId: string; raw: StoredProject; project: ClientProject }> =>
  rows.flatMap((row) => projectEntries(row).map((entry) => ({ clientId: row.id, ...entry })));

const sortProjects = (projects: ClientProject[]): ClientProject[] => projects.sort((left, right) => {
  const archivedOrder = Number(Boolean(left.archivedAt)) - Number(Boolean(right.archivedAt));
  if (archivedOrder !== 0) return archivedOrder;
  const startOrder = right.startDate.localeCompare(left.startDate);
  if (startOrder !== 0) return startOrder;
  return left.name.localeCompare(right.name);
});

const withMutationTransaction = async <T>(
  db: ProjectDatabase,
  work: (session: ProjectQueryable) => Promise<T>,
): Promise<T> => {
  if ('engine' in db) {
    return db.transaction({ isolation: 'serializable' }, (session) => work(session));
  }
  if ('connect' in db && typeof db.connect === 'function') {
    return withSerializablePostgresTransaction(db as unknown as Pool, (client) => work(client));
  }
  return work(db);
};

const updateClientProjects = async (
  db: ProjectQueryable,
  scope: TenantScope,
  clientId: string,
  projects: StoredProject[],
  updatedAt: string,
): Promise<void> => {
  const result = await db.query(
    `UPDATE clients
        SET projects_json = $1,
            updated_at = $2
      WHERE tenant_id = $3
        AND id = $4`,
    [JSON.stringify(projects), updatedAt, scope.tenantId, clientId],
  );
  if ((result.rowCount ?? result.affectedRows ?? 0) < 1) {
    throw new ProjectError(404, 'Kunde nicht gefunden.');
  }
};

export const createPostgresProjectRepository = (
  db: ProjectDatabase,
  actor: AuditActor = { type: 'service', displayName: 'server-projects' },
): ServerProjectRepository => ({
  async list(scope, options) {
    const rows = await readRows(db, scope);
    const projects = allProjects(rows)
      .filter(({ clientId }) => !options?.clientId || clientId === options.clientId)
      .map(({ project }) => project)
      .filter((project) => options?.includeArchived || !project.archivedAt);
    return sortProjects(projects);
  },

  async get(scope, id) {
    const rows = await readRows(db, scope);
    return allProjects(rows).find(({ project }) => project.id === id)?.project ?? null;
  },

  async upsert(scope, project, reason) {
    if (!reason.trim()) throw new ProjectError(400, 'Änderungsgrund erforderlich.');
    if (!project.clientId) throw new ProjectError(400, 'Kunde erforderlich.');

    return withMutationTransaction(db, async (session) => {
      const rows = await readRows(session, scope, true);
      const target = rows.find((row) => row.id === project.clientId);
      if (!target) throw new ProjectError(404, 'Kunde nicht gefunden.');

      const existing = allProjects(rows).find(({ project: candidate }) => candidate.id === project.id);
      const year = project.startDate.slice(0, 4);
      const requestedCode = project.code?.trim();
      const nextCode = requestedCode || buildNextProjectCode(
        allProjects(rows)
          .filter(({ project: candidate }) => candidate.id !== project.id)
          .map(({ project: candidate }) => candidate.code)
          .filter((code) => code?.startsWith(`PRJ-${year}-`)),
        year,
      );
      const codeCollision = allProjects(rows).some(({ project: candidate }) =>
        candidate.id !== project.id && candidate.code === nextCode,
      );
      if (codeCollision) throw new ProjectError(409, 'Projektnummer bereits vergeben.');

      const now = new Date().toISOString();
      const next: StoredProject = {
        ...(existing?.raw ?? {}),
        ...project,
        clientId: project.clientId,
        code: nextCode,
        ...(existing ? { createdAt: existing.project.createdAt ?? project.createdAt } : { createdAt: project.createdAt ?? now }),
        updatedAt: now,
      };

      for (const row of rows) {
        const current = parseStoredProjects(row.projects_json);
        const withoutProject = current.filter((candidate) => candidate.id !== project.id);
        const nextProjects = row.id === project.clientId ? [...withoutProject, next] : withoutProject;
        if (nextProjects.length !== current.length || row.id === project.clientId) {
          await updateClientProjects(session, scope, row.id, nextProjects, now);
        }
      }

      const saved = toProject(next, project.clientId);
      await createPostgresAuditLogPort(session).append(scope, {
        occurredAt: now, action: 'project.upsert', reason, actor,
        subject: { entityType: 'project', entityId: saved.id, tenantId: scope.tenantId },
        change: { before: existing?.project, after: saved },
      });
      return saved;
    });
  },

  async archive(scope, id, reason) {
    if (!reason.trim()) throw new ProjectError(400, 'Archivierungsgrund erforderlich.');

    return withMutationTransaction(db, async (session) => {
      const rows = await readRows(session, scope, true);
      const existing = allProjects(rows).find(({ project }) => project.id === id);
      if (!existing) throw new ProjectError(404, 'Projekt nicht gefunden.');

      const now = new Date().toISOString();
      const next: StoredProject = { ...existing.raw, archivedAt: now, updatedAt: now };
      const owner = rows.find((row) => row.id === existing.clientId);
      if (!owner) throw new ProjectError(404, 'Kunde nicht gefunden.');
      const nextProjects = parseStoredProjects(owner.projects_json).map((candidate) => candidate.id === id ? next : candidate);
      await updateClientProjects(session, scope, owner.id, nextProjects, now);
      const saved = toProject(next, owner.id);
      await createPostgresAuditLogPort(session).append(scope, {
        occurredAt: now, action: 'project.archive', reason, actor,
        subject: { entityType: 'project', entityId: saved.id, tenantId: scope.tenantId },
        change: { before: existing.project, after: saved },
      });
      return saved;
    });
  },
});
