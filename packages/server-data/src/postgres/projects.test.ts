import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSingleTenantScope, type ClientProject } from '@billme/server-core';
import { PgliteServerDatabase } from '../pglite/database.js';
import { createPostgresProjectRepository } from './projects.js';

const now = '2026-08-21T10:00:00.000Z';

const project = (overrides: Partial<ClientProject> = {}): ClientProject => ({
  id: 'project-a',
  clientId: 'client-a',
  name: 'Projekt A',
  status: 'active',
  budget: 100,
  startDate: '2026-01-01',
  ...overrides,
});

async function withDatabase<T>(work: (database: PgliteServerDatabase) => Promise<T>): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-projects-'));
  const database = await PgliteServerDatabase.open(dataDir);
  try {
    await database.migrate();
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at)
       VALUES ('tenant-a', 'tenant-a', 'Tenant A', 'pro', $1, $1),
              ('tenant-b', 'tenant-b', 'Tenant B', 'pro', $1, $1)`,
      [now],
    );
    await database.query(
      `INSERT INTO clients (id, tenant_id, company, contact_person, email, phone, address, status, tags_json, notes, projects_json, created_at, updated_at)
       VALUES ('client-a', 'tenant-a', 'Client A', '', '', '', '', 'active', '[]', 'keep-a', $1, $2, $2),
              ('client-b', 'tenant-b', 'Client B', '', '', '', '', 'active', '[]', 'keep-b', $3, $2, $2)`,
      [JSON.stringify([{ ...project(), clientSpecificMetadata: 'keep' }]), now, JSON.stringify([project({ id: 'project-b', clientId: 'client-b', name: 'Projekt B' })])],
    );
    return await work(database);
  } finally {
    await database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('project repository lists and gets only the scoped tenant projects without creating defaults', async () => {
  await withDatabase(async (database) => {
    const repository = createPostgresProjectRepository(database);
    const scope = createSingleTenantScope('tenant-a', 'pro');

    assert.deepEqual(await repository.list(scope), [project()]);
    assert.deepEqual(await repository.get(scope, 'project-a'), project());
    assert.equal(await repository.get(scope, 'project-b'), null);
    assert.deepEqual((await database.query<{ projects_json: string }>(
      'SELECT projects_json FROM clients WHERE id = $1',
      ['client-a'],
    )).rows[0]?.projects_json, JSON.stringify([{ ...project(), clientSpecificMetadata: 'keep' }]));
  });
});

test('project repository upsert moves a project atomically and preserves unknown project and client fields', async () => {
  await withDatabase(async (database) => {
    await database.query(
      `INSERT INTO clients (id, tenant_id, company, contact_person, email, phone, address, status, tags_json, notes, projects_json, created_at, updated_at)
       VALUES ('client-c', 'tenant-a', 'Client C', '', '', '', '', 'active', '["tag"]', 'keep-client-c', '[]', $1, $1)`,
      [now],
    );
    const repository = createPostgresProjectRepository(database);
    const scope = createSingleTenantScope('tenant-a', 'pro');

    const moved = await repository.upsert(scope, project({ clientId: 'client-c', description: 'Moved' }), 'Projekt verschoben');
    assert.equal(moved.clientId, 'client-c');
    assert.equal(moved.description, 'Moved');
    assert.equal(moved.code, 'PRJ-2026-001');

    const source = await database.query<{ projects_json: string; notes: string }>(
      'SELECT projects_json, notes FROM clients WHERE id = $1',
      ['client-a'],
    );
    assert.deepEqual(source.rows[0], { projects_json: '[]', notes: 'keep-a' });
    const target = await database.query<{ projects_json: string; tags_json: string; notes: string }>(
      'SELECT projects_json, tags_json, notes FROM clients WHERE id = $1',
      ['client-c'],
    );
    const targetProjects = JSON.parse(target.rows[0]?.projects_json ?? '[]') as Array<Record<string, unknown>>;
    assert.equal(targetProjects[0]?.description, 'Moved');
    assert.equal(targetProjects[0]?.clientSpecificMetadata, 'keep');
    assert.equal(target.rows[0]?.tags_json, '["tag"]');
    assert.equal(target.rows[0]?.notes, 'keep-client-c');

    await assert.rejects(
      () => repository.upsert(scope, project({ id: 'project-collision', clientId: 'client-c', code: 'PRJ-2026-001' }), 'Kollision'),
      /Project code already exists/,
    );
  });
});

test('project repository archives and filters projects while retaining archived records on request', async () => {
  await withDatabase(async (database) => {
    const repository = createPostgresProjectRepository(database);
    const scope = createSingleTenantScope('tenant-a', 'pro');

    const archived = await repository.archive(scope, 'project-a', 'Projekt abgeschlossen');
    assert.equal(archived.archivedAt !== undefined, true);
    assert.deepEqual(await repository.list(scope), []);
    assert.deepEqual(await repository.list(scope, { includeArchived: true }), [archived]);
    await assert.rejects(() => repository.archive(scope, 'missing', 'Nicht vorhanden'), /Project not found/);
    await assert.rejects(() => repository.archive(scope, 'project-a', '   '), /Archive reason is required/);
  });
});
