import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { createBillingScope, createSqliteInvoiceRepository } from './billingDomainCompat';
import type { Invoice } from '@billme/server-core';

const canRunNativeSqlite = (() => {
  try {
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
})();

const createSchema = (db: Database.Database) => db.exec(`
  CREATE TABLE invoices (
    id TEXT PRIMARY KEY, client_id TEXT, client_number TEXT, project_id TEXT,
    number TEXT NOT NULL, document_kind TEXT NOT NULL DEFAULT 'invoice', source_document_id TEXT,
    root_document_id TEXT, revision_of_id TEXT, revision_number INTEGER NOT NULL DEFAULT 0,
    client TEXT NOT NULL, client_email TEXT NOT NULL,
    client_address TEXT, billing_address_json TEXT, shipping_address_json TEXT,
    tax_mode TEXT NOT NULL, tax_meta_json TEXT, tax_snapshot_json TEXT,
    date TEXT NOT NULL, due_date TEXT NOT NULL, service_period TEXT,
    amount REAL NOT NULL, status TEXT NOT NULL,
    accounting_status TEXT NOT NULL DEFAULT 'unposted',
    accounting_snapshot_json TEXT,
    accounting_journal_entry_id TEXT,
    accounting_posted_at TEXT,
    dunning_level INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id TEXT NOT NULL, position INTEGER NOT NULL,
    description TEXT NOT NULL, line_meta_json TEXT, article_id TEXT, category TEXT, unit TEXT,
    discount_percent REAL, tax_rate REAL, quantity REAL NOT NULL, price REAL NOT NULL, total REAL NOT NULL
  );
  CREATE TABLE invoice_payments (
    id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, date TEXT NOT NULL, amount REAL NOT NULL, method TEXT NOT NULL
  );
`);

const invoice: Invoice = {
  kind: 'invoice',
  tenantId: 'default',
  id: 'invoice-line-meta',
  number: 'RE-2026-001',
  client: 'Bauherr GmbH',
  clientEmail: 'buchhaltung@example.test',
  date: '2026-08-07',
  dueDate: '2026-08-21',
  amount: 100,
  status: 'draft',
  items: [
    { kind: 'group', description: 'Bauabschnitt 1', quantity: 0, price: 0, total: 0, groupId: 'rohbau' },
    { kind: 'time', description: 'Montage', quantity: 2, price: 50, total: 100, unit: 'Std.', date: '2026-08-07', durationMinutes: 120 },
    { kind: 'optional', description: 'Support', quantity: 1, price: 25, total: 25, optionNote: 'bei Bedarf' },
    { kind: 'summary', description: 'Zwischensumme', quantity: 0, price: 0, total: 0, summaryScope: 'group', summaryMetric: 'quantity', summaryUnit: 'Std.' },
  ],
  payments: [],
};

describe.skipIf(!canRunNativeSqlite)('shared SQLite billing line persistence', () => {
  it('saves and refetches structural line metadata through compact line_meta_json', () => {
    const db = new Database(':memory:');
    createSchema(db);
    const repository = createSqliteInvoiceRepository(db);
    const saved = repository.save(createBillingScope('lite'), invoice);
    expect(saved.items).toEqual(invoice.items);
    expect(db.prepare('SELECT line_meta_json FROM invoice_items ORDER BY position').all()).toEqual([
      { line_meta_json: JSON.stringify({ kind: 'group', groupId: 'rohbau' }) },
      { line_meta_json: JSON.stringify({ kind: 'time', date: '2026-08-07', durationMinutes: 120 }) },
      { line_meta_json: JSON.stringify({ kind: 'optional', optionNote: 'bei Bedarf' }) },
      { line_meta_json: JSON.stringify({ kind: 'summary', summaryScope: 'group', summaryMetric: 'quantity', summaryUnit: 'Std.' }) },
    ]);
    db.close();
  });
});
