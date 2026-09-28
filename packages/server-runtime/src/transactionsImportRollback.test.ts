import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PgliteServerDatabase } from '@billme/server-data';
import { buildServerApi } from './app.js';

const tenantId = 'import-rollback-tenant';
const accountId = 'import-rollback-account';
const token = 'import-rollback-local-token';
const headers = { 'x-billme-local-token': token };

const withProApp = async (
  csv: string,
  work: (context: { app: Awaited<ReturnType<typeof buildServerApi>>; database: PgliteServerDatabase; payload: Record<string, unknown> }) => Promise<void>,
): Promise<void> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-import-rollback-'));
  const csvPath = join(dataDir, 'payments.csv');
  await writeFile(csvPath, csv);
  const database = await PgliteServerDatabase.open(join(dataDir, 'pglite'));
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'pro',
    logger: false,
    sessionSecret: 'import-rollback-test-secret-32-characters',
    localAuth: { accessToken: token, tenantId, userId: 'import-rollback-user', email: 'rollback@example.test', fullName: 'Rollback Owner' },
  });
  try {
    const now = new Date().toISOString();
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at)
       VALUES ($1, $1, 'Import Rollback', 'pro', 'single-tenant', 'active', $2, $2)`,
      [tenantId, now],
    );
    await database.query(
      `INSERT INTO accounts (id, tenant_id, name, iban, balance, default_skr_account_number, type, color)
       VALUES ($1, $2, 'Bank', 'DE123', 0, '1200', 'bank', '#000000')`,
      [accountId, tenantId],
    );
    await app.ready();
    await work({
      app,
      database,
      payload: {
        path: csvPath,
        accountId,
        profile: 'generic',
        mapping: { dateColumn: 'Date', amountColumn: 'Amount', counterpartyColumn: 'Name', purposeColumn: 'Purpose' },
        delimiter: ',',
        encoding: 'utf8',
      },
    });
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
};

const counts = async (database: PgliteServerDatabase) => {
  const count = async (table: string) => Number((await database.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`)).rows[0]?.n);
  return {
    transactions: await count('transactions'),
    bankTransactions: await count('bank_transactions'),
    batches: await count('import_batches'),
    audits: Number((await database.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_log WHERE action = 'finance_import.commit'`)).rows[0]?.n),
  };
};

test('a failing bank_transactions insert rolls the whole import commit back and leaves the file retryable', async () => {
  await withProApp('Date,Amount,Name,Purpose\n2026-08-01,119.00,Customer,Invoice RE-1\n2026-08-02,20.00,Poison,Hosting\n', async ({ app, database, payload }) => {
    await database.query(`ALTER TABLE bank_transactions ADD CONSTRAINT reject_poison CHECK (counterparty <> 'Poison')`);

    const failed = await app.inject({ method: 'POST', url: '/api/v1/pro/finance/import/commit', headers, payload });
    assert.equal(failed.statusCode, 500, failed.body);
    assert.deepEqual(await counts(database), { transactions: 0, bankTransactions: 0, batches: 0, audits: 0 });

    await database.query('ALTER TABLE bank_transactions DROP CONSTRAINT reject_poison');
    const retried = await app.inject({ method: 'POST', url: '/api/v1/pro/finance/import/commit', headers, payload });
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(retried.json().imported, 2);
    assert.deepEqual(await counts(database), { transactions: 2, bankTransactions: 2, batches: 1, audits: 1 });
  });
});

test('linking or unlinking a transaction of a rolled-back import answers TRANSACTION_NOT_FOUND', async () => {
  await withProApp('Date,Amount,Name,Purpose\n2026-08-01,119.00,Customer,Invoice RE-1\n', async ({ app, database, payload }) => {
    const commit = await app.inject({ method: 'POST', url: '/api/v1/pro/finance/import/commit', headers, payload });
    assert.equal(commit.statusCode, 200, commit.body);
    const batchId = commit.json().batchId as string;
    const transactionId = (await database.query<{ id: string }>('SELECT id FROM transactions WHERE import_batch_id = $1', [batchId])).rows[0]!.id;
    await database.query(
      `INSERT INTO invoices
        (id, tenant_id, number, client, client_email, date, due_date, amount, status, items_json, payments_json, history_json, tax_mode)
       VALUES ('rollback-invoice', $1, 'RE-1', 'Customer GmbH', 'customer@example.test', '2026-07-01', '2026-08-15', 119, 'open', '[]', '[]', '[]', 'standard_vat')`,
      [tenantId],
    );

    const rollback = await app.inject({
      method: 'POST',
      url: `/api/v1/pro/finance/import-batches/${batchId}/rollback`,
      headers,
      payload: { reason: 'Falsche Datei' },
    });
    assert.equal(rollback.statusCode, 200, rollback.body);

    const link = await app.inject({
      method: 'POST',
      url: `/api/v1/pro/transactions/${transactionId}/link`,
      headers,
      payload: { invoiceId: 'rollback-invoice', reason: 'Zuordnung' },
    });
    assert.equal(link.statusCode, 404, link.body);
    assert.match(link.body, /TRANSACTION_NOT_FOUND/);

    const unlink = await app.inject({
      method: 'POST',
      url: `/api/v1/pro/transactions/${transactionId}/unlink`,
      headers,
      payload: { reason: 'Aufhebung' },
    });
    assert.equal(unlink.statusCode, 404, unlink.body);
    assert.match(unlink.body, /TRANSACTION_NOT_FOUND/);

    const invoice = await database.query<{ payments_json: string; status: string }>(`SELECT payments_json, status FROM invoices WHERE id = 'rollback-invoice'`);
    assert.deepEqual(JSON.parse(invoice.rows[0]!.payments_json), []);
    assert.equal(invoice.rows[0]!.status, 'open');
  });
});
