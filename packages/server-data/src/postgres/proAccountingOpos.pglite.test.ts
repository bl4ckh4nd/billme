import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { IncomingInvoiceEntity } from '@billme/accounting-shared';
import { createSingleTenantScope } from '@billme/server-core';
import { PgliteServerDatabase } from '../pglite/database.js';
import { createPostgresProAccountingRepository } from './proAccountingRepository.js';

const TENANT = 'opos-tenant';
const scope = createSingleTenantScope(TENANT, 'pro');
const stamp = '2026-08-01T00:00:00.000Z';
const mutation = { reason: 'test' };

type Db = PgliteServerDatabase;

async function withOpos<T>(work: (database: Db, repo: ReturnType<typeof createPostgresProAccountingRepository>) => Promise<T>, vatMethod: 'soll' | 'ist' = 'soll'): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-opos-'));
  const database = await PgliteServerDatabase.open(dataDir);
  try {
    await database.migrate();
    await database.query(`INSERT INTO tenants (id,slug,display_name,product,created_at,updated_at) VALUES ($1,$1,'OPOS','pro',$2,$2)`, [TENANT, stamp]);
    await database.query(`INSERT INTO accounting_policies (tenant_id,active_chart,vat_method,period_policy,updated_at) VALUES ($1,'SKR03',$2,'calendar_month',$3)`, [TENANT, vatMethod, stamp]);
    await database.query(`INSERT INTO tax_case_account_mappings (id,chart,tax_case_key,role,account_number,datev_bu_key,updated_at) VALUES
      ('m-7-out','SKR03','DE_STD_7','output_tax','1771',NULL,$1),
      ('m-7-in','SKR03','DE_STD_7','input_tax','1571',NULL,$1),
      ('m-7-bu','SKR03','DE_STD_7','datev_bu','1771','2',$1),
      ('m-19-bu','SKR03','DE_STD_19','datev_bu','1776','1',$1)`, [stamp]);
    return await work(database, createPostgresProAccountingRepository(database));
  } finally {
    await database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

interface InvoiceSeed {
  id: string;
  number?: string;
  date?: string;
  status?: string;
  accountingStatus?: string;
  taxMode?: string | null;
  taxMeta?: unknown;
  snapshot?: unknown;
  taxRate?: number;
  reservation?: 'finalized' | 'none';
}

const STD_SNAPSHOT = { netAmount: 100, vatAmount: 19, grossAmount: 119 };

async function seedInvoice(database: Db, seed: InvoiceSeed): Promise<{ id: string; reservationId: string }> {
  const number = seed.number ?? `RE-${seed.id}`;
  const gross = (seed.snapshot as { grossAmount: number } | undefined)?.grossAmount ?? 119;
  await database.query(
    `INSERT INTO invoices (id,tenant_id,number,client,client_email,date,due_date,amount,status,dunning_level,items_json,payments_json,history_json,tax_mode,tax_meta_json,tax_snapshot_json,created_at,updated_at,accounting_status)
     VALUES ($1,$2,$3,'Acme','','${seed.date ?? '2026-08-01'}','2026-08-31',$4,$5,0,$6,'[]','[]',$7,$8,$9,$10,$10,$11)`,
    [
      seed.id, TENANT, number, gross, seed.status ?? 'open',
      JSON.stringify(seed.snapshot && (seed.snapshot as { vatBreakdown?: unknown }).vatBreakdown ? [] : [{ description: 'Service', total: gross, taxRate: seed.taxRate ?? 19 }]),
      seed.taxMode ?? 'standard_vat', seed.taxMeta ? JSON.stringify(seed.taxMeta) : null,
      JSON.stringify(seed.snapshot ?? STD_SNAPSHOT), stamp, seed.accountingStatus ?? 'unposted',
    ],
  );
  const reservationId = `res-${seed.id}`;
  if (seed.reservation !== 'none') {
    await database.query(
      `INSERT INTO number_reservations (id,tenant_id,kind,number,counter_value,status,document_id,created_at,updated_at) VALUES ($1,$2,'invoice',$3,1,'finalized',$4,$5,$5)`,
      [reservationId, TENANT, number, seed.id, stamp],
    );
  }
  return { id: seed.id, reservationId };
}

const one = async <R = Record<string, unknown>>(database: Db, sql: string, params: unknown[] = []): Promise<R> =>
  (await database.query<R>(sql, params)).rows[0] as R;
const all = async <R = Record<string, unknown>>(database: Db, sql: string, params: unknown[] = []): Promise<R[]> =>
  (await database.query<R>(sql, params)).rows;
const count = async (database: Db, sql: string, params: unknown[] = []): Promise<number> =>
  Number((await one<{ c: string | number }>(database, sql, params)).c);

const entryLines = (database: Db, invoiceId: string, table = 'invoices') =>
  all<{ account_number: string; debit_amount: string; credit_amount: string; tax_case_key: string | null; net_amount: string | null; tax_amount: string | null; gross_amount: string | null; memo: string | null }>(
    database,
    `SELECT account_number,debit_amount,credit_amount,tax_case_key,net_amount,tax_amount,gross_amount,memo FROM journal_lines WHERE entry_id=(SELECT accounting_journal_entry_id FROM ${table} WHERE id=$1) ORDER BY line_no`,
    [invoiceId],
  );

const payment = (openItemId: string, amount: number, allocate: number, sourceId: string, eventId = `event-${sourceId}`) => ({
  sourceType: 'manual' as const,
  sourceId,
  partyType: 'debtor' as const,
  paymentDate: '2026-08-15',
  amount,
  bankAccountNumber: '1200',
  reason: 'test allocation',
  allocationEventId: eventId,
  allocations: [{ openItemId, amount: allocate }],
});

const incomingInvoice = (id: string, vendorId: string, overrides: Partial<IncomingInvoiceEntity> & { lineRate?: number } = {}): IncomingInvoiceEntity => {
  const rate = overrides.taxRate ?? 19;
  const tax = Math.round(rate) === 19 ? 19 : Math.round(rate);
  return {
    id, tenantId: TENANT, vendorId, number: `ER-${id}`, invoiceDate: '2026-08-02', dueDate: '2026-08-31',
    netAmount: 100, taxAmount: tax, grossAmount: 100 + tax, taxRate: rate, status: 'open', accountingStatus: 'unposted',
    lines: [{ id: `line-${id}`, incomingInvoiceId: id, position: 0, description: 'Hosting', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: rate, taxAmount: tax, grossAmount: 100 + tax }],
    createdAt: '', updatedAt: '', mutation,
    ...overrides,
  } as IncomingInvoiceEntity;
};

test('outgoing invoice posts once, opens a debtor item and replays idempotently', async () => {
  await withOpos(async (database, repo) => {
    const { id, reservationId } = await seedInvoice(database, { id: 'inv-1' });
    assert.equal((await repo.postOutgoingInvoice(scope, id, { reservationId })).status, 'ready');
    assert.equal((await repo.postOutgoingInvoice(scope, id, { reservationId })).status, 'ready');

    assert.equal(await count(database, `SELECT COUNT(*) c FROM journal_entries WHERE source_type='outgoing_invoice'`), 1);
    const lines = await entryLines(database, id);
    assert.deepEqual(lines.map((l) => [l.account_number, Number(l.debit_amount), Number(l.credit_amount)]), [['1400', 119, 0], ['8400', 0, 100], ['1776', 0, 19]]);
    const items = await repo.listOpenItems(scope);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.partyType, 'debtor');
    assert.equal(items[0]?.residualAmount, 119);
    assert.equal((await one<{ accounting_status: string }>(database, `SELECT accounting_status FROM invoices WHERE id=$1`, [id])).accounting_status, 'posted');
  });
});

