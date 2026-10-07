import assert from 'node:assert/strict';
import test from 'node:test';
import { createPostgresPool } from './connection.js';
import { runDrizzleMigrations } from './migrations.js';
import {
  applyServerModeLiteTenantSeed,
  applyServerModeProTenantSeed,
  buildServerModeLiteTenantSeed,
  buildServerModeProTenantSeed,
} from './e2eSeeding.js';

test('applyServerModeLiteTenantSeed persists settings and billing fixtures', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const db = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  await runDrizzleMigrations(db);
  const seed = buildServerModeLiteTenantSeed({
    tenantId: `tenant-lite-${Date.now()}`,
    namespace: `lite-seed-${Date.now()}`,
    now: '2026-03-20T09:00:00.000Z',
  });
  await applyServerModeLiteTenantSeed(db, seed);
  const counts = await db.query<{ clients: string; invoices: string; offers: string; recurring: string }>(
    `SELECT
       (SELECT COUNT(*) FROM clients WHERE tenant_id = $1) AS clients,
       (SELECT COUNT(*) FROM invoices WHERE tenant_id = $1) AS invoices,
       (SELECT COUNT(*) FROM offers WHERE tenant_id = $1) AS offers,
       (SELECT COUNT(*) FROM recurring_profiles WHERE tenant_id = $1) AS recurring`,
    [seed.clients[0]?.tenantId],
  );
  assert.deepEqual(counts.rows[0], { clients: '2', invoices: '2', offers: '1', recurring: '1' });
  await db.end();
});

test('applyServerModeProTenantSeed persists accounting fixtures after billing data', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const db = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  await runDrizzleMigrations(db);
  const seed = buildServerModeProTenantSeed({
    tenantId: `tenant-pro-${Date.now()}`,
    namespace: `pro-seed-${Date.now()}`,
    now: '2026-03-20T09:00:00.000Z',
  });
  await applyServerModeProTenantSeed(db, seed);
  const counts = await db.query<{ ledger: string; articles: string; accounts: string; templates: string; workflow: string }>(
    `SELECT
       (SELECT COUNT(*) FROM ledger_accounts WHERE chart = 'SKR03' AND account_number IN ('1200', '3125', '8400', '1776', '1576')) AS ledger,
       (SELECT COUNT(*) FROM articles WHERE tenant_id = $1) AS articles,
       (SELECT COUNT(*) FROM accounts WHERE tenant_id = $1) AS accounts,
       (SELECT COUNT(*) FROM templates WHERE tenant_id = $1) AS templates,
       (SELECT COUNT(*) FROM pro_workflow_entries WHERE tenant_id = $1) AS workflow`,
    [seed.tenantId],
  );
  assert.deepEqual(counts.rows[0], { ledger: '5', articles: '2', accounts: '1', templates: '2', workflow: '1' });
  await db.end();
});
