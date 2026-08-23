import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSingleTenantScope } from '@billme/server-core';
import { createPostgresAuditLogPort, PgliteServerDatabase } from '@billme/server-data';
import { buildServerApi } from './app.js';

const tenantId = 'tax-export-tenant';
const otherTenantId = 'tax-export-other-tenant';
const localToken = 'tax-export-local-token';

type ExportArtifact = {
  files: Array<{ name: string; content: string; rowCount?: number }>;
  includeDocuments: boolean;
};

test('embedded Pro tax audit export is authenticated, tenant scoped, and honors includeDocuments', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-tax-audit-export-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'pro',
    logger: false,
    sessionSecret: 'tax-export-server-api-test-secret-32-chars',
    localAuth: {
      accessToken: localToken,
      tenantId,
      userId: 'tax-export-user',
      email: 'tax-export@example.test',
      fullName: 'Tax Export Owner',
    },
  });

  try {
    const now = new Date().toISOString();
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at)
       VALUES ($1, $2, $3, 'pro', $4, $4), ($5, $6, $7, 'pro', $4, $4)`,
      [tenantId, 'tax-export', 'Tax Export', now, otherTenantId, 'tax-export-other', 'Other Tenant'],
    );
    const auditLog = createPostgresAuditLogPort(database);
    await auditLog.append(createSingleTenantScope(tenantId, 'pro'), {
      occurredAt: '2026-01-05T10:00:00.000Z',
      action: 'invoice.created',
      reason: 'current tenant',
      actor: { type: 'user', id: 'tax-export-user', displayName: 'Tax Export Owner' },
      subject: { entityType: 'invoice', entityId: 'invoice-current', tenantId },
      change: { before: null, after: { number: 'RE-CURRENT' } },
    });
    await auditLog.append(createSingleTenantScope(otherTenantId, 'pro'), {
      occurredAt: '2026-01-05T10:01:00.000Z',
      action: 'invoice.created',
      reason: 'foreign tenant',
      actor: { type: 'user', id: 'other-user', displayName: 'Other Owner' },
      subject: { entityType: 'invoice', entityId: 'invoice-foreign', tenantId: otherTenantId },
      change: { before: null, after: { number: 'RE-FOREIGN' } },
    });
    await database.query(
      `INSERT INTO invoices
        (id, tenant_id, number, client, client_email, date, due_date, amount, status, created_at, updated_at)
       VALUES ($1, $2, 'RE-CURRENT', 'Current Client', 'current@example.test', '2026-01-05', '2026-01-19', 119, 'open', $3, $3),
              ($4, $5, 'RE-FOREIGN', 'Foreign Client', 'foreign@example.test', '2026-01-05', '2026-01-19', 119, 'open', $3, $3)`,
      ['invoice-current', tenantId, now, 'invoice-foreign', otherTenantId],
    );
    await app.ready();

    const url = '/api/v1/pro/tax/audit-export-package';
    assert.equal((await app.inject({ method: 'POST', url, payload: {} })).statusCode, 401);

    const headers = { 'x-billme-local-token': localToken };
    const withoutDocuments = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { from: '2026-01-01', to: '2026-01-31', includeDocuments: false },
    });
    assert.equal(withoutDocuments.statusCode, 200, withoutDocuments.body);
    const withoutDocumentsArtifact = withoutDocuments.json() as ExportArtifact;
    assert.equal(withoutDocumentsArtifact.includeDocuments, false);
    const auditCsv = withoutDocumentsArtifact.files.find((file) => file.name === 'audit-log.csv');
    assert.ok(auditCsv);
    assert.match(auditCsv.content, /RE-CURRENT/);
    assert.doesNotMatch(auditCsv.content, /RE-FOREIGN/);
    assert.equal(withoutDocumentsArtifact.files.some((file) => file.name === 'invoices.jsonl'), false);

    const withDocuments = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: { includeDocuments: true },
    });
    assert.equal(withDocuments.statusCode, 200, withDocuments.body);
    const withDocumentsArtifact = withDocuments.json() as ExportArtifact;
    assert.equal(withDocumentsArtifact.includeDocuments, true);
    const invoices = withDocumentsArtifact.files.find((file) => file.name === 'invoices.jsonl');
    assert.ok(invoices);
    assert.match(invoices.content, /RE-CURRENT/);
    assert.doesNotMatch(invoices.content, /RE-FOREIGN/);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('embedded Pro tax audit export rejects roles without accounting export access', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-tax-audit-export-role-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'pro',
    logger: false,
    sessionSecret: 'tax-export-role-server-api-test-secret-32-chars',
    localAuth: {
      accessToken: 'tax-export-reviewer-token',
      tenantId: 'tax-export-reviewer-tenant',
      userId: 'tax-export-reviewer',
      email: 'reviewer@example.test',
      fullName: 'Reviewer',
      role: 'viewer',
    },
  });

  try {
    await app.ready();
    const result = await app.inject({
      method: 'POST',
      url: '/api/v1/pro/tax/audit-export-package',
      headers: { 'x-billme-local-token': 'tax-export-reviewer-token' },
      payload: {},
    });
    assert.equal(result.statusCode, 403);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
