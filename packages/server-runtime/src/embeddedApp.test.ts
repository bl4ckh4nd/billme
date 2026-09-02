import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PgliteServerDatabase } from '@billme/server-data';
import { buildServerApi } from './app.js';

const localToken = 'embedded-test-local-access-token';
const tenantId = 'embedded-tenant';

const settings = {
  company: { name: 'Billme', owner: 'Local Owner', street: '', zip: '', city: '', email: '', phone: '', website: '' },
  catalog: { categories: [] },
  finance: { bankName: '', iban: '', bic: '', taxId: '', vatId: '', registerCourt: '' },
  numbers: {
    invoicePrefix: 'RE-', nextInvoiceNumber: 1, numberLength: 4,
    offerPrefix: 'AN-', nextOfferNumber: 1, customerPrefix: 'KD-', nextCustomerNumber: 1, customerNumberLength: 4,
  },
  dunning: { levels: [] },
  legal: {
    smallBusinessRule: false, defaultVatRate: 19, countryCode: 'DE', taxAccountingMethod: 'soll',
    paymentTermsDays: 14, defaultIntroText: '', defaultFooterText: '',
  },
  portal: { baseUrl: '' },
  eInvoice: { enabled: false, standard: 'zugferd-en16931', profile: 'EN16931', version: '2.3' },
  email: { provider: 'none', smtpHost: '', smtpPort: 587, smtpSecure: true, smtpUser: '', fromName: '', fromEmail: '' },
  automation: { dunningEnabled: false, dunningRunTime: '09:00', recurringEnabled: false, recurringRunTime: '03:00' },
  dashboard: { monthlyRevenueGoal: 30000, dueSoonDays: 7, topCategoriesLimit: 5, recentPaymentsLimit: 5, topClientsLimit: 5 },
};

