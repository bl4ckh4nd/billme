import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createSingleTenantScope, type Offer } from '@billme/server-core';
import {
  PgliteServerDatabase, createPostgresPool, createPostgresServerDatabase,
  createPostgresBillingDependencies, applyServerOfferPortalDecision,
} from '@billme/server-data';
import { DEFAULT_SETTINGS } from '@billme/desktop-services/mockData';
import { buildServerApi } from './app.js';

// Only opt in with an isolated test database, never the runtime DATABASE_URL.
const testUrl = process.env.ARCHITECTURE_TEST_DATABASE_URL;
if (testUrl && !new URL(testUrl).pathname.endsWith('/billme_architecture_test')) throw new Error('An isolated billme_architecture_test database is required');

for (const product of ['lite', 'pro'] as const) test(`${product} document workflows persist, serialize and roll back through the server`, async (t) => {
  const database = testUrl ? createPostgresServerDatabase(createPostgresPool(testUrl)) : await PgliteServerDatabase.open();
  const tenantId = `architecture-${randomUUID()}`;
  const scope = createSingleTenantScope(tenantId, product);
  const actor = { type: 'service' as const, id: 'test-worker', displayName: 'Test worker' };
  const app = await buildServerApi({ logger: false, runtime: 'embedded', product, database,
    sessionSecret: 'architecture-regression-session-secret',
    localAuth: { accessToken: 'architecture-local-token', tenantId, userId: 'owner', email: 'owner@example.test', fullName: 'Owner' },
  });
  t.after(() => app.close());
  const now = new Date().toISOString();
  await database.query('INSERT INTO tenants (id,slug,display_name,product,created_at,updated_at) VALUES ($1,$1,$1,$2,$3,$3)', [tenantId, product, now]);
  await database.query('INSERT INTO server_settings (tenant_id,settings_json,created_at,updated_at) VALUES ($1,$2,$3,$3)', [tenantId, JSON.stringify({ ...DEFAULT_SETTINGS, portal: { baseUrl: 'https://portal.example.test' } }), now]);
  const repositories = createPostgresBillingDependencies(database);
  const offer: Offer = {
    kind: 'offer', tenantId, id: randomUUID(), number: 'AN-1', client: 'Snapshot buyer', clientEmail: 'buyer@example.test',
    clientAddress: 'Snapshot address', date: '2026-09-01', validUntil: '2026-09-30', amount: 119,
    status: 'open', history: [], items: [{ kind: 'item', description: 'Snapshot work', quantity: 1, price: 100, total: 100, taxRate: 19, unit: 'Stk' }],
    taxMode: 'standard_vat', taxMeta: { defaultVatRate: 19 },
    taxSnapshot: { vatRateApplied: 19, vatAmount: 19, netAmount: 100, grossAmount: 119, einvoiceCategoryCode: 'S' },
    share: { token: 'original-publication-token' },
  };
  await repositories.offerRepo.save(scope, offer);
  const headers = { 'x-billme-local-token': 'architecture-local-token' };
  const url = `/api/v1/${product}/documents/convert-offer`;
  const invoiceId = randomUUID();
  const request = () => app.inject({ method: 'POST', url, headers, payload: { offerId: offer.id, invoiceId } });
  const [first, replay] = await Promise.all([request(), request()]);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(first.json().number, replay.json().number);
  const refetched = await app.inject({ method: 'GET', url: `/api/v1/${product}/invoices/${invoiceId}`, headers });
  assert.equal(refetched.statusCode, 200);
  const stored = refetched.json();
  assert.equal(stored.sourceDocumentId, offer.id);
  assert.equal(stored.rootDocumentId, invoiceId);
  assert.equal(stored.clientAddress, offer.clientAddress);
  assert.deepEqual(stored.taxSnapshot, offer.taxSnapshot);
  assert.deepEqual(stored.items.map(({ description, taxRate }: { description: string; taxRate: number }) => ({ description, taxRate })), [{ description: 'Snapshot work', taxRate: 19 }]);
  assert.equal((await repositories.auditLog.listBySubject(scope, { entityType: 'invoice', entityId: invoiceId })).length, 1);
  const reservation = await database.query<{ status: string }>('SELECT status FROM number_reservations WHERE tenant_id=$1 AND document_id=$2', [tenantId, invoiceId]);
  assert.deepEqual(reservation.rows, [{ status: 'finalized' }]);
  const other = await app.inject({ method: 'POST', url, headers, payload: { offerId: offer.id, invoiceId: randomUUID() } });
  assert.equal(other.statusCode, 200, other.body);
  assert.notEqual(other.json().number, stored.number);
  const conflict = await app.inject({ method: 'POST', url, headers, payload: { offerId: 'different-offer', invoiceId } });
  assert.equal(conflict.statusCode, 409);
  const missing = await app.inject({ method: 'POST', url, headers, payload: { offerId: 'another-tenant-offer', invoiceId: randomUUID() } });
  assert.equal(missing.statusCode, 404);
  const foreignTenant = `architecture-foreign-${randomUUID()}`;
  await database.query('INSERT INTO tenants (id,slug,display_name,product,created_at,updated_at) VALUES ($1,$1,$1,$2,$3,$3)', [foreignTenant, product, now]);
  const foreignScope = createSingleTenantScope(foreignTenant, product);
  const foreignInvoice = { ...stored, id: randomUUID(), tenantId: foreignTenant, number: 'FOREIGN-1' };
  await repositories.invoiceRepo.save(foreignScope, foreignInvoice);
  const collision = await app.inject({ method: 'POST', url, headers, payload: { offerId: offer.id, invoiceId: foreignInvoice.id } });
  assert.equal(collision.statusCode, 409);
  await assert.rejects(async () => repositories.invoiceRepo.save(scope, { ...foreignInvoice, tenantId }), /another tenant/);
  assert.equal((await repositories.invoiceRepo.getById(foreignScope, foreignInvoice.id))?.number, 'FOREIGN-1');

  const decision = { decision: 'accepted' as const, decidedAt: now, acceptedName: 'Buyer', acceptedEmail: 'buyer@example.test', decisionTextVersion: 'v1', acceptedUserAgent: 'Test browser' };
  const input = { offerId: offer.id, shareToken: offer.share!.token!, decision, actor };
  const applied = await Promise.all([applyServerOfferPortalDecision(database, scope, input), applyServerOfferPortalDecision(database, scope, input)]);
  assert.equal(applied.filter((result) => result.updated).length, 1);
  assert.equal((await repositories.offerRepo.getById(scope, offer.id))?.share?.acceptedUserAgent, 'Test browser');
  assert.equal((await repositories.auditLog.listBySubject(scope, { entityType: 'offer', entityId: offer.id })).length, 1);
  const stale = { ...offer, id: randomUUID(), number: 'AN-stale', share: { token: 'new-publication-token' } };
  await repositories.offerRepo.save(scope, stale);
  assert.equal((await applyServerOfferPortalDecision(database, scope, { ...input, offerId: stale.id })).updated, false);
  const legacy = { ...offer, id: randomUUID(), number: 'AN-legacy', share: { ...offer.share, acceptedAt: now } };
  await repositories.offerRepo.save(scope, legacy);
  assert.equal((await applyServerOfferPortalDecision(database, scope, { ...input, offerId: legacy.id })).updated, false);

  // Force a real storage failure after the document write, inside its transaction.
  const failInvoiceId = randomUUID();
  const failOffer = { ...offer, id: randomUUID(), number: 'AN-fail' };
  await repositories.offerRepo.save(scope, failOffer);
  const trigger = `architecture_fail_${product}`;
  await database.query(`CREATE OR REPLACE FUNCTION ${trigger}() RETURNS trigger AS $$ BEGIN
    IF NEW.entity_id IN ('${failInvoiceId}', '${failOffer.id}') THEN RAISE EXCEPTION 'Injected audit failure'; END IF;
    RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await database.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION ${trigger}()`);
  try {
    const before = await database.query('SELECT settings_json FROM server_settings WHERE tenant_id=$1', [tenantId]);
    const failed = await app.inject({ method: 'POST', url, headers, payload: { offerId: offer.id, invoiceId: failInvoiceId } });
    assert.equal(failed.statusCode, 500, failed.body);
    assert.equal(await repositories.invoiceRepo.getById(scope, failInvoiceId), null);
    assert.deepEqual((await database.query('SELECT settings_json FROM server_settings WHERE tenant_id=$1', [tenantId])).rows, before.rows);
    assert.equal((await database.query('SELECT id FROM number_reservations WHERE tenant_id=$1 AND document_id=$2', [tenantId, failInvoiceId])).rows.length, 0);
    await assert.rejects(applyServerOfferPortalDecision(database, scope, { ...input, offerId: failOffer.id }));
    assert.equal((await repositories.offerRepo.getById(scope, failOffer.id))?.share?.decision, undefined);
  } finally {
    await database.query(`DROP TRIGGER ${trigger} ON audit_log`);
    await database.query(`DROP FUNCTION ${trigger}()`);
  }
  const retried = await app.inject({ method: 'POST', url, headers, payload: { offerId: offer.id, invoiceId: failInvoiceId } });
  assert.equal(retried.statusCode, 200, retried.body);
  app.localSession!.role = 'viewer';
  const denied = await app.inject({ method: 'POST', url, headers, payload: { offerId: offer.id, invoiceId: randomUUID() } });
  assert.equal(denied.statusCode, 403);
});
