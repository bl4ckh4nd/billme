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
    const createdClient = await app.inject({
      method: 'POST',
      url: '/api/v1/lite/clients',
      headers,
      payload: {
        reason: 'Embedded client smoke test',
        client: {
          id: 'embedded-client-1', company: 'Embedded GmbH', contactPerson: '', email: '', phone: '',
          address: '', status: 'active', tags: [], notes: '', addresses: [], emails: [], projects: [], activities: [],
        },
      },
    });
    assert.equal(createdClient.statusCode, 200, createdClient.body);
    assert.equal(createdClient.json().company, 'Embedded GmbH');
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