test('outgoing post requires a finalized matching reservation and a non-draft document', async () => {
  await withOpos(async (database, repo) => {
    await seedInvoice(database, { id: 'inv-draft', status: 'draft', reservation: 'none' });
    await assert.rejects(() => repo.postOutgoingInvoice(scope, 'inv-draft', {}), /FINALIZED_RESERVATION_REQUIRED/);
    await assert.rejects(() => repo.postOutgoingInvoice(scope, 'inv-draft', { reservationId: 'missing' }), /FINALIZED_RESERVATION_REQUIRED/);
    await database.query(`INSERT INTO number_reservations (id,tenant_id,kind,number,counter_value,status,document_id,created_at,updated_at) VALUES ('res-draft',$1,'invoice','RE-inv-draft',1,'finalized','inv-draft',$2,$2)`, [TENANT, stamp]);
    await assert.rejects(() => repo.postOutgoingInvoice(scope, 'inv-draft', { reservationId: 'res-draft' }), /FINALIZED_RESERVATION_REQUIRED/);
    await database.query(`UPDATE invoices SET status='open' WHERE id='inv-draft'`);
    await database.query(`UPDATE number_reservations SET number='OTHER' WHERE id='res-draft'`);
    await assert.rejects(() => repo.postOutgoingInvoice(scope, 'inv-draft', { reservationId: 'res-draft' }), /FINALIZED_RESERVATION_REQUIRED/);
    await database.query(`UPDATE number_reservations SET number='RE-inv-draft' WHERE id='res-draft'`);
    assert.equal((await repo.postOutgoingInvoice(scope, 'inv-draft', { reservationId: 'res-draft' })).status, 'ready');
    assert.equal(await count(database, `SELECT COUNT(*) c FROM journal_entries`), 1);
  });
});

