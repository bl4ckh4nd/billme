import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSingleTenantScope,
  runMaintenanceSweep,
  type AuditEntry,
  type AuditEntryDraft,
} from '@billme/server-core';
import {
  createPostgresMaintenanceRepository,
  createPostgresTenantRepository,
  deleteServerSqliteImportRunsBefore,
} from './billing.js';
import { createPostgresPool } from './connection.js';
import { runDrizzleMigrations } from './migrations.js';

const scope = createSingleTenantScope('tenant-1', 'lite');

test('runMaintenanceSweep applies explicit retention policies and audits deletions', async () => {
  const calls: Array<{ kind: string; args: Record<string, unknown> }> = [];
  const auditEntries: AuditEntryDraft[] = [];

  const result = await runMaintenanceSweep(scope, {
    clock: {
      now: () => new Date('2026-06-15T12:00:00.000Z'),
      nowIso: () => '2026-06-15T12:00:00.000Z',
    },
    retentionRepo: {
      async deleteReleasedNumberReservations(_scope, args) {
        calls.push({ kind: 'released-number-reservations', args });
        return 2;
      },
      async deleteSqliteImportRuns(_scope, args) {
        calls.push({ kind: 'sqlite-import-runs', args });
        return 1;
      },
    },
    auditLog: {
      append(_scope, entry) {
        auditEntries.push(entry);
        return {
          sequence: 1,
          ...entry,
          prevHash: null,
          hash: 'maintenance-hash',
        } satisfies AuditEntry;
      },
    },
  });

  assert.equal(result.totalDeleted, 3);
  assert.deepEqual(calls, [
    {
      kind: 'released-number-reservations',
      args: { updatedBefore: '2026-03-17T12:00:00.000Z' },
    },
    {
      kind: 'sqlite-import-runs',
      args: {
        completedBefore: '2025-06-15T12:00:00.000Z',
        statuses: ['completed', 'failed'],
      },
    },
  ]);
  assert.equal(auditEntries.length, 1);
  assert.equal(auditEntries[0]?.action, 'maintenance.retention');
  assert.deepEqual(result.steps, [
    {
      key: 'released-number-reservations',
      retentionDays: 90,
      deleteBefore: '2026-03-17T12:00:00.000Z',
      deletedCount: 2,
    },
    {
      key: 'sqlite-import-runs',
      retentionDays: 365,
      deleteBefore: '2025-06-15T12:00:00.000Z',
      deletedCount: 1,
    },
  ]);
});

test('createPostgresMaintenanceRepository issues targeted delete statements', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const db = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  await runDrizzleMigrations(db);
  const tenantRepo = createPostgresTenantRepository(db);
  const now = new Date().toISOString();
  await tenantRepo.save({
    id: scope.tenantId,
    slug: scope.tenantId,
    displayName: 'Maintenance integration test',
    product: 'lite',
    deploymentMode: 'single-tenant',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  });
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  await db.query(
    `INSERT INTO number_reservations (id, tenant_id, kind, number, counter_value, status, document_id, created_at, updated_at)
     VALUES ($1, $2, 'invoice', $3, 1, 'released', NULL, $4, $5), ($6, $2, 'invoice', $7, 2, 'released', NULL, $4, $5)`,
    [`maint-a-${suffix}`, scope.tenantId, `R-${suffix}`, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z', `maint-b-${suffix}`, `R2-${suffix}`],
  );
  await db.query(
    `INSERT INTO sqlite_import_runs (id, tenant_id, source_path, source_product, source_sha256, status, details_json, started_at, completed_at)
     VALUES ($1, $2, '', 'lite', '', 'completed', '{}', $3, $3), ($4, $2, '', 'lite', '', 'failed', '{}', $3, $3)`,
    [`run-a-${suffix}`, scope.tenantId, '2024-01-01T00:00:00.000Z', `run-b-${suffix}`],
  );

  const repository = createPostgresMaintenanceRepository(db);
  const releasedDeleted = await repository.deleteReleasedNumberReservations(scope, {
    updatedBefore: '2026-03-17T12:00:00.000Z',
  });
  const importRunsDeleted = await repository.deleteSqliteImportRuns(scope, {
    completedBefore: '2025-06-15T12:00:00.000Z',
    statuses: ['completed', 'failed'],
  });

  assert.equal(releasedDeleted, 2);
  assert.equal(importRunsDeleted, 2);
  await db.query('DELETE FROM tenants WHERE id = $1', [scope.tenantId]);
  await db.end();
});

test('deleteServerSqliteImportRunsBefore skips empty status lists', async () => {
  const deleted = await deleteServerSqliteImportRunsBefore({} as never, 'tenant-1', '2025-06-15T00:00:00.000Z', []);
  assert.equal(deleted, 0);
});
