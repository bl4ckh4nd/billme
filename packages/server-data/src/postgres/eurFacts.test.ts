import assert from 'node:assert/strict';
import test from 'node:test';
import { getCatalogForYear } from '@billme/desktop-services/eurCatalog';
import { getEurAnnexCatalog } from '@billme/desktop-services/eur/annexCatalog';
import { createSingleTenantScope } from '@billme/server-core';
import { createPostgresPool } from './connection.js';
import { runDrizzleMigrations } from './migrations.js';
import { saveServerEurAnnexFact, saveServerEurCashFact } from './eurFacts.js';

const databaseUrl = process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL;

test('server EÜR cash idempotency includes classification and source provenance', { skip: !databaseUrl }, async () => {
  const pool = createPostgresPool(databaseUrl!);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenantId = `eur-fact-${suffix}`;
  const accountId = `eur-fact-account-${suffix}`;
  const transactionId = `eur-fact-transaction-${suffix}`;
  const now = new Date().toISOString();
  const scope = createSingleTenantScope(tenantId, 'pro');
  const incomeLines = getCatalogForYear(2025).filter((line) => line.kind === 'income');
  try {
    await runDrizzleMigrations(pool);
    await pool.query(`INSERT INTO tenants (id,slug,display_name,product,deployment_mode,status,created_at,updated_at) VALUES ($1,$1,'EÜR fact test','pro','single-tenant','active',$2,$2)`, [tenantId, now]);
    await pool.query(`INSERT INTO server_settings (tenant_id,settings_json,created_at,updated_at) VALUES ($1,$2,$3,$3)`, [tenantId, JSON.stringify({ businessReportingProfile: { jurisdiction: 'DE', legalForm: 'sole_proprietor', profitDetermination: 'eur', fiscalYearStart: '01-01' } }), now]);
    await pool.query(`INSERT INTO accounts (id,tenant_id,name,iban,balance,default_skr_account_number,type,color) VALUES ($1,$2,'EÜR fact bank','DE00000000000000000000','0','1200','bank','#000000')`, [accountId, tenantId]);
    await pool.query(`INSERT INTO bank_transactions (id,tenant_id,account_id,date,amount,type,counterparty,purpose,linked_invoice_id,status,created_at,updated_at) VALUES ($1,$2,$3,'2025-03-01',100,'income','Customer','Initial',NULL,'booked',$4,$4)`, [transactionId, tenantId, accountId, now]);

    const input = {
      sourceType: 'transaction' as const, sourceId: transactionId, taxYear: 2025, kind: 'income' as const, amountNet: 100,
      flowType: 'income' as const, eurLineId: incomeLines[0]!.id, idempotencyKey: 'cash-fact-1',
      mutation: { reason: 'EÜR fact test', actor: { type: 'user' as const, id: 'test-user' } },
    };
    const first = await saveServerEurCashFact(pool, scope, input);
    assert.equal((await saveServerEurCashFact(pool, scope, input)).id, first.id);
    await assert.rejects(() => saveServerEurCashFact(pool, scope, { ...input, eurLineId: incomeLines[1]?.id ?? input.eurLineId }), /EUR_FACT_IDEMPOTENCY_CONFLICT/);

    await pool.query(`UPDATE bank_transactions SET purpose='Changed source' WHERE tenant_id=$1 AND id=$2`, [tenantId, transactionId]);
    await assert.rejects(() => saveServerEurCashFact(pool, scope, input), /EUR_FACT_IDEMPOTENCY_CONFLICT/);
  } finally {
    await pool.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]).catch(() => undefined);
    await pool.end();
  }
});

test('server EÜR annex idempotency includes source identity and provenance', { skip: !databaseUrl }, async () => {
  const pool = createPostgresPool(databaseUrl!);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenantId = `eur-annex-${suffix}`;
  const now = new Date().toISOString();
  const scope = createSingleTenantScope(tenantId, 'pro');
  const line = getEurAnnexCatalog(2025, 'AVEÜR').lines.find((candidate) => candidate.kind === 'input')!;
  try {
    await runDrizzleMigrations(pool);
    await pool.query(`INSERT INTO tenants (id,slug,display_name,product,deployment_mode,status,created_at,updated_at) VALUES ($1,$1,'EÜR annex test','pro','single-tenant','active',$2,$2)`, [tenantId, now]);
    const input = {
      taxYear: 2025, annex: 'AVEÜR', lineId: line.id, amount: 10, sourceId: 'source-1', date: '2025-12-31', sourceSnapshotHash: 'a'.repeat(64), idempotencyKey: 'annex-fact-1',
      mutation: { reason: 'EÜR annex test', actor: { type: 'user' as const, id: 'test-user' } },
    };
    const first = await saveServerEurAnnexFact(pool, scope, input);
    assert.equal((await saveServerEurAnnexFact(pool, scope, input)).id, first.id);
    await assert.rejects(() => saveServerEurAnnexFact(pool, scope, { ...input, sourceId: 'source-2' }), /EUR_FACT_IDEMPOTENCY_CONFLICT/);
    await assert.rejects(() => saveServerEurAnnexFact(pool, scope, { ...input, sourceSnapshotHash: 'b'.repeat(64) }), /EUR_FACT_IDEMPOTENCY_CONFLICT/);
  } finally {
    await pool.query(`DELETE FROM tenants WHERE id=$1`, [tenantId]).catch(() => undefined);
    await pool.end();
  }
});
