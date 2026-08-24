import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { startEmbeddedServer, type EmbeddedServerHandle } from '@billme/embedded-server-runtime';
import { bootstrapSql } from '../../../apps/desktop/db/bootstrap.js';
import { bootstrapSql as proBootstrapSql } from '../../../apps/pro-desktop/db/bootstrap.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const migrationCli = resolve(repositoryRoot, 'packages/pglite-migration-cli/bin/billme-pglite-migrate.mjs');

type ChildResult = { readonly code: number | null; readonly stdout: string; readonly stderr: string };

const runMigrationProcess = (args: readonly string[]): Promise<ChildResult> => new Promise((resolveProcess, reject) => {
  const child = spawn(process.execPath, [migrationCli, ...args], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { stdout += chunk; });
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  child.once('error', reject);
  child.once('close', (code) => resolveProcess({ code, stdout, stderr }));
});

const createLiteFixture = async (sqlitePath: string): Promise<void> => {
  const db = new Database(sqlitePath);
  try {
    db.exec(bootstrapSql);
    db.prepare(`
      INSERT INTO clients (id, customer_number, company, contact_person, email, phone, address, status, avatar, tags_json, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('lite-client-1', 'KD-0001', 'PGlite Lite GmbH', 'Lena Lite', 'lite@example.test', '+49 711 100', 'Liteweg 1', 'active', null, '[]', 'subprocess fixture');
    db.prepare(`
      INSERT INTO client_addresses (id, client_id, label, kind, company, contact_person, street, line2, zip, city, country, is_default_billing, is_default_shipping, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('lite-address-1', 'lite-client-1', 'Rechnung', 'billing', 'PGlite Lite GmbH', 'Lena Lite', 'Liteweg 1', null, '70173', 'Stuttgart', 'DE', 1, 0, '2026-01-15T10:00:00.000Z', '2026-01-15T10:00:00.000Z');
    db.prepare(`
      INSERT INTO client_emails (id, client_id, label, kind, email, is_default_general, is_default_billing, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('lite-email-1', 'lite-client-1', 'Allgemein', 'general', 'lite-billing@example.test', 1, 1, '2026-01-15T10:00:00.000Z', '2026-01-15T10:00:00.000Z');
    db.prepare(`
      INSERT INTO client_projects (id, client_id, code, name, status, budget, start_date, end_date, description, archived_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('lite-project-1', 'lite-client-1', 'PRJ-2026-001', 'Lite E2E Projekt', 'active', 5000, '2026-01-01', null, 'Imported project', null, '2026-01-15T10:00:00.000Z', '2026-01-15T10:00:00.000Z');
    db.prepare(`
      INSERT INTO client_activities (id, client_id, type, content, date, author)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('lite-activity-1', 'lite-client-1', 'note', 'Imported activity', '2026-01-15', 'Lena Lite');
    db.prepare(`
      INSERT INTO invoices (id, client_id, client_number, number, client, client_email, client_address, date, due_date, service_period, amount, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('lite-invoice-1', 'lite-client-1', 'KD-0001', 'RE-2026-0001', 'PGlite Lite GmbH', 'lite@example.test', 'Liteweg 1', '2026-01-15', '2026-01-29', null, 119, 'open', '2026-01-15T10:00:00.000Z', '2026-01-15T10:00:00.000Z');
    db.prepare(`
      INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('lite-invoice-1', 1, 'Lite fixture service', 1, 100, 119, 19);
    db.prepare(`
      INSERT INTO invoice_payments (id, invoice_id, date, amount, method)
      VALUES (?, ?, ?, ?, ?)
    `).run('lite-payment-1', 'lite-invoice-1', '2026-01-20', 119, 'bank');
    db.prepare(`
      INSERT INTO offers (id, client_id, client_number, number, client, client_email, client_address, date, valid_until, amount, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('lite-offer-1', 'lite-client-1', 'KD-0001', 'AN-2026-0001', 'PGlite Lite GmbH', 'lite@example.test', 'Liteweg 1', '2026-01-20', '2026-02-20', 59.5, 'draft', '2026-01-20T10:00:00.000Z', '2026-01-20T10:00:00.000Z');
    db.prepare(`
      INSERT INTO offer_items (offer_id, position, description, quantity, price, total, tax_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('lite-offer-1', 1, 'Lite fixture offer', 1, 50, 59.5, 19);
    db.prepare(`
      INSERT INTO articles (id, sku, title, description, price, unit, category, tax_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('lite-article-1', 'LITE-001', 'Lite fixture article', 'Imported article', 50, 'Stück', 'Services', 19);
    db.prepare(`
      INSERT INTO recurring_profiles (id, client_id, active, name, interval, next_run, last_run, end_date, amount, items_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('lite-recurring-1', 'lite-client-1', 1, 'Lite fixture recurring', 'monthly', '2026-02-15', null, null, 119, JSON.stringify([{ description: 'Recurring service', quantity: 1, price: 100, total: 119 }]));
    db.prepare(`
      INSERT INTO templates (id, kind, name, elements_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('lite-template-1', 'invoice', 'Lite E2E template', '[]', '2026-01-15T10:00:00.000Z', '2026-01-15T10:00:00.000Z');
    db.prepare(`
      INSERT INTO active_templates (id, invoice_template_id, offer_template_id)
      VALUES (?, ?, ?)
    `).run(1, 'lite-template-1', null);
    db.prepare('INSERT INTO settings (id, settings_json) VALUES (?, ?)').run(1, JSON.stringify({
      company: { name: 'PGlite Lite GmbH', owner: 'Lena Lite', street: 'Liteweg 1', zip: '70173', city: 'Stuttgart', email: 'lite@example.test', phone: '', website: '' },
      finance: { bankName: '', iban: '', bic: '', taxId: '', vatId: '', registerCourt: '' },
      numbers: { invoicePrefix: 'RE-', nextInvoiceNumber: 1, numberLength: 4, offerPrefix: 'AN-', nextOfferNumber: 1, customerPrefix: 'KD-', nextCustomerNumber: 1, customerNumberLength: 4 },
      dunning: { levels: [] },
      legal: { smallBusinessRule: false, defaultVatRate: 19, countryCode: 'DE', taxAccountingMethod: 'soll', paymentTermsDays: 14, defaultIntroText: '', defaultFooterText: '' },
    }));
    db.prepare(`
      INSERT INTO number_reservations (id, kind, number, counter_value, status, document_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('lite-reservation-1', 'invoice', 'RE-2026-0002', 2, 'reserved', null, '2026-01-15T10:00:00.000Z', '2026-01-15T10:00:00.000Z');
  } finally {
    db.close();
  }
};

const createProFixture = async (sqlitePath: string): Promise<void> => {
  const db = new Database(sqlitePath);
  try {
    db.exec(proBootstrapSql);
    db.prepare(`
      INSERT INTO clients (id, customer_number, company, contact_person, email, phone, address, status, avatar, tags_json, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('pro-client-1', 'KD-9001', 'PGlite Pro AG', 'Max Pro', 'pro@example.test', '+49 711 900', 'Proweg 9', 'active', null, '[]', 'subprocess fixture');
    db.prepare(`
      INSERT INTO invoices (id, client_id, client_number, number, client, client_email, client_address, date, due_date, service_period, amount, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('pro-invoice-1', 'pro-client-1', 'KD-9001', 'PRO-2026-0001', 'PGlite Pro AG', 'pro@example.test', 'Proweg 9', '2026-02-15', '2026-03-01', null, 238, 'open', '2026-02-15T10:00:00.000Z', '2026-02-15T10:00:00.000Z');
    db.prepare(`
      INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('pro-invoice-1', 1, 'Pro fixture accounting service', 2, 100, 238, 19);
    db.prepare(`
      INSERT INTO accounts (id, name, iban, balance, default_skr_account_number, type, color)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('pro-account-1', 'Pro fixture bank', 'DE02120300000000202051', 2500, '1200', 'bank', '#2563eb');
    db.prepare(`
      INSERT INTO bank_transactions (id, account_id, date, amount, type, counterparty, purpose, linked_invoice_id, status, source_transaction_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('pro-bank-transaction-1', 'pro-account-1', '2026-02-16', 238, 'income', 'PGlite Pro AG', 'Pro fixture payment', 'pro-invoice-1', 'booked', null, '2026-02-16T10:00:00.000Z', '2026-02-16T10:00:00.000Z');
    db.prepare(`
      INSERT INTO transactions (id, account_id, date, amount, type, counterparty, purpose, linked_invoice_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('pro-transaction-1', 'pro-account-1', '2026-02-17', 238, 'income', 'PGlite Pro AG', 'Pro fixture imported transaction', 'pro-invoice-1', 'booked');
    db.prepare(`
      INSERT INTO journal_entries (id, tenant_id, entry_number, posting_date, document_date, booking_text, reference, period, fiscal_year, status, source_draft_id, reversed_entry_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('pro-journal-1', 'default', 9001, '2026-02-18', '2026-02-18', 'Pro fixture journal', 'PRO-E2E-1', '2026-02', 2026, 'posted', null, null, '2026-02-18T10:00:00.000Z');
    db.prepare(`
      INSERT INTO journal_lines (id, tenant_id, entry_id, line_no, account_number, debit_amount, credit_amount, tax_code, tax_case_key, tax_rate, net_amount, tax_amount, gross_amount, datev_sachverhalt_ll, country_code, counterparty_vat_id, evidence_type, evidence_reference, cost_center, memo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('pro-journal-line-1', 'default', 'pro-journal-1', 1, '9000', 238, 0, null, null, null, null, null, 238, null, null, null, null, null, null, 'Pro fixture debit');
    db.prepare(`
      INSERT INTO journal_lines (id, tenant_id, entry_id, line_no, account_number, debit_amount, credit_amount, tax_code, tax_case_key, tax_rate, net_amount, tax_amount, gross_amount, datev_sachverhalt_ll, country_code, counterparty_vat_id, evidence_type, evidence_reference, cost_center, memo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('pro-journal-line-2', 'default', 'pro-journal-1', 2, '4980', 0, 238, null, null, null, null, null, 238, null, null, null, null, null, null, 'Pro fixture credit');
    db.prepare(`
      INSERT INTO ledger_accounts (id, chart, account_number, name, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('pro-ledger-1', 'SKR03', '4980', 'Sonstiger Betriebsbedarf', 'desktop-e2e', '2026-02-15T10:00:00.000Z', '2026-02-15T10:00:00.000Z');
    db.prepare(`
      INSERT INTO pro_workflow_entries (tenant_id, transaction_id, transaction_json, draft_json, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run('default', 'pro-transaction-1', '{"amount":238}', '{"status":"ready"}', '2026-02-15T10:00:00.000Z');
  } finally {
    db.close();
  }
};

const json = async (url: string, token: string): Promise<{ response: Response; body: any }> => {
  const response = await fetch(url, { headers: { 'x-billme-local-token': token } });
  return { response, body: await response.json() };
};

const sha256 = (value: Buffer): string => createHash('sha256').update(value).digest('hex');

test('CLI subprocess migrates a real Lite SQLite fixture and embedded HTTP reads the imported data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'billme-pglite-cli-e2e-lite-'));
  let server: EmbeddedServerHandle | undefined;
  try {
    const sourcePath = join(root, 'lite.sqlite');
    const targetDataDir = join(root, 'lite-pglite');
    await createLiteFixture(sourcePath);

    const processResult = await runMigrationProcess([
      '--product', 'lite', '--source', sourcePath, '--target', targetDataDir,
      '--tenant-id', 'billme-local-tenant', '--tenant-slug', 'billme-local', '--tenant-name', 'Billme lokal',
    ]);
    assert.equal(processResult.code, 0, processResult.stderr);
    assert.equal(processResult.stderr, '');
    const receipt = JSON.parse(processResult.stdout) as {
      targetDataDir: string;
      backupPath: string;
      manifestPath: string;
      manifest: { product: string; counts: { clients: number; invoices: number; offers: number; articles: number; recurringProfiles: number; templates: number; activeTemplates: number; numberReservations: number } };
    };
    assert.equal(receipt.targetDataDir, targetDataDir);
    assert.equal(receipt.manifest.product, 'lite');
    assert.equal(receipt.manifest.counts.clients, 1);
    assert.equal(receipt.manifest.counts.invoices, 1);
    assert.equal(receipt.manifest.counts.offers, 1);
    assert.equal(receipt.manifest.counts.articles, 1);
    assert.equal(receipt.manifest.counts.recurringProfiles, 1);
    assert.equal(receipt.manifest.counts.templates, 1);
    assert.equal(receipt.manifest.counts.activeTemplates, 1);
    assert.equal(receipt.manifest.counts.numberReservations, 1);
    const manifest = JSON.parse(await readFile(receipt.manifestPath, 'utf8')) as typeof receipt.manifest;
    assert.deepEqual(manifest, receipt.manifest);
    assert.equal(await readFile(sourcePath, 'utf8').then(() => true), true);
    assert.equal(await readFile(receipt.backupPath, 'utf8').then(() => true), true);

    server = await startEmbeddedServer({
      userDataPath: root,
      dataDirName: 'lite-pglite',
      product: 'lite',
      identity: { tenantId: 'billme-local-tenant', userId: 'e2e-user', email: 'lite@example.test', fullName: 'Lite E2E' },
    });
    const liteHealth = await fetch(`${server.baseUrl}/health`);
    assert.equal(liteHealth.status, 200);
    const liteUnauthorized = await fetch(`${server.baseUrl}/api/v1/lite/clients`);
    assert.equal(liteUnauthorized.status, 401);
    const liteCapabilities = await json(`${server.baseUrl}/api/v1/meta/capabilities`, server.accessToken);
    assert.equal(liteCapabilities.response.status, 200);
    assert.deepEqual(liteCapabilities.body.products, ['lite']);
    assert.equal(liteCapabilities.body.runtime, 'embedded');
    assert.equal(liteCapabilities.body.database.local, 'pglite');
    assert.equal(liteCapabilities.body.database.production, 'postgres');
    assert.equal(liteCapabilities.body.auth.multiUser, false);
    const clients = await json(`${server.baseUrl}/api/v1/lite/clients`, server.accessToken);
    assert.equal(clients.response.status, 200, JSON.stringify(clients.body));
    assert.equal(clients.body[0]?.company, 'PGlite Lite GmbH');
    assert.equal(clients.body[0]?.addresses[0]?.city, 'Stuttgart');
    assert.equal(clients.body[0]?.emails[0]?.email, 'lite-billing@example.test');
    assert.equal(clients.body[0]?.projects[0]?.code, 'PRJ-2026-001');
    assert.equal(clients.body[0]?.activities[0]?.content, 'Imported activity');
    const invoices = await json(`${server.baseUrl}/api/v1/lite/invoices`, server.accessToken);
    assert.equal(invoices.response.status, 200, JSON.stringify(invoices.body));
    assert.equal(invoices.body[0]?.number, 'RE-2026-0001');
    assert.equal(invoices.body[0]?.items[0]?.description, 'Lite fixture service');
    assert.equal(invoices.body[0]?.payments[0]?.amount, 119);
    const offers = await json(`${server.baseUrl}/api/v1/lite/offers`, server.accessToken);
    assert.equal(offers.response.status, 200, JSON.stringify(offers.body));
    assert.equal(offers.body[0]?.number, 'AN-2026-0001');
    assert.equal(offers.body[0]?.items[0]?.description, 'Lite fixture offer');
    const recurring = await json(`${server.baseUrl}/api/v1/lite/recurring`, server.accessToken);
    assert.equal(recurring.response.status, 200, JSON.stringify(recurring.body));
    assert.equal(recurring.body[0]?.name, 'Lite fixture recurring');
    const settings = await json(`${server.baseUrl}/api/v1/lite/settings`, server.accessToken);
    assert.equal(settings.response.status, 200, JSON.stringify(settings.body));
    assert.equal(settings.body.company.name, 'PGlite Lite GmbH');
    assert.equal(settings.body.numbers.invoicePrefix, 'RE-');
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI subprocess migrates a real Pro SQLite fixture and embedded HTTP reads Pro accounting data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'billme-pglite-cli-e2e-pro-'));
  let server: EmbeddedServerHandle | undefined;
  try {
    const sourcePath = join(root, 'pro.sqlite');
    const targetDataDir = join(root, 'pro-pglite');
    await createProFixture(sourcePath);

    const processResult = await runMigrationProcess([
      '--product', 'pro', '--source', sourcePath, '--target', targetDataDir,
      '--tenant-id', 'billme-pro-local-tenant', '--tenant-slug', 'billme-pro-local', '--tenant-name', 'Billme Pro lokal',
    ]);
    assert.equal(processResult.code, 0, processResult.stderr);
    assert.equal(processResult.stderr, '');
    const receipt = JSON.parse(processResult.stdout) as {
      targetDataDir: string;
      backupPath: string;
      manifestPath: string;
      manifest: { product: string; counts: { clients: number; invoices: number; accounts: number; bankTransactions: number; transactions: number; journalEntries: number; journalLines: number; proWorkflowEntries: number } };
    };
    assert.equal(receipt.targetDataDir, targetDataDir);
    assert.equal(receipt.manifest.product, 'pro');
    assert.equal(receipt.manifest.counts.clients, 1);
    assert.equal(receipt.manifest.counts.invoices, 1);
    assert.equal(receipt.manifest.counts.accounts, 1);
    assert.equal(receipt.manifest.counts.bankTransactions, 1);
    assert.equal(receipt.manifest.counts.transactions, 1);
    assert.equal(receipt.manifest.counts.journalEntries, 1);
    assert.equal(receipt.manifest.counts.journalLines, 2);
    assert.equal(receipt.manifest.counts.proWorkflowEntries, 1);
    const manifest = JSON.parse(await readFile(receipt.manifestPath, 'utf8')) as typeof receipt.manifest;
    assert.equal(manifest.product, 'pro');
    assert.equal(manifest.counts.proWorkflowEntries, 1);
    assert.equal(await readFile(receipt.backupPath, 'utf8').then(() => true), true);

    server = await startEmbeddedServer({
      userDataPath: root,
      dataDirName: 'pro-pglite',
      product: 'pro',
      identity: { tenantId: 'billme-pro-local-tenant', userId: 'e2e-pro-user', email: 'pro@example.test', fullName: 'Pro E2E' },
    });
    const proHealth = await fetch(`${server.baseUrl}/health`);
    assert.equal(proHealth.status, 200);
    const proUnauthorized = await fetch(`${server.baseUrl}/api/v1/pro/clients`);
    assert.equal(proUnauthorized.status, 401);
    const proCapabilities = await json(`${server.baseUrl}/api/v1/meta/capabilities`, server.accessToken);
    assert.equal(proCapabilities.response.status, 200);
    assert.deepEqual(proCapabilities.body.products, ['pro']);
    assert.equal(proCapabilities.body.runtime, 'embedded');
    assert.equal(proCapabilities.body.database.local, 'pglite');
    assert.equal(proCapabilities.body.database.production, 'postgres');
    assert.equal(proCapabilities.body.auth.multiUser, false);
    const clients = await json(`${server.baseUrl}/api/v1/pro/clients`, server.accessToken);
    assert.equal(clients.response.status, 200, JSON.stringify(clients.body));
    assert.equal(clients.body[0]?.company, 'PGlite Pro AG');
    const invoices = await json(`${server.baseUrl}/api/v1/pro/invoices`, server.accessToken);
    assert.equal(invoices.response.status, 200, JSON.stringify(invoices.body));
    assert.equal(invoices.body[0]?.number, 'PRO-2026-0001');
    const accounts = await json(`${server.baseUrl}/api/v1/pro/accounts`, server.accessToken);
    assert.equal(accounts.response.status, 200, JSON.stringify(accounts.body));
    assert.equal(accounts.body[0]?.name, 'Pro fixture bank');
    const transactions = await json(`${server.baseUrl}/api/v1/pro/transactions?accountId=pro-account-1`, server.accessToken);
    assert.equal(transactions.response.status, 200, JSON.stringify(transactions.body));
    assert.equal(transactions.body[0]?.purpose, 'Pro fixture imported transaction');
    const journal = await json(`${server.baseUrl}/api/v1/pro/accounting/journal?from=2026-02-01&to=2026-02-28`, server.accessToken);
    assert.equal(journal.response.status, 200, JSON.stringify(journal.body));
    assert.equal(journal.body[0]?.entryNumber, 9001);
    const workflow = await json(`${server.baseUrl}/api/v1/pro/workflow`, server.accessToken);
    assert.equal(workflow.response.status, 200, JSON.stringify(workflow.body));
    assert.equal(workflow.body[0]?.transactionId, 'pro-transaction-1');
    assert.equal(workflow.body[0]?.transactionJson, '{"amount":238}');
    const ledgerAccounts = await json(`${server.baseUrl}/api/v1/pro/accounting/ledger/accounts?chart=SKR03&search=4980`, server.accessToken);
    assert.equal(ledgerAccounts.response.status, 200, JSON.stringify(ledgerAccounts.body));
    assert.equal(ledgerAccounts.body[0]?.accountNumber, '4980');
    assert.equal(ledgerAccounts.body[0]?.name, 'Sonstiger Betriebsbedarf');
    const ledgerStats = await json(`${server.baseUrl}/api/v1/pro/accounting/ledger/stats`, server.accessToken);
    assert.equal(ledgerStats.response.status, 200, JSON.stringify(ledgerStats.body));
    assert.ok(ledgerStats.body.total > 0);
    assert.ok(ledgerStats.body.byChart.SKR03 > 0);
  } finally {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI subprocess refuses an existing target without touching the source or target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'billme-pglite-cli-e2e-refusal-'));
  try {
    const sourcePath = join(root, 'lite.sqlite');
    const targetDataDir = join(root, 'existing-pglite');
    await createLiteFixture(sourcePath);
    const sourceBefore = await readFile(sourcePath);
    await mkdir(targetDataDir);
    await writeFile(join(targetDataDir, 'keep.txt'), 'do not replace');

    const processResult = await runMigrationProcess([
      '--product', 'lite', '--source', sourcePath, '--target', targetDataDir,
    ]);
    assert.equal(processResult.code, 1);
    assert.match(processResult.stderr, /already exists; refusing to overwrite/);
    assert.equal(processResult.stdout, '');
    assert.deepEqual(await readFile(sourcePath), sourceBefore);
    assert.equal(await readFile(join(targetDataDir, 'keep.txt'), 'utf8'), 'do not replace');
    assert.deepEqual(await readdir(root), ['existing-pglite', 'lite.sqlite']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI subprocess keeps the source and backup while quarantining a failed import', async () => {
  const root = await mkdtemp(join(tmpdir(), 'billme-pglite-cli-e2e-failed-import-'));
  try {
    const sourcePath = join(root, 'lite.sqlite');
    const targetDataDir = join(root, 'failed-pglite');
    const backupPath = join(root, 'lite-backup.sqlite');
    await createLiteFixture(sourcePath);
    const sourceDb = new Database(sourcePath);
    sourceDb.exec('CREATE TABLE unsupported_fixture (id TEXT NOT NULL); INSERT INTO unsupported_fixture VALUES (\'one\');');
    sourceDb.close();
    const sourceWithUnsupportedTable = await readFile(sourcePath);

    const processResult = await runMigrationProcess([
      '--product', 'lite', '--source', sourcePath, '--target', targetDataDir, '--backup', backupPath,
    ]);
    assert.equal(processResult.code, 1);
    assert.match(processResult.stderr, /unsupported populated tables: unsupported_fixture \(1\)/);
    assert.equal(processResult.stdout, '');
    assert.deepEqual(await readFile(sourcePath), sourceWithUnsupportedTable);
    const backupDb = new Database(backupPath, { readonly: true, fileMustExist: true });
    try {
      assert.equal((backupDb.prepare('SELECT COUNT(*) AS count FROM unsupported_fixture').get() as { count: number }).count, 1);
    } finally {
      backupDb.close();
    }
    const entries = await readdir(root);
    assert.equal(entries.includes('failed-pglite'), false);
    assert.equal(entries.some((entry) => entry.startsWith('failed-pglite.staging-') && entry.includes('.failed-')), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI subprocess exposes its help contract and usage exit code', async () => {
  const help = await runMigrationProcess(['--help']);
  assert.equal(help.code, 0);
  assert.equal(help.stderr, '');
  assert.match(help.stdout, /billme-pglite-migrate --product <lite\|pro>/);
  assert.match(help.stdout, /--target <directory>/);

  const invalid = await runMigrationProcess(['--product', 'lite']);
  assert.equal(invalid.code, 2);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /--source is required/);
  assert.match(invalid.stderr, /Options:/);
});

test('CLI subprocess receipt keeps deterministic tenant and source/backup metadata', async () => {
  const root = await mkdtemp(join(tmpdir(), 'billme-pglite-cli-e2e-receipt-'));
  try {
    const sourcePath = join(root, 'lite.sqlite');
    const targetDataDir = join(root, 'receipt-pglite');
    const backupPath = join(root, 'receipt-backup.sqlite');
    await createLiteFixture(sourcePath);
    const sourceBytes = await readFile(sourcePath);
    const processResult = await runMigrationProcess([
      '--product', 'lite', '--source', sourcePath, '--target', targetDataDir, '--backup', backupPath,
      '--tenant-id', 'receipt-tenant', '--tenant-slug', 'receipt-slug', '--tenant-name', 'Receipt GmbH',
    ]);
    assert.equal(processResult.code, 0, processResult.stderr);
    const receipt = JSON.parse(processResult.stdout) as {
      manifest: {
        version: number;
        origin: string;
        product: string;
        tenant: { id: string; slug: string; displayName: string };
        source: { path: string; sha256: string };
        backup: { path: string; sha256: string };
        importRunId: string;
        completedAt: string;
      };
    };
    assert.equal(receipt.manifest.version, 1);
    assert.equal(receipt.manifest.origin, 'sqlite-migration');
    assert.equal(receipt.manifest.product, 'lite');
    assert.deepEqual(receipt.manifest.tenant, { id: 'receipt-tenant', slug: 'receipt-slug', displayName: 'Receipt GmbH' });
    assert.equal(receipt.manifest.source.path, sourcePath);
    assert.equal(receipt.manifest.source.sha256, sha256(sourceBytes));
    assert.equal(receipt.manifest.backup.path, backupPath);
    assert.equal(receipt.manifest.backup.sha256, sha256(await readFile(backupPath)));
    assert.match(receipt.manifest.importRunId, /^[0-9a-f-]{36}$/);
    assert.match(receipt.manifest.completedAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI subprocess refuses an existing explicit backup before creating a target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'billme-pglite-cli-e2e-backup-refusal-'));
  try {
    const sourcePath = join(root, 'lite.sqlite');
    const targetDataDir = join(root, 'backup-refusal-pglite');
    const backupPath = join(root, 'existing-backup.sqlite');
    await createLiteFixture(sourcePath);
    await writeFile(backupPath, 'keep this backup');
    const sourceBefore = await readFile(sourcePath);
    const processResult = await runMigrationProcess([
      '--product', 'lite', '--source', sourcePath, '--target', targetDataDir, '--backup', backupPath,
    ]);
    assert.equal(processResult.code, 1);
    assert.match(processResult.stderr, /Backup target already exists; refusing to overwrite/);
    assert.equal(processResult.stdout, '');
    assert.equal(await readFile(backupPath, 'utf8'), 'keep this backup');
    assert.deepEqual(await readFile(sourcePath), sourceBefore);
    assert.equal((await readdir(root)).includes('backup-refusal-pglite'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI subprocess fails before opening a missing source and leaves the target absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'billme-pglite-cli-e2e-missing-source-'));
  try {
    const sourcePath = join(root, 'does-not-exist.sqlite');
    const targetDataDir = join(root, 'missing-source-pglite');
    const processResult = await runMigrationProcess([
      '--product', 'pro', '--source', sourcePath, '--target', targetDataDir,
    ]);
    assert.equal(processResult.code, 1);
    assert.match(processResult.stderr, /SQLite source does not exist/);
    assert.equal(processResult.stdout, '');
    assert.equal((await readdir(root)).includes('missing-source-pglite'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CLI subprocess rejects an unsupported product with usage guidance', async () => {
  const invalid = await runMigrationProcess([
    '--product', 'enterprise', '--source', '/tmp/unused.sqlite', '--target', '/tmp/unused-pglite',
  ]);
  assert.equal(invalid.code, 2);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /--product must be lite or pro/);
  assert.match(invalid.stderr, /--help/);
});
