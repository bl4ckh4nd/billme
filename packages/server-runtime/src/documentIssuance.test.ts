import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createSingleTenantScope, type Offer } from '@billme/server-core';
import {
  PgliteServerDatabase,
  createPostgresBillingDependencies,
  createPostgresPool,
  createPostgresServerDatabase,
  saveServerLedgerAccount,
  type ServerDatabase,
} from '@billme/server-data';
import { DEFAULT_SETTINGS } from '@billme/desktop-services/mockData';
import { buildServerApi } from './app.js';

// Only opt in with an isolated test database, never the runtime DATABASE_URL.
const testUrl = process.env.ARCHITECTURE_TEST_DATABASE_URL;
if (testUrl && !new URL(testUrl).pathname.endsWith('/billme_architecture_test')) {
  throw new Error('An isolated billme_architecture_test database is required');
}

type Product = 'lite' | 'pro';

const setup = async (product: Product) => {
  const database: ServerDatabase = testUrl
    ? createPostgresServerDatabase(createPostgresPool(testUrl))
    : await PgliteServerDatabase.open();
  const tenantId = `issuance-${randomUUID()}`;
  const scope = createSingleTenantScope(tenantId, product);
  const app = await buildServerApi({
    logger: false,
    runtime: 'embedded',
    product,
    database,
    sessionSecret: 'architecture-regression-session-secret',
    localAuth: {
      accessToken: 'architecture-local-token',
      tenantId,
      userId: 'owner',
      email: 'owner@example.test',
      fullName: 'Owner',
    },
  });
  const now = new Date().toISOString();
  await database.query(
    'INSERT INTO tenants (id,slug,display_name,product,created_at,updated_at) VALUES ($1,$1,$1,$2,$3,$3)',
    [tenantId, product, now],
  );
  await database.query(
    'INSERT INTO server_settings (tenant_id,settings_json,created_at,updated_at) VALUES ($1,$2,$3,$3)',
    [tenantId, JSON.stringify({ ...DEFAULT_SETTINGS, portal: { baseUrl: 'https://portal.example.test' } }), now],
  );
  const repositories = createPostgresBillingDependencies(database);
  const headers = { 'x-billme-local-token': 'architecture-local-token' };
  const url = `/api/v1/${product}/document-chain/issue`;
  const issue = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url, headers, payload });
  const seedOffer = async (): Promise<Offer> => {
    const offer: Offer = {
      kind: 'offer',
      tenantId,
      id: randomUUID(),
      number: 'AN-1',
      client: 'Issuance buyer',
      clientEmail: 'buyer@example.test',
      clientAddress: 'Teststraße 1\n10115 Berlin',
      date: '2026-09-01',
      validUntil: '2026-09-30',
      amount: 100,
      status: 'accepted',
      history: [],
      items: [{ kind: 'item', description: 'Issuance work', quantity: 1, price: 100, total: 100, taxRate: 19, unit: 'Stk' }],
      taxMode: 'standard_vat',
      taxMeta: { defaultVatRate: 19 },
    };
    await repositories.offerRepo.save(scope, offer);
    return offer;
  };
  // Pro postings need the SKR03 posting roles and their ledger accounts.
  const seedPostingMappings = async () => {
    if (product !== 'pro') return;
    const stamp = new Date().toISOString();
    // Every posting line is validated against the chart's ledger accounts.
    for (const [accountNumber, name] of [
      ['1200', 'Bank'],
      ['8400', 'Erlöse 19% USt'],
      ['1776', 'Umsatzsteuer 19% USt'],
    ]) {
      await saveServerLedgerAccount(database, {
        id: randomUUID(),
        chart: 'SKR03',
        accountNumber,
        name,
        source: 'issuance-test',
        createdAt: stamp,
        updatedAt: stamp,
      });
    }
    for (const [role, accountNumber] of [
      ['accounts_receivable', '1200'],
      ['revenue', '8400'],
      ['output_vat', '1776'],
    ]) {
      const mapping = await app.inject({
        method: 'POST',
        url: '/api/v1/pro/accounting/mappings',
        headers,
        payload: { reason: `Issuance mapping ${role}`, chart: 'SKR03', role, accountNumber },
      });
      assert.ok(mapping.statusCode < 300, mapping.body);
    }
  };
  return { app, database, scope, tenantId, repositories, headers, url, issue, seedOffer, seedPostingMappings };
};