test('VAT summary counts Soll VAT once from the revenue basis line and reversal neutralizes it', async () => {
  await withOpos(async (database, repo) => {
    const { id, reservationId } = await seedInvoice(database, { id: 'inv-vat' });
    await repo.postOutgoingInvoice(scope, id, { reservationId });
    assert.deepEqual((await repo.getVatSummary(scope, {})).rows, [{ taxCaseKey: 'DE_STD_19', netAmount: 100, taxAmount: 19, grossAmount: 119, lineCount: 1 }]);

    await repo.reverseDocumentAccounting(scope, { documentType: 'outgoing_invoice', documentId: id, reason: 'Korrektur' });
    const [row] = (await repo.getVatSummary(scope, {})).rows;
    assert.equal(row?.taxCaseKey, 'DE_STD_19');
    assert.equal(row?.netAmount, 0);
    assert.equal(row?.taxAmount, 0);
    assert.equal(row?.grossAmount, 0);
  });
});

test('vatBreakdown posts one tax case, VAT account and DATEV BU key per rate', async () => {
  await withOpos(async (database, repo) => {
    const snapshot = { netAmount: 150, vatAmount: 22.5, grossAmount: 172.5, vatBreakdown: [{ rate: 19, netAmount: 100, vatAmount: 19 }, { rate: 7, netAmount: 50, vatAmount: 3.5 }] };
    const { id, reservationId } = await seedInvoice(database, { id: 'inv-mixed', snapshot });
    assert.equal((await repo.postOutgoingInvoice(scope, id, { reservationId })).status, 'ready');

    const lines = await entryLines(database, id);
    assert.deepEqual(
      lines.filter((l) => l.account_number === '8400').map((l) => [l.tax_case_key, Number(l.net_amount), Number(l.tax_amount), Number(l.gross_amount)]),
      [['DE_STD_19', 100, 19, 119], ['DE_STD_7', 50, 3.5, 53.5]],
    );
    assert.deepEqual(
      lines.filter((l) => l.memo?.startsWith('USt ')).map((l) => [l.account_number, Number(l.credit_amount)]),
      [['1776', 19], ['1771', 3.5]],
    );
    const pairs = await all<{ tax_case_key: string; datev_bu_key: string }>(database, `SELECT tax_case_key,datev_bu_key FROM journal_posting_pairs WHERE entry_id=(SELECT accounting_journal_entry_id FROM invoices WHERE id=$1) AND tax_case_key IS NOT NULL ORDER BY tax_case_key`, [id]);
    assert.ok(pairs.length >= 2);
    assert.deepEqual([...new Set(pairs.map((p) => `${p.tax_case_key}:${p.datev_bu_key}`))], ['DE_STD_19:1', 'DE_STD_7:2']);
  });
});

test('zero-tax invoice modes map to their legal tax cases instead of standard 19 percent', async () => {
  await withOpos(async (database, repo) => {
    const zero = { netAmount: 100, vatAmount: 0, grossAmount: 100 };
    const ku = await seedInvoice(database, { id: 'inv-ku', taxMode: 'small_business_19_ustg', taxRate: 0, snapshot: { ...zero, einvoiceCategoryCode: 'E' }, taxMeta: { datevEvidenceType: 'exemption', datevEvidenceReference: '§19 UStG' } });
    const rc = await seedInvoice(database, { id: 'inv-rc', taxMode: 'reverse_charge_13b', taxRate: 0, snapshot: { ...zero, einvoiceCategoryCode: 'AE' }, taxMeta: { datevEvidenceType: 'reverse_charge', datevEvidenceReference: '13' } });
    assert.equal((await repo.postOutgoingInvoice(scope, ku.id, { reservationId: ku.reservationId })).status, 'ready');
    assert.equal((await repo.postOutgoingInvoice(scope, rc.id, { reservationId: rc.reservationId })).status, 'ready');

    const key = async (id: string) => (await entryLines(database, id)).find((l) => l.account_number === '8400')?.tax_case_key;
    assert.equal(await key(ku.id), 'DE_KU19');
    assert.equal(await key(rc.id), 'DE_RC_13B_DOMESTIC');
  });
});

test('overpayment closes the item and stays as payment residual', async () => {
  await withOpos(async (database, repo) => {
    const { id, reservationId } = await seedInvoice(database, { id: 'inv-over' });
    await repo.postOutgoingInvoice(scope, id, { reservationId });
    const [item] = await repo.listOpenItems(scope);
    const paid = await repo.allocateOpenItemPayment(scope, payment(item!.id, 150, 119, 'pay-over'));
    assert.equal(paid.allocatedAmount, 119);
    assert.equal(paid.residualAmount, 31);
    assert.equal(paid.status, 'partially_allocated');
    const [after] = await repo.listOpenItems(scope);
    assert.equal(after?.status, 'paid');
    assert.equal(after?.residualAmount, 0);
    assert.equal((await one<{ status: string }>(database, `SELECT status FROM invoices WHERE id=$1`, [id])).status, 'paid');
  });
});

