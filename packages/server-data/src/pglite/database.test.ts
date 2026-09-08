import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { billingLineItemSchema, createSingleTenantScope, type Invoice } from '@billme/server-core';
import { PgliteServerDatabase } from './database.js';
import { createPostgresInvoiceRepository } from '../postgres/billing.js';
import { resolveCanonicalMigrationDirectory } from '../postgres/migrations.js';

const openDatabase = async (): Promise<{
  database: PgliteServerDatabase;
  dataDir: string;
}> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-pglite-seam-'));
  return { database: await PgliteServerDatabase.open(dataDir), dataDir };
};

const closeDatabase = async (database: PgliteServerDatabase, dataDir: string): Promise<void> => {
  await database.close();
  await rm(dataDir, { recursive: true, force: true });
};

test('PGlite applies the canonical migrations and reports a current schema', async () => {
  const { database, dataDir } = await openDatabase();
  try {
    assert.equal(database.engine, 'pglite');
    assert.ok(database.drizzle());
    await assert.rejects(database.assertCurrent(), /schema is not initialized/i);
    await database.migrate();
    await database.assertCurrent();
    await database.migrate();
    await database.assertCurrent();

    const result = await database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations',
    );
    const canonicalMigrations = readMigrationFiles({
      migrationsFolder: resolveCanonicalMigrationDirectory(),
    });
    assert.equal(Number(result.rows[0]?.count), canonicalMigrations.length);
  } finally {
    await closeDatabase(database, dataDir);
  }
});

test('PGlite transactions commit, rollback, serialize, and remain reentrant', async () => {
  const { database, dataDir } = await openDatabase();
  try {
    await database.query('CREATE TABLE seam_values (id integer PRIMARY KEY, value text NOT NULL)');

    await database.transaction({}, async (session) => {
      await session.query('INSERT INTO seam_values (id, value) VALUES ($1, $2)', [1, 'committed']);
    });

    await assert.rejects(
      database.transaction({}, async (session) => {
        await session.query('INSERT INTO seam_values (id, value) VALUES ($1, $2)', [2, 'rolled back']);
        throw new Error('rollback marker');
      }),
      /rollback marker/,
    );

    const afterRollback = await database.query<{ id: number }>(
      'SELECT id FROM seam_values ORDER BY id',
    );
    assert.deepEqual(afterRollback.rows.map((row) => row.id), [1]);

    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let transactionStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      transactionStarted = resolve;
    });
    const first = database.transaction({}, async (session) => {
      await session.query('INSERT INTO seam_values (id, value) VALUES ($1, $2)', [3, 'first']);
      transactionStarted();
      await firstEntered;
      await session.query('UPDATE seam_values SET value = $1 WHERE id = $2', ['done', 3]);
    });
    await started;

    let secondFinished = false;
    const second = database
      .query<{ value: string }>('SELECT value FROM seam_values WHERE id = $1', [3])
      .then((result) => {
        secondFinished = true;
        return result;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(secondFinished, false);

    releaseFirst();
    await first;
    assert.equal((await second).rows[0]?.value, 'done');

    await database.transaction({}, async () => {
      await database.query('INSERT INTO seam_values (id, value) VALUES ($1, $2)', [4, 'outer']);
      await database.transaction({}, async (nestedSession) => {
        await nestedSession.query('INSERT INTO seam_values (id, value) VALUES ($1, $2)', [5, 'nested']);
      });
    });

    const reentrant = await database.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM seam_values',
    );
    assert.equal(Number(reentrant.rows[0]?.count), 4);
  } finally {
    await closeDatabase(database, dataDir);
  }
});

test('PGlite saves and refetches the shared outgoing document-chain fields', async () => {
  const { database, dataDir } = await openDatabase();
  const scope = createSingleTenantScope('pglite-chain', 'lite');
  try {
    await database.migrate();
    const now = new Date().toISOString();
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [scope.tenantId, scope.tenantId, 'PGlite chain test', scope.product, scope.deploymentMode, 'active', now],
    );
    const invoiceRepo = createPostgresInvoiceRepository(database);
    const invoice: Invoice = {
      kind: 'invoice',
      tenantId: scope.tenantId,
      id: 'chain-invoice-1',
      number: 'RE-CHAIN-1',
      documentKind: 'partial_invoice',
      sourceDocumentId: 'order-1',
      rootDocumentId: 'order-1',
      revisionOfId: undefined,
      revisionNumber: 0,
      client: 'PGlite Customer',
      clientEmail: 'billing@example.test',
      date: '2026-09-04',
      dueDate: '2026-09-18',
      amount: 50,
      status: 'draft',
      taxMode: 'standard_vat',
      items: [billingLineItemSchema.parse({ description: 'Service', quantity: 1, price: 50, total: 50, taxRate: 19 })],
      payments: [],
      history: [],
    };
    await invoiceRepo.save(scope, invoice);
    const refetched = await invoiceRepo.getById(scope, invoice.id);
    assert.equal(refetched?.documentKind, 'partial_invoice');
    assert.equal(refetched?.sourceDocumentId, 'order-1');
    assert.equal(refetched?.rootDocumentId, 'order-1');
    assert.equal(refetched?.revisionNumber, 0);
    await database.query('DELETE FROM invoices WHERE tenant_id = $1 AND id = $2', [scope.tenantId, invoice.id]);
    await database.query('DELETE FROM tenants WHERE id = $1', [scope.tenantId]);
  } finally {
    await closeDatabase(database, dataDir);
  }
});