test('embedded Lite server exposes EÜR report routes on direct PGlite', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-embedded-lite-eur-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const token = 'embedded-lite-eur-local-access-token';
  const tenantId = 'embedded-lite-eur-tenant';
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'lite',
    logger: false,
    sessionSecret: 'embedded-lite-eur-server-api-test-secret-32-chars',
    localAuth: {
      accessToken: token,
      tenantId,
      userId: 'embedded-lite-eur-user',
      email: 'eur@example.com',
      fullName: 'EÜR Owner',
    },
  });

  try {
    const now = new Date().toISOString();
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at)
       VALUES ($1, $2, $3, 'lite', $4, $4)`,
      [tenantId, 'embedded-lite-eur', 'Embedded Lite EÜR', now],
    );
    await database.query(
      `INSERT INTO server_settings (tenant_id, settings_json, created_at, updated_at)
       VALUES ($1, $2, $3, $3)`,
      [tenantId, JSON.stringify({
        legal: { smallBusinessRule: true },
        businessReportingProfile: {
          jurisdiction: 'DE',
          legalForm: 'sole_proprietor',
          profitDetermination: 'eur',
          fiscalYearStart: '01-01',
        },
      }), now],
    );
    await app.ready();

    const headers = { 'x-billme-local-token': token };
    const report = await app.inject({
      method: 'GET',
      url: '/api/v1/lite/reports/eur?from=2025-01-01&to=2025-12-31',
      headers,
    });
    assert.equal(report.statusCode, 200, report.body);

    const items = await app.inject({
      method: 'GET',
      url: '/api/v1/lite/reports/eur/items?from=2025-01-01&to=2025-12-31',
      headers,
    });
    assert.equal(items.statusCode, 200, items.body);
    assert.deepEqual(items.json(), []);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('embedded Lite server runs health, capabilities, billing, settings, and numbering on direct PGlite', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-embedded-api-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'lite',
    logger: false,
    sessionSecret: 'embedded-server-api-test-secret-32-chars',
    localAuth: {
      accessToken: localToken,
      tenantId,
      userId: 'embedded-user',
      email: 'local@example.com',
      fullName: 'Local Owner',
    },
  });

  try {
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $5)`,
      [tenantId, 'embedded', 'Embedded', 'lite', new Date().toISOString()],
    );
    await database.query(
      `INSERT INTO server_settings (tenant_id, settings_json, created_at, updated_at)
       VALUES ($1, $2, $3, $3)`,
      [tenantId, JSON.stringify(settings), new Date().toISOString()],
    );
    await app.ready();

    const health = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(health.statusCode, 200);

    const missingCapabilitiesToken = await app.inject({
      method: 'GET',
      url: '/api/v1/meta/capabilities',
    });
    assert.equal(missingCapabilitiesToken.statusCode, 401);

    const headers = { 'x-billme-local-token': localToken };
    const capabilities = await app.inject({
      method: 'GET',
      url: '/api/v1/meta/capabilities',
      headers,
    });
    assert.equal(capabilities.statusCode, 200);
    assert.deepEqual(capabilities.json().products, ['lite']);
    assert.equal(capabilities.json().runtime, 'embedded');
    assert.equal(capabilities.json().database.local, 'pglite');
    assert.equal(capabilities.json().auth.multiUser, false);

    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/lite/clients' });
    assert.equal(unauthorized.statusCode, 401);
    const forbidden = await app.inject({
      method: 'GET',
      url: '/api/v1/lite/clients',
      headers: { 'x-billme-local-token': 'wrong-token' },
    });
    assert.equal(forbidden.statusCode, 401);

    const clients = await app.inject({ method: 'GET', url: '/api/v1/lite/clients', headers });
    assert.equal(clients.statusCode, 200);
    assert.deepEqual(clients.json(), []);
    const invoices = await app.inject({ method: 'GET', url: '/api/v1/lite/invoices', headers });
    assert.equal(invoices.statusCode, 200);
    assert.deepEqual(invoices.json(), []);
    const storedSettings = await app.inject({ method: 'GET', url: '/api/v1/lite/settings', headers });
    assert.equal(storedSettings.statusCode, 200);

    const reserved = await app.inject({
      method: 'POST',
      url: '/api/v1/lite/numbers/reserve',
      headers,
      payload: { kind: 'invoice' },
    });
    assert.equal(reserved.statusCode, 200, reserved.body);
    const reservation = reserved.json() as { reservationId: string; number: string };
    assert.equal(reservation.number, 'RE-0001');

    const finalized = await app.inject({
      method: 'POST',
      url: '/api/v1/lite/numbers/finalize',
      headers,
      payload: { reservationId: reservation.reservationId, documentId: 'invoice-1' },
    });
    assert.equal(finalized.statusCode, 200);

    const releasedReservation = await app.inject({
      method: 'POST',
      url: '/api/v1/lite/numbers/reserve',
      headers,
      payload: { kind: 'invoice' },
    });
    assert.equal(releasedReservation.statusCode, 200);
    const released = await app.inject({
      method: 'POST',
      url: '/api/v1/lite/numbers/release',
      headers,
      payload: { reservationId: releasedReservation.json().reservationId },
    });
    assert.equal(released.statusCode, 200);

    assert.equal((await app.inject({
      method: 'POST',
      url: '/api/v1/lite/auth/login',
      headers,
    })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/pro/clients', headers })).statusCode, 404);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/pro/accounting/ledger/stats', headers })).statusCode, 404);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('embedded Pro server exposes accounting routes on direct PGlite without exposing Lite routes', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-embedded-pro-api-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'pro',
    logger: false,
    sessionSecret: 'embedded-pro-server-api-test-secret-32-chars',
    localAuth: {
      accessToken: 'embedded-pro-local-access-token',
      tenantId: 'embedded-pro-tenant',
      userId: 'embedded-pro-user',
      email: 'pro@example.com',
      fullName: 'Pro Owner',
    },
  });

  try {
    await app.ready();
    const headers = { 'x-billme-local-token': 'embedded-pro-local-access-token' };

    const capabilities = await app.inject({
      method: 'GET',
      url: '/api/v1/meta/capabilities',
      headers,
    });
    assert.equal(capabilities.statusCode, 200);
    assert.deepEqual(capabilities.json().products, ['pro']);

    const ledgerStats = await app.inject({
      method: 'GET',
      url: '/api/v1/pro/accounting/ledger/stats',
      headers,
    });
    assert.equal(ledgerStats.statusCode, 200, ledgerStats.body);
    const stats = ledgerStats.json() as { total: number; byChart: { SKR03: number; SKR04: number } };
    assert.ok(stats.total > 0);
    assert.ok(stats.byChart.SKR03 > 0);
    assert.ok(stats.byChart.SKR04 > 0);

    const liteOnlyRoute = await app.inject({
      method: 'GET',
      url: '/api/v1/lite/clients',
      headers,
    });
    assert.equal(liteOnlyRoute.statusCode, 404);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('embedded Pro server exposes tenant-scoped project list/get routes without creating a default project', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-embedded-pro-projects-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'pro',
    logger: false,
    sessionSecret: 'embedded-pro-server-api-test-secret-32-chars',
    localAuth: {
      accessToken: 'embedded-pro-projects-local-access-token',
      tenantId: 'embedded-pro-projects-tenant',
      userId: 'embedded-pro-projects-user',
      email: 'projects@example.com',
      fullName: 'Projects Owner',
    },
  });

  try {
    await app.ready();
    const now = new Date().toISOString();
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at)
       VALUES ('embedded-pro-projects-tenant', 'embedded-pro-projects', 'Projects Tenant', 'pro', $1, $1),
              ('embedded-pro-projects-other', 'embedded-pro-projects-other', 'Other Tenant', 'pro', $1, $1)`,
      [now],
    );
    const project = {
      id: 'project-local-1',
      clientId: 'client-local-1',
      code: 'PRJ-2026-001',
      name: 'Lokales Projekt',
      status: 'active',
      budget: 1250,
      startDate: '2026-01-01',
    };
    await database.query(
      `INSERT INTO clients (id, tenant_id, company, contact_person, email, phone, address, status, tags_json, notes, projects_json, created_at, updated_at)
       VALUES ('client-local-1', 'embedded-pro-projects-tenant', 'Lokaler Kunde', '', '', '', '', 'active', '[]', 'keep', $1, $2, $2),
              ('client-other-1', 'embedded-pro-projects-other', 'Anderer Kunde', '', '', '', '', 'active', '[]', '', $3, $2, $2)`,
      [JSON.stringify([project]), now, JSON.stringify([{ ...project, id: 'project-other-1', clientId: 'client-other-1' }])],
    );
    const headers = { 'x-billme-local-token': 'embedded-pro-projects-local-access-token' };

    const listed = await app.inject({ method: 'GET', url: '/api/v1/pro/projects', headers });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(listed.json(), [project]);

    const fetched = await app.inject({ method: 'GET', url: '/api/v1/pro/projects/project-local-1', headers });
    assert.equal(fetched.statusCode, 200, fetched.body);
    assert.deepEqual(fetched.json(), project);

    const foreign = await app.inject({ method: 'GET', url: '/api/v1/pro/projects/project-other-1', headers });
    assert.equal(foreign.statusCode, 200, foreign.body);
    assert.equal(foreign.json(), null);

    const snapshot = await database.query<{ projects_json: string }>(
      'SELECT projects_json FROM clients WHERE id = $1',
      ['client-local-1'],
    );
    assert.equal(snapshot.rows[0]?.projects_json, JSON.stringify([project]));
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('embedded Lite server exposes tenant-scoped project list routes on PGlite', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-embedded-lite-projects-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'lite',
    logger: false,
    sessionSecret: 'embedded-lite-server-api-test-secret-32-chars',
    localAuth: {
      accessToken: 'embedded-lite-projects-local-access-token',
      tenantId: 'embedded-lite-projects-tenant',
      userId: 'embedded-lite-projects-user',
      email: 'projects@example.com',
      fullName: 'Projects Owner',
    },
  });

  try {
    await app.ready();
    const now = new Date().toISOString();
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at)
       VALUES ('embedded-lite-projects-tenant', 'embedded-lite-projects', 'Projects Tenant', 'lite', $1, $1)`,
      [now],
    );
    const project = {
      id: 'lite-project-1',
      clientId: 'lite-client-1',
      code: 'PRJ-2026-001',
      name: 'Lite Projekt',
      status: 'active',
      budget: 900,
      startDate: '2026-01-01',
    };
    await database.query(
      `INSERT INTO clients (id, tenant_id, company, contact_person, email, phone, address, status, tags_json, notes, projects_json, created_at, updated_at)
       VALUES ('lite-client-1', 'embedded-lite-projects-tenant', 'Lite Kunde', '', '', '', '', 'active', '[]', '', $1, $2, $2)`,
      [JSON.stringify([project]), now],
    );

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/lite/projects',
      headers: { 'x-billme-local-token': 'embedded-lite-projects-local-access-token' },
    });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(listed.json(), [project]);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('embedded Lite server owns catalog CRUD and clears active template references', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-embedded-lite-catalog-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'lite',
    logger: false,
    sessionSecret: 'embedded-lite-server-api-test-secret-32-chars',
    localAuth: {
      accessToken: 'embedded-lite-catalog-local-access-token',
      tenantId: 'embedded-lite-catalog-tenant',
      userId: 'embedded-lite-catalog-user',
      email: 'catalog@example.com',
      fullName: 'Catalog Owner',
    },
  });

  try {
    await app.ready();
    const now = new Date().toISOString();
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at)
       VALUES ('embedded-lite-catalog-tenant', 'embedded-lite-catalog', 'Catalog Tenant', 'lite', $1, $1)`,
      [now],
    );
    await database.query(
      `INSERT INTO clients (id, tenant_id, company, contact_person, email, phone, address, status, tags_json, notes, projects_json, created_at, updated_at)
       VALUES ('lite-catalog-client', 'embedded-lite-catalog-tenant', 'Lite Kunde', '', '', '', '', 'active', '[]', '', $1, $2, $2)`,
      [JSON.stringify([{
        id: 'lite-catalog-project', clientId: 'lite-catalog-client', code: 'PRJ-2026-001', name: 'Projekt',
        status: 'active', budget: 500, startDate: '2026-01-01',
      }]), now],
    );
    const headers = { 'x-billme-local-token': 'embedded-lite-catalog-local-access-token' };

    const project = {
      id: 'lite-catalog-project', clientId: 'lite-catalog-client', code: 'PRJ-2026-001', name: 'Aktualisiertes Projekt',
      status: 'active', budget: 900, startDate: '2026-01-01',
    };
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/lite/projects/lite-catalog-project', headers })).json(), { ...project, name: 'Projekt', budget: 500 });
    const savedProject = await app.inject({ method: 'POST', url: '/api/v1/lite/projects', headers, payload: { reason: 'Projekt aktualisiert', project } });
    assert.equal(savedProject.statusCode, 200, savedProject.body);
    assert.equal(savedProject.json().name, project.name);
    const archivedProject = await app.inject({ method: 'POST', url: '/api/v1/lite/projects/lite-catalog-project/archive', headers, payload: { reason: 'Projekt abgeschlossen' } });
    assert.equal(archivedProject.statusCode, 200, archivedProject.body);
    assert.equal(archivedProject.json().status, 'active');
    assert.ok(archivedProject.json().archivedAt);

    const article = {
      id: 'lite-catalog-article', title: 'Beratung', description: 'Termin', price: 120,
      unit: 'Stunde', category: 'Dienstleistung', taxRate: 19,
    };
    const savedArticle = await app.inject({ method: 'POST', url: '/api/v1/lite/articles', headers, payload: { article } });
    assert.equal(savedArticle.statusCode, 200, savedArticle.body);
    assert.deepEqual(savedArticle.json(), article);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/lite/articles', headers })).json()[0].id, article.id);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/lite/articles/${article.id}`, headers })).statusCode, 200);

    const account = {
      id: 'lite-catalog-account', name: 'Geschäftskonto', iban: 'DE02120300000000202051', balance: 1000,
      defaultSkrAccountNumber: '1200', transactions: [], type: 'bank', color: '#123456',
    };
    const savedAccount = await app.inject({ method: 'POST', url: '/api/v1/lite/accounts', headers, payload: { account } });
    assert.equal(savedAccount.statusCode, 200, savedAccount.body);
    assert.deepEqual(savedAccount.json(), account);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/lite/accounts', headers })).json()[0].id, account.id);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/lite/accounts/${account.id}`, headers })).statusCode, 200);

    const template = { id: 'lite-catalog-template', kind: 'invoice', name: 'Standard', createdAt: now, updatedAt: now, elements: [] };
    const savedTemplate = await app.inject({ method: 'POST', url: '/api/v1/lite/templates', headers, payload: { template } });
    assert.equal(savedTemplate.statusCode, 200, savedTemplate.body);
    assert.deepEqual(savedTemplate.json(), template);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/lite/templates', headers })).json()[0].id, template.id);
    for (const kind of ['invoice', 'offer'] as const) {
      const setActive = await app.inject({ method: 'PUT', url: '/api/v1/lite/templates/active', headers, payload: { kind, templateId: template.id } });
      assert.equal(setActive.statusCode, 200, setActive.body);
      assert.equal((await app.inject({ method: 'GET', url: `/api/v1/lite/templates/active/${kind}`, headers })).json().id, template.id);
    }
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/lite/templates/${template.id}`, headers })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/lite/templates/active/invoice', headers })).json(), null);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/lite/templates/active/offer', headers })).json(), null);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('embedded Lite server exposes tax filing status through the PGlite HTTP boundary', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-embedded-lite-tax-filing-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'lite',
    logger: false,
    sessionSecret: 'embedded-lite-server-api-test-secret-32-chars',
    localAuth: {
      accessToken: 'embedded-lite-tax-filing-local-access-token',
      tenantId: 'embedded-lite-tax-filing-tenant',
      userId: 'embedded-lite-tax-filing-user',
      email: 'tax@example.com',
      fullName: 'Tax Owner',
    },
  });

  try {
    const now = new Date().toISOString();
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at)
       VALUES ($1, $2, $3, 'lite', $4, $4)`,
      ['embedded-lite-tax-filing-tenant', 'embedded-lite-tax-filing', 'Tax Filing Tenant', now],
    );
    await app.ready();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/lite/tax-filing/status',
      headers: { 'x-billme-local-token': 'embedded-lite-tax-filing-local-access-token' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), {
      provider: { available: false, provider: null, errorCode: 'PROVIDER_UNAVAILABLE' },
      certificates: [],
    });

    const records = await app.inject({
      method: 'GET',
      url: '/api/v1/lite/tax-filing/records',
      headers: { 'x-billme-local-token': 'embedded-lite-tax-filing-local-access-token' },
    });
    assert.equal(records.statusCode, 200, records.body);
    assert.deepEqual(records.json(), []);

    const previousKeyId = process.env.TAX_FILING_CREDENTIAL_KEY_ID;
    const previousKey = process.env.TAX_FILING_CREDENTIAL_KEY;
    process.env.TAX_FILING_CREDENTIAL_KEY_ID = 'embedded-test-key';
    process.env.TAX_FILING_CREDENTIAL_KEY = 'a'.repeat(64);
    try {
      const invalidCertificate = await app.inject({
        method: 'POST',
        url: '/api/v1/lite/tax-filing/certificates',
        headers: { 'x-billme-local-token': 'embedded-lite-tax-filing-local-access-token' },
        payload: { id: 'cert-1', pem: 'not-pem', expiresAt: '2030-01-01T00:00:00.000Z' },
      });
      assert.equal(invalidCertificate.statusCode, 400);

      const installed = await app.inject({
        method: 'POST',
        url: '/api/v1/lite/tax-filing/certificates',
        headers: { 'x-billme-local-token': 'embedded-lite-tax-filing-local-access-token' },
        payload: {
          id: 'cert-1',
          pem: '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----',
          expiresAt: '2030-01-01T00:00:00.000Z',
          subject: 'Embedded test certificate',
          reason: 'Install certificate for embedded route test',
        },
      });
      assert.equal(installed.statusCode, 200, installed.body);
      assert.deepEqual(installed.json(), {
        id: 'cert-1',
        fingerprint: 'c4a7a86dcee12cbe8dbbf8a97ef5b0f6e86d069fa9cc25c8e4d5af8f204829fe',
        expiresAt: '2030-01-01T00:00:00.000Z',
        subject: 'Embedded test certificate',
      });

      const withCertificate = await app.inject({
        method: 'GET',
        url: '/api/v1/lite/tax-filing/status',
        headers: { 'x-billme-local-token': 'embedded-lite-tax-filing-local-access-token' },
      });
      assert.equal(withCertificate.statusCode, 200, withCertificate.body);
      assert.equal(withCertificate.json().certificates.length, 1);

      const removed = await app.inject({
        method: 'DELETE',
        url: '/api/v1/lite/tax-filing/certificates/cert-1?reason=Remove%20test%20certificate',
        headers: { 'x-billme-local-token': 'embedded-lite-tax-filing-local-access-token' },
      });
      assert.equal(removed.statusCode, 200, removed.body);
      assert.equal(removed.json(), true);

      const removedAgain = await app.inject({
        method: 'DELETE',
        url: '/api/v1/lite/tax-filing/certificates/cert-1',
        headers: { 'x-billme-local-token': 'embedded-lite-tax-filing-local-access-token' },
      });
      assert.equal(removedAgain.statusCode, 200, removedAgain.body);
      assert.equal(removedAgain.json(), false);
    } finally {
      if (previousKeyId === undefined) delete process.env.TAX_FILING_CREDENTIAL_KEY_ID;
      else process.env.TAX_FILING_CREDENTIAL_KEY_ID = previousKeyId;
      if (previousKey === undefined) delete process.env.TAX_FILING_CREDENTIAL_KEY;
      else process.env.TAX_FILING_CREDENTIAL_KEY = previousKey;
    }
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('embedded Pro server exposes the same tax filing status contract', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-embedded-pro-tax-filing-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'pro',
    logger: false,
    sessionSecret: 'embedded-pro-tax-filing-test-secret-32-chars',
    localAuth: {
      accessToken: 'embedded-pro-tax-filing-local-access-token',
      tenantId: 'embedded-pro-tax-filing-tenant',
      userId: 'embedded-pro-tax-filing-user',
      email: 'tax-pro@example.com',
      fullName: 'Pro Tax Owner',
    },
  });

  try {
    await app.ready();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/pro/tax-filing/status',
      headers: { 'x-billme-local-token': 'embedded-pro-tax-filing-local-access-token' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), {
      provider: { available: false, provider: null, errorCode: 'PROVIDER_UNAVAILABLE' },
      certificates: [],
    });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('embedded Pro server owns catalog CRUD and clears every active reference before deleting a template', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-embedded-pro-catalog-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'pro',
    logger: false,
    sessionSecret: 'embedded-pro-server-api-test-secret-32-chars',
    localAuth: {
      accessToken: 'embedded-pro-local-access-token',
      tenantId: 'embedded-catalog-tenant',
      userId: 'embedded-catalog-user',
      email: 'catalog@example.com',
      fullName: 'Catalog Owner',
    },
  });

  try {
    await app.ready();
    const now = new Date().toISOString();
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at)
       VALUES ($1, $2, $3, 'pro', $4, $4)`,
      ['embedded-catalog-tenant', 'embedded-catalog', 'Catalog Tenant', now],
    );
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at)
       VALUES ($1, $2, $3, 'pro', $4, $4)`,
      ['embedded-catalog-other-tenant', 'embedded-catalog-other', 'Other Catalog Tenant', now],
    );
    await database.query(
      `INSERT INTO articles (id, tenant_id, sku, title, description, price, unit, category, tax_rate)
       VALUES ('catalog-article-other', 'embedded-catalog-other-tenant', NULL, 'Andere Leistung', 'Andere Leistung', 50, 'Stunde', 'Andere', 19)`,
    );
    await database.query(
      `INSERT INTO accounts (id, tenant_id, name, iban, balance, default_skr_account_number, type, color)
       VALUES ('catalog-account-other', 'embedded-catalog-other-tenant', 'Anderes Konto', 'DE02120300000000202051', 200, '1200', 'bank', '#654321')`,
    );
    await database.query(
      `INSERT INTO templates (id, tenant_id, kind, name, elements_json, created_at, updated_at)
       VALUES ('catalog-template-other', 'embedded-catalog-other-tenant', 'invoice', 'Andere Vorlage', '[]', $1, $1)`,
      [now],
    );
    await database.query(
      `INSERT INTO active_templates (tenant_id, id, invoice_template_id, offer_template_id)
       VALUES ('embedded-catalog-other-tenant', 1, 'catalog-template-other', 'catalog-template-other')`,
    );
    const headers = {
      'x-billme-local-token': 'embedded-pro-local-access-token',
      authorization: 'Bearer embedded-pro-local-access-token',
    };

    const article = {
      id: 'catalog-article-1', title: 'Beratung', description: 'Termin', price: 120,
      unit: 'Stunde', category: 'Dienstleistung', taxRate: 19,
    };
    const savedArticle = await app.inject({ method: 'POST', url: '/api/v1/pro/articles', headers, payload: { article } });
    assert.equal(savedArticle.statusCode, 200, savedArticle.body);
    assert.deepEqual(savedArticle.json(), article);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/pro/articles/catalog-article-1', headers })).statusCode, 200);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/pro/articles', headers })).json(), []);
    assert.equal((await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM articles WHERE tenant_id = $1 AND id = $2`,
      ['embedded-catalog-other-tenant', 'catalog-article-other'],
    )).rows[0]?.count, '1');

    const account = {
      id: 'catalog-account-1', name: 'Geschäftskonto', iban: 'DE02120300000000202051', balance: 1000,
      defaultSkrAccountNumber: '1200', transactions: [], type: 'bank', color: '#123456',
    };
    const savedAccount = await app.inject({ method: 'POST', url: '/api/v1/pro/accounts', headers, payload: { account } });
    assert.equal(savedAccount.statusCode, 200, savedAccount.body);
    assert.deepEqual(savedAccount.json(), account);
    assert.equal((await app.inject({ method: 'DELETE', url: '/api/v1/pro/accounts/catalog-account-1', headers })).statusCode, 200);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/pro/accounts', headers })).json(), []);
    assert.equal((await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM accounts WHERE tenant_id = $1 AND id = $2`,
      ['embedded-catalog-other-tenant', 'catalog-account-other'],
    )).rows[0]?.count, '1');

    const template = {
      id: 'catalog-template-1', kind: 'invoice', name: 'Standard', createdAt: now, updatedAt: now, elements: [],
    };
    const savedTemplate = await app.inject({ method: 'POST', url: '/api/v1/pro/templates', headers, payload: { template } });
    assert.equal(savedTemplate.statusCode, 200, savedTemplate.body);
    assert.deepEqual(savedTemplate.json(), template);
    const setInvoice = await app.inject({ method: 'PUT', url: '/api/v1/pro/templates/active', headers, payload: { kind: 'invoice', templateId: template.id } });
    assert.equal(setInvoice.statusCode, 200, setInvoice.body);
    const setOffer = await app.inject({ method: 'PUT', url: '/api/v1/pro/templates/active', headers, payload: { kind: 'offer', templateId: template.id } });
    assert.equal(setOffer.statusCode, 200, setOffer.body);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/pro/templates/active/invoice', headers })).json().id, template.id);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/pro/templates/active/offer', headers })).json().id, template.id);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/v1/pro/templates/${template.id}`, headers })).statusCode, 200);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/pro/templates/active/invoice', headers })).json(), null);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/pro/templates/active/offer', headers })).json(), null);
    assert.equal((await database.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM templates WHERE tenant_id = $1 AND id = $2`,
      ['embedded-catalog-other-tenant', 'catalog-template-other'],
    )).rows[0]?.count, '1');
    assert.deepEqual((await database.query<{ invoice_template_id: string; offer_template_id: string }>(
      `SELECT invoice_template_id, offer_template_id FROM active_templates WHERE tenant_id = $1`,
      ['embedded-catalog-other-tenant'],
    )).rows[0], { invoice_template_id: 'catalog-template-other', offer_template_id: 'catalog-template-other' });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