test('partial payment projects partially_paid and the residual', async () => {
  await withOpos(async (database, repo) => {
    const { id, reservationId } = await seedInvoice(database, { id: 'inv-part' });
    await repo.postOutgoingInvoice(scope, id, { reservationId });
    const [item] = await repo.listOpenItems(scope);
    await repo.allocateOpenItemPayment(scope, payment(item!.id, 50, 50, 'pay-part'));
    const [after] = await repo.listOpenItems(scope);
    assert.equal(after?.status, 'partially_paid');
    assert.equal(after?.residualAmount, 69);
  });
});

test('remaining allocation is capped by the payment residual and a fully allocated payment is not over-allocated', async () => {
  await withOpos(async (database, repo) => {
    const first = await seedInvoice(database, { id: 'inv-cap-1' });
    const second = await seedInvoice(database, { id: 'inv-cap-2', snapshot: { netAmount: 26.05, vatAmount: 4.95, grossAmount: 31 } });
    await repo.postOutgoingInvoice(scope, first.id, { reservationId: first.reservationId });
    await repo.postOutgoingInvoice(scope, second.id, { reservationId: second.reservationId });
    const items = await repo.listOpenItems(scope);
    const item1 = items.find((i) => i.sourceId === first.id)!;
    const item2 = items.find((i) => i.sourceId === second.id)!;
    const paid = await repo.allocateOpenItemPayment(scope, payment(item1.id, 150, 119, 'pay-cap'));

    await assert.rejects(() => repo.allocateRemainingOpenItemPayment(scope, paid.id, [{ openItemId: item2.id, amount: 32 }], 'remaining-32', mutation), /PAYMENT_ALLOCATION_EXCEEDS_RESIDUAL/);
    assert.equal(await count(database, `SELECT COUNT(*) c FROM open_item_allocations WHERE payment_id=$1`, [paid.id]), 1);

    const done = await repo.allocateRemainingOpenItemPayment(scope, paid.id, [{ openItemId: item2.id, amount: 31 }], 'remaining-31', mutation);
    assert.equal(done.allocatedAmount, 150);
    assert.equal(done.residualAmount, 0);
    assert.equal(await count(database, `SELECT COUNT(*) c FROM open_item_allocations WHERE payment_id=$1`, [paid.id]), 2);
    const extra = await repo.allocateRemainingOpenItemPayment(scope, paid.id, [{ openItemId: item2.id, amount: 1 }], 'remaining-1', mutation);
    assert.equal(extra.allocatedAmount, 150);
    assert.equal(await count(database, `SELECT COUNT(*) c FROM open_item_allocations WHERE payment_id=$1`, [paid.id]), 2);
    const row = await one<{ allocated_amount: string; residual_amount: string }>(database, `SELECT allocated_amount,residual_amount FROM open_item_payments WHERE id=$1`, [paid.id]);
    assert.deepEqual([Number(row.allocated_amount), Number(row.residual_amount)], [150, 0]);
  });
});

test('retrying the same remaining-allocation event does not duplicate the allocation', async () => {
  await withOpos(async (database, repo) => {
    const { id, reservationId } = await seedInvoice(database, { id: 'inv-idem' });
    await repo.postOutgoingInvoice(scope, id, { reservationId });
    const [item] = await repo.listOpenItems(scope);
    const paid = await repo.allocateOpenItemPayment(scope, payment(item!.id, 150, 100, 'pay-idem', 'payment-event'));

    const first = await repo.allocateRemainingOpenItemPayment(scope, paid.id, [{ openItemId: item!.id, amount: 19 }], 'remaining-event', mutation);
    const retry = await repo.allocateRemainingOpenItemPayment(scope, paid.id, [{ openItemId: item!.id, amount: 19 }], 'remaining-event', mutation);
    assert.equal(first.allocatedAmount, 119);
    assert.equal(retry.allocatedAmount, 119);
    assert.equal(retry.residualAmount, 31);
    assert.equal(await count(database, `SELECT COUNT(*) c FROM open_item_allocations WHERE payment_id=$1`, [paid.id]), 2);
    const [after] = await repo.listOpenItems(scope);
    assert.equal(after?.allocatedAmount, 119);
    assert.equal(after?.residualAmount, 0);
  });
});

