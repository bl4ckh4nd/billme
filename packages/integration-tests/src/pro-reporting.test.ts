import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { startPro, type ProHarness } from './harness.js';
import { localIsoDate } from '@billme/server-core';
import { addDays, newClient, today } from './fixtures.js';
import { sha256Hex, stableStringify } from '@billme/server-data';
import { defaultResultAccount, isProfitAndLossAccount } from '@billme/accounting-shared';
import {
  addBankAccount, approveDraft, assertBalanced, draft, assertLedgerConsistent, bankTx, cents, download, get, getDraft, importCsv, invoiceEntry, issue,
  journal, money, openItems, payOpenItem, periods, postDraft, statusOf, type JournalEntry,
} from './pro-fixtures.js';

/**
 * Pro reporting end to end: ledger views, report mappings, BWA / GuV / Bilanz,
 * frozen snapshots and the DATEV export, through the embedded Pro backend.
 *
 * How this can fail (each one has a test below):
 * - ledger views: balances, SuSa or the VAT summary that disagree with the
 *   journal they are built from, opening balances that ignore earlier years,
 *   a reversal that does not net out of a report
 * - mappings: a report that silently guesses a mapping, health that lists the
 *   wrong accounts, an override that does not apply from its date, a retry
 *   that duplicates the mapping, a bad position / chart / date accepted, a
 *   rejected override answered with a server error, a mapping without audit
 * - reports: BWA / GuV / Bilanz numbers that differ from the ledger, a balance
 *   sheet that does not balance, a blocked report that still shows numbers
 * - range defaults: an HGB GuV / Bilanz that needs every DATEV account mapped
 *   by hand, a default that is stored or beats a tenant mapping, a default that
 *   is not flagged, Geldtransit (1360) without a balance-sheet position, a BWA
 *   that silently guesses P&L positions; a balancing sole proprietor refused or
 *   without Kapital and Privat in the Eigenkapital; a fiscal year after the
 *   newest catalogue refused instead of running on it, marked provisional; SuSa
 *   rows without the account name
 * - EÜR profile: an imported bank line that nobody books (no draft step) missing
 *   from the classification and the report
 * - snapshots: a frozen report that changes afterwards, a duplicate that is not
 *   recognised, a snapshot of an incomplete mapping, one without a reason
 * - DATEV: a file whose record count, hash or bytes differ from the receipt, a
 *   wrong header (consultant, client, fiscal year, period), a text field in the
 *   wrong encoding, a stack spanning two periods, a bad query accepted, an
 *   export that cannot be fetched again unchanged; a net row plus a VAT row
 *   instead of one gross row (DATEV books the tax twice), the entry number in
 *   Belegfeld 1 instead of the invoice number (also for a payment booked on
 *   the invoice), a bank booking whose Beleg is the internal transaction id, a
 *   Storno whose booking text does not name the original, a Storno under another
 *   Belegfeld than its original, a booking text over 60 characters that
 *   refuses the whole export, a file name without its period
 * - EÜR rules and PDF: a rule without value, line or reason accepted, a deleted
 *   rule still suggesting, a PDF faked when no printer is attached
 * - filing operations: an unknown, stale or anonymous filing validated or submitted
 * - UStVA: running numbers instead of the Kennzahlen of the form, a sale,
 *   purchase or free entry in the wrong Kennzahl (81/86, 41/21, 46/47, 84/85,
 *   89/93, 61/66/67), Kz 83 not output minus input, the live view and the
 *   prepared return disagreeing, the live view locking the month, 2026 or
 *   2027 refused, years before 2025 accepted; ZM with an EU purchase in it;
 *   a tax case without a Kennzahl (§ 25a) dropped silently or frozen into a prepared return
 * - corrections and bank bookings in the UStVA: a Stornorechnung, a partial
 *   credit note, a Skonto or a bad debt that raises Kz 81/86 instead of lowering
 *   them, a cancelled EU supply left in the ZM; a bank expense with a tax case
 *   booked gross without its Vorsteuer (no Kz 66, no BU key in DATEV)
 * - year-end: a fiscal-year close or carry-forward that changes SuSa, BWA, GuV
 *   or Bilanz of the closed or the next year (result zeroed, balances counted
 *   twice), closing entries exported to DATEV, a closed year or a prepared
 *   UStVA month that stays open for postings without an override; a close that
 *   needs every account and balance typed in by hand, a preview that books
 *   something or differs from the booking, a second year's close that closes
 *   the first year's result again; Erfolgskonten that open the next year with
 *   last year's balance, an earlier year's result missing from the Eigenkapital
 * - assets: a disposal during the year refused (ASSET_DISPOSAL_PROJECTION_MISMATCH)
 *   instead of booking the AfA up to the disposal month, or accepted while an
 *   earlier AfA year is unposted; AfA years that ignore the Wirtschaftsjahr; an
 *   AfA booked outside its year; a missing AfA of a past year not reported in the
 *   health; IT hardware with a 1-year life spread over two years; degressive AfA
 *   with the wrong rate or outside its legal windows; the yearly AfA booked in full on a date
 *   before the Wirtschaftsjahr ends; no Anlagenspiegel (opening, additions,
 *   disposals, AfA, closing) or one that does not add up per asset
 * - asset sale through an invoice: the sale draft deleted or the issued sale
 *   invoice stornoed while the asset stays "verkauft" without proceeds (the
 *   disposal and its AfA up to the sale must be reversed, the schedule planned
 *   again, a new disposal or the year-end AfA possible); a Stornorechnung on
 *   another revenue account than the sale invoice; a sale at residual book
 *   value 0 refused by the database or not idempotent, a second sale invoice
 *   for an already sold asset accepted; a sale at a book loss on the "bei
 *   Buchgewinn" account where the chart has a "bei Buchverlust" one (SKR04 6889)
 * - Prüferpaket (Z3): journal lines or posting pairs of other periods in a
 *   package for one range, no Kontenplan, customers, vendors, incoming invoices
 *   (with their receipt files, byte-identical), Belege of bank lines without
 *   their files or from bank lines of another range, open items, asset register or
 *   mappings, the retired account_mappings_hgb still exported, a file whose hash
 *   does not match its bytes
 */

const GROSS = 238;
const net = (entries: JournalEntry[], account: string, until = '9999-12-31', from = '0000-01-01') =>
  entries.filter((entry) => entry.postingDate >= from && entry.postingDate <= until)
    .reduce((sum, entry) => sum + entry.lines.filter((line) => line.accountNumber === account).reduce((s, line) => s + cents(line.debitAmount) - cents(line.creditAmount), 0), 0) / 100;
const override = (h: ProHarness, accountNumber: string, statementType: string, positionKey: string, extra: Record<string, unknown> = {}) =>
  h.raw('PUT', '/accounting/mappings/overrides', { reason: 'Konto zugeordnet', chart: 'SKR03', asOfDate: '2025-01-01', accountNumber, statementType, positionKey, positionLabel: positionKey, ...extra });
const health = (h: ProHarness, reportType: string, asOfDate = '2026-12-31') =>
  get<{ chart: string; unmapped: Array<{ accountNumber: string }> }>(h, `/accounting/mappings/health?reportType=${reportType}&asOfDate=${asOfDate}`).then((body) => body.unmapped.map((row) => row.accountNumber));
const row = (report: { rows: Array<{ position: string; amount: number }> }, position: string) => report.rows.find((candidate) => candidate.position === position)?.amount;
/** A refused request must be answered with a client error. 5xx answers are collected for one todo test at the end of the file. */
const serverErrors: string[] = [];
const refused = (label: string, response: { status: number; text: string }) => {
  assert.ok(response.status >= 400, `${label}: expected a refusal, got ${response.status} ${response.text.slice(0, 120)}`);
  if (response.status >= 500) serverErrors.push(`${label} → ${response.status} ${response.text.slice(0, 80)}`);
};
const invoiceOfApi = async (h: ProHarness, id: string) => (await h.api.invoices.list()).find((invoice) => invoice.id === id)!;

