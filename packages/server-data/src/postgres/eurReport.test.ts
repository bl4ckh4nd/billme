import assert from 'node:assert/strict';
import test from 'node:test';
import { createSingleTenantScope } from '@billme/server-core';
import { createPostgresPool } from './connection.js';
import { runDrizzleMigrations } from './migrations.js';
import { saveServerEurClassification, saveServerEurLine } from './proAccounting.js';
import { getServerEurReport } from './eurReport.js';

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
    await saveServerEurLine(pool, { id: `income-${suffix}`, taxYear: 2025, kennziffer: '112', providerPath: 'income', label: 'Income', kind: 'income', exportable: true, sortOrder: 1, sourceVersion: 'BMF-2025-2025-08-29', createdAt: now, updatedAt: now });
    await saveServerEurLine(pool, { id: `expense-${suffix}`, taxYear: 2025, kennziffer: '112', providerPath: 'expenses', label: 'Expense', kind: 'expense', exportable: true, sortOrder: 2, sourceVersion: 'BMF-2025-2025-08-29', createdAt: now, updatedAt: now });
    await saveServerEurLine(pool, { id: `profit-${suffix}`, taxYear: 2025, kennziffer: '290', providerPath: 'income', label: 'Profit', kind: 'computed', exportable: true, sortOrder: 3, computedTermsJson: JSON.stringify([{ id: `income-${suffix}`, sign: 1 }, { id: `expense-${suffix}`, sign: -1 }]), sourceVersion: 'BMF-2025-2025-08-29', createdAt: now, updatedAt: now });
    await saveServerEurClassification(pool, { id: `classification-income-${suffix}`, tenantId, sourceType: 'transaction', sourceId: `bank-income-${suffix}`, taxYear: 2025, eurLineId: `income-${suffix}`, excluded: false, vatMode: 'default', vatRate: 19, updatedAt: now });
    await saveServerEurClassification(pool, { id: `classification-expense-${suffix}`, tenantId, sourceType: 'transaction', sourceId: `bank-expense-${suffix}`, taxYear: 2025, eurLineId: `expense-${suffix}`, excluded: false, vatMode: 'default', vatRate: 19, updatedAt: now });
    const report = await getServerEurReport(pool, scope);
    assert.equal(report.summary.incomeTotal, 100);
    assert.equal(report.summary.expenseTotal, 50);
    assert.equal(report.summary.surplus, 50);
    assert.equal(report.rows.find((row) => row.id === `profit-${suffix}`)?.total, 50);
    assert.equal(report.rows.find((row) => row.id === `income-${suffix}`)?.providerPath, 'income');
    assert.equal(report.rows.find((row) => row.id === `expense-${suffix}`)?.providerPath, 'expenses');
    assert.equal(report.unclassifiedCount, 0);
    assert.equal(report.catalog.delivery, 'print-form-only');
  } finally {
    await pool.query('DELETE FROM tenants WHERE id=$1', [tenantId]);
    await pool.end();
  }
});