test('Ist VAT is recognized only for allocated debtor amounts, never for overpayment', async () => {
  await withOpos(async (database, repo) => {
    const { id, reservationId } = await seedInvoice(database, { id: 'inv-ist' });
    await repo.postOutgoingInvoice(scope, id, { reservationId });
    assert.deepEqual((await entryLines(database, id)).map((l) => l.account_number), ['1400', '8400', '1780']);

    const [item] = await repo.listOpenItems(scope);
    const paid = await repo.allocateOpenItemPayment(scope, payment(item!.id, 150, 50, 'pay-ist'));
    const vat = () => one<{ credit: string; entries: string }>(database, `SELECT COALESCE(SUM(jl.credit_amount),0) credit, COUNT(DISTINCT je.id) entries FROM journal_lines jl JOIN journal_entries je ON je.id=jl.entry_id WHERE je.source_type='payment_vat'`);
    const partial = await vat();
    assert.equal(Number(partial.credit), 7.98);
    assert.equal(Number(partial.entries), 1);

    const done = await repo.allocateRemainingOpenItemPayment(scope, paid.id, [{ openItemId: item!.id, amount: 69 }], 'remaining-69', mutation);
    assert.equal(done.residualAmount, 31);
    const complete = await vat();
    assert.equal(Number(complete.credit), 19);
    assert.equal(Number(complete.entries), 2);
    assert.equal((await repo.getVatSummary(scope, {})).rows[0]?.taxAmount, 19);
  }, 'ist');
});

test('a custom deferred VAT account replaces the built-in Ist account', async () => {
  await withOpos(async (database, repo) => {
    await repo.upsertAccountingAccountMapping(scope, { chart: 'SKR03', role: 'output_vat_deferred', accountNumber: '1790' });
    const { id, reservationId } = await seedInvoice(database, { id: 'inv-custom' });
    const preview = await repo.previewOutgoingInvoice(scope, id);
    assert.deepEqual(preview.snapshot?.lines.map((l) => l.accountNumber), ['1400', '8400', '1790']);

    await repo.postOutgoingInvoice(scope, id, { reservationId });
    const [item] = await repo.listOpenItems(scope);
    await repo.allocateOpenItemPayment(scope, payment(item!.id, 119, 119, 'pay-custom'));
    assert.deepEqual((await entryLines(database, id)).map((l) => l.account_number), ['1400', '8400', '1790']);
    const accounts = await all<{ account_number: string }>(database, `SELECT DISTINCT account_number FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE source_type='payment_vat') ORDER BY 1`);
    assert.deepEqual(accounts.map((a) => a.account_number), ['1776', '1790']);
  }, 'ist');
});

test('DATEV BU key follows the posting date and is preserved through document reversal', async () => {
  await withOpos(async (database, repo) => {
    await database.query(`UPDATE tax_case_account_mappings SET valid_to='2026-06-30' WHERE id='m-19-bu'`);
    await database.query(`INSERT INTO tax_case_account_mappings (id,chart,tax_case_key,role,account_number,datev_bu_key,valid_from,valid_to,updated_at) VALUES ('m-19-bu-new','SKR03','DE_STD_19','datev_bu','1776','9','2026-07-01',NULL,$1)`, [stamp]);
    const { id, reservationId } = await seedInvoice(database, { id: 'inv-bu' });
    await repo.postOutgoingInvoice(scope, id, { reservationId });
    const originalId = (await one<{ accounting_journal_entry_id: string }>(database, `SELECT accounting_journal_entry_id FROM invoices WHERE id=$1`, [id])).accounting_journal_entry_id;
    const keys = (entryId: string) => all<{ datev_bu_key: string }>(database, `SELECT datev_bu_key FROM journal_posting_pairs WHERE entry_id=$1 AND tax_case_key='DE_STD_19'`, [entryId]);
    assert.deepEqual((await keys(originalId)).map((k) => k.datev_bu_key), ['9']);

    await database.query(`UPDATE tax_case_account_mappings SET datev_bu_key='7' WHERE id='m-19-bu-new'`);
    const reversal = await repo.reverseDocumentAccounting(scope, { documentType: 'outgoing_invoice', documentId: id, reason: 'Korrektur', postingDate: '2026-08-20' });
    assert.deepEqual((await keys(reversal.reversalEntryId)).map((k) => k.datev_bu_key), ['9']);
  });
});

test('incoming invoices post expense plus input VAT against creditors, per rate', async () => {
  await withOpos(async (database, repo) => {
    const vendor = await repo.upsertVendor(scope, { id: 'vendor-1', name: 'Supplier', mutation });
    await repo.upsertIncomingInvoice(scope, incomingInvoice('in-19', vendor.id));
    await repo.upsertIncomingInvoice(scope, incomingInvoice('in-7', vendor.id, { taxRate: 7 }));
    assert.equal((await repo.postIncomingInvoice(scope, 'in-19', { mutation })).status, 'ready');
    assert.equal((await repo.postIncomingInvoice(scope, 'in-7', { mutation })).status, 'ready');

    const rows19 = await entryLines(database, 'in-19', 'incoming_invoices');
    assert.deepEqual(rows19.map((l) => [l.account_number, Number(l.debit_amount), Number(l.credit_amount)]), [['4900', 100, 0], ['1576', 19, 0], ['1600', 0, 119]]);
    const rows7 = await entryLines(database, 'in-7', 'incoming_invoices');
    assert.deepEqual(rows7.map((l) => [l.account_number, Number(l.debit_amount), Number(l.credit_amount)]), [['4900', 100, 0], ['1571', 7, 0], ['1600', 0, 107]]);
    assert.ok((await repo.listOpenItems(scope)).every((item) => item.partyType === 'creditor'));
  });
});

