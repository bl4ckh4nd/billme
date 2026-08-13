import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createSingleTenantScope } from '@billme/server-core';
import { createPostgresPool, type PostgresQueryable } from './connection.js';
import { runDrizzleMigrations } from './migrations.js';
import { createPostgresProAccountingRepository } from './proAccountingRepository.js';

const databaseUrl = process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

test('accounting source-run migration is tenant-scoped, immutable, and replay-keyed', async () => {
  const sql = await readFile(new URL('../../drizzle/0022_server_data_accounting_source_runs.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS accounting_source_runs/);
  assert.match(sql, /UNIQUE \(tenant_id, source_type, source_id, source_revision\)/);
  assert.match(sql, /UNIQUE \(tenant_id, idempotency_key\)/);
  assert.match(sql, /accounting_source_runs_immutable/);
  assert.match(sql, /journal_entry_id TEXT REFERENCES journal_entries\(id\)/);
});

test('closing source facts persist once, replay deterministically, and remain tenant-isolated', { skip: !databaseUrl }, async () => {
  const pool = createPostgresPool(databaseUrl!);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenantA = `source-run-a-${suffix}`;
  const tenantB = `source-run-b-${suffix}`;
  const now = new Date().toISOString();
  try {
    await runDrizzleMigrations(pool);
    for (const tenantId of [tenantA, tenantB]) {
      await pool.query(`INSERT INTO tenants (id,slug,display_name,product,deployment_mode,status,created_at,updated_at) VALUES ($1,$1,$2,'pro','single-tenant','active',$3,$3)`, [tenantId, tenantId, now]);
      await pool.query(`INSERT INTO accounting_policies (tenant_id,active_chart,vat_method,period_policy,updated_at) VALUES ($1,'SKR03','soll','calendar_month',$2)`, [tenantId, now]);
    }
    await pool.query(`INSERT INTO ledger_accounts (id,chart,account_number,name,source,created_at,updated_at) VALUES ($1,'SKR03','1000','Cash','test',$2,$2),($3,'SKR03','2000','Equity','test',$2,$2) ON CONFLICT DO NOTHING`, [`source-account-a-${suffix}`, now, `source-account-b-${suffix}`]);
    const scopeA = createSingleTenantScope(tenantA, 'pro');
    const scopeB = createSingleTenantScope(tenantB, 'pro');
    const repository = createPostgresProAccountingRepository(pool);
    const input = {
      command: 'source_fact' as const,
      sourceId: `fact-${suffix}`,
      sourceRevision: 'v1',
      idempotencyKey: `fact-${suffix}:v1`,
      reason: 'Closing source fact reviewed',
      input: {
        sourceType: 'standalone_source' as const,
        sourceId: `fact-${suffix}`,
        sourceRevision: 'v1',
        effectiveDate: '2025-01-31',
        postingDate: '2025-01-31',
        period: '2025-01',
        fiscalYear: 2025,
        currency: 'EUR',
        bookingText: 'Test source fact',
        lines: [
          { accountNumber: '1000', debitAmount: 10, creditAmount: 0 },
          { accountNumber: '2000', debitAmount: 0, creditAmount: 10 },
        ],
      },
    };
    const first = await repository.runClosingCommand(scopeA, input);
    const replay = await repository.runClosingCommand(scopeA, input);
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.equal((await repository.listAccountingSourceRuns(scopeB)).length, 0);
    await assert.rejects(() => repository.runClosingCommand(scopeA, { ...input, input: { ...input.input, lines: [{ accountNumber: '1000', debitAmount: 20, creditAmount: 0 }, { accountNumber: '2000', debitAmount: 0, creditAmount: 20 }] } }), /ACCOUNTING_SOURCE_RUN_CONFLICT/);
    assert.equal((await repository.listAccountingSourceRuns(scopeA)).length, 1);
  } finally {
    await pool.query(`DELETE FROM tenants WHERE id = ANY($1::text[])`, [[tenantA, tenantB]]).catch(() => undefined);
    await pool.end();
  }
});

test('source-fact validation rolls back invalid accounts and rejects incomplete tax evidence', { skip: !databaseUrl }, async () => {
  const pool = createPostgresPool(databaseUrl!);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenantId = `source-run-invalid-${suffix}`;
  const now = new Date().toISOString();
  try {
    await runDrizzleMigrations(pool);
    await pool.query(`INSERT INTO tenants (id,slug,display_name,product,deployment_mode,status,created_at,updated_at) VALUES ($1,$1,$2,'pro','single-tenant','active',$3,$3)`, [tenantId, tenantId, now]);
    await pool.query(`INSERT INTO accounting_policies (tenant_id,active_chart,vat_method,period_policy,updated_at) VALUES ($1,'SKR03','soll','calendar_month',$2)`, [tenantId, now]);
    await pool.query(`INSERT INTO ledger_accounts (id,chart,account_number,name,source,created_at,updated_at) VALUES ($1,'SKR03','1000','Cash','test',$2,$2),($3,'SKR03','2000','Equity','test',$2,$2) ON CONFLICT DO NOTHING`, [`source-invalid-a-${suffix}`, now, `source-invalid-b-${suffix}`]);
    const repository = createPostgresProAccountingRepository(pool);
    const scope = createSingleTenantScope(tenantId, 'pro');
    const invalid = {
      command: 'source_fact' as const,
      sourceId: `invalid-${suffix}`,
      sourceRevision: 'v1',
      idempotencyKey: `invalid-${suffix}:v1`,
      reason: 'Invalid account test',
      input: {
        sourceType: 'standalone_source' as const, sourceId: `invalid-${suffix}`, sourceRevision: 'v1', effectiveDate: '2025-01-31', postingDate: '2025-01-31', period: '2025-01', fiscalYear: 2025, currency: 'EUR', bookingText: 'Invalid',
        lines: [{ accountNumber: '9999', debitAmount: 10, creditAmount: 0 }, { accountNumber: '2000', debitAmount: 0, creditAmount: 10 }],
      },
    };
    await assert.rejects(() => repository.runClosingCommand(scope, invalid), /UNKNOWN_ACCOUNT/);
    assert.equal((await repository.listAccountingSourceRuns(scope)).length, 0);
    await assert.rejects(() => repository.prepareTaxExport(scope, {
      kind: 'zm', period: '2025-01', reason: 'Evidence test', entries: [{ postingDate: '2025-01-31', status: 'posted', lines: [{ taxCaseKey: 'EU_B2B_SERVICE_RC', netAmount: 100 }] }],
    }), /MISSING_EVIDENCE/);
  } finally {
    await pool.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]).catch(() => undefined);
    await pool.end();
  }
});

test('repository source-run methods remain callable through the query-only seam', async () => {
  const calls: string[] = [];
  const db = { query: async (text: string) => { calls.push(text); return { rows: [] }; } } as unknown as PostgresQueryable;
  const repository = createPostgresProAccountingRepository(db);
  assert.deepEqual(await repository.listAccountingSourceRuns(createSingleTenantScope('query-only', 'pro')), []);
  assert.equal(calls.length, 1);
});
