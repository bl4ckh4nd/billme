import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { and, asc, desc, eq, isNull, like, ne } from 'drizzle-orm';
import {
  buildNextProjectCode,
  ensureDefaultProjectForClient as ensureDefaultProjectForClientDomain,
} from '@billme/server-core/services';
import type { SyncDefaultProjectPorts } from '@billme/server-core/ports';
import type { Project } from '@billme/desktop-core/types';
import { appendAuditLog } from './audit';
import { createDrizzle, schema } from './drizzle';

type ProjectRow = {
  id: string;
  client_id: string;
  code: string | null;
  name: string;
  status: string;
  budget: number;
  start_date: string;
  end_date: string | null;
  description: string | null;
  archived_at: string | null;
  created_at: string | null;
  updated_at: string | null;
};

const rowToProject = (row: ProjectRow): Project => {
  return {
    id: row.id,
    clientId: row.client_id,
    code: row.code ?? undefined,
    name: row.name,
    status: row.status as any,
    budget: row.budget,
    startDate: row.start_date,
    endDate: row.end_date ?? undefined,
    description: row.description ?? undefined,
    archivedAt: row.archived_at ?? undefined,
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  };
};

const listProjectCodesByPrefix = (db: Database.Database, prefix: string): Array<string | null> => {
  return createDrizzle(db).select({ code: schema.clientProjects.code }).from(schema.clientProjects)
    .where(like(schema.clientProjects.code, `${prefix}%`)).all().map((row) => row.code);
};

const nextProjectCode = (db: Database.Database, year: string): string => {
  return buildNextProjectCode(listProjectCodesByPrefix(db, `PRJ-${year}-`), year);
};

export const ensureDefaultProjectForClient = (db: Database.Database, clientId: string): Project => {
  const drizzle = createDrizzle(db);
  const ports: SyncDefaultProjectPorts<Project & { clientId: string }> = {
    tx: {
      inTransaction<TResult>(work: () => TResult): TResult {
        return db.transaction(work)();
      },
    },
    getActiveDefaultProjectForClient: (currentClientId) => {
      const existing = drizzle.select({
        id: schema.clientProjects.id,
        client_id: schema.clientProjects.clientId,
        code: schema.clientProjects.code,
        name: schema.clientProjects.name,
        status: schema.clientProjects.status,
        budget: schema.clientProjects.budget,
        start_date: schema.clientProjects.startDate,
        end_date: schema.clientProjects.endDate,
        description: schema.clientProjects.description,
        archived_at: schema.clientProjects.archivedAt,
        created_at: schema.clientProjects.createdAt,
        updated_at: schema.clientProjects.updatedAt,
      }).from(schema.clientProjects).where(and(
        eq(schema.clientProjects.clientId, currentClientId),
        eq(schema.clientProjects.name, 'Allgemein'),
        isNull(schema.clientProjects.archivedAt),
      )).orderBy(desc(schema.clientProjects.startDate)).limit(1).get() as ProjectRow | undefined;
      return existing ? rowToProject(existing) as Project & { clientId: string } : null;
    },
    listProjectCodesByPrefix: (prefix) => listProjectCodesByPrefix(db, prefix),
    saveProject: (project) => {
      drizzle.insert(schema.clientProjects).values({
        id: project.id,
        clientId: project.clientId,
        code: project.code ?? null,
        name: project.name,
        status: project.status,
        budget: project.budget,
        startDate: project.startDate,
        endDate: project.endDate ?? null,
        description: project.description ?? null,
        archivedAt: project.archivedAt ?? null,
        createdAt: project.createdAt ?? null,
        updatedAt: project.updatedAt ?? null,
      }).run();
      return project;
    },
  };

  const result = ensureDefaultProjectForClientDomain(ports, {
    clientId,
    createProjectId: () => randomUUID(),
  });

  if (result.created) {
    appendAuditLog(db, {
      entityType: 'project',
      entityId: result.project.id,
      action: 'project.create',
      reason: 'auto:default',
      before: null,
      after: result.project,
    });
  }

  return result.project;
};

