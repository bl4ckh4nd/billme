import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSingleTenantScope } from '@billme/server-core';
import { buildPostgresTaxAuditExportArtifact, createPostgresClientRepository, createPostgresInvoiceRepository, createPostgresOfferRepository, createPostgresRecurringProfileRepository, PgliteServerDatabase, type PostgresQueryable } from '@billme/server-data';
import { buildServerApi } from './app.js';

const token = 'automation-local-token';
const tenantId = 'automation-tenant';
const headers = { 'x-billme-local-token': token };

const settings = {
  company: { name: 'Billme', owner: 'Owner', street: '', zip: '', city: '', email: 'billing@example.test', phone: '', website: '' },
  catalog: { categories: [] },
  finance: { bankName: '', iban: '', bic: '', taxId: '', vatId: '', registerCourt: '' },
  numbers: { invoicePrefix: 'RE-', nextInvoiceNumber: 1, numberLength: 4, offerPrefix: 'AN-', nextOfferNumber: 1, customerPrefix: 'KD-', nextCustomerNumber: 1, customerNumberLength: 4 },
  dunning: { levels: [] },
  legal: { smallBusinessRule: false, defaultVatRate: 19, countryCode: 'DE', taxAccountingMethod: 'soll', paymentTermsDays: 14, defaultIntroText: '', defaultFooterText: '' },
  portal: { baseUrl: 'http://localhost' },
  eInvoice: { enabled: false, standard: 'zugferd-en16931', profile: 'EN16931', version: '2.3' },
  email: { provider: 'none', smtpHost: '', smtpPort: 587, smtpSecure: true, smtpUser: '', fromName: '', fromEmail: '' },
  automation: { dunningEnabled: false, dunningRunTime: '09:00', recurringEnabled: false, recurringRunTime: '03:00' },
  dashboard: { monthlyRevenueGoal: 30000, dueSoonDays: 7, topCategoriesLimit: 5, recentPaymentsLimit: 5, topClientsLimit: 5 },
};

const client = {
  id: 'automation-client', tenantId, customerNumber: 'KD-0001', company: 'Automation GmbH',
  contactPerson: '', email: 'customer@example.test', phone: '', address: '', status: 'active' as const,
  avatar: '', tags: [], notes: '', addresses: [], emails: [], projects: [], activities: [],
};

const offer = {
  id: 'automation-offer', tenantId, clientId: client.id, number: 'AN-0001', client: client.company,
  clientEmail: client.email, clientAddress: '', date: '2026-08-22', validUntil: '2026-12-31', amount: 100,
  status: 'open' as const, items: [], history: [], taxMode: 'standard_vat' as const, kind: 'offer' as const,
};

const invoice = {
  id: 'automation-invoice', tenantId, clientId: client.id, number: 'RE-0001', client: client.company,
  clientEmail: client.email, clientAddress: '', date: '2026-08-22', dueDate: '2026-12-31', amount: 100,
  status: 'open' as const, items: [], payments: [], history: [], taxMode: 'standard_vat' as const, kind: 'invoice' as const,
};

const response = (payload: unknown, status = 200): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
  text: async () => JSON.stringify(payload),
} as Response);

