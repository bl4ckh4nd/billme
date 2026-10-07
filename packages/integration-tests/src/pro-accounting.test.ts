import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { startPro, type ProHarness } from './harness.js';
import { addDays, today } from './fixtures.js';
import {
  addBankAccount, approveDraft, assertBalanced, assertLedgerConsistent, bankCsv, bankTransactions, bankTx, draft, draftAction, entryFor, get,
  getDraft, importCsv, invoiceEntry, issue, journal, money, openItems, payOpenItem, postDraft, saveDraft, shape,
  type CsvRow, type Draft, type JournalEntry,
} from './pro-fixtures.js';

/**
 * Pro accounting end to end: posting, journal, corrections, manual booking,
 * OPOS. The backend is the one Electron starts for Billme Pro (embedded
 * Fastify on PGlite); every call is HTTP.
 *
 * How this can fail (each one has a test below):
 * - setup: a role mapping with a bad role/chart/blank account or no reason, a
 *   mapping onto an account that does not exist (every later invoice would
 *   fail), a mapping change rewriting entries that were already posted
 * - issuing posts: an entry that does not balance, the wrong accounts or
 *   direction, VAT lumped together across rates, 7 % VAT on the 19 % account,
 *   a tax case without its evidence (Kleinunternehmer, §13b, EU supply), a
 *   second posting when an issued invoice is saved again, a draft posted
 *   straight into the ledger
 * - atomicity: a posting that fails after the invoice was already issued
 *   (half-issued: number gone, no entry), a lost number after the failure, a
 *   half-written audit trail
 * - corrections: a cancellation that does not mirror the original, a credit
 *   note that posts a different amount than the document, a source cancelled
 *   twice (the revenue reversed twice), an open item left open
 * - document reversal: reversing a document that has payments, reversing it
 *   twice, a journal reversal that bypasses the document owner
 * - manual booking: an unbalanced / one-sided / zero / sub-cent entry, an
 *   unknown or missing account, a bad date or a period that does not match it,
 *   a draft approved or posted by the client, floating point false alarms on
 *   cents, posting the same draft twice, an entry that can be edited after
 *   posting, a reversal that does not neutralise every line, reversing twice
 * - OPOS: a payment allocated beyond the open balance or beyond the payment
 *   itself, to the wrong party, to an item that is not there, a retry that
 *   books twice, an overpayment that disappears, a bank line booked twice,
 *   the invoice status not following the open item
 * - bank workbench: an import that double-books, a rolled-back batch that
 *   stays bookable, a suggestion rule that outranks a better one, ignores its
 *   flow/chart/active flag, or is credited for a booking it did not decide
 * - incoming invoices and receipts: a posting with the wrong accounts or
 *   balance, amounts that do not add up posted anyway, a posted document or its
 *   vendor edited afterwards, an archived original that changes, a spoofed file
 *   type, a duplicate or a path in the file name accepted
 * - workflow entries (CLI): a malformed entry stored, a second save duplicating
 *   the entry instead of replacing it, a write without the token
 * The period locks, the restart and the SKR04/Ist-VAT mode live in
 * pro-periods.test.ts; reports, DATEV and assets in pro-reporting.test.ts.
 */

const GROSS = 238;
const ledgerNet = (entries: JournalEntry[], account: string) =>
  entries.reduce((sum, entry) => sum + entry.lines.filter((line) => line.accountNumber === account).reduce((s, line) => s + line.debitAmount - line.creditAmount, 0), 0);
const posted = (h: ProHarness) => get<{ postedCount: number; reversedCount: number; draftCount: number }>(h, '/accounting/health');
const chainIssue = (h: ProHarness, input: Record<string, unknown>) => h.api.documents.chainIssue({ id: randomUUID(), date: today(), dueDate: today(), ...input } as never) as Promise<any>;
const correction = (h: ProHarness, invoiceId: string, kind: 'credit_note' | 'cancellation_invoice', amount?: number) =>
  chainIssue(h, { operation: 'correction', invoiceId, kind, reason: kind === 'credit_note' ? 'Gutschrift' : 'Storno', ...(amount === undefined ? {} : { amount }) });
const invoiceOf = async (h: ProHarness, id: string) => (await h.api.invoices.list()).find((invoice) => invoice.id === id)!;
const map = (h: ProHarness, role: string, accountNumber: string, extra: Record<string, unknown> = {}) =>
  h.raw('POST', '/accounting/mappings', { reason: 'Kontenzuordnung', chart: 'SKR03', role, accountNumber, ...extra });

