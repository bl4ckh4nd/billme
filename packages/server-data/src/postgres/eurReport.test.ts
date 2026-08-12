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

test('Lite EÜR aggregates invoice payments_json by invoice and keeps linked banks out of the cash basis', { skip: !(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL) }, async () => {
  const pool = createPostgresPool(process.env.BILLME_TEST_DATABASE_URL ?? process.env.DATABASE_URL!);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const tenantId = `eur-lite-${suffix}`;
  const now = new Date().toISOString();
  const scope = createSingleTenantScope(tenantId, 'lite');
  const invoiceId = `invoice-${suffix}`;
  try {
    await runDrizzleMigrations(pool);
    await pool.query(`INSERT INTO tenants (id,slug,display_name,product,deployment_mode,status,created_at,updated_at) VALUES ($1,$1,'Lite EÜR test','lite','single-tenant','active',$2,$2)`, [tenantId, now]);
    await pool.query(`INSERT INTO server_settings (tenant_id,settings_json,created_at,updated_at) VALUES ($1,$2,$3,$3)`, [tenantId, JSON.stringify({ legal: { smallBusinessRule: true }, businessReportingProfile: { jurisdiction: 'DE', legalForm: 'sole_proprietor', profitDetermination: 'eur', fiscalYearStart: '01-01', vatMethod: 'ist' } }), now]);
    await pool.query(`INSERT INTO accounts (id,tenant_id,name,iban,balance,default_skr_account_number,type,color) VALUES ($1,$2,'Lite bank','DE00000000000000000000','0','1200','bank','#000000')`, [`account-${suffix}`, tenantId]);
    await pool.query(`INSERT INTO invoices (id,tenant_id,number,client,client_email,date,due_date,amount,status,dunning_level,items_json,payments_json,history_json,tax_snapshot_json,created_at,updated_at,accounting_status) VALUES ($1,$2,'RE-LITE-1','Lite customer','test@example.test','2025-03-01','2025-03-31',119,'open',0,'[]',$3,'[]',$4,$5,$5,'unposted')`, [invoiceId, tenantId, JSON.stringify([{ id: 'payment-1', date: '2025-03-01', amount: 59.5, method: 'bank' }, { id: 'payment-2', date: '2025-03-15', amount: 59.5, method: 'bank' }]), JSON.stringify({ grossAmount: 119, netAmount: 119, taxAmount: 0 }), now]);
    await pool.query(`INSERT INTO bank_transactions (id,tenant_id,account_id,date,amount,type,counterparty,purpose,linked_invoice_id,status,created_at,updated_at) VALUES ($1,$2,$3,'2025-03-20',119,'income','Lite customer','linked payment',$4,'booked',$5,$5),($6,$2,$3,'2025-03-21',20,'expense','Hosting','unlinked expense',NULL,'booked',$5,$5)`, [`linked-bank-${suffix}`, tenantId, `account-${suffix}`, invoiceId, now, `unlinked-bank-${suffix}`]);
    await saveServerEurClassification(pool, { id: `classification-invoice-${suffix}`, tenantId, sourceType: 'invoice', sourceId: invoiceId, taxYear: 2025, eurLineId: 'E2025_KZ112', excluded: false, vatMode: 'none', updatedAt: now });
    await saveServerEurClassification(pool, { id: `classification-bank-${suffix}`, tenantId, sourceType: 'transaction', sourceId: `unlinked-bank-${suffix}`, taxYear: 2025, eurLineId: 'E2025_KZ280', excluded: false, vatMode: 'none', updatedAt: now });
    const repository = createPostgresProAccountingRepository(pool);
    const items = await repository.listEurCashItems(scope, { product: 'lite' });
    assert.equal(items.length, 2);
    assert.equal(items.find((item) => item.sourceType === 'invoice')?.amountGross, 119);
    assert.equal(items.some((item) => item.sourceId === `linked-bank-${suffix}`), false);
    const saved = await repository.upsertEurClassification(scope, {
      product: 'lite', sourceType: 'invoice', sourceId: invoiceId, taxYear: 2025, eurLineId: 'E2025_KZ112', excluded: false, vatMode: 'none',
      mutation: { reason: 'Lite EÜR Beleg geprüft', actor: { type: 'user', id: 'lite-user', displayName: 'Lite EÜR' } },
    });
    assert.equal(saved.sourceId, invoiceId);
    assert.equal((await repository.listEurCashItems(scope, { product: 'lite' })).find((item) => item.sourceId === invoiceId)?.classification?.eurLineId, 'E2025_KZ112');
    assert.equal((await pool.query(`SELECT reason FROM audit_log WHERE tenant_id=$1 AND entity_type='eur_classification' ORDER BY sequence DESC LIMIT 1`, [tenantId])).rows[0]?.reason, 'Lite EÜR Beleg geprüft');
    const report = await repository.getEurReport(scope, { product: 'lite' });
    assert.equal(report.summary.incomeTotal, 119);
    assert.equal(report.summary.expenseTotal, 20);
    assert.equal(report.summary.surplus, 99);
  } finally {
    await pool.end();
  }
});