test('incoming non-EU reverse charge without DATEV evidence stays unresolved and writes nothing', async () => {
  await withOpos(async (database, repo) => {
    const vendor = await repo.upsertVendor(scope, { id: 'vendor-rc', name: 'Supplier', mutation });
    await repo.upsertIncomingInvoice(scope, incomingInvoice('in-non-eu-rc', vendor.id, { taxRate: 0, taxAmount: 0, grossAmount: 100, taxCaseKey: 'NON_EU_SERVICE_RC' } as Partial<IncomingInvoiceEntity>));
    const result = await repo.postIncomingInvoice(scope, 'in-non-eu-rc', { mutation });
    assert.equal(result.status, 'unresolved');
    assert.equal(await count(database, `SELECT COUNT(*) c FROM journal_entries WHERE source_key='incoming-invoice:in-non-eu-rc'`), 0);
    assert.equal(await count(database, `SELECT COUNT(*) c FROM open_items`), 0);
    assert.equal((await one<{ accounting_status: string }>(database, `SELECT accounting_status FROM incoming_invoices WHERE id='in-non-eu-rc'`)).accounting_status, 'unposted');
  });
});

test('an aborted audit append rolls back the vendor and the incoming invoice with its lines', async () => {
  await withOpos(async (database, repo) => {
    const vendor = await repo.upsertVendor(scope, { id: 'vendor-audit', name: 'Supplier', mutation });
    await database.query(`CREATE FUNCTION fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit blocked'; END $$`);
    await database.query(`CREATE TRIGGER fail_audit_insert BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION fail_audit()`);
    const auditBlocked = (error: unknown) => /audit blocked/.test(String((error as { cause?: { message?: string } }).cause?.message ?? (error as Error).message));
    const inTransaction = <T>(work: (r: ReturnType<typeof createPostgresProAccountingRepository>) => Promise<T>) =>
      database.transaction({ isolation: 'serializable' }, (session) => work(createPostgresProAccountingRepository(session)));

    await assert.rejects(() => inTransaction((r) => r.upsertVendor(scope, { id: 'vendor-rollback', name: 'Supplier', mutation })), auditBlocked);
    assert.equal(await count(database, `SELECT COUNT(*) c FROM vendors WHERE id='vendor-rollback'`), 0);

    await assert.rejects(() => inTransaction((r) => r.upsertIncomingInvoice(scope, incomingInvoice('in-rollback', vendor.id, { status: 'draft' }))), auditBlocked);
    assert.equal(await count(database, `SELECT COUNT(*) c FROM incoming_invoices WHERE id='in-rollback'`), 0);
    assert.equal(await count(database, `SELECT COUNT(*) c FROM incoming_invoice_lines WHERE incoming_invoice_id='in-rollback'`), 0);
  });
});

test('accounting backfill excludes drafts and documents without a finalized reservation', async () => {
  await withOpos(async (database, repo) => {
    await seedInvoice(database, { id: 'bf-draft', status: 'draft' });
    await seedInvoice(database, { id: 'bf-unfinalized', reservation: 'none' });
    const preview = await repo.previewAccountingBackfill(scope);
    assert.equal(preview.readyCount, 0);
    assert.equal(preview.candidates.filter((c) => c.sourceType === 'outgoing_invoice').length, 0);
    assert.equal(await count(database, `SELECT COUNT(*) c FROM journal_entries`), 0);
  });
});

test('accounting backfill excludes cancelled/reversed documents and direct reposting is rejected without writes', async () => {
  await withOpos(async (database, repo) => {
    const { id, reservationId } = await seedInvoice(database, { id: 'bf-terminal', status: 'cancelled', accountingStatus: 'reversed' });
    const vendor = await repo.upsertVendor(scope, { id: 'vendor-terminal', name: 'Supplier', mutation });
    await repo.upsertIncomingInvoice(scope, incomingInvoice('in-terminal', vendor.id));
    await database.query(`UPDATE incoming_invoices SET status='cancelled',accounting_status='reversed' WHERE id='in-terminal'`);

    const preview = await repo.previewAccountingBackfill(scope);
    assert.equal(preview.candidates.some((c) => c.sourceId === id || c.sourceId === 'in-terminal'), false);
    await assert.rejects(() => repo.postOutgoingInvoice(scope, id, { reservationId }), /DOCUMENT_NOT_POSTABLE/);
    await assert.rejects(() => repo.postIncomingInvoice(scope, 'in-terminal', { mutation }), /DOCUMENT_NOT_POSTABLE/);
    assert.equal(await count(database, `SELECT COUNT(*) c FROM journal_entries`), 0);
    assert.equal(await count(database, `SELECT COUNT(*) c FROM open_items`), 0);
  });
});

