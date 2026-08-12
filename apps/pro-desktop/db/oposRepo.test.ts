import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { bootstrapSql } from './bootstrap';
import { runMigrations } from './migrate';
import { createProTenantScope } from '../tenantScope';
import {
  allocateOpenItemPayment,
  listOpenItems,
  postIncomingInvoice,
  postOutgoingInvoice,
  previewAccountingBackfill,
  upsertIncomingInvoice,
  upsertVendor,
} from './oposRepo';

const scope = createProTenantScope('default');
const createDb = () => {
  const db = new Database(':memory:');
  db.exec(bootstrapSql);
  runMigrations(db);
  db.exec(`INSERT INTO ledger_accounts (id, chart, account_number, name, source, created_at, updated_at) VALUES
    ('skr03-ar', 'SKR03', '1400', 'Debitoren', 'test', datetime('now'), datetime('now')),
    ('skr03-ap', 'SKR03', '1600', 'Kreditoren', 'test', datetime('now'), datetime('now')),
    ('skr03-bank', 'SKR03', '1200', 'Bank', 'test', datetime('now'), datetime('now')),
    ('skr03-revenue', 'SKR03', '8400', 'Erlöse', 'test', datetime('now'), datetime('now')),
    ('skr03-expense', 'SKR03', '4900', 'Aufwand', 'test', datetime('now'), datetime('now')),
    ('skr03-vat-out', 'SKR03', '1776', 'USt', 'test', datetime('now'), datetime('now')),
    ('skr03-vat-in', 'SKR03', '1576', 'VSt', 'test', datetime('now'), datetime('now'))`);
  return db;
};

describe('OPOS accounting', () => {
  it('posts an outgoing invoice once and opens a debtor item', () => {
    const db = createDb();
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, tax_snapshot_json, created_at, updated_at) VALUES ('inv-1', 'client-1', 'RE-1', 'Acme', 'a@example.test', '2026-08-01', '2026-08-31', 119, 'open', ?, datetime('now'), datetime('now'))`).run(JSON.stringify({ netAmount: 100, vatAmount: 19, grossAmount: 119 }));
    db.prepare(`INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate) VALUES ('inv-1', 0, 'Service', 1, 119, 119, 19)`);

    expect(postOutgoingInvoice(db, scope, 'inv-1').status).toBe('ready');
    expect(postOutgoingInvoice(db, scope, 'inv-1').status).toBe('ready');
    expect((db.prepare("SELECT COUNT(*) AS c FROM journal_entries WHERE source_type = 'outgoing_invoice'").get() as { c: number }).c).toBe(1);
    expect(listOpenItems(db, scope)[0]?.residualAmount).toBe(119);
    expect((db.prepare("SELECT accounting_status FROM invoices WHERE id = 'inv-1'").get() as { accounting_status: string }).accounting_status).toBe('posted');
    db.close();
  });

  it('allocates partial payment and projects the open-item status', () => {
    const db = createDb();
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, tax_snapshot_json, created_at, updated_at) VALUES ('inv-2', 'client-2', 'RE-2', 'Acme', 'a@example.test', '2026-08-01', '2026-08-31', 119, 'open', ?, datetime('now'), datetime('now'))`).run(JSON.stringify({ netAmount: 100, vatAmount: 19, grossAmount: 119 }));
    db.prepare(`INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate) VALUES ('inv-2', 0, 'Service', 1, 119, 119, 19)`);
    postOutgoingInvoice(db, scope, 'inv-2');
    const item = listOpenItems(db, scope)[0]!;
    allocateOpenItemPayment(db, scope, { sourceType: 'manual', sourceId: 'pay-1', partyType: 'debtor', partyId: 'client-2', paymentDate: '2026-08-15', amount: 50, bankAccountNumber: '1200', allocations: [{ openItemId: item.id, amount: 50 }] });
    expect(listOpenItems(db, scope)[0]?.status).toBe('partially_paid');
    expect(listOpenItems(db, scope)[0]?.residualAmount).toBe(69);
    db.close();
  });

  it('retains an overpayment as payment residual while closing the item', () => {
    const db = createDb();
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, tax_snapshot_json, created_at, updated_at) VALUES ('inv-over', 'client-over', 'RE-OVER', 'Acme', 'a@example.test', '2026-08-01', '2026-08-31', 119, 'open', ?, datetime('now'), datetime('now'))`).run(JSON.stringify({ netAmount: 100, vatAmount: 19, grossAmount: 119 }));
    db.prepare(`INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate) VALUES ('inv-over', 0, 'Service', 1, 119, 119, 19)`);
    postOutgoingInvoice(db, scope, 'inv-over');
    const item = listOpenItems(db, scope)[0]!;
    const payment = allocateOpenItemPayment(db, scope, { sourceType: 'manual', sourceId: 'pay-over', partyType: 'debtor', partyId: 'client-over', paymentDate: '2026-08-15', amount: 150, bankAccountNumber: '1200', allocations: [{ openItemId: item.id, amount: 119 }] });
    expect(payment.residualAmount).toBe(31);
    expect(listOpenItems(db, scope)[0]?.status).toBe('paid');
    expect((db.prepare("SELECT status FROM invoices WHERE id = 'inv-over'").get() as { status: string }).status).toBe('paid');
    db.close();
  });

  it('posts incoming invoices as expense plus input VAT against creditors', () => {
    const db = createDb();
    const vendor = upsertVendor(db, scope, { id: 'vendor-1', name: 'Supplier' });
    const invoice = upsertIncomingInvoice(db, scope, { id: 'in-1', tenantId: 'default', vendorId: vendor.id, number: 'ER-1', invoiceDate: '2026-08-02', dueDate: '2026-08-31', netAmount: 100, taxAmount: 19, grossAmount: 119, taxRate: 19, status: 'draft', accountingStatus: 'unposted', lines: [{ id: 'line-1', incomingInvoiceId: 'in-1', position: 0, description: 'Hosting', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 19, taxAmount: 19, grossAmount: 119 }] , createdAt: '', updatedAt: '' });
    expect(postIncomingInvoice(db, scope, invoice.id).status).toBe('ready');
    const rows = db.prepare("SELECT account_number, debit_amount, credit_amount FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE source_type = 'incoming_invoice') ORDER BY line_no").all() as Array<{ account_number: string; debit_amount: number; credit_amount: number }>;
    expect(rows.map((row) => row.account_number)).toEqual(['4900', '1576', '1600']);
    expect(listOpenItems(db, scope)[0]?.partyType).toBe('creditor');
    db.close();
  });

  it('keeps ambiguous legacy records unresolved in dry-run backfill', () => {
    const db = createDb();
    db.prepare(`INSERT INTO invoices (id, number, client, client_email, date, due_date, amount, status, created_at, updated_at) VALUES ('legacy-1', 'LEG-1', 'Unknown', '', '2026-08-01', '2026-08-31', 119, 'open', datetime('now'), datetime('now'))`).run();
    const preview = previewAccountingBackfill(db, scope);
    expect(preview.readyCount).toBe(0);
    expect(preview.unresolvedCount).toBe(1);
    expect(preview.candidates[0]?.status).toBe('unresolved');
    db.close();
  });
});
