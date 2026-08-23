import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PgliteServerDatabase } from '@billme/server-data';
import { buildServerApi } from './app.js';

test('embedded project routes are tenant scoped and preserve client/project data', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-project-routes-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const token = 'project-routes-local-token';
  const tenantId = 'project-routes-tenant';
  const otherTenantId = 'project-routes-other-tenant';
  const now = new Date().toISOString();
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'pro',
    logger: false,
    sessionSecret: 'project-routes-session-secret-32-chars',
    localAuth: {
      accessToken: token,
      tenantId,
      userId: 'project-routes-user',
      email: 'projects@example.test',
      fullName: 'Projects Owner',
    },
  });

  try {
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at)
       VALUES ($1, $2, 'Current', 'pro', $3, $3), ($4, $5, 'Other', 'pro', $3, $3)`,
      [tenantId, tenantId, now, otherTenantId, otherTenantId],
    );
    await database.query(
      `INSERT INTO clients
        (id, tenant_id, company, contact_person, email, phone, address, status, tags_json, notes, projects_json, created_at, updated_at)
       VALUES
        ('project-client-current', $1, 'Current Client', '', '', '', '', 'active', '[]', 'keep', $3, $4, $4),
        ('project-client-other', $2, 'Other Client', '', '', '', '', 'active', '[]', '', '[]', $4, $4)`,
      [tenantId, otherTenantId, JSON.stringify([{ id: 'project-current', name: 'Current Project', status: 'active', budget: 100, startDate: '2026-01-01', clientSpecificMetadata: 'keep' }]), now],
    );
    await app.ready();
    const headers = { 'x-billme-local-token': token };

    const listed = await app.inject({ method: 'GET', url: '/api/v1/pro/projects', headers });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(listed.json().map((project: { id: string }) => project.id), ['project-current']);

    const saved = await app.inject({
      method: 'POST',
      url: '/api/v1/pro/projects',
      headers,
      payload: {
        reason: 'Projekt aktualisiert',
        project: { id: 'project-current', clientId: 'project-client-current', name: 'Updated Project', status: 'active', budget: 250, startDate: '2026-01-01' },
      },
    });
    assert.equal(saved.statusCode, 200, saved.body);
    assert.equal(saved.json().name, 'Updated Project');
    assert.equal(saved.json().code, 'PRJ-2026-001');

    const foreign = await app.inject({ method: 'GET', url: '/api/v1/pro/projects/project-foreign', headers });
    assert.equal(foreign.statusCode, 200, foreign.body);
    assert.equal(foreign.json(), null);

    const archived = await app.inject({
      method: 'POST',
      url: '/api/v1/pro/projects/project-current/archive',
      headers,
      payload: { reason: 'Projekt abgeschlossen' },
    });
    assert.equal(archived.statusCode, 200, archived.body);
    assert.equal(archived.json().archivedAt !== undefined, true);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/pro/projects', headers })).json(), []);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
