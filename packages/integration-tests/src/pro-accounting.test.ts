import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { startPro, type ProHarness } from './harness.js';
import { addDays, asSmallBusiness, draftOffer, today } from './fixtures.js';
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
 * - Kontenplan: an own account without name, with a bad number or without a
 *   reason accepted; an own account that cannot be booked or is not listed; a
 *   deactivated account (own or DATEV) that still takes postings, or whose old
 *   entry can no longer be reversed; a role account deactivated (every invoice
 *   would fail); a change that is not audited
 * - issuing posts: an entry that does not balance, the wrong accounts or
 *   direction, VAT lumped together across rates, 7 % VAT on the 19 % account,
 *   a tax case without its evidence (Kleinunternehmer, §13b, EU supply), a
 *   second posting when an issued invoice is saved again, a draft posted
 *   straight into the ledger
 * - revenue per tax case: 7 %, Kleinunternehmer, §13b, EU supply, EU service,
 *   export, §4-exempt and non-taxable (Drittland) sales all booked as "Erlöse
 *   19 %" (8400), a tenant mapping for such an account ignored, a non-taxable
 *   Drittland service booked as a reverse-charge purchase (NON_EU_SERVICE_RC),
 *   a foreign rate (20 %) booked as German 19 % VAT, 1-cent rounding between
 *   line VAT and invoice VAT failing the posting
 * - atomicity: a posting that fails after the invoice was already issued
 *   (half-issued: number gone, no entry), a lost number after the failure, a
 *   half-written audit trail
 * - corrections: a cancellation that does not mirror the original, a credit
 *   note that posts a different amount than the document, a source cancelled
 *   twice (the revenue reversed twice), an open item left open
 * - document reversal: reversing a document that has payments, reversing it
 *   twice, a journal reversal that bypasses the document owner, a reversal
 *   that loses the document reference of the original (DATEV Belegfeld)
 * - manual booking: an unbalanced / one-sided / zero / sub-cent entry, an
 *   unknown or missing account, a bad date or a period that does not match it,
 *   a draft approved or posted by the client, floating point false alarms on
 *   cents, posting the same draft twice, an entry that can be edited after
 *   posting, a reversal that does not neutralise every line, reversing twice
 * - bank drafts: a draft whose bank line does not carry the bank amount, books
 *   another ledger account than the bank account's, or the wrong side; a draft
 *   for a bank line that does not exist (a journal entry without a source); a
 *   payment for an open invoice drafted on revenue (counted twice) or booked as a
 *   free draft on 1400 (ledger paid, open item still open)
 * - booking a bank line again after its Storno: refused (the person is left
 *   with a free entry), the original or its Storno touched, the new posting
 *   reusing the old entry, a retry that books it twice, the bank line left
 *   "gebucht" while nothing live is booked on it
 * - a Beleg on a bank line: no way to attach one, a file stored changed or twice,
 *   a wrong type or no reason accepted, the line still "ohne Beleg", the posting
 *   without a reference to the Beleg
 * - exceptions (Ausnahmen): an owner, pause or resolution that is not kept on
 *   the draft (gone after a reload or the next save of the draft), changed
 *   without a reason or without audit, accepted for a bank line that is not there
 * - free entries (Buchungssatz): an entry without Belegnummer, Belegdatum or
 *   Buchungstext, a text DATEV refuses (> 60), an unbalanced, one-sided or
 *   unknown-account entry posted anyway, a tax key the entry cannot split
 *   accepted, a Steuerschlüssel without its VAT line or with 7 % on the 19 %
 *   account, a retry that books twice, an entry that cannot be reversed,
 *   Privatentnahme/-einlage on accounts the chart does not have
 * - bank reconciliation: a ledger account that drifts from its bank lines
 *   without showing it, pending lines counted as booked
 * - OPOS: a payment allocated beyond the open balance or beyond the payment
 *   itself, to the wrong party, to an item that is not there, a retry that
 *   books twice, an overpayment that disappears, a bank line booked twice,
 *   the invoice status not following the open item; a booked payment listed
 *   without the invoice number and customer it settled (OPOS "Gebuchte Zahlungen")
 * - Skonto: a payment within the Skonto days less the Skonto leaving the rest
 *   open, the Skonto booked against revenue instead of gewährte Skonti or
 *   without its VAT, a Skonto for a late or short payment, a Skonto that stays
 *   when its payment is reversed, a Skonto typed by hand
 * - advance invoices: the advance booked as revenue, its VAT due on issue under
 *   Soll although §13 Abs. 1 Nr. 1a S. 4 makes it due with the payment, the
 *   advance never released at the final invoice (revenue short or 1718 left
 *   standing), a Storno of the advance booking other accounts than the advance
 * - bank accounts: a deletion audited under a service name instead of the person;
 *   a bank account saved on a ledger account that is no money account (0005, an
 *   expense account), a blank ledger account stored instead of the bank role, a
 *   changed ledger account that leaves the open drafts on the old one
 * - bank workbench: an import that double-books, a rolled-back batch that
 *   stays bookable, a suggestion rule that outranks a better one, ignores its
 *   flow/chart/active flag, or is credited for a booking it did not decide; a
 *   rule made after a line was opened that the card shows but the draft ignores,
 *   or that overwrites what a person entered
 * - incoming invoices and receipts: a posting with the wrong accounts or
 *   balance, the vendor's default expense account ignored, a second vendor for the
 *   same name, a differing IBAN/USt-IdNr. of that name dropped silently, an incoming invoice released with an account the chart does not know, Bewirtung booked
 *   100 % deductible (no 70/30 split), 7 % input VAT on the
 *   19 % account (1576 instead of 1571), amounts that do not add up posted anyway, a posted document or its
 *   vendor edited afterwards, an archived original that changes, a spoofed file
 *   type, a duplicate or a path in the file name accepted; a 0 % purchase
 *   refused for missing evidence, a § 13b or EU purchase that cannot be posted
 *   or posts without the self-assessed USt and Vorsteuer (1577/1787, ig. Erwerb
 *   1574/1774 and 1572/1772), the supplier owed the self-assessed tax, a
 *   self-assessed purchase posted without its evidence, with billed VAT or with
 *   a sales-only tax case
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

    test('Kontenplan: an own account is created, listed and booked; deactivated it takes no postings, its old entry still reverses', async () => {
      const save = (chart: string, number: string, body: Record<string, unknown>) => h.raw('PUT', `/accounting/ledger/accounts/${chart}/${number}`, body);
      const book = (account: string) => h.raw('POST', '/accounting/journal', { reason: 'Kontenplan', reference: `KP-${account}`, documentDate: today(), postingDate: today(), bookingText: `Kontenplan ${account}`, idempotencyKey: randomUUID(), lines: [{ accountNumber: account, debitAmount: 10, creditAmount: 0 }, { accountNumber: '1000', debitAmount: 0, creditAmount: 10 }] });
      assert.equal((await save('SKR03', '4997', { active: true, reason: 'eigenes Konto' })).status, 400, 'an own account needs a name');
      assert.equal((await save('SKR03', '4997', { name: 'x'.repeat(41), active: true, reason: 'eigenes Konto' })).status, 400, 'at most 40 characters (DATEV)');
      assert.equal((await save('SKR03', '4997', { name: 'Fortbildung Team', active: true })).status, 400, 'a reason is required');
      assert.equal((await save('SKR03', '49a9', { name: 'Fortbildung Team', active: true, reason: 'x' })).status, 400, 'digits only');
      assert.equal((await save('SKR05', '4997', { name: 'Fortbildung Team', active: true, reason: 'x' })).status, 400, 'a known chart');
      assert.equal((await book('4997')).status >= 400, true, 'before it exists 4997 cannot be booked');

      const created = await save('SKR03', '4997', { name: 'Fortbildung Team', active: true, reason: 'eigenes Konto' });
      assert.equal(created.status, 200, created.text);
      assert.deepEqual([created.body.accountNumber, created.body.name, created.body.source, created.body.active], ['4997', 'Fortbildung Team', 'tenant', true]);
      const listed = await get<Array<{ accountNumber: string; name: string; source: string; active?: boolean }>>(h, '/accounting/ledger/accounts?chart=SKR03&search=Fortbildung&limit=50');
      assert.deepEqual(listed.filter((row) => row.accountNumber === '4997').map((row) => [row.name, row.source, row.active]), [['Fortbildung Team', 'tenant', true]]);
      const booked = await book('4997');
      assert.equal(booked.status, 200, booked.text);

      assert.equal((await save('SKR03', '4997', { active: false, reason: 'nicht mehr gebraucht' })).status, 200);
      const refused = await book('4997');
      assert.ok(refused.status >= 400 && refused.status < 500, `a deactivated own account takes no posting (${refused.status})`);
      const reversed = await h.raw('POST', `/accounting/journal/${booked.body.id}/reverse`, { reason: 'Konto aufgelöst' });
      assert.equal(reversed.status, 200, `the old entry still reverses: ${reversed.text}`);

      assert.equal((await save('SKR03', '4930', { active: false, reason: 'Bürobedarf nicht genutzt' })).status, 200, 'a DATEV account can be deactivated');
      try {
        assert.equal((await book('4930')).status >= 400, true, 'a deactivated DATEV account takes no posting');
        const standard = await get<Array<{ accountNumber: string; name: string; active?: boolean }>>(h, '/accounting/ledger/accounts?chart=SKR03&search=4930&limit=20');
        assert.deepEqual(standard.filter((row) => row.accountNumber === '4930').map((row) => [row.name, row.active]), [['Bürobedarf', false]], 'it keeps its DATEV name');
      } finally {
        assert.equal((await save('SKR03', '4930', { name: 'Umbenannt', active: true, reason: 'wieder aktiv' })).status, 200);
      }
      assert.equal((await book('4930')).status, 200, 'active again');
      assert.equal((await get<Array<{ accountNumber: string; name: string }>>(h, '/accounting/ledger/accounts?chart=SKR03&search=4930&limit=20')).find((row) => row.accountNumber === '4930')?.name, 'Bürobedarf', 'a DATEV account is never renamed');

      const inUse = await save('SKR03', '1776', { active: false, reason: 'weg damit' });
      assert.equal(inUse.status, 409, `a role account cannot be deactivated: ${inUse.text}`);
      assert.match(inUse.body.message, /ACCOUNT_IN_USE/);
      assert.ok((await h.api.audit.exportCsv()).includes('nicht mehr gebraucht'), 'the change is audited with its reason');
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
      const revenue = entry.lines.filter((line) => line.taxCaseKey);
      assert.deepEqual(revenue.map((line) => [line.accountNumber, line.taxCaseKey, line.netAmount, line.taxAmount, line.grossAmount]), [['8400', 'DE_STD_19', 100, 19, 119], ['8300', 'DE_STD_7', 50, 3.5, 53.5]], 'each rate on its own revenue account');
      assert.deepEqual(entry.lines.filter((line) => line.memo?.startsWith('USt ')).map((line) => [line.memo, line.creditAmount]), [['USt DE_STD_19', 19], ['USt DE_STD_7', 3.5]]);
      assertBalanced([entry]);
    });

    test('7 % revenue and output VAT land on the 7 % accounts without any setup', async () => {
      const invoice = await issue(h, { client: 'Sieben Prozent', items: [{ kind: 'item', description: 'Buch', quantity: 1, price: 50, total: 50, taxRate: 7 }] });
      const entry = (await invoiceEntry(h, invoice.id))!;
      assert.deepEqual(shape(entry), [['1400', 53.5, 0], ['8300', 0, 50], ['1771', 0, 3.5]]);
    });

    test('a tax-case account mapping routes 7 % VAT to 1771 and carries the DATEV BU key', async () => {
      const output = await h.raw('POST', '/accounting/tax-case-account-mappings', { reason: 'USt 7 %', chart: 'SKR03', taxCaseKey: 'DE_STD_7', role: 'output_tax', accountNumber: '1771' });
      assert.equal(output.status, 200, output.text);
      const bu = await h.raw('POST', '/accounting/tax-case-account-mappings', { reason: 'BU 2', chart: 'SKR03', taxCaseKey: 'DE_STD_7', role: 'datev_bu', accountNumber: '1771', datevBuKey: '2' });
      assert.equal(bu.status, 200, bu.text);
      assert.equal((await h.raw('POST', '/accounting/tax-case-account-mappings', { reason: 'x', chart: 'SKR03', taxCaseKey: 'DE_STD_7', role: 'vat_magic', accountNumber: '1771' })).status, 400, 'unknown role');
      assert.equal((await h.raw('POST', '/accounting/tax-case-account-mappings', { reason: 'x', chart: 'SKR03', taxCaseKey: 'NOT_A_CASE', role: 'output_tax', accountNumber: '1771' })).status, 400, 'unknown tax case');
      const invoice = await issue(h, { client: 'Sieben konfiguriert', items: [{ kind: 'item', description: 'Buch', quantity: 1, price: 50, total: 50, taxRate: 7 }] });
      assert.deepEqual(shape((await invoiceEntry(h, invoice.id))!), [['1400', 53.5, 0], ['8300', 0, 50], ['1771', 0, 3.5]]);
      const rows = await get<Array<{ konto: string; gegenkonto: string; buSchluessel?: string; umsatz: number }>>(h, '/accounting/datev/rows');
      // 8300 is a DATEV Automatikkonto (AM 7 %): the export carries the gross amount without a BU key, a BU 2 on top
      // would make DATEV compute the tax twice. The configured key applies to revenue accounts without Automatik.
      assert.ok(rows.some((row) => row.gegenkonto === '8300' && !row.buSchluessel && row.umsatz === 53.5), JSON.stringify(rows.filter((row) => row.gegenkonto === '8300')));
      assert.ok(!rows.some((row) => row.gegenkonto === '1771' || row.konto === '1771'), 'no separate VAT row');
    });

    test('Kleinunternehmer and §13b invoices post without VAT lines and keep their evidence; without it issuing is refused', async () => {
      const items = [{ kind: 'item' as const, description: 'Leistung', quantity: 1, price: 100, total: 100, taxRate: 19 }];
      const before = { entries: (await journal(h)).length, items: (await openItems(h)).length };
      // Only a Kleinunternehmer issues under §19.
      let kuEntry!: NonNullable<Awaited<ReturnType<typeof invoiceEntry>>>;
      await asSmallBusiness(h.api, async () => {
        const blocked = await draft(h, { client: 'KU ohne Nachweis', taxMode: 'small_business_19_ustg', items });
        const refused = await h.raw('POST', '/invoices', { reason: 'stellen', invoice: { ...blocked, status: 'open', kind: 'invoice' } });
        assert.equal(refused.status, 400, refused.text);
        assert.match(refused.body.message, /MISSING_TAX_EVIDENCE/);
        assert.equal((await invoiceOf(h, blocked.id)).status, 'draft');
        assert.deepEqual([(await journal(h)).length, (await openItems(h)).length], [before.entries, before.items], 'nothing was posted');

        const ku = await issue(h, { client: 'KU mit Nachweis', taxMode: 'small_business_19_ustg', taxMeta: { datevEvidenceType: 'exemption', datevEvidenceReference: '§19 UStG' }, items });
        kuEntry = (await invoiceEntry(h, ku.id))!;
        assert.deepEqual(shape(kuEntry), [['1400', 100, 0], ['8195', 0, 100]], 'Erlöse als Kleinunternehmer');
        assert.deepEqual([kuEntry.lines[1]!.taxCaseKey, kuEntry.lines[1]!.evidenceType, kuEntry.lines[1]!.evidenceReference], ['DE_KU19', 'exemption', '§19 UStG']);
      });

      const rc = await issue(h, { client: 'RC mit Nachweis', taxMode: 'reverse_charge_13b', taxMeta: { buyerVatId: 'DE123456789', datevEvidenceType: 'reverse_charge', datevEvidenceReference: '13' }, items: [{ kind: 'item', description: 'Bau', quantity: 1, price: 100, total: 100 }] });
      const rcEntry = (await invoiceEntry(h, rc.id))!;
      assert.deepEqual(shape(rcEntry), [['1400', 100, 0], ['8337', 0, 100]], 'Erlöse aus Leistungen nach §13b');
      assert.equal(rcEntry.lines[1]!.taxCaseKey, 'DE_RC_13B_DOMESTIC');
      assertBalanced([kuEntry, rcEntry]);
    });
  });

  describe('revenue and VAT accounts per tax case', () => {
    const item = (price = 100) => [{ kind: 'item' as const, description: 'Leistung', quantity: 1, price, total: price }];
    const revenueOf = async (invoiceId: string) => (await invoiceEntry(h, invoiceId))!.lines.filter((line) => line.creditAmount > 0).map((line) => [line.accountNumber, line.taxCaseKey ?? null, line.creditAmount]);

    test('each tax case books its own revenue account and no VAT line', async () => {
      const cases: Array<[string, Record<string, unknown>, string, string]> = [
        ['intra_eu_service_reverse_charge', { buyerCountryCode: 'AT', buyerVatId: 'ATU12345678', destinationVatRate: 20, datevEvidenceType: 'Rechnung', datevEvidenceReference: 'N-1', datevSachverhaltLl: '1' }, '8336', 'EU_B2B_SERVICE_RC'],
        ['export_third_country', { buyerCountryCode: 'CH', datevEvidenceType: 'ausfuhrnachweis', datevEvidenceReference: 'MRN-1', taxRuleConfirmed: true }, '8120', 'NON_EU_EXPORT_0'],
        ['vat_exempt_4_ustg', { datevEvidenceType: 'Rechnung', datevEvidenceReference: '§4 Nr. 14 UStG', taxRuleConfirmed: true }, '8100', 'DE_ZERO_EXEMPT'],
        ['non_taxable_outside_scope', { buyerCountryCode: 'CH', datevEvidenceType: 'Rechnung', datevEvidenceReference: '§3a Abs. 2 UStG', taxRuleConfirmed: true }, '8338', 'NON_EU_SERVICE_OUTSIDE_SCOPE'],
      ];
      for (const [taxMode, taxMeta, account, taxCaseKey] of cases) {
        const invoice = await issue(h, { client: `Steuerfall ${taxMode}`, taxMode: taxMode as never, taxMeta: taxMeta as never, items: item() });
        assert.deepEqual(await revenueOf(invoice.id), [[account, taxCaseKey, 100]], taxMode);
      }
    });

    test('a non-taxable Drittland service is a sale, never the reverse-charge purchase case', async () => {
      const invoice = await issue(h, { client: 'Drittland Leistung', taxMode: 'non_taxable_outside_scope', taxMeta: { buyerCountryCode: 'US', datevEvidenceType: 'Rechnung', datevEvidenceReference: 'US-1', taxRuleConfirmed: true } as never, items: item() });
      const keys = (await invoiceEntry(h, invoice.id))!.lines.map((line) => line.taxCaseKey).filter(Boolean);
      assert.ok(!keys.includes('NON_EU_SERVICE_RC'), JSON.stringify(keys));
    });

    test('a tenant mapping moves the revenue of one tax case and leaves the others alone', async () => {
      const saved = await map(h, 'revenue_7', '8200');
      assert.equal(saved.status, 200, saved.text);
      try {
        const invoice = await issue(h, { client: 'Sieben gemappt', items: [{ kind: 'item', description: 'Buch', quantity: 1, price: 50, total: 50, taxRate: 7 }, { kind: 'item', description: 'Beratung', quantity: 1, price: 100, total: 100, taxRate: 19 }] });
        assert.deepEqual(await revenueOf(invoice.id), [['8200', 'DE_STD_7', 50], ['1771', null, 3.5], ['8400', 'DE_STD_19', 100], ['1776', null, 19]]);
      } finally {
        assert.equal((await map(h, 'revenue_7', '8300')).status, 200);
      }
    });

    test('a foreign VAT rate is refused instead of being booked as German 19 %', async () => {
      const unposted = await draft(h, { client: 'Zwanzig Prozent', items: [{ kind: 'item', description: 'Leistung', quantity: 1, price: 100, total: 100, taxRate: 20 }] });
      const before = (await journal(h)).length;
      const refused = await h.raw('POST', '/invoices', { reason: 'stellen', invoice: { ...unposted, status: 'open', kind: 'invoice' } });
      assert.equal(refused.status, 422, refused.text);
      assert.match(refused.body.message, /TAX_RATE_UNSUPPORTED/);
      assert.equal((await journal(h)).length, before, 'nothing posted');
      assert.equal((await invoiceOf(h, unposted.id)).status, 'draft');
    });

    test('line VAT that differs from the VAT on the total by a cent still posts a balanced entry', async () => {
      const lines = Array.from({ length: 3 }, (_, index) => ({ kind: 'item' as const, description: `Kleinteil ${index + 1}`, quantity: 1, price: 0.33, total: 0.33, taxRate: 19 }));
      const invoice = await issue(h, { client: 'Rundung', items: lines });
      const entry = (await invoiceEntry(h, invoice.id));
      assert.ok(entry, 'the invoice was posted');
      assertBalanced([entry!]);
      assert.equal(entry!.lines[0]!.debitAmount, invoice.amount, 'the receivable is the invoice amount');
      assert.equal(money(entry!.lines.filter((line) => line.accountNumber === '1776').reduce((sum, line) => sum + line.creditAmount, 0)), money(invoice.amount - 0.99), 'the VAT line takes the cent');
    });
  });

  describe('a failed posting leaves no half-issued invoice', () => {
    const snapshotOfLedger = async () => ({ entries: (await journal(h)).length, items: (await openItems(h)).length, posted: (await posted(h)).postedCount });

    test('an EU supply without country, VAT id and evidence is refused cleanly and the same draft issues once it is complete', async () => {
      const unposted = await draft(h, { client: 'EU Kunde', taxMode: 'intra_eu_supply_6a', items: [{ kind: 'item', description: 'Ware', quantity: 1, price: 200, total: 200 }] });
      const before = await snapshotOfLedger();
      const refused = await h.raw('POST', '/invoices', { reason: 'stellen', invoice: { ...unposted, status: 'open', kind: 'invoice' } });
      // §14a: the issue check refuses before the ledger sees it; the posting rule (MISSING_TAX_COUNTRY) stays behind it.
      assert.equal(refused.status, 422, refused.text);
      assert.match(refused.body.message, /USt-IdNr\. des Kunden fehlt/);
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
      assert.equal(entry.lines.find((line) => line.accountNumber === '8125')!.taxCaseKey, 'EU_IGL_GOODS_0', 'steuerfreie innergemeinschaftliche Lieferung');
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
      assert.equal(entry.bookingText, `Stornorechnung ${cancellation.number} zu ${source.number}`, 'the Storno names the invoice it cancels');
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
      assert.equal(reversal.reference, original.reference, 'the reversal keeps the document reference (invoice number) of the original');
      assert.equal(reversal.reference, source.number);
      assert.equal(reversal.bookingText, `Storno ${original.entryNumber}: Falsch gebucht`, 'the reason is the booking text');
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

    test('a Beleg attached to a bank line is archived unchanged and once, marks the line mit Beleg and is named in the posting', async () => {
      const { tx, draft: d } = await newTx({ date: '2026-03-06', amount: -23.8, counterparty: `Beleg Bank ${randomUUID().slice(0, 6)}` });
      const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(randomUUID())]);
      const upload = (body: Record<string, unknown>, id = tx.id) => h.raw('POST', `/accounting/transactions/${id}/documents`, { originalFilename: 'quittung.pdf', mimeType: 'application/pdf', data: pdf.toString('base64'), reason: 'Quittung nachgereicht', ...body });
      assert.equal((await upload({ reason: ' ' })).status, 400, 'a reason is required');
      assert.equal((await upload({ mimeType: 'application/zip' })).status, 400, 'PDF and images only');
      assert.equal((await upload({ mimeType: 'image/png' })).status, 400, 'the content must match the type');
      assert.equal((await upload({}, 'no-such-line')).status, 404);
      const saved = await upload({});
      assert.equal(saved.status, 200, saved.text);
      assert.deepEqual([saved.body.bankTransactionId, saved.body.originalFilename, saved.body.byteLength, saved.body.sha256], [tx.id, 'quittung.pdf', pdf.byteLength, createHash('sha256').update(pdf).digest('hex')]);
      const retry = await upload({});
      assert.equal(retry.body.id, saved.body.id, 'the same file twice is one Beleg');
      assert.equal((await get<unknown[]>(h, `/accounting/transactions/${tx.id}/documents`)).length, 1);
      const download = await get<{ data: string }>(h, `/accounting/bank-transaction-documents/${saved.body.id}/download`);
      assert.equal(download.data, pdf.toString('base64'), 'archived byte for byte');
      assert.equal((await bankTx(h, tx.counterparty)).receiptDocumentCount, 1, 'the line is mit Beleg');
      const approved = await approveDraft(h, d, lines(d, 23.8));
      const posted = await postDraft(h, approved.id, { postingDate: '2026-03-06' });
      assert.equal(posted.status, 200, posted.text);
      assert.ok(posted.body.entry.lines.every((line: { evidenceReference?: string }) => line.evidenceReference === 'quittung.pdf'), 'every posting line names the Beleg');
      assert.ok((await h.api.audit.exportCsv()).includes('Quittung nachgereicht'), 'the upload is audited');
    });

    test('an exception is assigned, paused and resolved on the draft with a reason; it survives a reload and the next save, and is audited', async () => {
      const { tx, draft: d } = await newTx({ counterparty: `Ausnahme ${randomUUID().slice(0, 6)}` });
      const put = (body: Record<string, unknown>, id = tx.id) => h.raw('PUT', `/accounting/drafts/${id}/exception`, body);
      assert.equal((await put({ patch: { owner: 'Mara' } })).status, 400, 'a reason is required');
      assert.equal((await put({ reason: 'x', patch: { state: 'gone' } })).status, 400, 'a known state only');
      assert.equal((await put({ reason: 'x', patch: { state: 'resolved' } }, 'no-such-line')).status, 404);
      assert.equal((await put({ reason: 'Zuständigkeit geklärt', patch: { owner: 'Mara Buchhaltung' } })).status, 200);
      const until = addDays(today(), 7);
      const snoozed = await put({ reason: 'Beleg kommt nächste Woche', patch: { state: 'snoozed', snoozedUntil: until } });
      assert.equal(snoozed.status, 200, snoozed.text);
      assert.deepEqual(snoozed.body.exceptionCase, { state: 'snoozed', owner: 'Mara Buchhaltung', snoozedUntil: until });
      const resolved = await put({ reason: 'Beleg liegt vor', patch: { state: 'resolved', resolutionNote: 'Rechnung per Mail erhalten' } });
      assert.equal(resolved.status, 200, resolved.text);
      assert.deepEqual((await getDraft(h, tx.id)).exceptionCase, { state: 'resolved', owner: 'Mara Buchhaltung', snoozedUntil: until, resolutionNote: 'Rechnung per Mail erhalten' }, 'kept after a reload');
      assert.equal((await saveDraft(h, d, lines(d, 119))).status, 200);
      assert.equal((await getDraft(h, tx.id)).exceptionCase?.state, 'resolved', 'a later save of the Kontierung keeps the exception');
      assert.ok((await h.api.audit.exportCsv()).includes('Beleg liegt vor'), 'the change is audited with its reason');
    });

    test('after a Storno the same bank line is kontiert and booked again; original and Storno stay, a retry books once', async () => {
      const { tx, draft: d } = await newTx({ date: '2026-03-04', amount: -59.5, counterparty: `Neu buchen ${randomUUID().slice(0, 6)}` });
      const wrong = await approveDraft(h, d, lines(d, 59.5, 59.5, { debitAccount: '4920' }));
      const first = await postDraft(h, wrong.id, { postingDate: '2026-03-04' });
      assert.equal(first.status, 200, first.text);
      const original = first.body.entry;
      const storno = await h.raw('POST', `/accounting/journal/${original.id}/reverse`, { reason: 'Falsches Konto' });
      assert.equal(storno.status, 200, storno.text);
      assert.equal((await getDraft(h, tx.id)).workflowStatus, 'reversed');
      assert.equal((await bankTx(h, tx.counterparty)).status, 'pending', 'nothing live is booked on the line any more');

      const reopened = await draftAction(h, tx.id, 'create_correction', 'Neu kontieren');
      assert.equal(reopened.status, 200, reopened.text);
      assert.equal(reopened.body.workflowStatus, 'corrected');
      const again = await approveDraft(h, reopened.body, lines(d, 59.5, 59.5, { debitAccount: '4930' }));
      const second = await postDraft(h, again.id, { postingDate: '2026-03-05' });
      assert.equal(second.status, 200, second.text);
      assert.notEqual(second.body.entry.id, original.id, 'a new entry, not the reversed one');
      assert.deepEqual(shape(second.body.entry), [['4930', 59.5, 0], ['1200', 0, 59.5]]);
      const replay = await postDraft(h, again.id, { postingDate: '2026-03-05' });
      assert.equal(replay.body.entry.id, second.body.entry.id, 'a retry returns the same posting');
      const mine = (await journal(h)).filter((entry) => entry.id === original.id || entry.id === second.body.entry.id || entry.sourceKey === `reversal:${original.id}`);
      assert.deepEqual(mine.map((entry) => entry.status).sort(), ['posted', 'posted', 'reversed'], 'original (storniert), its Storno and the new posting');
      assert.deepEqual(shape((await get<JournalEntry>(h, `/accounting/journal/${original.id}`))), [['4920', 59.5, 0], ['1200', 0, 59.5]], 'the original is unchanged');
      assert.equal((await bankTx(h, tx.counterparty)).status, 'booked');
      await assertLedgerConsistent(h);
    });

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
      assert.deepEqual([reversal.postingDate, reversal.period, reversal.reference, reversal.sourceType], ['2026-04-15', '2026-04', original.reference, 'reversal']);
      assert.equal(reversal.bookingText, `Storno ${original.entryNumber}: Falsch kontiert`);
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
      assert.equal((await h.raw('POST', '/accounting/journal', { reason: 'Buchungssatz', postingDate: '2026-03-07', lines: [] })).status, 400, 'a free entry is validated, never an empty insert');
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

    const bankIssue = (body: any) => body.validationIssues.find((issue: any) => issue.code === 'BANK_LINE_MISMATCH');
    test('a bank draft must book the bank amount on the bank account, on the side the money moved', async () => {
      const { tx, draft: d } = await newTx({ date: '2026-03-11' });
      const cases: Array<[string, Draft['lines']]> = [
        ['another amount than the bank line', lines(d, 100)],
        ['another ledger account than the bank account', lines(d, 119, 119, { creditAccount: '1000' })],
        ['the bank on the wrong side', [{ id: `${d.id}-1`, accountNumber: '1200', debitAmount: 119, creditAmount: 0 }, { id: `${d.id}-2`, accountNumber: '4930', debitAmount: 0, creditAmount: 119 }]],
      ];
      for (const [label, wrong] of cases) {
        const saved = await saveDraft(h, d, wrong);
        assert.equal(saved.status, 200, saved.text);
        assert.ok(bankIssue(saved.body)?.blocking, `${label}: ${saved.text}`);
        assert.match(bankIssue(saved.body).message, /1200/, 'the issue names the bank account');
        assert.equal((await draftAction(h, tx.id, 'submit_for_review')).body.workflowStatus, 'incomplete', label);
      }
      const entries = (await journal(h)).length;
      assert.equal((await postDraft(h, d.id, { postingDate: '2026-03-11' })).body.entry.id, '', 'nothing is posted');
      assert.equal((await journal(h)).length, entries);
      const fixed = await saveDraft(h, d, lines(d, 119));
      assert.deepEqual(fixed.body.validationIssues, []);
    });

    test('a bank account with its own ledger account is booked there, not on the bank role', async () => {
      const own = await addBankAccount(h, 'bank-manual-1240', '1240');
      const counterparty = `Eigenes Konto ${randomUUID().slice(0, 6)}`;
      await importCsv(h, own, [{ date: '2026-03-12', amount: -119, counterparty, purpose: 'Eingangsrechnung' }]);
      const tx = await bankTx(h, counterparty);
      const d = await getDraft(h, tx.id);
      assert.equal(d.lines.find((line) => line.creditAmount === 119)?.accountNumber, '1240', 'the default draft books the money on the bank account\'s own ledger account');
      assert.equal(bankIssue(d), undefined, 'the default draft is not blocked as a bank mismatch');
      assert.ok(bankIssue((await saveDraft(h, d, lines(d, 119))).body)?.blocking, 'the bank role 1200 is not this bank account');
      await approveDraft(h, d, lines(d, 119, 119, { creditAccount: '1240' }));
      const posted = await postDraft(h, d.id, { postingDate: '2026-03-12' });
      assert.deepEqual(shape(posted.body.entry), [['4930', 119, 0], ['1240', 0, 119]]);
    });

    test('a draft for a bank line that does not exist is refused: that is a free entry with a Beleg', async () => {
      const entries = (await journal(h)).length;
      const ghost = { id: 'draft-ghost', tenantId: 'billme-local-tenant', transactionId: 'no-such-bank-line', workflowStatus: 'suggested', postingDate: '2026-03-12', documentDate: '2026-03-12', bookingText: 'ohne Bankzeile', period: '2026-03', fiscalYear: 2026, validationIssues: [], updatedAt: '2026-03-12T00:00:00.000Z' } as unknown as Draft;
      const saved = await saveDraft(h, ghost, [{ id: 'ghost-1', accountNumber: '4930', debitAmount: 50, creditAmount: 0 }, { id: 'ghost-2', accountNumber: '1200', debitAmount: 0, creditAmount: 50 }]);
      assert.equal(saved.status, 404, saved.text);
      assert.equal((await h.raw('POST', '/accounting/drafts/draft-ghost/post', { reason: 'Buchen' })).status, 404, 'there is no draft to post');
      assert.equal((await journal(h)).length, entries);
    });
  });

  describe('free entries (Buchungssatz) and the bank reconciliation', () => {
    type FreeLine = { accountNumber: string; debitAmount: number; creditAmount: number; taxCaseKey?: string };
    const freeEntry = (lines: FreeLine[], extra: Record<string, unknown> = {}) => h.raw('POST', '/accounting/journal', {
      reason: 'Buchungssatz', documentDate: '2026-03-10', reference: `B-${randomUUID().slice(0, 6)}`, bookingText: 'Umbuchung', idempotencyKey: randomUUID(), lines, ...extra,
    });
    const vat19 = async () => (await get<{ rows: Array<{ taxCaseKey: string; netAmount: number; taxAmount: number }> }>(h, '/accounting/vat/summary')).rows.find((row) => row.taxCaseKey === 'DE_STD_19') ?? { netAmount: 0, taxAmount: 0 };

    test('a split entry with a Steuerschlüssel posts net, VAT line and Privatentnahme, once per key, and is reversible once', async () => {
      const vatBefore = await vat19();
      const key = randomUUID();
      const body = { idempotencyKey: key, reference: 'KB-2026-031', documentDate: '2026-03-09', postingDate: '2026-03-10', bookingText: 'Barkauf Büro und Privatanteil' };
      const lines: FreeLine[] = [
        { accountNumber: '4930', debitAmount: 119, creditAmount: 0, taxCaseKey: 'DE_STD_19' },
        { accountNumber: '1800', debitAmount: 30, creditAmount: 0 },
        { accountNumber: '1000', debitAmount: 0, creditAmount: 149 },
      ];
      const response = await freeEntry(lines, body);
      assert.equal(response.status, 200, response.text);
      const entry: JournalEntry = response.body;
      assert.deepEqual(shape(entry), [['4930', 100, 0], ['1576', 19, 0], ['1800', 30, 0], ['1000', 0, 149]]);
      assert.deepEqual([entry.sourceType, entry.reference, entry.documentDate, entry.postingDate, entry.bookingText], ['manual', 'KB-2026-031', '2026-03-09', '2026-03-10', 'Barkauf Büro und Privatanteil']);
      assert.deepEqual([entry.lines[0]!.taxCaseKey, entry.lines[0]!.netAmount, entry.lines[0]!.taxAmount, entry.lines[0]!.grossAmount], ['DE_STD_19', 100, 19, 119]);
      const vatAfter = await vat19();
      assert.deepEqual([money(vatAfter.netAmount - vatBefore.netAmount), money(vatAfter.taxAmount - vatBefore.taxAmount)], [100, 19]);
      assertBalanced([entry]);

      const entries = (await journal(h)).length;
      const again = await freeEntry(lines, body);
      assert.equal(again.body.id, entry.id, 'the same key returns the same entry');
      assert.equal((await journal(h)).length, entries);

      const reversed = await h.raw('POST', `/accounting/journal/${entry.id}/reverse`, { reason: 'falsch erfasst', postingDate: '2026-03-20' });
      assert.equal(reversed.status, 200, reversed.text);
      assert.equal((await h.raw('POST', `/accounting/journal/${entry.id}/reverse`, { reason: 'nochmal' })).status, 409);
      const vatReversed = await vat19();
      assert.deepEqual([money(vatReversed.netAmount), money(vatReversed.taxAmount)], [money(vatAfter.netAmount - 100), money(vatAfter.taxAmount - 19)], 'the reversal neutralises the tax basis');
      await assertLedgerConsistent(h);
    });

    test('7 % input VAT lands on the 7 % account, a Privateinlage on 1890', async () => {
      const response = await freeEntry([
        { accountNumber: '4930', debitAmount: 107, creditAmount: 0, taxCaseKey: 'DE_STD_7' },
        { accountNumber: '1890', debitAmount: 0, creditAmount: 107 },
      ], { bookingText: 'Fachbuch privat bezahlt' });
      assert.equal(response.status, 200, response.text);
      assert.deepEqual(shape(response.body), [['4930', 100, 0], ['1571', 7, 0], ['1890', 0, 107]]);
    });

    test('a free entry needs Beleg, text, balance, known accounts and a key the entry can split; refused ones post nothing', async () => {
      const ok: FreeLine[] = [{ accountNumber: '4930', debitAmount: 50, creditAmount: 0 }, { accountNumber: '1000', debitAmount: 0, creditAmount: 50 }];
      const entries = (await journal(h)).length;
      const cases: Array<[string, Promise<{ status: number; text: string }>, number]> = [
        ['no Belegnummer', freeEntry(ok, { reference: '  ' }), 400],
        ['no Belegdatum', freeEntry(ok, { documentDate: undefined }), 400],
        ['an impossible date', freeEntry(ok, { documentDate: '2026-02-30' }), 400],
        ['no Buchungstext', freeEntry(ok, { bookingText: ' ' }), 400],
        ['a text DATEV refuses', freeEntry(ok, { bookingText: 'x'.repeat(61) }), 400],
        ['no reason', freeEntry(ok, { reason: ' ' }), 400],
        ['no idempotency key', freeEntry(ok, { idempotencyKey: undefined }), 400],
        ['one line', freeEntry([ok[0]!]), 400],
        ['unbalanced', freeEntry([ok[0]!, { ...ok[1]!, creditAmount: 49.99 }]), 422],
        ['debit and credit on one line', freeEntry([{ ...ok[0]!, creditAmount: 50 }, ok[1]!]), 422],
        ['a fraction of a cent', freeEntry([{ ...ok[0]!, debitAmount: 50.001 }, ok[1]!]), 422],
        ['an account the chart does not have', freeEntry([{ ...ok[0]!, accountNumber: '99999' }, ok[1]!]), 422],
        ['a reverse-charge key it cannot split', freeEntry([{ ...ok[0]!, taxCaseKey: 'DE_RC_13B_DOMESTIC' }, ok[1]!]), 422],
        ['an unknown key', freeEntry([{ ...ok[0]!, taxCaseKey: 'DE_FANTASY' }, ok[1]!]), 400],
      ];
      for (const [label, request, status] of cases) {
        const response = await request;
        assert.equal(response.status, status, `${label}: ${response.text}`);
      }
      assert.equal((await journal(h)).length, entries, 'nothing was posted');
    });

    test('the bank reconciliation compares booked bank lines with the ledger account and shows the drift', async () => {
      const own = await addBankAccount(h, 'bank-reconcile-1250', '1250');
      const counterparty = `Abgleich ${randomUUID().slice(0, 6)}`;
      await importCsv(h, own, [
        { date: '2026-03-13', amount: -119, counterparty, purpose: 'Eingangsrechnung' },
        { date: '2026-03-14', amount: 500, counterparty: `${counterparty} Eingang`, purpose: 'Zahlung' },
      ]);
      const row = async () => (await get<Array<{ ledgerAccountNumber: string; bankAccountIds: string[]; bookedBankTotal: number; pendingCount: number; pendingTotal: number; ledgerBalance: number; difference: number }>>(h, '/accounting/bank-reconciliation'))
        .find((candidate) => candidate.ledgerAccountNumber === '1250')!;
      assert.deepEqual(await row(), { ledgerAccountNumber: '1250', bankAccountIds: [own], bookedBankTotal: 0, pendingCount: 2, pendingTotal: 381, ledgerBalance: 0, difference: 0 });
      const tx = await bankTx(h, counterparty);
      const d = await getDraft(h, tx.id);
      await approveDraft(h, d, [{ id: `${d.id}-1`, accountNumber: '4930', debitAmount: 119, creditAmount: 0 }, { id: `${d.id}-2`, accountNumber: '1250', debitAmount: 0, creditAmount: 119 }]);
      assert.equal((await postDraft(h, d.id, { postingDate: '2026-03-13' })).status, 200);
      assert.deepEqual(await row(), { ledgerAccountNumber: '1250', bankAccountIds: [own], bookedBankTotal: -119, pendingCount: 1, pendingTotal: 500, ledgerBalance: -119, difference: 0 });
      // A Privateinlage booked on the bank account without a bank line: the ledger and the statement disagree.
      assert.equal((await freeEntry([{ accountNumber: '1250', debitAmount: 50, creditAmount: 0 }, { accountNumber: '1890', debitAmount: 0, creditAmount: 50 }])).status, 200);
      assert.deepEqual(await row(), { ledgerAccountNumber: '1250', bankAccountIds: [own], bookedBankTotal: -119, pendingCount: 1, pendingTotal: 500, ledgerBalance: -69, difference: 50 });
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

    const invoicePayment = (invoiceId: string, payment: Record<string, unknown>, reason = 'Zahlung erfasst') =>
      h.raw('POST', `/invoices/${invoiceId}/payments`, { reason, payment: { id: randomUUID(), date: today(), method: 'Überweisung', ...payment } });

    test('a payment recorded on a Pro invoice settles its open item and books bank against receivable in the same step', async () => {
      const invoice = await issue(h, { client: 'Rechnungszahlung' });
      const entries = (await journal(h)).length;
      const response = await invoicePayment(invoice.id, { amount: GROSS });
      assert.equal(response.status, 200, response.text);
      assert.equal(response.body.status, 'paid', 'the response carries the settled status');
      const paymentId = response.body.payments[0].id;
      assert.deepEqual([(await itemOf(invoice.id)).status, (await itemOf(invoice.id)).residualAmount], ['paid', 0]);
      assert.equal((await journal(h)).length, entries + 1, 'exactly one payment entry');
      const entry = (await entryFor(h, `payment:invoice_payment:${paymentId}`))!;
      assert.ok(entry, 'the payment is in the journal under its invoice payment id');
      assert.deepEqual(shape(entry), [['1200', GROSS, 0], ['1400', 0, GROSS]]);
      assert.equal((await invoiceOf(h, invoice.id)).status, 'paid');
      await assertLedgerConsistent(h);
    });

    test('a cash payment on a Pro invoice books the cash account, a partial one leaves the item partly open', async () => {
      const invoice = await issue(h, { client: 'Barzahler' });
      const response = await invoicePayment(invoice.id, { amount: 100, method: 'Bar' });
      assert.equal(response.status, 200, response.text);
      const entry = (await entryFor(h, `payment:invoice_payment:${response.body.payments[0].id}`))!;
      assert.deepEqual(shape(entry), [['1000', 100, 0], ['1400', 0, 100]], 'Bar goes to Kasse 1000');
      const item = await itemOf(invoice.id);
      assert.deepEqual([item.status, item.allocatedAmount, item.residualAmount], ['partially_paid', 100, 138]);
      assert.notEqual((await invoiceOf(h, invoice.id)).status, 'paid');
    });

    test('reversing a payment recorded on a Pro invoice posts the mirror entry and reopens item and invoice', async () => {
      const invoice = await issue(h, { client: 'Zahlung zurück' });
      const paid = await invoicePayment(invoice.id, { amount: GROSS });
      assert.equal(paid.status, 200, paid.text);
      const payment = paid.body.payments[0];
      const entry = (await entryFor(h, `payment:invoice_payment:${payment.id}`))!;
      const reversed = await h.raw('POST', `/invoices/${invoice.id}/payments/${payment.id}/reverse`, { reason: 'Falsch erfasst', expectedPayment: payment });
      assert.equal(reversed.status, 200, reversed.text);
      assert.equal(reversed.body.status, 'open');
      assert.deepEqual(reversed.body.payments, []);
      assert.equal((await get<JournalEntry>(h, `/accounting/journal/${entry.id}`)).status, 'reversed');
      const mirror = (await journal(h)).find((candidate) => candidate.sourceKey === `reversal:${entry.id}`)!;
      assert.deepEqual(shape(mirror), [['1200', 0, GROSS], ['1400', GROSS, 0]]);
      assert.deepEqual([(await itemOf(invoice.id)).status, (await itemOf(invoice.id)).residualAmount], ['open', GROSS]);
      // The same invoice takes a new payment afterwards.
      assert.equal((await invoicePayment(invoice.id, { amount: GROSS })).status, 200);
      assert.equal((await itemOf(invoice.id)).status, 'paid');
      await assertLedgerConsistent(h);
    });

    test('a Pro invoice payment that cannot be booked is refused and changes neither invoice nor ledger', async () => {
      const invoice = await issue(h, { client: 'Unbuchbar' });
      const entries = (await journal(h)).length;
      const negative = await invoicePayment(invoice.id, { amount: -50 });
      assert.ok(negative.status >= 400 && negative.status < 500, `a refund with nothing paid was accepted (${negative.status})`);
      const tooMuch = await invoicePayment(invoice.id, { amount: GROSS + 100 });
      assert.ok(tooMuch.status >= 400 && tooMuch.status < 500, `an overpayment on the invoice route was accepted (${tooMuch.status})`);
      assert.equal((await journal(h)).length, entries);
      assert.deepEqual((await invoiceOf(h, invoice.id)).payments ?? [], []);
      assert.equal((await itemOf(invoice.id)).allocatedAmount, 0);
    });

    test('a payment allocated in OPOS shows on the invoice: invoice payments and open item tell the same story', async () => {
      const invoice = await issue(h, { client: 'Eine Wahrheit' });
      const paid = await pay(h, await itemOf(invoice.id), 100);
      assert.equal(paid.status, 200, paid.text);
      const shown = await invoiceOf(h, invoice.id);
      assert.equal(money((shown.payments ?? []).reduce((sum, payment) => sum + payment.amount, 0)), 100, 'the invoice lists the OPOS payment');
      const edit = await h.raw('POST', `/invoices/${invoice.id}/payments/${shown.payments![0]!.id}/reverse`, { reason: 'x', expectedPayment: shown.payments![0] });
      assert.equal(edit.status, 409, 'an OPOS payment is corrected in OPOS, not on the invoice');
    });

    test('linking a bank transaction to an issued Pro invoice books the bank line against the receivable on the account of the bank', async () => {
      const invoice = await issue(h, { client: `Verknüpfung ${randomUUID().slice(0, 6)}` });
      const account = await addBankAccount(h, undefined, '1240');
      await importCsv(h, account, [{ date: today(), amount: GROSS, counterparty: invoice.client, purpose: `Zahlung ${invoice.number}` }]);
      const legacy = (await get<Array<{ id: string; counterparty: string }>>(h, '/transactions')).find((tx) => tx.counterparty === invoice.client)!;
      const tx = await bankTx(h, invoice.client);
      const entries = (await journal(h)).length;
      const response = await h.raw('POST', `/transactions/${legacy.id}/link`, { reason: 'Zuordnung', invoiceId: invoice.id });
      assert.equal(response.status, 200, response.text.slice(0, 160));
      assert.equal(response.body.invoice.status, 'paid');
      assert.equal((await journal(h)).length, entries + 1);
      const entry = (await entryFor(h, `payment:bank_transaction:${tx.id}`))!;
      assert.deepEqual(shape(entry), [['1240', GROSS, 0], ['1400', 0, GROSS]], 'the bank account books on its own ledger account');
      assert.deepEqual([(await itemOf(invoice.id)).status, (await bankTx(h, invoice.client)).status], ['paid', 'booked']);
      // The same bank line cannot be booked a second time through OPOS.
      const again = await pay(h, await itemOf(invoice.id), GROSS, { sourceType: 'bank_transaction', sourceId: tx.id, partyId: invoice.client, bankAccountNumber: '1240' });
      assert.equal(again.status, 200, again.text);
      const wrongAccount = await pay(h, await itemOf(invoice.id), GROSS, { sourceType: 'bank_transaction', sourceId: tx.id, partyId: invoice.client, bankAccountNumber: '1200' });
      assert.equal(wrongAccount.status, 422, 'the bank line cannot be booked on another bank account');
      assert.equal((await journal(h)).length, entries + 1, 'still one entry');

      const unlinked = await h.raw('POST', `/transactions/${legacy.id}/unlink`, { reason: 'Falscher Kunde' });
      assert.equal(unlinked.status, 200, unlinked.text);
      assert.equal((await get<JournalEntry>(h, `/accounting/journal/${entry.id}`)).status, 'reversed', 'unlinking reverses the payment entry');
      assert.deepEqual([(await itemOf(invoice.id)).status, (await bankTx(h, invoice.client)).status, (await invoiceOf(h, invoice.id)).status], ['open', 'pending', 'open']);
      await assertLedgerConsistent(h);
    });

    const paymentsList = () => get<Array<{ id: string; status: string; sourceId: string; partyId?: string; allocatedAmount: number; residualAmount: number; refund?: boolean }>>(h, '/accounting/open-items/payments');
    const reversePayment = (id: string, reason: string | null = 'Falsch zugeordnet', extra: Record<string, unknown> = {}) =>
      h.raw('POST', `/accounting/open-items/payments/${id}/reverse`, reason === null ? extra : { reason, ...extra });
    const bankLine = async (amount: number, counterparty: string, skr = '1200') => {
      const account = await addBankAccount(h, undefined, skr);
      await importCsv(h, account, [{ date: today(), amount, counterparty, purpose: `Bank ${counterparty}` }]);
      return bankTx(h, counterparty);
    };

    test('Umbuchung: a bank payment on the wrong customer is reversed and booked on the right one, both visible in the journal', async () => {
      const wrong = await issue(h, { client: `Kunde A ${randomUUID().slice(0, 6)}` });
      const right = await issue(h, { client: `Kunde B ${randomUUID().slice(0, 6)}` });
      const tx = await bankLine(GROSS, `Zahler ${randomUUID().slice(0, 6)}`);
      const first = await pay(h, await itemOf(wrong.id), GROSS, { sourceType: 'bank_transaction', sourceId: tx.id, partyId: wrong.client });
      assert.equal(first.status, 200, first.text);
      assert.equal((await invoiceOf(h, wrong.id)).status, 'paid');

      const call = (body: Record<string, unknown>) => h.raw('POST', `/accounting/open-items/payments/${first.body.id}/reallocate`, { reason: 'Zahlung gehört zu Kunde B', partyId: right.client, allocationEventId: `um-${randomUUID()}`, allocations: [{ openItemId: '', amount: GROSS }], ...body });
      const rightItem = await itemOf(right.id);
      const entries = (await journal(h)).length;
      assert.equal((await call({ reason: ' ', allocations: [{ openItemId: rightItem.id, amount: GROSS }] })).status, 400, 'a reason is required');
      const foreignParty = await call({ partyId: wrong.client, allocations: [{ openItemId: rightItem.id, amount: GROSS }] });
      assert.equal(foreignParty.status, 422, 'the partner and the open item must match');
      assert.equal((await journal(h)).length, entries, 'a refused Umbuchung books nothing, the Storno is rolled back too');
      assert.equal((await invoiceOf(h, wrong.id)).status, 'paid');

      const moved = await call({ allocations: [{ openItemId: rightItem.id, amount: GROSS }] });
      assert.equal(moved.status, 200, moved.text);
      assert.deepEqual([(await itemOf(wrong.id)).status, (await itemOf(right.id)).status], ['open', 'paid']);
      assert.deepEqual([(await invoiceOf(h, wrong.id)).status, (await invoiceOf(h, right.id)).status], ['open', 'paid']);
      assert.deepEqual((await invoiceOf(h, wrong.id)).payments ?? [], [], 'the wrong invoice no longer lists the payment');
      assert.equal(money(((await invoiceOf(h, right.id)).payments ?? []).reduce((sum, payment) => sum + payment.amount, 0)), GROSS);
      const all = await journal(h);
      assert.equal(all.length, entries + 2, 'one Storno entry and one new payment entry');
      assert.equal(all.find((entry) => entry.id === first.body.journalEntryId)!.status, 'reversed');
      const mirror = all.find((entry) => entry.sourceKey === `reversal:${first.body.journalEntryId}`)!;
      assert.match(mirror.bookingText, /Zahlung gehört zu Kunde B/);
      const rebooked = all.find((entry) => entry.id === moved.body.payment.journalEntryId)!;
      assert.match(rebooked.bookingText, /Umbuchung/);
      assert.deepEqual(shape(rebooked), [['1200', GROSS, 0], ['1400', 0, GROSS]]);
      const booked = await bankTx(h, tx.counterparty);
      assert.deepEqual([booked.status, booked.linkedInvoiceId], ['booked', right.id]);
      const listed = await paymentsList();
      assert.equal(listed.find((payment) => payment.id === first.body.id)!.status, 'reversed', 'the reversed payment stays as history');
      // OPOS "Gebuchte Zahlungen" names what each payment settled: invoice number and customer.
      const named = (id: string) => (({ documentNumbers, partyName }) => [documentNumbers, partyName])(listed.find((payment) => payment.id === id) as unknown as { documentNumbers?: string; partyName?: string });
      assert.deepEqual(named(first.body.id), [wrong.number, wrong.client], 'the reversed payment still says which invoice it was booked on');
      assert.deepEqual(named(moved.body.payment.id), [right.number, right.client]);
      assert.ok((await h.api.audit.exportCsv()).includes('Zahlung gehört zu Kunde B'));

      const twice = await reversePayment(first.body.id);
      assert.equal(twice.status, 409, 'a payment is reversed once');
      assert.equal((await reversePayment('nope')).status, 404);
      assert.equal((await reversePayment(moved.body.payment.id, null)).status, 400, 'a Zahlungsstorno needs a reason');
      await assertLedgerConsistent(h);
    });

    test('Umbuchung of a payment recorded on the invoice moves the whole payment to the right invoice; a split is refused', async () => {
      const wrong = await issue(h, { client: `Kunde A ${randomUUID().slice(0, 6)}` });
      const right = await issue(h, { client: `Kunde B ${randomUUID().slice(0, 6)}` });
      const paymentId = randomUUID();
      assert.equal((await invoicePayment(wrong.id, { id: paymentId, amount: GROSS })).status, 200);
      const booked = (await paymentsList()).find((payment) => payment.sourceId === paymentId)!;
      const rightItem = await itemOf(right.id);
      const call = (allocations: Array<{ openItemId: string; amount: number }>) => h.raw('POST', `/accounting/open-items/payments/${booked.id}/reallocate`, { reason: 'Rechnung verwechselt', partyId: right.client, allocationEventId: `um-${randomUUID()}`, allocations });
      const entries = (await journal(h)).length;
      const split = await call([{ openItemId: rightItem.id, amount: GROSS - 1 }]);
      assert.equal(split.status, 400, split.text);
      assert.match(split.text, /PAYMENT_REALLOCATION_UNSUPPORTED/);
      assert.equal((await journal(h)).length, entries, 'the refused Umbuchung books nothing');

      const moved = await call([{ openItemId: rightItem.id, amount: GROSS }]);
      assert.equal(moved.status, 200, moved.text);
      assert.deepEqual([(await invoiceOf(h, wrong.id)).status, (await invoiceOf(h, right.id)).status], ['open', 'paid']);
      assert.deepEqual((await invoiceOf(h, wrong.id)).payments ?? [], []);
      assert.deepEqual(((await invoiceOf(h, right.id)).payments ?? []).map((payment) => [payment.id, payment.amount]), [[paymentId, GROSS]], 'the right invoice lists the same payment');
      assert.equal((await journal(h)).length, entries + 2, 'one Storno entry and one new payment entry');
      await assertLedgerConsistent(h);
    });

    test('a Rücklastschrift (outgoing bank line to the customer) reopens the paid invoice; a refund beyond what was paid is refused', async () => {
      const invoice = await issue(h, { client: `Lastschrift ${randomUUID().slice(0, 6)}` });
      assert.equal((await pay(h, await itemOf(invoice.id), GROSS)).status, 200);
      const back = await bankLine(-GROSS, `Rücklastschrift ${randomUUID().slice(0, 6)}`);
      const entries = (await journal(h)).length;
      const tooMuch = await pay(h, await itemOf(invoice.id), GROSS + 10, { sourceType: 'bank_transaction', sourceId: back.id, partyId: invoice.client, amount: GROSS, allocations: [{ openItemId: (await itemOf(invoice.id)).id, amount: GROSS + 10 }] });
      assert.equal(tooMuch.status, 400, tooMuch.text);
      assert.equal((await journal(h)).length, entries);
      const returned = await pay(h, await itemOf(invoice.id), GROSS, { sourceType: 'bank_transaction', sourceId: back.id, partyId: invoice.client });
      assert.equal(returned.status, 200, returned.text);
      assert.equal(returned.body.refund, true);
      const entry = (await journal(h)).find((candidate) => candidate.id === returned.body.journalEntryId)!;
      assert.deepEqual(shape(entry), [['1400', GROSS, 0], ['1200', 0, GROSS]], 'Forderungen an Bank');
      assert.equal(entry.bookingText, `Erstattung ${invoice.number} ${invoice.client}`, 'the refund names the invoice and the customer');
      assert.deepEqual([(await itemOf(invoice.id)).status, (await itemOf(invoice.id)).residualAmount, (await invoiceOf(h, invoice.id)).status], ['open', GROSS, 'open']);
      assert.equal((await bankTx(h, back.counterparty)).status, 'booked');
      // The payment that was returned cannot be reversed while the Rücklastschrift stands.
      const original = (await paymentsList()).find((payment) => payment.partyId === invoice.client && !payment.refund)!;
      assert.equal((await reversePayment(original.id)).status, 409);
      await assertLedgerConsistent(h);
    });

    test('an overpayment is the customer\'s credit with its partner, and paying it out closes it', async () => {
      const invoice = await issue(h, { client: `Guthaben ${randomUUID().slice(0, 6)}` });
      const over = await pay(h, await itemOf(invoice.id), 300, { partyId: invoice.client }, GROSS);
      assert.equal(over.status, 200, over.text);
      const credit = (await openItems(h)).find((item) => item.sourceType === 'payment' && item.sourceId === over.body.id)!;
      assert.ok(credit, 'the surplus is listed as an open item');
      assert.deepEqual([credit.partyType, credit.partyId, credit.residualAmount], ['debtor', invoice.client, -62]);
      const out = await bankLine(-62, `Rückzahlung ${randomUUID().slice(0, 6)}`);
      const refund = await pay(h, credit, 62, { sourceType: 'bank_transaction', sourceId: out.id, partyId: invoice.client });
      assert.equal(refund.status, 200, refund.text);
      assert.deepEqual(shape((await journal(h)).find((entry) => entry.id === refund.body.journalEntryId)!), [['1400', 62, 0], ['1200', 0, 62]]);
      assert.ok(!(await openItems(h)).some((item) => item.id === credit.id), 'the credit is paid out');
      assert.equal((await reversePayment(over.body.id)).status, 409, 'the overpayment cannot be reversed while its refund stands');
      assert.equal((await reversePayment(refund.body.id, 'Erstattung falsch')).status, 200);
      assert.equal((await openItems(h)).find((item) => item.id === credit.id)!.residualAmount, -62, 'reversing the refund restores the credit');
      await assertLedgerConsistent(h);
    });

    test('a Storno of a paid invoice leaves the customer a credit item, paid out by a refund on the invoice', async () => {
      const invoice = await issue(h, { client: `Storno bezahlt ${randomUUID().slice(0, 6)}` });
      assert.equal((await invoicePayment(invoice.id, { amount: GROSS })).status, 200);
      const cancellation = await correction(h, invoice.id, 'cancellation_invoice');
      const credit = (await openItems(h)).find((item) => item.sourceId === cancellation.id)!;
      assert.ok(credit, 'the amount owed back is an open item');
      assert.deepEqual([credit.partyId, credit.residualAmount], [invoice.client, -GROSS]);
      const refund = await invoicePayment(invoice.id, { amount: -GROSS, method: 'Überweisung' }, 'Rückzahlung nach Storno');
      assert.equal(refund.status, 200, refund.text);
      const after = (await openItems(h)).find((item) => item.id === credit.id)!;
      assert.deepEqual([after.status, after.residualAmount], ['paid', 0]);
      assert.equal((await invoiceOf(h, invoice.id)).status, 'cancelled');
      await assertLedgerConsistent(h);
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
    test('deleting a bank account is audited with the person who did it, not a service name', async () => {
      const id = await addBankAccount(h);
      assert.deepEqual(await h.api.accounts.delete({ id }), { ok: true });
      const line = (await h.api.audit.exportCsv()).split('\n').find((row) => row.includes(`"${id}"`) && row.includes('"account.delete"'));
      assert.ok(line, 'the deletion is in the audit log');
      assert.doesNotMatch(line!, /server-banking/);
      assert.match(line!, /""type"":""user""/, 'actor type user');
    });

    test('a bank account books on a money account: another ledger account is refused, a blank one takes the bank role, a change moves its open drafts', async () => {
      const upsert = (id: string, defaultSkrAccountNumber?: string) => h.raw('POST', '/accounts', { account: { id, name: `Konto ${id}`, iban: '', balance: 0, transactions: [], type: 'bank', color: '#000000', ...(defaultSkrAccountNumber === undefined ? {} : { defaultSkrAccountNumber }) } });
      const stored = async (id: string) => (await h.api.accounts.list()).find((account) => account.id === id) as { defaultSkrAccountNumber?: string } | undefined;
      for (const wrong of ['0005', '4900', '9999']) {
        const id = `bank-wrong-${randomUUID().slice(0, 6)}`;
        const refused = await upsert(id, wrong);
        assert.equal(refused.status, 422, `${wrong}: ${refused.text}`);
        assert.match(refused.body.message, /kein Geld- oder Bankkonto/, 'a German message, no code');
        assert.equal(await stored(id), undefined, `${wrong} is not stored`);
      }
      for (const blank of [undefined, '', '  ']) {
        const id = `bank-blank-${randomUUID().slice(0, 6)}`;
        const saved = await upsert(id, blank);
        assert.equal(saved.status, 200, saved.text);
        assert.equal((await stored(id))?.defaultSkrAccountNumber, '1200', 'a blank ledger account takes the bank role');
      }

      const id = await addBankAccount(h, `bank-move-${randomUUID().slice(0, 6)}`);
      const counterparty = `Kontowechsel ${randomUUID().slice(0, 6)}`;
      await importCsv(h, id, [{ date: today(), amount: -119, counterparty, purpose: 'Bürobedarf' }]);
      const tx = await bankTx(h, counterparty);
      const before = await getDraft(h, tx.id);
      assert.equal(before.lines.find((line) => line.creditAmount === 119)?.accountNumber, '1200');
      const moved = await upsert(id, '1240');
      assert.equal(moved.status, 200, moved.text);
      const after = await getDraft(h, tx.id);
      assert.deepEqual(after.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]), [[before.lines[0]!.accountNumber, 119, 0], ['1240', 0, 119]], 'the open draft books on the new ledger account');
      assert.ok(!after.validationIssues.some((item) => item.code === 'BANK_LINE_MISMATCH'), JSON.stringify(after.validationIssues));
    });

    test('a payment received for an open invoice drafts against the receivable and is steered to OPOS, never booked as a second revenue', async () => {
      const invoice = await issue(h, { client: `Zahlungseingang ${randomUUID().slice(0, 6)}` });
      const account = await addBankAccount(h, `bank-receipt-${randomUUID().slice(0, 6)}`);
      const other = `Spender ${randomUUID().slice(0, 6)}`;
      await importCsv(h, account, [
        { date: today(), amount: GROSS, counterparty: invoice.client, purpose: `Restzahlung ${invoice.number}` },
        { date: today(), amount: 77.77, counterparty: other, purpose: 'Zuschuss' },
      ]);
      const tx = await bankTx(h, invoice.client);
      const receipt = await getDraft(h, tx.id);
      assert.deepEqual(receipt.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]), [['1200', GROSS, 0], ['1400', 0, GROSS]], 'the counter account is the receivable, not 8400');
      const steer = (receipt.validationIssues as Array<{ code: string; blocking: boolean; message?: string }>).find((item) => item.code === 'OPEN_ITEM_ACCOUNT_IN_DRAFT');
      assert.ok(steer?.blocking, JSON.stringify(receipt.validationIssues));
      assert.match(steer!.message ?? '', /In Offene Posten ausgleichen/, 'a German message with the way out');
      const entries = (await journal(h)).length;
      const posted = await postDraft(h, receipt.id);
      assert.ok(JSON.stringify(posted.body).includes('OPEN_ITEM_ACCOUNT_IN_DRAFT'), posted.text.slice(0, 300));
      assert.equal((await journal(h)).length, entries, 'a free draft on 1400 would leave the open item open while the ledger says paid');
      const second = await issue(h, { client: `Ohne Nummer ${randomUUID().slice(0, 6)}` });
      await importCsv(h, account, [{ date: today(), amount: GROSS, counterparty: second.client, purpose: 'Danke' }]);
      assert.equal((await getDraft(h, (await bankTx(h, second.client)).id)).lines[1]!.accountNumber, '1400', 'the exact rest from that customer, without the number in the purpose');
      const unrelated = await getDraft(h, (await bankTx(h, other)).id);
      assert.deepEqual(unrelated.lines.map((line) => line.accountNumber), ['1200', '8400'], 'income without an open invoice keeps the revenue default');
    });

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

    test('a rule made after the line was opened moves the untouched draft onto its account; a draft the person edited stays', async () => {
      const u = token();
      await importCsv(h, bank, [
        { date: today(), amount: -29.99, counterparty: `Hosting ${u} AG`, purpose: 'Server' },
        { date: today(), amount: -12, counterparty: `Hosting ${u} Mail`, purpose: 'Postfach' },
      ]);
      const untouched = await bankTx(h, `Hosting ${u} AG`);
      const edited = await bankTx(h, `Hosting ${u} Mail`);
      assert.equal((await getDraft(h, untouched.id)).lines[0]!.accountNumber, '4900', 'opened before the rule: the default');
      const mine = await getDraft(h, edited.id);
      assert.equal((await saveDraft(h, mine, [{ ...mine.lines[0]!, accountNumber: '4930' }, mine.lines[1]!])).status, 200);
      const made = await saveRule({ value: `hosting ${u}`, priority: 10, targetAccountNumber: '4910' });
      assert.equal(made.status, 200, made.text);
      try {
        assert.deepEqual(await suggestion(`Hosting ${u} AG`), ['rule', '4910']);
        const moved = await getDraft(h, untouched.id);
        assert.deepEqual(moved.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]), [['4910', 29.99, 0], ['1200', 0, 29.99]], 'the draft books what the card proposes');
        assert.equal(moved.workflowStatus, 'suggested', 'and offers the next step');
        assert.equal((await draftAction(h, untouched.id, 'submit_for_review')).status, 200);
        assert.equal((await getDraft(h, edited.id)).lines[0]!.accountNumber, '4930', 'a person\'s choice is not overwritten');
      } finally {
        await dropRule(made.body.id);
      }
    });
  });

  describe('Skonto derived from the payment', () => {
    const withSkonto = async (date = today()) => {
      const plain = await draft(h, { client: `Skonto ${randomUUID().slice(0, 4)}`, date, dueDate: addDays(date, 30) });
      return h.api.invoices.upsert({ reason: 'stellen', invoice: { ...plain, skonto: { percent: 2, days: 10 }, status: 'open' } as never });
    };
    const pay = (invoiceId: string, amount: number, date = today()) => h.raw('POST', `/invoices/${invoiceId}/payments`, { reason: 'Zahlung', payment: { id: randomUUID(), date, amount, method: 'Überweisung' } });
    const skontoEntries = async (number: string) => (await journal(h)).filter((entry) => entry.sourceType === 'skonto' && entry.reference === number);

    test('paid within the days less the Skonto: the rest is booked as gewährte Skonti with its VAT and the invoice is paid', async () => {
      const invoice = await withSkonto();
      const paid = await pay(invoice.id, 233.24);
      assert.equal(paid.status, 200, paid.text);
      assert.equal(paid.body.status, 'paid');
      assert.equal(paid.body.payments.find((payment: { method: string }) => payment.method === 'Skonto')?.amount, 4.76);
      const [entry] = await skontoEntries(invoice.number);
      assert.ok(entry, 'a Skonto entry');
      assert.deepEqual(shape(entry!), [['8736', 4, 0], ['1776', 0.76, 0], ['1400', 0, 4.76]]);
      assert.deepEqual([entry!.lines[0]!.taxCaseKey, entry!.lines[0]!.netAmount, entry!.lines[0]!.taxAmount], ['DE_STD_19', -4, -0.76], 'the VAT report sees the reduction');
      const item = (await openItems(h)).find((candidate) => candidate.sourceId === invoice.id)!;
      assert.deepEqual([item.status, item.residualAmount], ['paid', 0]);
      const typed = paid.body.payments.find((payment: { method: string }) => payment.method === 'Skonto');
      assert.equal((await h.raw('POST', `/invoices/${invoice.id}/payments`, { payment: { ...typed, amount: 1 }, reason: 'von Hand' })).status, 409, 'Skonto is derived, never typed');
      await assertLedgerConsistent(h);
    });

    test('a late or a short payment earns no Skonto and leaves the rest open', async () => {
      const late = await withSkonto(addDays(today(), -20));
      assert.equal((await pay(late.id, 233.24)).body.status, 'open');
      assert.deepEqual(await skontoEntries(late.number), []);
      const short = await withSkonto();
      assert.equal((await pay(short.id, 230.86)).body.status, 'open', '3 % less than billed is more than the 2 % Skonto');
      assert.deepEqual(await skontoEntries(short.number), []);
    });

    test('reversing the payment reverses the Skonto too and reopens the whole invoice', async () => {
      const invoice = await withSkonto();
      const paid = await pay(invoice.id, 233.24);
      const cash = paid.body.payments.find((payment: { method: string }) => payment.method === 'Überweisung');
      const reversed = await h.raw('POST', `/invoices/${invoice.id}/payments/${cash.id}/reverse`, { reason: 'Rücklastschrift', expectedPayment: cash });
      assert.equal(reversed.status, 200, reversed.text);
      assert.equal(reversed.body.status, 'open');
      assert.ok(!reversed.body.payments.some((payment: { method: string }) => payment.method === 'Skonto'), 'no money, no Skonto');
      const [entry] = await skontoEntries(invoice.number);
      assert.equal(entry!.status, 'reversed');
      const item = (await openItems(h)).find((candidate) => candidate.sourceId === invoice.id)!;
      assert.deepEqual([item.allocatedAmount, item.residualAmount], [0, GROSS]);
      assert.ok((await journal(h)).some((e) => e.sourceType === 'reversal' && e.reference === entry!.reference), 'the Skonto has its Storno entry');
      await assertLedgerConsistent(h);
    });
  });

  describe('advance invoices (Mindest-Ist) and the final invoice', () => {
    const chain = (body: Record<string, unknown>) => h.api.documents.chainIssue({ id: randomUUID(), date: today(), reason: 'Test', ...body } as never) as unknown as Promise<{ id: string; number: string; amount: number }>;
    /** An accepted offer of 200 EUR net (238 EUR gross) with its order confirmation. */
    const order = async (client: string) => {
      const offer = await draftOffer(h.api as never, { client });
      await h.api.offers.upsert({ reason: 'Angebot angenommen', offer: { ...offer, shareDecision: 'accepted', acceptedAt: new Date().toISOString() } } as never);
      return chain({ operation: 'order_confirmation', offerId: offer.id, reason: 'Auftragsbestätigung' });
    };
    const settle = (orderId: string, kind: 'advance_invoice' | 'final_invoice', amount: number) => chain({ operation: 'settlement_invoice', orderId, kind, amount, reason: kind });
    const pay = (invoiceId: string, amount: number) => h.raw('POST', `/invoices/${invoiceId}/payments`, { reason: 'Zahlung', payment: { id: randomUUID(), date: today(), amount, method: 'Überweisung' } });
    const balances = async (accounts: string[]) => { const entries = await journal(h); return accounts.map((account) => ledgerNet(entries, account)); };

    test('an advance invoice books Erhaltene Anzahlungen, its VAT is due on payment even under Soll, and the final invoice releases it into revenue', async () => {
      const accounts = ['1718', '1766', '1776', '8400'];
      const before = await balances(accounts);
      const moved = async () => (await balances(accounts)).map((value, index) => money(value - before[index]!));
      /** What the UStVA basis (VAT summary of DE_STD_19) moved since the start: [net, VAT]. */
      const vat19 = async () => { const row = (await get<{ rows: Array<{ taxCaseKey: string; netAmount: number; taxAmount: number }> }>(h, '/accounting/vat/summary')).rows.find((candidate) => candidate.taxCaseKey === 'DE_STD_19'); return [row?.netAmount ?? 0, row?.taxAmount ?? 0]; };
      const vatBefore = await vat19();
      const vatMoved = async () => (await vat19()).map((value, index) => money(value - vatBefore[index]!));
      const confirmation = await order('Anzahlung GmbH');
      const advance = await settle(confirmation.id, 'advance_invoice', 119);
      const advanceEntry = (await invoiceEntry(h, advance.id))!;
      assert.deepEqual(shape(advanceEntry), [['1400', 119, 0], ['1718', 0, 100], ['1766', 0, 19]], 'not revenue, and the VAT waits');
      assert.ok(!advanceEntry.lines.some((line) => line.taxAmount), 'nothing for the VAT return before the money comes in');
      assert.deepEqual(await moved(), [-100, -19, 0, 0]);
      assert.deepEqual(await vatMoved(), [0, 0], 'the UStVA does not see an unpaid advance');

      assert.equal((await pay(advance.id, 119)).status, 200);
      const recognised = (await journal(h)).filter((entry) => entry.sourceType === 'payment_vat').at(-1)!;
      assert.deepEqual(shape(recognised), [['1766', 19, 0], ['1776', 0, 19]], 'Mindest-Ist: due with the payment');
      assert.deepEqual([recognised.lines[0]!.taxCaseKey, recognised.lines[0]!.netAmount, recognised.lines[0]!.taxAmount], ['DE_STD_19', 100, 19]);
      assert.deepEqual(await vatMoved(), [100, 19], 'the UStVA reports the advance in the month it was paid');

      const final = await settle(confirmation.id, 'final_invoice', 119);
      const finalEntry = (await invoiceEntry(h, final.id))!;
      assert.deepEqual(finalEntry.lines.filter((line) => line.memo?.startsWith('Auflösung')).map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]), [['1718', 100, 0], ['8400', 0, 100]]);
      assert.deepEqual(await moved(), [0, 0, -38, -200], 'the advance is released, revenue and VAT are the whole order');
      assert.deepEqual(await vatMoved(), [200, 38], 'the UStVA reports the whole order once');
      await assertLedgerConsistent(h);
    });

    test('an unpaid advance invoice cancelled by Storno leaves nothing on Erhaltene Anzahlungen or the VAT accounts', async () => {
      const accounts = ['1718', '1766', '1776', '8400'];
      const before = await balances(accounts);
      const confirmation = await order('Anzahlung Storno GmbH');
      const advance = await settle(confirmation.id, 'advance_invoice', 119);
      const storno = await chain({ operation: 'correction', kind: 'cancellation_invoice', invoiceId: advance.id, reason: 'Storno' });
      const entry = (await entryFor(h, `outgoing-correction:${storno.id}`))!;
      assert.deepEqual(shape(entry), [['1400', 0, 119], ['1718', 100, 0], ['1766', 19, 0]]);
      assert.deepEqual((await balances(accounts)).map((value, index) => money(value - before[index]!)), [0, 0, 0, 0]);
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

    test('a vendor saved again under a new id but the same name is the same vendor, not a second one', async () => {
      const name = `Bau Schmidt ${randomUUID().slice(0, 6)}`;
      const first = await h.raw('POST', '/accounting/vendors', vendor(`v-${randomUUID().slice(0, 6)}`, { name, vendorNumber: undefined }));
      assert.equal(first.status, 200, first.text);
      const again = await h.raw('POST', '/accounting/vendors', vendor(`v-${randomUUID().slice(0, 6)}`, { name: `  ${name.toUpperCase()} `, vendorNumber: undefined }));
      assert.equal(again.status, 200, again.text);
      assert.equal(again.body.id, first.body.id, 'the existing vendor is returned');
      const all = await get<Array<{ name: string }>>(h, '/accounting/vendors');
      assert.equal(all.filter((candidate) => candidate.name.trim().toLowerCase() === name.toLowerCase()).length, 1);
      // A differing IBAN or USt-IdNr. is never dropped silently: the save is refused and the existing vendor stays as it was.
      const otherIban = await h.raw('POST', '/accounting/vendors', vendor(`v-${randomUUID().slice(0, 6)}`, { name, vendorNumber: undefined, iban: 'DE89370400440532013000' }));
      assert.equal(otherIban.status, 409, otherIban.text);
      assert.match(otherIban.body.message, /existiert bereits/);
      assert.match(otherIban.body.message, /IBAN/);
      const otherVat = await h.raw('POST', '/accounting/vendors', vendor(`v-${randomUUID().slice(0, 6)}`, { name, vendorNumber: undefined, vatId: 'DE999999999' }));
      assert.equal(otherVat.status, 409, otherVat.text);
      assert.match(otherVat.body.message, /USt-IdNr/);
      const kept = (await get<Array<{ id: string; iban?: string; vatId?: string }>>(h, '/accounting/vendors')).find((candidate) => candidate.id === first.body.id)!;
      assert.deepEqual([kept.iban, kept.vatId], [first.body.iban, first.body.vatId], 'the existing vendor is unchanged');
    });

    test('an incoming invoice with an account the chart does not know cannot be released for posting, and stays correctable', async () => {
      const id = `in-${randomUUID().slice(0, 6)}`;
      const lines = (accountNumber: string) => [{ id: `l-${id}`, incomingInvoiceId: id, position: 0, description: 'Bauleistung', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 19, taxAmount: 19, grossAmount: 119, accountNumber }];
      assert.equal((await h.raw('POST', '/accounting/incoming-invoices', incoming(id, { status: 'draft', lines: lines('4400') }))).status, 200, 'a draft may hold an unfinished account');
      const released = await h.raw('POST', '/accounting/incoming-invoices', incoming(id, { status: 'open', lines: lines('4400') }));
      assert.equal(released.status, 422, released.text);
      assert.match(released.body.message, /4400.*nicht im Kontenrahmen/, 'a German message naming the account');
      assert.equal((await listed(id)).status, 'draft', 'still a draft');
      const fixed = await h.raw('POST', '/accounting/incoming-invoices', incoming(id, { status: 'open', lines: lines('3100') }));
      assert.equal(fixed.status, 200, fixed.text);
      assert.equal((await listed(id)).lines[0].accountNumber, '3100');
      assert.equal((await post(id)).status, 200);
    });

    test('a line without its own account books the vendor\'s default expense account; a line account still wins', async () => {
      const id = `v-${randomUUID().slice(0, 6)}`;
      assert.equal((await h.raw('POST', '/accounting/vendors', vendor(id, { defaultExpenseAccount: '4930' }))).status, 200);
      const plain = `in-${randomUUID().slice(0, 6)}`;
      await h.raw('POST', '/accounting/incoming-invoices', incoming(plain, {}, id));
      assert.equal((await post(plain)).status, 200);
      assert.deepEqual(shape((await entryFor(h, `incoming-invoice:${plain}`))!), [['4930', 100, 0], ['1576', 19, 0], ['1600', 0, 119]]);
      const own = `in-${randomUUID().slice(0, 6)}`;
      await h.raw('POST', '/accounting/incoming-invoices', incoming(own, { lines: [{ id: `l-${own}`, incomingInvoiceId: own, position: 0, description: 'Miete', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 19, taxAmount: 19, grossAmount: 119, accountNumber: '4210' }] }, id));
      assert.equal((await post(own)).status, 200);
      assert.equal((await entryFor(h, `incoming-invoice:${own}`))!.lines[0]!.accountNumber, '4210');
    });

    test('Bewirtung books 70 % as deductible expense and 30 % as nicht abzugsfähig, the input VAT stays whole', async () => {
      const id = `in-${randomUUID().slice(0, 6)}`;
      await h.raw('POST', '/accounting/incoming-invoices', incoming(id, { lines: [{ id: `l-${id}`, incomingInvoiceId: id, position: 0, description: 'Geschäftsessen', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 19, taxAmount: 19, grossAmount: 119, accountNumber: '4650' }] }));
      assert.equal((await post(id)).status, 200);
      const entry = (await entryFor(h, `incoming-invoice:${id}`))!;
      assert.deepEqual(shape(entry), [['4650', 70, 0], ['4654', 30, 0], ['1576', 19, 0], ['1600', 0, 119]]);
      assert.deepEqual(entry.lines.slice(0, 2).map((line) => [line.netAmount, line.taxAmount]), [[70, 13.3], [30, 5.7]], 'the VAT return still sees 100 net and 19 input VAT');
    });

    test('non-deductible input VAT can be marked on an incoming invoice', { todo: 'BUG: incoming invoices have no field for non-deductible input VAT (§15 Abs. 1a UStG, e.g. unangemessene Bewirtung, Geschenke über 50 €); the VAT is always booked as Vorsteuer' }, async () => {
      const id = `in-${randomUUID().slice(0, 6)}`;
      await h.raw('POST', '/accounting/incoming-invoices', incoming(id, { lines: [{ id: `l-${id}`, incomingInvoiceId: id, position: 0, description: 'Geschenk', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 19, taxAmount: 19, grossAmount: 119, accountNumber: '4930', inputVatDeductible: false }] }));
      assert.equal((await post(id)).status, 200);
      assert.ok(!(await entryFor(h, `incoming-invoice:${id}`))!.lines.some((line) => line.accountNumber === '1576'), 'no Vorsteuer for a non-deductible line');
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
      assert.deepEqual(entry.lines.filter((line) => line.debitAmount > 0).map((line) => [line.accountNumber, line.debitAmount]), [['4930', 100], ['4940', 100], ['1576', 19], ['1571', 7]], '7 % Vorsteuer on 1571');
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
      // Zahlungsstorno on the supplier side: the creditor item and the incoming invoice are open again,
      // after which the invoice itself can be reversed.
      const reversed = await h.raw('POST', `/accounting/open-items/payments/${paid.body.id}/reverse`, { reason: 'Doppelt bezahlt erfasst' });
      assert.equal(reversed.status, 200, reversed.text);
      assert.deepEqual(shape((await journal(h)).find((entry) => entry.id === reversed.body.reversalEntryIds[0])!), [['1600', 0, 119], ['1200', 119, 0]]);
      assert.equal((await listed(id)).status, 'open');
      assert.equal((await openItems(h)).find((candidate) => candidate.sourceId === id)!.residualAmount, 119);
      assert.equal((await h.raw('POST', '/accounting/documents/reverse', { reason: 'Storno', documentType: 'incoming_invoice', documentId: id })).status, 200);
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

    describe('tax-free and self-assessed purchases (0 %, § 13b, innergemeinschaftlicher Erwerb)', () => {
      const evidence = { vendorCountryCode: 'AT', vendorVatId: 'ATU12345678', evidenceType: 'rechnung', evidenceReference: 'Steuerschuldnerschaft des Leistungsempfängers' };
      /** The supplier bills net: the line carries the rate the buyer owes, but no VAT amount. */
      const selfAssessed = (id: string, taxCaseKey: string, rate = 19, over: Record<string, unknown> = {}) => incoming(id, {
        netAmount: 1000, taxAmount: 0, grossAmount: 1000, taxRate: rate, taxCaseKey, taxMeta: evidence,
        lines: [{ id: `l-${id}`, incomingInvoiceId: id, position: 0, description: 'Leistung', quantity: 1, unitPrice: 1000, netAmount: 1000, taxRate: rate, taxAmount: 0, grossAmount: 1000 }],
        ...over,
      });
      const sorted = (entry: JournalEntry) => shape(entry).sort((a, b) => a[0].localeCompare(b[0]));
      const postedEntry = async (id: string) => {
        const result = await post(id);
        assert.equal(result.body.status, 'ready', result.text);
        const entry = (await entryFor(h, `incoming-invoice:${id}`))!;
        assertBalanced([entry]);
        return entry;
      };

      test('a 0 % purchase (Kleinunternehmer, Versicherung, Porto) posts without evidence and without tax lines', async () => {
        const id = `in-${randomUUID().slice(0, 6)}`;
        await h.raw('POST', '/accounting/incoming-invoices', incoming(id, { netAmount: 100, taxAmount: 0, grossAmount: 100, taxRate: 0, lines: [{ id: `l-${id}`, incomingInvoiceId: id, position: 0, description: 'Porto', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 0, taxAmount: 0, grossAmount: 100 }] }));
        const entry = await postedEntry(id);
        assert.deepEqual(shape(entry), [['4900', 100, 0], ['1600', 0, 100]]);
        assert.equal(entry.lines[0]!.taxCaseKey, 'DE_ZERO_EXEMPT');
      });

      test('a § 13b Bauleistung books expense, Vorsteuer 1577 and USt 1787 in one entry; the creditor gets the net amount', async () => {
        const id = `in-${randomUUID().slice(0, 6)}`;
        const saved = await h.raw('POST', '/accounting/incoming-invoices', selfAssessed(id, 'DE_RC_13B_DOMESTIC', 19, { taxMeta: { vendorCountryCode: 'DE', evidenceType: 'rechnung', evidenceReference: 'Bauleistung § 13b' } }));
        assert.equal(saved.status, 200, saved.text);
        assert.deepEqual(saved.body.taxMeta, { vendorCountryCode: 'DE', evidenceType: 'rechnung', evidenceReference: 'Bauleistung § 13b' }, 'the evidence is stored with the invoice');
        const entry = await postedEntry(id);
        assert.deepEqual(sorted(entry), [['1577', 190, 0], ['1600', 0, 1000], ['1787', 0, 190], ['4900', 1000, 0]]);
        const base = entry.lines.find((line) => line.taxCaseKey)!;
        assert.deepEqual([base.taxCaseKey, base.netAmount, base.taxRate, base.taxAmount], ['DE_RC_13B_DOMESTIC', 1000, 19, 190]);
        assert.equal((await openItems(h)).find((item) => item.sourceId === id)!.originalAmount, 1000, 'the supplier is owed the net amount only');
      });

      test('an EU service (§ 13b Abs. 1) and a Drittland service post on the § 13b accounts', async () => {
        const eu = `in-${randomUUID().slice(0, 6)}`;
        await h.raw('POST', '/accounting/incoming-invoices', selfAssessed(eu, 'EU_B2B_SERVICE_RC'));
        assert.deepEqual(sorted(await postedEntry(eu)), [['1577', 190, 0], ['1600', 0, 1000], ['1787', 0, 190], ['4900', 1000, 0]]);
        const us = `in-${randomUUID().slice(0, 6)}`;
        await h.raw('POST', '/accounting/incoming-invoices', selfAssessed(us, 'NON_EU_SERVICE_RC', 19, { taxMeta: { vendorCountryCode: 'US', evidenceType: 'rechnung', evidenceReference: 'Cloud-Abo' } }));
        assert.deepEqual(sorted(await postedEntry(us)), [['1577', 190, 0], ['1600', 0, 1000], ['1787', 0, 190], ['4900', 1000, 0]]);
      });

      test('an innergemeinschaftlicher Erwerb books 1574/1774 at 19 % and 1572/1772 at 7 %', async () => {
        const full = `in-${randomUUID().slice(0, 6)}`;
        await h.raw('POST', '/accounting/incoming-invoices', selfAssessed(full, 'EU_IGE_GOODS_RC'));
        assert.deepEqual(sorted(await postedEntry(full)), [['1574', 190, 0], ['1600', 0, 1000], ['1774', 0, 190], ['4900', 1000, 0]]);
        const reduced = `in-${randomUUID().slice(0, 6)}`;
        await h.raw('POST', '/accounting/incoming-invoices', selfAssessed(reduced, 'EU_IGE_GOODS_RC', 7));
        assert.deepEqual(sorted(await postedEntry(reduced)), [['1572', 70, 0], ['1600', 0, 1000], ['1772', 0, 70], ['4900', 1000, 0]]);
      });

      test('a self-assessed purchase without its evidence, with billed VAT, at an unsupported rate or with a sales-only tax case is not posted', async () => {
        const entries = (await journal(h)).length;
        const cases: Array<[string, Record<string, unknown>, string]> = [
          ['EU service without the supplier VAT ID', selfAssessed('x', 'EU_B2B_SERVICE_RC', 19, { taxMeta: { vendorCountryCode: 'AT', evidenceType: 'rechnung', evidenceReference: 'x' } }), 'MISSING_COUNTERPARTY_VAT_ID'],
          ['Erwerb without any evidence', selfAssessed('x', 'EU_IGE_GOODS_RC', 19, { taxMeta: undefined }), 'MISSING_TAX_COUNTRY'],
          ['§ 13b with VAT on the invoice', selfAssessed('x', 'DE_RC_13B_DOMESTIC', 19, { taxAmount: 190, grossAmount: 1190, lines: [{ id: 'l-x', incomingInvoiceId: 'x', position: 0, description: 'Bau', quantity: 1, unitPrice: 1000, netAmount: 1000, taxRate: 19, taxAmount: 190, grossAmount: 1190 }] }), 'SELF_ASSESSED_VAT_BILLED'],
          ['§ 13b at 7 %', selfAssessed('x', 'DE_RC_13B_DOMESTIC', 7), 'SELF_ASSESSED_RATE_UNSUPPORTED'],
          ['a sales case on a purchase', selfAssessed('x', 'EU_IGL_GOODS_0'), 'INCOMING_TAX_CASE_UNSUPPORTED'],
        ];
        for (const [label, body, code] of cases) {
          const id = `in-${randomUUID().slice(0, 6)}`;
          const invoice = { ...(body as { invoice: Record<string, unknown> }).invoice, id, number: `ER-${id}`, lines: ((body as { invoice: { lines: Array<Record<string, unknown>> } }).invoice.lines).map((line) => ({ ...line, id: `l-${id}`, incomingInvoiceId: id })) };
          const saved = await h.raw('POST', '/accounting/incoming-invoices', { ...body, invoice });
          assert.equal(saved.status, 200, `${label}: ${saved.text.slice(0, 200)}`);
          const preview = await h.raw('POST', '/accounting/incoming-invoices/preview', { invoiceId: id, reason: 'Vorschau' });
          assert.deepEqual([preview.body.status, preview.body.reason], ['unresolved', code], `${label}: ${preview.text.slice(0, 200)}`);
          assert.equal((await post(id)).body.status, 'unresolved', label);
        }
        assert.equal((await journal(h)).length, entries, 'nothing posted');
        const bad = `in-${randomUUID().slice(0, 6)}`;
        assert.equal((await h.raw('POST', '/accounting/incoming-invoices', selfAssessed(bad, 'DE_RC_13B_DOMESTIC', 19, { taxMeta: { vendorCountryCode: 'Deutschland' } }))).status, 400, 'a malformed country code');
      });

      test('a reversal of a § 13b purchase takes back expense, Vorsteuer and USt', async () => {
        const id = `in-${randomUUID().slice(0, 6)}`;
        await h.raw('POST', '/accounting/incoming-invoices', selfAssessed(id, 'EU_B2B_SERVICE_RC'));
        await postedEntry(id);
        const reversed = await h.raw('POST', '/accounting/documents/reverse', { reason: 'Falsch erfasst', documentType: 'incoming_invoice', documentId: id });
        assert.equal(reversed.status, 200, reversed.text);
        const mirror = (await journal(h)).find((entry) => entry.id === reversed.body.reversalEntryId)!;
        assert.deepEqual(sorted(mirror), [['1577', 0, 190], ['1600', 1000, 0], ['1787', 190, 0], ['4900', 0, 1000]]);
      });
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