test('backfill confirm is stale when an eligible outgoing document became terminal after preview', async () => {
  await withOpos(async (database, repo) => {
    await seedInvoice(database, { id: 'bf-stale-terminal' });
    const preview = await repo.previewAccountingBackfill(scope);
    assert.ok(preview.candidates.some((c) => c.sourceId === 'bf-stale-terminal' && c.status === 'ready'));
    await database.query(`UPDATE invoices SET status='cancelled',accounting_status='reversed' WHERE id='bf-stale-terminal'`);

    await assert.rejects(() => repo.confirmAccountingBackfill(scope, { runId: preview.runId, confirmationHash: preview.confirmationHash, reason: 'terminal state changed' }), /BACKFILL_STALE_PREVIEW/);
    assert.equal(await count(database, `SELECT COUNT(*) c FROM journal_entries`), 0);
    assert.deepEqual(await one(database, `SELECT accounting_status,status FROM invoices WHERE id='bf-stale-terminal'`), { accounting_status: 'reversed', status: 'cancelled' });
  });
});

test('backfill confirm is stale when the finalized reservation disappears after preview', async () => {
  await withOpos(async (database, repo) => {
    const { reservationId } = await seedInvoice(database, { id: 'bf-final-gone' });
    const preview = await repo.previewAccountingBackfill(scope);
    assert.equal(preview.readyCount, 1);
    await database.query(`UPDATE number_reservations SET status='released' WHERE id=$1`, [reservationId]);

    await assert.rejects(() => repo.confirmAccountingBackfill(scope, { runId: preview.runId, confirmationHash: preview.confirmationHash, reason: 'backfill review' }), /BACKFILL_STALE_PREVIEW/);
    assert.equal(await count(database, `SELECT COUNT(*) c FROM journal_entries WHERE source_type='outgoing_invoice'`), 0);
    assert.equal((await one<{ accounting_status: string }>(database, `SELECT accounting_status FROM invoices WHERE id='bf-final-gone'`)).accounting_status, 'unposted');
  });
});

test('backfill confirm rejects a stale preview before changing any record', async () => {
  await withOpos(async (database, repo) => {
    await seedInvoice(database, { id: 'bf-stale', number: 'RE-S' });
    const preview = await repo.previewAccountingBackfill(scope);
    assert.equal(preview.readyCount, 1);
    await database.query(`UPDATE invoices SET number='RE-S2' WHERE id='bf-stale'`);

    await assert.rejects(() => repo.confirmAccountingBackfill(scope, { runId: preview.runId, confirmationHash: preview.confirmationHash, reason: 'bestätigt' }), /BACKFILL_STALE_PREVIEW/);
    assert.equal((await one<{ status: string }>(database, `SELECT status FROM accounting_backfill_runs WHERE id=$1`, [preview.runId])).status, 'preview');
    assert.equal(await count(database, `SELECT COUNT(*) c FROM journal_entries`), 0);
  });
});

test('backfill confirm is stale when the posting configuration changed after preview', async () => {
  await withOpos(async (database, repo) => {
    await seedInvoice(database, { id: 'bf-config' });
    const preview = await repo.previewAccountingBackfill(scope);
    await repo.upsertAccountingAccountMapping(scope, { chart: 'SKR03', role: 'revenue', accountNumber: '8300' });
    await assert.rejects(() => repo.confirmAccountingBackfill(scope, { runId: preview.runId, confirmationHash: preview.confirmationHash, reason: 'config changed' }), /BACKFILL_STALE_PREVIEW/);
    assert.equal(await count(database, `SELECT COUNT(*) c FROM journal_entries`), 0);
  });
});

test('posting into a soft-locked period fails closed unless overridden with a reason', async () => {
  await withOpos(async (database, repo) => {
    await database.query(`INSERT INTO accounting_periods (id,tenant_id,period,fiscal_year,status,starts_at,ends_at,created_at,updated_at) VALUES ('period-locked',$1,'2026-08',2026,'soft_locked','2026-08-01','2026-08-31',$2,$2)`, [TENANT, stamp]);
    const { id, reservationId } = await seedInvoice(database, { id: 'inv-locked' });
    const inTransaction = <T>(work: (r: ReturnType<typeof createPostgresProAccountingRepository>) => Promise<T>) =>
      database.transaction({ isolation: 'serializable' }, (session) => work(createPostgresProAccountingRepository(session)));

    await assert.rejects(() => inTransaction((r) => r.postOutgoingInvoice(scope, id, { reservationId })), /SOFT_LOCK_OVERRIDE_REQUIRED/);
    await assert.rejects(() => inTransaction((r) => r.postOutgoingInvoice(scope, id, { reservationId, softLockOverride: true, overrideReason: '  ' })), /SOFT_LOCK_OVERRIDE_REQUIRED/);
    assert.equal(await count(database, `SELECT COUNT(*) c FROM journal_entries`), 0);
    assert.equal(await count(database, `SELECT COUNT(*) c FROM open_items`), 0);

    const posted = await inTransaction((r) => r.postOutgoingInvoice(scope, id, { reservationId, softLockOverride: true, overrideReason: 'Freigabe durch Inhaber' }));
    assert.equal(posted.status, 'ready');
    assert.equal(await count(database, `SELECT COUNT(*) c FROM journal_entries`), 1);
  });
});