const countRows = async (database: ServerDatabase, sql: string, params: readonly unknown[]): Promise<number> => {
  const result = await database.query<{ count: number }>(sql, params);
  return Number(result.rows[0]?.count);
};

for (const product of ['lite', 'pro'] as const) {
  test(`${product} document-chain issuance is atomic, idempotent, bounded, and role-guarded`, async (t) => {
    const harness = await setup(product);
    t.after(() => harness.app.close());
    const suffix = `${product}-${randomUUID().slice(0, 8)}`;
    await harness.seedPostingMappings();
    const offer = await harness.seedOffer();

    // Case 1: one call commits an open document with history and a receipt.
    const orderPayload = {
      operation: 'order_confirmation',
      id: `order-${suffix}`,
      offerId: offer.id,
      date: '2026-09-04',
      dueDate: '2026-09-18',
      reason: 'Issuance: Auftragsbestätigung',
    };
    const orderRes = await harness.issue(orderPayload);
    assert.equal(orderRes.statusCode, 200, orderRes.body);
    const order = orderRes.json();
    assert.equal(order.status, 'open');
    assert.equal(order.documentKind, 'order_confirmation');
    assert.ok(order.number);
    assert.ok(order.numberReservationId);
    assert.equal(order.history.length, 2, JSON.stringify(order.history));
    assert.ok(order.history.some((entry: { action: string }) => entry.action.includes('invoice.chain.create')));
    assert.ok(order.history.some((entry: { action: string }) => entry.action.includes('invoice.update')));
    const orderReceipt = await harness.database.query<{ intent_hash: string }>(
      'SELECT intent_hash FROM document_issuance_receipts WHERE tenant_id=$1 AND operation_id=$2',
      [harness.tenantId, orderPayload.id],
    );
    assert.equal(orderReceipt.rows.length, 1);
    assert.match(orderReceipt.rows[0]?.intent_hash ?? '', /^[0-9a-f]{64}$/);
    const orderReservation = await harness.database.query<{ status: string; document_id: string }>(
      'SELECT status, document_id FROM number_reservations WHERE tenant_id=$1 AND document_id=$2',
      [harness.tenantId, orderPayload.id],
    );
    assert.deepEqual(orderReservation.rows, [{ status: 'finalized', document_id: orderPayload.id }]);
    const orderRow = await harness.database.query<{ status: string }>(
      'SELECT status FROM invoices WHERE tenant_id=$1 AND id=$2',
      [harness.tenantId, orderPayload.id],
    );
    assert.deepEqual(orderRow.rows, [{ status: 'open' }]);

    // Case 6: an identical replay returns the recorded result byte-for-byte;
    // an altered intent on the same id is a 409 that creates nothing.
    const deliveryPayload = {
      operation: 'delivery_note',
      id: `delivery-${suffix}`,
      orderId: orderPayload.id,
      date: '2026-09-04',
      reason: 'Issuance: Lieferschein',
    };
    const deliveryFirst = await harness.issue(deliveryPayload);
    assert.equal(deliveryFirst.statusCode, 200, deliveryFirst.body);
    const deliveryReplay = await harness.issue(deliveryPayload);
    assert.equal(deliveryReplay.statusCode, 200, deliveryReplay.body);
    assert.deepEqual(deliveryReplay.json(), deliveryFirst.json());
    assert.equal(
      await countRows(harness.database, 'SELECT count(*)::int AS count FROM invoices WHERE tenant_id=$1 AND id=$2', [harness.tenantId, deliveryPayload.id]),
      1,
    );
    assert.equal(
      await countRows(harness.database, 'SELECT count(*)::int AS count FROM document_issuance_receipts WHERE tenant_id=$1 AND operation_id=$2', [harness.tenantId, deliveryPayload.id]),
      1,
    );
    const documentsBeforeConflicts = await countRows(
      harness.database,
      'SELECT count(*)::int AS count FROM invoices WHERE tenant_id=$1',
      [harness.tenantId],
    );
    const changedDate = await harness.issue({ ...deliveryPayload, date: '2026-09-05' });
    assert.equal(changedDate.statusCode, 409, changedDate.body);

    const settlePayload = {
      operation: 'settlement_invoice',
      id: `settle-${suffix}`,
      orderId: orderPayload.id,
      kind: 'advance_invoice',
      amount: 40,
      date: '2026-09-04',
      reason: 'Issuance: Abschlag',
    };
    const settleFirst = await harness.issue(settlePayload);
    assert.equal(settleFirst.statusCode, 200, settleFirst.body);
    const settleChanged = await harness.issue({ ...settlePayload, amount: 41 });
    assert.equal(settleChanged.statusCode, 409, settleChanged.body);
    assert.equal(
      await countRows(harness.database, 'SELECT count(*)::int AS count FROM invoices WHERE tenant_id=$1', [harness.tenantId]),
      documentsBeforeConflicts + 1,
    );
    assert.equal(
      await countRows(harness.database, 'SELECT count(*)::int AS count FROM document_issuance_receipts WHERE tenant_id=$1 AND operation_id=$2', [harness.tenantId, settlePayload.id]),
      1,
    );

    // Case 7: two concurrent identical issuances settle on one document.
    const concurrentPayload = {
      operation: 'settlement_invoice',
      id: `concurrent-${suffix}`,
      orderId: orderPayload.id,
      kind: 'partial_invoice',
      amount: 20,
      date: '2026-09-04',
      reason: 'Issuance: Teilrechnung parallel',
    };
    const [concurrentA, concurrentB] = await Promise.all([
      harness.issue(concurrentPayload),
      harness.issue(concurrentPayload),
    ]);
    assert.equal(concurrentA.statusCode, 200, concurrentA.body);
    assert.equal(concurrentB.statusCode, 200, concurrentB.body);
    assert.deepEqual(concurrentB.json(), concurrentA.json());
    assert.equal(
      await countRows(harness.database, 'SELECT count(*)::int AS count FROM invoices WHERE tenant_id=$1 AND id=$2', [harness.tenantId, concurrentPayload.id]),
      1,
    );
    assert.equal(
      await countRows(harness.database, 'SELECT count(*)::int AS count FROM document_issuance_receipts WHERE tenant_id=$1 AND operation_id=$2', [harness.tenantId, concurrentPayload.id]),
      1,
    );
    assert.equal(
      await countRows(harness.database, 'SELECT count(*)::int AS count FROM number_reservations WHERE tenant_id=$1 AND document_id=$2', [harness.tenantId, concurrentPayload.id]),
      1,
    );

    // Case 8: an occupied id — own tenant or foreign tenant — is never overwritten.
    const sameTenantCollision = await harness.issue({
      operation: 'delivery_note',
      id: orderPayload.id,
      orderId: orderPayload.id,
      date: '2026-09-04',
      reason: 'Issuance: Kollision',
    });
    assert.equal(sameTenantCollision.statusCode, 409, sameTenantCollision.body);
    const foreignTenant = `issuance-foreign-${randomUUID()}`;
    const now = new Date().toISOString();
    await harness.database.query(
      'INSERT INTO tenants (id,slug,display_name,product,created_at,updated_at) VALUES ($1,$1,$1,$2,$3,$3)',
      [foreignTenant, product, now],
    );
    const foreignScope = createSingleTenantScope(foreignTenant, product);
    const foreignId = randomUUID();
    await harness.repositories.invoiceRepo.save(foreignScope, {
      ...order,
      id: foreignId,
      tenantId: foreignTenant,
      number: 'FOREIGN-ISSUE-1',
      rootDocumentId: foreignId,
      sourceDocumentId: undefined,
    });
    const foreignCollision = await harness.issue({
      operation: 'delivery_note',
      id: foreignId,
      orderId: orderPayload.id,
      date: '2026-09-04',
      reason: 'Issuance: Fremd-Kollision',
    });
    assert.equal(foreignCollision.statusCode, 409, foreignCollision.body);
    assert.equal((await harness.repositories.invoiceRepo.getById(foreignScope, foreignId))?.number, 'FOREIGN-ISSUE-1');

    // Case 9: shared-helper amount bounds fail the whole issuance.
    const reservationsBeforeBounds = await countRows(
      harness.database,
      'SELECT count(*)::int AS count FROM number_reservations WHERE tenant_id=$1',
      [harness.tenantId],
    );
    const documentsBeforeBounds = await countRows(
      harness.database,
      'SELECT count(*)::int AS count FROM invoices WHERE tenant_id=$1',
      [harness.tenantId],
    );
    const failedIds = [`exceed-${suffix}`, `final-${suffix}`, `correction-${suffix}`];
    const exceeding = await harness.issue({
      operation: 'settlement_invoice',
      id: failedIds[0],
      orderId: orderPayload.id,
      kind: 'advance_invoice',
      amount: 500,
      date: '2026-09-04',
      reason: 'Issuance: Betrag zu hoch',
    });
    assert.ok(exceeding.statusCode >= 400, exceeding.body);
    const earlyFinal = await harness.issue({
      operation: 'settlement_invoice',
      id: failedIds[1],
      orderId: orderPayload.id,
      kind: 'final_invoice',
      amount: 10,
      date: '2026-09-04',
      reason: 'Issuung: Schlussrechnung zu früh',
    });
    assert.ok(earlyFinal.statusCode >= 400, earlyFinal.body);
    const oversizedCorrection = await harness.issue({
      operation: 'correction',
      id: failedIds[2],
      invoiceId: settlePayload.id,
      kind: 'credit_note',
      amount: 500,
      date: '2026-09-04',
      reason: 'Issuance: Gutschrift zu hoch',
    });
    assert.ok(oversizedCorrection.statusCode >= 400, oversizedCorrection.body);
    for (const failedId of failedIds) {
      assert.equal(
        await countRows(harness.database, 'SELECT count(*)::int AS count FROM invoices WHERE tenant_id=$1 AND id=$2', [harness.tenantId, failedId]),
        0,
        failedId,
      );
      assert.equal(
        await countRows(harness.database, 'SELECT count(*)::int AS count FROM document_issuance_receipts WHERE tenant_id=$1 AND operation_id=$2', [harness.tenantId, failedId]),
        0,
        failedId,
      );
    }
    assert.equal(
      await countRows(harness.database, 'SELECT count(*)::int AS count FROM number_reservations WHERE tenant_id=$1', [harness.tenantId]),
      reservationsBeforeBounds,
    );
    assert.equal(
      await countRows(harness.database, 'SELECT count(*)::int AS count FROM invoices WHERE tenant_id=$1', [harness.tenantId]),
      documentsBeforeBounds,
    );

    // Case 10: the mutation role guard runs last because it poisons the session.
    harness.app.localSession!.role = 'viewer';
    const denied = await harness.issue({
      operation: 'delivery_note',
      id: `denied-${suffix}`,
      orderId: orderPayload.id,
      date: '2026-09-04',
      reason: 'Issuance: gesperrt',
    });
    assert.equal(denied.statusCode, 403);
  });
}

