import assert from 'node:assert/strict';
import test from 'node:test';
import { createSingleTenantScope } from '@billme/server-core';
import { createPostgresPool } from './connection.js';
import { runDrizzleMigrations } from './migrations.js';
import { saveServerEurClassification } from './proAccounting.js';
import { getServerEurReport } from './eurReport.js';
import { createPostgresProAccountingRepository } from './proAccountingRepository.js';

test('real Postgres persists native EÜR provenance/classification and calculates signed VAT cash rows', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const pool = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenantId = `eur-native-${suffix}`;
  const now = new Date().toISOString();
  const scope = createSingleTenantScope(tenantId, 'pro');
  try {
    await runDrizzleMigrations(pool);
    await pool.query(`INSERT INTO tenants (id,slug,display_name,product,deployment_mode,status,created_at,updated_at) VALUES ($1,$1,'Native EÜR test','pro','single-tenant','active',$2,$2)`, [tenantId, now]);
    await pool.query(`INSERT INTO server_settings (tenant_id,settings_json,created_at,updated_at) VALUES ($1,$2,$3,$3)`, [tenantId, JSON.stringify({ legal: { smallBusinessRule: false }, businessReportingProfile: { jurisdiction: 'DE', legalForm: 'sole_proprietor', profitDetermination: 'eur', fiscalYearStart: '01-01', vatMethod: 'soll' } }), now]);
    await pool.query(`INSERT INTO accounts (id,tenant_id,name,iban,balance,default_skr_account_number,type,color) VALUES ($1,$2,'Native bank','DE00000000000000000000','0','1200','bank','#000000')`, [`account-${suffix}`, tenantId]);
    await pool.query(`INSERT INTO bank_transactions (id,tenant_id,account_id,date,amount,type,counterparty,purpose,status,created_at,updated_at) VALUES ($1,$2,$3,'2025-03-01',119,'income','Customer','Invoice paid','booked',$4,$4),($5,$2,$3,'2025-03-02',-59.5,'expense','Hosting','Hosting paid','booked',$4,$4)`, [`bank-income-${suffix}`, tenantId, `account-${suffix}`, now, `bank-expense-${suffix}`]);
    await saveServerEurClassification(pool, { id: `classification-income-${suffix}`, tenantId, sourceType: 'transaction', sourceId: `bank-income-${suffix}`, taxYear: 2025, eurLineId: 'E2025_KZ112', excluded: false, vatMode: 'default', vatRate: 19, updatedAt: now });
    await saveServerEurClassification(pool, { id: `classification-expense-${suffix}`, tenantId, sourceType: 'transaction', sourceId: `bank-expense-${suffix}`, taxYear: 2025, eurLineId: 'E2025_KZ280', excluded: false, vatMode: 'default', vatRate: 19, updatedAt: now });
    const report = await getServerEurReport(pool, scope);
    assert.equal(report.summary.incomeTotal, 100);
    assert.equal(report.summary.expenseTotal, 50);
    assert.equal(report.summary.surplus, 50);
    assert.equal(report.rows.find((row) => row.id === 'E2025_KZ290')?.total, 50);
    assert.equal(report.rows.find((row) => row.id === 'E2025_KZ112')?.providerPath, 'main');
    assert.equal(report.rows.find((row) => row.id === 'E2025_KZ280')?.providerPath, 'main');
    assert.equal(report.unclassifiedCount, 0);
    assert.equal(report.catalog.delivery, 'print-form-only');

    const repository = createPostgresProAccountingRepository(pool);
    await assert.rejects(() => repository.upsertEurClassification(scope, {
      sourceType: 'transaction', sourceId: `bank-income-${suffix}`, taxYear: 2025, eurLineId: 'E2025_KZ112', excluded: false, vatMode: 'none',
      mutation: { reason: '   ', actor: { type: 'user', id: 'test-user', displayName: 'EÜR test' } },
    }), /ACCOUNTING_AUDIT_REASON_REQUIRED/);
    await assert.rejects(() => repository.upsertEurClassification(scope, {
      sourceType: 'transaction', sourceId: `ghost-${suffix}`, taxYear: 2025, eurLineId: 'E2025_KZ112', excluded: false, vatMode: 'none',
      mutation: { reason: 'Ghost prüfen', actor: { type: 'user', id: 'test-user', displayName: 'EÜR test' } },
    }), /EUR_SOURCE_NOT_FOUND/);
    await assert.rejects(() => repository.upsertEurClassification(scope, {
      sourceType: 'transaction', sourceId: `bank-income-${suffix}`, taxYear: 2025, eurLineId: 'E2025_KZ280', excluded: false, vatMode: 'none',
      mutation: { reason: 'Fluss prüfen', actor: { type: 'user', id: 'test-user', displayName: 'EÜR test' } },
    }), /EUR_LINE_FLOW_MISMATCH/);
    const saved = await repository.upsertEurClassification(scope, {
      sourceType: 'transaction', sourceId: `bank-income-${suffix}`, taxYear: 2025, eurLineId: 'E2025_KZ112',
      excluded: false, vatMode: 'default', vatRate: 7, note: 'Nach Belegprüfung',
      mutation: { reason: 'EÜR-Klassifikation geprüft', actor: { type: 'user', id: 'test-user', displayName: 'EÜR test' } },
    });
    assert.equal(saved.eurLineId, 'E2025_KZ112');
    assert.equal(saved.vatRate, 7);
    const items = await repository.listEurCashItems(scope);
    assert.equal(items.find((item) => item.sourceId === `bank-income-${suffix}`)?.classification?.eurLineId, 'E2025_KZ112');
    const auditRows = await pool.query(`SELECT reason FROM audit_log WHERE tenant_id=$1 AND entity_type='eur_classification' ORDER BY sequence DESC LIMIT 1`, [tenantId]);
    assert.equal(auditRows.rows[0]?.reason, 'EÜR-Klassifikation geprüft');
  } finally {
    await pool.end();
  }
});