test('posted documents are frozen and reversal is refused once allocations exist', async () => {
  await withOpos(async (database, repo) => {
    const { id, reservationId } = await seedInvoice(database, { id: 'inv-rev' });
    await repo.postOutgoingInvoice(scope, id, { reservationId });
    const entryId = (await one<{ accounting_journal_entry_id: string }>(database, `SELECT accounting_journal_entry_id FROM invoices WHERE id=$1`, [id])).accounting_journal_entry_id;

    await assert.rejects(() => repo.reverseJournalEntry(scope, entryId, 'generic reversal'), /DOCUMENT_REVERSAL_REQUIRED/);
    await assert.rejects(() => database.query(`UPDATE invoices SET number='MUTATED' WHERE id=$1`, [id]), /immutable/);
    await assert.rejects(() => database.query(`DELETE FROM invoices WHERE id=$1`, [id]), /immutable/);

    const [item] = await repo.listOpenItems(scope);
    await repo.allocateOpenItemPayment(scope, payment(item!.id, 10, 10, 'pay-frozen'));
    await assert.rejects(() => repo.reverseDocumentAccounting(scope, { documentType: 'outgoing_invoice', documentId: id, reason: 'Korrektur' }), /DOCUMENT_HAS_ALLOCATIONS/);
    assert.equal((await one<{ accounting_status: string }>(database, `SELECT accounting_status FROM invoices WHERE id=$1`, [id])).accounting_status, 'posted');
  });
});

test('document reversal without allocations needs a soft-lock override, cancels the document and marks the item unresolved', async () => {
  await withOpos(async (database, repo) => {
    const { id, reservationId } = await seedInvoice(database, { id: 'inv-rev-free' });
    await repo.postOutgoingInvoice(scope, id, { reservationId });
    await database.query(`UPDATE accounting_periods SET status='soft_locked' WHERE tenant_id=$1 AND period='2026-08'`, [TENANT]);

    const input = { documentType: 'outgoing_invoice' as const, documentId: id, reason: 'Korrektur', postingDate: '2026-08-15' };
    await assert.rejects(() => repo.reverseDocumentAccounting(scope, input), /SOFT_LOCK_OVERRIDE_REQUIRED/);
    const reversal = await repo.reverseDocumentAccounting(scope, { ...input, softLockOverride: true, overrideReason: 'Owner approval' });
    assert.equal(reversal.ok, true);
    assert.deepEqual(await one(database, `SELECT accounting_status,status FROM invoices WHERE id=$1`, [id]), { accounting_status: 'reversed', status: 'cancelled' });
    assert.equal((await one<{ status: string }>(database, `SELECT status FROM open_items WHERE source_id=$1`, [id])).status, 'unresolved');
    await assert.rejects(() => database.query(`DELETE FROM invoices WHERE id=$1`, [id]), /immutable/);
    await assert.rejects(() => repo.reverseDocumentAccounting(scope, input), /DOCUMENT_NOT_POSTED/);
  });
});

test('posted incoming invoices are frozen and reversal is blocked while a linked asset exists', async () => {
  await withOpos(async (database, repo) => {
    const vendor = await repo.upsertVendor(scope, { id: 'vendor-rev', name: 'Supplier', mutation });
    await repo.upsertIncomingInvoice(scope, incomingInvoice('in-rev', vendor.id));
    await repo.postIncomingInvoice(scope, 'in-rev', { mutation });
    await assert.rejects(() => database.query(`UPDATE incoming_invoices SET accounting_status='reversed' WHERE id='in-rev'`), /immutable/);
    await assert.rejects(() => repo.upsertVendor(scope, { id: 'vendor-rev', name: 'Renamed', mutation }), /VENDOR_HAS_POSTED_DOCUMENTS/);

    await database.query(
      `INSERT INTO assets (id,tenant_id,asset_number,name,asset_class,status,activation_date,acquisition_cost,useful_life_years,depreciation_method,cost_center,location,source_incoming_invoice_id,asset_account_number,created_at,updated_at)
       VALUES ('asset-linked',$1,'AN-1','Linked asset','other','aktiv','2026-08-02',100,5,'linear','IT','Berlin','in-rev','0480',$2,$2)`,
      [TENANT, stamp],
    );
    await assert.rejects(() => repo.reverseDocumentAccounting(scope, { documentType: 'incoming_invoice', documentId: 'in-rev', reason: 'Korrektur' }), /ASSET_CORRECTION_REQUIRED/);
  });
});