test('server automation routes publish, sync, queue, and scope portal operations on PGlite', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-automation-routes-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/health')) return response({ ok: true, ts: '2026-08-22T10:00:00.000Z' });
    if (url.endsWith('/status')) return response({ decision: {
      decidedAt: '2026-08-22T10:00:00.000Z', decision: 'accepted', acceptedName: 'Customer',
      acceptedEmail: 'customer@example.test', decisionTextVersion: 'v1',
    } });
    if (url.includes('/customers/access-links')) return response({ ok: true, token: 'customer-link-token-123456', publicUrl: `${url}/public`, expiresAt: '2026-09-01T00:00:00.000Z' });
    return response({ ok: true });
  }) as typeof fetch;

  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'lite',
    logger: false,
    sessionSecret: 'automation-server-api-test-secret-32-chars',
    localAuth: { accessToken: token, tenantId, userId: 'automation-user', email: 'owner@example.test', fullName: 'Owner' },
  });

  try {
    const timestamp = new Date().toISOString();
    await database.query(`INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)`, [tenantId, 'automation', 'Automation', 'lite', timestamp]);
    await database.query(`INSERT INTO server_settings (tenant_id, settings_json, created_at, updated_at) VALUES ($1, $2, $3, $3)`, [tenantId, JSON.stringify(settings), timestamp]);
    const queryable = database;
    const scope = createSingleTenantScope(tenantId, 'lite');
    await createPostgresClientRepository(queryable).save(scope, client);
    await createPostgresOfferRepository(queryable).save(scope, offer);
    await createPostgresInvoiceRepository(queryable).save(scope, invoice);
    await app.ready();

    const health = await app.inject({ method: 'GET', url: '/api/v1/lite/portal/health?baseUrl=http%3A%2F%2Flocalhost', headers });
    assert.equal(health.statusCode, 200, health.body);

    const publication = await app.inject({ method: 'POST', url: '/api/v1/lite/portal/publish-offer', headers, payload: { offerId: offer.id } });
    assert.equal(publication.statusCode, 200, publication.body);
    const publicationJson = publication.json() as { token: string };
    assert.ok(publicationJson.token.length >= 16);
    assert.notEqual(
      publicationJson.token,
      createHash('sha256').update(`billme:${tenantId}:offer:${offer.id}`).digest('hex'),
    );
    const repeatedPublication = await app.inject({ method: 'POST', url: '/api/v1/lite/portal/publish-offer', headers, payload: { offerId: offer.id } });
    assert.equal((repeatedPublication.json() as { token: string }).token, publicationJson.token);

    const invoicePublication = await app.inject({ method: 'POST', url: '/api/v1/lite/portal/publish-invoice', headers, payload: { invoiceId: invoice.id } });
    assert.equal(invoicePublication.statusCode, 200, invoicePublication.body);
    assert.notEqual(
      (invoicePublication.json() as { token: string }).token,
      createHash('sha256').update(`billme:${tenantId}:invoice:${invoice.id}`).digest('hex'),
    );
    const repeatedInvoicePublication = await app.inject({ method: 'POST', url: '/api/v1/lite/portal/publish-invoice', headers, payload: { invoiceId: invoice.id } });
    assert.equal((repeatedInvoicePublication.json() as { token: string }).token, (invoicePublication.json() as { token: string }).token);
    const invoiceToken = (invoicePublication.json() as { token: string }).token;
    const auditRows = await database.query<{ before_json: string | null; after_json: string | null }>(
      `SELECT before_json, after_json FROM audit_log WHERE tenant_id = $1 AND entity_id IN ($2, $3)`,
      [tenantId, offer.id, invoice.id],
    );
    assert.ok(auditRows.rows.every((row) => !JSON.stringify(row).includes(invoiceToken)));
    assert.ok(auditRows.rows.every((row) => !JSON.stringify(row).includes(publicationJson.token)));
    const auditExport = await buildPostgresTaxAuditExportArtifact(database as unknown as PostgresQueryable, tenantId);
    const auditCsv = auditExport.files.find((file) => file.name === 'audit-log.csv')?.content ?? '';
    assert.ok(!auditCsv.includes(invoiceToken));
    assert.ok(!auditCsv.includes(publicationJson.token));

    const sync = await app.inject({ method: 'POST', url: '/api/v1/lite/portal/sync-offer-status', headers, payload: { offerId: offer.id } });
    assert.equal(sync.statusCode, 200, sync.body);
    assert.equal(sync.json().updated, true);
    const storedOffer = await createPostgresOfferRepository(queryable).getById(scope, offer.id);
    assert.equal(storedOffer?.share?.decision, 'accepted');

    for (const endpoint of ['/portal/customer-access-link', '/portal/customer-access-link/rotate']) {
      const link = await app.inject({ method: 'POST', url: `/api/v1/lite${endpoint}`, headers, payload: { customerRef: client.id } });
      assert.equal(link.statusCode, 200, link.body);
    }

    const emailPayload = { documentType: 'invoice', documentId: invoice.id, recipientEmail: invoice.clientEmail, recipientName: invoice.client, subject: 'Rechnung', bodyText: 'Ihre Rechnung' };
    const email = await app.inject({ method: 'POST', url: '/api/v1/lite/email/send', headers, payload: emailPayload });
    const repeatedEmail = await app.inject({ method: 'POST', url: '/api/v1/lite/email/send', headers, payload: emailPayload });
    assert.equal(email.statusCode, 200, email.body);
    assert.equal(repeatedEmail.json().messageId, email.json().messageId);

    const status = await app.inject({ method: 'GET', url: `/api/v1/lite/dunning/invoices/${invoice.id}/status`, headers });
    assert.equal(status.statusCode, 200, status.body);
    assert.equal(status.json().currentLevel, 0);
    const dunning = await app.inject({ method: 'POST', url: '/api/v1/lite/dunning/manual-run', headers });
    assert.equal(dunning.statusCode, 200, dunning.body);
    assert.equal(dunning.json().success, false);
    const recurring = await app.inject({ method: 'POST', url: '/api/v1/lite/recurring/manual-run', headers });
    assert.equal(recurring.statusCode, 200, recurring.body);
    assert.equal(recurring.json().success, true);

    assert.ok(requests.some((entry) => entry.startsWith('POST http://localhost/offers')));
    assert.ok(requests.some((entry) => entry.startsWith('GET http://localhost/offers/')));
  } finally {
    await app.close();
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('portal bearer reservations survive an external publish failure without entering the audit chain', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-portal-token-reservation-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const reservationTenantId = 'portal-token-reservation-tenant';
  const reservationToken = 'portal-token-reservation-auth';
  const reservationScope = createSingleTenantScope(reservationTenantId, 'lite');
  const reservationClient = { ...client, id: 'portal-token-client', tenantId: reservationTenantId };
  const reservationInvoice = { ...invoice, id: 'portal-token-invoice', tenantId: reservationTenantId, clientId: reservationClient.id, client: reservationClient.company, clientEmail: reservationClient.email };
  const originalFetch = globalThis.fetch;
  let failPublish = true;
  globalThis.fetch = (async (input) => {
    if (String(input).endsWith('/invoices') && failPublish) return response({ error: 'portal unavailable' }, 503);
    return response({ ok: true });
  }) as typeof fetch;
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'lite',
    logger: false,
    sessionSecret: 'automation-portal-token-reservation-secret',
    localAuth: { accessToken: reservationToken, tenantId: reservationTenantId, userId: 'reservation-user', email: 'owner@example.test', fullName: 'Owner' },
  });

  try {
    const timestamp = new Date().toISOString();
    await database.query(`INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)`, [reservationTenantId, 'portal-token-reservation', 'Portal Token Reservation', 'lite', timestamp]);
    await database.query(`INSERT INTO server_settings (tenant_id, settings_json, created_at, updated_at) VALUES ($1, $2, $3, $3)`, [reservationTenantId, JSON.stringify(settings), timestamp]);
    await createPostgresClientRepository(database).save(reservationScope, reservationClient);
    await createPostgresInvoiceRepository(database).save(reservationScope, reservationInvoice);
    await app.ready();

    const failed = await app.inject({ method: 'POST', url: '/api/v1/lite/portal/publish-invoice', headers: { 'x-billme-local-token': reservationToken }, payload: { invoiceId: reservationInvoice.id } });
    assert.equal(failed.statusCode, 500, failed.body);
    const reserved = await database.query<{ token: string; token_hash: string }>(
      'SELECT token, token_hash FROM portal_publications WHERE tenant_id = $1 AND document_type = $2 AND document_id = $3',
      [reservationTenantId, 'invoice', reservationInvoice.id],
    );
    assert.equal(reserved.rows.length, 1);
    assert.notEqual(reserved.rows[0]!.token, createHash('sha256').update(`billme:${reservationTenantId}:invoice:${reservationInvoice.id}`).digest('hex'));
    const failedAudit = await database.query<{ before_json: string | null; after_json: string | null }>('SELECT before_json, after_json FROM audit_log WHERE tenant_id = $1', [reservationTenantId]);
    assert.ok(failedAudit.rows.every((row) => !JSON.stringify(row).includes(reserved.rows[0]!.token)));

    failPublish = false;
    const retried = await app.inject({ method: 'POST', url: '/api/v1/lite/portal/publish-invoice', headers: { 'x-billme-local-token': reservationToken }, payload: { invoiceId: reservationInvoice.id } });
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal((retried.json() as { token: string }).token, reserved.rows[0]!.token);
  } finally {
    await app.close();
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('Pro automation routes expose authenticated portal health and keep provider secrets server-side', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-pro-automation-routes-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => response({ ok: true, ts: '2026-08-22T10:00:00.000Z' })) as typeof fetch;
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'pro',
    logger: false,
    sessionSecret: 'automation-pro-server-api-test-secret-32-chars',
    localAuth: { accessToken: 'pro-automation-token', tenantId: 'pro-automation-tenant', userId: 'pro-user', email: 'pro@example.test', fullName: 'Pro Owner' },
  });
  try {
    const timestamp = new Date().toISOString();
    await database.query(`INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)`, ['pro-automation-tenant', 'pro-automation', 'Pro Automation', 'pro', timestamp]);
    await database.query(`INSERT INTO server_settings (tenant_id, settings_json, created_at, updated_at) VALUES ($1, $2, $3, $3)`, ['pro-automation-tenant', JSON.stringify(settings), timestamp]);
    await app.ready();
    const missingAuth = await app.inject({ method: 'GET', url: '/api/v1/pro/portal/health?baseUrl=http%3A%2F%2Flocalhost' });
    assert.equal(missingAuth.statusCode, 401);
    const health = await app.inject({ method: 'GET', url: '/api/v1/pro/portal/health?baseUrl=http%3A%2F%2Flocalhost', headers: { 'x-billme-local-token': 'pro-automation-token' } });
    assert.equal(health.statusCode, 200, health.body);
    const emailTest = await app.inject({ method: 'POST', url: '/api/v1/pro/email/test-config', headers: { 'x-billme-local-token': 'pro-automation-token' }, payload: { provider: 'resend', resendApiKey: 're_should_not_cross_boundary' } });
    assert.equal(emailTest.statusCode, 200, emailTest.body);
    assert.match(emailTest.json().error, /server/i);
  } finally {
    await app.close();
    globalThis.fetch = originalFetch;
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('automation mutations deny viewer sessions before touching persisted or external state', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-viewer-automation-routes-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'lite',
    logger: false,
    sessionSecret: 'automation-viewer-server-api-test-secret-32-chars',
    localAuth: { accessToken: 'viewer-automation-token', tenantId: 'viewer-automation-tenant', userId: 'viewer-user', email: 'viewer@example.test', fullName: 'Viewer', role: 'viewer' },
  });

  try {
    await app.ready();
    const viewerHeaders = { 'x-billme-local-token': 'viewer-automation-token' };
    const mutations = [
      ['/api/v1/lite/portal/publish-offer', { offerId: 'offer-1' }],
      ['/api/v1/lite/portal/publish-invoice', { invoiceId: 'invoice-1' }],
      ['/api/v1/lite/portal/sync-offer-status', { offerId: 'offer-1' }],
      ['/api/v1/lite/portal/customer-access-link', { customerRef: 'customer-1' }],
      ['/api/v1/lite/portal/customer-access-link/rotate', { customerRef: 'customer-1' }],
      ['/api/v1/lite/email/send', { documentType: 'invoice', documentId: 'invoice-1', recipientEmail: 'customer@example.test', recipientName: 'Customer', subject: 'Invoice', bodyText: 'Body' }],
      ['/api/v1/lite/email/test-config', { provider: 'resend' }],
      ['/api/v1/lite/dunning/manual-run', undefined],
      ['/api/v1/lite/recurring/manual-run', undefined],
    ] as const;

    for (const [url, payload] of mutations) {
      const result = await app.inject({ method: 'POST', url, headers: viewerHeaders, ...(payload === undefined ? {} : { payload }) });
      assert.equal(result.statusCode, 403, `${url}: ${result.body}`);
    }
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('recurring manual runs roll back generated invoices and numbering when a later profile fails', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-recurring-rollback-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const rollbackTenantId = 'recurring-rollback-tenant';
  const rollbackToken = 'recurring-rollback-token';
  const scope = createSingleTenantScope(rollbackTenantId, 'lite');
  const rollbackSettings = structuredClone(settings);
  rollbackSettings.numbers.nextInvoiceNumber = 1;
  const rollbackClient = { ...client, id: 'recurring-client', tenantId: rollbackTenantId };
  const profileRepository = createPostgresRecurringProfileRepository(database);
  const invoiceRepository = createPostgresInvoiceRepository(database);
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'lite',
    logger: false,
    sessionSecret: 'automation-recurring-rollback-secret-32-chars',
    localAuth: { accessToken: rollbackToken, tenantId: rollbackTenantId, userId: 'recurring-user', email: 'owner@example.test', fullName: 'Owner' },
  });

  try {
    const timestamp = new Date().toISOString();
    await database.query(`INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)`, [rollbackTenantId, 'recurring-rollback', 'Recurring Rollback', 'lite', timestamp]);
    await database.query(`INSERT INTO server_settings (tenant_id, settings_json, created_at, updated_at) VALUES ($1, $2, $3, $3)`, [rollbackTenantId, JSON.stringify(rollbackSettings), timestamp]);
    await profileRepository.save(scope, {
      id: 'recurring-valid-profile', tenantId: rollbackTenantId, clientId: rollbackClient.id,
      active: true, name: 'A valid profile', interval: 'monthly', nextRun: '2000-01-01', amount: 100,
      items: [], taxMode: 'standard_vat',
    });
    await profileRepository.save(scope, {
      id: 'recurring-invalid-profile', tenantId: rollbackTenantId, clientId: 'missing-client',
      active: true, name: 'B failing profile', interval: 'monthly', nextRun: '2000-01-01', amount: 100,
      items: [], taxMode: 'standard_vat',
    });
    await createPostgresClientRepository(database).save(scope, rollbackClient);
    await app.ready();

    const run = await app.inject({
      method: 'POST',
      url: '/api/v1/lite/recurring/manual-run',
      headers: { 'x-billme-local-token': rollbackToken },
    });
    assert.equal(run.statusCode, 200, run.body);
    const payload = run.json() as { success: boolean; result?: { errors: unknown[] } };
    assert.equal(payload.success, false);
    assert.equal(payload.result?.errors.length, 1);
    assert.deepEqual(await invoiceRepository.list(scope), []);
    const storedValidProfile = await profileRepository.getById(scope, 'recurring-valid-profile');
    assert.equal(storedValidProfile?.nextRun, '2000-01-01');
    assert.equal(storedValidProfile?.lastRun, undefined);
    const settingsRow = await database.query<{ settings_json: string }>('SELECT settings_json FROM server_settings WHERE tenant_id = $1', [rollbackTenantId]);
    assert.equal(JSON.parse(settingsRow.rows[0]!.settings_json).numbers.nextInvoiceNumber, 1);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
