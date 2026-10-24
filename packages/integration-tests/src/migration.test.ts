import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { calculateInvoiceTaxSnapshot } from '@billme/server-core';
import { createPostgresPool, importDesktopSqliteToPostgres, sha256Hex, stableStringify } from '@billme/server-data';
import { DEFAULT_SETTINGS } from '@billme/desktop-services/mockData';
import { runMigrationCli } from '../../pglite-migration-cli/src/cli.js';
import { createLocalBackend, LEGACY_SQLITE_MIGRATION_REQUIRED } from '../../../apps/desktop/electron/localBackend.js';
import { PRODUCT_PROFILE } from '../../../apps/desktop/productProfile.js';
import { repoRoot, seedMember, startHostedServer, uniqueEmail } from './server-fixtures.js';
import { startLite } from './harness.js';
import { issueInvoice } from './fixtures.js';

/**
 * The upgrade from the last SQLite release (v0.4.0) to the PGlite desktop
 * (apps/desktop localBackend + packages/pglite-migration-cli). Losing a user's
 * invoices here is the one failure that cannot be repaired afterwards.
 *
 * The database is built from the real v0.4.0 schema (`fixtures/billme-lite-v0.4.0-schema.sql`,
 * bootstrapSql + runMigrations of the tag) and filled with a realistic book, then
 * migrated with the real CLI entry and opened by the real desktop backend.
 *
 * How this can fail (each one has a test below):
 * - the app opening a PGlite directory next to an unmigrated SQLite file and starting
 *   empty (the user "loses" everything), or touching the SQLite file at all
 * - the CLI overwriting an existing target, leaving a half-written target that the
 *   app then opens, deleting or modifying the source, producing no usable backup
 * - rows lost or altered on the way: clients and addresses, invoices with their items,
 *   payments, tax snapshots and billing addresses, offers and portal decisions, number
 *   reservations (the next number must not collide), bank accounts and transactions,
 *   settings, recurring profiles, the audit chain (it must still verify, and keep
 *   growing from where it stopped); a migrated database missing columns added
 *   later (e.g. client contact persons)
 * - a database with tables this version does not know being migrated anyway (silent data loss)
 * - a damaged or missing source reported as success
 * - bad command lines giving the wrong exit code
 * - the migrated data gone after the next start
 */

const require = createRequire(join(repoRoot, 'packages', 'pglite-migration-cli', 'package.json'));
type SqliteDb = { exec(sql: string): void; prepare(sql: string): { run(...values: unknown[]): unknown }; close(): void };
const Database = require('better-sqlite3') as new (path: string) => SqliteDb;
const schemaSql = readFileSync(join(repoRoot, 'packages', 'integration-tests', 'fixtures', 'billme-lite-v0.4.0-schema.sql'), 'utf8');

const sha256File = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
const year = new Date().getFullYear();
const iso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const settings = {
  ...DEFAULT_SETTINGS,
  company: { ...DEFAULT_SETTINGS.company, name: 'Altbestand GmbH', owner: 'Anna Alt', email: 'anna@alt.example', street: 'Altstraße 1', zip: '10115', city: 'Berlin' },
  finance: { ...DEFAULT_SETTINGS.finance, taxId: '27/123/45678' },
  numbers: { ...DEFAULT_SETTINGS.numbers, invoicePrefix: 'RE-%Y-', nextInvoiceNumber: 4, numberLength: 3, offerPrefix: 'ANG-%Y-', nextOfferNumber: 3, nextCustomerNumber: 3 },
  onboardingCompleted: true,
};
const items = (description: string, net: number, rate = 19) => [{ kind: 'item' as const, description, quantity: 1, price: net, total: net, taxRate: rate }];