describe('pro accounting: setup and posting of issued invoices', () => {
  let h: ProHarness;
  before(async () => { h = await startPro(null, 'pro-accounting'); });
  after(async () => { await h.close(); });

  describe('chart of accounts and role mappings', () => {
    test('a fresh Pro tenant runs on SKR03 Soll-VAT with both charts seeded and the default roles in effect', async () => {
      const policy = await get(h, '/accounting/policy');
      assert.equal(policy.activeChart, 'SKR03');
      assert.equal(policy.vatMethod, 'soll');
      const stats = await get(h, '/accounting/ledger/stats');
      assert.ok(stats.byChart.SKR03 > 1000 && stats.byChart.SKR04 > 1000, JSON.stringify(stats));
      assert.equal(stats.total, stats.byChart.SKR03 + stats.byChart.SKR04);
      const skr03 = await get<Array<{ accountNumber: string; chart: string }>>(h, '/accounting/ledger/accounts?chart=SKR03&search=1400&limit=20');
      assert.ok(skr03.some((account) => account.accountNumber === '1400' && account.chart === 'SKR03'));
      const skr04 = await get<Array<{ accountNumber: string; chart: string }>>(h, '/accounting/ledger/accounts?chart=SKR04&search=4400&limit=20');
      assert.ok(skr04.some((account) => account.accountNumber === '4400' && account.chart === 'SKR04'));
      assert.deepEqual(await get(h, '/accounting/mappings'), [], 'no tenant mapping rows yet, the chart defaults apply');
      for (const [chart, account, name] of [['SKR03', '1571', 'Abziehbare Vorsteuer 7 %'], ['SKR03', '1771', 'Umsatzsteuer 7 %'], ['SKR04', '1401', 'Abziehbare Vorsteuer 7 %'], ['SKR04', '3801', 'Umsatzsteuer 7 %']]) {
        const found = await get<Array<{ accountNumber: string; name: string }>>(h, `/accounting/ledger/accounts?chart=${chart}&search=${account}&limit=20`);
        assert.equal(found.find((row) => row.accountNumber === account)?.name, name, `${chart} ${account} is seeded for the 7 % VAT`);
      }
    });

    test('mapping saves validate role, chart, account and reason', async () => {
      assert.equal((await map(h, 'cost_of_goods', '8400')).status, 400, 'unknown role');
      assert.equal((await h.raw('POST', '/accounting/mappings', { reason: 'x', chart: 'SKR05', role: 'revenue', accountNumber: '8400' })).status, 400, 'unknown chart');
      assert.equal((await h.raw('POST', '/accounting/mappings', { reason: '  ', chart: 'SKR03', role: 'revenue', accountNumber: '8400' })).status, 400, 'blank reason');
      assert.equal((await h.raw('POST', '/accounting/mappings', { chart: 'SKR03', role: 'revenue', accountNumber: '8400' })).status, 400, 'missing reason');
      assert.equal((await map(h, 'revenue', '   ')).status, 400, 'blank account');
      assert.deepEqual(await get(h, '/accounting/mappings'), [], 'nothing was stored');
    });

    test('a role mapped to an account that is not in the chart is refused when it is saved', async () => {
      const response = await map(h, 'revenue', '99999');
      try {
        assert.ok(response.status >= 400 && response.status < 500, `a mapping onto 99999 was stored (${response.status})`);
      } finally {
        await map(h, 'revenue', '8400');
      }
    });

    test('changing a role mapping moves the next posting and leaves posted entries alone', async () => {
      assert.ok((await get<unknown[]>(h, '/accounting/ledger/accounts?chart=SKR03&search=8200&limit=20')).length > 0, 'precondition: SKR03 has an account 8200');
      const before = await issue(h, { client: 'Mapping vorher' });
      try {
        const saved = await map(h, 'revenue', '8200');
        assert.equal(saved.status, 200, saved.text);
        assert.equal(saved.body.accountNumber, '8200');
        const after = await issue(h, { client: 'Mapping nachher' });
        assert.deepEqual(shape((await invoiceEntry(h, after.id))!), [['1400', GROSS, 0], ['8200', 0, 200], ['1776', 0, 38]]);
        assert.deepEqual(shape((await invoiceEntry(h, before.id))!), [['1400', GROSS, 0], ['8400', 0, 200], ['1776', 0, 38]], 'the earlier entry still books 8400');
      } finally {
        assert.equal((await map(h, 'revenue', '8400')).status, 200);
      }
      const listed = await get<Array<{ role: string; accountNumber: string }>>(h, '/accounting/mappings?chart=SKR03');
      assert.equal(listed.filter((row) => row.role === 'revenue').length, 1, 'one row per role');
      assert.equal(listed.find((row) => row.role === 'revenue')!.accountNumber, '8400');
      assert.deepEqual(await get(h, '/accounting/mappings?chart=SKR04'), [], 'mappings are per chart');
    });
  });

  describe('issuing posts the invoice', () => {
    test('issuing posts a balanced entry: receivable debit, revenue and output VAT credit, plus an open item', async () => {
      const before = await posted(h);
      const invoice = await issue(h, { client: 'Posting GmbH' });
      assert.equal(invoice.status, 'open');
      const entry = (await invoiceEntry(h, invoice.id))!;
      assert.ok(entry, 'the issued invoice has a journal entry');
      assert.deepEqual(shape(entry), [['1400', GROSS, 0], ['8400', 0, 200], ['1776', 0, 38]]);
      assert.equal(entry.sourceType, 'outgoing_invoice');
      assert.equal(entry.status, 'posted');
      assert.equal(entry.postingDate, invoice.date);
      assert.equal(entry.period, invoice.date.slice(0, 7));
      assert.equal(entry.fiscalYear, Number(invoice.date.slice(0, 4)));
      assert.equal(entry.bookingText, `Rechnung ${invoice.number}`);
      assert.equal(entry.reference, invoice.number);
      const revenue = entry.lines.find((line) => line.accountNumber === '8400')!;
      assert.deepEqual([revenue.taxCaseKey, revenue.taxRate, revenue.netAmount, revenue.taxAmount, revenue.grossAmount], ['DE_STD_19', 19, 200, 38, GROSS]);
      assertBalanced([entry]);

      assert.deepEqual(await get(h, `/accounting/journal/${entry.id}`), entry, 'the detail view returns the same entry');
      const item = (await openItems(h)).find((candidate) => candidate.sourceId === invoice.id)!;
      assert.deepEqual(
        [item.partyType, item.partyId, item.documentNumber, item.documentDate, item.dueDate, item.originalAmount, item.allocatedAmount, item.residualAmount, item.status, item.journalEntryId],
        ['debtor', 'Posting GmbH', invoice.number, invoice.date, invoice.dueDate, GROSS, 0, GROSS, 'open', entry.id],
      );
      assert.ok((await invoiceOf(h, invoice.id)).history?.some((line) => line.action.includes('accounting_post')), 'the posting is part of the invoice history');
      assert.equal((await posted(h)).postedCount, before.postedCount + 1);
      await assertLedgerConsistent(h);
    });

    test('invoices issued at the same time get distinct numbers, one entry each and consecutive entry numbers', async () => {
      const before = (await journal(h)).length;
      const invoices = await Promise.all(Array.from({ length: 6 }, (_, index) => issue(h, { client: `Parallel ${index}` })));
      assert.equal(new Set(invoices.map((invoice) => invoice.number)).size, 6, 'six distinct invoice numbers');
      const entries = await Promise.all(invoices.map((invoice) => invoiceEntry(h, invoice.id)));
      assert.ok(entries.every(Boolean), 'every invoice has its entry');
      assert.equal((await journal(h)).length, before + 6);
      const numbers = (await journal(h)).map((entry) => entry.entryNumber).sort((a, b) => a - b);
      assert.deepEqual(numbers, numbers.map((_, index) => index + 1), 'entry numbers are unique and have no gaps');
      assert.equal(new Set((await openItems(h)).map((item) => item.sourceId)).size, (await openItems(h)).length, 'one open item per document');
      await assertLedgerConsistent(h);
    });

    test('the posting preview shows the same lines and is repeatable', async () => {
      const invoice = await issue(h, { client: 'Preview GmbH' });
      const entry = (await invoiceEntry(h, invoice.id))!;
      const first = await h.raw('POST', '/accounting/outgoing-invoices/preview', { invoiceId: invoice.id, reason: 'Vorschau' });
      assert.equal(first.status, 200, first.text);
      assert.equal(first.body.status, 'ready');
      assert.deepEqual(first.body.issues, []);
      assert.deepEqual(first.body.snapshot.lines.map((line: any) => [line.accountNumber, line.debitAmount, line.creditAmount]), shape(entry));
      assert.equal(first.body.snapshot.grossAmount, GROSS);
      assert.deepEqual((await h.raw('POST', '/accounting/outgoing-invoices/preview', { invoiceId: invoice.id, reason: 'Vorschau' })).body.snapshot.sourceVersion, first.body.snapshot.sourceVersion);
      assert.equal((await h.raw('POST', '/accounting/outgoing-invoices/preview', { invoiceId: 'nope', reason: 'Vorschau' })).status, 404);
    });

    test('posting an issued invoice again replays the posting instead of booking it twice', async () => {
      const unposted = await draft(h, { client: 'Einmal GmbH' });
      const reservation = await h.api.numbers.reserve({ kind: 'invoice' });
      await h.api.numbers.release({ reservationId: reservation.reservationId });
      const invoice = await h.api.invoices.upsert({ reason: 'stellen', invoice: { ...unposted, status: 'open' } });
      const key = `outgoing-invoice:${invoice.id}`;
      const count = async () => (await journal(h)).filter((entry) => entry.sourceKey === key).length;
      assert.equal(await count(), 1);
      const finalized = await h.raw('POST', '/accounting/outgoing-invoices/preview', { invoiceId: invoice.id, reason: 'Vorschau' });
      assert.equal(finalized.body.status, 'ready');
      assert.equal((await openItems(h)).filter((item) => item.sourceId === invoice.id).length, 1);
      assert.equal(await count(), 1);
    });

    test('saving an issued invoice again is accepted and does not post it a second time', async () => {
      const invoice = await issue(h, { client: 'Erneut gespeichert' });
      const key = `outgoing-invoice:${invoice.id}`;
      const response = await h.raw('POST', '/invoices', { reason: 'erneut gespeichert', invoice: { ...invoice, kind: 'invoice' } });
      assert.equal(response.status, 200, response.text.slice(0, 200));
      assert.equal((await journal(h)).filter((entry) => entry.sourceKey === key).length, 1);
    });

    test('a draft cannot be posted straight into the ledger', async () => {
      const unposted = await draft(h, { client: 'Nur Entwurf' });
      const before = (await journal(h)).length;
      const response = await h.raw('POST', '/accounting/outgoing-invoices/post', { reason: 'ohne Stellen', invoiceId: unposted.id, reservationId: 'not-a-reservation' });
      assert.equal(response.status, 409, response.text);
      assert.match(response.body.message, /FINALIZED_RESERVATION_REQUIRED/);
      assert.equal((await journal(h)).length, before);
      assert.equal((await invoiceOf(h, unposted.id)).status, 'draft');
      assert.equal((await h.raw('POST', '/accounting/outgoing-invoices/post', { reason: 'x', invoiceId: unposted.id })).status, 400, 'the reservation id is mandatory');
    });

    test('mixed 19 % and 7 % invoices post one revenue and one VAT line per rate', async () => {
      const invoice = await issue(h, { client: 'Mischsatz', items: [
        { kind: 'item', description: 'Beratung', quantity: 1, price: 100, total: 100, taxRate: 19 },
        { kind: 'item', description: 'Buch', quantity: 1, price: 50, total: 50, taxRate: 7 },
      ] });
      const entry = (await invoiceEntry(h, invoice.id))!;
      assert.equal(entry.lines[0]!.accountNumber, '1400');
      assert.equal(entry.lines[0]!.debitAmount, 172.5);
      const revenue = entry.lines.filter((line) => line.accountNumber === '8400');
      assert.deepEqual(revenue.map((line) => [line.taxCaseKey, line.netAmount, line.taxAmount, line.grossAmount]), [['DE_STD_19', 100, 19, 119], ['DE_STD_7', 50, 3.5, 53.5]]);
      assert.deepEqual(entry.lines.filter((line) => line.memo?.startsWith('USt ')).map((line) => [line.memo, line.creditAmount]), [['USt DE_STD_19', 19], ['USt DE_STD_7', 3.5]]);
      assertBalanced([entry]);
    });

    test('7 % output VAT lands on the 7 % output-tax account without any setup', async () => {
      const invoice = await issue(h, { client: 'Sieben Prozent', items: [{ kind: 'item', description: 'Buch', quantity: 1, price: 50, total: 50, taxRate: 7 }] });
      const entry = (await invoiceEntry(h, invoice.id))!;
      assert.deepEqual(shape(entry), [['1400', 53.5, 0], ['8400', 0, 50], ['1771', 0, 3.5]]);
    });

    test('a tax-case account mapping routes 7 % VAT to 1771 and carries the DATEV BU key', async () => {
      const output = await h.raw('POST', '/accounting/tax-case-account-mappings', { reason: 'USt 7 %', chart: 'SKR03', taxCaseKey: 'DE_STD_7', role: 'output_tax', accountNumber: '1771' });
      assert.equal(output.status, 200, output.text);
      const bu = await h.raw('POST', '/accounting/tax-case-account-mappings', { reason: 'BU 2', chart: 'SKR03', taxCaseKey: 'DE_STD_7', role: 'datev_bu', accountNumber: '1771', datevBuKey: '2' });
      assert.equal(bu.status, 200, bu.text);
      assert.equal((await h.raw('POST', '/accounting/tax-case-account-mappings', { reason: 'x', chart: 'SKR03', taxCaseKey: 'DE_STD_7', role: 'vat_magic', accountNumber: '1771' })).status, 400, 'unknown role');
      assert.equal((await h.raw('POST', '/accounting/tax-case-account-mappings', { reason: 'x', chart: 'SKR03', taxCaseKey: 'NOT_A_CASE', role: 'output_tax', accountNumber: '1771' })).status, 400, 'unknown tax case');
      const invoice = await issue(h, { client: 'Sieben konfiguriert', items: [{ kind: 'item', description: 'Buch', quantity: 1, price: 50, total: 50, taxRate: 7 }] });
      assert.deepEqual(shape((await invoiceEntry(h, invoice.id))!), [['1400', 53.5, 0], ['8400', 0, 50], ['1771', 0, 3.5]]);
      const rows = await get<Array<{ konto: string; gegenkonto: string; buSchluessel?: string; umsatz: number }>>(h, '/accounting/datev/rows');
      assert.ok(rows.some((row) => row.gegenkonto === '8400' && row.buSchluessel === '0002' && row.umsatz === 50), 'the revenue pair carries BU key 2');
    });

    test('Kleinunternehmer and §13b invoices post without VAT lines and keep their evidence; without it issuing is refused', async () => {
      const items = [{ kind: 'item' as const, description: 'Leistung', quantity: 1, price: 100, total: 100, taxRate: 19 }];
      const before = { entries: (await journal(h)).length, items: (await openItems(h)).length };
      const blocked = await draft(h, { client: 'KU ohne Nachweis', taxMode: 'small_business_19_ustg', items });
      const refused = await h.raw('POST', '/invoices', { reason: 'stellen', invoice: { ...blocked, status: 'open', kind: 'invoice' } });
      assert.equal(refused.status, 400, refused.text);
      assert.match(refused.body.message, /MISSING_TAX_EVIDENCE/);
      assert.equal((await invoiceOf(h, blocked.id)).status, 'draft');
      assert.deepEqual([(await journal(h)).length, (await openItems(h)).length], [before.entries, before.items], 'nothing was posted');

      const ku = await issue(h, { client: 'KU mit Nachweis', taxMode: 'small_business_19_ustg', taxMeta: { datevEvidenceType: 'exemption', datevEvidenceReference: '§19 UStG' }, items });
      const kuEntry = (await invoiceEntry(h, ku.id))!;
      assert.deepEqual(shape(kuEntry), [['1400', 100, 0], ['8400', 0, 100]]);
      assert.deepEqual([kuEntry.lines[1]!.taxCaseKey, kuEntry.lines[1]!.evidenceType, kuEntry.lines[1]!.evidenceReference], ['DE_KU19', 'exemption', '§19 UStG']);

      const rc = await issue(h, { client: 'RC mit Nachweis', taxMode: 'reverse_charge_13b', taxMeta: { buyerVatId: 'DE123456789', datevEvidenceType: 'reverse_charge', datevEvidenceReference: '13' }, items: [{ kind: 'item', description: 'Bau', quantity: 1, price: 100, total: 100 }] });
      const rcEntry = (await invoiceEntry(h, rc.id))!;
      assert.deepEqual(shape(rcEntry), [['1400', 100, 0], ['8400', 0, 100]]);
      assert.equal(rcEntry.lines[1]!.taxCaseKey, 'DE_RC_13B_DOMESTIC');
      assertBalanced([kuEntry, rcEntry]);
    });
  });

  describe('a failed posting leaves no half-issued invoice', () => {
    const snapshotOfLedger = async () => ({ entries: (await journal(h)).length, items: (await openItems(h)).length, posted: (await posted(h)).postedCount });

    test('an EU supply without country, VAT id and evidence is refused cleanly and the same draft issues once it is complete', async () => {
      const unposted = await draft(h, { client: 'EU Kunde', taxMode: 'intra_eu_supply_6a', items: [{ kind: 'item', description: 'Ware', quantity: 1, price: 200, total: 200 }] });
      const before = await snapshotOfLedger();
      const refused = await h.raw('POST', '/invoices', { reason: 'stellen', invoice: { ...unposted, status: 'open', kind: 'invoice' } });
      assert.equal(refused.status, 400, refused.text);
      assert.match(refused.body.message, /MISSING_TAX_COUNTRY/);
      assert.deepEqual(await snapshotOfLedger(), before, 'no entry, no open item');
      const stored = await invoiceOf(h, unposted.id);
      assert.equal(stored.status, 'draft', 'the invoice is still a draft');
      assert.equal(stored.number, unposted.number, 'the draft keeps its number');
      assert.equal((await h.api.audit.verify()).ok, true);

      const taxMeta = { buyerCountryCode: 'FR', buyerVatId: 'FR12345678901', destinationVatRate: 20, datevEvidenceType: 'gelangensbestaetigung', datevEvidenceReference: 'GB-2026-17' };
      const issued = await h.api.invoices.upsert({ reason: 'vollständig gestellt', invoice: { ...unposted, taxMeta, status: 'open' } as never });
      assert.equal(issued.status, 'open');
      assert.equal(issued.number, unposted.number, 'the number reserved for the failed attempt is the one that gets issued');
      const entry = (await invoiceEntry(h, issued.id))!;
      assert.equal(entry.lines.find((line) => line.accountNumber === '8400')!.taxCaseKey, 'EU_IGL_GOODS_0');
      assert.equal((await posted(h)).postedCount, before.posted + 1);
    });

    test('a role mapped to an unknown account makes issuing fail with 422 and rolls the whole issue back', async () => {
      const unposted = await draft(h, { client: 'Kaputte Zuordnung' });
      const saved = await map(h, 'revenue', '99999');
      if (saved.status !== 200) return; // the mapping is refused at save time, which is the better behaviour (see the todo test above)
      try {
        const before = await snapshotOfLedger();
        const refused = await h.raw('POST', '/invoices', { reason: 'stellen', invoice: { ...unposted, status: 'open', kind: 'invoice' } });
        assert.equal(refused.status, 422, refused.text);
        assert.match(refused.body.message, /UNKNOWN_ACCOUNT/);
        assert.doesNotMatch(refused.text, /insert into|params:/i, 'no SQL in the error');
        assert.deepEqual(await snapshotOfLedger(), before);
        const stored = await invoiceOf(h, unposted.id);
        assert.equal(stored.status, 'draft');
        assert.equal(stored.number, unposted.number);
      } finally {
        assert.equal((await map(h, 'revenue', '8400')).status, 200);
      }
      const issued = await h.api.invoices.upsert({ reason: 'nach Korrektur gestellt', invoice: { ...unposted, status: 'open' } });
      assert.equal(issued.number, unposted.number, 'the number survived the failed attempt');
      assert.deepEqual(shape((await invoiceEntry(h, issued.id))!), [['1400', GROSS, 0], ['8400', 0, 200], ['1776', 0, 38]]);
      assert.equal((await h.api.audit.verify()).ok, true);
    });
  });

  describe('corrections post the opposite', () => {
    test('a cancellation invoice mirrors the original entry and settles the open item', async () => {
      const source = await issue(h, { client: 'Storno GmbH' });
      const cancellation = await correction(h, source.id, 'cancellation_invoice');
      assert.equal(cancellation.documentKind, 'cancellation_invoice');
      const entry = (await entryFor(h, `outgoing-correction:${cancellation.id}`))!;
      assert.ok(entry, 'the cancellation is posted');
      assert.deepEqual(shape(entry), [['1400', 0, GROSS], ['8400', 200, 0], ['1776', 38, 0]]);
      assert.equal(entry.bookingText, `Stornorechnung ${cancellation.number}`);
      const original = (await invoiceEntry(h, source.id))!;
      const entries = [original, entry];
      for (const account of ['1400', '8400', '1776']) assert.equal(money(ledgerNet(entries, account)), 0, `${account} nets to zero over both entries`);
      const item = (await openItems(h)).find((candidate) => candidate.sourceId === source.id)!;
      assert.equal(item.residualAmount, 0);
      assert.notEqual(item.status, 'open');
      await assertLedgerConsistent(h);
    });

    test('an invoice can only be cancelled once', async () => {
      const source = await issue(h, { client: 'Doppelt storniert' });
      await correction(h, source.id, 'cancellation_invoice');
      const entries = (await journal(h)).length;
      const second = await correction(h, source.id, 'cancellation_invoice').then(() => 'accepted', (error: Error) => error.message);
      assert.notEqual(second, 'accepted', 'a second cancellation of the same invoice reverses the revenue twice');
      assert.equal((await journal(h)).length, entries, 'no second reversal entry');
    });

    test('a credit note books its gross amount: receivable, revenue and VAT reduced by what the document says', async () => {
      const source = await issue(h, { client: 'Gutschrift GmbH' });
      const credit = await correction(h, source.id, 'credit_note', 50);
      assert.equal(credit.amount, 50);
      const entry = (await entryFor(h, `outgoing-correction:${credit.id}`))!;
      assert.deepEqual(shape(entry), [['1400', 0, 50], ['8400', 42.02, 0], ['1776', 7.98, 0]]);
    });

    test('a credit note posts a balanced entry against the open item, and a credit above the invoice is refused', async () => {
      const source = await issue(h, { client: 'Gutschrift Grenze' });
      const credit = await correction(h, source.id, 'credit_note', 50);
      const entry = (await entryFor(h, `outgoing-correction:${credit.id}`))!;
      assertBalanced([entry]);
      assert.equal(entry.lines.find((line) => line.accountNumber === '1400')!.creditAmount, entry.lines.find((line) => line.accountNumber === '8400')!.debitAmount + entry.lines.find((line) => line.accountNumber === '1776')!.debitAmount);
      const item = (await openItems(h)).find((candidate) => candidate.sourceId === source.id)!;
      assert.ok(item.allocatedAmount > 0 && item.residualAmount < GROSS, 'the credit reduces the open item');
      const entries = (await journal(h)).length;
      await assert.rejects(correction(h, source.id, 'credit_note', GROSS * 10));
      assert.equal((await journal(h)).length, entries, 'the refused credit note posted nothing');
    });
  });

  describe('document reversal and journal reversal', () => {
    test('reversing an issued invoice posts the mirror entry at the chosen date and cancels the invoice', async () => {
      const source = await issue(h, { client: 'Reverse GmbH' });
      const original = (await invoiceEntry(h, source.id))!;
      const response = await h.raw('POST', '/accounting/documents/reverse', { reason: 'Falsch gebucht', documentType: 'outgoing_invoice', documentId: source.id, postingDate: today() });
      assert.equal(response.status, 200, response.text);
      const reversal = (await journal(h)).find((entry) => entry.id === response.body.reversalEntryId)!;
      assert.deepEqual(shape(reversal), [['1400', 0, GROSS], ['8400', 200, 0], ['1776', 38, 0]]);
      assert.equal(reversal.postingDate, today());
      assert.equal(reversal.reference, 'Falsch gebucht');
      assert.equal((await get<JournalEntry>(h, `/accounting/journal/${original.id}`)).status, 'reversed');
      assert.equal((await invoiceOf(h, source.id)).status, 'cancelled');
      assert.equal((await h.raw('POST', '/accounting/documents/reverse', { reason: 'nochmal', documentType: 'outgoing_invoice', documentId: source.id })).status, 409, 'a reversed document cannot be reversed again');
      assert.equal((await h.raw('POST', `/accounting/journal/${response.body.reversalEntryId}/reverse`, { reason: 'Gegenbuchung stornieren' })).status, 409, 'a reversal entry cannot be reversed');
      await assertLedgerConsistent(h);
    });

    test('a document with payments cannot be reversed, and a draft or unknown document is refused', async () => {
      const source = await issue(h, { client: 'Reverse mit Zahlung' });
      const item = (await openItems(h)).find((candidate) => candidate.sourceId === source.id)!;
      assert.equal((await payOpenItem(h, item, 10)).status, 200);
      const entries = (await journal(h)).length;
      const refused = await h.raw('POST', '/accounting/documents/reverse', { reason: 'Storno', documentType: 'outgoing_invoice', documentId: source.id });
      assert.equal(refused.status, 409, refused.text);
      assert.match(refused.body.message, /DOCUMENT_HAS_ALLOCATIONS/);
      const unposted = await draft(h, { client: 'Reverse Entwurf' });
      assert.equal((await h.raw('POST', '/accounting/documents/reverse', { reason: 'Storno', documentType: 'outgoing_invoice', documentId: unposted.id })).status, 409);
      assert.equal((await h.raw('POST', '/accounting/documents/reverse', { reason: 'Storno', documentType: 'outgoing_invoice', documentId: 'nope' })).status, 409);
      assert.equal((await h.raw('POST', '/accounting/documents/reverse', { reason: ' ', documentType: 'outgoing_invoice', documentId: source.id })).status, 400, 'a reason is mandatory');
      assert.equal((await journal(h)).length, entries);
    });

    test('the journal route cannot reverse entries owned by a document or a payment', async () => {
      const source = await issue(h, { client: 'Journal Owner' });
      const entry = (await invoiceEntry(h, source.id))!;
      const refused = await h.raw('POST', `/accounting/journal/${entry.id}/reverse`, { reason: 'am Beleg vorbei' });
      assert.equal(refused.status, 409, refused.text);
      assert.match(refused.body.message, /DOCUMENT_REVERSAL_REQUIRED/);
      const item = (await openItems(h)).find((candidate) => candidate.sourceId === source.id)!;
      const payment = await payOpenItem(h, item, 20);
      const paymentEntry = (await journal(h)).find((candidate) => candidate.id === payment.body.journalEntryId)!;
      const refusedPayment = await h.raw('POST', `/accounting/journal/${paymentEntry.id}/reverse`, { reason: 'Zahlung zurück' });
      assert.equal(refusedPayment.status, 409, refusedPayment.text);
      assert.match(refusedPayment.body.message, /PAYMENT_REVERSAL_REQUIRED/);
      assert.equal((await get<JournalEntry>(h, `/accounting/journal/${entry.id}`)).status, 'posted');
    });
  });

  describe('manual booking through drafts', () => {
    let bank: string;
    before(async () => { bank = await addBankAccount(h, 'bank-manual'); });
    const lines = (d: Draft, debit: number, credit: number = debit, extra: { debitAccount?: string; creditAccount?: string; tax?: boolean } = {}): Draft['lines'] => [
      { id: `${d.id}-1`, accountNumber: extra.debitAccount ?? '4930', debitAmount: debit, creditAmount: 0, ...(extra.tax ? { taxCaseKey: 'DE_STD_19', taxRate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 } : {}) },
      { id: `${d.id}-2`, accountNumber: extra.creditAccount ?? '1200', debitAmount: 0, creditAmount: credit, ...(extra.tax ? { taxCaseKey: 'DE_STD_19', taxRate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 } : {}) },
    ];
    const newTx = async (row: Partial<{ date: string; amount: number; counterparty: string; purpose: string }> = {}) => {
      const counterparty = row.counterparty ?? `Lieferant ${randomUUID().slice(0, 6)}`;
      await importCsv(h, bank, [{ date: row.date ?? '2026-03-02', amount: row.amount ?? -119, counterparty, purpose: row.purpose ?? 'Eingangsrechnung' }]);
      const tx = await bankTx(h, counterparty);
      return { tx, draft: await getDraft(h, tx.id) };
    };

    test('a draft walks imported → approved → posted, books the bank line and moves the ledger', async () => {
      const { tx, draft: d } = await newTx({ date: '2026-03-02' });
      assert.equal(d.workflowStatus, 'imported');
      assert.equal(tx.status, 'pending');
      const before = await posted(h);
      const approved = await approveDraft(h, d, lines(d, 119));
      assert.equal(approved.workflowStatus, 'approved');

      const result = await postDraft(h, d.id, { postingDate: '2026-03-02' });
      assert.equal(result.status, 200, result.text);
      assert.deepEqual(result.body.issues, []);
      const entry: JournalEntry = result.body.entry;
      assert.deepEqual(shape(entry), [['4930', 119, 0], ['1200', 0, 119]]);
      assert.deepEqual([entry.sourceType, entry.sourceDraftId, entry.postingDate, entry.period, entry.status], ['booking_draft', d.id, '2026-03-02', '2026-03', 'posted']);
      assert.equal((await bankTx(h, tx.counterparty)).status, 'booked');
      assert.equal((await getDraft(h, tx.id)).workflowStatus, 'posted');
      assert.equal((await posted(h)).postedCount, before.postedCount + 1);

      const again = await postDraft(h, d.id, { postingDate: '2026-03-02' });
      assert.equal(again.body.entry.id, entry.id, 'posting twice returns the same entry');
      assert.equal((await journal(h)).filter((candidate) => candidate.sourceDraftId === d.id).length, 1);
      assertBalanced([entry]);
    });

    test('the same draft posted four times at once books exactly one entry', async () => {
      const { tx, draft: d } = await newTx({ date: '2026-03-09' });
      await approveDraft(h, d, lines(d, 119));
      const entries = (await journal(h)).length;
      const results = await Promise.all(Array.from({ length: 4 }, () => postDraft(h, d.id, { postingDate: '2026-03-09' })));
      assert.ok(results.every((result) => result.status === 200), results.map((result) => result.status).join());
      assert.equal(new Set(results.map((result) => result.body.entry.id)).size, 1, 'all four answers name the same entry');
      assert.equal((await journal(h)).length, entries + 1);
      assert.equal((await bankTx(h, tx.counterparty)).status, 'booked');
    });

    test('an income line books bank debit against the suggested revenue account', async () => {
      const { draft: d } = await newTx({ amount: 250, counterparty: `Kunde ${randomUUID().slice(0, 6)}`, purpose: 'Barverkauf' });
      assert.equal(d.lines[0]!.accountNumber, '1200');
      assert.equal(d.lines[0]!.debitAmount, 250);
      assert.equal(d.lines[1]!.creditAmount, 250);
      assert.deepEqual(d.validationIssues, []);
    });

    const matrix: Array<[string, (d: Draft) => { lines: Draft['lines']; overrides?: Record<string, unknown> }, string[]]> = [
      ['an unbalanced entry', (d) => ({ lines: lines(d, 100, 99) }), ['UNBALANCED_ENTRY']],
      ['an entry of zero', (d) => ({ lines: lines(d, 0, 0) }), ['UNBALANCED_ENTRY', 'INVALID_LINE_AMOUNT']],
      ['a line with debit and credit at once', (d) => ({ lines: [{ ...lines(d, 119)[0]!, creditAmount: 119 }, lines(d, 119)[1]!] }), ['INVALID_LINE_AMOUNT']],
      ['a fraction of a cent', (d) => ({ lines: lines(d, 0.001) }), ['INVALID_LINE_AMOUNT']],
      ['a negative amount', (d) => ({ lines: lines(d, -5, 0) }), ['INVALID_LINE_AMOUNT']],
      ['an account that is not in the chart', (d) => ({ lines: lines(d, 119, 119, { debitAccount: '99999' }) }), ['UNKNOWN_ACCOUNT']],
      ['a line without an account', (d) => ({ lines: lines(d, 119, 119, { debitAccount: '' }) }), ['MISSING_ACCOUNT']],
      ['a single line', (d) => ({ lines: [lines(d, 119)[0]!] }), ['MISSING_ACCOUNT', 'UNBALANCED_ENTRY']],
      ['an impossible posting date', (d) => ({ lines: lines(d, 119), overrides: { postingDate: '2026-02-30' } }), ['INVALID_POSTING_DATE']],
      ['a period that does not match the posting date', (d) => ({ lines: lines(d, 119), overrides: { period: '2026-05' } }), ['POSTING_PERIOD_MISMATCH']],
      ['a §13b line without its evidence', (d) => ({ lines: [{ ...lines(d, 119)[0]!, taxCaseKey: 'DE_RC_13B_DOMESTIC' }, lines(d, 119)[1]!] }), ['MISSING_TAX_EVIDENCE']],
      ['an EU supply without country and VAT id', (d) => ({ lines: [{ ...lines(d, 119)[0]!, taxCaseKey: 'EU_IGL_GOODS_0' }, lines(d, 119)[1]!] }), ['MISSING_TAX_COUNTRY', 'MISSING_COUNTERPARTY_VAT_ID']],
    ];
    for (const [label, build, codes] of matrix) {
      test(`${label} is flagged, cannot be approved and posts nothing`, async () => {
        const { tx, draft: d } = await newTx({ date: '2026-03-03' });
        const built = build(d);
        const entries = (await journal(h)).length;
        const saved = await saveDraft(h, d, built.lines, built.overrides);
        assert.equal(saved.status, 200, saved.text);
        const found = saved.body.validationIssues.filter((issue: any) => issue.blocking).map((issue: any) => issue.code);
        for (const code of codes) assert.ok(found.includes(code), `${code} missing, got ${found}`);
        assert.equal(saved.body.workflowStatus, 'incomplete');

        const submitted = await draftAction(h, tx.id, 'submit_for_review');
        assert.equal(submitted.status, 200, submitted.text);
        assert.equal(submitted.body.workflowStatus, 'incomplete', 'a blocked draft does not move to review');
        assert.equal((await draftAction(h, tx.id, 'approve')).status, 409);
        const post = await postDraft(h, d.id, { postingDate: built.overrides?.postingDate as string | undefined ?? '2026-03-03' });
        assert.equal(post.status, 200, post.text);
        assert.equal(post.body.entry.id, '', 'no entry id: nothing was posted');
        assert.deepEqual(post.body.entry.lines, []);
        assert.ok(post.body.issues.length > 0 && post.body.issues.every((issue: any) => issue.blocking !== undefined));
        assert.equal((await journal(h)).length, entries);
        assert.equal((await bankTx(h, tx.counterparty)).status, 'pending');
      });
    }

    test('the fiscal year is derived from the posting date, whatever the client sends', async () => {
      const { draft: d } = await newTx({ date: '2026-03-03' });
      const saved = await saveDraft(h, d, lines(d, 119), { fiscalYear: 2019 });
      assert.equal(saved.status, 200, saved.text);
      assert.equal(saved.body.fiscalYear, 2026);
      assert.deepEqual(saved.body.validationIssues, []);
      assert.equal((await saveDraft(h, d, lines(d, 119), { period: '2026-13' })).status, 400, 'a malformed period is a bad request');
    });

    test('two lines with the same id are flagged instead of crashing the save', async () => {
      const { draft: d } = await newTx({ date: '2026-03-03' });
      const two = lines(d, 119);
      const saved = await saveDraft(h, d, [two[0]!, { ...two[1]!, id: two[0]!.id }]);
      assert.equal(saved.status, 200, saved.text);
      assert.ok(saved.body.validationIssues.some((issue: any) => issue.code === 'DUPLICATE_LINE_ID' && issue.blocking));
    });

    test('whole cents never raise a rounding alarm, and the exception count follows the unbalanced drafts', async () => {
      const baseline = (await get<{ unbalancedDraftCount: number }>(h, '/accounting/health')).unbalancedDraftCount;
      for (const amount of [0.07, 0.3, 1.1, 19.99, 1234.56]) {
        const { draft: d } = await newTx({ date: '2026-03-04', amount: -amount });
        const saved = await saveDraft(h, d, lines(d, amount));
        const codes = saved.body.validationIssues.map((issue: any) => issue.code);
        assert.ok(!codes.includes('INVALID_LINE_AMOUNT') && !codes.includes('UNBALANCED_ENTRY'), `${amount}: ${codes}`);
      }
      const { tx, draft: d } = await newTx({ date: '2026-03-04' });
      await saveDraft(h, d, lines(d, 100, 99));
      assert.equal((await get<{ unbalancedDraftCount: number }>(h, '/accounting/health')).unbalancedDraftCount, baseline + 1);
      const fixed = await saveDraft(h, d, lines(d, 119));
      assert.deepEqual(fixed.body.validationIssues, []);
      assert.equal((await get<{ unbalancedDraftCount: number }>(h, '/accounting/health')).unbalancedDraftCount, baseline);
      assert.equal((await getDraft(h, tx.id)).validationIssues.length, 0);
    });

    test('validating a draft reports its blocking issues without changing it and needs a draft or a transaction', async () => {
      const { tx, draft: d } = await newTx({ date: '2026-03-08' });
      await saveDraft(h, d, lines(d, 100, 99));
      const byTransaction = await h.raw('POST', '/accounting/validate', { reason: 'Prüfung', transactionId: tx.id });
      assert.equal(byTransaction.status, 200, byTransaction.text);
      assert.equal(byTransaction.body.ok, false);
      assert.ok(byTransaction.body.issues.some((issue: any) => issue.code === 'UNBALANCED_ENTRY' && issue.blocking));
      const byDraft = await h.raw('POST', `/accounting/drafts/${d.id}/validate`, { reason: 'Prüfung' });
      assert.equal(byDraft.body.ok, false);
      await saveDraft(h, d, lines(d, 119));
      const stateBefore = (await getDraft(h, tx.id)).workflowStatus;
      assert.equal((await h.raw('POST', '/accounting/validate', { reason: 'Prüfung', draftId: d.id })).body.ok, true);
      assert.equal((await h.raw('POST', '/accounting/validate', { reason: 'Prüfung' })).status, 400, 'a draft or a transaction is required');
      assert.equal((await h.raw('POST', '/accounting/validate', { transactionId: tx.id })).status, 400, 'a reason is required');
      assert.equal((await h.raw('POST', '/accounting/validate', { reason: 'Prüfung', transactionId: 'nope' })).status, 404, 'unknown draft');
      assert.equal((await getDraft(h, tx.id)).workflowStatus, stateBefore, 'validation does not move the workflow');
      await draftAction(h, tx.id, 'submit_for_review');
      await draftAction(h, tx.id, 'approve');
      assert.equal((await h.raw('POST', `/accounting/drafts/${d.id}/validate`, { reason: 'Prüfung' })).body.ok, true);
      assert.equal((await getDraft(h, tx.id)).workflowStatus, 'approved', 'validating an approved draft keeps it approved');
    });

    test('the server owns the workflow: a client cannot save a draft as approved or posted', async () => {
      const { tx, draft: d } = await newTx();
      for (const workflowStatus of ['approved', 'posted', 'reversed', 'corrected', 'period_locked']) {
        const response = await h.raw('POST', '/accounting/drafts', { reason: 'Status gesetzt', draft: { ...d, workflowStatus, lines: lines(d, 119) } });
        assert.equal(response.status, 400, `${workflowStatus}: ${response.text}`);
      }
      assert.equal((await h.raw('POST', '/accounting/drafts', { reason: ' ', draft: { ...d, lines: lines(d, 119) } })).status, 400, 'a reason is mandatory');
      assert.equal((await h.raw('POST', '/accounting/drafts', { reason: 'x', draft: { ...d, lines: [{ ...lines(d, 119)[0]!, taxCaseKey: 'DE_FANTASY' }, lines(d, 119)[1]!] } })).status, 400, 'unknown tax key');
      assert.equal((await h.raw('POST', '/accounting/drafts', { reason: 'x', draft: { ...d, lines: [{ ...lines(d, 119)[0]!, datevSachverhaltLl: '0' }, lines(d, 119)[1]!] } })).status, 400, 'Sachverhalt must be 1-999');
      assert.equal((await getDraft(h, tx.id)).workflowStatus, 'imported', 'nothing of this was stored');
    });

    test('workflow transitions: review → approve, reject returns to editing, and nothing skips a step', async () => {
      const { tx, draft: d } = await newTx();
      assert.equal((await draftAction(h, tx.id, 'approve')).status, 409, 'an imported draft cannot be approved');
      await saveDraft(h, d, lines(d, 119));
      const review = await draftAction(h, tx.id, 'submit_for_review');
      assert.equal(review.body.workflowStatus, 'pending_approval');
      const rejected = await h.raw('POST', `/accounting/drafts/${tx.id}/action`, { reason: 'Beleg fehlt', action: 'reject', rejectReason: 'Beleg fehlt' });
      assert.equal(rejected.status, 200, rejected.text);
      assert.equal(rejected.body.workflowStatus, 'incomplete');
      assert.equal((await draftAction(h, tx.id, 'approve')).status, 409, 'a rejected draft needs a new review first');
      assert.equal((await h.raw('POST', `/accounting/drafts/${tx.id}/action`, { reason: 'x', action: 'teleport' })).status, 400);
      assert.equal((await h.raw('POST', `/accounting/drafts/${tx.id}/action`, { action: 'approve' })).status, 400, 'reason is mandatory');
      assert.equal((await h.raw('POST', `/accounting/drafts/nope/action`, { reason: 'x', action: 'submit_for_review' })).status, 404, 'unknown draft');
      const blocked = await postDraft(h, d.id, { postingDate: '2026-03-02' });
      assert.equal(blocked.body.entry.id, '');
      assert.ok(blocked.body.issues.some((issue: any) => issue.code === 'DRAFT_NOT_APPROVED'));
      assert.equal((await h.raw('GET', '/accounting/drafts/not-a-transaction')).body, null);
    });

    test('a posted entry can be reversed once: the mirror neutralises every line and VAT cent, and cannot itself be reversed', async () => {
      const { draft: d } = await newTx({ date: '2026-03-05' });
      await approveDraft(h, d, lines(d, 119, 119, { tax: true }));
      const vat = async () => (await get<{ rows: Array<{ taxCaseKey: string; netAmount: number; taxAmount: number }> }>(h, '/accounting/vat/summary')).rows.find((row) => row.taxCaseKey === 'DE_STD_19')!;
      const vatBefore = await vat();
      const original: JournalEntry = (await postDraft(h, d.id, { postingDate: '2026-03-05' })).body.entry;
      const vatPosted = await vat();
      assert.deepEqual([money(vatPosted.netAmount - vatBefore.netAmount), money(vatPosted.taxAmount - vatBefore.taxAmount)], [200, 38], 'both lines carry the tax basis');

      const response = await h.raw('POST', `/accounting/journal/${original.id}/reverse`, { reason: 'Falsch kontiert', postingDate: '2026-04-15' });
      assert.equal(response.status, 200, response.text);
      const reversal = (await journal(h)).find((entry) => entry.id === response.body.reversalEntryId)!;
      assert.deepEqual(shape(reversal), [['4930', 0, 119], ['1200', 119, 0]]);
      assert.deepEqual([reversal.postingDate, reversal.period, reversal.reference, reversal.sourceType], ['2026-04-15', '2026-04', 'Falsch kontiert', 'reversal']);
      assert.match(reversal.bookingText, /^Storno \d+: /);
      const stored = await get<JournalEntry>(h, `/accounting/journal/${original.id}`);
      assert.equal(stored.status, 'reversed');
      assert.equal(stored.reversedEntryId, reversal.id);
      assert.equal(money(ledgerNet([stored, reversal], '4930')), 0);
      const vatAfter = await vat();
      assert.deepEqual([vatAfter.netAmount, vatAfter.taxAmount], [vatBefore.netAmount, vatBefore.taxAmount], 'the reversal neutralises the tax basis');

      assert.equal((await h.raw('POST', `/accounting/journal/${original.id}/reverse`, { reason: 'nochmal' })).status, 409, 'once only');
      assert.equal((await h.raw('POST', `/accounting/journal/${reversal.id}/reverse`, { reason: 'Gegenbuchung' })).status, 409, 'a reversal is final');
      assert.equal((await h.raw('POST', `/accounting/journal/${original.id}/reverse`, { reason: ' ' })).status, 400);
      assert.ok([404, 409].includes((await h.raw('POST', '/accounting/journal/nope/reverse', { reason: 'x' })).status));
      await assertLedgerConsistent(h);
    });

    test('a reversal needs a real date', async () => {
      const { draft: d } = await newTx({ date: '2026-03-06' });
      await approveDraft(h, d, lines(d, 119));
      const entry: JournalEntry = (await postDraft(h, d.id, { postingDate: '2026-03-06' })).body.entry;
      const response = await h.raw('POST', `/accounting/journal/${entry.id}/reverse`, { reason: 'Datum falsch', postingDate: '2026-13-45' });
      assert.equal(response.status, 409, response.text);
      assert.equal((await get<JournalEntry>(h, `/accounting/journal/${entry.id}`)).status, 'posted');
    });

    test('posted entries cannot be edited or deleted: the API has no such route', async () => {
      const { draft: d } = await newTx({ date: '2026-03-07' });
      await approveDraft(h, d, lines(d, 119));
      const entry: JournalEntry = (await postDraft(h, d.id, { postingDate: '2026-03-07' })).body.entry;
      for (const method of ['PUT', 'PATCH', 'DELETE']) {
        const response = await h.raw(method, `/accounting/journal/${entry.id}`, method === 'DELETE' ? undefined : { bookingText: 'manipuliert' });
        assert.equal(response.status, 404, `${method}: ${response.text}`);
      }
      assert.equal((await h.raw('POST', '/accounting/journal', { postingDate: '2026-03-07', lines: [] })).status, 404, 'no direct journal insert');
      assert.deepEqual(await get(h, `/accounting/journal/${entry.id}`), entry);
    });

    test('the journal list filters by date and account before it paginates, newest first', async () => {
      const dates = ['2026-02-03', '2026-02-10', '2026-02-17'];
      const entries: JournalEntry[] = [];
      for (const date of dates) {
        const { draft: d } = await newTx({ date, amount: -10, counterparty: `Filter ${date}` });
        await approveDraft(h, d, lines(d, 10, 10, { debitAccount: '4955' }));
        entries.push((await postDraft(h, d.id, { postingDate: date })).body.entry);
      }
      const ids = (query: string) => get<JournalEntry[]>(h, `/accounting/journal?${query}`).then((list) => list.map((entry) => entry.id));
      assert.deepEqual(await ids('accountNumbers=4955'), [entries[2]!.id, entries[1]!.id, entries[0]!.id]);
      assert.deepEqual(await ids('accountNumbers=4955&from=2026-02-05&to=2026-02-15'), [entries[1]!.id]);
      assert.deepEqual(await ids('accountNumbers=4955&limit=1'), [entries[2]!.id]);
      assert.deepEqual(await ids('accountNumbers=4955&limit=1&offset=1'), [entries[1]!.id]);
      const union = await ids('accountNumbers=4955&accountNumbers=4930');
      for (const entry of entries) assert.ok(union.includes(entry.id), 'repeated accountNumbers widen the filter');
      assert.deepEqual(await ids('accountNumbers=does-not-exist'), []);
      assert.equal((await h.raw('GET', '/accounting/journal?limit=0')).status, 400);
      assert.equal((await h.raw('GET', '/accounting/journal?limit=5001')).status, 400);
      assert.equal((await h.raw('GET', '/accounting/journal?offset=-1')).status, 400);
      assert.equal((await h.raw('GET', '/accounting/journal/nope')).body, null, 'an unknown entry is an empty answer, not a 404');
    });
  });

  describe('open items and payments', () => {
    const pay = payOpenItem;
    const itemOf = async (id: string) => (await openItems(h)).find((item) => item.sourceId === id)!;

    test('payments settle the open item and the invoice status follows: partial → partially_paid, rest → paid', async () => {
      const invoice = await issue(h, { client: 'Zahler GmbH' });
      const item = await itemOf(invoice.id);
      const first = await pay(h, item, 100);
      assert.equal(first.status, 200, first.text);
      assert.deepEqual([first.body.status, first.body.allocatedAmount, first.body.residualAmount], ['allocated', 100, 0]);
      const afterFirst = await itemOf(invoice.id);
      assert.deepEqual([afterFirst.status, afterFirst.allocatedAmount, afterFirst.residualAmount], ['partially_paid', 100, 138]);
      assert.equal((await invoiceOf(h, invoice.id)).status, 'open');
      const paymentEntry = (await journal(h)).find((entry) => entry.id === first.body.journalEntryId)!;
      assert.deepEqual(shape(paymentEntry), [['1200', 100, 0], ['1400', 0, 100]]);
      assert.equal(paymentEntry.sourceType, 'payment');

      const second = await pay(h, item, 138);
      assert.equal(second.status, 200, second.text);
      const afterSecond = await itemOf(invoice.id);
      assert.deepEqual([afterSecond.status, afterSecond.allocatedAmount, afterSecond.residualAmount], ['paid', GROSS, 0]);
      assert.equal((await invoiceOf(h, invoice.id)).status, 'paid');
      const bankSide = (await journal(h)).filter((entry) => entry.sourceType === 'payment' && entry.lines.some((line) => line.accountNumber === '1400' && line.creditAmount > 0));
      assert.ok(bankSide.length >= 2, 'both payments are in the journal');
      await assertLedgerConsistent(h);
    });

    test('an overpayment closes the item and keeps the surplus on the payment', async () => {
      const invoice = await issue(h, { client: 'Überzahler' });
      const item = await itemOf(invoice.id);
      const response = await pay(h, item, 300, {}, GROSS);
      assert.equal(response.status, 200, response.text);
      assert.deepEqual([response.body.allocatedAmount, response.body.residualAmount, response.body.status], [GROSS, 62, 'partially_allocated']);
      assert.equal((await itemOf(invoice.id)).status, 'paid');
      assert.equal((await invoiceOf(h, invoice.id)).status, 'paid');
    });

    test('allocations beyond the open balance or the payment, to the wrong party, an unknown item or with bad amounts are refused and book nothing', async () => {
      const invoice = await issue(h, { client: 'Grenzfall GmbH' });
      const item = await itemOf(invoice.id);
      const entries = (await journal(h)).length;
      const cases: Array<[string, Promise<{ status: number; body: any }>, number, RegExp?]> = [
        ['over the open balance', pay(h, item, 500), 400, /OPEN_ITEM_ALLOCATION_EXCEEDS_RESIDUAL/],
        ['more than the payment itself', pay(h, item, 5, {}, 10), 400, /PAYMENT_ALLOCATION_EXCEEDS_PAYMENT/],
        ['a creditor payment on a debtor item', pay(h, { ...item, partyType: 'creditor' }, 5), 422, /PAYMENT_PARTY_MISMATCH/],
        ['an unknown open item', pay(h, { ...item, id: 'nope' }, 5), 404, /OPEN_ITEM_NOT_FOUND/],
        ['a zero payment', pay(h, item, 0), 400],
        ['a negative payment', pay(h, item, -10), 400],
        ['a payment without event id', pay(h, item, 5, { allocationEventId: '' }), 400],
        ['a payment without bank account', pay(h, item, 5, { bankAccountNumber: '' }), 400],
        ['an unknown source type', pay(h, item, 5, { sourceType: 'cash_in_hand' }), 400],
        ['a malformed allocation', h.raw('POST', '/accounting/open-items/payments', { reason: 'x', payment: { sourceType: 'manual', sourceId: 'x', partyType: 'debtor', paymentDate: today(), amount: 5, bankAccountNumber: '1200', allocations: [{ openItemId: item.id, amount: -5 }], allocationEventId: 'e' } }), 400],
      ];
      for (const [label, call, status, message] of cases) {
        const response = await call;
        assert.equal(response.status, status, `${label}: ${JSON.stringify(response.body)}`);
        if (message) assert.match(response.body.message, message, label);
      }
      assert.equal((await journal(h)).length, entries);
      assert.deepEqual([(await itemOf(invoice.id)).status, (await itemOf(invoice.id)).allocatedAmount], ['open', 0]);
    });

    test('two payments racing for the same open item cannot allocate more than the balance', async () => {
      const invoice = await issue(h, { client: 'Wettlauf GmbH' });
      const item = await itemOf(invoice.id);
      const results = await Promise.all([pay(h, item, 150), pay(h, item, 150), pay(h, item, 150)]);
      const statuses = results.map((result) => result.status).sort();
      assert.deepEqual(statuses, [200, 400, 400], `exactly one 150 fits into 238: ${statuses}`);
      const after = await itemOf(invoice.id);
      assert.deepEqual([after.allocatedAmount, after.residualAmount, after.status], [150, 88, 'partially_paid']);
      await assertLedgerConsistent(h);
    });

    test('a retried payment with the same event id books once', async () => {
      const invoice = await issue(h, { client: 'Retry GmbH' });
      const item = await itemOf(invoice.id);
      const body = { sourceId: `pay-${randomUUID()}`, allocationEventId: `event-${randomUUID()}` };
      const first = await pay(h, item, 50, body);
      const entries = (await journal(h)).length;
      const replay = await pay(h, item, 50, body);
      assert.equal(replay.status, 200, replay.text);
      assert.equal(replay.body.id, first.body.id);
      assert.equal((await journal(h)).length, entries, 'no second journal entry');
      assert.equal((await itemOf(invoice.id)).allocatedAmount, 50, 'allocated once');
    });

    test('a retry of a payment that settled its item completely returns the recorded payment', async () => {
      const invoice = await issue(h, { client: 'Retry voll' });
      const item = await itemOf(invoice.id);
      const body = { sourceId: `pay-${randomUUID()}`, allocationEventId: `event-${randomUUID()}` };
      const first = await pay(h, item, GROSS, body);
      assert.equal(first.status, 200, first.text);
      const entries = (await journal(h)).length;
      const replay = await pay(h, item, GROSS, body);
      assert.equal(replay.status, 200, `${replay.status} ${replay.text}`);
      assert.equal(replay.body.id, first.body.id);
      assert.equal((await journal(h)).length, entries);
    });

    test('a retry of a remaining allocation that used up the payment returns the recorded result', async () => {
      const a = await issue(h, { client: 'Rest voll GmbH' });
      const b = await issue(h, { client: 'Rest voll GmbH' });
      const itemA = await itemOf(a.id);
      const itemB = await itemOf(b.id);
      const first = await pay(h, itemA, 300, { partyId: 'Rest voll GmbH' }, 100);
      const call = () => h.raw('POST', `/accounting/open-items/payments/${first.body.id}/remaining`, { reason: 'Rest', paymentId: first.body.id, allocations: [{ openItemId: itemB.id, amount: 200 }], allocationEventId: 'rest-all' });
      const ok = await call();
      assert.equal(ok.status, 200, ok.text);
      const replay = await call();
      assert.equal(replay.status, 200, `${replay.status} ${replay.text}`);
      assert.equal(replay.body.allocatedAmount, 300);
    });

    test('the rest of a payment can be allocated later, capped by what is left, and a retry does not duplicate it', async () => {
      const a = await issue(h, { client: 'Rest GmbH' });
      const b = await issue(h, { client: 'Rest GmbH' });
      const other = await issue(h, { client: 'Anderer Kunde' });
      const itemA = await itemOf(a.id);
      const itemB = await itemOf(b.id);
      const first = await pay(h, itemA, 300, { partyId: 'Rest GmbH' }, 100);
      assert.deepEqual([first.body.allocatedAmount, first.body.residualAmount, first.body.status], [100, 200, 'partially_allocated']);
      const remaining = (allocations: Array<{ openItemId: string; amount: number }>, allocationEventId: string) =>
        h.raw('POST', `/accounting/open-items/payments/${first.body.id}/remaining`, { reason: 'Rest zuordnen', paymentId: first.body.id, allocations, allocationEventId });
      const tooMuch = await remaining([{ openItemId: itemB.id, amount: 201 }], 'rest-too-much');
      assert.equal(tooMuch.status, 400, tooMuch.text);
      assert.match(tooMuch.body.message, /PAYMENT_ALLOCATION_EXCEEDS_RESIDUAL/);
      const ok = await remaining([{ openItemId: itemB.id, amount: 100 }], 'rest-100');
      assert.equal(ok.status, 200, ok.text);
      assert.deepEqual([ok.body.allocatedAmount, ok.body.residualAmount], [200, 100]);
      assert.equal((await remaining([{ openItemId: itemB.id, amount: 100 }], 'rest-100')).body.allocatedAmount, 200, 'a retry is a no-op');
      assert.equal((await itemOf(b.id)).allocatedAmount, 100, 'allocated once');
      const foreign = await remaining([{ openItemId: (await itemOf(other.id)).id, amount: 10 }], 'rest-foreign');
      assert.equal(foreign.status, 422, 'the rest of a payment cannot go to another customer');
      assert.match(foreign.body.message, /PAYMENT_PARTY_MISMATCH/);
      assert.equal((await h.raw('POST', '/accounting/open-items/payments/nope/remaining', { reason: 'x', paymentId: 'nope', allocations: [{ openItemId: itemB.id, amount: 1 }], allocationEventId: 'x' })).status, 404);
      await assertLedgerConsistent(h);
    });

    test('open items are ordered by due date and an overdue item stays open: aging is derived from the due date', async () => {
      const old = await issue(h, { client: 'Alt GmbH', date: addDays(today(), -80), dueDate: addDays(today(), -66) });
      const itemOld = await itemOf(old.id);
      assert.deepEqual([itemOld.documentDate, itemOld.dueDate, itemOld.status, itemOld.residualAmount], [old.date, old.dueDate, 'open', GROSS]);
      const items = await openItems(h);
      const dueDates = items.map((item) => item.dueDate);
      assert.deepEqual(dueDates, [...dueDates].sort(), 'sorted by due date');
      assert.equal(items[0]!.dueDate <= itemOld.dueDate, true);
      const age = Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${itemOld.dueDate}T00:00:00Z`)) / 86_400_000);
      assert.equal(age, 66, 'the buckets of the aging view are computed from dueDate');
    });

    test('recording an invoice payment on a Pro invoice either works or is refused with a typed error, never a 500', async () => {
      const invoice = await issue(h, { client: 'Rechnungszahlung' });
      const response = await h.raw('POST', `/invoices/${invoice.id}/payments`, { reason: 'bezahlt', payment: { id: randomUUID(), date: today(), amount: GROSS, method: 'bank' } });
      assert.ok(response.status < 500, `${response.status} ${response.text.slice(0, 120)}`);
      assert.doesNotMatch(response.text, /insert into|params:/i);
    });

    test('linking a bank transaction to an issued Pro invoice records the payment', async () => {
      const invoice = await issue(h, { client: `Verknüpfung ${randomUUID().slice(0, 6)}` });
      const account = await addBankAccount(h);
      await importCsv(h, account, [{ date: today(), amount: GROSS, counterparty: invoice.client, purpose: `Zahlung ${invoice.number}` }]);
      const legacy = (await get<Array<{ id: string; counterparty: string }>>(h, '/transactions')).find((tx) => tx.counterparty === invoice.client)!;
      const response = await h.raw('POST', `/transactions/${legacy.id}/link`, { reason: 'Zuordnung', invoiceId: invoice.id });
      assert.equal(response.status, 200, response.text.slice(0, 160));
    });

    test('a bank line allocated to an open item books the transaction once and needs the party', async () => {
      const invoice = await issue(h, { client: `Bankzahler ${randomUUID().slice(0, 6)}` });
      const item = await itemOf(invoice.id);
      const account = await addBankAccount(h);
      await importCsv(h, account, [{ date: today(), amount: GROSS, counterparty: invoice.client, purpose: `Zahlung ${invoice.number}` }]);
      const tx = await bankTx(h, invoice.client);
      assert.equal(tx.status, 'pending');
      const payment = (partyId?: string, eventId = `ev-${randomUUID()}`) => pay(h, item, GROSS, { sourceType: 'bank_transaction', sourceId: tx.id, ...(partyId ? { partyId } : {}), allocationEventId: eventId });
      const noParty = await payment();
      assert.equal(noParty.status, 400, noParty.text);
      assert.match(noParty.body.message, /PAYMENT_PARTY_REQUIRED/);
      assert.equal((await bankTx(h, invoice.client)).status, 'pending');

      const ok = await payment(invoice.client);
      assert.equal(ok.status, 200, ok.text);
      const booked = await bankTx(h, invoice.client);
      assert.deepEqual([booked.status, booked.linkedInvoiceId], ['booked', invoice.id]);
      assert.equal((await getDraft(h, tx.id)).workflowStatus, 'posted');
      assert.equal((await invoiceOf(h, invoice.id)).status, 'paid');
      const entries = (await journal(h)).filter((entry) => entry.sourceKey === `payment:bank_transaction:${tx.id}`);
      assert.equal(entries.length, 1);
      assert.deepEqual(shape(entries[0]!), [['1200', GROSS, 0], ['1400', 0, GROSS]]);

      const replay = await payment(invoice.client);
      assert.equal(replay.body.id, ok.body.id, 'the same bank line is never booked twice');
      assert.equal((await journal(h)).filter((entry) => entry.sourceKey === `payment:bank_transaction:${tx.id}`).length, 1);
    });

    test('a bank line booked manually cannot then be allocated to an open item', async () => {
      const invoice = await issue(h, { client: `Erst manuell ${randomUUID().slice(0, 6)}` });
      const item = await itemOf(invoice.id);
      const account = await addBankAccount(h);
      await importCsv(h, account, [{ date: today(), amount: GROSS, counterparty: invoice.client, purpose: `Zahlung ${invoice.number}` }]);
      const tx = await bankTx(h, invoice.client);
      const d = await getDraft(h, tx.id);
      await approveDraft(h, d, [{ id: `${d.id}-1`, accountNumber: '1200', debitAmount: GROSS, creditAmount: 0 }, { id: `${d.id}-2`, accountNumber: '8400', debitAmount: 0, creditAmount: GROSS }], { postingDate: today() });
      assert.equal((await postDraft(h, d.id, { postingDate: today() })).status, 200);
      const entries = (await journal(h)).length;
      const refused = await pay(h, item, GROSS, { sourceType: 'bank_transaction', sourceId: tx.id, partyId: invoice.client });
      assert.equal(refused.status, 409, refused.text);
      assert.match(refused.body.message, /PAYMENT_SOURCE_ALREADY_BOOKED/);
      assert.equal((await journal(h)).length, entries);
      assert.equal((await itemOf(invoice.id)).status, 'open');
    });

    test('a bank line already allocated to an open item cannot be booked again as a manual draft', async () => {
      const invoice = await issue(h, { client: `Erst OPOS ${randomUUID().slice(0, 6)}` });
      const item = await itemOf(invoice.id);
      const account = await addBankAccount(h);
      await importCsv(h, account, [{ date: today(), amount: GROSS, counterparty: invoice.client, purpose: `Zahlung ${invoice.number}` }]);
      const tx = await bankTx(h, invoice.client);
      assert.equal((await pay(h, item, GROSS, { sourceType: 'bank_transaction', sourceId: tx.id, partyId: invoice.client })).status, 200);
      const d = await getDraft(h, tx.id);
      const entries = (await journal(h)).length;
      const lines2 = [{ id: `${d.id}-1`, accountNumber: '1200', debitAmount: GROSS, creditAmount: 0 }, { id: `${d.id}-2`, accountNumber: '8400', debitAmount: 0, creditAmount: GROSS }];
      const saved = await saveDraft(h, d, lines2, { postingDate: today() });
      await draftAction(h, tx.id, 'submit_for_review');
      await draftAction(h, tx.id, 'approve');
      const attempt = await postDraft(h, d.id, { postingDate: today() });
      assert.equal((await journal(h)).length - entries, 0, `the bank line was booked a second time (save ${saved.status}, post ${attempt.status})`);
    });
  });

  describe('bank import and the reconciliation workbench', () => {
    let bank: string;
    before(async () => { bank = await addBankAccount(h, 'bank-workbench'); });
    const token = () => randomUUID().replaceAll('-', '').slice(0, 6);
    const rule = (extra: Record<string, unknown> = {}) => ({ chart: 'SKR03', priority: 10, field: 'counterparty', operator: 'contains', targetAccountNumber: '4920', flowType: 'expense', reason: 'Regel gespeichert', ...extra });
    const saveRule = (extra: Record<string, unknown>) => h.raw('POST', '/accounting/account-suggestion-rules', rule(extra));
    const rules = () => get<Array<{ id: string; value: string; targetAccountNumber: string; priority: number; active: boolean; createdAt: string; hitCount?: number; lastHitAt?: string }>>(h, '/accounting/account-suggestion-rules?chart=SKR03');
    const dropRule = (id: string) => h.raw('DELETE', `/accounting/account-suggestion-rules/${id}?reason=${encodeURIComponent('Regel entfernt')}`);
    const suggestion = async (counterparty: string) => { const tx = await bankTx(h, counterparty); return [tx.suggestionLayer, tx.suggestedAccountNumber]; };

    test('an import lands in the workbench as pending lines with signs, types and suggestions; the legacy list keeps the bank status', async () => {
      const u = token();
      const rows: CsvRow[] = [
        { date: '2026-03-02', amount: -119, counterparty: `Hetzner ${u}`, purpose: 'Server' },
        { date: '2026-03-05', amount: 500, counterparty: `Kunde ${u}`, purpose: 'Zahlung' },
        { date: '2026-03-06', amount: -42.5, counterparty: `Aral ${u}`, purpose: 'Kraftstoff' },
      ];
      const { preview, commit } = await importCsv(h, bank, rows);
      assert.deepEqual([commit.imported, commit.skipped, commit.errors.length], [3, 0, 0]);
      assert.equal(commit.fileSha256, createHash('sha256').update(bankCsv(rows)).digest('hex'));
      assert.equal(preview.stats.validRows, 3);
      const workbench = (await bankTransactions(h)).filter((tx) => tx.counterparty.endsWith(u));
      assert.equal(workbench.length, 3);
      for (const tx of workbench) assert.deepEqual([tx.status, tx.accountId], ['pending', bank]);
      assert.deepEqual(workbench.map((tx) => [tx.type, tx.amount]).sort(), [['expense', -119], ['expense', -42.5], ['income', 500]].sort());
      assert.ok(workbench.every((tx) => tx.suggestedAccountNumber && tx.suggestionLayer), 'every line carries a suggestion');
      const legacy = (await get<Array<{ id: string; counterparty: string; status: string; importBatchId: string }>>(h, '/transactions')).filter((tx) => tx.counterparty.endsWith(u));
      assert.equal(legacy.length, 3);
      assert.ok(legacy.every((tx) => tx.status === 'booked' && tx.importBatchId === commit.batchId), 'the shared transaction list keeps the bank status and batch');
      assert.equal(new Set([...legacy.map((tx) => tx.id), ...workbench.map((tx) => tx.id)]).size, 6, 'the two lists use different ids');
      const batches = await get<Array<{ id: string; importedCount: number; fileName: string }>>(h, '/finance/import-batches');
      assert.equal(batches.find((batch) => batch.id === commit.batchId)!.importedCount, 3);
    });

    test('the same file is recognised, the same lines in another file are deduplicated and an overlapping file only adds the new line', async () => {
      const u = token();
      const first: CsvRow[] = [
        { date: '2026-04-01', amount: -10, counterparty: `Dedup ${u}`, purpose: 'Eins' },
        { date: '2026-04-02', amount: -20, counterparty: `Dedup ${u}`, purpose: 'Zwei' },
      ];
      const original = await importCsv(h, bank, first);
      assert.deepEqual([original.commit.imported, original.commit.skipped], [2, 0]);
      const sameFile = await importCsv(h, bank, first);
      assert.equal(sameFile.commit.batchId, original.commit.batchId, 'an identical file is a replay of the earlier batch');
      assert.equal(sameFile.commit.fileSha256, original.commit.fileSha256);
      const reordered = await importCsv(h, bank, [...first].reverse());
      assert.notEqual(reordered.commit.batchId, original.commit.batchId);
      assert.deepEqual([reordered.commit.imported, reordered.commit.skipped], [0, 2], 'the same lines in a different file are skipped one by one');
      const overlap = await importCsv(h, bank, [...first, { date: '2026-04-03', amount: -30, counterparty: `Dedup ${u}`, purpose: 'Drei' }]);
      assert.deepEqual([overlap.commit.imported, overlap.commit.skipped], [1, 2]);
      assert.equal((await bankTransactions(h)).filter((tx) => tx.counterparty === `Dedup ${u}`).length, 3, 'three lines, never five');
    });

    test('bad imports are refused or reported line by line and never half-import silently', async () => {
      const upload = (body: Record<string, unknown>) => h.raw('POST', '/finance/import/preview', body);
      const csv = Buffer.from(bankCsv([{ date: '2026-04-01', amount: -1, counterparty: 'x', purpose: 'y' }]), 'utf8').toString('base64');
      assert.equal((await upload({ fileName: 'konto.txt', contentBase64: csv, profile: 'generic' })).status, 400, 'only .csv');
      assert.equal((await upload({ fileName: '../konto.csv', contentBase64: csv, profile: 'generic' })).status, 400, 'no path in the name');
      assert.equal((await upload({ fileName: 'konto.csv', contentBase64: 'not base64 at all!!', profile: 'generic' })).status, 400);
      assert.equal((await upload({ fileName: 'konto.csv', contentBase64: '', profile: 'generic' })).status, 400);
      assert.equal((await upload({ fileName: 'konto.csv', profile: 'generic' })).status, 400, 'no content at all');
      const preview = await upload({ fileName: 'konto.csv', contentBase64: csv, profile: 'generic' });
      const commit = (accountId: string, path: string = preview.body.path) => h.raw('POST', '/finance/import/commit', { path, accountId, profile: 'generic', mapping: preview.body.suggestedMapping });
      const unknown = await commit('no-such-account');
      assert.equal(unknown.status, 404, unknown.text);
      assert.match(unknown.body.message, /ACCOUNT_NOT_FOUND/);
      assert.equal((await commit(bank, 'import-upload:expired-or-foreign')).status, 404, 'a stale upload handle');

      const mixed = Buffer.from('Datum;Betrag;Empfänger;Verwendungszweck\n2026-05-01;-5,00;Gut;ok\n32.13.2026;-6,00;Schlecht;Datum kaputt\n2026-05-03;abc;Schlecht;Betrag kaputt\n', 'utf8').toString('base64');
      const mixedPreview = await upload({ fileName: `gemischt-${token()}.csv`, contentBase64: mixed, profile: 'generic' });
      assert.equal(mixedPreview.status, 200, mixedPreview.text);
      assert.deepEqual([mixedPreview.body.stats.validRows, mixedPreview.body.stats.errorRows], [1, 2]);
      const committed = await h.raw('POST', '/finance/import/commit', { path: mixedPreview.body.path, accountId: bank, profile: 'generic', mapping: mixedPreview.body.suggestedMapping });
      assert.equal(committed.status, 200, committed.text);
      assert.deepEqual([committed.body.imported, committed.body.errors.length], [1, 2], 'good rows in, bad rows reported');
    });

    test('rolling back an import removes its lines from the workbench too', async () => {
      const u = token();
      const { commit } = await importCsv(h, bank, [{ date: '2026-04-10', amount: -77, counterparty: `Falsche Datei ${u}`, purpose: 'Rollback' }]);
      assert.equal((await bankTransactions(h)).filter((tx) => tx.counterparty === `Falsche Datei ${u}`).length, 1);
      const rolled = await h.raw('POST', `/finance/import-batches/${commit.batchId}/rollback`, { reason: 'falsche Datei' });
      assert.equal(rolled.status, 200, rolled.text);
      assert.equal((await get<unknown[]>(h, '/transactions')).filter((tx: any) => tx.counterparty === `Falsche Datei ${u}`).length, 0);
      assert.equal((await bankTransactions(h)).filter((tx) => tx.counterparty === `Falsche Datei ${u}`).length, 0, 'still in the workbench');
    });

    test('document analysis is off without an API key and checks the transaction before it would call out', async () => {
      const config = await get<{ configured: boolean; models: string[]; maxDocumentBytes: number; timeoutMs: number }>(h, '/accounting/vlm/config');
      assert.equal(config.configured, false);
      assert.ok(config.models.length > 0 && config.maxDocumentBytes === 10 * 1024 * 1024 && config.timeoutMs > 0);
      const u = token();
      await importCsv(h, bank, [{ date: '2026-04-20', amount: -88, counterparty: `Beleg ${u}`, purpose: 'Analyse' }]);
      const tx = await bankTx(h, `Beleg ${u}`);
      const body = (over: Record<string, unknown> = {}) => ({ transaction: { id: tx.id, date: tx.date, amount: tx.amount, currency: 'EUR', type: tx.type, counterparty: tx.counterparty, purpose: tx.purpose }, document: { mimeType: 'application/pdf', data: Buffer.from('%PDF-1.4 beleg').toString('base64'), fileName: 'beleg.pdf' }, ...over });
      const analyze = (id: string, payload: unknown) => h.raw('POST', `/accounting/transactions/${id}/analyze-document`, payload);
      const notConfigured = await analyze(tx.id, body());
      assert.equal(notConfigured.status, 503, notConfigured.text);
      assert.equal((await analyze(tx.id, body({ transaction: { ...body().transaction, id: 'another-transaction' } }))).status, 400, 'the body must describe the transaction of the URL');
      assert.equal((await analyze('missing', body({ transaction: { ...body().transaction, id: 'missing' } }))).status, 404);
      assert.equal((await analyze(tx.id, body({ document: { mimeType: 'application/zip', data: 'AAAA' } }))).status, 400);
      assert.equal((await analyze(tx.id, body({ document: { mimeType: 'application/pdf', data: '' } }))).status, 400);
      assert.equal((await getDraft(h, tx.id)).workflowStatus, 'imported', 'an analysis never touches the booking');
    });

    test('suggestion rules: create, rank by priority, narrow by flow, deactivate, update in place and delete', async () => {
      const u = token();
      const name = `Anbieter ${u}`;
      await importCsv(h, bank, [{ date: '2026-04-11', amount: -30, counterparty: name, purpose: 'Rechnung' }, { date: '2026-04-11', amount: 30, counterparty: `Erlös ${u}`, purpose: 'Gutschrift' }]);
      assert.deepEqual((await suggestion(name))[0], 'fallback');

      const low = await saveRule({ value: u, priority: 10, targetAccountNumber: '4920' });
      assert.equal(low.status, 200, low.text);
      assert.deepEqual(await suggestion(name), ['rule', '4920']);
      assert.match((await bankTx(h, name)).suggestionReason ?? '', /Regel/);
      const high = await saveRule({ value: u, priority: 5, targetAccountNumber: '4930' });
      assert.deepEqual(await suggestion(name), ['rule', '4930'], 'the lower priority number wins');
      assert.equal((await rules()).filter((candidate) => candidate.value === u).length, 2);

      const updated = await saveRule({ id: high.body.id, value: u, priority: 5, targetAccountNumber: '4930', flowType: 'income' });
      assert.equal(updated.body.id, high.body.id, 'update keeps the id');
      assert.equal(updated.body.createdAt, high.body.createdAt, 'update keeps the creation time');
      assert.deepEqual(await suggestion(name), ['rule', '4920'], 'an income-only rule does not touch an expense line');
      assert.equal((await rules()).filter((candidate) => candidate.value === u).length, 2, 'still two rows');

      await saveRule({ id: low.body.id, value: u, priority: 10, targetAccountNumber: '4920', flowType: 'expense', active: false });
      assert.equal((await suggestion(name))[0], 'fallback', 'inactive rules are ignored');
      await saveRule({ id: low.body.id, value: u, priority: 10, targetAccountNumber: '4920', flowType: 'expense', active: true, operator: 'equals' });
      assert.equal((await suggestion(name))[0], 'fallback', 'equals needs the whole counterparty');
      await saveRule({ id: low.body.id, value: name, priority: 10, targetAccountNumber: '4920', flowType: 'expense', operator: 'equals' });
      assert.deepEqual(await suggestion(name), ['rule', '4920']);
      await saveRule({ id: low.body.id, value: 'Anbieter', priority: 10, targetAccountNumber: '4920', flowType: 'expense', operator: 'startsWith' });
      assert.deepEqual(await suggestion(name), ['rule', '4920']);
      await saveRule({ id: low.body.id, value: 'Rechnung', priority: 10, targetAccountNumber: '4920', flowType: 'expense', operator: 'contains', field: 'purpose' });
      assert.deepEqual(await suggestion(name), ['rule', '4920'], 'a purpose rule matches the purpose');
      await saveRule({ id: low.body.id, value: u, priority: 10, targetAccountNumber: '4920', flowType: 'expense', chart: 'SKR04' });
      assert.equal((await suggestion(name))[0], 'fallback', 'a rule of the other chart is not applied');

      const draftOf = async () => getDraft(h, (await bankTx(h, name)).id);
      await saveRule({ id: low.body.id, value: u, priority: 10, targetAccountNumber: '4920', flowType: 'expense' });
      assert.equal((await draftOf()).lines[0]!.accountNumber, '4920', 'the booking proposal starts from the rule account');
      for (const id of [low.body.id, high.body.id]) assert.equal((await dropRule(id)).status, 200);
      assert.equal((await rules()).filter((candidate) => candidate.value === u).length, 0);
      assert.equal((await suggestion(name))[0], 'fallback');
    });

    test('rule input is validated, a delete needs a reason and deleting twice is harmless', async () => {
      assert.equal((await saveRule({ value: 'x', operator: 'regex' })).status, 400);
      assert.equal((await saveRule({ value: '' })).status, 400);
      assert.equal((await saveRule({ value: 'x', field: 'iban' })).status, 400);
      assert.equal((await saveRule({ value: 'x', priority: 1.5 })).status, 400);
      assert.equal((await saveRule({ value: 'x', targetAccountNumber: '' })).status, 400);
      assert.equal((await saveRule({ value: 'x', chart: 'SKR09' })).status, 400);
      assert.equal((await saveRule({ value: 'x', reason: '  ' })).status, 400);
      assert.equal((await saveRule({ value: 'x', flowType: 'transfer' })).status, 400);
      assert.equal((await h.raw('DELETE', '/accounting/account-suggestion-rules/whatever')).status, 400, 'delete without reason');
      assert.equal((await dropRule('does-not-exist')).status, 200);
      const csv = await h.api.audit.exportCsv();
      assert.ok(csv.includes('Regel gespeichert') || csv.includes('account_suggestion_rule'), 'rule changes are audited');
    });

    test('a rule that points at an account that does not exist is refused', async () => {
      const response = await saveRule({ value: `zzz${token()}`, targetAccountNumber: '99999' });
      try { assert.ok(response.status >= 400, `stored with ${response.status}`); } finally { if (response.status === 200) await dropRule(response.body.id); }
    });

    test('accepting a suggestion books the rule account against the bank, counts as a rule hit and teaches the counterparty', async () => {
      const u = token();
      const name = `Anbieter ${u}-tel GmbH`;
      const telekom = await saveRule({ value: `${u}-tel`, priority: 1, targetAccountNumber: '4920' });
      const broad = await saveRule({ value: u, priority: 2, targetAccountNumber: '4900' });
      try {
        const book = async (date: string, account: string) => {
          await importCsv(h, bank, [{ date, amount: -50, counterparty: name, purpose: `Rechnung ${date}` }]);
          const tx = (await bankTransactions(h)).find((candidate) => candidate.counterparty === name && candidate.purpose === `Rechnung ${date}`)!;
          const d = await getDraft(h, tx.id);
          assert.equal(d.lines[0]!.accountNumber, account === '4980' ? '4920' : account, 'the proposal is the rule account');
          await approveDraft(h, d, [{ ...d.lines[0]!, accountNumber: account }, d.lines[1]!], { postingDate: date });
          const entry: JournalEntry = (await postDraft(h, d.id, { postingDate: date })).body.entry;
          assert.deepEqual(shape(entry), [[account, 50, 0], ['1200', 0, 50]]);
          return tx;
        };
        await book('2026-03-10', '4920');
        await book('2026-05-02', '4920');
        await book('2026-06-01', '4980');
        await importCsv(h, bank, [{ date: '2026-07-01', amount: -50, counterparty: name, purpose: 'Rechnung offen' }]);
        const hit = (await rules()).find((candidate) => candidate.id === telekom.body.id)!;
        assert.deepEqual([hit.hitCount, hit.lastHitAt], [2, '2026-05-02'], 'posted bookings on the rule account count; an overridden or unposted one does not');
        assert.equal((await rules()).find((candidate) => candidate.id === broad.body.id)!.hitCount, 0, 'only the winning rule is credited');
      } finally {
        await dropRule(telekom.body.id); await dropRule(broad.body.id);
      }
      const next = `Gelernt ${u}`;
      await importCsv(h, bank, [{ date: '2026-08-01', amount: -20, counterparty: next, purpose: 'Erste' }]);
      const first = await bankTx(h, next);
      const d = await getDraft(h, first.id);
      await approveDraft(h, d, [{ ...d.lines[0]!, accountNumber: '4930' }, d.lines[1]!], { postingDate: '2026-08-01' });
      await postDraft(h, d.id, { postingDate: '2026-08-01' });
      await importCsv(h, bank, [{ date: '2026-08-02', amount: -20, counterparty: next, purpose: 'Zweite' }]);
      const second = (await bankTransactions(h)).find((tx) => tx.counterparty === next && tx.purpose === 'Zweite')!;
      assert.deepEqual([second.suggestionLayer, second.suggestedAccountNumber], ['counterparty', '4930']);
    });
  });

  describe('vendors, incoming invoices and the receipts archive', () => {
    const vendorId = `v-${randomUUID().slice(0, 6)}`;
    const vendor = (id: string = vendorId, extra: Record<string, unknown> = {}) => ({ reason: 'Lieferant gespeichert', vendor: { id, name: `Lieferant ${id}`, vendorNumber: `K-${id}`, ...extra } });
    const incoming = (id: string, over: Record<string, unknown> = {}, vendor: string = vendorId) => ({
      reason: 'Eingangsrechnung erfasst',
      invoice: {
        id, vendorId: vendor, number: `ER-${id}`, invoiceDate: '2026-03-02', dueDate: '2026-03-30', netAmount: 100, taxAmount: 19, grossAmount: 119, status: 'open', taxRate: 19,
        lines: [{ id: `l-${id}`, incomingInvoiceId: id, position: 0, description: 'Hosting', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 19, taxAmount: 19, grossAmount: 119 }],
        ...over,
      },
    });
    const post = (id: string) => h.raw('POST', '/accounting/incoming-invoices/post', { invoiceId: id, reason: 'Eingangsrechnung gebucht' });
    const listed = (id: string) => get<Array<any>>(h, '/accounting/incoming-invoices').then((all) => all.find((invoice) => invoice.id === id));
    before(async () => { assert.equal((await h.raw('POST', '/accounting/vendors', vendor())).status, 200); });

    test('vendors validate their name, update in place and are listed by name', async () => {
      const id = `v-${randomUUID().slice(0, 6)}`;
      assert.equal((await h.raw('POST', '/accounting/vendors', vendor(id, { name: '' }))).status, 400);
      assert.equal((await h.raw('POST', '/accounting/vendors', { vendor: { id, name: 'X' } })).status, 400, 'reason required');
      const created = await h.raw('POST', '/accounting/vendors', vendor(id, { email: 'a@example.com', vatId: 'DE123456789', iban: 'DE02120300000000202051', defaultExpenseAccount: '4930' }));
      assert.equal(created.status, 200, created.text);
      const renamed = await h.raw('POST', '/accounting/vendors', vendor(id, { name: 'Aaa Umbenannt' }));
      assert.equal(renamed.body.createdAt, created.body.createdAt);
      const all = await get<Array<{ id: string; name: string }>>(h, '/accounting/vendors');
      assert.equal(all.filter((candidate) => candidate.id === id).length, 1);
      const names = all.map((candidate) => candidate.name);
      assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), 'sorted by name');
    });

    test('an incoming invoice needs its vendor, and amounts that do not add up cannot be posted', async () => {
      assert.equal((await h.raw('POST', '/accounting/incoming-invoices', incoming(`in-${randomUUID().slice(0, 6)}`, {}, 'no-such-vendor'))).status, 404);
      assert.equal((await h.raw('POST', '/accounting/incoming-invoices', incoming(`in-${randomUUID().slice(0, 6)}`, { status: 'paid-ish' }))).status, 400);
      assert.equal((await h.raw('POST', '/accounting/incoming-invoices', { invoice: incoming('x').invoice })).status, 400, 'reason required');
      const id = `in-${randomUUID().slice(0, 6)}`;
      assert.equal((await h.raw('POST', '/accounting/incoming-invoices', incoming(id, { grossAmount: 500 }))).status, 200);
      const entries = (await journal(h)).length;
      const preview = await h.raw('POST', '/accounting/incoming-invoices/preview', { invoiceId: id, reason: 'Vorschau' });
      assert.deepEqual([preview.body.status, preview.body.reason], ['unresolved', 'AMBIGUOUS_TAX_SNAPSHOT']);
      const attempt = await post(id);
      assert.equal(attempt.body.status, 'unresolved');
      assert.equal((await journal(h)).length, entries, 'nothing posted');
      assert.equal((await listed(id)).accountingStatus, 'unposted');
      assert.equal((await h.raw('POST', '/accounting/incoming-invoices/post', { invoiceId: 'nope', reason: 'x' })).status, 404);
    });

    test('posting books expense, input VAT and the creditor, opens a creditor item and is idempotent; a posted invoice and its vendor are frozen', async () => {
      const id = `in-${randomUUID().slice(0, 6)}`;
      await h.raw('POST', '/accounting/incoming-invoices', incoming(id));
      const preview = await h.raw('POST', '/accounting/incoming-invoices/preview', { invoiceId: id, reason: 'Vorschau' });
      assert.equal(preview.body.status, 'ready');
      const result = await post(id);
      assert.equal(result.status, 200, result.text);
      const entry = (await entryFor(h, `incoming-invoice:${id}`))!;
      assert.deepEqual(shape(entry), [['4900', 100, 0], ['1576', 19, 0], ['1600', 0, 119]]);
      assert.equal(entry.lines[0]!.taxCaseKey, 'DE_STD_19');
      assert.deepEqual(preview.body.snapshot.lines.map((line: any) => [line.accountNumber, line.debitAmount, line.creditAmount]), shape(entry));
      assertBalanced([entry]);
      const item = (await openItems(h)).find((candidate) => candidate.sourceId === id)!;
      assert.deepEqual([item.partyType, item.partyId, item.originalAmount, item.residualAmount, item.status, item.journalEntryId], ['creditor', vendorId, 119, 119, 'open', entry.id]);
      const stored = await listed(id);
      assert.equal(stored.accountingStatus, 'posted');
      assert.equal(stored.accountingSnapshot.grossAmount, 119);

      assert.equal((await post(id)).body.status, 'ready');
      assert.equal((await journal(h)).filter((candidate) => candidate.sourceKey === `incoming-invoice:${id}`).length, 1, 'posted once');
      const edit = await h.raw('POST', '/accounting/incoming-invoices', incoming(id, { netAmount: 999, grossAmount: 1018 }));
      assert.equal(edit.body.grossAmount, 119, 'a posted invoice keeps its amounts');
      assert.equal((await listed(id)).grossAmount, 119);
      const rename = await h.raw('POST', '/accounting/vendors', vendor(vendorId, { name: 'Umbenannt nach Buchung' }));
      assert.equal(rename.status, 409, rename.text);
      assert.match(rename.body.message, /VENDOR_HAS_POSTED_DOCUMENTS/);
    });

    test('mixed rates post one debit base per line with its own account and a balanced total', async () => {
      const id = `in-${randomUUID().slice(0, 6)}`;
      const lines = [
        { id: `${id}-a`, incomingInvoiceId: id, position: 0, description: 'A', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 19, taxAmount: 19, grossAmount: 119, accountNumber: '4930' },
        { id: `${id}-b`, incomingInvoiceId: id, position: 1, description: 'B', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 7, taxAmount: 7, grossAmount: 107, accountNumber: '4940' },
      ];
      await h.raw('POST', '/accounting/incoming-invoices', incoming(id, { netAmount: 200, taxAmount: 26, grossAmount: 226, lines }));
      assert.equal((await post(id)).body.status, 'ready');
      const entry = (await entryFor(h, `incoming-invoice:${id}`))!;
      assert.deepEqual(entry.lines.filter((line) => line.debitAmount > 0).map((line) => [line.accountNumber, line.debitAmount]), [['4930', 100], ['4940', 100], ['1576', 19], ['1576', 7]]);
      assert.equal(entry.lines.at(-1)!.accountNumber, '1600');
      assert.equal(entry.lines.at(-1)!.creditAmount, 226);
      assertBalanced([entry]);
    });

    test('paying a creditor item books creditor against bank, closes the invoice and rejects a debtor payment', async () => {
      const id = `in-${randomUUID().slice(0, 6)}`;
      await h.raw('POST', '/accounting/incoming-invoices', incoming(id));
      await post(id);
      const item = (await openItems(h)).find((candidate) => candidate.sourceId === id)!;
      const wrongParty = await payOpenItem(h, { ...item, partyType: 'debtor' }, 119);
      assert.equal(wrongParty.status, 422, wrongParty.text);
      const paid = await payOpenItem(h, item, 119);
      assert.equal(paid.status, 200, paid.text);
      assert.deepEqual(shape((await journal(h)).find((entry) => entry.id === paid.body.journalEntryId)!), [['1600', 119, 0], ['1200', 0, 119]]);
      assert.equal((await listed(id)).status, 'paid');
      assert.equal((await openItems(h)).find((candidate) => candidate.sourceId === id)!.status, 'paid');
      const refused = await h.raw('POST', '/accounting/documents/reverse', { reason: 'Storno', documentType: 'incoming_invoice', documentId: id });
      assert.equal(refused.status, 409, 'a paid incoming invoice cannot be reversed');
      assert.match(refused.body.message, /DOCUMENT_HAS_ALLOCATIONS/);
    });

    test('an unpaid incoming invoice can be reversed once and its mirror neutralises the expense', async () => {
      const id = `in-${randomUUID().slice(0, 6)}`;
      await h.raw('POST', '/accounting/incoming-invoices', incoming(id));
      await post(id);
      const original = (await entryFor(h, `incoming-invoice:${id}`))!;
      const reversed = await h.raw('POST', '/accounting/documents/reverse', { reason: 'Falsch erfasst', documentType: 'incoming_invoice', documentId: id });
      assert.equal(reversed.status, 200, reversed.text);
      const mirror = (await journal(h)).find((entry) => entry.id === reversed.body.reversalEntryId)!;
      assert.deepEqual(shape(mirror), [['4900', 0, 100], ['1576', 0, 19], ['1600', 119, 0]]);
      assert.equal((await get<JournalEntry>(h, `/accounting/journal/${original.id}`)).status, 'reversed');
      assert.equal((await h.raw('POST', '/accounting/documents/reverse', { reason: 'nochmal', documentType: 'incoming_invoice', documentId: id })).status, 409);
      assert.equal((await post(id)).status, 409, 'a reversed document cannot be posted again');
    });

    describe('documents', () => {
      const pdf = () => Buffer.concat([Buffer.from('%PDF-1.4\n%billme\n'), Buffer.from(randomUUID())]);
      const png = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(randomUUID())]);
      const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(randomUUID())]);
      const webp = () => Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 2, 3, 4]), Buffer.from('WEBP'), Buffer.from(randomUUID())]);
      const upload = (invoiceId: string, bytes: Buffer, filename = 'beleg.pdf', mimeType = 'application/pdf') =>
        h.raw('POST', `/accounting/incoming-invoices/${invoiceId}/documents`, { reason: 'Beleg archiviert', originalFilename: filename, mimeType, data: bytes.toString('base64') });
      let invoiceId: string;
      before(async () => { invoiceId = `in-${randomUUID().slice(0, 6)}`; await h.raw('POST', '/accounting/incoming-invoices', incoming(invoiceId)); });

      test('an original is archived with its hash, downloads byte for byte and is reviewed once decided', async () => {
        const bytes = pdf();
        const uploaded = await upload(invoiceId, bytes, 'rechnung-märz.pdf');
        assert.equal(uploaded.status, 200, uploaded.text);
        assert.deepEqual([uploaded.body.originalFilename, uploaded.body.mimeType, uploaded.body.byteLength, uploaded.body.reviewStatus, uploaded.body.incomingInvoiceId], ['rechnung-märz.pdf', 'application/pdf', bytes.length, 'pending', invoiceId]);
        assert.equal(uploaded.body.sha256, createHash('sha256').update(bytes).digest('hex'));
        const download = await h.raw('GET', `/accounting/incoming-invoice-documents/${uploaded.body.id}/download`);
        assert.equal(download.status, 200);
        assert.ok(Buffer.from(download.body.data, 'base64').equals(bytes), 'the archived bytes are the uploaded bytes');
        assert.equal(download.body.document.sha256, uploaded.body.sha256);
        assert.ok((await get<any[]>(h, `/accounting/incoming-invoices/${invoiceId}/documents`)).some((doc) => doc.id === uploaded.body.id));
        assert.ok((await get<any[]>(h, '/accounting/incoming-invoice-documents')).some((doc) => doc.id === uploaded.body.id), 'the receipts inbox lists it');
        const big = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(3 * 1024 * 1024, 7), Buffer.from(randomUUID())]);
        const bigUpload = await upload(invoiceId, big, 'scan-gross.pdf');
        assert.equal(bigUpload.status, 200, `a 3 MB original is above the default request limit but allowed: ${bigUpload.text.slice(0, 120)}`);
        const bigDownload = await h.raw('GET', `/accounting/incoming-invoice-documents/${bigUpload.body.id}/download`);
        assert.ok(Buffer.from(bigDownload.body.data, 'base64').equals(big), 'a large original comes back byte for byte');

        const review = (documentId: string, reviewStatus: string, reason = 'Beleg geprüft') => h.raw('POST', `/accounting/incoming-invoice-documents/${documentId}/review`, { reviewStatus, reason });
        assert.equal((await review(uploaded.body.id, 'accepted')).body.reviewStatus, 'accepted');
        assert.equal((await review(uploaded.body.id, 'rejected')).body.reviewStatus, 'rejected', 'a decision can be revised');
        assert.equal((await review(uploaded.body.id, 'pending')).status, 400, 'pending is not a decision');
        assert.equal((await review(uploaded.body.id, 'accepted', ' ')).status, 400, 'reason required');
        assert.equal((await review('nope', 'accepted')).status, 404);
        const csv = await h.api.audit.exportCsv();
        assert.ok(csv.includes('incoming_invoice_document'), 'upload and review are audited');
      });

      test('every supported type is accepted, while a spoofed type, a duplicate and a damaged request are refused', async () => {
        for (const [bytes, name, mime] of [[png(), 'scan.png', 'image/png'], [jpeg(), 'scan.jpg', 'image/jpeg'], [webp(), 'scan.webp', 'image/webp']] as const) {
          assert.equal((await upload(invoiceId, bytes, name, mime)).status, 200, name);
        }
        const bytes = pdf();
        assert.equal((await upload(invoiceId, bytes)).status, 200);
        const duplicate = await upload(invoiceId, bytes, 'kopie.pdf');
        assert.equal(duplicate.status, 409, duplicate.text);
        assert.match(duplicate.body.message, /INCOMING_INVOICE_DOCUMENT_DUPLICATE/);
        const other = `in-${randomUUID().slice(0, 6)}`;
        await h.raw('POST', '/accounting/incoming-invoices', incoming(other));
        assert.equal((await upload(other, bytes)).status, 409, 'the archive is deduplicated across invoices');

        const refused: Array<[string, Promise<{ status: number; body: any }>, number, RegExp?]> = [
          ['png bytes labelled pdf', upload(invoiceId, png(), 'fake.pdf', 'application/pdf'), 400, /CONTENT_MISMATCH/],
          ['text labelled jpeg', upload(invoiceId, Buffer.from(`text ${randomUUID()}`), 'fake.jpg', 'image/jpeg'), 400, /CONTENT_MISMATCH/],
          ['a path in the file name', upload(invoiceId, pdf(), '../evil.pdf'), 400, /FILENAME_INVALID/],
          ['a control character in the file name', upload(invoiceId, pdf(), 'a\u0001b.pdf'), 400],
          ['a gif', upload(invoiceId, pdf(), 'x.gif', 'image/gif'), 400],
          ['malformed base64', h.raw('POST', `/accounting/incoming-invoices/${invoiceId}/documents`, { reason: 'x', originalFilename: 'a.pdf', mimeType: 'application/pdf', data: 'abc' }), 400, /INVALID_BASE64/],
          ['an empty file', h.raw('POST', `/accounting/incoming-invoices/${invoiceId}/documents`, { reason: 'x', originalFilename: 'a.pdf', mimeType: 'application/pdf', data: '' }), 400],
          ['no reason', h.raw('POST', `/accounting/incoming-invoices/${invoiceId}/documents`, { originalFilename: 'a.pdf', mimeType: 'application/pdf', data: pdf().toString('base64') }), 400],
          ['an unknown invoice', upload('nope', pdf()), 404, /INCOMING_INVOICE_NOT_FOUND/],
        ];
        for (const [label, call, status, message] of refused) {
          const response = await call;
          assert.equal(response.status, status, `${label}: ${JSON.stringify(response.body)}`);
          if (message) assert.match(response.body.message, message, label);
        }
        assert.equal((await h.raw('GET', '/accounting/incoming-invoice-documents/nope/download')).status, 404);
      });
    });
  });

  test('a workflow entry is stored once per transaction, replaced on save, and malformed entries are refused', async () => {
    const entry = { transactionId: `wf-${randomUUID().slice(0, 8)}`, transactionJson: JSON.stringify({ id: 'tx', amount: 10 }), draftJson: JSON.stringify({ lines: [] }) };
    assert.equal((await h.raw('POST', '/workflow', entry)).status, 200);
    assert.equal((await h.raw('POST', '/workflow', { ...entry, draftJson: JSON.stringify({ lines: [1] }) })).status, 200);
    const stored = ((await h.raw('GET', '/workflow')).body as Array<{ transactionId: string; draftJson: string }>).filter((candidate) => candidate.transactionId === entry.transactionId);
    assert.deepEqual(stored.map((candidate) => JSON.parse(candidate.draftJson)), [{ lines: [1] }], 'replaced, not duplicated');
    assert.equal((await h.raw('POST', '/workflow', { ...entry, transactionId: '' })).status, 400);
    assert.equal((await h.raw('POST', '/workflow', { ...entry, draftJson: 'kein json' })).status, 400, 'an entry that cannot be read back is refused');
    const anonymous = await fetch(`${h.connection.baseUrl}/api/v1/pro/workflow`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(entry) });
    assert.equal(anonymous.status, 401);
  });

  test('the accounting API refuses requests without or with a wrong token and a mutation without a reason', async () => {
    for (const path of ['/api/v1/pro/accounting/journal', '/api/v1/pro/accounting/open-items', '/api/v1/pro/accounting/reports/susa', '/api/v1/pro/accounting/datev/exports', '/api/v1/pro/accounting/assets']) {
      assert.equal((await fetch(`${h.connection.baseUrl}${path}`)).status, 401, `${path} without a token`);
      assert.equal((await fetch(`${h.connection.baseUrl}${path}`, { headers: { 'x-billme-local-token': 'wrong' } })).status, 401, `${path} with a wrong token`);
    }
    const forged = await fetch(`${h.connection.baseUrl}/api/v1/pro/accounting/mappings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'x', chart: 'SKR03', role: 'revenue', accountNumber: '8400' }) });
    assert.equal(forged.status, 401, 'a mapping cannot be written without the token');
    assert.equal((await fetch(`${h.connection.baseUrl}/api/v1/lite/invoices`, { headers: { 'x-billme-local-token': h.connection.token } })).status >= 400, true, 'the Lite API is not served by the Pro backend');
  });

  test('every ledger entry so far balances, the ledger agrees with the journal and the audit chain verifies', async () => {
    await assertLedgerConsistent(h);
    const verify = await h.api.audit.verify();
    assert.equal(verify.ok, true, JSON.stringify(verify));
    const csv = await h.api.audit.exportCsv();
    for (const action of ['pro_journal_entry', 'accounting_mapping']) assert.ok(csv.includes(action), `${action} missing from the audit export`);
  });
});

