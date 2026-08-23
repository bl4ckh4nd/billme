import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PgliteServerDatabase } from '@billme/server-data';
import { buildServerApi } from './app.js';

const token = 'audit-eur-local-token';
const tenantId = 'audit-eur-tenant';
const headers = { 'x-billme-local-token': token };
const profileSettings = {
  businessReportingProfile: {
    jurisdiction: 'DE', legalForm: 'sole_proprietor', profitDetermination: 'eur', fiscalYearStart: '01-01',
  },
  legal: { smallBusinessRule: true },
};

const openApp = async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-audit-eur-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'pro',
    logger: false,
    sessionSecret: 'audit-eur-server-secret-32-characters',
    localAuth: {
      accessToken: token,
      tenantId,
      userId: 'audit-eur-user',
      email: 'audit-eur@example.test',
      fullName: 'Audit EÜR User',
    },
  });
  await database.query(`
    INSERT INTO tenants (id,slug,display_name,product,created_at,updated_at)
    VALUES ($1,$2,$3,'pro',$4,$4)`, [tenantId, tenantId, 'Audit EÜR Tenant', new Date().toISOString()]);
  await database.query(`
    INSERT INTO server_settings (tenant_id,settings_json,created_at,updated_at)
    VALUES ($1,$2,$3,$3)`, [tenantId, JSON.stringify(profileSettings), new Date().toISOString()]);
  await database.query(`
    INSERT INTO eur_lines (id,tax_year,kennziffer,provider_path,label,kind,exportable,sort_order,source_version,created_at,updated_at)
    VALUES ('eur-line-test',2025,'101','main','Test Einnahmen','income',TRUE,1,'test',$1,$1)`, [new Date().toISOString()]);
  await app.ready();
  return { app, database, dataDir };
};

test('embedded Pro audit and EÜR rules are tenant-scoped, audited, and exportable', async () => {
  const { app, database, dataDir } = await openApp();
  try {
    const emptyVerification = await app.inject({ method: 'GET', url: '/api/v1/pro/audit/verify', headers });
    assert.equal(emptyVerification.statusCode, 200, emptyVerification.body);
    assert.deepEqual(emptyVerification.json(), { ok: true, errors: [], count: 0, headHash: null });

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/pro/accounting/reports/eur/rules',
      headers,
      payload: {
        id: 'rule-local', taxYear: 2025, priority: 10, field: 'purpose', operator: 'contains',
        value: 'Hosting', targetEurLineId: 'eur-line-test', active: true, reason: 'Regel für Hosting',
      },
    });
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(created.json().id, 'rule-local');

    await database.query(`
      INSERT INTO tenants (id,slug,display_name,product,created_at,updated_at)
      VALUES ('other-tenant','other-tenant','Other','pro',$1,$1)`, [new Date().toISOString()]);
    await database.query(`
      INSERT INTO eur_rules (id,tenant_id,tax_year,priority,field,operator,value,target_eur_line_id,active,created_at,updated_at)
      VALUES ('rule-other','other-tenant',2025,1,'purpose','contains','Other','eur-line-test',TRUE,$1,$1)`, [new Date().toISOString()]);

    const listed = await app.inject({ method: 'GET', url: '/api/v1/pro/accounting/reports/eur/rules?taxYear=2025', headers });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(listed.json().map((rule: { id: string }) => rule.id), ['rule-local']);

    const verification = await app.inject({ method: 'GET', url: '/api/v1/pro/audit/verify', headers });
    assert.equal(verification.json().count, 1);
    const exported = await app.inject({ method: 'GET', url: '/api/v1/pro/audit/export.csv', headers });
    assert.equal(exported.statusCode, 200, exported.body);
    assert.match(exported.body, /^\uFEFFsequence,ts,entity_type/);
    assert.match(exported.body, /Regel für Hosting/);
    assert.equal(exported.headers['content-type'], 'text/csv; charset=utf-8');

    const foreignDelete = await app.inject({
      method: 'DELETE', url: '/api/v1/pro/accounting/reports/eur/rules/rule-other', headers,
      payload: { reason: 'Fremde Regel löschen' },
    });
    assert.equal(foreignDelete.statusCode, 404);

    const deleted = await app.inject({
      method: 'DELETE', url: '/api/v1/pro/accounting/reports/eur/rules/rule-local', headers,
      payload: { reason: 'Regel entfernen' },
    });
    assert.equal(deleted.statusCode, 200, deleted.body);
    assert.deepEqual(deleted.json(), { ok: true });
    const afterDelete = await app.inject({ method: 'GET', url: '/api/v1/pro/audit/verify', headers });
    assert.equal(afterDelete.json().count, 2);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('embedded Pro EÜR CSV export is served by the server report boundary', async () => {
  const { app, dataDir } = await openApp();
  try {
    const exported = await app.inject({ method: 'GET', url: '/api/v1/pro/accounting/reports/eur/export.csv?taxYear=2025', headers });
    assert.equal(exported.statusCode, 200, exported.body);
    assert.match(exported.body, /^\uFEFFKennziffer;Bezeichnung;Betrag/);
    assert.match(exported.body, /101;Test Einnahmen;0,00/);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