describe('pro reporting', () => {
  let h: ProHarness;
  const ids: Record<string, string> = {};
  before(async () => {
    h = await startPro(null, 'pro-reporting');
    const bank = await addBankAccount(h, 'bank-reports');
    ids.old = (await issue(h, { client: 'Report 2025', date: '2025-06-10', dueDate: '2025-06-24', items: [{ kind: 'item', description: 'Altauftrag', quantity: 1, price: 500, total: 500, taxRate: 19 }] })).id;
    ids.a = (await issue(h, { client: 'Report A', date: '2026-03-10', dueDate: '2026-03-24' })).id;
    ids.b = (await issue(h, { client: 'Report B', date: '2026-04-05', dueDate: '2026-04-19', items: [{ kind: 'item', description: 'Auftrag B', quantity: 1, price: 100, total: 100, taxRate: 19 }] })).id;
    const item = (id: string) => openItems(h).then((all) => all.find((candidate) => candidate.sourceId === id)!);
    assert.equal((await payOpenItem(h, await item(ids.old), 595, { paymentDate: '2025-06-20' })).status, 200);
    assert.equal((await payOpenItem(h, await item(ids.a), 100, { paymentDate: '2026-03-20' })).status, 200);
    assert.equal((await h.raw('POST', '/accounting/documents/reverse', { reason: 'Auftrag storniert', documentType: 'outgoing_invoice', documentId: ids.b, postingDate: '2026-04-06' })).status, 200);
    const vendorId = 'v-reports';
    await h.raw('POST', '/accounting/vendors', { reason: 'Lieferant', vendor: { id: vendorId, name: 'Report Lieferant' } });
    await h.raw('POST', '/accounting/incoming-invoices', { reason: 'Eingang', invoice: { id: 'in-reports', vendorId, number: 'ER-R1', invoiceDate: '2026-03-12', dueDate: '2026-04-12', netAmount: 100, taxAmount: 19, grossAmount: 119, status: 'open', taxRate: 19, lines: [{ id: 'l-reports', incomingInvoiceId: 'in-reports', position: 0, description: 'Hosting', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 19, taxAmount: 19, grossAmount: 119 }] } });
    assert.equal((await h.raw('POST', '/accounting/incoming-invoices/post', { invoiceId: 'in-reports', reason: 'gebucht' })).body.status, 'ready');
    await importCsv(h, bank, [{ date: '2026-03-15', amount: -119, counterparty: 'Büro Müller', purpose: 'Büromaterial Größe' }]);
    const d = await getDraft(h, (await bankTx(h, 'Büro Müller')).id);
    await approveDraft(h, d, [{ id: `${d.id}-1`, accountNumber: '4930', debitAmount: 119, creditAmount: 0 }, { id: `${d.id}-2`, accountNumber: '1200', debitAmount: 0, creditAmount: 119 }]);
    assert.equal((await postDraft(h, d.id, { postingDate: '2026-03-15' })).status, 200);
  });
  after(async () => { await h.close(); });

  describe('ledger views', () => {
    test('balances and SuSa are cent-exact against the journal, with opening balances carried over from earlier years', async () => {
      await assertLedgerConsistent(h);
      const entries = await journal(h);
      const susa = await get<{ from: string; to: string; rows: Array<{ accountNumber: string; openingBalance: number; debitTurnover: number; creditTurnover: number; closingBalance: number }>; totals: { debit: number; credit: number; balance: number } }>(h, '/accounting/reports/susa?from=2026-01-01&to=2026-12-31');
      assert.equal(susa.totals.balance, 0);
      assert.equal(susa.totals.debit, susa.totals.credit);
      // Erfolgskonten open every fiscal year at 0; the earlier result is carried on the result account of the legal form.
      const resultAccount = defaultResultAccount('SKR03', (await h.api.settings.get())?.businessReportingProfile?.legalForm);
      const accounts = [...new Set(entries.flatMap((entry) => entry.lines.map((line) => line.accountNumber)))];
      const result2025 = accounts.filter((account) => isProfitAndLossAccount('SKR03', account)).reduce((sum, account) => sum + cents(net(entries, account, '2025-12-31')), 0);
      for (const account of susa.rows) {
        const pnl = isProfitAndLossAccount('SKR03', account.accountNumber);
        const opening = pnl ? 0 : cents(net(entries, account.accountNumber, '2025-12-31')) + (account.accountNumber === resultAccount ? result2025 : 0);
        assert.equal(cents(account.openingBalance), opening, `opening ${account.accountNumber}`);
        assert.equal(cents(account.closingBalance), opening + cents(net(entries, account.accountNumber, '2026-12-31', '2026-01-01')), `closing ${account.accountNumber}`);
        assert.equal(money(account.openingBalance + account.debitTurnover - account.creditTurnover), account.closingBalance, `roll-forward ${account.accountNumber}`);
      }
      const revenue = susa.rows.find((candidate) => candidate.accountNumber === '8400')!;
      assert.equal(revenue.openingBalance, 0, 'the 2025 revenue is not an opening balance of 2026');
      assert.equal(susa.rows.find((candidate) => candidate.accountNumber === resultAccount)?.openingBalance, -500, 'the 2025 result opens 2026 on the result account');
      const march = await get<typeof susa.rows>(h, '/accounting/balances?from=2026-03-01&to=2026-03-31');
      assert.equal(march.find((candidate) => candidate.accountNumber === '4930')!.debitTurnover, 119);
      assert.deepEqual(await get(h, '/accounting/balances?asOfDate=2024-12-31'), [], 'nothing before the first entry');
    });

    test('ledger balances as of a date are the journal up to that date; a malformed date is refused', async () => {
      const entries = await journal(h);
      const rows = await get<Array<{ accountNumber: string; closingBalance: number }>>(h, '/accounting/ledger/balances?asOfDate=2025-12-31');
      assert.ok(rows.length > 0);
      for (const account of rows) assert.equal(cents(account.closingBalance), cents(net(entries, account.accountNumber, '2025-12-31')), `closing ${account.accountNumber}`);
      assert.deepEqual(await get(h, '/accounting/ledger/balances?asOfDate=2024-12-31'), [], 'nothing before the first entry');
      refused('ledger balances with a malformed date', await h.raw('GET', '/accounting/ledger/balances?asOfDate=kaputt'));
      refused('ledger balances of an unknown chart', await h.raw('GET', '/accounting/ledger/balances?chart=SKR99'));
    });

    test('the VAT summary adds up the tax lines of the journal and a reversed invoice nets out', async () => {
      const entries = await journal(h);
      const summary = await get<{ rows: Array<{ taxCaseKey: string; netAmount: number; taxAmount: number; grossAmount: number }> }>(h, '/accounting/vat/summary');
      const standard = summary.rows.find((candidate) => candidate.taxCaseKey === 'DE_STD_19')!;
      const taxed = entries.flatMap((entry) => entry.lines).filter((line) => line.taxCaseKey === 'DE_STD_19');
      assert.ok(taxed.length >= 4, 'invoices, the reversal and the incoming invoice carry the tax case');
      assert.equal(standard.taxAmount, money(entries.flatMap((entry) => entry.lines).filter((line) => line.taxCaseKey === 'DE_STD_19').reduce((sum, line) => sum + (line.taxAmount ?? 0), 0)));
      const only2026 = await get<typeof summary>(h, '/accounting/vat/summary?from=2026-01-01&to=2026-12-31');
      const only2025 = await get<typeof summary>(h, '/accounting/vat/summary?from=2025-01-01&to=2025-12-31');
      assert.equal(only2025.rows.find((candidate) => candidate.taxCaseKey === 'DE_STD_19')!.taxAmount, 95);
      assert.equal(money(standard.taxAmount - only2025.rows[0]!.taxAmount), only2026.rows.find((candidate) => candidate.taxCaseKey === 'DE_STD_19')!.taxAmount);
      const reversed = await invoiceEntry(h, ids.b);
      assert.ok(reversed);
      assert.equal(net(entries, '8400', '2026-04-30', '2026-04-01'), 0, 'invoice B and its reversal net to zero on the revenue account');
    });
  });

  describe('report mappings', () => {
    test('with the default EÜR profile no ledger account is mapped, and a report never writes guessed mappings', async () => {
      const unmapped = await health(h, 'management-guv');
      for (const account of ['8400', '4930', '4900']) assert.ok(unmapped.includes(account), `${account} is reported as unmapped`);
      for (const account of ['1200', '1400', '1776', '1576', '1600']) assert.ok(!unmapped.includes(account), `${account} is excluded as a balance-sheet account`);
      const bwa = await get<any>(h, '/accounting/reports/bwa01?from=2026-01-01&to=2026-12-31');
      assert.equal(bwa.mappingHealth.blocking, false, 'the BWA runs on the DATEV range defaults');
      assert.ok(bwa.mappingHealth.warnings.some((warning: string) => /Standardzuordnung nach Kontenbereich \(SKR03\): .*4930.*8400/.test(warning)), JSON.stringify(bwa.mappingHealth.warnings));
      assert.deepEqual(await get(h, '/accounting/mappings?chart=SKR03'), [], 'reading a report stores nothing');
      assert.equal((await h.raw('GET', '/accounting/mappings/health?reportType=nonsense')).status, 400);
      assert.equal((await h.raw('GET', '/accounting/mappings/health?asOfDate=31.12.2026')).status, 400);
      assert.equal((await h.raw('GET', '/accounting/mappings/positions?reportType=bwa01')).status, 400, 'asOfDate is required');
      const positions = await get<Array<{ key: string; kind: string }>>(h, '/accounting/mappings/positions?reportType=bwa01&asOfDate=2026-12-31');
      assert.ok(positions.some((position) => position.key === 'revenue' && position.kind === 'line'));
    });

    test('for the default EÜR profile the BWA can be made complete without mapping the balance-sheet accounts', async () => {
      for (const [account, position] of [['8400', 'revenue'], ['4900', 'other-operating-expense'], ['4930', 'space-expense']] as const) assert.equal((await override(h, account, 'bwa01', position)).status, 200);
      const stuck = await health(h, 'bwa01');
      assert.deepEqual(stuck, [], `still unmapped for the BWA: ${stuck}`);
    });

    describe('EÜR (cash basis) of the sole-proprietor profile', () => {
      const eur = (query = 'taxYear=2026') => get<any>(h, `/accounting/reports/eur?${query}`);
      const items = (year: number) => get<Array<{ sourceType: string; sourceId: string; date: string; amountGross: number; amountNet: number; flowType: string; counterparty: string; classification?: { eurLineId?: string; excluded: boolean } }>>(h, `/accounting/reports/eur/items?taxYear=${year}`);
      const classify = (body: Record<string, unknown>) => h.raw('PUT', '/accounting/reports/eur/classifications', { taxYear: 2026, reason: 'Zuordnung', ...body });

      test('payments are the cash items: gross, net and flow, per tax year, and unclassified ones are counted', async () => {
        const y2026 = await items(2026);
        const payment = y2026.find((item) => item.counterparty === 'Report A')!;
        assert.ok(payment, 'the 100 € payment of invoice A is a cash item of 2026');
        assert.deepEqual([payment.flowType, payment.amountGross, payment.amountNet, payment.date, payment.sourceType], ['income', 100, 84.03, '2026-03-20', 'transaction']);
        const y2025 = (await items(2025)).find((item) => item.counterparty === 'Report 2025')!;
        assert.deepEqual([y2025.amountGross, y2025.amountNet, y2025.date], [595, 500, '2025-06-20']);
        assert.ok(!y2026.some((item) => item.counterparty === 'Report 2025'), 'a 2025 payment is not a 2026 item');
        const report = await eur();
        assert.deepEqual([report.taxYear, report.from, report.to], [2026, '2026-01-01', '2026-12-31']);
        assert.ok(report.unclassifiedCount >= 1);
        assert.equal(report.summary.incomeTotal, 0, 'nothing is counted before it is classified');
        assert.ok(report.rows.some((line: any) => line.kind === 'income' && line.kennziffer === '112'));
      });

      test('an imported bank line nobody booked is a cash item of the EÜR profile: classified, it moves the result once', async () => {
        const bank = await addBankAccount(h, `bank-eur-${randomUUID().slice(0, 6)}`);
        const who = `EÜR Import ${randomUUID().slice(0, 6)}`;
        await importCsv(h, bank, [{ date: '2026-04-10', amount: -59.5, counterparty: who, purpose: 'Fachbuch' }]);
        assert.equal((await bankTx(h, who)).status, 'pending', 'the EÜR profile has no booking draft step');
        const item = (await items(2026)).filter((row) => row.counterparty === who);
        assert.equal(item.length, 1, 'the imported line is listed once for classification');
        assert.deepEqual([item[0]!.flowType, item[0]!.amountGross, item[0]!.date], ['expense', 59.5, '2026-04-10']);
        const before = await eur();
        const saved = await classify({ sourceType: item[0]!.sourceType, sourceId: item[0]!.sourceId, eurLineId: 'E2026_KZ100' });
        assert.equal(saved.status, 200, saved.text);
        const after = await eur();
        assert.ok(after.summary.expenseTotal > before.summary.expenseTotal, 'the classified line is an expense of the report');
        assert.equal(after.unclassifiedCount, before.unclassifiedCount - 1);
      });

      test('a classification puts the item on its line and moves the result; excluding takes it out again', async () => {
        const payment = (await items(2026)).find((item) => item.counterparty === 'Report A')!;
        const before = await eur();
        const saved = await classify({ sourceType: payment.sourceType, sourceId: payment.sourceId, eurLineId: 'E2026_KZ112' });
        assert.equal(saved.status, 200, saved.text);
        const after = await eur();
        assert.equal(money(after.summary.incomeTotal - before.summary.incomeTotal), 84.03);
        assert.equal(after.unclassifiedCount, before.unclassifiedCount - 1);
        assert.equal(after.rows.find((line: any) => line.id === 'E2026_KZ112').total, 84.03);
        assert.equal(money(after.summary.surplus), money(after.summary.incomeTotal - after.summary.expenseTotal));
        const excluded = await classify({ sourceType: payment.sourceType, sourceId: payment.sourceId, excluded: true, reason: 'privat' });
        assert.equal(excluded.body.excluded, true);
        assert.equal((await eur()).summary.incomeTotal, before.summary.incomeTotal);
        await classify({ sourceType: payment.sourceType, sourceId: payment.sourceId, eurLineId: 'E2026_KZ112' });
        const csv = await h.raw('GET', '/accounting/reports/eur/export.csv?taxYear=2026');
        assert.equal(csv.status, 200);
        assert.ok(csv.text.startsWith('﻿Kennziffer;Bezeichnung;Betrag') || csv.text.startsWith('Kennziffer;Bezeichnung;Betrag'));
        assert.match(csv.text, /\n112;Umsatzsteuerpflichtige Betriebseinnahmen;84,03/);
      });

      test('classification and report requests are validated: line, flow, source, reason, year and range', async () => {
        const payment = (await items(2026)).find((item) => item.counterparty === 'Report A')!;
        const source = { sourceType: payment.sourceType, sourceId: payment.sourceId };
        assert.equal((await classify({ ...source, eurLineId: 'NOPE' })).status, 400, 'unknown line');
        assert.equal((await classify({ ...source, eurLineId: 'E2026_KZ100' })).status, 400, 'an expense line for income');
        assert.equal((await classify({ sourceType: 'transaction', sourceId: 'nope', eurLineId: 'E2026_KZ112' })).status, 400, 'unknown source');
        assert.equal((await classify({ ...source, eurLineId: 'E2026_KZ112', reason: ' ' })).status, 400);
        assert.equal((await classify({ ...source, eurLineId: 'E2026_KZ112', taxYear: 2024 })).status, 400);
        assert.equal((await classify({ ...source, eurLineId: 'E2026_KZ112', sourceType: 'receipt' })).status, 400);
        assert.equal((await h.raw('GET', '/accounting/reports/eur?taxYear=2024')).status, 400, 'no catalogue for 2024');
        assert.equal((await h.raw('GET', '/accounting/reports/eur?taxYear=2026&from=2026-03-01')).status, 400, 'only whole calendar years');
        assert.equal((await h.raw('GET', '/accounting/reports/eur?from=2026-01-01')).status, 400, 'a 2026 range needs the tax year');
        assert.equal((await h.raw('GET', '/accounting/reports/eur/items?taxYear=2026&limit=5000')).status, 400);
        assert.equal((await h.raw('POST', '/accounting/reports/eur/facts/cash', { ...source, taxYear: 2026, kind: 'income', amountNet: 84.03, reason: ' ' })).status, 400);
        assert.equal((await h.raw('POST', '/accounting/reports/eur/facts/cash', { ...source, taxYear: 2026, kind: 'expense', amountNet: 84.03, reason: 'Fakt' })).status, 400, 'an income source cannot become an expense fact');
        assert.equal((await h.raw('POST', '/accounting/reports/eur/facts/annex', { taxYear: 2026, annex: 'AVEÜR', lineId: 'does-not-exist', amount: 5, reason: 'Anlage' })).status, 400);
      });

      test('EÜR rules suggest their line by priority, need a value, a matching line and a reason, and are audited', async () => {
        type Item = { sourceId: string; counterparty: string; flowType: string; classification?: unknown; suggestedLineId?: string; suggestionLayer?: string };
        const open = (await get<Item[]>(h, '/accounting/reports/eur/items?taxYear=2026')).find((item) => !item.classification && item.counterparty.trim());
        assert.ok(open, 'an unclassified item to suggest for');
        const line = open.flowType === 'income' ? 'E2026_KZ103' : 'E2026_KZ280';
        const rule = (body: Record<string, unknown>) => h.raw('POST', '/accounting/reports/eur/rules', { taxYear: 2026, priority: 1, field: 'counterparty', operator: 'equals', value: open.counterparty, targetEurLineId: line, reason: 'Regel angelegt', ...body });
        const created = await rule({});
        assert.equal(created.status, 200, created.text);
        const listed = await get<Array<{ id: string; active: boolean }>>(h, '/accounting/reports/eur/rules?taxYear=2026');
        assert.deepEqual(listed.map((candidate) => candidate.id), [created.body.id]);
        const suggested = (await get<Item[]>(h, '/accounting/reports/eur/items?taxYear=2026')).find((item) => item.sourceId === open.sourceId)!;
        assert.deepEqual([suggested.suggestedLineId, suggested.suggestionLayer], [line, 'rule'], 'the rule suggests its line in Pro too');
        assert.deepEqual(await get(h, '/accounting/reports/eur/rules?taxYear=2025'), [], 'a 2026 rule is not a 2025 rule');
        assert.equal((await rule({ value: '' })).status, 400, 'a rule needs a value');
        assert.equal((await rule({ targetEurLineId: 'E2026_DOES_NOT_EXIST' })).status, 400, 'an unknown line');
        assert.equal((await rule({ reason: ' ' })).status, 400, 'a reason is mandatory');
        assert.equal((await h.raw('DELETE', `/accounting/reports/eur/rules/${created.body.id}`, {})).status, 400, 'deleting needs a reason');
        assert.equal((await h.raw('DELETE', `/accounting/reports/eur/rules/${created.body.id}`, { reason: 'Regel entfernt' })).status, 200);
        assert.equal((await h.raw('DELETE', `/accounting/reports/eur/rules/${created.body.id}`, { reason: 'nochmal' })).status, 404);
        assert.deepEqual(await get(h, '/accounting/reports/eur/rules?taxYear=2026'), []);
        const csv = await h.api.audit.exportCsv();
        assert.ok(csv.includes('eur_rule.upsert') && csv.includes('eur_rule.delete') && csv.includes('Regel entfernt'));
      });

      test('the EÜR PDF is refused for a year without a catalogue and is not faked when no printer is attached', async () => {
        refused('EÜR PDF for 2019', await h.raw('GET', '/reports/eur/pdf?taxYear=2019'));
        const pdf = await download(h, '/api/v1/pro/reports/eur/pdf?taxYear=2026');
        assert.ok(pdf.status === 501 || (pdf.status === 200 && pdf.bytes.subarray(0, 5).toString() === '%PDF-'), `either a real PDF or a clear 501, got ${pdf.status}`);
      });

      test('an EÜR snapshot freezes the year once everything is classified and is refused for a wrong range', async () => {
        const wrong = await h.raw('POST', '/accounting/reports/snapshots', { reportType: 'eur', taxYear: 2026, from: '2026-03-01', to: '2026-12-31', reason: 'EÜR' });
        assert.equal(wrong.status, 400, wrong.text);
        const report = await eur();
        if (report.unclassifiedCount > 0) {
          for (const item of await items(2026)) if (!item.classification) await classify({ sourceType: item.sourceType, sourceId: item.sourceId, excluded: true, reason: 'für den Test ausgeschlossen' });
        }
        const snapshot = await h.raw('POST', '/accounting/reports/snapshots', { reportType: 'eur', taxYear: 2026, reason: 'EÜR 2026 eingefroren' });
        assert.equal(snapshot.status, 200, snapshot.text);
        assert.equal(snapshot.body.taxYear, 2026);
        assert.equal((await get<any[]>(h, '/accounting/reports/snapshots?reportType=eur&taxYear=2026')).some((candidate) => candidate.id === snapshot.body.id), true);
      });
    });

    test('a rejected mapping override is answered as a client error, not a server error', async () => {
      const unknownPosition = await override(h, '4930', 'bwa01', 'not-a-position');
      assert.ok(unknownPosition.status >= 400 && unknownPosition.status < 500, `unknown position: ${unknownPosition.status}`);
      const hgb = await h.raw('GET', '/accounting/reports/hgb-guv?from=2026-01-01&to=2026-12-31');
      assert.ok(hgb.status >= 400 && hgb.status < 500, `HGB report on an EÜR profile: ${hgb.status}`);
    });
  });

  describe('GmbH profile: complete mappings, BWA, GuV, Bilanz and frozen snapshots', () => {
    const pnl: Array<[string, string, string, string]> = [
      // account, hgb-guv position, bwa01 position, management-guv position
      ['8400', 'revenue', 'revenue', 'revenue'],
      // The EU supply of the ZM test (2025) books its own revenue account (steuerfreie ig. Lieferung).
      ['8125', 'revenue', 'revenue', 'revenue'],
      ['4900', 'other-operating-expense', 'other-operating-expense', 'fixed-costs'],
      ['4930', 'other-operating-expense', 'space-expense', 'fixed-costs'],
    ];
    const balance: Array<[string, string, 'asset' | 'liability']> = [
      ['1200', 'assets.current.cash', 'asset'], ['1400', 'assets.current.receivables', 'asset'], ['1576', 'assets.current.receivables', 'asset'],
      ['1600', 'liabilities', 'liability'], ['1776', 'liabilities', 'liability'],
    ];
    before(async () => {
      const settings = await h.api.settings.get();
      await h.api.settings.set({ settings: { ...settings, businessReportingProfile: { jurisdiction: 'DE', legalForm: 'gmbh', profitDetermination: 'double_entry', hgbSizeClass: 'small', fiscalYearStart: '01-01', chart: 'SKR03', vatMethod: 'soll' } } } as never);
    });

    test('mapping overrides validate position, chart, date, account and reason, and are audited', async () => {
      const bad = (extra: Record<string, unknown>) => override(h, '8400', 'hgb-guv', 'revenue', extra);
      assert.equal((await bad({ reason: ' ' })).status, 400);
      assert.equal((await bad({ asOfDate: '2026-02-30' })).status, 400);
      assert.equal((await bad({ statementType: 'cashflow' })).status, 400);
      assert.equal((await bad({ accountNumber: ' ' })).status, 400);
      assert.equal((await bad({ chart: 'SKR04' })).status, 409, 'a mapping for the inactive chart is a conflict');
      assert.equal((await h.raw('PUT', '/accounting/mappings/overrides', { chart: 'SKR03', asOfDate: '2025-01-01', accountNumber: '8400', statementType: 'hgb-guv', positionKey: 'revenue', positionLabel: 'Umsatz' })).status, 400, 'reason is mandatory');
      assert.deepEqual(await get(h, '/accounting/mappings?chart=SKR03'), [], 'nothing was stored by the rejected calls');
    });

    test('mapping every account clears the health lists per report family', async () => {
      assert.deepEqual(await health(h, 'hgb-bilanz'), [], 'the DATEV range defaults cover every booked account');
      for (const [account, hgb, bwa, management] of pnl) {
        for (const [type, position] of [['hgb-guv', hgb], ['bwa01', bwa], ['management-guv', management]] as const) {
          const response = await override(h, account, type, position, { reason: `Zuordnung ${account}` });
          assert.equal(response.status, 200, `${account} → ${type}: ${response.text}`);
          assert.deepEqual([response.body.source, response.body.version], ['tenant_override', 1]);
        }
      }
      assert.deepEqual(await health(h, 'hgb-guv'), [], 'the balance-sheet accounts are covered by their range default');
      for (const [account, position, side] of balance) {
        const response = await override(h, account, 'hgb-bilanz', position, { balanceSide: side });
        assert.equal(response.status, 200, `${account}: ${response.text}`);
      }
      for (const type of ['hgb-guv', 'bwa01', 'management-guv', 'hgb-bilanz']) assert.deepEqual(await health(h, type), [], `${type}: balance-sheet accounts mapped in hgb-bilanz do not block the P&L families`);
      const audit = await h.api.audit.exportCsv();
      assert.ok(audit.includes('Zuordnung 8400'), 'the reason of an override is audited');
    });

    test('a retry on the same effective date updates the mapping in place; a later date starts a new version from that date', async () => {
      const stored = async () => (await h.api.audit.exportCsv()).split('\n').filter((line) => line.includes('report_account_mapping')).length;
      const before = await stored();
      const again = await override(h, '4930', 'bwa01', 'space-expense', { reason: 'Wiederholung' });
      assert.equal(again.body.version, 1, 'same account, type and date: same version');
      assert.equal(again.body.id, `report-override:billme-pro-local-tenant:SKR03:4930:bwa01:2025-01-01`);
      assert.equal(await stored(), before + 1, 'each save is audited');
      const later = await override(h, '4930', 'bwa01', 'insurance', { asOfDate: '2026-04-01', reason: 'ab April Versicherung' });
      assert.equal(later.body.version, 2);
      const before2026 = await get<any>(h, '/accounting/reports/bwa01?from=2026-01-01&to=2026-03-31');
      const after2026 = await get<any>(h, '/accounting/reports/bwa01?from=2026-04-01&to=2026-04-30');
      assert.equal(row(before2026, 'space-expense'), -119, 'March still reports 4930 under Raumkosten');
      assert.equal(row(after2026, 'insurance'), 0, 'April has no 4930 booking');
      await override(h, '4930', 'bwa01', 'space-expense', { asOfDate: '2026-04-01', reason: 'zurück' });
    });

    test('the BWA, management GuV and HGB GuV match the ledger account by account', async () => {
      const entries = await journal(h);
      const range = 'from=2026-01-01&to=2026-12-31';
      const revenue = -net(entries, '8400', '2026-12-31', '2026-01-01');
      const costs = net(entries, '4900', '2026-12-31', '2026-01-01') + net(entries, '4930', '2026-12-31', '2026-01-01');
      assert.ok(revenue > 0 && costs > 0, 'the fixture has revenue and costs in 2026');
      const bwa = await get<any>(h, `/accounting/reports/bwa01?${range}`);
      assert.equal(bwa.mappingHealth.blocking, false);
      assert.equal(row(bwa, 'revenue'), revenue);
      assert.equal(row(bwa, 'space-expense'), -net(entries, '4930', '2026-12-31', '2026-01-01'));
      assert.equal(row(bwa, 'other-operating-expense'), -net(entries, '4900', '2026-12-31', '2026-01-01'));
      assert.equal(bwa.totals.revenue, revenue);
      assert.equal(money(bwa.totals.operatingResult), money(revenue - costs));

      const management = await get<any>(h, `/accounting/reports/management-guv?${range}`);
      const legacy = await get<any>(h, `/accounting/reports/guv?${range}`);
      assert.equal(row(management, 'revenue'), revenue);
      assert.equal(management.netResult, money(revenue - costs));
      assert.deepEqual(legacy.rows, management.rows, 'the guv alias is the management GuV');

      const hgb = await get<any>(h, `/accounting/reports/hgb-guv?${range}`);
      assert.equal(hgb.mappingHealth.blocking, false);
      assert.equal(row(hgb, 'revenue'), revenue);
      assert.equal(row(hgb, 'other-operating-expense'), -costs);
      assert.equal(hgb.netResult, money(revenue - costs));
      assert.equal(row(await get<any>(h, '/accounting/reports/hgb-guv?from=2025-01-01&to=2025-12-31'), 'revenue'), 500, 'a different range is a different report');
      const reversal = (await invoiceEntry(h, ids.b))!;
      assert.equal(reversal.status, 'reversed');
    });

    test('the balance sheet balances, assets and liabilities follow the ledger and the result splits into year and carry-forward', async () => {
      const entries = await journal(h);
      const report = await get<any>(h, '/accounting/reports/bilanz?asOfDate=2026-12-31');
      assert.equal(report.mappingHealth.blocking, false);
      assert.deepEqual(report.totals, { assets: report.totals.assets, liabilities: report.totals.assets, delta: 0 });
      const assets = ['1200', '1400', '1576'].reduce((sum, account) => sum + net(entries, account, '2026-12-31'), 0);
      assert.equal(report.totals.assets, money(assets));
      const liabilities = report.liabilities as Array<{ position: string; amount: number }>;
      assert.equal(liabilities.find((line) => line.position === 'equity.profit-loss-forward')?.amount, 500, '2025 result carried forward (500 revenue)');
      assert.equal(liabilities.find((line) => line.position === 'equity.result')?.amount, money(-net(entries, '8400', '2026-12-31', '2026-01-01') - net(entries, '4900', '2026-12-31', '2026-01-01') - net(entries, '4930', '2026-12-31', '2026-01-01')));
      assert.equal((await h.raw('GET', '/accounting/reports/hgb-bilanz?asOfDate=2026-12-31')).status, 200);
    });

    test('a booking on an account without mapping blocks the reports and their snapshots until it is mapped', async () => {
      const bank = await addBankAccount(h, 'bank-unmapped');
      await importCsv(h, bank, [{ date: '2026-05-02', amount: -30, counterparty: 'Neues Konto', purpose: 'Versicherung' }]);
      const d = await getDraft(h, (await bankTx(h, 'Neues Konto')).id);
      // 4990 Kalkulatorischer Unternehmerlohn: no range default in any report family.
      await approveDraft(h, d, [{ id: `${d.id}-1`, accountNumber: '4990', debitAmount: 30, creditAmount: 0 }, { id: `${d.id}-2`, accountNumber: '1200', debitAmount: 0, creditAmount: 30 }]);
      await postDraft(h, d.id, { postingDate: '2026-05-02' });
      assert.deepEqual(await health(h, 'bwa01'), ['4990']);
      const blocked = await get<any>(h, '/accounting/reports/bwa01?from=2026-01-01&to=2026-12-31');
      assert.equal(blocked.mappingHealth.blocking, true);
      assert.deepEqual(blocked.mappingHealth.unmappedAccounts, ['4990']);
      assert.deepEqual(blocked.rows, []);
      const snapshots = async () => (await get<unknown[]>(h, '/accounting/reports/snapshots?reportType=bwa01')).length;
      const count = await snapshots();
      const snapshotRefused = await h.raw('POST', '/accounting/reports/snapshots', { reportType: 'bwa01', from: '2026-01-01', to: '2026-12-31', reason: 'Quartalsbericht' });
      assert.equal(snapshotRefused.status, 422, snapshotRefused.text);
      assert.match(snapshotRefused.body.message, /REPORT_SNAPSHOT_BLOCKED_INCOMPLETE_MAPPING/);
      assert.equal(await snapshots(), count, 'no snapshot was created');
      assert.equal((await h.raw('POST', '/accounting/reports/snapshots', { reportType: 'susa', from: '2026-01-01', to: '2026-12-31', reason: 'SuSa ist nie blockiert' })).status, 200, 'the trial balance has no mapping');
      assert.equal((await override(h, '4990', 'hgb-guv', 'other-operating-expense')).status, 200);
      assert.equal((await override(h, '4990', 'bwa01', 'special-cost')).status, 200);
      assert.equal((await override(h, '4990', 'management-guv', 'fixed-costs')).status, 200);
      assert.deepEqual(await health(h, 'bwa01'), []);
      assert.equal(row(await get<any>(h, '/accounting/reports/bwa01?from=2026-01-01&to=2026-12-31'), 'special-cost'), -30);
    });

    test('a snapshot is frozen: later bookings do not change it, an identical report is recognised, a changed one is new', async () => {
      const create = (extra: Record<string, unknown> = {}) => h.raw('POST', '/accounting/reports/snapshots', { reportType: 'bwa01', from: '2026-01-01', to: '2026-12-31', reason: 'Quartalsbericht', ...extra });
      const first = await create();
      assert.equal(first.status, 200, first.text);
      assert.match(first.body.sourceHash, /^[a-f0-9]{64}$/);
      assert.equal(first.body.reportType, 'bwa01');
      const again = await create();
      assert.equal(again.body.id, first.body.id, 'the same report is the same snapshot');
      assert.equal(again.body.sourceHash, first.body.sourceHash);
      const frozen = JSON.parse(first.body.payloadJson);
      assert.equal(row(frozen, 'revenue'), -net(await journal(h), '8400', '2026-12-31', '2026-01-01'));

      const extra = await issue(h, { client: 'Nach dem Snapshot', date: '2026-06-01', dueDate: '2026-06-15' });
      assert.ok(extra.id);
      const changed = await create();
      assert.notEqual(changed.body.id, first.body.id);
      assert.notEqual(changed.body.sourceHash, first.body.sourceHash);
      const reread = await get<any>(h, `/accounting/reports/snapshots/${first.body.id}`);
      assert.equal(reread.payloadJson, first.body.payloadJson, 'the stored payload is byte-identical');
      assert.equal(reread.sourceHash, first.body.sourceHash);
      const list = await get<Array<{ id: string; reportType: string }>>(h, '/accounting/reports/snapshots?reportType=bwa01');
      assert.ok(list.some((snapshot) => snapshot.id === first.body.id) && list.some((snapshot) => snapshot.id === changed.body.id));
      assert.ok(list.every((snapshot) => snapshot.reportType === 'bwa01'));
      assert.equal((await h.raw('GET', '/accounting/reports/snapshots/does-not-exist')).status, 404);
      assert.equal((await create({ reason: ' ' })).status, 400);
      assert.equal((await create({ reportType: 'cashflow' })).status, 400);
      for (const reportType of ['management-guv', 'hgb-guv', 'hgb-bilanz', 'bilanz']) {
        assert.equal((await create({ reportType, asOfDate: '2026-12-31' })).status, 200, reportType);
      }
    });
  });

  describe('balancing sole proprietor (own tenant): range defaults, Kapital and Privat, provisional catalogue', () => {
    let e: ProHarness;
    const book = (lines: Array<[string, number, number]>, text: string, date = '2026-05-10') => e.raw('POST', '/accounting/journal', { reason: text, reference: text.slice(0, 20), documentDate: date, postingDate: date, bookingText: text, idempotencyKey: randomUUID(), lines: lines.map(([accountNumber, debitAmount, creditAmount]) => ({ accountNumber, debitAmount, creditAmount })) });
    before(async () => {
      e = await startPro(null, 'pro-sole-balance');
      const settings = await e.api.settings.get();
      const saved = await e.raw('PUT', '/settings', { settings: { ...settings, businessReportingProfile: { jurisdiction: 'DE', legalForm: 'sole_proprietor', profitDetermination: 'double_entry', fiscalYearStart: '01-01', chart: 'SKR03', vatMethod: 'soll' } } });
      assert.equal(saved.status, 200, `a sole proprietor may balance: ${saved.text}`);
      assert.equal((await book([['1000', 1000, 0], ['1890', 0, 1000]], 'Privateinlage')).status, 200);
      assert.equal((await book([['1800', 300, 0], ['1000', 0, 300]], 'Privatentnahme')).status, 200);
      assert.equal((await book([['1360', 50, 0], ['1000', 0, 50]], 'Geldtransit')).status, 200);
      await issue(e, { client: 'Einzel Kunde', date: '2026-05-12', dueDate: '2026-05-26' });
    });
    after(async () => { await e?.close(); });

    test('GuV, Bilanz and BWA run on the DATEV range defaults without any mapping, flagged, and store nothing', async () => {
      const guv = await get<any>(e, '/accounting/reports/hgb-guv?from=2026-01-01&to=2026-12-31');
      assert.equal(guv.mappingHealth.blocking, false, JSON.stringify(guv.mappingHealth));
      assert.equal(row(guv, 'revenue'), 200);
      assert.equal(guv.netResult, 200);
      assert.ok(guv.mappingHealth.inferredAccounts > 0 && guv.mappingHealth.warnings.some((warning: string) => /Standardzuordnung nach Kontenbereich \(SKR03\): .*8400/.test(warning)), 'the defaults are flagged');

      const bilanz = await get<any>(e, '/accounting/reports/bilanz?asOfDate=2026-12-31');
      assert.equal(bilanz.mappingHealth.blocking, false, JSON.stringify(bilanz.mappingHealth));
      assert.deepEqual(bilanz.totals, { assets: 938, liabilities: 938, delta: 0 }, 'Kasse 650 + Geldtransit 50 + Forderung 238');
      const equity = (bilanz.liabilities as Array<{ position: string; amount: number }>).find((line) => line.position === 'equity')?.amount;
      assert.equal(equity, 900, 'Eigenkapital: Einlage 1000 − Entnahme 300 + Gewinn 200');
      const current = (bilanz.assets as Array<{ position: string; amount: number; accounts?: string[] }>).find((line) => line.position === 'assets.current');
      assert.equal(current?.amount, 938);

      assert.deepEqual(await health(e, 'hgb-bilanz'), [], 'every booked account has a range default');
      assert.deepEqual(await health(e, 'hgb-guv'), []);
      assert.deepEqual(await health(e, 'bwa01'), [], 'the BWA takes 8400 by its range too, the balance accounts need no mapping');
      const bwa = await get<any>(e, '/accounting/reports/bwa01?from=2026-01-01&to=2026-12-31');
      assert.equal(bwa.mappingHealth.blocking, false, JSON.stringify(bwa.mappingHealth));
      assert.equal(row(bwa, 'revenue'), 200);
      assert.ok(bwa.mappingHealth.warnings.some((warning: string) => /Standardzuordnung nach Kontenbereich \(SKR03\): .*8400/.test(warning)), JSON.stringify(bwa.mappingHealth.warnings));
      assert.deepEqual(await get(e, '/accounting/mappings?chart=SKR03'), [], 'nothing stored');
    });

    test('a tenant mapping beats the range default', async () => {
      const saved = await e.raw('PUT', '/accounting/mappings/overrides', { reason: 'Provision', chart: 'SKR03', asOfDate: '2026-01-01', accountNumber: '8400', statementType: 'hgb-guv', positionKey: 'other-operating-income', positionLabel: 'Sonstige' });
      assert.equal(saved.status, 200, saved.text);
      assert.equal(saved.body.version, 1, 'reading reports stored no default mapping before');
      const guv = await get<any>(e, '/accounting/reports/hgb-guv?from=2026-01-01&to=2026-12-31');
      assert.deepEqual([row(guv, 'revenue'), row(guv, 'other-operating-income')], [0, 200]);
    });

    test('2027 runs on the 2026 catalogue and says so', async () => {
      const later = await get<any>(e, '/accounting/reports/hgb-guv?from=2027-01-01&to=2027-12-31');
      assert.deepEqual([later.snapshot.catalogYear, later.snapshot.catalogProvisional], [2026, true]);
      assert.ok(later.mappingHealth.warnings.some((warning: string) => /Berichtskatalog 2026 vorläufig für 2027/.test(warning)));
      const positions = await e.raw('GET', '/accounting/mappings/positions?reportType=hgb-guv&asOfDate=2027-06-30');
      assert.equal(positions.status, 200, `mapping positions for 2027: ${positions.text}`);
      const current = await get<any>(e, '/accounting/reports/hgb-guv?from=2026-01-01&to=2026-12-31');
      assert.deepEqual([current.snapshot.catalogYear, current.snapshot.catalogProvisional], [2026, false]);
    });

    test('SuSa rows carry the account name', async () => {
      const susa = await get<{ rows: Array<{ accountNumber: string; accountName?: string }> }>(e, '/accounting/reports/susa?from=2026-01-01&to=2026-12-31');
      const name = (account: string) => susa.rows.find((candidate) => candidate.accountNumber === account)?.accountName;
      assert.deepEqual([name('1360'), name('1800'), name('1890'), name('8400')], ['Geldtransit', 'Privatentnahmen allgemein', 'Privateinlagen', 'Erlöse 19 % USt']);
    });
  });

  describe('Prüferpaket (Z3)', () => {
    test('the package of a range holds journal, Kontenplan, master data, receipts with their files, OPOS, assets and mappings of that range only', async () => {
      const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(randomUUID())]);
      const upload = await h.raw('POST', '/accounting/incoming-invoices/in-reports/documents', { reason: 'Beleg', originalFilename: 'hosting-maerz.pdf', mimeType: 'application/pdf', data: pdf.toString('base64') });
      assert.equal(upload.status, 200, upload.text);
      assert.equal((await h.raw('POST', '/clients', { reason: 'Kunde', client: newClient({ company: 'Prüfer Kunde GmbH' }) })).status, 200);
      const asset = await h.raw('POST', '/accounting/assets', { reason: 'Anlage', asset: { assetNumber: 'A-PRUEF', name: 'Drucker', assetClass: 'IT-Hardware', status: 'aktiv', activationDate: '2026-03-05', acquisitionCost: 900, usefulLifeYears: 3, depreciationMethod: 'linear', costCenter: 'IT', location: 'Berlin', receiptLinked: true, assetAccountNumber: '0440' } });
      assert.equal(asset.status, 200, asset.text);
      // A Beleg on a March bank line belongs in the package with its file; one on an April line does not.
      const bankAccount = await addBankAccount(h, 'bank-pruefer');
      await importCsv(h, bankAccount, [{ date: '2026-03-12', amount: -23.8, counterparty: 'Prüfer Bürobedarf', purpose: 'Papier' }, { date: '2026-04-12', amount: -11.9, counterparty: 'Prüfer April', purpose: 'Toner' }]);
      const bankPdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(`quittung-${randomUUID()}`)]);
      const attach = async (counterparty: string, bytes: Buffer) => {
        const response = await h.raw('POST', `/accounting/transactions/${(await bankTx(h, counterparty)).id}/documents`, { reason: 'Quittung', originalFilename: 'quittung.pdf', mimeType: 'application/pdf', data: bytes.toString('base64') });
        assert.equal(response.status, 200, response.text);
        return response.body as { id: string; sha256: string };
      };
      const bankBeleg = await attach('Prüfer Bürobedarf', bankPdf);
      const aprilBeleg = await attach('Prüfer April', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from(`april-${randomUUID()}`)]));
      const response = await h.raw('POST', '/tax/audit-export-package', { from: '2026-03-01', to: '2026-03-31', includeDocuments: true });
      assert.equal(response.status, 200, response.text);
      const files = response.body.files as Array<{ name: string; content: string; encoding?: 'base64'; sha256: string; sizeBytes: number; rowCount?: number }>;
      const byName = new Map(files.map((entry) => [entry.name, entry]));
      const rows = (name: string) => { const entry = byName.get(name); assert.ok(entry, `${name} is in the package`); return entry!.content ? entry!.content.split('\n').map((line) => JSON.parse(line)) : []; };
      for (const entry of files) {
        const bytes = Buffer.from(entry.content, entry.encoding === 'base64' ? 'base64' : 'utf8');
        assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${entry.name}: hash`);
        assert.equal(bytes.byteLength, entry.sizeBytes, `${entry.name}: size`);
      }
      assert.ok(!byName.has('account-mappings-hgb.jsonl'), 'the retired HGB mapping table is not exported');

      const entries = rows('journal-entries.jsonl');
      assert.ok(entries.length > 0 && entries.every((entry) => entry.posting_date >= '2026-03-01' && entry.posting_date <= '2026-03-31'));
      const ids = new Set(entries.map((entry) => entry.id));
      const lines = rows('journal-lines.jsonl');
      assert.ok(lines.length > 0 && lines.every((line) => ids.has(line.entry_id)), 'journal lines only of the March entries');
      assert.ok(rows('journal-posting-pairs.jsonl').every((pair) => ids.has(pair.entry_id)), 'posting pairs only of the March entries');

      const chart = rows('chart-of-accounts.jsonl');
      assert.deepEqual(chart.find((account) => account.account_number === '1400'), { chart: 'SKR03', account_number: '1400', name: 'Forderungen aus Lieferungen und Leistungen', active: true, source: 'datev' });
      assert.ok(rows('customers.jsonl').some((client) => client.company === 'Prüfer Kunde GmbH'), 'customers');
      assert.ok(rows('vendors.jsonl').some((vendor) => vendor.name === 'Report Lieferant'), 'vendors');
      assert.ok(rows('incoming-invoices.jsonl').some((invoice) => invoice.number === 'ER-R1'), 'incoming invoices');
      assert.ok(rows('incoming-invoice-lines.jsonl').some((line) => line.incoming_invoice_id === 'in-reports'));
      const documents = rows('incoming-invoice-documents.jsonl');
      const document = documents.find((entry) => entry.id === upload.body.id);
      assert.ok(document && !('content_bytes' in document), 'the receipt index without the bytes');
      const receipt = files.find((entry) => entry.name.startsWith(`beleg-`) && entry.name.endsWith('.pdf') && entry.encoding === 'base64' && entry.sha256 === document.sha256);
      assert.ok(receipt && Buffer.from(receipt.content, 'base64').equals(pdf), 'the receipt file is byte-identical');
      assert.deepEqual(rows('bank-transaction-documents.jsonl').map((entry) => entry.id), [bankBeleg.id], 'the Beleg index of the March bank lines');
      const bankFile = files.find((entry) => entry.name.startsWith('beleg-') && entry.encoding === 'base64' && entry.sha256 === bankBeleg.sha256);
      assert.ok(bankFile && Buffer.from(bankFile.content, 'base64').equals(bankPdf), 'the Beleg of the bank line is in the package, byte-identical');
      assert.equal(bankFile!.name, `beleg-${bankBeleg.id}.pdf`, 'named like the receipts of incoming invoices');
      assert.ok(!files.some((entry) => entry.sha256 === aprilBeleg.sha256), 'not the Beleg of an April bank line');
      assert.ok(rows('open-items.jsonl').every((item) => item.document_date >= '2026-03-01' && item.document_date <= '2026-03-31'));
      assert.ok(rows('open-items.jsonl').length > 0, 'open items of March');
      assert.ok(rows('assets.jsonl').some((entry) => entry.asset_number === 'A-PRUEF'), 'the asset register');
      assert.ok(rows('asset-depreciation-schedule.jsonl').some((entry) => entry.asset_id === asset.body.id), 'its AfA plan');
      const health = await get<{ unmappedAccountCount: number }>(h, '/accounting/health');
      const mapping = await get<{ unmapped: unknown[] }>(h, `/accounting/mappings/health?reportType=hgb-bilanz&asOfDate=${localIsoDate(new Date())}`);
      assert.equal(health.unmappedAccountCount, mapping.unmapped.length, 'the health count comes from the report mappings, not the retired HGB table');
      for (const name of ['asset-depreciation-schedule.jsonl', 'asset-movements.jsonl', 'accounting-account-mappings.jsonl', 'tax-case-account-mappings.jsonl', 'report-account-mappings.jsonl', 'open-item-payments.jsonl', 'open-item-allocations.jsonl']) rows(name);
    });

    test('the package also carries every table as CSV with a GDPdU index.xml (Beschreibungsstandard), so IDEA can read it', async () => {
      const response = await h.raw('POST', '/tax/audit-export-package', { from: '2026-03-01', to: '2026-03-31' });
      assert.equal(response.status, 200, response.text);
      const files = new Map((response.body.files as Array<{ name: string; content: string }>).map((entry) => [entry.name, entry.content]));
      const index = files.get('index.xml');
      assert.ok(index, 'index.xml is in the package');
      assert.match(index!, /<!DOCTYPE DataSet SYSTEM "gdpdu-01-09-2004.dtd">/);
      assert.ok(files.get('gdpdu-01-09-2004.dtd')?.includes('<!ELEMENT VariableLength'), 'with the DTD it refers to');
      const tables = [...index!.matchAll(/<Table>([\s\S]*?)<\/Table>/g)].map((match) => match[1]!);
      assert.ok(tables.length >= 10, 'one table per dataset');
      for (const table of tables) {
        const url = /<URL>([^<]+)<\/URL>/.exec(table)![1]!;
        const csv = files.get(url);
        assert.ok(csv !== undefined, `${url} is in the package`);
        const columns = [...table.matchAll(/<Variable(?:Column|PrimaryKey)>\s*<Name>([^<]+)<\/Name>/g)].map((match) => match[1]);
        assert.deepEqual(csv!.split('\r\n')[0]!.split(';'), columns.map((name) => `"${name}"`), `${url}: the header row names the described columns`);
        assert.match(table, /<Range>\s*<From>2<\/From>\s*<\/Range>/, `${url}: the data start after the header row`);
      }
      const lines = tables.find((table) => table.includes('<URL>journal-lines.csv</URL>'))!;
      assert.match(lines, /<Name>debit_amount<\/Name>\s*<Numeric>\s*<Accuracy>2<\/Accuracy>\s*<\/Numeric>/, 'amounts are numbers with two decimals');
      const entries = tables.find((table) => table.includes('<URL>journal-entries.csv</URL>'))!;
      assert.match(entries, /<Name>posting_date<\/Name>\s*<Date>\s*<Format>YYYY-MM-DD<\/Format>\s*<\/Date>/, 'dates are dates');
      const csv = files.get('journal-lines.csv')!.split('\r\n').filter(Boolean);
      const header = csv[0]!.split(';');
      const debit = header.indexOf('"debit_amount"');
      assert.ok(csv.slice(1).some((row) => /^\d+,\d{2}$/.test(row.split(';')[debit]!)), 'with a decimal comma');
      assert.equal(csv.length - 1, (files.get('journal-lines.jsonl') ?? '').split('\n').filter(Boolean).length, 'the CSV holds the same rows as the JSONL');
    });

    test('a draft Verfahrensdokumentation is generated from the settings and the books, with the parts only the business can write marked open', async () => {
      const settings = await h.api.settings.get() as { company: { name: string }; numbers: { invoicePrefix: string } };
      const response = await download(h, '/api/v1/pro/tax/procedure-documentation');
      assert.equal(response.status, 200, response.bytes.toString());
      assert.match(response.headers.get('content-type') ?? '', /text\/markdown/);
      assert.match(response.headers.get('content-disposition') ?? '', /filename="Verfahrensdokumentation_\d{4}-\d{2}-\d{2}\.md"/);
      const doc = response.bytes.toString('utf8');
      assert.match(doc, /^# Verfahrensdokumentation \(Entwurf\)/);
      for (const heading of ['## 1. Allgemeine Beschreibung', '## 2. Anwenderdokumentation', '## 3. Technische Systemdokumentation', '## 4. Betriebsdokumentation', '## 5. Vom Unternehmen zu ergänzen']) assert.ok(doc.includes(heading), heading);
      assert.ok(doc.includes(settings.company.name), 'the company from the settings');
      assert.ok(doc.includes('SKR03'), 'the Kontenrahmen in use');
      assert.ok(doc.includes(`„${settings.numbers.invoicePrefix}“`), 'the invoice number range');
      const chain = (await h.raw('POST', '/tax/audit-export-package', {})).body.files.find((file: { name: string }) => file.name === 'audit-chain-verification.json');
      assert.ok(JSON.parse(chain.content).ok);
      assert.match(doc, /Prüfkette: intakt \(\d+ Einträge\)/, 'the state of the audit chain on the day of the draft');
      assert.match(doc, /Festgeschriebene Monate: (keine|\d{4}-\d{2})/);
      assert.ok(!/undefined|null|NaN/.test(doc), 'no placeholders leak');
    });
  });

  describe('DATEV export', () => {
    const base = { from: '2026-03-01', to: '2026-03-31', consultantNumber: '1234567', clientNumber: '12345', fiscalYearStart: '2026-01-01', accountLength: 4, encoding: 'cp1252' };
    const qs = (over: Record<string, unknown>) => Object.entries({ ...base, ...over }).filter(([, value]) => value !== undefined).map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join('&');
    const exportCsv = (over: Record<string, unknown> = {}) => download(h, `/api/v1/pro/accounting/datev/export.csv?${qs(over)}`);
    const receipts = () => get<Array<{ id: string; recordCount: number; contentSha256: string; fromDate: string; toDate: string; encoding: string; headerVersion: number; formatVersion: number; chart: string }>>(h, '/accounting/datev/exports');
    const text = (bytes: Buffer, encoding: 'latin1' | 'utf8' = 'latin1') => bytes.toString(encoding);
    const dataRows = (bytes: Buffer, encoding: 'latin1' | 'utf8' = 'latin1') => text(bytes, encoding).split('\r\n').slice(2).filter(Boolean).map((line) => line.split(';'));
    const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const text5 = (bytes: Buffer) => bytes.toString('latin1');

    test('the file matches its receipt: record count, hash, header, columns, amounts and the Windows-1252 text', async () => {
      const exported = await exportCsv();
      assert.equal(exported.status, 200, exported.bytes.toString());
      const rows = dataRows(exported.bytes);
      assert.equal(Number(exported.headers.get('x-billme-datev-record-count')), rows.length);
      assert.equal(exported.headers.get('x-billme-datev-content-sha256'), sha(exported.bytes), 'the hash header is the hash of the downloaded bytes');
      assert.match(exported.headers.get('content-type') ?? '', /windows-1252/);

      const lines = text(exported.bytes).split('\r\n');
      const header = lines[0]!.split(';');
      assert.deepEqual([header[0], header[1], header[2], header[3], header[4]], ['"EXTF"', '700', '21', '"Buchungsstapel"', '13']);
      assert.deepEqual([header[10], header[11], header[12], header[13], header[14], header[15]], ['1234567', '12345', '20260101', '4', '20260301', '20260331'], 'consultant, client, fiscal year start, account length, period');
      assert.equal(lines[1]!.split(';').length, 125, 'all 125 DATEV columns');
      assert.equal(lines[1]!.split(';')[0], 'Umsatz (ohne Soll/Haben-Kz)');
      assert.ok(rows.every((fields) => fields.length === 125), 'every row has 125 fields');

      const march = (await journal(h)).filter((entry) => entry.postingDate >= '2026-03-01' && entry.postingDate <= '2026-03-31');
      const debitTotal = march.reduce((sum, entry) => sum + entry.lines.reduce((s, line) => s + cents(line.debitAmount), 0), 0);
      const exportedTotal = rows.reduce((sum, fields) => sum + Math.round(Number(fields[0]!.replace(',', '.')) * 100), 0);
      assert.equal(exportedTotal, debitTotal, 'the exported amounts add up to the debits of March');
      assert.deepEqual((await get<unknown[]>(h, '/accounting/datev/rows?from=2026-03-01&to=2026-03-31')).length, rows.length, 'the preview rows and the file agree');
      const invoiceRow = rows.find((fields) => /^1\d{4}$/.test(fields[6]!) && fields[7] === '8400')!;
      assert.deepEqual([invoiceRow[0], invoiceRow[8]], ['238,00', ''], 'invoice A is one gross row on the Automatikkonto 8400, without BU key');
      assert.ok(!rows.some((fields) => fields[6] === '1776' || fields[7] === '1776'), 'and no separate VAT row');
      assert.match(invoiceRow[10]!, /^"RE-\d{4}-\d{3}"$/, 'Belegfeld 1 is the invoice number');
      assert.match(exported.headers.get('content-disposition') ?? '', /filename="EXTF_Buchungsstapel_2026-03-01_2026-03-31\.csv"/);
      const preview = await get<Array<{ belegfeld1: string; buchungstext: string; konto: string; gegenkonto: string }>>(h, '/accounting/datev/rows?from=2026-03-01&to=2026-03-31');
      for (const entry of march) {
        // A payment carries the invoice number too (Belegfeld 1 for the OPOS settlement): the booking text tells the entries apart.
        const pairs = preview.filter((row) => row.belegfeld1 === (entry.reference || String(entry.entryNumber)) && row.buchungstext === entry.bookingText);
        assert.ok(pairs.length > 0, `${entry.bookingText}: no DATEV rows`);
        const lineOrder = (account: string) => entry.lines.findIndex((line) => line.accountNumber === account);
        assert.deepEqual(pairs, [...pairs].sort((a, b) => lineOrder(a.konto) - lineOrder(b.konto) || lineOrder(a.gegenkonto) - lineOrder(b.gegenkonto)), 'DATEV pairs follow journal line order, never random pair IDs');
      }
      assert.deepEqual([invoiceRow[1], invoiceRow[9]], ['"S"', '1003'], 'Soll and the document date as TTMM');
      assert.match(invoiceRow[13]!, /^"Rechnung RE-\d{4}-\d{3}"$/);
      assert.ok(exported.bytes.includes(Buffer.from('Büromaterial Größe', 'latin1')), 'umlauts are single-byte Windows-1252');
      assert.ok(!exported.bytes.includes(Buffer.from('Büromaterial Größe', 'utf8')), 'and not UTF-8');

      const receipt = (await receipts()).find((candidate) => candidate.id === exported.headers.get('x-billme-datev-export-id'))!;
      assert.deepEqual([receipt.recordCount, receipt.contentSha256, receipt.fromDate, receipt.toDate, receipt.encoding, receipt.headerVersion, receipt.formatVersion, receipt.chart], [rows.length, sha(exported.bytes), '2026-03-01', '2026-03-31', 'cp1252', 700, 13, 'SKR03']);
    });

    test('customers and vendors get their own Personenkonto in the stack (Debitor 1xxxx, Kreditor 7xxxx), stable across exports', async () => {
      const rows = dataRows((await exportCsv()).bytes);
      const invoiceRow = rows.find((fields) => fields[7] === '8400' && /^"RE-/.test(fields[10]!))!;
      assert.match(invoiceRow[6]!, /^1\d{4}$/, 'the receivable is booked on the customer\'s Debitor, not on 1400');
      const purchase = rows.find((fields) => fields[10] === '"ER-R1"')!;
      assert.ok([purchase[6], purchase[7]].some((account) => /^7\d{4}$/.test(account!)), 'the payable is on the vendor\'s Kreditor, not on 1600');
      assert.ok(!rows.some((fields) => /^"(RE|ER)-/.test(fields[10]!) && [fields[6], fields[7]].some((account) => account === '1400' || account === '1600')), 'no Sammelkonto left on an invoice, where the party is known');
      assert.ok(rows.some((fields) => fields[10] === '"A-PRUEF"' && fields[7] === '1600'), 'an asset bought without a vendor stays on the Sammelkonto');
      const again = dataRows((await exportCsv({ encoding: 'utf8-bom' })).bytes, 'utf8');
      assert.equal(again.find((fields) => fields[10] === invoiceRow[10] && fields[7] === '8400')![6], invoiceRow[6], 'the same customer keeps the same Debitor');

      // The tax adviser needs the names behind the numbers: a Stammdaten stack Debitoren/Kreditoren.
      const parties = await exportCsv({ kind: 'parties' });
      assert.equal(parties.status, 200, parties.bytes.toString());
      const lines = text(parties.bytes).split('\r\n');
      assert.deepEqual(lines[0]!.split(';').slice(0, 5), ['"EXTF"', '700', '16', '"Debitoren/Kreditoren"', '5']);
      assert.equal(lines[0]!.split(';')[13], '4', 'Sachkontenlänge; the Personenkonten have one digit more');
      assert.deepEqual(lines[1]!.split(';').slice(0, 2), ['Konto', 'Name (Adressatentyp Unternehmen)']);
      const master = dataRows(parties.bytes);
      assert.ok(master.every((fields) => fields.length === lines[1]!.split(';').length), 'every row has every column');
      const vendor = master.find((fields) => fields[0] === purchase.slice(6, 8).find((account) => /^7\d{4}$/.test(account!)))!;
      assert.ok(vendor.slice(1, 6).includes('"Report Lieferant"'), 'the Kreditor carries the vendor name');
      assert.ok(master.some((fields) => fields[0] === invoiceRow[6]), 'the Debitor of the invoice is listed');
      assert.equal(new Set(master.map((fields) => fields[0])).size, master.length, 'one row per Personenkonto');
      assert.match(parties.headers.get('content-disposition') ?? '', /filename="EXTF_Debitoren-Kreditoren_/);
      const fetchedAgain = await download(h, `/api/v1/pro/accounting/datev/exports/${parties.headers.get('x-billme-datev-export-id')}`);
      assert.ok(fetchedAgain.bytes.equals(parties.bytes));
      assert.match(fetchedAgain.headers.get('content-disposition') ?? '', /filename="EXTF_Debitoren-Kreditoren_/, 'fetched again from the history, it keeps its name');
      const audit = await h.raw('POST', '/tax/audit-export-package', { from: '2026-03-01', to: '2026-03-31' });
      assert.equal(audit.status, 200, audit.text);
      const numbered = (audit.body.files as Array<{ name: string; content: string }>).find((file) => file.name === 'datev-party-accounts.jsonl')!.content.split('\n').map((line) => JSON.parse(line) as { party_type: string; party_id: string; ordinal: number });
      assert.ok(numbered.some((row) => row.party_type === 'creditor' && row.party_id === 'v-reports' && String(7 * 10 ** 4 + row.ordinal) === vendor[0]), 'the Prüferpaket says which vendor stands behind the Kreditor');
    });

    test('an export can be fetched again byte for byte, even after the ledger changed, and the renderer client verifies the receipt', async () => {
      const exported = await exportCsv();
      const id = exported.headers.get('x-billme-datev-export-id')!;
      const late = await issue(h, { client: 'Nach dem Export', date: '2026-03-25', dueDate: '2026-04-08' });
      assert.ok(late.id, 'a March booking after the export');
      const again = await download(h, `/api/v1/pro/accounting/datev/exports/${id}`);
      assert.equal(again.status, 200);
      assert.ok(again.bytes.equals(exported.bytes), 'identical bytes');
      assert.equal(again.headers.get('x-billme-datev-content-sha256'), sha(exported.bytes));
      assert.equal(again.headers.get('x-billme-datev-record-count'), exported.headers.get('x-billme-datev-record-count'));
      assert.equal((await download(h, '/api/v1/pro/accounting/datev/exports/does-not-exist')).status, 404);
      const receipt = await h.api.pro.exportDatevBuchungsstapel({ from: '2026-03-01', to: '2026-03-31', consultantNumber: '1234567', clientNumber: '12345', fiscalYearStart: '2026-01-01', accountLength: 4 } as never);
      assert.equal(receipt.recordCount, Number(exported.headers.get('x-billme-datev-record-count')) + 1, 'the later invoice adds its one gross row to a new export');
      assert.match(receipt.contentSha256 ?? receipt.sha256 ?? '', /^[a-f0-9]{64}$/);
      assert.ok((await h.api.pro.listDatevExports({} as never)).some((entry) => entry.id === receipt.id));
    });

    test('text fields are quoted: semicolons and quotes in a booking text cannot break the row', async () => {
      const bank = await addBankAccount(h, 'bank-quote');
      await importCsv(h, bank, [{ date: '2026-06-02', amount: -10, counterparty: 'Quote Test', purpose: 'plain' }]);
      const d = await getDraft(h, (await bankTx(h, 'Quote Test')).id);
      const text = 'Miete; "Büro" Juni';
      const lines = [{ id: `${d.id}-1`, accountNumber: '4930', debitAmount: 10, creditAmount: 0 }, { id: `${d.id}-2`, accountNumber: '1200', debitAmount: 0, creditAmount: 10 }];
      await approveDraft(h, d, lines, { postingDate: '2026-06-02', bookingText: text });
      assert.equal((await postDraft(h, d.id, { postingDate: '2026-06-02' })).status, 200);
      const june = await exportCsv({ from: '2026-06-01', to: '2026-06-30' });
      const fieldsOf = (line: string) => {
        const out: string[] = []; let current = ''; let quoted = false;
        for (let index = 0; index < line.length; index += 1) {
          const char = line[index]!;
          if (char === '"') { if (quoted && line[index + 1] === '"') { current += '""'; index += 1; } else { quoted = !quoted; current += char; } } else if (char === ';' && !quoted) { out.push(current); current = ''; } else current += char;
        }
        return [...out, current];
      };
      const rows = text5(june.bytes).split('\r\n').slice(2).filter(Boolean).map(fieldsOf);
      assert.ok(rows.length > 0 && rows.every((fields) => fields.length === 125), `a semicolon in the text kept every row at 125 fields: ${rows.map((fields) => fields.length)}`);
      assert.equal(rows.find((fields) => fields[13]!.includes('Miete'))![13], '"Miete; ""Büro"" Juni"', 'the semicolon is inside the quotes and the quotes are doubled');
    });

    test('UTF-8 with BOM is a different encoding of the same rows', async () => {
      const cp = await exportCsv({ encoding: 'cp1252' });
      const utf = await exportCsv({ encoding: 'utf8-bom' });
      assert.deepEqual([...utf.bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      assert.match(utf.headers.get('content-type') ?? '', /utf-8/);
      assert.ok(utf.bytes.includes(Buffer.from('Büromaterial Größe', 'utf8')));
      assert.equal(dataRows(utf.bytes.subarray(3), 'utf8').length, dataRows(cp.bytes).length);
      const receipt = (await receipts()).find((candidate) => candidate.id === utf.headers.get('x-billme-datev-export-id'))!;
      assert.equal(receipt.encoding, 'utf8-bom');
    });

    test('reversals appear as opposite pairs under the Belegfeld 1 of the original, and 7 % revenue is one gross row on the Automatikkonto 8300', async () => {
      const april = await exportCsv({ from: '2026-04-01', to: '2026-04-30' });
      assert.equal(april.status, 200, april.bytes.toString());
      const rows = dataRows(april.bytes);
      const sum = (konto: string, gegen: string) => rows.filter((fields) => fields[6] === konto && fields[7] === gegen).reduce((total, fields) => total + Math.round(Number(fields[0]!.replace(',', '.')) * 100) * (fields[1] === 'S' ? 1 : -1), 0);
      assert.ok(rows.some((fields) => /Storno/.test(fields[13]!)), 'the reversal says Storno');
      assert.equal(sum('1400', '8400') - sum('8400', '1400'), 0, 'the invoice and its reversal cancel on the revenue pair');
      const reversal = rows.find((fields) => /Storno/.test(fields[13]!))!;
      assert.ok(rows.some((fields) => fields !== reversal && fields[10] === reversal[10]), 'the Storno keeps the Belegfeld 1 of the original invoice');

      assert.equal((await h.raw('POST', '/accounting/tax-case-account-mappings', { reason: 'BU 2', chart: 'SKR03', taxCaseKey: 'DE_STD_7', role: 'datev_bu', accountNumber: '1771', datevBuKey: '2' })).status, 200);
      const seven = await issue(h, { client: 'Sieben DATEV', date: '2026-05-10', dueDate: '2026-05-24', items: [{ kind: 'item', description: 'Buch', quantity: 1, price: 50, total: 50, taxRate: 7 }] });
      assert.ok(seven.id);
      const may = dataRows((await exportCsv({ from: '2026-05-01', to: '2026-05-31' })).bytes);
      const revenueRow = may.find((fields) => /^1\d{4}$/.test(fields[6]!) && fields[7] === '8300')!;
      assert.deepEqual([revenueRow[0], revenueRow[8]], ['53,50', ''], '8300 is the Automatikkonto for 7 %: gross, and a BU key there would be refused by DATEV');
    });

    test('a booking text over 60 characters is shortened, the export is not refused', async () => {
      const bank = await addBankAccount(h, 'bank-long');
      await importCsv(h, bank, [{ date: '2026-07-02', amount: -20, counterparty: 'Langtext', purpose: 'plain' }]);
      const d = await getDraft(h, (await bankTx(h, 'Langtext')).id);
      const long = 'Wartungsvertrag Kopierer Standort Hauptgebäude zweites Quartal inklusive Toner';
      await approveDraft(h, d, [{ id: `${d.id}-1`, accountNumber: '4930', debitAmount: 20, creditAmount: 0 }, { id: `${d.id}-2`, accountNumber: '1200', debitAmount: 0, creditAmount: 20 }], { postingDate: '2026-07-02', bookingText: long });
      assert.equal((await postDraft(h, d.id, { postingDate: '2026-07-02' })).status, 200);
      const july = await exportCsv({ from: '2026-07-01', to: '2026-07-31' });
      assert.equal(july.status, 200, july.bytes.toString());
      const textField = dataRows(july.bytes).find((fields) => fields[13]!.startsWith('"Wartungsvertrag'))![13]!;
      assert.equal(textField, `"${long.slice(0, 59)}…"`.replace('…', '\u0085'), 'cut to 60 characters with an ellipsis');
    });

    test('a month without bookings exports an empty stack', async () => {
      const empty = await exportCsv({ from: '2026-01-01', to: '2026-01-31' });
      assert.equal(empty.status, 200, empty.bytes.toString());
      assert.equal(empty.headers.get('x-billme-datev-record-count'), '0');
      assert.deepEqual(dataRows(empty.bytes), []);
    });

    test('an account length that the booked accounts do not fit is refused and stores no receipt', async () => {
      const known = (await receipts()).length;
      const wide = await exportCsv({ accountLength: 8 });
      refused('DATEV account length 8 with 4-digit accounts', { status: wide.status, text: wide.bytes.toString() });
      assert.match(wide.bytes.toString(), /Sachkontenlänge/);
      assert.equal((await receipts()).length, known);
    });

    test('bad export requests are refused with 400 and store no receipt', async () => {
      const known = (await receipts()).length;
      const bad: Array<[string, Record<string, unknown>]> = [
        ['no consultant number', { consultantNumber: undefined }],
        ['a consultant number that is too short', { consultantNumber: '123' }],
        ['a consultant number below 1001', { consultantNumber: '1000' }],
        ['a consultant number with letters', { consultantNumber: 'ABCD' }],
        ['no client number', { clientNumber: undefined }],
        ['client number zero', { clientNumber: '0' }],
        ['a six digit client number', { clientNumber: '123456' }],
        ['no fiscal year start', { fiscalYearStart: undefined }],
        ['no account length', { accountLength: undefined }],
        ['an account length of 3', { accountLength: 3 }],
        ['an account length of 9', { accountLength: 9 }],
        ['an unknown encoding', { encoding: 'latin1' }],
        ['no period', { from: undefined, to: undefined }],
        ['a date without leading zeros', { from: '2026-3-1' }],
        ['a reversed period', { from: '2026-03-31', to: '2026-03-01' }],
        ['a stack over two periods', { from: '2026-03-01', to: '2026-04-30' }],
        ['a period outside the fiscal year', { from: '2025-12-01', to: '2025-12-31' }],
      ];
      for (const [label, over] of bad) {
        const response = await exportCsv(over);
        assert.equal(response.status, 400, `${label}: ${response.status} ${response.bytes.toString().slice(0, 160)}`);
      }
      assert.equal((await receipts()).length, known, 'refused exports leave no receipt behind');
    });
  });

  describe('VAT filing preparation', () => {
    const prepare = (over: Record<string, unknown> = {}) => h.raw('POST', '/accounting/tax-exports/prepare', { kind: 'ustva', period: '2025-06', year: 2025, idempotencyKey: `ustva-${randomUUID()}`, reason: 'UStVA vorbereitet', ...over });

    test('the UStVA of a month is prepared from the ledger, is an export-only preparation, replays by its key and rejects a changed request under the same key', async () => {
      const key = `ustva-${randomUUID()}`;
      const first = await prepare({ idempotencyKey: key });
      assert.equal(first.status, 200, first.text);
      assert.equal(first.body.replayed, false);
      const artifact = first.body.artifact;
      assert.deepEqual([artifact.kind, artifact.period.period, artifact.period.from, artifact.period.to], ['ustva', '2025-06', '2025-06-01', '2025-06-30']);
      assert.deepEqual(artifact.rows.map((line: any) => [line.kennziffer, line.direction, line.netAmount, line.taxAmount, line.lineCount]), [['81', 'output', 500, 95, 1], ['83', 'total', 0, 95, 0]], 'the June 2025 invoice in Kz 81: base 500, VAT 95; Kz 83 is the Zahllast');
      assert.deepEqual([artifact.catalog.taxYear, artifact.catalog.official, artifact.catalog.provisional], [2025, true, false], 'the Kennzahlen of the official form, no running numbers');
      assert.deepEqual([artifact.submissionReady, artifact.exportable, artifact.providerValidation, artifact.operation], [false, true, 'unavailable', 'preparation'], 'never claims to be a submission');
      assert.match(artifact.sourceHash, /^[a-f0-9]{64}$/);
      assert.equal(await statusOf(h, '2025-06'), 'soft_locked', 'preparing the UStVA soft-locks its month');
      assert.ok((await h.api.audit.exportCsv()).includes('accounting_period.soft_lock'), 'the lock is audited');
      const replay = await prepare({ idempotencyKey: key });
      assert.equal(replay.body.replayed, true);
      assert.equal(replay.body.run.id, first.body.run.id);
      assert.equal(replay.body.artifact.sourceHash, artifact.sourceHash);
      const conflict = await prepare({ idempotencyKey: key, period: '2025-07' });
      assert.equal(conflict.status, 409, conflict.text);
      const stored = await h.raw('GET', `/accounting/tax-exports/ustva/${first.body.run.id}`);
      assert.equal(stored.status, 200, stored.text);
      assert.equal(stored.body.sourceHash, artifact.sourceHash);
      const exported = await download(h, `/api/v1/pro/accounting/tax-exports/ustva/${first.body.run.id}/export`);
      assert.equal(exported.status, 200);
      assert.match(exported.headers.get('content-disposition') ?? '', /ustva-preparation\.json/);
      assert.equal(JSON.parse(exported.bytes.toString()).sourceHash, artifact.sourceHash);
      assert.equal((await h.raw('GET', `/accounting/tax-exports/zm/${first.body.run.id}`)).status, 404, 'a run of another kind is not found under this kind');
      const empty = await prepare({ period: '2025-02' });
      assert.equal(empty.status, 200, empty.text);
      assert.deepEqual(empty.body.artifact.rows, [], 'a month without taxed lines prepares an empty return');
    });

    test('the ZM groups intra-EU supplies by buyer VAT ID and nets a reversal; an EU supply without VAT-ID evidence cannot be prepared', async () => {
      const taxMeta = { buyerCountryCode: 'FR', buyerVatId: 'FR12345678901', destinationVatRate: 20, datevEvidenceType: 'gelangensbestaetigung', datevEvidenceReference: 'GB-2025-07' };
      const supply = await issue(h, { client: 'ZM Kunde', date: '2025-07-10', dueDate: '2025-07-24', taxMode: 'intra_eu_supply_6a', taxMeta, items: [{ kind: 'item', description: 'Ware', quantity: 1, price: 200, total: 200 }] });
      assert.ok(supply.id);
      const zm = await prepare({ kind: 'zm', period: '2025-07' });
      assert.equal(zm.status, 200, zm.text);
      const rows = zm.body.artifact.rows as Array<Record<string, any>>;
      assert.equal(rows.length, 1, JSON.stringify(rows));
      assert.deepEqual([rows[0]!.taxCaseKey, rows[0]!.netAmount], ['EU_IGL_GOODS_0', 200]);
      assert.ok(JSON.stringify(rows[0]).includes('FR12345678901'), 'grouped by the buyer VAT ID');
      assert.equal((await h.raw('POST', '/accounting/documents/reverse', { reason: 'Storno ZM', documentType: 'outgoing_invoice', documentId: supply.id, postingDate: '2025-07-20' })).status, 200);
      const netted = await prepare({ kind: 'zm', period: '2025-07' });
      assert.equal(netted.status, 200, netted.text);
      assert.equal(netted.body.artifact.rows.reduce((sum: number, line: any) => sum + (line.netAmount ?? 0), 0), 0, 'the reversal nets the supply out');
      const oss = await prepare({ kind: 'oss', period: '2025-07' });
      assert.equal(oss.status, 200, oss.text);
      assert.deepEqual(oss.body.artifact.rows, [], 'no B2C distance sales in the period');
    });

    test('unsupported years, periods and kinds, missing keys and reasons are refused', async () => {
      assert.equal((await prepare({ period: '2024-12', year: 2024 })).status, 422, 'no Kennzahlen before 2025');
      assert.equal((await prepare({ period: '2025-13' })).status, 422);
      assert.equal((await prepare({ kind: 'gwg' })).status, 400);
      assert.equal((await prepare({ idempotencyKey: '' })).status, 400);
      assert.equal((await prepare({ reason: ' ' })).status, 400);
      assert.equal((await h.raw('GET', '/accounting/tax-exports/ustva/does-not-exist')).status, 404);
      assert.equal((await h.raw('GET', '/accounting/tax-exports/vat/abc')).status, 400);
    });
  });

  describe('UStVA Kennzahlen from the ledger (own tenant)', () => {
    let u: ProHarness;
    const vendorId = 'v-ustva';
    const purchase = async (id: string, net: number, rate: number, taxCaseKey?: string, taxMeta?: Record<string, unknown>) => {
      const tax = taxCaseKey ? 0 : money(net * rate / 100);
      const saved = await u.raw('POST', '/accounting/incoming-invoices', { reason: 'Eingang', invoice: { id, vendorId, number: `ER-${id}`, invoiceDate: '2026-08-12', dueDate: '2026-09-12', netAmount: net, taxAmount: tax, grossAmount: money(net + tax), status: 'open', taxRate: rate, ...(taxCaseKey ? { taxCaseKey, taxMeta } : {}), lines: [{ id: `l-${id}`, incomingInvoiceId: id, position: 0, description: 'Einkauf', quantity: 1, unitPrice: net, netAmount: net, taxRate: rate, taxAmount: tax, grossAmount: money(net + tax) }] } });
      assert.equal(saved.status, 200, saved.text);
      const posted = await u.raw('POST', '/accounting/incoming-invoices/post', { invoiceId: id, reason: 'gebucht' });
      assert.equal(posted.body.status, 'ready', posted.text);
    };
    const ustva = (from: string, to: string) => get<any>(u, `/accounting/vat/summary?from=${from}&to=${to}`);
    const prepareFor = (over: Record<string, unknown>) => u.raw('POST', '/accounting/tax-exports/prepare', { kind: 'ustva', idempotencyKey: `ustva-${randomUUID()}`, reason: 'UStVA vorbereitet', ...over });
    const kz = (positions: Array<{ kennziffer: string; netAmount: number; taxAmount: number }>) => Object.fromEntries(positions.map((row) => [row.kennziffer, [row.netAmount, row.taxAmount]]));
    const AUGUST = { '81': [1000, 190], '86': [100, 7], '41': [200, 0], '21': [300, 0], '46': [500, 95], '84': [1000, 190], '89': [400, 76], '66': [200, 38], '67': [1500, 285], '61': [400, 76], '83': [0, 159] };
    before(async () => {
      u = await startPro(null, 'pro-ustva');
      await u.raw('POST', '/accounting/vendors', { reason: 'Lieferant', vendor: { id: vendorId, name: 'UStVA Lieferant' } });
      const august = { date: '2026-08-10', dueDate: '2026-08-24' };
      await issue(u, { client: 'Inland 19', ...august, items: [{ kind: 'item', description: 'Beratung', quantity: 1, price: 1000, total: 1000, taxRate: 19 }] });
      await issue(u, { client: 'Inland 7', ...august, items: [{ kind: 'item', description: 'Buch', quantity: 1, price: 100, total: 100, taxRate: 7 }] });
      await issue(u, { client: 'EU Ware', ...august, taxMode: 'intra_eu_supply_6a', taxMeta: { buyerCountryCode: 'FR', buyerVatId: 'FR12345678901', destinationVatRate: 20, datevEvidenceType: 'gelangensbestaetigung', datevEvidenceReference: 'GB-1' }, items: [{ kind: 'item', description: 'Ware', quantity: 1, price: 200, total: 200 }] });
      await issue(u, { client: 'EU Dienst', ...august, taxMode: 'intra_eu_service_reverse_charge', taxMeta: { buyerCountryCode: 'AT', buyerVatId: 'ATU12345678', destinationVatRate: 20, datevEvidenceType: 'Rechnung', datevEvidenceReference: 'N-1', datevSachverhaltLl: '1' }, items: [{ kind: 'item', description: 'Beratung', quantity: 1, price: 300, total: 300 }] });
      await purchase('in-inland', 100, 19);
      await purchase('in-bau', 1000, 19, 'DE_RC_13B_DOMESTIC', { vendorCountryCode: 'DE', evidenceType: 'rechnung', evidenceReference: 'Bauleistung' });
      await purchase('in-eu-dienst', 500, 19, 'EU_B2B_SERVICE_RC', { vendorCountryCode: 'IE', vendorVatId: 'IE9999999W', evidenceType: 'rechnung', evidenceReference: 'Software-Lizenz' });
      await purchase('in-erwerb', 400, 19, 'EU_IGE_GOODS_RC', { vendorCountryCode: 'NL', vendorVatId: 'NL123456789B01', evidenceType: 'rechnung', evidenceReference: 'Warenlieferung' });
      const manual = await u.raw('POST', '/accounting/journal', { reason: 'Barkauf', reference: 'KB-UStVA', documentDate: '2026-08-15', postingDate: '2026-08-15', bookingText: 'Barkauf Büro', idempotencyKey: randomUUID(), lines: [{ accountNumber: '4930', debitAmount: 119, creditAmount: 0, taxCaseKey: 'DE_STD_19' }, { accountNumber: '1000', debitAmount: 0, creditAmount: 119 }] });
      assert.equal(manual.status, 200, manual.text);
    });
    after(async () => { await u?.close(); });

    test('the live UStVA puts every sale, purchase and free entry into its Kennzahl, with Kz 83 and a drilldown to the entries, and locks nothing', async () => {
      const summary = await ustva('2026-08-01', '2026-08-31');
      const view = summary.kennzahlen;
      assert.deepEqual(kz(view.rows), AUGUST);
      assert.deepEqual(view.rows.filter((row: any) => row.taxKennziffer).map((row: any) => [row.kennziffer, row.taxKennziffer]), [['46', '47'], ['84', '85']]);
      assert.deepEqual([view.outputTaxAmount, view.inputTaxAmount, view.payableAmount], [558, 399, 159]);
      assert.deepEqual(view.issues, []);
      assert.equal(view.rows.find((row: any) => row.kennziffer === '67').label, 'Vorsteuer aus § 13b');
      const bau = (await journal(u)).find((entry) => entry.sourceKey === 'incoming-invoice:in-bau')!;
      const drill = view.sources.filter((source: any) => source.kennziffer === '84');
      assert.deepEqual(drill.map((source: any) => [source.entryId, source.netAmount, source.taxAmount]), [[bau.id, 1000, 190]]);
      assert.ok(view.sources.some((source: any) => source.kennziffer === '66' && source.reference === 'KB-UStVA'), 'the free entry is in Kz 66');
      assert.equal(summary.rows.length > 0, true, 'the tax-case rows stay');
      assert.equal(await statusOf(u, '2026-08'), 'open', 'looking does not lock');
      assert.deepEqual((await ustva('2026-07-01', '2026-07-31')).kennzahlen.rows, [], 'an empty month');
    });

    test('the prepared UStVA has the same Kennzahlen; 2026 is supported and 2027 runs on the latest form, marked as provisional', async () => {
      const prepared = await prepareFor({ period: '2026-08', year: 2026 });
      assert.equal(prepared.status, 200, prepared.text);
      assert.deepEqual(kz(prepared.body.artifact.rows.map((row: any) => ({ ...row, kennziffer: row.kennziffer }))), AUGUST);
      assert.deepEqual([prepared.body.artifact.catalog.taxYear, prepared.body.artifact.catalog.provisional, prepared.body.artifact.submissionReady], [2026, false, false]);
      const later = await prepareFor({ period: '2027-01', year: 2027 });
      assert.equal(later.status, 200, later.text);
      assert.deepEqual([later.body.artifact.catalog.taxYear, later.body.artifact.catalog.provisional, later.body.artifact.catalog.official], [2027, true, false]);
      assert.match(later.body.artifact.catalog.label, /2026.*vorläufig.*2027/);
      assert.equal((await u.raw('POST', '/accounting/tax-exports/prepare', { kind: 'zm', period: '2027-Q1', idempotencyKey: `zm-${randomUUID()}`, reason: 'ZM' })).status, 200, 'ZM 2027');
      assert.equal((await u.raw('POST', '/accounting/tax-exports/prepare', { kind: 'oss', period: '2026-Q3', idempotencyKey: `oss-${randomUUID()}`, reason: 'OSS' })).status, 200, 'OSS 2026');
    });

    test('a tax case without a Kennzahl (§ 25a) is shown as an issue in the live view, and the UStVA is not frozen without it', async () => {
      // A bank receipt booked by hand with the § 25a tax case (the bank workbench lets the user pick any case).
      await importCsv(u, await addBankAccount(u), [{ date: '2026-09-05', amount: 500, counterparty: 'Gebrauchtwagen Käufer', purpose: 'Differenzbesteuerung' }]);
      const tx = await bankTx(u, 'Gebrauchtwagen Käufer');
      const d = await getDraft(u, tx.id);
      await approveDraft(u, d, [{ id: `${d.id}-1`, accountNumber: '1200', debitAmount: 500, creditAmount: 0 }, { id: `${d.id}-2`, accountNumber: '8200', debitAmount: 0, creditAmount: 500, taxCaseKey: 'DE_MARGIN_25A', taxRate: 0, netAmount: 500, taxAmount: 0, grossAmount: 500, evidenceType: 'rechnung', evidenceReference: 'Gebrauchtgegenstand § 25a' }]);
      const margin = await postDraft(u, d.id, { postingDate: d.postingDate });
      assert.ok(margin.body.entry?.id, margin.text);
      const view = (await ustva('2026-09-01', '2026-09-30')).kennzahlen;
      assert.deepEqual(view.issues.map((issue: any) => [issue.code, issue.taxCaseKey]), [['USTVA_KENNZAHL_MISSING', 'DE_MARGIN_25A']]);
      const runs = (await get<any[]>(u, '/accounting/source-runs')).length;
      const refused = await prepareFor({ period: '2026-09', year: 2026 });
      assert.equal(refused.status, 422, refused.text);
      assert.match(refused.body.message, /USTVA_KENNZAHL_MISSING/);
      assert.equal((await get<any[]>(u, '/accounting/source-runs')).length, runs, 'no frozen preparation');
      assert.equal(await statusOf(u, '2026-09'), 'open', 'and no soft lock');
    });

    test('the ZM lists the own EU sales by buyer VAT ID, split into Lieferungen and sonstige Leistungen, never an EU purchase', async () => {
      const zm = await u.raw('POST', '/accounting/tax-exports/prepare', { kind: 'zm', period: '2026-08', idempotencyKey: `zm-${randomUUID()}`, reason: 'ZM' });
      assert.equal(zm.status, 200, zm.text);
      assert.deepEqual(zm.body.artifact.rows.map((row: any) => [row.counterpartyVatId, row.taxCaseKey, row.kind, row.netAmount]), [['ATU12345678', 'EU_B2B_SERVICE_RC', 'sonstige_leistung', 300], ['FR12345678901', 'EU_IGL_GOODS_0', 'lieferung', 200]]);
    });
  });

  describe('UStVA, ZM and DATEV after corrections and bank bookings with a tax case (own tenant)', () => {
    let c: ProHarness;
    const month = today().slice(0, 7);
    const from = `${month}-01`;
    const to = addDays(`${addDays(from, 31).slice(0, 7)}-01`, -1);
    const kennzahlen = async () => (await get<any>(c, `/accounting/vat/summary?from=${from}&to=${to}`)).kennzahlen;
    const kzNow = async () => kz((await kennzahlen()).rows);
    const kz = (positions: Array<{ kennziffer: string; netAmount: number; taxAmount: number }>) => Object.fromEntries(positions.map((row) => [row.kennziffer, [row.netAmount, row.taxAmount]])) as Record<string, [number, number]>;
    /** Kennzahl movement between two snapshots, in cents, only where something moved. */
    const delta = (before: Record<string, [number, number]>, after: Record<string, [number, number]>) => Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])].sort()
      .map((key) => [key, [money((after[key]?.[0] ?? 0) - (before[key]?.[0] ?? 0)), money((after[key]?.[1] ?? 0) - (before[key]?.[1] ?? 0))]] as const)
      .filter(([, [n, t]]) => n !== 0 || t !== 0));
    const correction = (invoiceId: string, kind: 'credit_note' | 'cancellation_invoice', amount?: number) =>
      c.api.documents.chainIssue({ id: randomUUID(), date: today(), dueDate: today(), operation: 'correction', invoiceId, kind, reason: kind === 'credit_note' ? 'Gutschrift' : 'Storno', ...(amount === undefined ? {} : { amount }) } as never) as Promise<any>;
    const mixed = [{ kind: 'item' as const, description: 'Beratung', quantity: 1, price: 1000, total: 1000, taxRate: 19 }, { kind: 'item' as const, description: 'Buch', quantity: 1, price: 100, total: 100, taxRate: 7 }];
    before(async () => { c = await startPro(null, 'pro-ustva-corrections'); });
    after(async () => { await c?.close(); });

    test('a Storno brings Kz 81, 86 and 83 back to where they were before the invoice', async () => {
      const start = await kzNow();
      const invoice = await issue(c, { client: 'Storno UStVA', items: mixed });
      assert.deepEqual(delta(start, await kzNow()), { '81': [1000, 190], '83': [0, 197], '86': [100, 7] }, 'the invoice');
      const storno = await correction(invoice.id, 'cancellation_invoice');
      assert.ok(storno, 'the Stornorechnung is issued');
      assert.deepEqual(delta(start, await kzNow()), {}, 'after the Storno nothing is left');
      const view = await kennzahlen();
      assert.ok(view.sources.some((source: any) => source.kennziffer === '81' && source.netAmount === -1000 && source.taxAmount === -190), 'the drilldown shows the Storno as a reduction');
    });

    test('a partial credit note, a Skonto and a bad debt lower Kz 81 by their net and VAT', async () => {
      const invoice = await issue(c, { client: 'Gutschrift UStVA', items: [mixed[0]!] });
      let start = await kzNow();
      const issued = await correction(invoice.id, 'credit_note', 119);
      const creditId = issued?.id ?? issued?.document?.id;
      const credit = (await journal(c)).find((entry) => entry.sourceKey === `outgoing-correction:${creditId}`)!;
      assert.ok(credit, `the credit note is posted (${JSON.stringify(issued).slice(0, 200)})`);
      const creditNet = credit.lines.find((line) => line.accountNumber === '8400')!.debitAmount;
      assert.equal(creditNet, 100, 'a partial credit note of 119 € gross');
      assert.deepEqual(delta(start, await kzNow()), { '81': [-creditNet, money(-creditNet * 0.19)], '83': [0, money(-creditNet * 0.19)] }, 'the credit note');

      const plain = await draft(c, { client: 'Skonto UStVA', dueDate: addDays(today(), 30) });
      const withSkonto = await c.api.invoices.upsert({ reason: 'stellen', invoice: { ...plain, skonto: { percent: 2, days: 10 }, status: 'open' } as never });
      start = await kzNow();
      const paid = await c.raw('POST', `/invoices/${withSkonto.id}/payments`, { reason: 'Zahlung', payment: { id: randomUUID(), date: today(), amount: 233.24, method: 'Überweisung' } });
      assert.equal(paid.status, 200, paid.text);
      assert.deepEqual(delta(start, await kzNow()), { '81': [-4, -0.76], '83': [0, -0.76] }, 'the Skonto');

      const lost = await issue(c, { client: 'Ausfall UStVA', items: [{ kind: 'item', description: 'Ausfall', quantity: 1, price: 100, total: 100, taxRate: 19 }] });
      start = await kzNow();
      const id = `baddebt-${randomUUID()}`;
      const facts = { legalBasis: '§17 UStG', reason: 'bad_debt', originalDocumentId: lost.id, originalDocumentNumber: lost.number, originalTaxEffectiveDate: lost.date, adjustmentDate: today(), evidenceReference: 'Insolvenz UStVA' };
      const writeOff = await c.raw('POST', '/accounting/closing', { reason: 'Forderungsausfall', commandType: 'bad_debt', sourceId: id, sourceRevision: 'v1', idempotencyKey: `${id}:v1`, input: { effectiveDate: today(), postingDate: today(), period: month, fiscalYear: Number(month.slice(0, 4)), currency: 'EUR', taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }], writeOffGrossAmount: 119, originalDocumentId: lost.id, badDebtExpenseAccount: '2400', facts } });
      assert.equal(writeOff.status, 200, writeOff.text);
      assert.deepEqual(delta(start, await kzNow()), { '81': [-100, -19], '83': [0, -19] }, 'the bad debt');
    });

    test('a bank expense with the tax case Inland 19 % books net and Vorsteuer, counts in Kz 66 and goes to DATEV as one gross row with BU 9', async () => {
      const bank = await addBankAccount(c, 'bank-vorsteuer');
      await importCsv(c, bank, [{ date: today(), amount: -35.7, counterparty: 'Telekom Deutschland', purpose: 'Rechnung 99 Telefon' }]);
      const tx = await bankTx(c, 'Telekom Deutschland');
      const d = await getDraft(c, tx.id);
      const start = await kennzahlen();
      // What the workbench sends: the gross bank amount on the expense line, with the tax case chosen there.
      await approveDraft(c, d, [{ id: `${d.id}-1`, accountNumber: '4920', debitAmount: 35.7, creditAmount: 0, taxCode: 'USt19', taxCaseKey: 'DE_STD_19', taxRate: 19 }, { id: `${d.id}-2`, accountNumber: '1200', debitAmount: 0, creditAmount: 35.7 }] as never);
      const posted = await postDraft(c, d.id, { postingDate: today() });
      assert.equal(posted.status, 200, posted.text);
      const entry = posted.body.entry as JournalEntry;
      assert.deepEqual(entry.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]), [['4920', 30, 0], ['1576', 5.7, 0], ['1200', 0, 35.7]], 'net, Vorsteuer and the bank amount');
      const basis = entry.lines.find((line) => line.accountNumber === '4920')!;
      assert.deepEqual([basis.taxCaseKey, basis.netAmount, basis.taxAmount, basis.grossAmount], ['DE_STD_19', 30, 5.7, 35.7]);
      const view = await kennzahlen();
      assert.deepEqual(delta(kz(start.rows), kz(view.rows)), { '66': [30, 5.7], '83': [0, -5.7] });
      assert.equal(money(view.inputTaxAmount - start.inputTaxAmount), 5.7);
      const rows = await get<Array<{ belegfeld1: string; konto: string; gegenkonto: string; umsatz: number; buSchluessel?: string }>>(c, `/accounting/datev/rows?from=${from}&to=${to}`);
      const datev = rows.filter((row) => row.konto === '4920' || row.konto === '1576');
      assert.deepEqual(datev.map((row) => [row.konto, row.gegenkonto, row.umsatz, row.buSchluessel]), [['4920', '1200', 35.7, '0009']], 'one gross row with the Vorsteuer key');
    });

    test('a payment, a bank booking and a Storno carry readable references into the journal and DATEV Belegfeld 1', async () => {
      const invoice = await issue(c, { client: 'Referenz Kunde', items: [mixed[0]!] });
      const paymentId = randomUUID();
      const paid = await c.raw('POST', `/invoices/${invoice.id}/payments`, { reason: 'Zahlung', payment: { id: paymentId, date: today(), amount: 500, method: 'Überweisung' } });
      assert.equal(paid.status, 200, paid.text);
      const payment = (await journal(c)).find((entry) => entry.sourceType === 'payment' && String(entry.sourceKey).includes(paymentId))!;
      assert.ok(payment, 'the payment is posted');
      assert.equal(payment.reference, invoice.number, 'the payment names the invoice');
      assert.match(payment.bookingText, new RegExp(`${invoice.number}.*Referenz Kunde`), 'and the customer');

      const account = await addBankAccount(c, `bank-ref-${randomUUID().slice(0, 6)}`);
      await importCsv(c, account, [{ date: today(), amount: -50, counterparty: 'Büro Meier', purpose: 'Rechnung 4711 Büromaterial' }]);
      const tx = await bankTx(c, 'Büro Meier');
      const bankDraft = await getDraft(c, tx.id) as Awaited<ReturnType<typeof getDraft>> & { reference?: string };
      assert.notEqual(bankDraft.reference, tx.id, 'no internal id as Beleg');
      assert.doesNotMatch(String(bankDraft.reference ?? ''), /^[0-9a-f]{8}-[0-9a-f]{4}-/, 'no UUID as Beleg');

      const cancelled = await issue(c, { client: 'Referenz Storno', items: [mixed[0]!] });
      const storno = await correction(cancelled.id, 'cancellation_invoice');
      const stornoId = storno?.id ?? storno?.document?.id;
      const stornoEntry = (await journal(c)).find((entry) => entry.sourceKey === `outgoing-correction:${stornoId}`)!;
      assert.match(stornoEntry.bookingText, new RegExp(cancelled.number), 'the Storno names the invoice it cancels');

      const rows = await get<Array<{ belegfeld1: string; konto: string; gegenkonto: string; umsatz: number }>>(c, `/accounting/datev/rows?from=${from}&to=${to}`);
      const paymentRow = rows.find((row) => row.umsatz === 500 && (row.konto === '1200' || row.gegenkonto === '1200'));
      assert.equal(paymentRow?.belegfeld1, invoice.number.replace(/[^\w$&%*+\-/]+/g, '-'), 'DATEV can settle the receivable with the invoice number');
    });

    test('a Storno of an EU supply takes it out of the ZM again', async () => {
      const igl = await issue(c, { client: 'EU Storno', taxMode: 'intra_eu_supply_6a', taxMeta: { buyerCountryCode: 'FR', buyerVatId: 'FR98765432109', destinationVatRate: 20, datevEvidenceType: 'gelangensbestaetigung', datevEvidenceReference: 'GB-S' }, items: [{ kind: 'item', description: 'Ware', quantity: 1, price: 500, total: 500 }] });
      await correction(igl.id, 'cancellation_invoice');
      assert.deepEqual(delta({}, await kzNow())['41'] ?? [0, 0], [0, 0], 'Kz 41 is back to zero');
      // Preparing locks the month softly, so this runs last in this tenant.
      const zm = await c.raw('POST', '/accounting/tax-exports/prepare', { kind: 'zm', period: month, idempotencyKey: `zm-${randomUUID()}`, reason: 'ZM' });
      assert.equal(zm.status, 200, zm.text);
      assert.deepEqual(zm.body.artifact.rows.filter((row: any) => row.counterpartyVatId === 'FR98765432109' && row.netAmount !== 0), [], 'no ZM amount for a cancelled supply');
    });
  });

  describe('official tax filing operations (Pro)', () => {
    test('validate, export and submit refuse an unknown or malformed filing and need the local token', async () => {
      const record = { id: 'gibt-es-nicht', kind: 'euer', periodStart: '2025-01-01', periodEnd: '2025-12-31', sourceHash: 'a'.repeat(64), status: 'frozen' };
      for (const operation of ['validate', 'export', 'submit']) {
        assert.equal((await h.raw('POST', `/tax-filing/${operation}`, { record })).status, 409, `${operation} of an unknown filing`);
        assert.equal((await h.raw('POST', `/tax-filing/${operation}`, { record: { ...record, sourceHash: 'kurz' } })).status, 400, `${operation} with a malformed hash`);
        const anonymous = await fetch(`${h.connection.baseUrl}/api/v1/pro/tax-filing/${operation}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ record }) });
        assert.equal(anonymous.status, 401, `${operation} without the local token`);
      }
      assert.equal((await h.raw('POST', '/tax-filing/explode', { record })).status, 400, 'unknown operation');
      assert.deepEqual((await h.raw('GET', '/tax-filing/records')).body, [], 'nothing was filed');
    });
  });

  describe('fixed assets', () => {
    const asset = (over: Record<string, unknown> = {}) => ({ assetNumber: `A-${randomUUID().slice(0, 6)}`, name: 'Notebook', assetClass: 'IT-Hardware', status: 'aktiv', activationDate: '2026-05-01', acquisitionCost: 1200, usefulLifeYears: 3, depreciationMethod: 'linear', costCenter: 'IT', location: 'Berlin', receiptLinked: true, assetAccountNumber: '0440', ...over });
    const save = (over: Record<string, unknown> = {}, reason = 'Anlage erfasst') => h.raw('POST', '/accounting/assets', { reason, asset: asset(over) });
    const depreciate = (id: string, over: Record<string, unknown> = {}) => h.raw('POST', `/accounting/assets/${id}/depreciation`, { reason: 'Jahres-AfA', postingDate: '2026-12-31', year: 2026, ...over });
    const dispose = (id: string, over: Record<string, unknown> = {}) => h.raw('POST', `/accounting/assets/${id}/dispose`, { reason: 'Verkauf', disposalDate: '2026-12-31', proceeds: 100, taxRate: 0, proceedsAccountNumber: '1200', ...over });

    test('activating posts the acquisition against the creditors; depreciation posts the schedule year once', async () => {
      const created = await save({ assetNumber: 'A-NOTEBOOK' });
      assert.equal(created.status, 200, created.text);
      const a = created.body;
      assert.deepEqual([a.status, a.depreciationMethod, a.acquisitionCost, a.residualValue, a.annualDepreciation, a.acquisitionOffsetAccountNumber], ['aktiv', 'linear', 1200, 1200, 400, '1600']);
      const activation = (await journal(h)).find((entry) => entry.id === a.activationJournalEntryId)!;
      assert.deepEqual(activation.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]), [['0440', 1200, 0], ['1600', 0, 1200]]);
      assertBalanced([activation]);
      const schedule = await get<Array<{ year: number; amount: number; months: number; status: string }>>(h, `/accounting/assets/${a.id}/schedule`);
      assert.deepEqual(schedule.map((entry) => [entry.year, entry.amount, entry.months, entry.status]), [[2026, 266.67, 8, 'planned'], [2027, 400, 12, 'planned'], [2028, 400, 12, 'planned'], [2029, 133.33, 4, 'planned']], 'May start: 8 months in year one, the rest follows, the total is the cost');
      assert.equal(money(schedule.reduce((sum, entry) => sum + entry.amount, 0)), 1200);

      const run = await depreciate(a.id);
      assert.equal(run.status, 200, run.text);
      assert.equal(run.body.scheduleEntry.status, 'posted');
      assert.equal(run.body.asset.residualValue, 933.33);
      const afa = (await journal(h)).find((entry) => entry.id === run.body.journalEntryId)!;
      assert.deepEqual(afa.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]), [['4830', 266.67, 0], ['0440', 0, 266.67]]);
      const entries = (await journal(h)).length;
      const replay = await depreciate(a.id, { reason: 'nochmal' });
      assert.equal(replay.status, 200, replay.text);
      assert.equal(replay.body.journalEntryId, run.body.journalEntryId, 'the same year is never posted twice');
      assert.equal((await journal(h)).length, entries);
      assert.equal((await get<Array<{ status: string }>>(h, `/accounting/assets/${a.id}/schedule`))[0]!.status, 'posted');
      assert.ok((await get<Array<{ assetNumber: string }>>(h, '/accounting/assets')).some((candidate) => candidate.assetNumber === 'A-NOTEBOOK'));
      assert.ok((await h.api.audit.exportCsv()).includes('depreciation_posted') || (await h.api.audit.exportCsv()).includes('Jahres-AfA'), 'depreciation is audited');
    });

    test('the yearly AfA is not booked before the Wirtschaftsjahr ends: a mid-year date is refused and posts nothing', async () => {
      const created = await save();
      assert.equal(created.status, 200, created.text);
      const entries = (await journal(h)).length;
      const early = await depreciate(created.body.id, { postingDate: '2026-06-30' });
      assert.equal(early.status, 400, early.text);
      assert.match(early.body.message, /Ende des Wirtschaftsjahres/);
      assert.equal((await journal(h)).length, entries, 'nothing is posted');
      assert.equal((await get<Array<{ status: string }>>(h, `/accounting/assets/${created.body.id}/schedule`))[0]!.status, 'planned');
    });

    test('the Anlagenspiegel shows opening, additions, disposals, AfA and closing per asset and adds up', async () => {
      type Row = { assetId: string; assetNumber: string; accountNumber: string; opening: number; additions: number; disposals: number; depreciation: number; closing: number };
      const register = (year: number) => get<{ year: number; from: string; to: string; rows: Row[]; totals: Omit<Row, 'assetId' | 'assetNumber' | 'accountNumber'> }>(h, `/accounting/assets/register?year=${year}`);
      const kept = await save();
      const sold = await save();
      assert.equal((await depreciate(kept.body.id)).status, 200);
      assert.equal((await dispose(sold.body.id)).status, 200);
      const pick = (rows: Row[], id: string) => { const row = rows.find((candidate) => candidate.assetId === id)!; return [row.opening, row.additions, row.disposals, row.depreciation, row.closing]; };
      const y2026 = await register(2026);
      assert.deepEqual([y2026.from, y2026.to], ['2026-01-01', '2026-12-31']);
      assert.deepEqual(pick(y2026.rows, kept.body.id), [0, 1200, 0, 266.67, 933.33]);
      assert.deepEqual(pick(y2026.rows, sold.body.id), [0, 1200, 933.33, 266.67, 0], 'the sale books the AfA up to the disposal month and leaves at book value');
      assert.equal(y2026.rows.find((row) => row.assetId === kept.body.id)!.accountNumber, '0440');
      for (const row of y2026.rows) assert.equal(money(row.opening + row.additions - row.disposals - row.depreciation) + 0, row.closing, `${row.assetNumber} adds up`);
      assert.equal(money(y2026.rows.reduce((sum, row) => sum + row.closing, 0)), y2026.totals.closing);
      const y2027 = await register(2027);
      assert.deepEqual(pick(y2027.rows, kept.body.id), [933.33, 0, 0, 0, 933.33], 'the closing of 2026 opens 2027');
      assert.ok(!y2027.rows.some((row) => row.assetId === sold.body.id), 'a disposed asset is gone from the next year');
      assert.equal((await h.raw('GET', '/accounting/assets/register')).status, 400, 'the year is required');
    });

    test('the journal route cannot reverse the entries an asset owns', async () => {
      const created = await save({ assetNumber: 'A-OWNED' });
      const run = await depreciate(created.body.id);
      assert.equal(run.status, 200, run.text);
      for (const entryId of [created.body.activationJournalEntryId, run.body.journalEntryId]) {
        const refusedReversal = await h.raw('POST', `/accounting/journal/${entryId}/reverse`, { reason: 'am Anlagenbuch vorbei' });
        assert.equal(refusedReversal.status, 409, refusedReversal.text);
        assert.match(refusedReversal.body.message, /ASSET_REVERSAL_REQUIRED/);
        assert.equal((await get<JournalEntry>(h, `/accounting/journal/${entryId}`)).status, 'posted');
      }
    });

    test('a low-value asset is written off in full in its first year', async () => {
      const created = await save({ assetNumber: 'A-GWG', name: 'Monitor', acquisitionCost: 800, usefulLifeYears: undefined, assetClass: 'Büromöbel', activationDate: '2026-07-15' });
      assert.equal(created.status, 200, created.text);
      assert.equal(created.body.depreciationMethod, 'gwg', 'the method is normalised to GWG');
      const schedule = await get<Array<{ year: number; amount: number }>>(h, `/accounting/assets/${created.body.id}/schedule`);
      assert.deepEqual(schedule.map((entry) => [entry.year, entry.amount]), [[2026, 800]]);
      const run = await depreciate(created.body.id);
      assert.equal(run.body.asset.residualValue, 0);
      assert.equal(run.body.asset.status, 'voll_abgeschrieben');
    });

    test('assets are validated: cost, life, account, status, reason and the soft-lock override', async () => {
      const entries = (await journal(h)).length;
      const cases: Array<[string, Record<string, unknown>, number]> = [
        ['a negative cost', { acquisitionCost: -1 }, 400],
        ['a zero useful life', { usefulLifeYears: 0 }, 400],
        ['a fractional useful life', { usefulLifeYears: 2.5 }, 400],
        ['an unknown depreciation method', { depreciationMethod: 'degressiv' }, 400],
        ['an unknown status', { status: 'verschwunden' }, 400],
        ['an override without a reason', { softLockOverride: true }, 400],
      ];
      for (const [label, over, status] of cases) assert.equal((await save(over)).status, status, label);
      assert.equal((await save({}, ' ')).status, 400, 'reason');
      refused('an asset on an account that is not in the chart', await save({ assetAccountNumber: '99999' }));
      assert.equal((await journal(h)).length, entries, 'nothing was posted by the refused requests');
    });

    test('an asset that has been posted cannot change its status or cost in place', async () => {
      const created = await save({ assetNumber: 'A-FROZEN' });
      const id = created.body.id;
      const entries = (await journal(h)).length;
      const renamed = await h.raw('POST', '/accounting/assets', { reason: 'Umbenannt', asset: { ...asset({ assetNumber: 'A-FROZEN' }), id, name: 'Umbenannter Laptop' } });
      assert.equal(renamed.status, 200, renamed.text);
      assert.equal(renamed.body.name, 'Umbenannter Laptop');
      assert.equal(renamed.body.activationJournalEntryId, created.body.activationJournalEntryId, 'the activation is kept');
      assert.equal((await journal(h)).length, entries, 'renaming posts nothing');
      const status = await h.raw('POST', '/accounting/assets', { reason: 'Stillgelegt', asset: { ...asset({ assetNumber: 'A-FROZEN' }), id, status: 'stillgelegt' } });
      refused('a status change of a posted asset', status);
      const cost = await h.raw('POST', '/accounting/assets', { reason: 'Preis geändert', asset: { ...asset({ assetNumber: 'A-FROZEN' }), id, acquisitionCost: 2000 } });
      refused('a cost change of a posted asset', cost);
      assert.equal((await get<Array<{ id: string; acquisitionCost: number }>>(h, '/accounting/assets')).find((candidate) => candidate.id === id)!.acquisitionCost, 1200);
    });

    test('depreciation is refused for a year without schedule entry, an impossible date and an unknown asset', async () => {
      const created = await save({ assetNumber: 'A-AFA-NEG' });
      const entries = (await journal(h)).length;
      for (const [label, over] of [['a year outside the schedule', { year: 2040, postingDate: '2040-12-31' }], ['an impossible date', { postingDate: '2026-02-30' }], ['no reason', { reason: ' ' }], ['an override without reason', { softLockOverride: true }]] as const) {
        const response = await depreciate(created.body.id, over as Record<string, unknown>);
        assert.ok(response.status >= 400 && response.status < 500, `${label}: ${response.status} ${response.text.slice(0, 100)}`);
      }
      assert.equal((await depreciate('no-such-asset')).status, 404);
      assert.equal((await journal(h)).length, entries);
    });

    test('a disposal books proceeds against the residual book value, retries idempotently and ends the asset', async () => {
      const created = await save({ assetNumber: 'A-SOLD', usefulLifeYears: 2, activationDate: '2026-01-01' });
      const id = created.body.id;
      assert.equal((await depreciate(id)).status, 200);
      const sold = await dispose(id);
      assert.equal(sold.status, 200, sold.text);
      assert.deepEqual([sold.body.residualBookValue, sold.body.gainLoss, sold.body.asset.status], [600, -500, 'verkauft']);
      const entry = (await journal(h)).find((candidate) => candidate.id === sold.body.journalEntryId)!;
      assert.deepEqual(entry.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]).sort(), [['0440', 0, 600], ['1200', 100, 0], ['2310', 500, 0]]);
      assertBalanced([entry]);
      const schedule = await get<Array<{ year: number; status: string }>>(h, `/accounting/assets/${id}/schedule`);
      assert.deepEqual(schedule.map((row) => [row.year, row.status]), [[2026, 'posted'], [2027, 'cancelled']]);
      const entries = (await journal(h)).length;
      const retry = await dispose(id, { proceeds: 999 });
      assert.equal(retry.body.journalEntryId, sold.body.journalEntryId, 'a retry returns the recorded disposal');
      assert.equal((await journal(h)).length, entries);
      assert.equal((await dispose('no-such-asset')).status, 404);
      const draftAsset = await save({ assetNumber: 'A-ENTWURF', status: 'entwurf', receiptLinked: false });
      const refusedDraft = await dispose(draftAsset.body.id);
      refused('the disposal of a draft asset', refusedDraft);
      assert.equal((await dispose(id, { reason: ' ' })).status, 400);
    });

    test('a sale at a book loss goes to DATEV with the VAT on the proceeds: one gross row with BU 3 against the asset, the loss without a key', async () => {
      const number = `A-LOSS-${randomUUID().slice(0, 4)}`;
      const created = await save({ assetNumber: number, usefulLifeYears: 1, activationDate: '2026-01-01', acquisitionCost: 10800 });
      assert.equal(created.status, 200, created.text);
      const sold = await dispose(created.body.id, { disposalDate: '2026-01-31', proceeds: 8000, taxRate: 19 });
      assert.equal(sold.status, 200, sold.text);
      const entry = (await journal(h)).find((candidate) => candidate.id === sold.body.journalEntryId)!;
      const residual = sold.body.residualBookValue as number;
      assert.deepEqual(entry.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]).sort(), [['0440', 0, residual], ['1200', 9520, 0], ['1776', 0, 1520], ['2310', money(residual - 8000), 0]].sort());
      const rows = (await get<Array<{ belegfeld1: string; konto: string; gegenkonto: string; umsatz: number; buSchluessel?: string }>>(h, '/accounting/datev/rows?from=2026-01-01&to=2026-01-31')).filter((row) => row.belegfeld1 === number && row.konto !== '4830' && row.gegenkonto !== '1600');
      assert.deepEqual(rows.map((row) => [row.konto, row.gegenkonto, row.umsatz, row.buSchluessel ?? null]).sort(), [['1200', '0440', 9520, '0003'], ['2310', '0440', money(residual - 8000), null]].sort(), 'DATEV computes the 1.520 € USt from the proceeds, not from the loss');
    });

    test('a sale to a customer runs through an outgoing invoice: the invoice books revenue, VAT and the open item, the disposal only the book value', async () => {
      const number = `A-SALE-${randomUUID().slice(0, 4)}`;
      const created = await save({ assetNumber: number, usefulLifeYears: 1, activationDate: '2026-01-01', acquisitionCost: 1200 });
      assert.equal(created.status, 200, created.text);
      const assetId = created.body.id as string;
      const sale = (over: Record<string, unknown> = {}) => draft(h, { client: 'Käufer GmbH', date: '2026-01-31', items: [{ kind: 'item', description: `Verkauf Anlage ${number} Notebook`, quantity: 1, price: 1500, total: 1500, taxRate: 19 }], taxMeta: { assetSaleAssetId: assetId } as never, ...over });

      const plain = await draft(h, { client: 'Käufer GmbH', date: '2026-01-31', items: [{ kind: 'item', description: 'Beratung', quantity: 1, price: 1500, total: 1500, taxRate: 19 }] });
      refused('an invoice that is not the sale of this asset', await dispose(assetId, { disposalDate: '2026-01-31', proceeds: 1500, taxRate: undefined, proceedsAccountNumber: undefined, saleInvoiceId: plain.id }));
      const invoice = await sale();
      refused('proceeds that differ from the invoice', await dispose(assetId, { disposalDate: '2026-01-31', proceeds: 1400, taxRate: undefined, proceedsAccountNumber: undefined, saleInvoiceId: invoice.id }));

      const sold = await dispose(assetId, { disposalDate: '2026-01-31', proceeds: 1500, taxRate: undefined, proceedsAccountNumber: undefined, saleInvoiceId: invoice.id });
      assert.equal(sold.status, 200, sold.text);
      assert.equal(sold.body.gainLoss, money(1500 - sold.body.residualBookValue));
      const disposal = (await journal(h)).find((entry) => entry.id === sold.body.journalEntryId)!;
      const residual = sold.body.residualBookValue as number;
      assert.deepEqual(disposal.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]).sort(), [['0440', 0, residual], ['2315', residual, 0]].sort(), 'no proceeds, no VAT: those come with the invoice');

      const issued = await h.api.invoices.upsert({ reason: 'Rechnung gestellt', invoice: { ...invoice, status: 'open' } as never });
      const posted = (await invoiceEntry(h, issued.id))!;
      assert.deepEqual(posted.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]).sort(), [['1400', 1785, 0], ['1776', 0, 285], ['8829', 0, 1500]].sort(), 'revenue on the asset-sale account, VAT from the tax case');
      assert.ok((await openItems(h)).some((item) => item.sourceId === issued.id && item.partyType === 'debtor'), 'the buyer owes the invoice in OPOS');
      assert.equal((await journal(h)).filter((entry) => entry.lines.some((line) => line.accountNumber === '8829' && line.creditAmount === 1500)).length, 1, 'the proceeds are booked once');
    });

    // A sale draft as the Pro UI creates it: one line "Verkauf Anlage …" and the asset marker in taxMeta.
    const saleOf = (number: string, assetId: string, proceeds: number, date = '2026-01-31') => draft(h, { client: 'Käufer GmbH', date, items: [{ kind: 'item', description: `Verkauf Anlage ${number} Notebook`, quantity: 1, price: proceeds, total: proceeds, taxRate: 19 }], taxMeta: { assetSaleAssetId: assetId } as never });
    const sellTo = (assetId: string, invoiceId: string, proceeds: number, date = '2026-01-31') => dispose(assetId, { disposalDate: date, proceeds, taxRate: undefined, proceedsAccountNumber: undefined, saleInvoiceId: invoiceId });
    const assetOf = async (id: string) => (await get<Array<{ id: string; status: string; disposalDate?: string | null }>>(h, '/accounting/assets')).find((row) => row.id === id)!;
    const scheduleOf = async (id: string) => (await get<Array<{ year: number; amount: number; months: number; status: string }>>(h, `/accounting/assets/${id}/schedule`)).map((row) => [row.year, row.amount, row.months, row.status]);
    const registerRow = async (id: string, year = 2026) => { const row = (await get<{ rows: Array<{ assetId: string; opening: number; additions: number; disposals: number; depreciation: number; closing: number }> }>(h, `/accounting/assets/register?year=${year}`)).rows.find((candidate) => candidate.assetId === id)!; return [row.opening, row.additions, row.disposals, row.depreciation, row.closing]; };

    test('a deleted sale draft takes the sale back: AfA and book value reversed, the asset active and planned again, the year-end AfA possible', async () => {
      const number = `A-UNDO-${randomUUID().slice(0, 4)}`;
      const created = await save({ assetNumber: number, usefulLifeYears: 1, activationDate: '2026-01-01', acquisitionCost: 1200 });
      const assetId = created.body.id as string;
      const invoice = await saleOf(number, assetId, 1500);
      const sold = await sellTo(assetId, invoice.id, 1500);
      assert.equal(sold.status, 200, sold.text);
      const afa = (await journal(h)).find((entry) => entry.bookingText === `AfA ${number} 2026 bis Abgang`)!;
      assert.ok(afa, 'the sale booked the AfA up to January');

      await h.api.invoices.delete({ id: invoice.id, reason: 'Verkauf geplatzt' });
      const asset = await assetOf(assetId);
      assert.deepEqual([asset.status, asset.disposalDate ?? null], ['aktiv', null], 'the asset is on the books again');
      const entries = await journal(h);
      assert.deepEqual([entries.find((entry) => entry.id === sold.body.journalEntryId)!.status, entries.find((entry) => entry.id === afa.id)!.status], ['reversed', 'reversed'], 'book value and AfA of the sale are reversed');
      assert.deepEqual(await scheduleOf(assetId), [[2026, 1200, 12, 'planned']], 'the plan is back');
      assert.deepEqual(await registerRow(assetId), [0, 1200, 0, 0, 1200], 'the Anlagenspiegel shows no disposal and no AfA');
      assert.equal(money(net((await journal(h)).filter((entry) => entry.reference === number), '0440')), 1200, 'the asset account carries the cost again');

      const yearEnd = await depreciate(assetId);
      assert.equal(yearEnd.status, 200, yearEnd.text);
      assert.deepEqual(await registerRow(assetId), [0, 1200, 0, 1200, 0], 'the year-end AfA after the undo');
      await assertLedgerConsistent(h);
    });

    test('a Storno of the issued sale invoice takes the sale back on the same revenue account; the asset can be sold again', async () => {
      const number = `A-STORNO-${randomUUID().slice(0, 4)}`;
      const created = await save({ assetNumber: number, usefulLifeYears: 1, activationDate: '2026-01-01', acquisitionCost: 1200 });
      const assetId = created.body.id as string;
      const invoice = await saleOf(number, assetId, 1500);
      const sold = await sellTo(assetId, invoice.id, 1500);
      assert.equal(sold.status, 200, sold.text);
      const issued = await h.api.invoices.upsert({ reason: 'Rechnung gestellt', invoice: { ...invoice, status: 'open' } as never });
      const revenue = (entry: JournalEntry) => entry.lines.filter((line) => line.taxCaseKey).map((line) => line.accountNumber);
      const original = (await invoiceEntry(h, issued.id))!;

      const storno = await h.api.documents.chainIssue({ id: randomUUID(), date: '2026-02-10', dueDate: '2026-02-10', operation: 'correction', invoiceId: issued.id, kind: 'cancellation_invoice', reason: 'Käufer tritt zurück' } as never) as { id: string; number: string };
      const cancellation = (await journal(h)).find((entry) => entry.bookingText === `Stornorechnung ${storno.number} zu ${issued.number}`)!;
      assert.deepEqual(revenue(cancellation), revenue(original), 'the Storno takes the proceeds off the account the sale put them on');
      assert.deepEqual(revenue(original), ['8829']);
      const asset = await assetOf(assetId);
      assert.deepEqual([asset.status, asset.disposalDate ?? null], ['aktiv', null]);
      assert.equal((await journal(h)).find((entry) => entry.id === sold.body.journalEntryId)!.status, 'reversed');
      assert.deepEqual(await scheduleOf(assetId), [[2026, 1200, 12, 'planned']]);

      const again = await dispose(assetId, { disposalDate: '2026-03-31', proceeds: 0 });
      assert.equal(again.status, 200, again.text);
      assert.notEqual(again.body.journalEntryId, sold.body.journalEntryId, 'a new disposal, not the reversed one');
      assert.equal(again.body.asset.status, 'stillgelegt');
      await assertLedgerConsistent(h);
    });

    test('a sale at residual book value 0 is booked once; the same call again returns it, a second sale invoice is refused in words', async () => {
      const number = `A-ZERO-${randomUUID().slice(0, 4)}`;
      const created = await save({ assetNumber: number, usefulLifeYears: 1, activationDate: '2025-01-01', acquisitionCost: 1200 });
      const assetId = created.body.id as string;
      assert.equal((await depreciate(assetId, { year: 2025, postingDate: '2025-12-31' })).status, 200);
      const invoice = await saleOf(number, assetId, 50);
      const sold = await sellTo(assetId, invoice.id, 50);
      assert.equal(sold.status, 200, sold.text);
      assert.deepEqual([sold.body.residualBookValue, sold.body.gainLoss, sold.body.journalEntryId, sold.body.asset.status], [0, 50, '', 'verkauft']);
      const entries = (await journal(h)).length;
      const retry = await sellTo(assetId, invoice.id, 50);
      assert.equal(retry.status, 200, retry.text);
      assert.deepEqual([retry.body.residualBookValue, retry.body.gainLoss, retry.body.journalEntryId], [0, 50, '']);
      const second = await saleOf(number, assetId, 50);
      const refusedSecond = await sellTo(assetId, second.id, 50);
      assert.equal(refusedSecond.status, 409, refusedSecond.text);
      assert.match(refusedSecond.body.message, /bereits/);
      assert.doesNotMatch(refusedSecond.body.message, /^[A-Z_]+$/);
      assert.equal((await journal(h)).length, entries, 'nothing more is booked');
    });

    test('a disposal during the year books the AfA up to the disposal month, then the disposal; with an earlier year unposted it is refused', async () => {
      const created = await save({ assetNumber: 'A-MIDYEAR', usefulLifeYears: 3, activationDate: '2026-01-01', acquisitionCost: 3600 });
      const id = created.body.id;
      const sold = await dispose(id, { disposalDate: '2026-06-30', proceeds: 0 });
      assert.equal(sold.status, 200, sold.text);
      assert.deepEqual([sold.body.residualBookValue, sold.body.gainLoss, sold.body.asset.status], [3000, -3000, 'stillgelegt'], 'six of 36 months written off');
      const entries = await journal(h);
      const afa = entries.find((entry) => entry.bookingText === 'AfA A-MIDYEAR 2026 bis Abgang')!;
      assert.deepEqual([afa.postingDate, ...afa.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount])], ['2026-06-30', ['4830', 600, 0], ['0440', 0, 600]]);
      const disposal = entries.find((entry) => entry.id === sold.body.journalEntryId)!;
      assert.deepEqual(disposal.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]).sort(), [['0440', 0, 3000], ['2310', 3000, 0]]);
      const schedule = await get<Array<{ year: number; amount: number; months: number; status: string }>>(h, `/accounting/assets/${id}/schedule`);
      assert.deepEqual(schedule.map((row) => [row.year, row.amount, row.months, row.status]), [[2026, 600, 6, 'posted'], [2027, 1200, 12, 'cancelled'], [2028, 1200, 12, 'cancelled']]);
      assert.equal(net(entries, '0440') >= 0, true);

      const late = await save({ assetNumber: 'A-LATE', usefulLifeYears: 3, activationDate: '2026-01-01', acquisitionCost: 3600 });
      const refusedLate = await dispose(late.body.id, { disposalDate: '2027-03-31', proceeds: 0 });
      refused('a disposal in 2027 while the AfA 2026 is unposted', refusedLate);
      assert.match(refusedLate.text, /ASSET_DISPOSAL_PROJECTION_MISMATCH/);
    });

    test('the AfA of a year is booked inside that year; a past year without AfA shows in the health', async () => {
      const created = await save({ assetNumber: 'A-PAST', usefulLifeYears: 5, activationDate: '2025-03-01', acquisitionCost: 6000 });
      assert.equal(created.status, 200, created.text);
      const outside = await depreciate(created.body.id, { year: 2025, postingDate: '2026-01-10' });
      assert.equal(outside.status, 400, outside.text);
      assert.match(outside.text, /INVALID_DEPRECIATION_POSTING_DATE/);
      const health = await get<{ missingDepreciation?: Array<{ assetNumber: string; year: number }> }>(h, '/accounting/health');
      assert.ok(health.missingDepreciation?.some((row) => row.assetNumber === 'A-PAST' && row.year === 2025), JSON.stringify(health.missingDepreciation));
      assert.ok(!health.missingDepreciation?.some((row) => row.assetNumber === 'A-PAST' && row.year === 2026), 'the running year is not missing yet');
    });

    test('computer hardware with a 1-year life is written off in the year of acquisition; other classes still spread', async () => {
      const it = await save({ assetNumber: 'A-IT1', assetClass: 'IT-Hardware', usefulLifeYears: 1, activationDate: '2026-05-01', acquisitionCost: 1200 });
      assert.equal(it.status, 200, it.text);
      assert.deepEqual((await get<Array<{ year: number; amount: number }>>(h, `/accounting/assets/${it.body.id}/schedule`)).map((row) => [row.year, row.amount]), [[2026, 1200]]);
      const desk = await save({ assetNumber: 'A-DESK1', assetClass: 'Büromöbel', usefulLifeYears: 1, activationDate: '2026-05-01', acquisitionCost: 1200 });
      assert.deepEqual((await get<Array<{ year: number; amount: number }>>(h, `/accounting/assets/${desk.body.id}/schedule`)).map((row) => [row.year, row.amount]), [[2026, 800], [2027, 400]]);
    });

    test('degressive AfA: three times linear, at most 30 %, on the book value; refused for additions outside the legal windows', async () => {
      const machine = await save({ assetNumber: 'A-DEGR', assetClass: 'Maschinen', usefulLifeYears: 10, activationDate: '2026-01-01', acquisitionCost: 10000, depreciationMethod: 'degressive', assetAccountNumber: '0210' });
      assert.equal(machine.status, 200, machine.text);
      assert.equal(machine.body.depreciationMethod, 'degressive');
      const schedule = await get<Array<{ year: number; amount: number }>>(h, `/accounting/assets/${machine.body.id}/schedule`);
      assert.deepEqual(schedule.slice(0, 3).map((row) => [row.year, row.amount]), [[2026, 3000], [2027, 2100], [2028, 1470]], '30 % of the book value');
      assert.equal(money(schedule.reduce((sum, row) => sum + row.amount, 0)), 10000);
      assert.equal(schedule.at(-1)!.year, 2035, 'the useful life still ends after ten years (switch to linear)');
      const old = await save({ assetNumber: 'A-DEGR-OLD', assetClass: 'Maschinen', usefulLifeYears: 10, activationDate: '2024-03-01', acquisitionCost: 10000, depreciationMethod: 'degressive', assetAccountNumber: '0210' });
      refused('degressive AfA for a 2024 addition', old);
      assert.match(old.text, /ASSET_DEGRESSIVE_NOT_ALLOWED/);
    });

    test('AfA years follow the Wirtschaftsjahr', async () => {
      const settings = await h.api.settings.get();
      await h.api.settings.set({ settings: { ...settings, businessReportingProfile: { jurisdiction: 'DE', legalForm: 'gmbh', profitDetermination: 'double_entry', hgbSizeClass: 'small', fiscalYearStart: '04-01', chart: 'SKR03', vatMethod: 'soll' } } } as never);
      try {
        const created = await save({ assetNumber: 'A-WJ', usefulLifeYears: 3, activationDate: '2026-05-01', acquisitionCost: 1200 });
        assert.equal(created.status, 200, created.text);
        const schedule = await get<Array<{ year: number; amount: number; months: number }>>(h, `/accounting/assets/${created.body.id}/schedule`);
        assert.deepEqual(schedule.map((row) => [row.year, row.amount, row.months]), [[2026, 366.67, 11], [2027, 400, 12], [2028, 400, 12], [2029, 33.33, 1]], 'May 2026 to March 2027 is the first Wirtschaftsjahr');
        assert.equal((await depreciate(created.body.id, { year: 2026, postingDate: '2027-04-01' })).status, 400, 'April 2027 belongs to the next Wirtschaftsjahr');
        assert.equal((await depreciate(created.body.id, { year: 2026, postingDate: '2027-03-31' })).status, 200);
      } finally {
        await h.api.settings.set({ settings: { ...settings, businessReportingProfile: { jurisdiction: 'DE', legalForm: 'gmbh', profitDetermination: 'double_entry', hgbSizeClass: 'small', fiscalYearStart: '01-01', chart: 'SKR03', vatMethod: 'soll' } } } as never);
      }
    });

    test('selling an asset after full depreciation books the proceeds as a gain without crediting the asset account', async () => {
      const created = await save({ assetNumber: 'A-GAIN', usefulLifeYears: 1, activationDate: '2026-01-01', acquisitionCost: 1000 });
      const id = created.body.id;
      assert.equal((await depreciate(id)).body.asset.status, 'voll_abgeschrieben');
      const sold = await dispose(id, { disposalDate: '2027-01-15', proceeds: 100 });
      assert.equal(sold.status, 200, sold.text);
      assert.deepEqual([sold.body.residualBookValue, sold.body.gainLoss, sold.body.asset.status], [0, 100, 'verkauft']);
      const entry = (await journal(h)).find((candidate) => candidate.id === sold.body.journalEntryId)!;
      assert.deepEqual(entry.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]).sort(), [['1200', 100, 0], ['8829', 0, 100]]);
      assertBalanced([entry]);
    });

    test('an asset can be activated from a posted incoming invoice without posting the acquisition twice', async () => {
      const id = `in-asset-${randomUUID().slice(0, 6)}`;
      await h.raw('POST', '/accounting/incoming-invoices', { reason: 'Eingang', invoice: { id, vendorId: 'v-reports', number: `ER-${id}`, invoiceDate: '2026-02-02', dueDate: '2026-03-02', netAmount: 1000, taxAmount: 190, grossAmount: 1190, status: 'open', taxRate: 19, lines: [{ id: `l-${id}`, incomingInvoiceId: id, position: 0, description: 'Maschine', quantity: 1, unitPrice: 1000, netAmount: 1000, taxRate: 19, taxAmount: 190, grossAmount: 1190, assetAccountNumber: '0440' }] } });
      assert.equal((await h.raw('POST', '/accounting/incoming-invoices/post', { invoiceId: id, reason: 'gebucht' })).body.status, 'ready');
      const source = (await journal(h)).find((entry) => entry.sourceKey === `incoming-invoice:${id}`)!;
      assert.deepEqual(source.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]), [['0440', 1000, 0], ['1576', 190, 0], ['1600', 0, 1190]]);
      const entries = (await journal(h)).length;
      const mismatch = await save({ assetNumber: 'A-MISMATCH', acquisitionCost: 900, sourceIncomingInvoiceId: id });
      refused('an activation whose cost is not on the source invoice', mismatch);
      assert.equal((await journal(h)).length, entries);
      const activated = await save({ assetNumber: 'A-MASCHINE', name: 'Maschine', acquisitionCost: 1000, sourceIncomingInvoiceId: id, assetClass: 'Maschinen', usefulLifeYears: 10 });
      assert.equal(activated.status, 200, activated.text);
      assert.equal(activated.body.activationJournalEntryId, source.id, 'the invoice entry is the activation');
      assert.equal((await journal(h)).length, entries, 'no second acquisition entry');
      const reverse = await h.raw('POST', '/accounting/documents/reverse', { reason: 'Storno der Anlagenrechnung', documentType: 'incoming_invoice', documentId: id });
      assert.equal(reverse.status, 409, 'the source invoice of an asset cannot be reversed behind the asset');
      assert.match(reverse.body.message, /ASSET_CORRECTION_REQUIRED/);
      assert.equal((await journal(h)).length, entries);
    });
  });

  describe('settlement, standalone postings, corrections and the year-end', () => {
    const key = () => randomUUID();
    const closing = (body: Record<string, unknown>) => h.raw('POST', '/accounting/closing', { reason: 'Abschlussbuchung', ...body });
    const standalone = (id: string, over: Record<string, unknown> = {}, lines?: unknown) => ({
      command: 'source_fact', sourceId: id, sourceRevision: 'v1', idempotencyKey: `${id}:v1`,
      input: {
        sourceType: 'standalone_source', sourceId: id, sourceRevision: 'v1', effectiveDate: '2026-03-31', postingDate: '2026-03-31', period: '2026-03', fiscalYear: 2026, currency: 'EUR', bookingText: 'Abschlussbuchung Test',
        lines: lines ?? [{ accountNumber: '4930', debitAmount: 40, creditAmount: 0 }, { accountNumber: '1200', debitAmount: 0, creditAmount: 40 }], ...over,
      },
    });
    const breakdown = (gross: number) => [{ rate: 19, netAmount: money(gross / 1.19), taxAmount: money(gross - gross / 1.19), grossAmount: gross }];
    const itemOf = async (invoiceId: string) => (await openItems(h)).find((candidate) => candidate.sourceId === invoiceId)!;

    test('a standalone source fact posts once, replays by its key and conflicts when the same key brings other lines', async () => {
      const id = `fact-${key()}`;
      const entries = (await journal(h)).length;
      const first = await closing(standalone(id));
      assert.equal(first.status, 200, first.text);
      assert.equal(first.body.replayed, false);
      assert.equal(first.body.run.status, 'posted');
      const entry = (await journal(h)).find((candidate) => candidate.id === first.body.run.journalEntryId)!;
      assert.deepEqual(entry.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]), [['4930', 40, 0], ['1200', 0, 40]]);
      assert.equal(entry.sourceType, 'standalone_source');
      assert.equal(entry.postingDate, '2026-03-31');
      assert.equal((await journal(h)).length, entries + 1);
      const replay = await closing(standalone(id));
      assert.equal(replay.body.replayed, true);
      assert.equal(replay.body.run.id, first.body.run.id);
      assert.equal((await journal(h)).length, entries + 1, 'a replay posts nothing');
      const conflict = await closing(standalone(id, {}, [{ accountNumber: '4930', debitAmount: 41, creditAmount: 0 }, { accountNumber: '1200', debitAmount: 0, creditAmount: 41 }]));
      assert.equal(conflict.status, 409, conflict.text);
      const run = await get<any>(h, `/accounting/source-runs/${first.body.run.id}`);
      assert.deepEqual([run.status, run.sourceId, run.journalEntryId], ['posted', id, entry.id]);
      assert.ok((await get<any[]>(h, '/accounting/source-runs')).some((candidate) => candidate.id === first.body.run.id));
      assert.equal((await h.raw('GET', '/accounting/source-runs/nope')).status, 404);
    });

    test('a source fact with an unknown account, a bad period or without a key posts nothing', async () => {
      const entries = (await journal(h)).length;
      const runs = (await get<any[]>(h, '/accounting/source-runs')).filter((run) => run.status === 'posted').length;
      const unknown = await closing(standalone(`fact-${key()}`, {}, [{ accountNumber: '99999', debitAmount: 5, creditAmount: 0 }, { accountNumber: '1200', debitAmount: 0, creditAmount: 5 }]));
      assert.ok([409, 422].includes(unknown.status), unknown.text);
      assert.match(unknown.body.message, /UNKNOWN_ACCOUNT/);
      const unbalanced = await closing(standalone(`fact-${key()}`, {}, [{ accountNumber: '4930', debitAmount: 5, creditAmount: 0 }, { accountNumber: '1200', debitAmount: 0, creditAmount: 4 }]));
      assert.ok(unbalanced.status >= 400 || unbalanced.body.run?.status === 'rejected', `an unbalanced fact: ${unbalanced.status} ${unbalanced.text.slice(0, 160)}`);
      const wrongPeriod = await closing(standalone(`fact-${key()}`, { period: '2026-04' }));
      assert.ok(wrongPeriod.status >= 400 || wrongPeriod.body.run?.status === 'rejected', `a period that does not contain the posting date: ${wrongPeriod.status}`);
      assert.equal((await closing({ ...standalone(`fact-${key()}`), idempotencyKey: '' })).status, 400);
      assert.equal((await closing({ ...standalone(`fact-${key()}`), reason: ' ' })).status, 400);
      assert.equal((await closing({ command: 'teleport', idempotencyKey: key(), input: {} })).status, 400);
      assert.equal((await journal(h)).length, entries, 'no entry');
      assert.equal((await get<any[]>(h, '/accounting/source-runs')).filter((run) => run.status === 'posted').length, runs, 'no run was posted by the refused facts');
    });

    test('a discount (Skonto) books gewährte Skonti, reduces VAT and the open item by the discount; a discount above the balance is refused', async () => {
      const invoice = await issue(h, { client: 'Skonto GmbH', date: '2026-03-02', dueDate: '2026-03-16' });
      const skonto = (amount: number, id = `skonto-${key()}`) => closing({ commandType: 'skonto', sourceId: id, sourceRevision: 'v1', idempotencyKey: `${id}:v1`, input: { effectiveDate: '2026-03-20', postingDate: '2026-03-20', period: '2026-03', fiscalYear: 2026, currency: 'EUR', taxBreakdown: breakdown(GROSS), skontoAmount: amount, originalDocumentId: invoice.id } });
      const response = await skonto(11.9);
      assert.equal(response.status, 200, response.text);
      const entry = (await journal(h)).find((candidate) => candidate.id === response.body.run.journalEntryId)!;
      assertBalanced([entry]);
      assert.equal(entry.lines.reduce((sum, line) => sum + (line.accountNumber === '1400' ? line.creditAmount : 0), 0), 11.9, 'the receivable is reduced by the gross discount');
      assert.equal(money(entry.lines.reduce((sum, line) => sum + (line.accountNumber === '8736' ? line.debitAmount : 0), 0) + entry.lines.reduce((sum, line) => sum + (line.accountNumber === '1776' ? line.debitAmount : 0), 0)), 11.9, 'gewährte Skonti and output VAT take the other side');
      assert.ok(!entry.lines.some((line) => line.accountNumber === '8400'), 'the revenue account itself stays untouched');
      const item = await itemOf(invoice.id);
      assert.deepEqual([item.status, item.allocatedAmount, item.residualAmount], ['partially_paid', 11.9, 226.1]);
      const entries = (await journal(h)).length;
      const tooMuch = await skonto(500);
      assert.equal(tooMuch.status, 409, tooMuch.text);
      assert.match(tooMuch.body.message, /SETTLEMENT_EXCEEDS_OPEN_ITEM/);
      assert.equal((await journal(h)).length, entries);
      assert.equal((await itemOf(invoice.id)).allocatedAmount, 11.9);
      const noOriginal = await closing({ commandType: 'skonto', sourceId: `skonto-${key()}`, sourceRevision: 'v1', idempotencyKey: key(), input: { effectiveDate: '2026-03-20', postingDate: '2026-03-20', period: '2026-03', fiscalYear: 2026, currency: 'EUR', taxBreakdown: breakdown(GROSS), skontoAmount: 5 } });
      assert.ok(noOriginal.status >= 400 && noOriginal.status < 500, `a discount without an original document: ${noOriginal.status}`);
    });

    test('settling advances against a final invoice stays within one customer and within the final invoice', async () => {
      const final = await issue(h, { client: 'Anzahlung GmbH', date: '2026-03-06', dueDate: '2026-03-20' });
      const advance = await issue(h, { client: 'Anzahlung GmbH', date: '2026-03-01', dueDate: '2026-03-15', items: [{ kind: 'item', description: 'Anzahlung', quantity: 1, price: 100, total: 100, taxRate: 19 }] });
      const stranger = await issue(h, { client: 'Anderer Zahler', date: '2026-03-02', dueDate: '2026-03-16', items: [{ kind: 'item', description: 'Anzahlung', quantity: 1, price: 100, total: 100, taxRate: 19 }] });
      const settle = (advanceInvoice: { id: string }, gross: number, id = `advance-${key()}`) => closing({
        commandType: 'advance_settlement', sourceId: id, sourceRevision: 'v1', idempotencyKey: `${id}:v1`,
        input: { effectiveDate: '2026-03-25', postingDate: '2026-03-25', period: '2026-03', fiscalYear: 2026, currency: 'EUR', finalInvoiceId: final.id, finalInvoice: { id: final.id, grossAmount: GROSS, taxBreakdown: breakdown(GROSS) }, advances: [{ id: advanceInvoice.id, kind: 'advance', grossAmount: gross, taxBreakdown: breakdown(gross) }], advanceClearingReceivable: '1400', advanceClearingPayable: '1600' },
      });
      const entries = (await journal(h)).length;
      const crossParty = await settle(stranger, 50);
      assert.equal(crossParty.status, 409, crossParty.text);
      assert.match(crossParty.body.message, /SETTLEMENT_PARTY_MISMATCH/);
      const tooMuch = await settle(advance, 500);
      assert.equal(tooMuch.status, 409, tooMuch.text);
      assert.equal((await journal(h)).length, entries, 'refused settlements posted nothing');
      assert.equal((await itemOf(stranger.id)).allocatedAmount, 0);
      assert.equal((await itemOf(advance.id)).allocatedAmount, 0);
    });

    test('the Skonto and Anzahlung masks send invoice numbers and amounts only; the tax split comes from the posted invoice', async () => {
      const mixed = await issue(h, { client: 'Maske Skonto', date: '2026-03-07', dueDate: '2026-03-21', items: [{ kind: 'item', description: 'Beratung', quantity: 1, price: 100, total: 100, taxRate: 19 }, { kind: 'item', description: 'Buch', quantity: 1, price: 100, total: 100, taxRate: 7 }] });
      const dates = { effectiveDate: '2026-03-22', postingDate: '2026-03-22', period: '2026-03', fiscalYear: 2026, currency: 'EUR' };
      // 2 % of 226,00: 2,38 on the 19 % part (2,00 + 0,38) and 2,14 on the 7 % part (2,00 + 0,14).
      const skonto = await closing({ commandType: 'skonto', sourceId: mixed.number, sourceRevision: '1', idempotencyKey: `mask-${key()}`, input: { ...dates, skontoAmount: 4.52 } });
      assert.equal(skonto.status, 200, skonto.text);
      const entry = (await journal(h)).find((candidate) => candidate.id === skonto.body.run.journalEntryId)!;
      const sum = (account: string, side: 'debitAmount' | 'creditAmount') => money(entry.lines.filter((line) => line.accountNumber === account).reduce((total, line) => total + line[side], 0));
      assert.deepEqual([sum('1776', 'debitAmount'), sum('1771', 'debitAmount'), sum('1400', 'creditAmount')], [0.38, 0.14, 4.52], 'the VAT of each rate is reduced by its share');
      assert.equal((await itemOf(mixed.id)).residualAmount, 221.48);

      const final = await issue(h, { client: 'Maske Anzahlung', date: '2026-03-08', dueDate: '2026-03-22' });
      const advance = await issue(h, { client: 'Maske Anzahlung', date: '2026-03-01', dueDate: '2026-03-15', items: [{ kind: 'item', description: 'Abschlag', quantity: 1, price: 100, total: 100, taxRate: 19 }] });
      const settled = await closing({ commandType: 'advance_settlement', sourceId: final.number, sourceRevision: '1', idempotencyKey: `mask-${key()}`, input: { ...dates, finalInvoice: { number: final.number }, advances: [{ number: advance.number, grossAmount: 119 }], advanceClearingReceivable: '1400', advanceClearingPayable: '1600' } });
      assert.equal(settled.status, 200, settled.text);
      assert.deepEqual([(await itemOf(advance.id)).residualAmount, (await itemOf(final.id)).residualAmount], [0, money(GROSS - 119)], 'the advance is settled against the final invoice');
    });

    test('a bad debt write-off closes the receivable against the expense account and needs that account', async () => {
      assert.ok((await get<unknown[]>(h, '/accounting/ledger/accounts?chart=SKR03&search=2400&limit=20')).length > 0, 'precondition: SKR03 has the account 2400');
      const invoice = await issue(h, { client: 'Ausfall GmbH', date: '2026-03-03', dueDate: '2026-03-17', items: [{ kind: 'item', description: 'Ausfall', quantity: 1, price: 100, total: 100, taxRate: 19 }] });
      const facts = { legalBasis: '§17 UStG', reason: 'bad_debt', originalDocumentId: invoice.id, originalDocumentNumber: invoice.number, originalTaxEffectiveDate: invoice.date, adjustmentDate: '2026-03-25', evidenceReference: 'Insolvenzbeschluss 4711' };
      const writeOff = (over: Record<string, unknown> = {}, id = `baddebt-${key()}`) => closing({ commandType: 'bad_debt', sourceId: id, sourceRevision: 'v1', idempotencyKey: `${id}:v1`, input: { effectiveDate: '2026-03-25', postingDate: '2026-03-25', period: '2026-03', fiscalYear: 2026, currency: 'EUR', taxBreakdown: breakdown(119), writeOffGrossAmount: 119, originalDocumentId: invoice.id, badDebtExpenseAccount: '2400', facts, ...over } });
      const missing = await writeOff({ badDebtExpenseAccount: undefined });
      assert.equal(missing.status, 400, missing.text);
      assert.match(JSON.stringify(missing.body), /badDebtExpenseAccount/);
      const done = await writeOff();
      assert.equal(done.status, 200, done.text);
      const entry = (await journal(h)).find((candidate) => candidate.id === done.body.run.journalEntryId)!;
      assertBalanced([entry]);
      assert.ok(entry.lines.some((line) => line.accountNumber === '2400' && line.debitAmount > 0), 'the loss is booked on 2400');
      assert.equal(entry.lines.find((line) => line.accountNumber === '1400')!.creditAmount, 119);
      const item = await itemOf(invoice.id);
      assert.deepEqual([item.status, item.residualAmount], ['paid', 0]);
      assert.equal((await invoiceOfApi(h, invoice.id)).status, 'paid');
      assert.equal((await writeOff()).status, 409, 'nothing is left to write off');
      const second = await issue(h, { client: 'Ausfall ohne Beleg', date: '2026-03-03', dueDate: '2026-03-17' });
      refused('a write-off without the §17 facts', await writeOff({ originalDocumentId: second.id, facts: undefined, taxBreakdown: breakdown(GROSS), writeOffGrossAmount: GROSS }));
      refused('a write-off whose §17 reason is not bad_debt', await writeOff({ originalDocumentId: second.id, facts: { ...facts, reason: 'other', originalDocumentId: second.id }, taxBreakdown: breakdown(GROSS), writeOffGrossAmount: GROSS }));
      assert.equal((await itemOf(second.id)).status, 'open', 'refused write-offs touched nothing');
    });

    test('the workspace\'s Quellbeleg names the original: a Skonto by invoice number, a write-off by id with §17 facts that leave the original out', async () => {
      const skontoInvoice = await issue(h, { client: 'Quellbeleg Skonto', date: '2026-03-05', dueDate: '2026-03-19' });
      const byNumber = await closing({ commandType: 'skonto', sourceId: skontoInvoice.number, sourceRevision: '1', idempotencyKey: `qb-${key()}`, input: { effectiveDate: '2026-03-21', postingDate: '2026-03-21', period: '2026-03', fiscalYear: 2026, currency: 'EUR', taxBreakdown: breakdown(GROSS), skontoAmount: 4.76 } });
      assert.equal(byNumber.status, 200, byNumber.text);
      assert.equal((await itemOf(skontoInvoice.id)).allocatedAmount, 4.76, 'the open item of the named invoice is reduced');

      const lost = await issue(h, { client: 'Quellbeleg Ausfall', date: '2026-03-06', dueDate: '2026-03-20', items: [{ kind: 'item', description: 'Ausfall', quantity: 1, price: 100, total: 100, taxRate: 19 }] });
      const facts = { legalBasis: '§17 UStG', reason: 'bad_debt', adjustmentDate: '2026-03-26', evidenceReference: 'Insolvenzbeschluss 0815' };
      const writeOff = await closing({ commandType: 'bad_debt', sourceId: lost.id, sourceRevision: '1', idempotencyKey: `qb-${key()}`, input: { effectiveDate: '2026-03-26', postingDate: '2026-03-26', period: '2026-03', fiscalYear: 2026, currency: 'EUR', taxBreakdown: breakdown(119), writeOffGrossAmount: 119, badDebtExpenseAccount: '2400', facts } });
      assert.equal(writeOff.status, 200, writeOff.text);
      assert.deepEqual([(await itemOf(lost.id)).status], ['paid']);
      const stored = (await get<any[]>(h, '/accounting/source-runs')).find((run) => run.id === writeOff.body.run.id);
      assert.deepEqual([stored.source.input.facts.originalDocumentId, stored.source.input.facts.originalDocumentNumber, stored.source.input.facts.originalTaxEffectiveDate], [lost.id, lost.number, lost.date], 'the run records the original it settled');

      const unknown = await closing({ commandType: 'bad_debt', sourceId: 'RE-GIBT-ES-NICHT', sourceRevision: '1', idempotencyKey: `qb-${key()}`, input: { effectiveDate: '2026-03-26', postingDate: '2026-03-26', period: '2026-03', fiscalYear: 2026, currency: 'EUR', taxBreakdown: breakdown(119), writeOffGrossAmount: 119, badDebtExpenseAccount: '2400', facts } });
      refused('a write-off whose Quellbeleg names no invoice', unknown);
    });

    test('a linked correction credits the original with its own VAT, replays by key and cannot over-credit', async () => {
      const invoice = await issue(h, { client: 'Korrektur GmbH', date: '2026-03-04', dueDate: '2026-03-18', items: [{ kind: 'item', description: 'Leistung', quantity: 1, price: 100, total: 100, taxRate: 19 }] });
      const preview = await h.raw('POST', '/accounting/outgoing-invoices/preview', { invoiceId: invoice.id, reason: 'Vorschau' });
      const original = {
        documentId: invoice.id, documentNumber: invoice.number, revision: preview.body.snapshot.sourceVersion, snapshotHash: sha256Hex(stableStringify(invoice.taxSnapshot)),
        taxEffectiveDate: invoice.date, taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }],
      };
      const correct = (id: string, grossAmount: number, over: Record<string, unknown> = {}) => h.raw('POST', '/accounting/corrections', { id, idempotencyKey: `${id}:key`, correctionDate: '2026-03-20', original, deltas: [{ rate: 19, grossAmount }], reason: 'Teilkorrektur', ...over });
      const id = `corr-${key()}`;
      const first = await correct(id, 11.9);
      assert.equal(first.status, 200, first.text);
      assert.equal(first.body.replayed, false);
      const entry = (await journal(h)).find((candidate) => candidate.id === first.body.run.journalEntryId)!;
      assert.deepEqual(entry.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]), [['8400', 10, 0], ['1776', 1.9, 0], ['1400', 0, 11.9]]);
      assertBalanced([entry]);
      assert.equal((await correct(id, 11.9)).body.replayed, true);
      const entries = (await journal(h)).length;
      const overCredit = await correct(`corr-${key()}`, 107.11);
      assert.ok(overCredit.status >= 400, 'a second correction beyond the remainder is refused');
      assert.ok(overCredit.status >= 400 && (await journal(h)).length === entries, 'and posts nothing');
      assert.ok((await correct(`corr-${key()}`, 500)).status >= 400);
      assert.equal((await journal(h)).length, entries, 'refused corrections posted nothing');
      const changed = await correct(`corr-${key()}`, 5, { original: { ...original, snapshotHash: 'f'.repeat(64) } });
      assert.equal(changed.status, 409, changed.text);
      assert.match(changed.body.message, /ORIGINAL_CHANGED/);
      const unknown = await correct(`corr-${key()}`, 5, { original: { ...original, documentId: 'nope' } });
      assert.equal(unknown.status, 400, unknown.text);
      assert.match(unknown.body.message, /ORIGINAL_DOCUMENT_NOT_FOUND/);
      assert.equal((await correct(`corr-${key()}`, 5, { idempotencyKey: '' })).status, 400);
    });

    test('a correction beyond what is left of the invoice is a 409 OVER_CREDIT', async () => {
      const invoice = await issue(h, { client: 'Über-Gutschrift GmbH', date: '2026-03-05', dueDate: '2026-03-19', items: [{ kind: 'item', description: 'Leistung', quantity: 1, price: 100, total: 100, taxRate: 19 }] });
      const preview = await h.raw('POST', '/accounting/outgoing-invoices/preview', { invoiceId: invoice.id, reason: 'Vorschau' });
      const original = { documentId: invoice.id, documentNumber: invoice.number, revision: preview.body.snapshot.sourceVersion, snapshotHash: sha256Hex(stableStringify(invoice.taxSnapshot)), taxEffectiveDate: invoice.date, taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }] };
      const correct = (grossAmount: number) => { const id = `corr-${key()}`; return h.raw('POST', '/accounting/corrections', { id, idempotencyKey: `${id}:key`, correctionDate: '2026-03-20', original, deltas: [{ rate: 19, grossAmount }], reason: 'Teilkorrektur' }); };
      assert.equal((await correct(11.9)).status, 200);
      const over = await correct(107.11);
      assert.equal(over.status, 409, over.text);
      assert.match(over.body.message, /OVER_CREDIT|exceeds remaining/);
    });

    test('the fiscal-year close books the result from the ledger balances; carrying forward opens the next year', async () => {
      const reports = async () => {
        const out: Record<string, unknown> = {};
        for (const path of [
          '/accounting/reports/susa?from=2025-01-01&to=2025-12-31', '/accounting/reports/susa?from=2026-01-01&to=2026-12-31',
          '/accounting/reports/hgb-guv?from=2025-01-01&to=2025-12-31', '/accounting/reports/hgb-guv?from=2026-01-01&to=2026-12-31',
          '/accounting/reports/bwa01?from=2025-01-01&to=2025-12-31', '/accounting/reports/bwa01?from=2026-01-01&to=2026-12-31',
          '/accounting/reports/bilanz?asOfDate=2025-12-31', '/accounting/reports/bilanz?asOfDate=2026-12-31',
          '/accounting/balances?asOfDate=2026-01-31', '/accounting/vat/summary?from=2025-01-01&to=2026-12-31',
        ]) {
          const response = await h.raw('GET', path);
          const body = response.body ?? {};
          out[path] = { status: response.status, rows: body.rows ?? body, totals: body.totals, netResult: body.netResult, assets: body.assets, liabilities: body.liabilities, blocking: body.mappingHealth?.blocking };
        }
        return out;
      };
      const reportsBefore = await reports();
      assert.equal(row((await h.raw('GET', '/accounting/reports/hgb-guv?from=2025-01-01&to=2025-12-31')).body, 'revenue'), 500);
      const balances = await get<Array<{ accountNumber: string }>>(h, '/accounting/balances?asOfDate=2025-12-31');
      const revenue = balances.find((row) => row.accountNumber === '8400')!;
      assert.ok(revenue, 'there is 2025 revenue to close');
      const id = `close-${key()}`;
      const close = await closing({ command: 'fiscal_close', sourceId: id, sourceRevision: 'v1', idempotencyKey: `${id}:v1`, input: { sourceId: id, sourceRevision: 'v1', fiscalYear: 2025, period: '2025-12', closingDate: '2025-12-31', currency: 'EUR', revenueAccounts: ['8400'], expenseAccounts: [], retainedEarningsAccount: '0860', balances } });
      assert.equal(close.status, 200, close.text);
      const entry = (await journal(h)).find((candidate) => candidate.id === close.body.run.journalEntryId)!;
      assert.deepEqual(entry.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]), [['8400', 500, 0], ['0860', 0, 500]]);
      assert.equal(entry.postingDate, '2025-12-31');
      assert.equal((await closing({ command: 'fiscal_close', sourceId: id, sourceRevision: 'v1', idempotencyKey: `${id}:v1`, input: { sourceId: id, sourceRevision: 'v1', fiscalYear: 2025, period: '2025-12', closingDate: '2025-12-31', currency: 'EUR', revenueAccounts: ['8400'], expenseAccounts: [], retainedEarningsAccount: '0860', balances } })).body.replayed, true);
      const opening = await get<Array<{ accountNumber: string; closingBalance: number }>>(h, '/accounting/balances?asOfDate=2025-12-31');
      const cfId = `carry-${key()}`;
      const carry = (balances: unknown, over: Record<string, unknown> = {}) => closing({ command: 'carry_forward', sourceId: cfId, sourceRevision: 'v1', idempotencyKey: `${cfId}:v1`, input: { sourceId: cfId, sourceRevision: 'v1', effectiveDate: '2026-01-01', period: '2026-01', fiscalYear: 2026, currency: 'EUR', balanceSheetAccounts: ['1400', '1776'], openingBalanceAccount: '9000', balances, ...over } });
      const carried = await carry(opening);
      assert.equal(carried.status, 200, carried.text);
      const openingEntry = (await journal(h)).find((candidate) => candidate.id === carried.body.run.journalEntryId)!;
      assertBalanced([openingEntry]);
      assert.equal(openingEntry.postingDate, '2026-01-01');
      const expected = ['1400', '1776'].map((account) => [account, opening.find((row) => row.accountNumber === account)?.closingBalance ?? 0]);
      for (const [account, balance] of expected as Array<[string, number]>) {
        const line = openingEntry.lines.find((candidate) => candidate.accountNumber === account);
        if (balance === 0) assert.equal(line, undefined);
        else assert.equal(money((line?.debitAmount ?? 0) - (line?.creditAmount ?? 0)), balance, `${account} is opened with its closing balance`);
      }
      assert.ok(openingEntry.lines.some((line) => line.accountNumber === '9000'), 'the clearing account takes the other side');
      assert.equal((await carry(opening)).body.replayed, true);
      const badCarry = await carry(opening, { period: '2026-02' });
      assert.ok(badCarry.status >= 400 || badCarry.body.run?.status === 'rejected', `a period that does not contain the effective date: ${badCarry.status}`);
      const bad = await closing({ command: 'fiscal_close', sourceId: `close-${key()}`, sourceRevision: 'v1', idempotencyKey: key(), input: { sourceId: 'x', sourceRevision: 'v1', fiscalYear: 2025, period: '2026-01', closingDate: '2025-12-31', currency: 'EUR', revenueAccounts: ['8400'], expenseAccounts: [], retainedEarningsAccount: '0860', balances } });
      assert.ok(bad.status >= 400 || bad.body.run?.status === 'rejected', `a period that does not contain the closing date: ${bad.status} ${bad.text.slice(0, 120)}`);

      assert.deepEqual(await reports(), reportsBefore, 'closing and carrying forward change no report of either year');
      const datev = await get<Array<{ konto: string; gegenkonto: string }>>(h, '/accounting/datev/rows?from=2025-12-01&to=2026-01-31');
      assert.ok(!datev.some((pair) => ['0860', '9000'].includes(pair.konto) || ['0860', '9000'].includes(pair.gegenkonto)), 'closing entries are not part of the DATEV stack');
      // The carry-forward goes to the tax adviser as its own stack (EB-Werte), each balance against 9000.
      const eb = await download(h, '/api/v1/pro/accounting/datev/export.csv?kind=opening_balances&from=2026-01-01&to=2026-01-31&consultantNumber=1234567&clientNumber=12345&fiscalYearStart=2026-01-01&accountLength=4&encoding=cp1252');
      assert.equal(eb.status, 200, eb.bytes.toString());
      const [ebHeader, , ...ebRows] = eb.bytes.toString('latin1').split('\r\n').filter(Boolean).map((line) => line.split(';'));
      assert.ok(ebHeader!.includes('"Eröffnungsbilanzwerte 2026"'), ebHeader!.join(';'));
      assert.match(eb.headers.get('content-disposition') ?? '', /EB-Werte/);
      assert.match((await download(h, `/api/v1/pro/accounting/datev/exports/${eb.headers.get('x-billme-datev-export-id')}`)).headers.get('content-disposition') ?? '', /EXTF_EB-Werte_2026-01-01_2026-01-31/, 'and keeps that name in the history');
      const carriedLines = openingEntry.lines.filter((line) => line.accountNumber !== '9000');
      assert.ok(carriedLines.length > 0);
      assert.deepEqual(
        ebRows.map((row) => [row[6], row[7], row[1], Number(row[0]!.replace(',', '.'))]).sort(),
        carriedLines.map((line) => [line.accountNumber, '9000', line.debitAmount > 0 ? '"S"' : '"H"', money(Math.abs(line.debitAmount - line.creditAmount))]).sort(),
      );
      const running = await download(h, '/api/v1/pro/accounting/datev/export.csv?from=2026-01-01&to=2026-01-31&consultantNumber=1234567&clientNumber=12345&fiscalYearStart=2026-01-01&accountLength=4&encoding=cp1252');
      assert.ok(!running.bytes.toString('latin1').split('\r\n').slice(2).some((line) => line.split(';')[7] === '9000'), 'the running stack still leaves it out');
      assert.ok((await periods(h, 2025)).every((month) => month.status === 'soft_locked'), 'the closed fiscal year is soft-locked');
      assert.equal(await statusOf(h, '2026-01'), 'open', 'the next year stays open');
      await assertLedgerConsistent(h);
    });

    test('the fiscal-year close derives its lines from the ledger, not from numbers the client supplies', async () => {
      const id = `close-fake-${key()}`;
      const forged = [{ accountNumber: '8400', openingBalance: 0, debitTurnover: 0, creditTurnover: 9999, closingBalance: -9999 }];
      const entries = (await journal(h)).length;
      const response = await closing({ command: 'fiscal_close', sourceId: id, sourceRevision: 'v1', idempotencyKey: `${id}:v1`, input: { sourceId: id, sourceRevision: 'v1', fiscalYear: 2026, period: '2026-12', closingDate: '2026-12-31', currency: 'EUR', revenueAccounts: ['8400'], expenseAccounts: [], retainedEarningsAccount: '0860', balances: forged } });
      assert.ok(response.status >= 400 || response.body.run?.status === 'rejected', `the server posted a close of 9999 against a ledger that carries 2026 revenue of ${money(-net(await journal(h), '8400', '2026-12-31', '2026-01-01'))}`);
      assert.equal((await journal(h)).length, entries);
    });
  });

  describe('year-end close from the ledger (own tenant)', () => {
    let y: ProHarness;
    const book = (lines: Array<[string, number, number]>, text: string, date: string) => y.raw('POST', '/accounting/journal', { reason: text, reference: text.slice(0, 20), documentDate: date, postingDate: date, bookingText: text, idempotencyKey: randomUUID(), lines: lines.map(([accountNumber, debitAmount, creditAmount]) => ({ accountNumber, debitAmount, creditAmount })) });
    // What the Jahresabschluss mask sends: the year and its dates, no account lists, no balances.
    const close = (command: 'fiscal_close' | 'carry_forward', sourceId: string, input: Record<string, unknown>) => y.raw('POST', '/accounting/closing', { command, sourceId, sourceRevision: '1', idempotencyKey: `${sourceId}:1`, reason: 'Jahresabschluss', input: { sourceId, sourceRevision: '1', currency: 'EUR', ...input } });
    const yearEnd = (year: number, preview = false) => close('fiscal_close', `JA-${year}`, { fiscalYear: year, period: `${year}-12`, closingDate: `${year}-12-31`, ...(preview ? { preview } : {}) });
    const opening = (year: number, preview = false) => close('carry_forward', `EB-${year}`, { fiscalYear: year, period: `${year}-01`, effectiveDate: `${year}-01-01`, ...(preview ? { preview } : {}) });
    const linesOf = (lines: Array<{ accountNumber: string; debitAmount: number; creditAmount: number }>) => lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]);
    const susa = async (year: number) => new Map((await get<{ rows: Array<{ accountNumber: string; openingBalance: number; closingBalance: number }> }>(y, `/accounting/reports/susa?from=${year}-01-01&to=${year}-12-31`)).rows.map((row) => [row.accountNumber, row]));
    before(async () => {
      y = await startPro(null, 'pro-year-end');
      const settings = await y.api.settings.get();
      assert.equal((await y.raw('PUT', '/settings', { settings: { ...settings, businessReportingProfile: { jurisdiction: 'DE', legalForm: 'gmbh', profitDetermination: 'double_entry', hgbSizeClass: 'small', fiscalYearStart: '01-01', chart: 'SKR03', vatMethod: 'soll' } } })).status, 200);
      for (const [lines, text, date] of [
        [[['1200', 1190, 0], ['8400', 0, 1000], ['1776', 0, 190]], 'Erlös 2025', '2025-06-10'],
        [[['4930', 100, 0], ['1200', 0, 100]], 'Büro 2025', '2025-07-01'],
        [[['1200', 595, 0], ['8400', 0, 500], ['1776', 0, 95]], 'Erlös 2026', '2026-03-10'],
      ] as Array<[Array<[string, number, number]>, string, string]>) assert.equal((await book(lines, text, date)).status, 200, text);
    });
    after(async () => { await y?.close(); });

    test('the next year opens its Erfolgskonten at 0 and the result on the Gewinnvortrag, with and without a close', async () => {
      const carryFirst = await opening(2026, true);
      assert.deepEqual(linesOf(carryFirst.body.command.lines).sort(), [['0860', 0, 900], ['1200', 1090, 0], ['1776', 0, 190]], 'before the close the carry-forward already opens the result on 0860, like the reports');
      const open2026 = await susa(2026);
      assert.equal(open2026.get('8400')?.openingBalance, 0, '8400 starts 2026 at 0');
      assert.equal(open2026.get('4930')?.openingBalance ?? 0, 0, '4930 starts 2026 at 0');
      assert.equal(open2026.get('0860')?.openingBalance, -900, 'the 2025 profit of 900 opens on 0860');
      assert.equal(open2026.get('1200')?.openingBalance, 1090, 'the bank carries over');
      assert.equal(open2026.get('8400')?.closingBalance, -500, 'the 2026 revenue alone');
      const january = await get<Array<{ accountNumber: string; openingBalance: number }>>(y, '/accounting/balances?asOfDate=2026-01-31');
      assert.equal(january.find((row) => row.accountNumber === '8400')?.openingBalance ?? 0, 0);
    });

    test('the close needs only the year: the preview books nothing and shows what the close books; the next year closes only its own result', async () => {
      const before2026 = await susa(2026);
      const entries = (await journal(y)).length;
      const preview = await yearEnd(2025, true);
      assert.equal(preview.status, 200, preview.text);
      assert.equal(preview.body.status, 'preview');
      assert.deepEqual(linesOf(preview.body.command.lines), [['8400', 1000, 0], ['4930', 0, 100], ['0860', 0, 900]]);
      assert.equal(preview.body.command.retainedEarningsAccount, '0860', 'a GmbH closes into the Gewinnvortrag');
      assert.equal((await journal(y)).length, entries, 'a preview books nothing');
      const posted = await yearEnd(2025);
      assert.equal(posted.status, 200, posted.text);
      const entry = (await journal(y)).find((candidate) => candidate.id === posted.body.run.journalEntryId)!;
      assert.deepEqual(linesOf(entry.lines), linesOf(preview.body.command.lines), 'the booking is the preview');
      assert.equal((await yearEnd(2025)).body.replayed, true, 'closing the same year again changes nothing');

      const carry = await opening(2026, true);
      assert.equal(carry.status, 200, carry.text);
      assert.deepEqual(linesOf(carry.body.command.lines).sort(), [['0860', 0, 900], ['1200', 1090, 0], ['1776', 0, 190]], 'Bestandskonten and the Gewinnvortrag, no Erfolgskonto');
      assert.equal((await opening(2026)).status, 200);
      assert.deepEqual(await susa(2026), before2026, 'close and carry-forward leave the 2026 report as it was');
      const again = await close('fiscal_close', 'JA-2025-zwei', { fiscalYear: 2025, period: '2025-12', closingDate: '2025-12-31' });
      assert.equal(again.status, 400, `a second close of 2025 under another Quellbeleg: ${again.text}`);
      assert.match(again.body.message, /FISCAL_YEAR_ALREADY_CLOSED/);

      assert.equal((await book([['1200', 238, 0], ['8400', 0, 200], ['1776', 0, 38]], 'Erlös 2026 b', '2026-05-10')).status, 200);
      const second = await yearEnd(2026, true);
      assert.equal(second.status, 200, second.text);
      assert.deepEqual(linesOf(second.body.command.lines), [['8400', 700, 0], ['0860', 0, 700]], 'only the 2026 revenue, not 2025 again');
      assert.equal((await susa(2027)).get('0860')?.openingBalance, -1600, 'both years on the Gewinnvortrag');
    });
  });

  describe('asset sale at a book loss on SKR04 (own tenant)', () => {
    let k: ProHarness;
    before(async () => {
      k = await startPro(null, 'pro-asset-sale-skr04');
      const policy = await k.raw('PUT', '/accounting/policy', { reason: 'Kontenrahmen gewählt', activeChart: 'SKR04', vatMethod: 'soll' });
      assert.equal(policy.status, 200, policy.text);
    });
    after(async () => { await k?.close(); });

    test('the invoice books the proceeds "bei Buchverlust" (6889), the disposal the book value on 6895', async () => {
      const created = await k.raw('POST', '/accounting/assets', { reason: 'Anlage erfasst', asset: { assetNumber: 'A-SKR04', name: 'Regal', assetClass: 'Büromöbel', status: 'aktiv', activationDate: '2026-01-01', acquisitionCost: 1200, usefulLifeYears: 1, depreciationMethod: 'linear', costCenter: '', location: '', receiptLinked: true, assetAccountNumber: '0650' } });
      assert.equal(created.status, 200, created.text);
      const invoice = await draft(k, { client: 'Käufer GmbH', date: '2026-01-31', items: [{ kind: 'item', description: 'Verkauf Anlage A-SKR04 Regal', quantity: 1, price: 500, total: 500, taxRate: 19 }], taxMeta: { assetSaleAssetId: created.body.id } as never });
      const sold = await k.raw('POST', `/accounting/assets/${created.body.id}/dispose`, { reason: 'Verkauf', disposalDate: '2026-01-31', proceeds: 500, saleInvoiceId: invoice.id });
      assert.equal(sold.status, 200, sold.text);
      const residual = sold.body.residualBookValue as number;
      assert.ok(sold.body.gainLoss < 0, 'a book loss');
      const disposal = (await journal(k)).find((entry) => entry.id === sold.body.journalEntryId)!;
      assert.deepEqual(disposal.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]).sort(), [['0650', 0, residual], ['6895', residual, 0]].sort());
      const issued = await k.api.invoices.upsert({ reason: 'Rechnung gestellt', invoice: { ...invoice, status: 'open' } as never });
      const posted = (await invoiceEntry(k, issued.id))!;
      assert.deepEqual(posted.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]).sort(), [['1200', 595, 0], ['3806', 0, 95], ['6889', 0, 500]].sort());
    });
  });

  describe('a fiscal year that does not start on 1 January', () => {
    test('the journal and the balance sheet follow a 15 April fiscal-year start', async () => {
      const settings = await h.api.settings.get();
      await h.api.settings.set({ settings: { ...settings, businessReportingProfile: { jurisdiction: 'DE', legalForm: 'gmbh', profitDetermination: 'double_entry', hgbSizeClass: 'small', fiscalYearStart: '04-15', chart: 'SKR03', vatMethod: 'soll' } } } as never);
      try {
        const before = await issue(h, { client: 'GJ davor', date: '2026-04-14', dueDate: '2026-04-28' });
        const first = await issue(h, { client: 'GJ erster Tag', date: '2026-04-15', dueDate: '2026-04-29' });
        const fiscalYearOf = async (id: string) => (await invoiceEntry(h, id))!.fiscalYear;
        assert.equal(await fiscalYearOf(before.id), 2025, '14 April 2026 still belongs to the fiscal year that began on 15 April 2025');
        assert.equal(await fiscalYearOf(first.id), 2026, '15 April 2026 starts the next one');
        const bwa = await get<any>(h, '/accounting/reports/bwa01?from=2026-04-15&to=2027-04-14');
        assert.deepEqual([bwa.snapshot.fiscalYear, bwa.snapshot.fiscalYearStart], [2026, '04-15']);
        const bilanz = await get<any>(h, '/accounting/reports/bilanz?asOfDate=2026-06-30');
        assert.equal(bilanz.snapshot.fiscalYearRange.start, '2026-04-15');
        assert.equal(bilanz.snapshot.fiscalYearRange.end, '2027-04-14');
        const later = await get<any>(h, '/accounting/reports/bwa01?from=2027-04-15&to=2028-04-14');
        assert.deepEqual([later.snapshot.fiscalYear, later.snapshot.catalogYear, later.snapshot.catalogProvisional], [2027, 2026, true], 'a year without its own catalogue runs on the newest one, marked provisional');
      } finally {
        await h.api.settings.set({ settings: { ...settings, businessReportingProfile: { jurisdiction: 'DE', legalForm: 'gmbh', profitDetermination: 'double_entry', hgbSizeClass: 'small', fiscalYearStart: '01-01', chart: 'SKR03', vatMethod: 'soll' } } } as never);
      }
    });
  });

  describe('legacy backfill', () => {
    test('the preview lists what is not in the ledger as an unresolved candidate; confirming needs the matching run and hash', async () => {
      const preview = await get<{ runId: string; status: string; candidates: Array<{ sourceType: string; status: string; reason?: string }>; readyCount: number; unresolvedCount: number; confirmationHash: string }>(h, '/accounting/backfill/preview');
      assert.equal(preview.status, 'preview');
      assert.equal(preview.readyCount + preview.unresolvedCount, preview.candidates.length);
      assert.ok(preview.candidates.every((candidate) => candidate.status === 'unresolved' && candidate.sourceType === 'legacy_transaction'), 'bank lines are never posted without an explicit review');
      assert.match(preview.confirmationHash, /^[a-f0-9]{64}$/);
      const entries = (await journal(h)).length;
      const wrongRun = await h.raw('POST', '/accounting/backfill/confirm', { reason: 'Nachbuchung', runId: 'nope', confirmationHash: preview.confirmationHash });
      assert.equal(wrongRun.status, 404, wrongRun.text);
      const wrongHash = await h.raw('POST', '/accounting/backfill/confirm', { reason: 'Nachbuchung', runId: preview.runId, confirmationHash: 'f'.repeat(64) });
      assert.equal(wrongHash.status, 409, wrongHash.text);
      assert.match(wrongHash.body.message, /BACKFILL_CONFIRMATION_HASH_MISMATCH/);
      assert.equal((await h.raw('POST', '/accounting/backfill/confirm', { reason: ' ', runId: preview.runId, confirmationHash: preview.confirmationHash })).status, 400);
      const done = await h.raw('POST', '/accounting/backfill/confirm', { reason: 'Nachbuchung bestätigt', runId: preview.runId, confirmationHash: preview.confirmationHash });
      assert.equal(done.status, 200, done.text);
      assert.deepEqual([done.body.postedCount, done.body.unresolvedCount, done.body.status], [0, preview.unresolvedCount, 'completed']);
      assert.equal((await journal(h)).length, entries, 'nothing unresolved was posted');
      assert.deepEqual((await h.raw('POST', '/accounting/backfill/confirm', { reason: 'nochmal', runId: preview.runId, confirmationHash: preview.confirmationHash })).body, done.body, 'confirming a completed run returns the recorded result');
    });
  });

  test('after everything the ledger is consistent, every entry balances and the audit chain verifies', async () => {
    await assertLedgerConsistent(h);
    const verify = await h.api.audit.verify();
    assert.equal(verify.ok, true, JSON.stringify(verify));
  });

  test('every refused request in this file was answered with a client error', () => {
    assert.deepEqual(serverErrors, [], 'rule violations answered with a server error');
  });
});
