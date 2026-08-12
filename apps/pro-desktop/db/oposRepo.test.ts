import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { bootstrapSql } from './bootstrap';
import { runMigrations } from './migrate';
import { createProTenantScope } from '../tenantScope';
import { getInvoice, upsertInvoice } from './invoicesRepo';
import {
  allocateOpenItemPayment,
  listOpenItems,
  postIncomingInvoice,
  postOutgoingInvoice,
  previewAccountingBackfill,
  confirmAccountingBackfill,
  reverseDocumentAccounting,
  setAccountingPolicyForPro,
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

  it('recognizes Ist VAT only for allocated debtor amounts and never for overpayment', () => {
    const db = createDb();
    db.prepare("INSERT INTO ledger_accounts (id, chart, account_number, name, source, created_at, updated_at) VALUES ('skr03-vat-def', 'SKR03', '1780', 'USt nicht fällig', 'test', datetime('now'), datetime('now'))").run();
    setAccountingPolicyForPro(db, scope, { activeChart: 'SKR03', vatMethod: 'ist' });
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, tax_snapshot_json, created_at, updated_at) VALUES ('inv-ist', 'client-ist', 'RE-IST', 'Acme', 'a@example.test', '2026-08-01', '2026-08-31', 119, 'open', ?, datetime('now'), datetime('now'))`).run(JSON.stringify({ netAmount: 100, vatAmount: 19, grossAmount: 119 }));
    db.prepare(`INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate) VALUES ('inv-ist', 0, 'Service', 1, 119, 119, 19)`);
    postOutgoingInvoice(db, scope, 'inv-ist');
    const item = listOpenItems(db, scope)[0]!;
    allocateOpenItemPayment(db, scope, { sourceType: 'manual', sourceId: 'ist-1', partyType: 'debtor', partyId: 'client-ist', paymentDate: '2026-08-15', amount: 150, bankAccountNumber: '1200', allocations: [{ openItemId: item.id, amount: 50 }] });
    const first = db.prepare("SELECT COALESCE(SUM(credit_amount), 0) AS amount FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE je.source_type = 'payment_vat'").get() as { amount: number };
    expect(first.amount).toBe(7.98);
    expect(db.prepare("SELECT COUNT(*) AS c FROM journal_entries WHERE source_type = 'payment_vat'").get()).toEqual({ c: 1 });
    expect(() => allocateOpenItemPayment(db, scope, { sourceType: 'manual', sourceId: 'ist-2', partyType: 'debtor', partyId: 'client-ist', paymentDate: '2026-08-16', amount: 100, bankAccountNumber: '1200', allocations: [{ openItemId: item.id, amount: 69 }] })).not.toThrow();
    const complete = db.prepare("SELECT COALESCE(SUM(credit_amount), 0) AS amount FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE je.source_type = 'payment_vat'").get() as { amount: number };
    expect(complete.amount).toBe(19);
    db.close();
  });

  it('rejects an empty chart through the canonical journal seam', () => {
    const db = new Database(':memory:');
    db.exec(bootstrapSql); runMigrations(db);
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, tax_snapshot_json, created_at, updated_at) VALUES ('inv-empty', 'client-empty', 'RE-E', 'Acme', '', '2026-08-01', '2026-08-31', 119, 'open', ?, datetime('now'), datetime('now'))`).run(JSON.stringify({ netAmount: 100, vatAmount: 19, grossAmount: 119 }));
    db.prepare(`INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate) VALUES ('inv-empty', 0, 'Service', 1, 119, 119, 19)`);
    expect(postOutgoingInvoice(db, scope, 'inv-empty').status).toBe('unresolved');
    expect((db.prepare("SELECT COUNT(*) AS c FROM journal_entries").get() as { c: number }).c).toBe(0);
    db.close();
  });

  it('freezes posted documents and reverses only without allocations', () => {
    const db = createDb();
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, tax_snapshot_json, created_at, updated_at) VALUES ('inv-rev', 'client-rev', 'RE-R', 'Acme', '', '2026-08-01', '2026-08-31', 119, 'open', ?, datetime('now'), datetime('now'))`).run(JSON.stringify({ netAmount: 100, vatAmount: 19, grossAmount: 119 }));
    db.prepare(`INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate) VALUES ('inv-rev', 0, 'Service', 1, 119, 119, 19)`);
    postOutgoingInvoice(db, scope, 'inv-rev');
    expect(() => db.prepare("UPDATE invoices SET number = 'MUTATED' WHERE id = 'inv-rev'").run()).toThrow('immutable');
    expect(() => db.prepare("DELETE FROM invoices WHERE id = 'inv-rev'").run()).toThrow('cannot be deleted');
    const reversal = reverseDocumentAccounting(db, scope, { documentType: 'outgoing_invoice', documentId: 'inv-rev', reason: 'Korrektur' });
    expect(reversal.ok).toBe(true);
    expect((db.prepare("SELECT accounting_status, status FROM invoices WHERE id = 'inv-rev'").get() as { accounting_status: string; status: string })).toEqual({ accounting_status: 'reversed', status: 'cancelled' });
    db.close();
  });

  it('rejects a stale backfill preview before changing any record', () => {
    const db = createDb();
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, created_at, updated_at) VALUES ('inv-stale', 'client-stale', 'RE-S', 'Acme', '', '2026-08-01', '2026-08-31', 119, 'open', datetime('now'), datetime('now'))`).run();
    const preview = previewAccountingBackfill(db, scope);
    db.prepare("UPDATE invoices SET number = 'RE-S2' WHERE id = 'inv-stale'").run();
    expect(() => confirmAccountingBackfill(db, scope, { runId: preview.runId, confirmationHash: preview.confirmationHash, reason: 'bestätigt' })).toThrow('BACKFILL_STALE_PREVIEW');
    expect((db.prepare("SELECT status FROM accounting_backfill_runs WHERE id = ?").get(preview.runId) as { status: string }).status).toBe('preview');
    db.close();
  });

  it('validates and atomically books bank payment sources', () => {
    const db = createDb();
    db.prepare("INSERT INTO bank_transactions (id, tenant_id, account_id, date, amount, type, counterparty, purpose, status, source_transaction_id, created_at, updated_at) VALUES ('bank-1', 'default', 'bank-account', '2026-08-15', 119, 'income', 'Acme', 'RE-BANK', 'pending', 'bank-1', datetime('now'), datetime('now'))").run();
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, tax_snapshot_json, created_at, updated_at) VALUES ('inv-bank', 'client-bank', 'RE-B', 'Acme', '', '2026-08-01', '2026-08-31', 119, 'open', ?, datetime('now'), datetime('now'))`).run(JSON.stringify({ netAmount: 100, vatAmount: 19, grossAmount: 119 }));
    db.prepare(`INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate) VALUES ('inv-bank', 0, 'Service', 1, 119, 119, 19)`);
    postOutgoingInvoice(db, scope, 'inv-bank');
    const item = listOpenItems(db, scope)[0]!;
    const payment = allocateOpenItemPayment(db, scope, { sourceType: 'bank_transaction', sourceId: 'bank-1', partyType: 'debtor', partyId: 'client-bank', paymentDate: '2026-08-15', amount: 119, bankAccountNumber: '1200', allocations: [{ openItemId: item.id, amount: 119 }] });
    expect(payment.journalEntryId).toBeTruthy();
    expect((db.prepare("SELECT status, linked_invoice_id FROM bank_transactions WHERE id = 'bank-1'").get() as { status: string; linked_invoice_id: string })).toEqual({ status: 'booked', linked_invoice_id: 'inv-bank' });
    expect(allocateOpenItemPayment(db, scope, { sourceType: 'bank_transaction', sourceId: 'bank-1', partyType: 'debtor', partyId: 'client-bank', paymentDate: '2026-08-15', amount: 119, bankAccountNumber: '1200', allocations: [] }).id).toBe(payment.id);
    db.close();
  });

  it('keeps ordinary draft saves unposted and rolls back draft-to-open on accounting failure', () => {
    const db = createDb();
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, created_at, updated_at) VALUES ('inv-finalize', 'client-finalize', 'RE-F', 'Acme', '', '2026-08-01', '2026-08-31', 119, 'draft', datetime('now'), datetime('now'))`).run();
    db.prepare(`INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate) VALUES ('inv-finalize', 0, 'Ambiguous', 1, 119, 119, NULL)`);
    const draft = getInvoice(db, 'inv-finalize')!;
    upsertInvoice(db, { ...draft, status: 'draft' }, 'save draft');
    expect((db.prepare("SELECT status, accounting_status FROM invoices WHERE id = 'inv-finalize'").get() as { status: string; accounting_status: string })).toEqual({ status: 'draft', accounting_status: 'unposted' });
    expect(() => upsertInvoice(db, { ...draft, status: 'open' }, 'finalize')).toThrow('ACCOUNTING_UNRESOLVED');
    expect((db.prepare("SELECT status, accounting_status FROM invoices WHERE id = 'inv-finalize'").get() as { status: string; accounting_status: string })).toEqual({ status: 'draft', accounting_status: 'unposted' });
    db.close();
  });
});