type Book = ReturnType<typeof buildBook>;
const buildBook = () => {
  const snapshot = (list: ReturnType<typeof items>) => calculateInvoiceTaxSnapshot({ items: list, taxMode: 'standard_vat' }, settings as never);
  const paidItems = items('Beratung März', 100);
  const openItems = [...items('Wartung', 200), ...items('Reise', 50, 7)];
  const paid = { id: randomUUID(), number: `RE-${year}-001`, items: paidItems, snapshot: snapshot(paidItems) };
  const open = { id: randomUUID(), number: `RE-${year}-002`, items: openItems, snapshot: snapshot(openItems) };
  const draft = { id: randomUUID(), number: `RE-${year}-003`, items: items('Entwurf', 10), snapshot: snapshot(items('Entwurf', 10)) };
  return {
    clients: [
      { id: randomUUID(), number: 'KD-0001', company: 'Bestandskunde AG' },
      { id: randomUUID(), number: 'KD-0002', company: 'Zweitkunde & Söhne' },
    ],
    paid, open, draft,
    offers: [
      { id: randomUUID(), number: `ANG-${year}-001`, status: 'open', share: null as null | { token: string } },
      { id: randomUUID(), number: `ANG-${year}-002`, status: 'accepted', share: { token: 'portal-token-alt' } },
    ],
    account: { id: randomUUID(), name: 'Geschäftskonto', iban: 'DE02120300000000202051', balance: 1234.56 },
    transactions: [
      { id: randomUUID(), date: iso(-20), amount: 119, type: 'income', counterparty: 'Bestandskunde AG', purpose: `Zahlung ${paid.number}`, linked: paid.id, status: 'matched' },
      { id: randomUUID(), date: iso(-10), amount: -49.9, type: 'expense', counterparty: 'Büro Bedarf', purpose: 'Papier', linked: null, status: 'unmatched' },
      { id: randomUUID(), date: iso(-3), amount: 500, type: 'income', counterparty: 'Unbekannt', purpose: 'Überweisung ohne Zweck', linked: null, status: 'unmatched' },
    ],
    article: { id: randomUUID(), title: 'Stundensatz', price: 95, unit: 'h', taxRate: 19 },
    recurring: { id: randomUUID(), name: 'Wartungsvertrag' },
  };
};