export const listProjects = (
  db: Database.Database,
  args?: { clientId?: string; includeArchived?: boolean },
): Project[] => {
  const includeArchived = Boolean(args?.includeArchived);
  if (args?.clientId) {
    ensureDefaultProjectForClient(db, args.clientId);
  }

  const drizzle = createDrizzle(db);
  const selection = drizzle.select({
    id: schema.clientProjects.id,
    client_id: schema.clientProjects.clientId,
    code: schema.clientProjects.code,
    name: schema.clientProjects.name,
    status: schema.clientProjects.status,
    budget: schema.clientProjects.budget,
    start_date: schema.clientProjects.startDate,
    end_date: schema.clientProjects.endDate,
    description: schema.clientProjects.description,
    archived_at: schema.clientProjects.archivedAt,
    created_at: schema.clientProjects.createdAt,
    updated_at: schema.clientProjects.updatedAt,
  }).from(schema.clientProjects);
  const projectFilter = args?.clientId && !includeArchived
    ? and(eq(schema.clientProjects.clientId, args.clientId), isNull(schema.clientProjects.archivedAt))
    : args?.clientId
      ? eq(schema.clientProjects.clientId, args.clientId)
      : !includeArchived
        ? isNull(schema.clientProjects.archivedAt)
        : undefined;
  const rows = (projectFilter ? selection.where(projectFilter) : selection)
    .orderBy(asc(schema.clientProjects.archivedAt), desc(schema.clientProjects.startDate), asc(schema.clientProjects.name)).all() as ProjectRow[];

  return rows.map(rowToProject);
};

export const getProject = (db: Database.Database, id: string): Project | null => {
  const row = createDrizzle(db).select({
    id: schema.clientProjects.id,
    client_id: schema.clientProjects.clientId,
    code: schema.clientProjects.code,
    name: schema.clientProjects.name,
    status: schema.clientProjects.status,
    budget: schema.clientProjects.budget,
    start_date: schema.clientProjects.startDate,
    end_date: schema.clientProjects.endDate,
    description: schema.clientProjects.description,
    archived_at: schema.clientProjects.archivedAt,
    created_at: schema.clientProjects.createdAt,
    updated_at: schema.clientProjects.updatedAt,
  }).from(schema.clientProjects).where(eq(schema.clientProjects.id, id)).get() as ProjectRow | undefined;
  return row ? rowToProject(row) : null;
};

export const upsertProject = (
  db: Database.Database,
  project: Project & { clientId: string },
  reason: string,
): Project => {
  if (!reason || reason.trim().length === 0) {
    throw new Error('Edit reason is required');
  }
  if (!project.clientId) throw new Error('clientId is required');

  const tx = db.transaction(() => {
    const drizzle = createDrizzle(db);
    const before = getProject(db, project.id);
    const now = new Date().toISOString();
    const nowDate = now.split('T')[0] ?? now;

    const exists = drizzle.select({ id: schema.clientProjects.id }).from(schema.clientProjects)
      .where(eq(schema.clientProjects.id, project.id)).get();

    const year = (project.startDate?.slice(0, 4) || String(new Date(now).getFullYear())).padStart(4, '0');
    const code = (project.code && project.code.trim().length > 0 ? project.code.trim() : null) ?? nextProjectCode(db, year);

    const collision = drizzle.select({ id: schema.clientProjects.id }).from(schema.clientProjects)
      .where(and(eq(schema.clientProjects.code, code), ne(schema.clientProjects.id, project.id))).get();
    if (collision) throw new Error('Project code already exists');

    if (!exists) {
      drizzle.insert(schema.clientProjects).values({
        id: project.id,
        clientId: project.clientId,
        code,
        name: project.name,
        status: project.status,
        budget: project.budget ?? 0,
        startDate: project.startDate || nowDate,
        endDate: project.endDate ?? null,
        description: project.description ?? null,
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      }).run();
    } else {
      drizzle.update(schema.clientProjects).set({
        clientId: project.clientId,
        code,
        name: project.name,
        status: project.status,
        budget: project.budget ?? 0,
        startDate: project.startDate || nowDate,
        endDate: project.endDate ?? null,
        description: project.description ?? null,
        updatedAt: now,
      }).where(eq(schema.clientProjects.id, project.id)).run();
    }

    const after = getProject(db, project.id);
    if (!after) throw new Error('Project not found after upsert');

    appendAuditLog(db, {
      entityType: 'project',
      entityId: project.id,
      action: exists ? 'project.update' : 'project.create',
      reason,
      before,
      after,
    });

    return after;
  });

  return tx();
};

export const archiveProject = (db: Database.Database, id: string, reason: string): Project => {
  if (!reason || reason.trim().length === 0) {
    throw new Error('Archive reason is required');
  }

  const tx = db.transaction(() => {
    const before = getProject(db, id);
    if (!before) throw new Error('Project not found');

    const now = new Date().toISOString();
    createDrizzle(db).update(schema.clientProjects).set({ archivedAt: now, updatedAt: now })
      .where(eq(schema.clientProjects.id, id)).run();

    const after = getProject(db, id);
    if (!after) throw new Error('Project not found after archive');

    appendAuditLog(db, {
      entityType: 'project',
      entityId: id,
      action: 'project.archive',
      reason,
      before,
      after,
    });

    return after;
  });

  return tx();
};
