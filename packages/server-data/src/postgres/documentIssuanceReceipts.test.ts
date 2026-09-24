import assert from 'node:assert/strict';
import test from 'node:test';
import { PgliteServerDatabase } from '../pglite/database.js';

const RECEIPT_TABLE_PRESENCE =
  "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'document_issuance_receipts'";

const insertReceipt = (
  database: PgliteServerDatabase,
  id: string,
  operationId: string,
  createdAt: string,
): Promise<unknown> =>
  database.query(
    `INSERT INTO document_issuance_receipts
       (id, tenant_id, product, operation_id, intent_version, intent_hash, document_id, reservation_id, response_json, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      'receipt-tenant',
      'pro',
      operationId,
      1,
      'a'.repeat(64),
      `doc-${id}`,
      `res-${id}`,
      `{"id":"doc-${id}"}`,
      createdAt,
    ],
  );

test('document issuance receipts gain incrementally and enforce their constraints', async () => {
  const database = await PgliteServerDatabase.open();
  try {
    await database.migrate();

    // Upgrade simulation: rewind to the pre-0028 state of an existing
    // deployment (0028 and every later migration), then let the incremental
    // migrations gain the table again. Later migrations are idempotent.
    const migration0028CreatedAt = 1788528600003;
    await database.query('DROP TABLE document_issuance_receipts');
    await database.query('DELETE FROM drizzle.__drizzle_migrations WHERE created_at >= $1', [migration0028CreatedAt]);
    await database.migrate();
    const present = await database.query<{ table_name: string }>(RECEIPT_TABLE_PRESENCE);
    assert.equal(present.rows[0]?.table_name, 'document_issuance_receipts');

    const now = new Date().toISOString();
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      ['receipt-tenant', 'receipt-tenant', 'Receipt tenant', 'pro', 'single-tenant', 'active', now],
    );

    await insertReceipt(database, 'receipt-1', 'operation-1', now);
    const roundTrip = await database.query<{
      id: string;
      tenant_id: string;
      product: string;
      operation_id: string;
      intent_version: number;
      intent_hash: string;
      document_id: string;
      reservation_id: string;
      response_json: string;
      created_at: string;
    }>(
      `SELECT id, tenant_id, product, operation_id, intent_version, intent_hash,
              document_id, reservation_id, response_json, created_at
       FROM document_issuance_receipts WHERE id = $1`,
      ['receipt-1'],
    );
    assert.deepEqual(roundTrip.rows[0], {
      id: 'receipt-1',
      tenant_id: 'receipt-tenant',
      product: 'pro',
      operation_id: 'operation-1',
      intent_version: 1,
      intent_hash: 'a'.repeat(64),
      document_id: 'doc-receipt-1',
      reservation_id: 'res-receipt-1',
      response_json: '{"id":"doc-receipt-1"}',
      created_at: now,
    });

    await assert.rejects(
      insertReceipt(database, 'receipt-2', 'operation-1', now),
      (error: unknown) =>
        typeof error === 'object' && error !== null && 'code' in error && error.code === '23505',
    );

    await assert.rejects(
      database.query(
        "UPDATE document_issuance_receipts SET response_json = 'tampered' WHERE id = $1",
        ['receipt-1'],
      ),
      /document_issuance_receipts is immutable/,
    );
  } finally {
    await database.close();
  }
});
