import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createSingleTenantScope } from '@billme/server-core';
import { PgliteServerDatabase } from '../pglite/database.js';
import { createPostgresProAccountingRepository } from './proAccountingRepository.js';

const stamp = '2026-10-01T09:00:00.000Z';
const scope = createSingleTenantScope('tenant-a', 'pro');
const mutation = { reason: 'Test' };
const GIRO_IBAN = 'DE89370400440532013000';
const AMEX_IBAN = 'DE21 5001 0517 0000 0040 21';

type Repo = ReturnType<typeof createPostgresProAccountingRepository>;
type Fixture = { database: PgliteServerDatabase; repository: Repo };

async function withFixture<T>(work: (fixture: Fixture) => Promise<T>): Promise<T> {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-transfers-'));
  const database = await PgliteServerDatabase.open(dataDir);
  try {
    await database.migrate();
    await database.query(`INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at) VALUES ('tenant-a','tenant-a','Tenant A','pro',$1,$1)`, [stamp]);
    await database.query(`INSERT INTO accounting_policies (tenant_id,active_chart,vat_method,period_policy,updated_at) VALUES ('tenant-a','SKR04','soll','calendar_month',$1)`, [stamp]);
    await database.query(
      `INSERT INTO accounts (id,tenant_id,name,iban,balance,default_skr_account_number,type,color) VALUES
        ('giro','tenant-a','Girokonto',$1,0,'1800','bank','#000'),
        ('amex','tenant-a','Amex Business',$2,0,'1820','credit','#000'),
        ('paypal','tenant-a','PayPal','paypal@firma.de',0,'1830','paypal','#000')`,
      [GIRO_IBAN, AMEX_IBAN],
    );
    return await work({ database, repository: createPostgresProAccountingRepository(database) });
  } finally {
    await database.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

const bankLine = (database: PgliteServerDatabase, id: string, account: string, date: string, amount: number, counterparty: string, purpose = '', iban: string | null = null) =>
  database.query(
    `INSERT INTO bank_transactions (id,tenant_id,account_id,date,amount,type,counterparty,purpose,status,counterparty_iban,created_at,updated_at) VALUES ($1,'tenant-a',$2,$3,$4,$5,$6,$7,'pending',$8,$9,$9)`,
    [id, account, date, amount, amount < 0 ? 'expense' : 'income', counterparty, purpose, iban, stamp],
  );

const byId = async (repository: Repo) => new Map((await repository.listBankTransactions(scope)).map((row) => [row.id, row]));
const lines = (draft: { lines: Array<{ accountNumber: string; debitAmount: number; creditAmount: number }> }) =>
  draft.lines.map((line) => `${line.accountNumber}:${line.debitAmount > 0 ? 'S' : 'H'}${line.debitAmount || line.creditAmount}`);

async function post(repository: Repo, transactionId: string) {
  const draft = (await repository.getDraftByTransactionId(scope, transactionId))!;
  const result = await repository.postDraft(scope, draft.id, { postingDate: draft.postingDate });
  assert.deepEqual(result.issues, [], `${transactionId} posts without issues`);
}

test('Umbuchungen werden erkannt: sicher per eigener IBAN, wahrscheinlich per Gegenbetrag, mehrdeutig nie sicher', async () => {
  await withFixture(async ({ database, repository }) => {
    await bankLine(database, 'g-amex', 'giro', '2026-10-03', -1248.3, 'American Express Europe S.A.', 'AMEX Abrechnung 09/2026', AMEX_IBAN);
    await bankLine(database, 'a-in', 'amex', '2026-10-05', 1248.3, 'Zahlung erhalten', 'Vielen Dank');
    await bankLine(database, 'g-pp', 'giro', '2026-10-07', -300, 'PayPal Europe S.a.r.l.', 'PP.8812 Aufladung');
    await bankLine(database, 'p-in', 'paypal', '2026-10-08', 300, 'Bankgutschrift', 'Geld vom Bankkonto');
    await bankLine(database, 'g-50', 'giro', '2026-10-10', -50, 'Übertrag', '');
    await bankLine(database, 'a-50', 'amex', '2026-10-11', 50, 'Gutschrift', '');
    await bankLine(database, 'p-50', 'paypal', '2026-10-09', 50, 'Gutschrift', '');
    await bankLine(database, 'g-hetzner', 'giro', '2026-10-14', -23.8, 'Hetzner Online GmbH', 'Rechnung R0021938112');
    await bankLine(database, 'p-late', 'paypal', '2026-10-30', 1248.3, 'Zu spät', '');

    const rows = await byId(repository);
    const amex = rows.get('g-amex')!;
    assert.equal(amex.suggestionLayer, 'transfer');
    assert.equal(amex.suggestedAccountNumber, '1460');
    assert.equal(amex.transfer?.level, 'sicher');
    assert.equal(amex.transfer?.partnerTransactionId, 'a-in');
    assert.equal(amex.transfer?.partnerAccountName, 'Amex Business');
    assert.equal(rows.get('a-in')!.transfer?.partnerTransactionId, 'g-amex');
    // The PayPal line 27 days later is outside the window and loses against the IBAN pair.
    assert.equal(rows.get('p-late')!.transfer, undefined);

    assert.equal(rows.get('g-pp')!.transfer?.level, 'wahrscheinlich');
    assert.equal(rows.get('g-pp')!.transfer?.partnerTransactionId, 'p-in');

    // Two lines of 50 € one day apart: paired, but never "sicher".
    assert.equal(rows.get('g-50')!.transfer?.level, 'wahrscheinlich');
    assert.ok(rows.get('g-50')!.transfer?.reasons.includes('mehrere Kandidaten'));

    assert.equal(rows.get('g-hetzner')!.transfer, undefined);
    assert.notEqual(rows.get('g-hetzner')!.suggestionLayer, 'transfer');

    // Each side books over Geldtransit against its own ledger account.
    assert.deepEqual(lines((await repository.getDraftByTransactionId(scope, 'g-amex'))!), ['1460:S1248.3', '1800:H1248.3']);
    assert.deepEqual(lines((await repository.getDraftByTransactionId(scope, 'a-in'))!), ['1820:S1248.3', '1460:H1248.3']);
  });
});

test('Bestätigtes Paar wird einzeln gebucht und gleicht Geldtransit aus', async () => {
  await withFixture(async ({ database, repository }) => {
    await bankLine(database, 'g-amex', 'giro', '2026-10-03', -1248.3, 'American Express Europe S.A.', 'AMEX Abrechnung', AMEX_IBAN);
    await bankLine(database, 'a-in', 'amex', '2026-10-05', 1248.3, 'Zahlung erhalten');

    const drafts = await repository.confirmTransfer(scope, { transactionId: 'g-amex', mutation });
    assert.deepEqual(drafts.map((draft) => [draft.transactionId, draft.workflowStatus]), [['g-amex', 'approved'], ['a-in', 'approved']]);

    await post(repository, 'g-amex');
    let overview = await repository.getTransitOverview(scope);
    assert.equal(overview.transitAccountNumber, '1460');
    assert.equal(overview.openBalance, 1248.3);
    assert.deepEqual(overview.openSides.map((side) => [side.transactionId, side.partnerTransactionId]), [['g-amex', 'a-in']]);

    await post(repository, 'a-in');
    overview = await repository.getTransitOverview(scope);
    assert.deepEqual(overview.months, [{ period: '2026-10', debit: 1248.3, credit: 1248.3, balance: 0, cumulative: 0 }]);
    assert.deepEqual(overview.openSides, []);
    assert.equal((await byId(repository)).get('a-in')!.transfer?.status, 'confirmed');
  });
});

test('Offene Geldtransit-Seite bekommt Kandidaten außerhalb des Fensters und wird nachträglich zugeordnet', async () => {
  await withFixture(async ({ database, repository }) => {
    await bankLine(database, 'a-refund', 'amex', '2026-10-12', -42.1, 'Guthaben zurückerstattet');
    await bankLine(database, 'g-refund', 'giro', '2026-10-21', 42.1, 'Gutschrift American Express');
    // Nine days apart: no suggestion within the 7-day window.
    assert.equal((await byId(repository)).get('a-refund')!.transfer, undefined);

    await repository.confirmTransfer(scope, { transactionId: 'a-refund', mutation });
    await post(repository, 'a-refund');
    let overview = await repository.getTransitOverview(scope);
    assert.equal(overview.openBalance, 42.1);
    const [side] = overview.openSides;
    assert.equal(side!.transactionId, 'a-refund');
    assert.deepEqual(side!.candidates.map((c) => [c.transactionId, c.days, c.outsideWindow]), [['g-refund', 9, true]]);

    await repository.confirmTransfer(scope, { transactionId: 'a-refund', partnerTransactionId: 'g-refund', mutation });
    assert.deepEqual(lines((await repository.getDraftByTransactionId(scope, 'g-refund'))!), ['1800:S42.1', '1460:H42.1']);
    await post(repository, 'g-refund');
    overview = await repository.getTransitOverview(scope);
    assert.equal(overview.openBalance, 0);
    assert.deepEqual(overview.openSides, []);
  });
});

test('„Keine Umbuchung“ gibt beide Seiten frei; gebuchte Seiten nur per Storno', async () => {
  await withFixture(async ({ database, repository }) => {
    await bankLine(database, 'g-pp', 'giro', '2026-10-07', -300, 'PayPal Europe S.a.r.l.', 'Einkauf');
    await bankLine(database, 'p-in', 'paypal', '2026-10-08', 300, 'Kunde zahlt', '');
    assert.deepEqual(lines((await repository.getDraftByTransactionId(scope, 'g-pp'))!), ['1460:S300', '1800:H300']);

    await repository.rejectTransfer(scope, { transactionId: 'g-pp', mutation });
    const rows = await byId(repository);
    assert.equal(rows.get('g-pp')!.transfer, undefined);
    assert.equal(rows.get('p-in')!.transfer, undefined);
    const redrafted = (await repository.getDraftByTransactionId(scope, 'g-pp'))!;
    assert.ok(!redrafted.lines.some((line) => line.accountNumber === '1460'), 'the next draft is an ordinary booking');

    await bankLine(database, 'g-amex', 'giro', '2026-10-03', -10, 'Amex', '', AMEX_IBAN);
    await repository.confirmTransfer(scope, { transactionId: 'g-amex', mutation });
    await post(repository, 'g-amex');
    await assert.rejects(repository.rejectTransfer(scope, { transactionId: 'g-amex', mutation }), /TRANSFER_SIDE_POSTED_REVERSE_FIRST/);
    await assert.rejects(repository.confirmTransfer(scope, { transactionId: 'g-amex', mutation: { reason: ' ' } }), /ACCOUNTING_AUDIT_REASON_REQUIRED/);
  });
});

test('Ohne Erkennung bleiben nur bestätigte Paare', async () => {
  await withFixture(async ({ database, repository }) => {
    await bankLine(database, 'g-1', 'giro', '2026-10-03', -100, 'Übertrag', '');
    await bankLine(database, 'a-1', 'amex', '2026-10-03', 100, 'Zahlung erhalten', '');
    await bankLine(database, 'g-2', 'giro', '2026-10-04', -200, 'Übertrag', '');
    await bankLine(database, 'a-2', 'amex', '2026-10-04', 200, 'Zahlung erhalten', '');
    await repository.confirmTransfer(scope, { transactionId: 'g-1', mutation });
    const settings = await repository.saveBookingSettings(scope, { transferDetection: false, mutation });
    assert.equal(settings.transferDetection, false);
    assert.equal(settings.autoPostTransfers, false);
    const rows = await byId(repository);
    assert.equal(rows.get('g-1')!.transfer?.status, 'confirmed');
    assert.equal(rows.get('g-2')!.transfer, undefined);
    await assert.rejects(repository.saveBookingSettings(scope, { transferWindowDays: 90, mutation }), /TRANSFER_WINDOW_INVALID/);
  });
});