test('pro document-chain issuance posts billing documents, skips non-billing kinds, allocates corrections, and rolls back mid-failure', async (t) => {
  const harness = await setup('pro');
  t.after(() => harness.app.close());
  const suffix = `pro-post-${randomUUID().slice(0, 8)}`;
  await harness.seedPostingMappings();
  const offer = await harness.seedOffer();

  // Case 2: a billing settlement posts journal and open item atomically.
  const orderPayload = {
    operation: 'order_confirmation',
    id: `order-${suffix}`,
    offerId: offer.id,
    date: '2026-09-04',
    dueDate: '2026-09-18',
    reason: 'Issuance: Auftragsbestätigung',
  };
  const orderRes = await harness.issue(orderPayload);
  assert.equal(orderRes.statusCode, 200, orderRes.body);
  const order = orderRes.json();
  const settlementId = `settlement-${suffix}`;
  const settlementRes = await harness.issue({
    operation: 'settlement_invoice',
    id: settlementId,
    orderId: orderPayload.id,
    kind: 'advance_invoice',
    amount: 40,
    date: '2026-09-04',
    reason: 'Issuance: Abschlag buchen',
  });
  assert.equal(settlementRes.statusCode, 200, settlementRes.body);
  const settlement = settlementRes.json();
  assert.notEqual(settlement.number, order.number);
  const settlementRow = await harness.database.query<{ accounting_status: string }>(
    'SELECT accounting_status FROM invoices WHERE tenant_id=$1 AND id=$2',
    [harness.tenantId, settlementId],
  );
  assert.equal(settlementRow.rows[0]?.accounting_status, 'posted');
  assert.equal(
    await countRows(harness.database, 'SELECT count(*)::int AS count FROM journal_entries WHERE tenant_id=$1 AND source_key=$2', [harness.tenantId, `outgoing-invoice:${settlementId}`]),
    1,
  );
  assert.equal(
    await countRows(harness.database, 'SELECT count(*)::int AS count FROM open_items WHERE tenant_id=$1 AND source_id=$2', [harness.tenantId, settlementId]),
    1,
  );
  assert.equal(
    await countRows(harness.database, 'SELECT count(*)::int AS count FROM document_issuance_receipts WHERE tenant_id=$1', [harness.tenantId]),
    2,
  );

  // Case 3: non-billing chain documents stay outside journal/OPOS.
  const deliveryId = `delivery-${suffix}`;
  const deliveryRes = await harness.issue({
    operation: 'delivery_note',
    id: deliveryId,
    orderId: orderPayload.id,
    date: '2026-09-04',
    reason: 'Issuance: Lieferschein ohne Buchung',
  });
  assert.equal(deliveryRes.statusCode, 200, deliveryRes.body);
  const deliveryRow = await harness.database.query<{ accounting_status: string }>(
    'SELECT accounting_status FROM invoices WHERE tenant_id=$1 AND id=$2',
    [harness.tenantId, deliveryId],
  );
  assert.equal(deliveryRow.rows[0]?.accounting_status, 'unposted');
  const referencedJournals = await harness.database.query(
    'SELECT id FROM journal_entries WHERE tenant_id=$1 AND (source_key = $2 OR source_key = $3)',
    [harness.tenantId, `outgoing-invoice:${orderPayload.id}`, `outgoing-invoice:${deliveryId}`],
  );
  assert.equal(referencedJournals.rows.length, 0);

  // Case 4: a posted credit note allocates against the source open item once.
  const creditId = `credit-${suffix}`;
  const creditRes = await harness.issue({
    operation: 'correction',
    id: creditId,
    invoiceId: settlementId,
    kind: 'credit_note',
    amount: 20,
    date: '2026-09-04',
    reason: 'Issuance: Gutschrift',
  });
  assert.equal(creditRes.statusCode, 200, creditRes.body);
  assert.equal(
    await countRows(harness.database, 'SELECT count(*)::int AS count FROM journal_entries WHERE tenant_id=$1 AND source_key=$2', [harness.tenantId, `outgoing-correction:${creditId}`]),
    1,
  );
  const sourceItem = await harness.database.query<{ allocated_amount: string }>(
    'SELECT allocated_amount FROM open_items WHERE tenant_id=$1 AND source_id=$2',
    [harness.tenantId, settlementId],
  );
  assert.equal(Number(sourceItem.rows[0]?.allocated_amount), 20);

  // Case 5: a failure inside posting rolls back every effect; the same id retries.
  const targetId = `rollback-${suffix}`;
  const settingsBefore = await harness.database.query(
    'SELECT settings_json FROM server_settings WHERE tenant_id=$1',
    [harness.tenantId],
  );
  const reservationsBefore = await harness.database.query(
    'SELECT count(*)::int AS count FROM number_reservations WHERE tenant_id=$1',
    [harness.tenantId],
  );
  const triggerName = `issuance_fail_${randomUUID().replaceAll('-', '')}`;
  await harness.database.query(
    `CREATE OR REPLACE FUNCTION ${triggerName}() RETURNS trigger AS $$ BEGIN IF NEW.source_key = 'outgoing-invoice:${targetId}' THEN RAISE EXCEPTION 'Injected issuance failure'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql`,
  );
  await harness.database.query(
    `CREATE TRIGGER ${triggerName} BEFORE INSERT ON journal_entries FOR EACH ROW EXECUTE FUNCTION ${triggerName}()`,
  );
  try {
    const failedPayload = {
      operation: 'settlement_invoice',
      id: targetId,
      orderId: orderPayload.id,
      kind: 'partial_invoice',
      amount: 15,
      date: '2026-09-04',
      reason: 'Issuance: scheitert',
    };
    const failed = await harness.issue(failedPayload);
    assert.ok(failed.statusCode >= 400, failed.body);
    assert.equal(
      await countRows(harness.database, 'SELECT count(*)::int AS count FROM invoices WHERE tenant_id=$1 AND id=$2', [harness.tenantId, targetId]),
      0,
    );
    assert.equal(
      await countRows(harness.database, 'SELECT count(*)::int AS count FROM document_issuance_receipts WHERE tenant_id=$1 AND operation_id=$2', [harness.tenantId, targetId]),
      0,
    );
    assert.deepEqual(
      (await harness.database.query('SELECT count(*)::int AS count FROM number_reservations WHERE tenant_id=$1', [harness.tenantId])).rows,
      reservationsBefore.rows,
    );
    assert.deepEqual(
      (await harness.database.query('SELECT settings_json FROM server_settings WHERE tenant_id=$1', [harness.tenantId])).rows,
      settingsBefore.rows,
    );
    assert.equal(
      await countRows(harness.database, 'SELECT count(*)::int AS count FROM audit_log WHERE tenant_id=$1 AND entity_id=$2', [harness.tenantId, targetId]),
      0,
    );
    assert.equal(
      await countRows(harness.database, 'SELECT count(*)::int AS count FROM open_items WHERE tenant_id=$1 AND source_id=$2', [harness.tenantId, targetId]),
      0,
    );
    assert.equal(
      await countRows(harness.database, 'SELECT count(*)::int AS count FROM journal_entries WHERE tenant_id=$1 AND source_key=$2', [harness.tenantId, `outgoing-invoice:${targetId}`]),
      0,
    );
  } finally {
    await harness.database.query(`DROP TRIGGER ${triggerName} ON journal_entries`);
    await harness.database.query(`DROP FUNCTION ${triggerName}()`);
  }
  const retried = await harness.issue({
    operation: 'settlement_invoice',
    id: targetId,
    orderId: orderPayload.id,
    kind: 'partial_invoice',
    amount: 15,
    date: '2026-09-04',
    reason: 'Issuance: scheitert',
  });
  assert.equal(retried.statusCode, 200, retried.body);
});
