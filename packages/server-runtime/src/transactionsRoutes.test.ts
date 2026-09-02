import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { PgliteServerDatabase } from '@billme/server-data';
import { buildServerApi } from './app.js';

test('embedded Pro transactions list is tenant scoped and supports filters', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-embedded-transactions-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const token = 'transactions-local-token';
  const tenantId = 'transactions-tenant';
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'pro',
    logger: false,
    sessionSecret: 'embedded-transactions-test-secret-32-chars',
    localAuth: {
      accessToken: token,
      tenantId,
      userId: 'transactions-user',
      email: 'transactions@example.test',
      fullName: 'Transactions Owner',
    },
  });

  try {
    const now = new Date().toISOString();
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'pro', 'single-tenant', 'active', $4, $4)`,
      [tenantId, tenantId, 'Transactions', now],
    );
    await database.query(
      `INSERT INTO accounts (id, tenant_id, name, iban, balance, default_skr_account_number, type, color)
       VALUES ($1, $2, 'Bank', 'DE123', 0, '1200', 'bank', '#000000')`,
      ['transactions-account', tenantId],
    );
    await database.query(
      `INSERT INTO transactions
        (id, tenant_id, account_id, date, amount, type, counterparty, purpose, linked_invoice_id, status, dedup_hash, import_batch_id)
       VALUES
        ('transaction-income', $1, 'transactions-account', '2026-08-01', 119, 'income', 'Customer', 'Invoice RE-1', NULL, 'booked', NULL, NULL),
        ('transaction-expense', $1, 'transactions-account', '2026-08-02', -20, 'expense', 'Hosting', 'Hosting', NULL, 'pending', NULL, NULL)`,
      [tenantId],
    );
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/pro/transactions?type=income&unlinkedOnly=true',
      headers: { 'x-billme-local-token': token },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json().map((row: { id: string }) => row.id), ['transaction-income']);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('embedded Lite finance import preview parses mapped CSV without writing transactions or batches', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-embedded-import-preview-'));
  const csvPath = join(dataDir, 'payments.csv');
  await writeFile(csvPath, 'Date,Amount,Name,Purpose\n2026-08-01,119.00,Customer,Invoice RE-1\n');
  const database = await PgliteServerDatabase.open(join(dataDir, 'pglite'));
  const token = 'import-preview-local-token';
  const tenantId = 'import-preview-tenant';
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'lite',
    logger: false,
    sessionSecret: 'embedded-import-preview-test-secret-32-chars',
    localAuth: {
      accessToken: token,
      tenantId,
      userId: 'import-preview-user',
      email: 'import-preview@example.test',
      fullName: 'Import Preview Owner',
    },
  });

  try {
    await app.ready();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/lite/finance/import/preview',
      headers: { 'x-billme-local-token': token },
      payload: {
        path: csvPath,
        profile: 'generic',
        mapping: {
          dateColumn: 'Date',
          amountColumn: 'Amount',
          counterpartyColumn: 'Name',
          purposeColumn: 'Purpose',
        },
        delimiter: ',',
        encoding: 'utf8',
        accountIdForDedupHash: 'import-preview-account',
      },
    });

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().fileName, 'payments.csv');
    assert.equal(response.json().profile, 'generic');
    assert.deepEqual(response.json().stats, { totalRows: 1, previewRows: 1, validRows: 1, errorRows: 0 });
    assert.equal(response.json().rows[0].parsed.amount, 119);
    assert.match(response.json().rows[0].dedupHash, /^[a-f0-9]{64}$/);
    const batches = await database.query<{ count: string }>('SELECT count(*)::text AS count FROM import_batches');
    const transactions = await database.query<{ count: string }>('SELECT count(*)::text AS count FROM transactions');
    assert.equal(Number(batches.rows[0]?.count), 0);
    assert.equal(Number(transactions.rows[0]?.count), 0);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('embedded Lite finance import commit persists valid rows once and replays the same batch by file hash', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-embedded-import-commit-'));
  const csvPath = join(dataDir, 'payments.csv');
  await writeFile(csvPath, 'Date,Amount,Name,Purpose\n2026-08-01,119.00,Customer,Invoice RE-1\n2026-08-02,20.00,Hosting,Hosting\n2026-08-03,nope,Invalid,Rejected\n');
  const database = await PgliteServerDatabase.open(join(dataDir, 'pglite'));
  const token = 'import-commit-local-token';
  const tenantId = 'import-commit-tenant';
  const accountId = 'import-commit-account';
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'lite',
    logger: false,
    sessionSecret: 'embedded-import-commit-test-secret-32-chars',
    localAuth: {
      accessToken: token,
      tenantId,
      userId: 'import-commit-user',
      email: 'import-commit@example.test',
      fullName: 'Import Commit Owner',
    },
  });

  try {
    const now = new Date().toISOString();
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'lite', 'single-tenant', 'active', $4, $4)`,
      [tenantId, tenantId, 'Import Commit', now],
    );
    await database.query(
      `INSERT INTO accounts (id, tenant_id, name, iban, balance, default_skr_account_number, type, color)
       VALUES ($1, $2, 'Bank', 'DE123', 0, '1200', 'bank', '#000000')`,
      [accountId, tenantId],
    );
    await app.ready();
    const payload = {
      path: csvPath,
      accountId,
      profile: 'generic',
      mapping: { dateColumn: 'Date', amountColumn: 'Amount', counterpartyColumn: 'Name', purposeColumn: 'Purpose' },
      delimiter: ',',
      encoding: 'utf8',
    };
    const headers = { 'x-billme-local-token': token };
    const first = await app.inject({ method: 'POST', url: '/api/v1/lite/finance/import/commit', headers, payload });
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.json().imported, 2);
    assert.equal(first.json().skipped, 0);
    assert.equal(first.json().errors.length, 1);
    assert.equal(first.json().errors[0].rowIndex, 4);

    const second = await app.inject({ method: 'POST', url: '/api/v1/lite/finance/import/commit', headers, payload });
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(second.json().batchId, first.json().batchId);
    assert.equal(second.json().imported, 2);
    assert.equal(second.json().skipped, 0);

    const batches = await database.query<{ count: string }>('SELECT count(*)::text AS count FROM import_batches WHERE tenant_id = $1', [tenantId]);
    const transactions = await database.query<{ count: string }>('SELECT count(*)::text AS count FROM transactions WHERE tenant_id = $1 AND deleted_at IS NULL', [tenantId]);
    assert.equal(Number(batches.rows[0]?.count), 1);
    assert.equal(Number(transactions.rows[0]?.count), 2);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('embedded Lite finance import history is tenant scoped and rollback is audited, atomic, and one-shot', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-embedded-import-history-'));
  const csvPath = join(dataDir, 'payments.csv');
  await writeFile(csvPath, 'Date,Amount,Name,Purpose\n2026-08-04,42.00,Customer,Invoice RE-2\n');
  const database = await PgliteServerDatabase.open(join(dataDir, 'pglite'));
  const token = 'import-history-local-token';
  const tenantId = 'import-history-tenant';
  const accountId = 'import-history-account';
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'lite',
    logger: false,
    sessionSecret: 'embedded-import-history-test-secret-32-chars',
    localAuth: {
      accessToken: token,
      tenantId,
      userId: 'import-history-user',
      email: 'import-history@example.test',
      fullName: 'Import History Owner',
    },
  });

  try {
    const now = new Date().toISOString();
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'lite', 'single-tenant', 'active', $4, $4)`,
      [tenantId, tenantId, 'Import History', now],
    );
    await database.query(
      `INSERT INTO accounts (id, tenant_id, name, iban, balance, default_skr_account_number, type, color)
       VALUES ($1, $2, 'Bank', 'DE123', 0, '1200', 'bank', '#000000')`,
      [accountId, tenantId],
    );
    await app.ready();
    const headers = { 'x-billme-local-token': token };
    const commit = await app.inject({
      method: 'POST',
      url: '/api/v1/lite/finance/import/commit',
      headers,
      payload: {
        path: csvPath,
        accountId,
        profile: 'generic',
        mapping: { dateColumn: 'Date', amountColumn: 'Amount', counterpartyColumn: 'Name', purposeColumn: 'Purpose' },
        delimiter: ',',
      },
    });
    assert.equal(commit.statusCode, 200, commit.body);
    const batchId = commit.json().batchId as string;

    const listed = await app.inject({ method: 'GET', url: `/api/v1/lite/finance/import-batches?accountId=${accountId}`, headers });
    assert.equal(listed.statusCode, 200, listed.body);
    assert.deepEqual(listed.json().map((batch: { id: string }) => batch.id), [batchId]);
    const detail = await app.inject({ method: 'GET', url: `/api/v1/lite/finance/import-batches/${batchId}`, headers });
    assert.equal(detail.statusCode, 200, detail.body);
    assert.equal(detail.json().canRollback, true);
    assert.equal(detail.json().transactions.length, 1);

    await database.query('UPDATE transactions SET linked_invoice_id = $1 WHERE tenant_id = $2 AND import_batch_id = $3', ['linked-invoice', tenantId, batchId]);
    const unsafe = await app.inject({
      method: 'POST',
      url: `/api/v1/lite/finance/import-batches/${batchId}/rollback`,
      headers,
      payload: { reason: 'Rollback with linked transaction' },
    });
    assert.equal(unsafe.statusCode, 409, unsafe.body);

    await database.query('UPDATE transactions SET linked_invoice_id = NULL WHERE tenant_id = $1 AND import_batch_id = $2', [tenantId, batchId]);
    const rollback = await app.inject({
      method: 'POST',
      url: `/api/v1/lite/finance/import-batches/${batchId}/rollback`,
      headers,
      payload: { reason: 'Import versehentlich doppelt geprüft' },
    });
    assert.equal(rollback.statusCode, 200, rollback.body);
    assert.equal(rollback.json().deletedCount, 1);
    const after = await app.inject({ method: 'GET', url: `/api/v1/lite/finance/import-batches/${batchId}`, headers });
    assert.equal(after.statusCode, 200, after.body);
    assert.equal(after.json().canRollback, false);
    assert.equal(after.json().transactions.length, 0);

    const repeated = await app.inject({
      method: 'POST',
      url: `/api/v1/lite/finance/import-batches/${batchId}/rollback`,
      headers,
      payload: { reason: 'Noch einmal' },
    });
    assert.equal(repeated.statusCode, 409, repeated.body);
    const audits = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log
       WHERE tenant_id = $1 AND entity_type = 'finance_import' AND entity_id = $2 AND action = 'finance_import.rollback'`,
      [tenantId, batchId],
    );
    assert.equal(Number(audits.rows[0]?.count), 1);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('embedded Pro transaction link and unlink update invoice, transaction, and audit atomically', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-embedded-transaction-link-'));
  const database = await PgliteServerDatabase.open(dataDir);
  const token = 'transaction-link-local-token';
  const tenantId = 'transaction-link-tenant';
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'pro',
    logger: false,
    sessionSecret: 'embedded-transaction-link-test-secret-32-chars',
    localAuth: {
      accessToken: token,
      tenantId,
      userId: 'transaction-link-user',
      email: 'transaction-link@example.test',
      fullName: 'Transaction Link Owner',
    },
  });

  try {
    const now = new Date().toISOString();
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'pro', 'single-tenant', 'active', $4, $4)`,
      [tenantId, tenantId, 'Transaction Link', now],
    );
    await database.query(
      `INSERT INTO accounts (id, tenant_id, name, iban, balance, default_skr_account_number, type, color)
       VALUES ($1, $2, 'Bank', 'DE123', 0, '1200', 'bank', '#000000')`,
      ['transaction-link-account', tenantId],
    );
    await database.query(
      `INSERT INTO transactions
        (id, tenant_id, account_id, date, amount, type, counterparty, purpose, linked_invoice_id, status, dedup_hash, import_batch_id)
       VALUES ('transaction-link-source', $1, 'transaction-link-account', '2026-08-01', 119, 'income', 'Customer', 'Invoice RE-1', NULL, 'booked', NULL, NULL)`,
      [tenantId],
    );
    await database.query(
      `INSERT INTO invoices
        (id, tenant_id, number, client, client_email, date, due_date, amount, status, items_json, payments_json, history_json, tax_mode)
       VALUES ('transaction-link-invoice', $1, 'RE-1', 'Customer GmbH', 'customer@example.test', '2026-07-01', '2026-08-15', 119, 'open', '[]', '[]', '[]', 'standard_vat')`,
      [tenantId],
    );
    await app.ready();
    const headers = { 'x-billme-local-token': token };

    const link = await app.inject({
      method: 'POST',
      url: '/api/v1/pro/transactions/transaction-link-source/link',
      headers,
      payload: { invoiceId: 'transaction-link-invoice', reason: 'Zahlung zugeordnet' },
    });
    assert.equal(link.statusCode, 200, link.body);
    assert.equal(link.json().invoice.status, 'paid');

    const linked = await database.query<{ linked_invoice_id: string; payments_json: string; status: string }>(
      `SELECT t.linked_invoice_id, i.payments_json, i.status
       FROM transactions t JOIN invoices i ON i.id = t.linked_invoice_id
       WHERE t.tenant_id = $1 AND t.id = $2`,
      [tenantId, 'transaction-link-source'],
    );
    assert.equal(linked.rows[0]?.linked_invoice_id, 'transaction-link-invoice');
    assert.equal(JSON.parse(linked.rows[0]?.payments_json ?? '[]').length, 1);
    assert.equal(linked.rows[0]?.status, 'paid');

    const linkAudit = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_log WHERE tenant_id = $1 AND entity_id IN ($2, $3) AND reason = $4`,
      [tenantId, 'transaction-link-source', 'transaction-link-invoice', 'Zahlung zugeordnet'],
    );
    assert.equal(Number(linkAudit.rows[0]?.count), 2);

    const unlink = await app.inject({
      method: 'POST',
      url: '/api/v1/pro/transactions/transaction-link-source/unlink',
      headers,
      payload: { reason: 'Zahlungszuordnung aufgehoben' },
    });
    assert.equal(unlink.statusCode, 200, unlink.body);

    const unlinked = await database.query<{ linked_invoice_id: string | null; payments_json: string; status: string }>(
      `SELECT t.linked_invoice_id, i.payments_json, i.status
       FROM transactions t JOIN invoices i ON i.id = $2
       WHERE t.tenant_id = $1 AND t.id = $3`,
      [tenantId, 'transaction-link-invoice', 'transaction-link-source'],
    );
    assert.equal(unlinked.rows[0]?.linked_invoice_id, null);
    assert.deepEqual(JSON.parse(unlinked.rows[0]?.payments_json ?? '{}'), []);
    assert.equal(unlinked.rows[0]?.status, 'open');
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('transaction unlink removes only its stable payment when duplicate date and amount exist', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-embedded-transaction-payment-identity-'));
  const database = await PgliteServerDatabase.open(join(dataDir, 'pglite'));
  const token = 'transaction-payment-identity-token';
  const tenantId = 'transaction-payment-identity-tenant';
  const app = await buildServerApi({
    database,
    runtime: 'embedded',
    product: 'pro',
    logger: false,
    sessionSecret: 'embedded-transaction-payment-identity-secret-32-chars',
    localAuth: {
      accessToken: token,
      tenantId,
      userId: 'transaction-payment-identity-user',
      email: 'transaction-payment-identity@example.test',
      fullName: 'Transaction Payment Identity Owner',
    },
  });

  try {
    const now = new Date().toISOString();
    await database.query(
      `INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'pro', 'single-tenant', 'active', $4, $4)`,
      [tenantId, tenantId, 'Payment Identity', now],
    );
    await database.query(
      `INSERT INTO accounts (id, tenant_id, name, iban, balance, default_skr_account_number, type, color)
       VALUES ('transaction-payment-account', $1, 'Bank', 'DE123', 0, '1200', 'bank', '#000000')`,
      [tenantId],
    );
    await database.query(
      `INSERT INTO transactions
        (id, tenant_id, account_id, date, amount, type, counterparty, purpose, linked_invoice_id, status, dedup_hash, import_batch_id)
       VALUES
        ('transaction-payment-first', $1, 'transaction-payment-account', '2026-08-01', 50, 'income', 'Customer', 'First', NULL, 'booked', NULL, NULL),
        ('transaction-payment-second', $1, 'transaction-payment-account', '2026-08-01', 50, 'income', 'Customer', 'Second', NULL, 'booked', NULL, NULL)`,
      [tenantId],
    );
    await database.query(
      `INSERT INTO invoices
        (id, tenant_id, number, client, client_email, date, due_date, amount, status, items_json, payments_json, history_json, tax_mode)
       VALUES ('transaction-payment-invoice', $1, 'RE-PAYMENT', 'Customer GmbH', 'customer@example.test', '2026-07-01', '2026-08-15', 100, 'open', '[]', '[]', '[]', 'standard_vat')`,
      [tenantId],
    );
    await app.ready();
    const headers = { 'x-billme-local-token': token };
    for (const transactionId of ['transaction-payment-first', 'transaction-payment-second']) {
      const link = await app.inject({
        method: 'POST',
        url: `/api/v1/pro/transactions/${transactionId}/link`,
        headers,
        payload: { invoiceId: 'transaction-payment-invoice', reason: 'Zahlung zugeordnet' },
      });
      assert.equal(link.statusCode, 200, link.body);
    }
    const unlink = await app.inject({
      method: 'POST',
      url: '/api/v1/pro/transactions/transaction-payment-first/unlink',
      headers,
      payload: { reason: 'Erste Zahlung entlinkt' },
    });
    assert.equal(unlink.statusCode, 200, unlink.body);
    const invoice = await database.query<{ payments_json: string }>('SELECT payments_json FROM invoices WHERE tenant_id = $1 AND id = $2', [tenantId, 'transaction-payment-invoice']);
    assert.deepEqual(JSON.parse(invoice.rows[0]?.payments_json ?? '[]').map((payment: { id: string }) => payment.id), ['transaction-payment:transaction-payment-second']);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
