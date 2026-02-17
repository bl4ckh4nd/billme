import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { Project } from '../types';
import { appendAuditLog } from './audit';

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

const nextProjectCode = (db: Database.Database, year: string): string => {
  const like = `PRJ-${year}-%`;
  const rows = db
    .prepare(`SELECT code FROM client_projects WHERE code LIKE ?`)
    .all(like) as Array<{ code: string | null }>;

  let max = 0;
  for (const r of rows) {
    if (!r.code) continue;
    const m = /^PRJ-\d{4}-(\d+)$/.exec(r.code);
    if (!m) continue;
    const seq = Number(m[1]!);
    if (!Number.isFinite(seq)) continue;
    max = Math.max(max, seq);
  }
  return `PRJ-${year}-${String(max + 1).padStart(3, '0')}`;
};

export const ensureDefaultProjectForClient = (db: Database.Database, clientId: string): Project => {
  const existing = db
    .prepare(
      `
        SELECT * FROM client_projects
        WHERE client_id = ? AND name = 'Allgemein' AND archived_at IS NULL
        ORDER BY start_date DESC
        LIMIT 1
      `,
    )
    .get(clientId) as ProjectRow | undefined;
  if (existing) return rowToProject(existing);

  const now = new Date().toISOString();
  const nowDate = now.split('T')[0] ?? now;
  const year = String(new Date(now).getFullYear());

  const project: Project = {
    id: randomUUID(),
    clientId,
    code: nextProjectCode(db, year),
    name: 'Allgemein',
    status: 'active',
    budget: 0,
    startDate: nowDate,
  };

  db.prepare(
    `
      INSERT INTO client_projects (
        id, client_id, code, name, status, budget, start_date, end_date, description,
        archived_at, created_at, updated_at
      ) VALUES (
        @id, @clientId, @code, @name, @status, @budget, @startDate, @endDate, @description,
        @archivedAt, @createdAt, @updatedAt
      )
    `,
  ).run({
    id: project.id,
    clientId,
    code: project.code ?? null,
    name: project.name,
    status: project.status,
    budget: project.budget,
    startDate: project.startDate,
    endDate: null,
    description: null,
    archivedAt: null,
    createdAt: now,
    updatedAt: now,
  });

  appendAuditLog(db, {
    entityType: 'project',
    entityId: project.id,
    action: 'project.create',
    reason: 'auto:default',
    before: null,
    after: project,
  });

  return { ...project, createdAt: now, updatedAt: now };
};

export const listProjects = (
  db: Database.Database,
  args?: { clientId?: string; includeArchived?: boolean },
): Project[] => {
  const includeArchived = Boolean(args?.includeArchived);
  if (args?.clientId) {
    ensureDefaultProjectForClient(db, args.clientId);
  }

  const rows = args?.clientId
    ? (db
        .prepare(
          `
            SELECT * FROM client_projects
            WHERE client_id = ?
              AND (${includeArchived ? '1=1' : 'archived_at IS NULL'})
            ORDER BY archived_at IS NOT NULL, start_date DESC, name ASC
          `,
        )
        .all(args.clientId) as ProjectRow[])
    : (db
        .prepare(
          `
            SELECT * FROM client_projects
            WHERE ${includeArchived ? '1=1' : 'archived_at IS NULL'}
            ORDER BY archived_at IS NOT NULL, start_date DESC, name ASC
          `,
        )
        .all() as ProjectRow[]);

  return rows.map(rowToProject);
};

export const getProject = (db: Database.Database, id: string): Project | null => {
  const row = db.prepare('SELECT * FROM client_projects WHERE id = ?').get(id) as ProjectRow | undefined;
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
    const before = getProject(db, project.id);
    const now = new Date().toISOString();
    const nowDate = now.split('T')[0] ?? now;

    const exists = db
      .prepare('SELECT 1 FROM client_projects WHERE id = ?')
      .get(project.id) as { 1: 1 } | undefined;

    const year = (project.startDate?.slice(0, 4) || String(new Date(now).getFullYear())).padStart(4, '0');
    const code = (project.code && project.code.trim().length > 0 ? project.code.trim() : null) ?? nextProjectCode(db, year);

    const collision = db
      .prepare('SELECT id FROM client_projects WHERE code = ? AND id <> ?')
      .get(code, project.id) as { id: string } | undefined;
    if (collision) throw new Error('Project code already exists');

    if (!exists) {
      db.prepare(
        `
          INSERT INTO client_projects (
            id, client_id, code, name, status, budget, start_date, end_date, description,
            archived_at, created_at, updated_at
          ) VALUES (
            @id, @clientId, @code, @name, @status, @budget, @startDate, @endDate, @description,
            @archivedAt, @createdAt, @updatedAt
          )
        `,
      ).run({
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
      });
    } else {
      db.prepare(
        `
          UPDATE client_projects SET
            client_id=@clientId,
            code=@code,
            name=@name,
            status=@status,
            budget=@budget,
            start_date=@startDate,
            end_date=@endDate,
            description=@description,
            updated_at=@updatedAt
          WHERE id=@id
        `,
      ).run({
        id: project.id,
        clientId: project.clientId,
        code,
        name: project.name,
        status: project.status,
        budget: project.budget ?? 0,
        startDate: project.startDate || nowDate,
        endDate: project.endDate ?? null,
        description: project.description ?? null,
        updatedAt: now,
      });
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
    db.prepare('UPDATE client_projects SET archived_at = @archivedAt, updated_at = @updatedAt WHERE id = @id').run({
      id,
      archivedAt: now,
      updatedAt: now,
    });

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
