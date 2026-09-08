import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createSingleTenantScope } from '@billme/server-core';
import { createPostgresPool, createPostgresServerDatabase, createPostgresBillingDependencies } from '@billme/server-data';
import { DEFAULT_SETTINGS } from '@billme/desktop-services/mockData';
import { ServerWorkerRuntime, toRecurringWorkerTaskResult } from './runtime.js';
import { createWorkerLogger } from './logger.js';

test('scheduled recurring jobs complete with the number of profile errors', () => {
  const result = toRecurringWorkerTaskResult({
    generated: 1,
    deactivated: 0,
    errors: [{ profileName: 'Altes Abo', error: 'Ungültiges Abo-Profil' }],
  });

  assert.deepEqual(result, {
    status: 'completed',
    message: 'Recurring run finished',
    details: { generated: 1, deactivated: 0, errors: 1 },
  });
});

const testUrl = process.env.ARCHITECTURE_TEST_DATABASE_URL;
test('concurrent worker portal jobs persist one complete decision and one audit', { skip: !testUrl }, async (t) => {
  if (!testUrl || !new URL(testUrl).pathname.endsWith('/billme_architecture_test')) throw new Error('Isolated architecture test database required');
  const database = createPostgresServerDatabase(createPostgresPool(testUrl));
  await database.migrate();
  const tenantId = `worker-architecture-${randomUUID()}`;
  const scope = createSingleTenantScope(tenantId, 'lite');
  const now = new Date().toISOString();
  await database.query('INSERT INTO tenants (id,slug,display_name,product,created_at,updated_at) VALUES ($1,$1,$1,\'lite\',$2,$2)', [tenantId, now]);
  await database.query('INSERT INTO server_settings (tenant_id,settings_json,created_at,updated_at) VALUES ($1,$2,$3,$3)', [tenantId, JSON.stringify({ ...DEFAULT_SETTINGS, portal: { baseUrl: 'https://worker-portal.example.test' } }), now]);
  const { offerRepo, auditLog } = createPostgresBillingDependencies(database);
  const offerId = randomUUID();
  await offerRepo.save(scope, { kind: 'offer', tenantId, id: offerId, number: 'AN-1', client: 'Buyer', clientEmail: 'buyer@example.test', date: '2026-09-07', validUntil: '2026-10-07', amount: 0, status: 'open', taxMode: 'standard_vat', items: [], history: [], share: { token: 'worker-test-publication-token' } });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ decision: { decision: 'accepted', decidedAt: now, acceptedName: 'Buyer', acceptedEmail: 'buyer@example.test', decisionTextVersion: 'v1', acceptedUserAgent: 'Worker regression' } }), { headers: { 'content-type': 'application/json' } });
  const worker = new ServerWorkerRuntime({ databaseUrl: testUrl, tenantId }, createWorkerLogger('error'));
  t.after(async () => { globalThis.fetch = originalFetch; await worker.close(); await database.close(); });
  await worker.init();
  const results = await Promise.all([worker.runPortalSyncJob(), worker.runPortalSyncJob()]);
  assert.equal(results.reduce((sum, result) => sum + Number(result.details?.updated), 0), 1);
  assert.ok(results.every((result) => result.status === 'completed'));
  assert.equal((await offerRepo.getById(scope, offerId))?.share?.acceptedUserAgent, 'Worker regression');
  assert.equal((await auditLog.listBySubject(scope, { entityType: 'offer', entityId: offerId })).length, 1);
});
