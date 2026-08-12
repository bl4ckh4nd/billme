import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { bootstrapSql } from './bootstrap';
import { runMigrations } from './migrate';
import { createProTenantScope } from '../tenantScope';
import {
  allocateOpenItemPayment,
  allocateRemainingOpenItemPayment,
  listOpenItems,
  postIncomingInvoice,
  postOutgoingInvoice,
  previewOutgoingInvoice,
  previewAccountingBackfill,
  confirmAccountingBackfill,
  reverseDocumentAccounting,
  setAccountingPolicyForPro,
  upsertAccountingAccountMapping,
  upsertIncomingInvoice,
  upsertVendor,
} from './oposRepo';
import { buildDatevRows, getVatSummary, reverseJournalEntry } from './proAccountingRepo';
import { finalizeOutgoingInvoice, upsertInvoice, getInvoice } from './invoicesRepo';

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
    ('skr03-vat-out-7', 'SKR03', '1771', 'USt 7%', 'test', datetime('now'), datetime('now')),
    ('skr03-vat-in-7', 'SKR03', '1571', 'VSt 7%', 'test', datetime('now'), datetime('now')),
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

  it('summarizes Soll VAT once from the revenue basis line and neutralizes reversal', () => {
    const db = createDb();
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, tax_snapshot_json, created_at, updated_at) VALUES ('inv-vat', 'client-vat', 'RE-VAT', 'Acme', '', '2026-08-01', '2026-08-31', 119, 'open', ?, datetime('now'), datetime('now'))`).run(JSON.stringify({ netAmount: 100, vatAmount: 19, grossAmount: 119 }));
    db.prepare(`INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate) VALUES ('inv-vat', 0, 'Service', 1, 119, 119, 19)`).run();
    postOutgoingInvoice(db, scope, 'inv-vat');
    expect(getVatSummary(db, {}, scope).rows).toEqual([expect.objectContaining({ taxCaseKey: 'DE_STD_19', netAmount: 100, taxAmount: 19, grossAmount: 119, lineCount: 1 })]);
    reverseDocumentAccounting(db, scope, { documentType: 'outgoing_invoice', documentId: 'inv-vat', reason: 'Korrektur' });
    expect(getVatSummary(db, {}, scope).rows[0]).toMatchObject({ taxCaseKey: 'DE_STD_19', netAmount: 0, taxAmount: 0, grossAmount: 0 });
    db.close();
  });

  it('posts each vatBreakdown rate with its own tax case and basis amounts', () => {
    const db = createDb();
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, tax_snapshot_json, created_at, updated_at) VALUES ('inv-mixed', 'client-mixed', 'RE-MIXED', 'Acme', '', '2026-08-01', '2026-08-31', 172.5, 'open', ?, datetime('now'), datetime('now'))`).run(JSON.stringify({ netAmount: 150, vatAmount: 22.5, grossAmount: 172.5, vatBreakdown: [{ rate: 19, netAmount: 100, vatAmount: 19 }, { rate: 7, netAmount: 50, vatAmount: 3.5 }] }));
    const preview = postOutgoingInvoice(db, scope, 'inv-mixed');
    expect(preview.status).toBe('ready');
    const rows = db.prepare("SELECT tax_case_key, net_amount, tax_amount, gross_amount FROM journal_lines WHERE entry_id = (SELECT accounting_journal_entry_id FROM invoices WHERE id = 'inv-mixed') AND account_number = '8400' ORDER BY line_no").all();
    expect(rows).toEqual([
      { tax_case_key: 'DE_STD_19', net_amount: 100, tax_amount: 19, gross_amount: 119 },
      { tax_case_key: 'DE_STD_7', net_amount: 50, tax_amount: 3.5, gross_amount: 53.5 },
    ]);
    expect(db.prepare("SELECT account_number FROM journal_lines WHERE entry_id = (SELECT accounting_journal_entry_id FROM invoices WHERE id = 'inv-mixed') AND memo LIKE 'USt %' ORDER BY line_no").all()).toEqual([{ account_number: '1776' }, { account_number: '1771' }]);
    expect(db.prepare("SELECT tax_case_key, datev_bu_key FROM journal_posting_pairs WHERE entry_id = (SELECT accounting_journal_entry_id FROM invoices WHERE id = 'inv-mixed') AND tax_case_key IS NOT NULL ORDER BY id").all()).toEqual(expect.arrayContaining([{ tax_case_key: 'DE_STD_19', datev_bu_key: '1' }, { tax_case_key: 'DE_STD_7', datev_bu_key: '2' }]));
    db.close();
  });

  it('maps zero-tax invoice modes to their legal tax cases instead of standard 19%', () => {
    const db = createDb();
    const insert = db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, tax_mode, tax_snapshot_json, created_at, updated_at) VALUES (?, ?, ?, 'Acme', '', '2026-08-01', '2026-08-31', 100, 'open', ?, ?, datetime('now'), datetime('now'))`);
    insert.run('inv-ku', 'client-ku', 'RE-KU', 'small_business_19_ustg', JSON.stringify({ netAmount: 100, vatAmount: 0, grossAmount: 100, einvoiceCategoryCode: 'E' }));
    insert.run('inv-rc', 'client-rc', 'RE-RC', 'reverse_charge_13b', JSON.stringify({ netAmount: 100, vatAmount: 0, grossAmount: 100, einvoiceCategoryCode: 'AE' }));
    db.prepare("UPDATE invoices SET tax_meta_json = ? WHERE id = 'inv-ku'").run(JSON.stringify({ datevEvidenceType: 'exemption', datevEvidenceReference: '§19 UStG' }));
    db.prepare("UPDATE invoices SET tax_meta_json = ? WHERE id = 'inv-rc'").run(JSON.stringify({ datevEvidenceType: 'reverse_charge', datevEvidenceReference: '13' }));
    postOutgoingInvoice(db, scope, 'inv-ku');
    postOutgoingInvoice(db, scope, 'inv-rc');
    const rows = db.prepare("SELECT i.id, jl.tax_case_key FROM invoices i JOIN journal_entries je ON je.id = i.accounting_journal_entry_id JOIN journal_lines jl ON jl.entry_id = je.id WHERE i.id IN ('inv-ku', 'inv-rc') AND jl.account_number = '8400' ORDER BY i.id").all();
    expect(rows).toEqual([{ id: 'inv-ku', tax_case_key: 'DE_KU19' }, { id: 'inv-rc', tax_case_key: 'DE_RC_13B_DOMESTIC' }]);
    db.close();
  });

  it('carries persisted EU evidence from an invoice into DATEV fields 40, 41 and 43', () => {
    const db = createDb();
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, tax_mode, tax_meta_json, tax_snapshot_json, created_at, updated_at) VALUES ('inv-eu-rc', 'client-eu', 'RE-EU', 'EU GmbH', '', '2026-08-01', '2026-08-31', 100, 'open', 'intra_eu_service_reverse_charge', ?, ?, datetime('now'), datetime('now'))`).run(
      JSON.stringify({ buyerCountryCode: 'AT', buyerVatId: 'ATU12345678', destinationVatRate: 19, taxRuleConfirmed: true, datevEvidenceType: 'reverse_charge', datevEvidenceReference: 'invoice-proof-1', datevSachverhaltLl: '13' }),
      JSON.stringify({ netAmount: 100, vatAmount: 0, grossAmount: 100, einvoiceCategoryCode: 'AE' }),
    );
    db.prepare(`INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate) VALUES ('inv-eu-rc', 0, 'EU service', 1, 100, 100, 0)`);
    expect(postOutgoingInvoice(db, scope, 'inv-eu-rc').status).toBe('ready');
    expect(db.prepare("SELECT country_code, counterparty_vat_id, evidence_type, evidence_reference, datev_sachverhalt_ll FROM journal_lines WHERE entry_id = (SELECT accounting_journal_entry_id FROM invoices WHERE id = 'inv-eu-rc') AND tax_case_key = 'EU_B2B_SERVICE_RC'").get()).toEqual({ country_code: 'AT', counterparty_vat_id: 'ATU12345678', evidence_type: 'reverse_charge', evidence_reference: 'invoice-proof-1', datev_sachverhalt_ll: '13' });
    expect(db.prepare("SELECT country_code, counterparty_vat_id, evidence_type, evidence_reference FROM vat_evidence WHERE entry_id = (SELECT accounting_journal_entry_id FROM invoices WHERE id = 'inv-eu-rc')").get()).toEqual({ country_code: 'AT', counterparty_vat_id: 'ATU12345678', evidence_type: 'reverse_charge', evidence_reference: 'invoice-proof-1' });
    const rows = buildDatevRows(db, { from: '2026-08-01', to: '2026-08-31' }, scope);
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ euLandUstId: 'ATU12345678', euSteuersatz: 19, sachverhaltLl: '13', buSchluessel: '0094' })]));
    reverseDocumentAccounting(db, scope, { documentType: 'outgoing_invoice', documentId: 'inv-eu-rc', reason: 'Korrektur', postingDate: '2026-08-02' });
    expect(db.prepare("SELECT datev_sachverhalt_ll, evidence_reference FROM journal_lines WHERE entry_id = (SELECT reversed_entry_id FROM journal_entries WHERE id = (SELECT accounting_journal_entry_id FROM invoices WHERE id = 'inv-eu-rc')) AND tax_case_key = 'EU_B2B_SERVICE_RC'").get()).toEqual({ datev_sachverhalt_ll: '13', evidence_reference: 'invoice-proof-1' });
    db.close();
  });

  it('allocates partial payment and projects the open-item status', () => {
    const db = createDb();
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, tax_snapshot_json, created_at, updated_at) VALUES ('inv-2', 'client-2', 'RE-2', 'Acme', 'a@example.test', '2026-08-01', '2026-08-31', 119, 'open', ?, datetime('now'), datetime('now'))`).run(JSON.stringify({ netAmount: 100, vatAmount: 19, grossAmount: 119 }));
    db.prepare(`INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate) VALUES ('inv-2', 0, 'Service', 1, 119, 119, 19)`);
    postOutgoingInvoice(db, scope, 'inv-2');
    const item = listOpenItems(db, scope)[0]!;
    allocateOpenItemPayment(db, scope, { sourceType: 'manual', sourceId: 'pay-1', partyType: 'debtor', partyId: 'client-2', paymentDate: '2026-08-15', amount: 50, bankAccountNumber: '1200', reason: 'test allocation', allocationEventId: 'test-event', allocations: [{ openItemId: item.id, amount: 50 }] });
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
    const payment = allocateOpenItemPayment(db, scope, { sourceType: 'manual', sourceId: 'pay-over', partyType: 'debtor', partyId: 'client-over', paymentDate: '2026-08-15', amount: 150, bankAccountNumber: '1200', reason: 'test allocation', allocationEventId: 'test-event', allocations: [{ openItemId: item.id, amount: 119 }] });
    expect(payment.residualAmount).toBe(31);
    expect(listOpenItems(db, scope)[0]?.status).toBe('paid');
    expect((db.prepare("SELECT status FROM invoices WHERE id = 'inv-over'").get() as { status: string }).status).toBe('paid');
    db.close();
  });

  it('posts incoming invoices as expense plus input VAT against creditors', () => {
    const db = createDb();
    const vendor = upsertVendor(db, scope, { id: 'vendor-1', name: 'Supplier', mutation: { reason: 'test' } });
    const invoice = upsertIncomingInvoice(db, scope, { id: 'in-1', tenantId: 'default', vendorId: vendor.id, number: 'ER-1', invoiceDate: '2026-08-02', dueDate: '2026-08-31', netAmount: 100, taxAmount: 19, grossAmount: 119, taxRate: 19, status: 'draft', accountingStatus: 'unposted', lines: [{ id: 'line-1', incomingInvoiceId: 'in-1', position: 0, description: 'Hosting', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 19, taxAmount: 19, grossAmount: 119 }] , createdAt: '', updatedAt: '', mutation: { reason: 'test' } });
    expect(postIncomingInvoice(db, scope, invoice.id, { mutation: { reason: 'test post' } }).status).toBe('ready');
    const rows = db.prepare("SELECT account_number, debit_amount, credit_amount FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE source_type = 'incoming_invoice') ORDER BY line_no").all() as Array<{ account_number: string; debit_amount: number; credit_amount: number }>;
    expect(rows.map((row) => row.account_number)).toEqual(['4900', '1576', '1600']);
    expect(listOpenItems(db, scope)[0]?.partyType).toBe('creditor');
    const invoice7 = upsertIncomingInvoice(db, scope, { id: 'in-7', tenantId: 'default', vendorId: vendor.id, number: 'ER-7', invoiceDate: '2026-08-03', dueDate: '2026-08-31', netAmount: 100, taxAmount: 7, grossAmount: 107, taxRate: 7, status: 'draft', accountingStatus: 'unposted', lines: [{ id: 'line-7', incomingInvoiceId: 'in-7', position: 0, description: 'Book', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 7, taxAmount: 7, grossAmount: 107 }], createdAt: '', updatedAt: '', mutation: { reason: 'test' } });
    postIncomingInvoice(db, scope, invoice7.id, { mutation: { reason: 'test post' } });
    const rows7 = db.prepare("SELECT account_number FROM journal_lines WHERE entry_id = (SELECT accounting_journal_entry_id FROM incoming_invoices WHERE id = 'in-7') ORDER BY line_no").all();
    expect(rows7.map((row) => (row as { account_number: string }).account_number)).toEqual(['4900', '1571', '1600']);
    expect(db.prepare("SELECT tax_case_key, datev_bu_key FROM journal_posting_pairs WHERE entry_id = (SELECT accounting_journal_entry_id FROM incoming_invoices WHERE id = 'in-7') AND tax_case_key IS NOT NULL").all()).toEqual([{ tax_case_key: 'DE_STD_7', datev_bu_key: '2' }, { tax_case_key: 'DE_STD_7', datev_bu_key: '2' }]);
    const incomingRc = upsertIncomingInvoice(db, scope, { id: 'in-non-eu-rc', tenantId: 'default', vendorId: vendor.id, number: 'ER-RC', invoiceDate: '2026-08-04', dueDate: '2026-08-31', netAmount: 100, taxAmount: 0, grossAmount: 100, taxRate: 0, taxCaseKey: 'NON_EU_SERVICE_RC', status: 'draft', accountingStatus: 'unposted', lines: [{ id: 'line-non-eu-rc', incomingInvoiceId: 'in-non-eu-rc', position: 0, description: 'Drittland service', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 0, taxAmount: 0, grossAmount: 100 }], createdAt: '', updatedAt: '', mutation: { reason: 'test' } });
    expect(postIncomingInvoice(db, scope, incomingRc.id, { mutation: { reason: 'test post' } }).status).toBe('unresolved');
    expect((db.prepare("SELECT COUNT(*) AS c FROM journal_entries WHERE source_key = 'incoming-invoice:in-non-eu-rc'").get() as { c: number }).c).toBe(0);
    db.close();
  });

  it('rolls back vendor and incoming invoice writes when the audit append aborts', () => {
    const vendorDb = createDb();
    vendorDb.exec(`CREATE TRIGGER fail_audit_insert BEFORE INSERT ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit blocked'); END;`);
    expect(() => upsertVendor(vendorDb, scope, { id: 'vendor-audit-rollback', name: 'Supplier', mutation: { reason: 'test rollback' } })).toThrow('audit blocked');
    expect(vendorDb.prepare("SELECT COUNT(*) AS count FROM vendors WHERE id = 'vendor-audit-rollback'").get()).toEqual({ count: 0 });
    vendorDb.close();

    const invoiceDb = createDb();
    const vendor = upsertVendor(invoiceDb, scope, { id: 'vendor-audit-invoice', name: 'Supplier', mutation: { reason: 'seed vendor' } });
    invoiceDb.exec(`CREATE TRIGGER fail_audit_insert BEFORE INSERT ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit blocked'); END;`);
    expect(() => upsertIncomingInvoice(invoiceDb, scope, {
      id: 'incoming-audit-rollback', tenantId: 'default', vendorId: vendor.id, number: 'ER-AUDIT',
      invoiceDate: '2026-08-02', dueDate: '2026-08-31', netAmount: 100, taxAmount: 19, grossAmount: 119,
      taxRate: 19, status: 'draft', accountingStatus: 'unposted', lines: [{
        id: 'line-audit-rollback', incomingInvoiceId: 'incoming-audit-rollback', position: 0,
        description: 'Hosting', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 19,
        taxAmount: 19, grossAmount: 119,
      }], createdAt: '', updatedAt: '', mutation: { reason: 'test rollback' },
    })).toThrow('audit blocked');
    expect(invoiceDb.prepare("SELECT COUNT(*) AS count FROM incoming_invoices WHERE id = 'incoming-audit-rollback'").get()).toEqual({ count: 0 });
    expect(invoiceDb.prepare("SELECT COUNT(*) AS count FROM incoming_invoice_lines WHERE incoming_invoice_id = 'incoming-audit-rollback'").get()).toEqual({ count: 0 });
    invoiceDb.close();
  });

  it('excludes draft and unfinalized outgoing invoices from accounting backfill', () => {
    const db = createDb();
    db.prepare(`INSERT INTO invoices (id, number, client, client_email, date, due_date, amount, status, created_at, updated_at) VALUES
      ('draft-backfill', 'DRAFT-1', 'Unknown', '', '2026-08-01', '2026-08-31', 119, 'draft', datetime('now'), datetime('now')),
      ('unfinalized-backfill', 'OPEN-1', 'Unknown', '', '2026-08-01', '2026-08-31', 119, 'open', datetime('now'), datetime('now'))`).run();
    const preview = previewAccountingBackfill(db, scope);
    expect(preview.readyCount).toBe(0);
    expect(preview.candidates.filter((candidate) => candidate.sourceType === 'outgoing_invoice')).toHaveLength(0);
    expect((db.prepare("SELECT COUNT(*) AS c FROM journal_entries WHERE source_type = 'outgoing_invoice'").get() as { c: number }).c).toBe(0);
    db.close();
  });

  it('rejects a backfill when finalization disappears after preview without writing', () => {
    const db = createDb();
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, tax_snapshot_json, created_at, updated_at) VALUES ('inv-backfill-finalized', 'client-backfill', 'RE-BACKFILL', 'Acme', '', '2026-08-01', '2026-08-31', 119, 'open', ?, datetime('now'), datetime('now'))`).run(JSON.stringify({ netAmount: 100, vatAmount: 19, grossAmount: 119 }));
    db.prepare(`INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate) VALUES ('inv-backfill-finalized', 0, 'Service', 1, 119, 119, 19)`);
    db.prepare("INSERT INTO number_reservations (id, kind, number, counter_value, status, document_id, created_at, updated_at) VALUES ('reservation-backfill', 'invoice', 'RE-BACKFILL', 1, 'finalized', 'inv-backfill-finalized', datetime('now'), datetime('now'))").run();
    const preview = previewAccountingBackfill(db, scope);
    expect(preview.readyCount).toBe(1);
    db.prepare("UPDATE number_reservations SET status = 'released' WHERE id = 'reservation-backfill'").run();
    expect(() => confirmAccountingBackfill(db, scope, { runId: preview.runId, confirmationHash: preview.confirmationHash, reason: 'backfill review' })).toThrow('BACKFILL_STALE_PREVIEW');
    expect((db.prepare("SELECT COUNT(*) AS c FROM journal_entries WHERE source_type = 'outgoing_invoice'").get() as { c: number }).c).toBe(0);
    expect((db.prepare("SELECT accounting_status FROM invoices WHERE id = 'inv-backfill-finalized'").get() as { accounting_status: string }).accounting_status).toBe('unposted');
    db.close();
  });

  it('recognizes Ist VAT only for allocated debtor amounts and never for overpayment', () => {
    const db = createDb();
    db.prepare("INSERT INTO ledger_accounts (id, chart, account_number, name, source, created_at, updated_at) VALUES ('skr03-vat-def', 'SKR03', '1780', 'USt nicht fällig', 'test', datetime('now'), datetime('now'))").run();
    setAccountingPolicyForPro(db, scope, { activeChart: 'SKR03', vatMethod: 'ist' });
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, tax_snapshot_json, created_at, updated_at) VALUES ('inv-ist', 'client-ist', 'RE-IST', 'Acme', 'a@example.test', '2026-08-01', '2026-08-31', 119, 'open', ?, datetime('now'), datetime('now'))`).run(JSON.stringify({ netAmount: 100, vatAmount: 19, grossAmount: 119 }));
    db.prepare(`INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate) VALUES ('inv-ist', 0, 'Service', 1, 119, 119, 19)`);
    postOutgoingInvoice(db, scope, 'inv-ist');
    expect(db.prepare("SELECT account_number FROM journal_lines WHERE entry_id = (SELECT accounting_journal_entry_id FROM invoices WHERE id = 'inv-ist') ORDER BY line_no").all()).toEqual([
      { account_number: '1400' }, { account_number: '8400' }, { account_number: '1780' },
    ]);
    const item = listOpenItems(db, scope)[0]!;
    const payment = allocateOpenItemPayment(db, scope, { sourceType: 'manual', sourceId: 'ist-1', partyType: 'debtor', partyId: 'client-ist', paymentDate: '2026-08-15', amount: 150, bankAccountNumber: '1200', reason: 'test allocation', allocationEventId: 'test-event', allocations: [{ openItemId: item.id, amount: 50 }] });
    const first = db.prepare("SELECT COALESCE(SUM(credit_amount), 0) AS amount FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE je.source_type = 'payment_vat'").get() as { amount: number };
    expect(first.amount).toBe(7.98);
    expect(db.prepare("SELECT COUNT(*) AS c FROM journal_entries WHERE source_type = 'payment_vat'").get()).toEqual({ c: 1 });
    expect(allocateRemainingOpenItemPayment(db, scope, payment.id, [{ openItemId: item.id, amount: 69 }], 'remaining-69', { reason: 'test remaining' }).residualAmount).toBe(31);
    const complete = db.prepare("SELECT COALESCE(SUM(credit_amount), 0) AS amount FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id WHERE je.source_type = 'payment_vat'").get() as { amount: number };
    expect(complete.amount).toBe(19);
    expect(db.prepare("SELECT COUNT(*) AS c FROM journal_entries WHERE source_type = 'payment_vat'").get()).toEqual({ c: 2 });
    expect(getVatSummary(db, {}, scope).rows[0]).toMatchObject({ taxCaseKey: 'DE_STD_19', netAmount: 100, taxAmount: 19, grossAmount: 119 });
    db.close();
  });

  it('uses a custom deferred VAT account when the chart omits the built-in account', () => {
    const db = createDb();
    db.prepare("INSERT INTO ledger_accounts (id, chart, account_number, name, source, created_at, updated_at) VALUES ('skr03-vat-def-custom', 'SKR03', '1790', 'USt nicht fällig custom', 'test', datetime('now'), datetime('now'))").run();
    setAccountingPolicyForPro(db, scope, { activeChart: 'SKR03', vatMethod: 'ist' });
    upsertAccountingAccountMapping(db, scope, { chart: 'SKR03', role: 'output_vat_deferred', accountNumber: '1790' });
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, tax_snapshot_json, created_at, updated_at) VALUES ('inv-ist-custom', 'client-ist-custom', 'RE-IST-CUSTOM', 'Acme', '', '2026-08-01', '2026-08-31', 119, 'open', ?, datetime('now'), datetime('now'))`).run(JSON.stringify({ netAmount: 100, vatAmount: 19, grossAmount: 119 }));
    db.prepare("INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate) VALUES ('inv-ist-custom', 0, 'Service', 1, 119, 119, 19)").run();
    expect(previewOutgoingInvoice(db, scope, 'inv-ist-custom').snapshot?.lines.map((line) => line.accountNumber)).toEqual(['1400', '8400', '1790']);
    postOutgoingInvoice(db, scope, 'inv-ist-custom');
    const item = listOpenItems(db, scope)[0]!;
    allocateOpenItemPayment(db, scope, { sourceType: 'manual', sourceId: 'custom-ist-payment', partyType: 'debtor', partyId: 'client-ist-custom', paymentDate: '2026-08-15', amount: 119, bankAccountNumber: '1200', reason: 'test allocation', allocationEventId: 'test-event', allocations: [{ openItemId: item.id, amount: 119 }] });
    expect(db.prepare("SELECT account_number FROM journal_lines WHERE entry_id = (SELECT accounting_journal_entry_id FROM invoices WHERE id = 'inv-ist-custom') ORDER BY line_no").all()).toEqual([{ account_number: '1400' }, { account_number: '8400' }, { account_number: '1790' }]);
    expect(db.prepare("SELECT DISTINCT account_number FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE source_type = 'payment_vat')").all()).toEqual(expect.arrayContaining([{ account_number: '1776' }, { account_number: '1790' }]));
    db.close();
  });

  it('updates payment totals from allocation rows and caps remaining allocation atomically', () => {
    const db = createDb();
    const makeInvoice = (id: string, clientId: string, number: string, gross: number) => {
      db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, tax_snapshot_json, created_at, updated_at) VALUES (?, ?, ?, 'Acme', '', '2026-08-01', '2026-08-31', ?, 'open', ?, datetime('now'), datetime('now'))`).run(id, clientId, number, gross, JSON.stringify({ netAmount: gross / 1.19, vatAmount: gross - gross / 1.19, grossAmount: gross }));
      db.prepare(`INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate) VALUES (?, 0, 'Service', 1, ?, ?, 19)`).run(id, gross, gross);
      postOutgoingInvoice(db, scope, id);
    };
    makeInvoice('inv-pay-1', 'client-pay', 'RE-P1', 119);
    makeInvoice('inv-pay-2', 'client-pay', 'RE-P2', 31);
    const items = listOpenItems(db, scope);
    const payment = allocateOpenItemPayment(db, scope, { sourceType: 'manual', sourceId: 'pay-remaining', partyType: 'debtor', partyId: 'client-pay', paymentDate: '2026-08-15', amount: 150, bankAccountNumber: '1200', reason: 'test allocation', allocationEventId: 'test-event', allocations: [{ openItemId: items.find((item) => item.sourceId === 'inv-pay-1')!.id, amount: 119 }] });
    expect(payment.allocatedAmount).toBe(119);
    const completed = allocateRemainingOpenItemPayment(db, scope, payment.id, [{ openItemId: items.find((item) => item.sourceId === 'inv-pay-2')!.id, amount: 31 }], 'remaining-31', { reason: 'test remaining' });
    expect(completed.allocatedAmount).toBe(150);
    expect(completed.residualAmount).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM open_item_allocations WHERE payment_id = ?').get(payment.id) as { c: number }).c).toBe(2);
    expect(() => allocateRemainingOpenItemPayment(db, scope, payment.id, [{ openItemId: items.find((item) => item.sourceId === 'inv-pay-2')!.id, amount: 1 }], 'remaining-1', { reason: 'test remaining' })).toThrow('PAYMENT_ALLOCATION_EXCEEDS_RESIDUAL');
    expect((db.prepare('SELECT allocated_amount, residual_amount FROM open_item_payments WHERE id = ?').get(payment.id) as { allocated_amount: number; residual_amount: number })).toEqual({ allocated_amount: 150, residual_amount: 0 });
    db.close();
  });

  it('does not duplicate a remaining allocation when the same event is retried', () => {
    const db = createDb();
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, tax_snapshot_json, created_at, updated_at) VALUES ('inv-idempotent', 'client-idempotent', 'RE-IDEMPOTENT', 'Acme', '', '2026-08-01', '2026-08-31', 119, 'open', ?, datetime('now'), datetime('now'))`).run(JSON.stringify({ netAmount: 100, vatAmount: 19, grossAmount: 119 }));
    db.prepare(`INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate) VALUES ('inv-idempotent', 0, 'Service', 1, 119, 119, 19)`).run();
    postOutgoingInvoice(db, scope, 'inv-idempotent');
    const item = listOpenItems(db, scope)[0]!;
    const payment = allocateOpenItemPayment(db, scope, { sourceType: 'manual', sourceId: 'pay-idempotent', partyType: 'debtor', partyId: 'client-idempotent', paymentDate: '2026-08-15', amount: 119, bankAccountNumber: '1200', reason: 'Testzahlung', allocationEventId: 'payment-event', allocations: [{ openItemId: item.id, amount: 50 }] });
    const first = allocateRemainingOpenItemPayment(db, scope, payment.id, [{ openItemId: item.id, amount: 50 }], 'remaining-event', { reason: 'Restbetrag zugeordnet' });
    const retry = allocateRemainingOpenItemPayment(db, scope, payment.id, [{ openItemId: item.id, amount: 50 }], 'remaining-event', { reason: 'Restbetrag zugeordnet' });
    expect(retry.allocatedAmount).toBe(first.allocatedAmount);
    expect((db.prepare('SELECT COUNT(*) AS count FROM open_item_allocations WHERE payment_id = ?').get(payment.id) as { count: number }).count).toBe(2);
    expect((db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE entity_type = 'open_item_payment' AND entity_id = ? AND action = 'allocate_remaining'").get(payment.id) as { count: number }).count).toBe(1);
    db.close();
  });

  it('finalizes a reserved draft as open and posted, then permits an idempotent UI save', () => {
    const db = createDb();
    const reservation = { reservationId: 'reservation-event', number: 'RE-EVENT' };
    db.prepare("INSERT INTO number_reservations (id, kind, number, counter_value, status, created_at, updated_at) VALUES (?, 'invoice', ?, 1, 'reserved', datetime('now'), datetime('now'))").run(reservation.reservationId, reservation.number);
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, tax_snapshot_json, created_at, updated_at) VALUES ('inv-final-event', 'client-event', ?, 'Acme', '', '2026-08-01', '2026-08-31', 119, 'draft', ?, datetime('now'), datetime('now'))`).run(reservation.number, JSON.stringify({ netAmount: 100, vatAmount: 19, grossAmount: 119 }));
    db.prepare(`INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate) VALUES ('inv-final-event', 0, 'Service', 1, 119, 119, 19)`);
    finalizeOutgoingInvoice(db, reservation.reservationId, 'inv-final-event');
    expect((db.prepare("SELECT status, accounting_status FROM invoices WHERE id = 'inv-final-event'").get() as { status: string; accounting_status: string })).toEqual({ status: 'open', accounting_status: 'posted' });
    const saved = getInvoice(db, 'inv-final-event')!;
    expect(() => upsertInvoice(db, saved, 'UI save after finalization')).not.toThrow();
    expect((db.prepare("SELECT status, accounting_status FROM invoices WHERE id = 'inv-final-event'").get() as { status: string; accounting_status: string })).toEqual({ status: 'open', accounting_status: 'posted' });
    db.close();
  });

  it('requires a finalized matching reservation for the public outgoing post seam', () => {
    const db = createDb();
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, tax_snapshot_json, created_at, updated_at) VALUES ('inv-public-post', 'client-public', 'RE-PUBLIC', 'Acme', '', '2026-08-01', '2026-08-31', 119, 'draft', ?, datetime('now'), datetime('now'))`).run(JSON.stringify({ netAmount: 100, vatAmount: 19, grossAmount: 119 }));
    expect(() => postOutgoingInvoice(db, scope, 'inv-public-post', { requireFinalizedReservation: true, reservationId: 'missing' })).toThrow('INVOICE_MUST_BE_FINALIZED');
    db.prepare("UPDATE invoices SET status = 'open' WHERE id = 'inv-public-post'").run();
    expect(() => postOutgoingInvoice(db, scope, 'inv-public-post', { requireFinalizedReservation: true, reservationId: 'missing' })).toThrow('NUMBER_FINALIZATION_REQUIRED');
    db.prepare("INSERT INTO number_reservations (id, kind, number, counter_value, status, document_id, created_at, updated_at) VALUES ('reservation-public-post', 'invoice', 'RE-PUBLIC', 1, 'finalized', 'inv-public-post', datetime('now'), datetime('now'))").run();
    expect(postOutgoingInvoice(db, scope, 'inv-public-post', { requireFinalizedReservation: true, reservationId: 'reservation-public-post' }).status).toBe('ready');
    db.close();
  });

  it('fails closed for a soft-locked period on invoice posting', () => {
    const db = createDb();
    db.prepare("INSERT INTO accounting_periods (id, tenant_id, period, fiscal_year, status, starts_at, ends_at, created_at, updated_at) VALUES ('period-locked', 'default', '2026-08', 2026, 'soft_locked', '2026-08-01', '2026-08-31', datetime('now'), datetime('now'))").run();
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, tax_snapshot_json, created_at, updated_at) VALUES ('inv-locked', 'client-lock', 'RE-L', 'Acme', '', '2026-08-01', '2026-08-31', 119, 'open', ?, datetime('now'), datetime('now'))`).run(JSON.stringify({ netAmount: 100, vatAmount: 19, grossAmount: 119 }));
    db.prepare(`INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate) VALUES ('inv-locked', 0, 'Service', 1, 119, 119, 19)`);
    expect(() => postOutgoingInvoice(db, scope, 'inv-locked')).toThrow('SOFT_LOCK_OVERRIDE_REQUIRED');
    expect((db.prepare("SELECT COUNT(*) AS c FROM journal_entries").get() as { c: number }).c).toBe(0);
    expect(postOutgoingInvoice(db, scope, 'inv-locked', { softLockOverride: true, overrideReason: 'Freigabe durch Inhaber' }).status).toBe('ready');
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
    expect(() => reverseJournalEntry(db, (db.prepare("SELECT accounting_journal_entry_id FROM invoices WHERE id = 'inv-rev'").get() as { accounting_journal_entry_id: string }).accounting_journal_entry_id, 'generic reversal', scope)).toThrow('DOCUMENT_REVERSAL_REQUIRED');
    expect(() => db.prepare("UPDATE invoices SET number = 'MUTATED' WHERE id = 'inv-rev'").run()).toThrow('immutable');
    expect(() => db.prepare("DELETE FROM invoices WHERE id = 'inv-rev'").run()).toThrow('cannot be deleted');
    db.prepare("INSERT INTO accounting_periods (id, tenant_id, period, fiscal_year, status, starts_at, ends_at, created_at, updated_at) VALUES ('period-reversal-lock', 'default', '2026-08', 2026, 'soft_locked', '2026-08-01', '2026-08-31', datetime('now'), datetime('now'))").run();
    expect(() => reverseDocumentAccounting(db, scope, { documentType: 'outgoing_invoice', documentId: 'inv-rev', reason: 'Korrektur', postingDate: '2026-08-15' })).toThrow('Soft-locked reversal period');
    const reversal = reverseDocumentAccounting(db, scope, { documentType: 'outgoing_invoice', documentId: 'inv-rev', reason: 'Korrektur', postingDate: '2026-08-15', softLockOverride: true, overrideReason: 'Owner approval' });
    expect(reversal.ok).toBe(true);
    expect((db.prepare("SELECT accounting_status, status FROM invoices WHERE id = 'inv-rev'").get() as { accounting_status: string; status: string })).toEqual({ accounting_status: 'reversed', status: 'cancelled' });
    const reversalAudit = db.prepare("SELECT reason, after_json FROM audit_log WHERE entity_type = 'outgoing_invoice' AND entity_id = 'inv-rev' AND action = 'accounting_reverse'").get() as { reason: string; after_json: string };
    expect(reversalAudit.reason).toContain('Owner approval');
    expect(JSON.parse(reversalAudit.after_json)).toMatchObject({ reversalReason: 'Korrektur', softLockOverrideReason: 'Owner approval' });
    db.prepare("DELETE FROM accounting_periods WHERE id = 'period-reversal-lock'").run();
    expect(() => db.prepare("DELETE FROM invoices WHERE id = 'inv-rev'").run()).toThrow('cannot be deleted');
    expect(() => db.prepare("INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate) VALUES ('inv-rev', 1, 'Locked', 1, 1, 1, 19)").run()).toThrow('immutable');
    const vendor = upsertVendor(db, scope, { id: 'vendor-rev', name: 'Supplier', mutation: { reason: 'test' } });
    const incoming = upsertIncomingInvoice(db, scope, { id: 'in-rev', tenantId: 'default', vendorId: vendor.id, number: 'ER-R', invoiceDate: '2026-08-02', dueDate: '2026-08-31', netAmount: 100, taxAmount: 19, grossAmount: 119, taxRate: 19, status: 'draft', accountingStatus: 'unposted', lines: [{ id: 'line-rev', incomingInvoiceId: 'in-rev', position: 0, description: 'Hosting', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 19, taxAmount: 19, grossAmount: 119 }], createdAt: '', updatedAt: '', mutation: { reason: 'test' } });
    postIncomingInvoice(db, scope, incoming.id, { mutation: { reason: 'test post' } });
    expect(() => db.prepare("UPDATE incoming_invoices SET accounting_status = 'reversed' WHERE id = 'in-rev'").run()).toThrow('immutable');
    db.prepare(`INSERT INTO assets (id, tenant_id, asset_number, name, asset_class, status, activation_date, acquisition_cost, useful_life_years, depreciation_method, cost_center, location, source_incoming_invoice_id, asset_account_number, created_at, updated_at)
      VALUES ('asset-linked-incoming', 'default', 'AN-1', 'Linked asset', 'other', 'aktiv', '2026-08-02', 100, 5, 'linear', 'IT', 'Berlin', 'in-rev', '0480', datetime('now'), datetime('now'))`).run();
    expect(() => reverseDocumentAccounting(db, scope, { documentType: 'incoming_invoice', documentId: 'in-rev', reason: 'Korrektur' })).toThrow('ASSET_CORRECTION_REQUIRED');
    db.prepare("DELETE FROM assets WHERE id = 'asset-linked-incoming'").run();
    expect(reverseDocumentAccounting(db, scope, { documentType: 'incoming_invoice', documentId: 'in-rev', reason: 'Korrektur' }).ok).toBe(true);
    expect(() => db.prepare("DELETE FROM incoming_invoices WHERE id = 'in-rev'").run()).toThrow('cannot be deleted');
    expect(() => db.prepare("INSERT INTO incoming_invoice_lines (id, tenant_id, incoming_invoice_id, position, description, quantity, unit_price, net_amount, tax_rate, tax_amount, gross_amount) VALUES ('line-locked', 'default', 'in-rev', 1, 'Locked', 1, 1, 1, 19, .19, 1.19)").run()).toThrow('immutable');
    db.close();
  });

  it('uses the posting-date BU mapping and preserves it through document reversal/export', () => {
    const db = createDb();
    db.exec('DROP INDEX idx_tax_case_account_mappings_unique');
    db.prepare("UPDATE tax_case_account_mappings SET valid_to = '2026-06-30' WHERE chart = 'SKR03' AND tax_case_key = 'DE_STD_19' AND role = 'datev_bu'").run();
    db.prepare(`INSERT INTO tax_case_account_mappings (id, chart, tax_case_key, role, account_number, datev_bu_key, valid_from, valid_to, updated_at)
      VALUES ('dated-de-std-19', 'SKR03', 'DE_STD_19', 'datev_bu', '1776', '9', '2026-07-01', NULL, datetime('now'))`).run();
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, tax_snapshot_json, created_at, updated_at) VALUES ('inv-dated-bu', 'client-dated', 'RE-DATED', 'Acme', '', '2026-08-01', '2026-08-31', 119, 'open', ?, datetime('now'), datetime('now'))`).run(JSON.stringify({ netAmount: 100, vatAmount: 19, grossAmount: 119 }));
    db.prepare(`INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate) VALUES ('inv-dated-bu', 0, 'Service', 1, 119, 119, 19)`);
    postOutgoingInvoice(db, scope, 'inv-dated-bu');
    const originalId = (db.prepare("SELECT accounting_journal_entry_id FROM invoices WHERE id = 'inv-dated-bu'").get() as { accounting_journal_entry_id: string }).accounting_journal_entry_id;
    expect(db.prepare('SELECT datev_bu_key FROM journal_posting_pairs WHERE entry_id = ? AND tax_case_key = ?').get(originalId, 'DE_STD_19')).toEqual({ datev_bu_key: '9' });
    db.prepare("UPDATE tax_case_account_mappings SET datev_bu_key = '7' WHERE id = 'dated-de-std-19'").run();
    const reversal = reverseDocumentAccounting(db, scope, { documentType: 'outgoing_invoice', documentId: 'inv-dated-bu', reason: 'Korrektur', postingDate: '2026-08-20' });
    expect(db.prepare('SELECT datev_bu_key FROM journal_posting_pairs WHERE entry_id = ? AND tax_case_key = ?').get(reversal.reversalEntryId, 'DE_STD_19')).toEqual({ datev_bu_key: '9' });
    expect(buildDatevRows(db, { from: '2026-08-01', to: '2026-08-31' }, scope).filter((row) => row.buSchluessel).every((row) => row.buSchluessel === '0009')).toBe(true);
    db.close();
  });

  it('rejects a stale backfill preview before changing any record', () => {
    const db = createDb();
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, created_at, updated_at) VALUES ('inv-stale', 'client-stale', 'RE-S', 'Acme', '', '2026-08-01', '2026-08-31', 119, 'open', datetime('now'), datetime('now'))`).run();
    db.prepare("INSERT INTO number_reservations (id, kind, number, counter_value, status, document_id, created_at, updated_at) VALUES ('reservation-stale', 'invoice', 'RE-S', 1, 'finalized', 'inv-stale', datetime('now'), datetime('now'))").run();
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
    const payment = allocateOpenItemPayment(db, scope, { sourceType: 'bank_transaction', sourceId: 'bank-1', partyType: 'debtor', partyId: 'client-bank', paymentDate: '2026-08-15', amount: 119, bankAccountNumber: '1200', reason: 'test allocation', allocationEventId: 'test-event', allocations: [{ openItemId: item.id, amount: 119 }] });
    expect(payment.journalEntryId).toBeTruthy();
    expect(() => reverseJournalEntry(db, payment.journalEntryId!, 'generic payment reversal', scope)).toThrow('PAYMENT_REVERSAL_REQUIRED');
    expect((db.prepare("SELECT status, linked_invoice_id FROM bank_transactions WHERE id = 'bank-1'").get() as { status: string; linked_invoice_id: string })).toEqual({ status: 'booked', linked_invoice_id: 'inv-bank' });
    expect(allocateOpenItemPayment(db, scope, { sourceType: 'bank_transaction', sourceId: 'bank-1', partyType: 'debtor', partyId: 'client-bank', paymentDate: '2026-08-15', amount: 119, bankAccountNumber: '1200', reason: 'test allocation', allocationEventId: 'test-event', allocations: [] }).id).toBe(payment.id);
    db.close();
  });

  it('keeps ordinary draft saves unposted and rolls back draft-to-open on accounting failure', () => {
    const db = createDb();
    db.prepare(`INSERT INTO invoices (id, client_id, number, client, client_email, date, due_date, amount, status, created_at, updated_at) VALUES ('inv-finalize', 'client-finalize', 'RE-F', 'Acme', '', '2026-08-01', '2026-08-31', 119, 'draft', datetime('now'), datetime('now'))`).run();
    db.prepare(`INSERT INTO invoice_items (invoice_id, position, description, quantity, price, total, tax_rate) VALUES ('inv-finalize', 0, 'Ambiguous', 1, 119, 119, NULL)`);
    const draft = getInvoice(db, 'inv-finalize')!;
    upsertInvoice(db, { ...draft, status: 'draft' }, 'save draft');
    expect((db.prepare("SELECT status, accounting_status FROM invoices WHERE id = 'inv-finalize'").get() as { status: string; accounting_status: string })).toEqual({ status: 'draft', accounting_status: 'unposted' });
    expect(() => upsertInvoice(db, { ...draft, status: 'open' }, 'finalize')).toThrow('NUMBER_FINALIZATION_REQUIRED');
    db.prepare("INSERT INTO number_reservations (id, kind, number, counter_value, status, document_id, created_at, updated_at) VALUES ('reservation-invalid-finalize', 'invoice', 'RE-F', 1, 'finalized', 'inv-finalize', datetime('now'), datetime('now'))").run();
    expect(() => upsertInvoice(db, { ...draft, status: 'open' }, 'finalize')).toThrow('ACCOUNTING_UNRESOLVED');
    expect((db.prepare("SELECT status, accounting_status FROM invoices WHERE id = 'inv-finalize'").get() as { status: string; accounting_status: string })).toEqual({ status: 'draft', accounting_status: 'unposted' });
    db.close();
  });
});