/** A database as the v0.4.0 app left it. */
const createV040Database = (path: string, book: Book, extra?: (db: SqliteDb) => void) => {
  const db = new Database(path);
  db.exec(schemaSql);
  const stamp = '2026-03-01T10:00:00.000Z';
  db.prepare('INSERT INTO settings (id, settings_json) VALUES (1, ?)').run(JSON.stringify(settings));
  book.clients.forEach((client, index) => {
    db.prepare('INSERT INTO clients (id, customer_number, company, contact_person, email, phone, address, status, avatar, tags_json, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(client.id, client.number, client.company, 'Kontakt Person', `kontakt${index}@kunde.example`, '+49 30 1234', 'Kundenweg 1\n10115 Berlin', 'active', null, JSON.stringify(['wichtig']), 'Notiz zum Kunden');
  });
  db.prepare('INSERT INTO client_addresses (id, client_id, label, kind, company, contact_person, street, line2, zip, city, country, is_default_billing, is_default_shipping, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(), book.clients[0]!.id, 'Hauptsitz', 'billing', 'Bestandskunde AG', 'Kontakt Person', 'Kundenweg 1', null, '10115', 'Berlin', 'DE', 1, 1, stamp, stamp);

  const invoice = (doc: { id: string; number: string; items: ReturnType<typeof items>; snapshot: ReturnType<typeof calculateInvoiceTaxSnapshot> }, clientIndex: number, status: string, dueDays: number, dunningLevel = 0) => {
    const client = book.clients[clientIndex]!;
    db.prepare(`INSERT INTO invoices (id, client_id, client_number, project_id, number, client, client_email, client_address, billing_address_json, shipping_address_json, date, due_date, service_period, tax_mode, tax_meta_json, tax_snapshot_json, amount, status, dunning_level, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(doc.id, client.id, client.number, null, doc.number, client.company, `kontakt${clientIndex}@kunde.example`, 'Kundenweg 1\n10115 Berlin',
        clientIndex === 0 ? JSON.stringify({ id: 'addr-snapshot', label: 'Hauptsitz', kind: 'billing', company: client.company, street: 'Kundenweg 1', zip: '10115', city: 'Berlin', country: 'DE', isDefaultBilling: true, isDefaultShipping: true }) : null,
        null, iso(-dueDays - 14), iso(-dueDays), '2026-03', 'standard_vat', null, JSON.stringify(doc.snapshot), doc.snapshot.grossAmount, status, dunningLevel, stamp, stamp);
    doc.items.forEach((item, position) => {
      db.prepare('INSERT INTO invoice_items (invoice_id, position, description, tax_rate, quantity, price, total, article_id, category, unit, discount_percent) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(doc.id, position, item.description, item.taxRate, item.quantity, item.price, item.total, null, 'Beratung', 'h', null);
    });
  };
  invoice(book.paid, 0, 'paid', 60);
  invoice(book.open, 1, 'open', 20, 1);
  invoice(book.draft, 0, 'draft', -14);
  db.prepare('INSERT INTO invoice_payments (id, invoice_id, date, amount, method) VALUES (?,?,?,?,?)').run(randomUUID(), book.paid.id, iso(-20), 119, 'Bank');

  book.offers.forEach((offer, index) => {
    const list = items('Angebotsposition', 300);
    const snap = calculateInvoiceTaxSnapshot({ items: list, taxMode: 'standard_vat' }, settings as never);
    db.prepare(`INSERT INTO offers (id, client_id, client_number, project_id, number, client, client_email, client_address, billing_address_json, shipping_address_json, date, valid_until, tax_mode, tax_meta_json, tax_snapshot_json, amount, status, share_token, share_published_at, accepted_at, accepted_by, accepted_email, accepted_user_agent, decision, decision_text_version, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(offer.id, book.clients[index]!.id, book.clients[index]!.number, null, offer.number, book.clients[index]!.company, 'kontakt@kunde.example', 'Kundenweg 1', null, null, iso(-30), iso(30), 'standard_vat', null, JSON.stringify(snap), snap.grossAmount, offer.status,
        offer.share?.token ?? null, offer.share ? stamp : null, offer.status === 'accepted' ? stamp : null, offer.status === 'accepted' ? 'Karl Kunde' : null, offer.status === 'accepted' ? 'karl@kunde.example' : null, offer.status === 'accepted' ? 'Mozilla/5.0' : null, offer.status === 'accepted' ? 'accepted' : null, offer.status === 'accepted' ? 'v1' : null, stamp, stamp);
    list.forEach((item, position) => {
      db.prepare('INSERT INTO offer_items (offer_id, position, description, tax_rate, quantity, price, total, article_id, category, unit, discount_percent) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
        .run(offer.id, position, item.description, item.taxRate, item.quantity, item.price, item.total, null, null, null, null);
    });
  });

  [[book.paid.number, 1, 'finalized', book.paid.id], [book.open.number, 2, 'finalized', book.open.id], [book.draft.number, 3, 'reserved', book.draft.id]].forEach(([number, counter, status, documentId]) => {
    db.prepare('INSERT INTO number_reservations (id, kind, number, counter_value, status, document_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), 'invoice', number, counter, status, documentId, stamp, stamp);
  });
  book.offers.forEach((offer, index) => {
    db.prepare('INSERT INTO number_reservations (id, kind, number, counter_value, status, document_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)').run(randomUUID(), 'offer', offer.number, index + 1, 'finalized', offer.id, stamp, stamp);
  });

  db.prepare('INSERT INTO accounts (id, name, iban, balance, type, color) VALUES (?,?,?,?,?,?)').run(book.account.id, book.account.name, book.account.iban, book.account.balance, 'checking', '#2563eb');
  for (const tx of book.transactions) {
    db.prepare('INSERT INTO transactions (id, account_id, date, amount, type, counterparty, purpose, linked_invoice_id, status, dedup_hash, import_batch_id, deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(tx.id, book.account.id, tx.date, tx.amount, tx.type, tx.counterparty, tx.purpose, tx.linked, tx.status, `hash-${tx.id}`, null, null);
  }
  db.prepare('INSERT INTO articles (id, sku, title, description, price, unit, category, tax_rate) VALUES (?,?,?,?,?,?,?,?)').run(book.article.id, 'S-1', book.article.title, 'Beratung nach Aufwand', book.article.price, book.article.unit, 'Dienstleistung', book.article.taxRate);
  db.prepare('INSERT INTO recurring_profiles (id, client_id, active, name, interval, next_run, last_run, end_date, amount, items_json) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(book.recurring.id, book.clients[0]!.id, 1, book.recurring.name, 'monthly', iso(5), iso(-25), null, 100, JSON.stringify(items('Wartung monatlich', 100)));
  db.prepare('INSERT INTO email_log (id, document_type, document_id, document_number, recipient_email, recipient_name, subject, body_text, provider, status, error_message, sent_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(), 'invoice', book.open.id, book.open.number, 'kontakt1@kunde.example', 'Zweitkunde', 'Rechnung', 'Anbei', 'smtp', 'sent', null, stamp, stamp);
  db.prepare('INSERT INTO dunning_history (id, invoice_id, invoice_number, dunning_level, days_overdue, fee_applied, email_sent, email_log_id, processed_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(), book.open.id, book.open.number, 1, 8, 0, 1, null, stamp, stamp);

  // A real hash chain, written the way the app wrote it.
  let previous: string | null = null;
  const entries: Array<[string, string, string, string, unknown, unknown]> = [
    ['client', book.clients[0]!.id, 'client.create', 'Kunde angelegt', null, { company: book.clients[0]!.company }],
    ['invoice', book.paid.id, 'invoice.create', 'Rechnung erstellt', null, { number: book.paid.number }],
    ['invoice', book.paid.id, 'invoice.payment.create', 'Zahlung erfasst', { status: 'open' }, { status: 'paid' }],
    ['invoice', book.open.id, 'invoice.create', 'Rechnung erstellt', null, { number: book.open.number }],
    ['offer', book.offers[1]!.id, 'offer.portal_decision', 'Angebot angenommen', { status: 'open' }, { status: 'accepted' }],
  ];
  entries.forEach(([entityType, entityId, action, reason, before, after], index) => {
    const sequence = index + 1;
    const ts = `2026-03-0${sequence}T10:00:00.000Z`;
    const payload = { sequence, ts, entityType, entityId, action, reason, before, after, prevHash: previous, actor: 'local' };
    const hash = sha256Hex(`${previous ?? ''}:${stableStringify(payload)}`);
    db.prepare('INSERT INTO audit_log (sequence, ts, entity_type, entity_id, action, reason, before_json, after_json, prev_hash, hash, actor) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .run(sequence, ts, entityType, entityId, action, reason, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after), previous, hash, 'local');
    previous = hash;
  });
  extra?.(db);
  db.close();
  return entries.length;
};

type Reader = { prepare(sql: string): { get(...values: unknown[]): unknown } };
/** Row counts of every user table, read from a SQLite file. */
const tableCounts = (path: string): Record<string, number> => {
  const db = new Database(path) as unknown as SqliteDb & Reader & { prepare(sql: string): { all(): Array<{ name: string }>; get(): { n: number } } };
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name") as unknown as { all(): Array<{ name: string }> }).all();
    return Object.fromEntries(tables.map(({ name }) => [name, ((db.prepare(`SELECT COUNT(*) AS n FROM ${name}`) as unknown as { get(): { n: number } }).get()).n]));
  } finally { db.close(); }
};

const cli = async (args: string[]) => {
  let stdout = '';
  let stderr = '';
  const code = await runMigrationCli(args, { stdout: { write: (chunk) => { stdout += chunk; } }, stderr: { write: (chunk) => { stderr += chunk; } } });
  return { code, stdout, stderr };
};

describe('SQLite v0.4.0 to PGlite', () => {
  const roots: string[] = [];
  const book = buildBook();
  const entryCount = 5;
  let root: string;
  let source: string;
  let target: string;
  let sourceHash: string;
  let migrated: Awaited<ReturnType<typeof cli>>;
  let manifest: Record<string, any>;

  before(async () => {
    root = await mkdtemp(join(tmpdir(), 'billme-it-migration-'));
    roots.push(root);
    source = join(root, PRODUCT_PROFILE.dbFileName);
    target = join(root, PRODUCT_PROFILE.dataDirName);
    assert.equal(createV040Database(source, book), entryCount);
    sourceHash = sha256File(source);
  });
  after(async () => { await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true }))); });

  describe('before the migration', () => {
    test('the desktop backend refuses to start next to an unmigrated SQLite file and says how to migrate; nothing is created or touched', async () => {
      const error = await createLocalBackend({ userDataPath: root, profile: PRODUCT_PROFILE }).then(() => null, (e: Error & { code?: string }) => e);
      assert.equal(error?.code, LEGACY_SQLITE_MIGRATION_REQUIRED);
      assert.match(error?.message ?? '', /billme-pglite-migrate --product lite --source/);
      assert.match(error?.message ?? '', /billme\.sqlite/);
      assert.equal(existsSync(target), false, 'an empty PGlite directory would hide the user\'s data');
      assert.equal(sha256File(source), sourceHash, 'the SQLite file was modified');
    });

    test('bad command lines exit with the right code and print usage', async () => {
      const help = await cli(['--help']);
      assert.deepEqual([help.code, help.stderr], [0, '']);
      assert.match(help.stdout, /--product <lite\|pro>/);
      for (const args of [[], ['--product', 'enterprise', '--source', source, '--target', target], ['--product', 'lite', '--target', target], ['--product', 'lite', '--source', source], ['--product', 'lite', '--source', source, '--target', target, '--bogus']]) {
        const result = await cli(args);
        assert.equal(result.code, 2, `${args.join(' ')} -> ${result.code}`);
        assert.match(result.stderr, /billme-pglite-migrate:/);
        assert.equal(existsSync(target), false);
      }
    });

    test('a source that does not exist is an error and creates nothing', async () => {
      const result = await cli(['--product', 'lite', '--source', join(root, 'missing.sqlite'), '--target', join(root, 'never-created')]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /SQLite source does not exist/);
      assert.equal(existsSync(join(root, 'never-created')), false);
    });

    test('a damaged source is not reported as migrated: no target, the file is untouched, the failed staging is quarantined', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'billme-it-migration-bad-'));
      roots.push(dir);
      const bad = join(dir, 'billme.sqlite');
      await writeFile(bad, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(4096, 7)]));
      const badHash = sha256File(bad);
      const result = await cli(['--product', 'lite', '--source', bad, '--target', join(dir, 'billme-pglite')]);
      assert.equal(result.code, 1);
      assert.equal(result.stdout, '');
      assert.equal(existsSync(join(dir, 'billme-pglite')), false, 'a half-built target must never be activated');
      assert.equal(sha256File(bad), badHash);
      const failed = (await readdir(dir)).filter((entry) => entry.includes('.failed-'));
      assert.ok(failed.length <= 1);
    });

    test('a database holding tables this version does not know is refused, never migrated with silent data loss', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'billme-it-migration-unknown-'));
      roots.push(dir);
      const future = join(dir, 'billme.sqlite');
      createV040Database(future, buildBook(), (db) => {
        db.exec('CREATE TABLE loyalty_points (id TEXT PRIMARY KEY, client_id TEXT, points INTEGER)');
        db.prepare('INSERT INTO loyalty_points (id, client_id, points) VALUES (?,?,?)').run('p1', 'c1', 42);
      });
      const result = await cli(['--product', 'lite', '--source', future, '--target', join(dir, 'billme-pglite')]);
      assert.equal(result.code, 1, result.stdout);
      assert.match(result.stderr, /loyalty_points/);
      assert.equal(existsSync(join(dir, 'billme-pglite')), false);
    });

    test('an audit chain that does not verify is refused', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'billme-it-migration-chain-'));
      roots.push(dir);
      const tampered = join(dir, 'billme.sqlite');
      createV040Database(tampered, buildBook(), (db) => {
        db.exec('DROP TRIGGER audit_log_no_update');
        db.exec(`UPDATE audit_log SET after_json = '{"number":"RE-FAKE"}' WHERE sequence = 2`);
      });
      const result = await cli(['--product', 'lite', '--source', tampered, '--target', join(dir, 'billme-pglite')]);
      assert.equal(result.code, 1, 'a manipulated audit trail was migrated');
      assert.equal(existsSync(join(dir, 'billme-pglite')), false);
    });
  });

  describe('the migration', () => {
    before(async () => {
      migrated = await cli(['--product', 'lite', '--source', source, '--target', target]);
      if (migrated.code === 0) manifest = JSON.parse(migrated.stdout);
    });

    test('exits 0 and prints the receipt; source and backup are intact and identical, the manifest is complete', async () => {
      assert.equal(migrated.code, 0, migrated.stderr);
      assert.equal(sha256File(source), sourceHash, 'the source SQLite file must never change');
      assert.equal(manifest.targetDataDir, target);
      assert.ok(existsSync(manifest.backupPath), 'no backup');
      assert.equal(sha256File(manifest.backupPath), manifest.manifest.backup.sha256, 'the manifest describes another file than the backup');
      assert.deepEqual(tableCounts(manifest.backupPath), tableCounts(source), 'the backup is not a faithful copy of the source');
      assert.equal(manifest.manifest.version, 1);
      assert.equal(manifest.manifest.origin, 'sqlite-migration');
      assert.equal(manifest.manifest.product, 'lite');
      assert.equal(manifest.manifest.source.sha256, sourceHash);
      assert.equal(manifest.manifest.tenant.id, PRODUCT_PROFILE.localTenantId, 'the migrated tenant is the one the desktop app opens');
      assert.equal(manifest.manifest.counts.clients, 2);
      assert.equal(manifest.manifest.counts.invoices, 3);
      assert.equal(manifest.manifest.counts.offers, 2);
      assert.equal(manifest.manifest.counts.auditLog, entryCount);
      assert.ok(existsSync(join(target, 'billme-pglite-migration.v1.json')));
      assert.deepEqual((await readdir(root)).filter((entry) => entry.includes('.staging-')), [], 'staging directory left behind');
    });

    test('running it again never overwrites the migrated database', async () => {
      const again = await cli(['--product', 'lite', '--source', source, '--target', target]);
      assert.equal(again.code, 1);
      assert.match(again.stderr, /already exists; refusing to overwrite/);
      const backup = await cli(['--product', 'lite', '--source', source, '--target', join(root, 'second-target'), '--backup', manifest.backupPath]);
      assert.equal(backup.code, 1);
      assert.match(backup.stderr, /Backup target already exists/);
      assert.equal(existsSync(join(root, 'second-target')), false);
    });

    test('the desktop app opens the migrated data: every book entry is there, to the cent', async () => {
      const h = await startLite(null, 'migration-open', root);
      try {
        const api = h.api;
        const clients = await api.clients.list();
        assert.deepEqual(clients.map((c) => c.company).sort(), ['Bestandskunde AG', 'Zweitkunde & Söhne']);
        const first = clients.find((c) => c.company === 'Bestandskunde AG')!;
        assert.equal(first.customerNumber, 'KD-0001');
        assert.deepEqual(first.tags, ['wichtig']);
        assert.equal(first.addresses?.[0]?.street, 'Kundenweg 1');

        const invoices = await api.invoices.list();
        assert.equal(invoices.length, 3);
        const byNumber = Object.fromEntries(invoices.map((i) => [i.number, i]));
        const paid = byNumber[book.paid.number]!;
        assert.equal(paid.status, 'paid');
        assert.equal(paid.amount, 119);
        assert.equal(paid.items.length, 1);
        assert.equal(paid.items[0]!.description, 'Beratung März');
        assert.equal(paid.items[0]!.taxRate, 19);
        assert.deepEqual(paid.payments.map((p) => [p.amount, p.method]), [[119, 'Bank']]);
        assert.equal(paid.taxSnapshot?.grossAmount, 119);
        assert.equal(paid.taxSnapshot?.vatAmount, 19);
        assert.deepEqual(paid.billingAddressJson, { company: 'Bestandskunde AG', street: 'Kundenweg 1', zip: '10115', city: 'Berlin', country: 'DE' }, 'the billing address snapshot of an issued invoice');
        assert.equal(paid.clientId, first.id);
        const open = byNumber[book.open.number]!;
        assert.equal(open.status, 'open');
        assert.equal(open.amount, book.open.snapshot.grossAmount);
        assert.deepEqual(open.taxSnapshot?.vatBreakdown?.map((b) => [b.rate, b.netAmount]).sort(), [[19, 200], [7, 50]].sort(), 'mixed VAT rates survive');
        assert.equal(open.dunningLevel, 1);
        assert.deepEqual(open.items.map((i) => i.description), ['Wartung', 'Reise'], 'item order');
        assert.equal(byNumber[book.draft.number]!.status, 'draft');

        // Read through the server shape: the renderer's offers:list rejects accepted offers (separate test below).
        const offers = (await h.raw('GET', '/offers')).body as Array<{ number: string; status: string; share?: { token?: string; acceptedBy?: string; decision?: string } }>;
        assert.equal(offers.length, 2);
        const accepted = offers.find((o) => o.number === book.offers[1]!.number)!;
        assert.equal(accepted.status, 'accepted');
        assert.equal(accepted.share?.token, 'portal-token-alt');
        assert.equal(accepted.share?.acceptedBy, 'Karl Kunde');
        assert.equal(accepted.share?.decision, 'accepted');
        assert.equal(offers.find((o) => o.number === book.offers[0]!.number)!.status, 'open');

        const accounts = await api.accounts.list();
        assert.deepEqual(accounts.map((a) => [a.name, a.iban, a.balance]), [[book.account.name, book.account.iban, 1234.56]]);
        const transactions = await api.transactions.list({ accountId: book.account.id } as never);
        assert.equal(transactions.length, 3);
        const linked = transactions.find((t) => t.amount === 119)!;
        assert.equal(linked.linkedInvoiceId, book.paid.id);
        assert.equal(transactions.find((t) => t.amount === -49.9)?.counterparty, 'Büro Bedarf');

        assert.equal((await api.articles.list())[0]?.title, 'Stundensatz');
        const recurring = await api.recurring.list();
        assert.deepEqual(recurring.map((r) => [r.name, r.interval, r.active]), [[book.recurring.name, 'monthly', true]]);
        assert.equal((await api.settings.get())!.company.name, 'Altbestand GmbH');

        const verify = await api.audit.verify();
        assert.equal(verify.ok, true, JSON.stringify(verify));
        assert.ok(verify.count >= entryCount, `only ${verify.count} audit entries`);
        const csv = await api.audit.exportCsv();
        for (const action of ['client.create', 'invoice.payment.create', 'offer.portal_decision']) assert.ok(csv.includes(action), `${action} missing from the audit export`);
      } finally { await h.close({ keepData: true }); }
    });

    test('the offers list of the app shows an offer a customer accepted', async () => {
      const h = await startLite(null, 'migration-offers', root);
      try {
        const offers = await h.api.offers.list();
        assert.equal(offers.find((o) => o.number === book.offers[1]!.number)?.shareDecision, 'accepted');
      } finally { await h.close({ keepData: true }); }
    });

    test('numbering continues without collisions, new documents extend the old audit chain, and everything survives another restart', async () => {
      const h = await startLite(null, 'migration-numbering', root);
      let next: string;
      try {
        const reserved = await h.api.numbers.reserve({ kind: 'invoice' });
        next = reserved.number;
        assert.equal(reserved.number, `RE-${year}-004`, 'the next number after the migrated book');
        await h.api.numbers.release({ reservationId: reserved.reservationId });
        const issued = await issueInvoice(h.api, { client: 'Neukunde nach Migration' });
        assert.equal(issued.number, next);
        assert.equal((await h.api.invoices.list()).length, 4);
        // A migrated client takes contact persons (clients.contacts_json, migration 0040).
        const [migratedClient] = await h.api.clients.list();
        assert.deepEqual(migratedClient!.contacts, [], 'a migrated client has no contacts yet');
        await h.api.clients.upsert({ client: { ...migratedClient!, contacts: [{ id: 'mig-1', name: 'Nach Migration', isPrimary: true }] } as never });
        const verify = await h.api.audit.verify();
        assert.equal(verify.ok, true, 'the imported chain must keep verifying after new entries');
        assert.ok(verify.count > entryCount);
      } finally { await h.close({ keepData: true }); }

      const again = await startLite(null, 'migration-restart', root);
      try {
        assert.equal((await again.api.invoices.list()).length, 4);
        assert.equal((await again.api.clients.list()).length, 2);
        assert.deepEqual((await again.api.clients.list()).flatMap((client) => client.contacts ?? []), [{ id: 'mig-1', name: 'Nach Migration', isPrimary: true }]);
        assert.equal((await again.api.audit.verify()).ok, true);
      } finally { await again.close({ keepData: true }); }
    });

    test('the SQLite file is still byte-identical and the backup unchanged after the app ran on the migrated data', async () => {
      assert.equal(sha256File(source), sourceHash);
      assert.equal(sha256File(manifest.backupPath), manifest.manifest.backup.sha256);
    });

    test('a copy of the migrated directory plus the backup is all a user needs: the backup migrates again to an identical book', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'billme-it-migration-again-'));
      roots.push(dir);
      await mkdir(join(dir, 'x'));
      const restoredSource = join(dir, 'billme.sqlite');
      await copyFile(manifest.backupPath, restoredSource);
      const result = await cli(['--product', 'lite', '--source', restoredSource, '--target', join(dir, 'billme-pglite')]);
      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).manifest.counts, manifest.manifest.counts);
    });
  });

  describe('import into a hosted Postgres (server mode)', () => {
    const tenant = (id: string) => ({ id, slug: id, displayName: `Import ${id}` });
    let server: Awaited<ReturnType<typeof startHostedServer>>;
    let pool: ReturnType<typeof createPostgresPool>;
    before(async () => { server = await startHostedServer('migration-hosted'); pool = createPostgresPool(server.wire.url); });
    after(async () => { await pool.end(); await server.close(); });

    const login = async (tenantId: string) => {
      const email = uniqueEmail('imported');
      await seedMember(server.wire, { product: 'lite', email, fullName: 'Importierter Owner', role: 'owner', tenantId });
      return (await server.login('lite', email)).token;
    };

    test('the book arrives complete for the imported tenant, a second import is refused instead of duplicating it, and the audit chain verifies', async () => {
      const first = await importDesktopSqliteToPostgres({ pool, sqlitePath: source, product: 'lite', tenant: tenant('hosted-import-a') });
      assert.deepEqual([first.counts.clients, first.counts.invoices, first.counts.offers, first.counts.auditLog], [2, 3, 2, entryCount]);
      const token = await login('hosted-import-a');
      const invoices = (await server.http('GET', '/api/v1/lite/invoices', { token })).body as Array<{ number: string; status: string; amount: number; payments: unknown[]; items: unknown[] }>;
      assert.deepEqual(invoices.map((i) => [i.number, i.status, i.amount]).sort(), [[book.paid.number, 'paid', 119], [book.open.number, 'open', book.open.snapshot.grossAmount], [book.draft.number, 'draft', book.draft.snapshot.grossAmount]].sort());
      assert.equal(invoices.find((i) => i.number === book.paid.number)!.payments.length, 1);
      assert.equal(invoices.find((i) => i.number === book.open.number)!.items.length, 2);
      assert.equal((await server.http('GET', '/api/v1/lite/audit/verify', { token })).body.ok, true);

      // A second import into a tenant that already holds data is refused, never merged or duplicated.
      await assert.rejects(importDesktopSqliteToPostgres({ pool, sqlitePath: source, product: 'lite', tenant: tenant('hosted-import-a') }), /already contains server billing data/);
      assert.equal((await server.http('GET', '/api/v1/lite/invoices', { token })).body.length, 3, 'a second import must not duplicate documents');
      assert.equal((await server.wire.sql('SELECT 1 FROM audit_log WHERE tenant_id = $1', ['hosted-import-a'])).rows.length, entryCount, 'nor the audit log');
      assert.equal((await server.wire.sql(`SELECT 1 FROM sqlite_import_runs WHERE tenant_id = $1 AND status = 'completed'`, ['hosted-import-a'])).rows.length, 1);
    });

    test('the same SQLite file cannot be imported into another tenant, and the first tenant keeps everything', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'billme-it-migration-hosted-collision-'));
      roots.push(dir);
      const file = join(dir, 'billme.sqlite');
      createV040Database(file, buildBook());
      await importDesktopSqliteToPostgres({ pool, sqlitePath: file, product: 'lite', tenant: tenant('hosted-import-owner') });
      await assert.rejects(importDesktopSqliteToPostgres({ pool, sqlitePath: file, product: 'lite', tenant: tenant('hosted-import-thief') }), /IMPORT_ID_TENANT_COLLISION/);
      assert.equal((await server.wire.sql('SELECT 1 FROM invoices WHERE tenant_id = $1', ['hosted-import-owner'])).rows.length, 3);
      assert.equal((await server.wire.sql('SELECT 1 FROM invoices WHERE tenant_id = $1', ['hosted-import-thief'])).rows.length, 0, 'documents moved to the second tenant');
      assert.equal((await server.wire.sql('SELECT 1 FROM clients WHERE tenant_id = $1', ['hosted-import-owner'])).rows.length, 2);
    });

    test('a tenant whose metadata does not match the target is refused; an unsupported populated table aborts the import', async () => {
      await server.wire.sql(`INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at) VALUES ('hosted-import-pro', 'hosted-import-pro', 'Pro Tenant', 'pro', 'single-tenant', 'active', 'x', 'x')`);
      await assert.rejects(importDesktopSqliteToPostgres({ pool, sqlitePath: source, product: 'lite', tenant: { id: 'hosted-import-pro', slug: 'hosted-import-pro', displayName: 'Pro Tenant' } }), /metadata does not match/);
      const dir = await mkdtemp(join(tmpdir(), 'billme-it-migration-hosted-unknown-'));
      roots.push(dir);
      const future = join(dir, 'billme.sqlite');
      createV040Database(future, buildBook(), (db) => { db.exec('CREATE TABLE loyalty_points (id TEXT PRIMARY KEY, points INTEGER)'); db.prepare('INSERT INTO loyalty_points VALUES (?,?)').run('p1', 1); });
      await assert.rejects(importDesktopSqliteToPostgres({ pool, sqlitePath: future, product: 'lite', tenant: tenant('hosted-import-unknown') }), /unsupported populated tables: loyalty_points/);
      assert.equal((await server.wire.sql('SELECT 1 FROM clients WHERE tenant_id = $1', ['hosted-import-unknown'])).rows.length, 0);
    });
  });
});
