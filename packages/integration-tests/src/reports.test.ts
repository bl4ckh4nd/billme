import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { startLite, type LiteHarness } from './harness.js';
import { getEurAnnexCatalog } from '@billme/desktop-services/eur/annexCatalog';
import { draftInvoice, draftOffer } from './fixtures.js';
import { bankAccount, configureLite, importBankRows, issueDated, line, pay } from './reports-fixtures.js';

/**
 * Tax reports of the Lite desktop backend: EÜR, USt-Voranmeldung preparation
 * and the (fail-closed) tax filing routes, driven through real invoices, bank
 * imports and manual cash entries.
 *
 * How this can fail (each one has a test below):
 * - Zufluss/Abfluss: the invoice date decides the year instead of the payment
 *   date; a payment on 31 Dec / 1 Jan lands in the wrong year; a partial
 *   payment is counted whole; refunds do not reduce income; unpaid invoices,
 *   drafts, pending bank rows or rows of another year leak in
 * - net/VAT split: gross booked as income, a mixed 19/7 % invoice split with
 *   the wrong ratio, vereinnahmte USt (KZ 140) / gezahlte Vorsteuer (KZ 185)
 *   missing or doubled, Kleinunternehmer showing VAT
 * - double counting: a bank row linked to an invoice counted next to the
 *   invoice payment, a manual cash entry counted next to its bank row, a link
 *   that does not give the bank row back on unlink
 * - classification: an item moved to another line leaves the old total behind,
 *   an excluded item still counts, a computed/unknown/wrong-flow line or a
 *   made-up source is accepted, a change leaves no audit entry, the missing
 *   VAT rate goes unnoticed
 * - suggestions: rules applied out of priority order, inactive/other-year
 *   rules applied, a deleted rule still suggesting, counterparty memory wrong
 * - facts: private withdrawals counted as expense, splits that do not add up,
 *   a replayed idempotency key creating a second fact
 * - CSV export: wrong decimal format, non-exportable rows, totals that differ
 *   from the report
 * - boundaries: unsupported tax year, partial-year ranges, no EÜR profile,
 *   no token
 * - VAT preparation: Soll vs. Ist recognised in the wrong month, partial
 *   payments / refunds / overpayments, cancellations and credit notes not
 *   netting out, drafts reported, reverse charge / Kleinunternehmer / export
 *   taxed, input VAT from unreviewed or file-less receipts, double input VAT
 *   for instalments, spreadsheet formula injection in the CSV, bad periods
 * - tax filing: a filing that can leave `draft` without a report snapshot, a
 *   replayed idempotency key creating a second filing, a certificate stored
 *   without an encryption key
 * - persistence: classifications, rules and reports changing after a restart
 */

const YEAR_LINE = (year: number, code: string) => `E${year}_KZ${code}`;
const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;
const rowOf = (report: { rows: Array<{ lineId: string; total: number; kennziffer?: string }> }, code: string, year = 2026) =>
  report.rows.find((row) => row.lineId === YEAR_LINE(year, code));
const totalOf = (report: Parameters<typeof rowOf>[0], code: string, year = 2026) => rowOf(report, code, year)?.total;

describe('EÜR', () => {
  let h: LiteHarness;
  let items26: Awaited<ReturnType<LiteHarness['api']['eur']['listItems']>>;
  const ids = {} as Record<string, string>;
  const account = 'bank-eur';
  const txId = async (counterparty: string, purpose?: string) => {
    const tx = (await h.api.transactions.list({} as never)).find((t) => t.counterparty === counterparty && (purpose === undefined || t.purpose === purpose));
    assert.ok(tx, `bank row ${counterparty} / ${purpose} not found`);
    return tx.id;
  };
  const items = (year = 2026, extra: Record<string, unknown> = {}) => h.api.eur.listItems({ taxYear: year, ...extra } as never);
  const itemFor = async (predicate: (item: Awaited<ReturnType<typeof items>>[number]) => boolean, year = 2026) => {
    const found = (await items(year)).find(predicate);
    assert.ok(found, 'item not found');
    return found;
  };
  const classify = (sourceId: string, eurLineId: string | undefined, extra: Record<string, unknown> = {}, sourceType: 'transaction' | 'invoice' | 'manual' = 'invoice', taxYear = 2026) =>
    h.raw('PUT', '/reports/eur/classifications', { sourceType, sourceId, taxYear, eurLineId, reason: 'Beleg geprüft', ...extra });
  const reportOf = (year = 2026) => h.api.eur.getReport({ taxYear: year });

  before(async () => {
    h = await startLite(null, 'reports-eur');
    await configureLite(h.api);
    await h.api.accounts.upsert({ account: bankAccount(account) } as never);

    // Invoice dated 2025, paid 2026 (Zufluss 2026), later partly refunded.
    const invA = await issueDated(h.api, { client: 'Kunde A', date: '2025-12-20', items: [line('Beratung', 200, 19)], servicePeriod: '2025-12-20' });
    ids.invA = invA.id;
    ids.invAPay = (await pay(h.api, invA.id, 238, '2026-01-05')).id;
    ids.invARefund = (await pay(h.api, invA.id, -59.5, '2026-02-01', 'refund')).id;
    // Mixed 19/7 %, two instalments of 113.
    const invB = await issueDated(h.api, { client: 'Kunde B', date: '2026-02-01', items: [line('Beratung', 100, 19), line('Fachbuch', 100, 7)], servicePeriod: '2026-02-01' });
    ids.invB = invB.id;
    ids.invBPay1 = (await pay(h.api, invB.id, 113, '2026-02-10')).id;
    ids.invBPay2 = (await pay(h.api, invB.id, 113, '2026-03-05')).id;
    // Dated and paid in 2025.
    const invC = await issueDated(h.api, { client: 'Kunde C', date: '2025-11-01', items: [line('Workshop', 100, 19)], servicePeriod: '2025-11-01' });
    ids.invC = invC.id;
    ids.invCPay = (await pay(h.api, invC.id, 119, '2025-12-31')).id;
    // Instalments on 31 Dec and 1 Jan.
    const invD = await issueDated(h.api, { client: 'Kunde D', date: '2025-12-15', items: [line('Projekt', 200, 19)], servicePeriod: '2025-12-15' });
    ids.invD = invD.id;
    ids.invDPay1 = (await pay(h.api, invD.id, 119, '2025-12-31')).id;
    ids.invDPay2 = (await pay(h.api, invD.id, 119, '2026-01-01')).id;
    // Issued but unpaid, and a draft.
    ids.invUnpaid = (await issueDated(h.api, { client: 'Kunde Offen', date: '2026-03-01', items: [line('Offen', 100, 19)] })).id;
    ids.invDraft = (await draftInvoice(h.api, { client: 'Kunde Entwurf', date: '2026-03-02' })).id;
    // Paid through the bank: the statement row gets linked to this invoice.
    const invE = await issueDated(h.api, { client: 'Kunde E', date: '2026-03-20', items: [line('Fachbuch', 100, 7)], servicePeriod: '2026-03-20' });
    ids.invE = invE.id;

    await importBankRows(h.api, account, [
      ['2026-03-10', 500, 'Kunde X', 'Zahlung Projekt'],
      ['2026-03-12', -59.5, 'Hoster AG', 'Hosting Server'],
      ['2026-09-30', -12.5, 'Telekom', 'Telefon September'],
      ['2026-12-31', -10, 'Telekom', 'Telefon Dezember'],
      ['2025-12-31', -20, 'Telekom', 'Telefon Dezember alt'],
      ['2027-01-01', -5, 'Telekom', 'Telefon Januar 2027'],
      ['2026-05-20', -77, 'Wartend GmbH', 'Noch nicht gebucht', 'pending'],
      ['2026-04-02', 107, 'Kunde E', 'Rechnung Fachbuch'],
    ]);
    const linkTx = await txId('Kunde E');
    const link = await h.api.transactions.link({ transactionId: linkTx, invoiceId: invE.id, reason: 'Zahlung zugeordnet' } as never);
    assert.equal(link.success, true);

    // Manual cash: an expense with a reviewed receipt (19 % VAT), one without receipt, one income.
    await h.api.cash.saveReceipt({
      receipt: { id: 'rcpt-eur', number: 'LIEF-1', counterparty: 'Lieferant GmbH', documentDate: '2026-04-08', receivedDate: '2026-04-09', serviceDate: '2026-04-01', grossAmountCents: 11900, taxMode: 'domestic', deductiblePercent: 100, reviewed: true, taxBreakdown: [{ rate: 19, netAmountCents: 10000, vatAmountCents: 1900 }] },
      reason: 'Beleg geprüft',
    } as never);
    await h.api.cash.saveEntry({ entry: { id: 'cash-receipt', cashDate: '2026-04-10', amountCents: -11900, currency: 'EUR', flowType: 'expense', counterparty: 'Lieferant GmbH', purpose: 'Material', receiptId: 'rcpt-eur' }, reason: 'Barzahlung' } as never);
    await h.api.cash.saveEntry({ entry: { id: 'cash-plain', cashDate: '2026-05-02', amountCents: -3000, currency: 'EUR', flowType: 'expense', counterparty: 'Schreibwaren Müller', purpose: 'Bürobedarf bar' }, reason: 'Barzahlung' } as never);
    await h.api.cash.saveEntry({ entry: { id: 'cash-income', cashDate: '2026-05-03', amountCents: 4000, currency: 'EUR', flowType: 'income', counterparty: 'Laufkunde', purpose: 'Verkauf bar' }, reason: 'Barverkauf' } as never);
    items26 = await items();
  });
  after(async () => { await h.close(); });

  const payId = (invoice: string, payment: string) => `${ids[invoice]}:payment:${ids[payment]}`;

  describe('Zufluss/Abfluss', () => {
    test('the payment date, not the invoice date, decides the year', async () => {
      const paidIn2026 = items26.find((i) => i.sourceId === payId('invA', 'invAPay'));
      assert.ok(paidIn2026, 'invoice dated 2025-12-20 but paid 2026-01-05 belongs to 2026');
      assert.equal(paidIn2026.date, '2026-01-05');
      assert.equal(paidIn2026.amountGross, 238);
      assert.equal(paidIn2026.amountNet, 200);
      assert.equal(paidIn2026.flowType, 'income');
      assert.ok(!items26.some((i) => i.sourceId === payId('invC', 'invCPay')), 'invoice paid on 2025-12-31 is not a 2026 item');
      const items25 = await items(2025);
      const paidIn2025 = items25.find((i) => i.sourceId === payId('invC', 'invCPay'));
      assert.ok(paidIn2025);
      assert.equal(paidIn2025.amountNet, 100);
      assert.ok(!items25.some((i) => i.sourceId === payId('invA', 'invAPay')), 'and the 2026 payment is not a 2025 item');
    });

    test('instalments on 31 December and 1 January land in different years', async () => {
      const items25 = await items(2025);
      const dec = items25.find((i) => i.sourceId === payId('invD', 'invDPay1'));
      const jan = items26.find((i) => i.sourceId === payId('invD', 'invDPay2'));
      assert.ok(dec && jan);
      assert.deepEqual([dec.date, dec.amountGross, dec.amountNet], ['2025-12-31', 119, 100]);
      assert.deepEqual([jan.date, jan.amountGross, jan.amountNet], ['2026-01-01', 119, 100]);
      assert.ok(!items25.some((i) => i.sourceId === payId('invD', 'invDPay2')));
      assert.ok(!items26.some((i) => i.sourceId === payId('invD', 'invDPay1')));
    });

    test('a refund reduces the income of the year it is paid back in', async () => {
      const refund = items26.find((i) => i.sourceId === payId('invA', 'invARefund'));
      assert.ok(refund);
      assert.equal(refund.amountGross, -59.5);
      assert.equal(refund.amountNet, -50, 'net follows the invoice ratio 200/238');
      assert.equal(refund.flowType, 'income');
    });

    test('unpaid invoices, drafts, pending bank rows and rows outside the year are not cash', async () => {
      for (const id of [ids.invUnpaid, ids.invDraft]) assert.ok(!items26.some((i) => i.sourceId.startsWith(id)), `${id} must not appear`);
      const purposes = items26.map((i) => i.purpose);
      assert.ok(!purposes.includes('Noch nicht gebucht'), 'a pending bank row is not yet an Abfluss');
      assert.ok(!purposes.includes('Telefon Januar 2027'));
      assert.ok(!purposes.includes('Telefon Dezember alt'));
      assert.ok(!(await items(2025)).some((i) => i.purpose === 'Telefon Januar 2027'));
    });

    test('the same cash moves with the year: bank rows on 31 Dec belong to that year only', async () => {
      assert.ok(items26.some((i) => i.purpose === 'Telefon Dezember' && i.date === '2026-12-31'));
      const items25 = await items(2025);
      const old = items25.find((i) => i.purpose === 'Telefon Dezember alt');
      assert.ok(old);
      assert.equal(old.flowType, 'expense');
      assert.equal(old.amountGross, 20);
    });
  });

  describe('net/VAT split and double counting', () => {
    test('a mixed 19/7 % invoice splits every instalment pro rata (net 100 of 113)', () => {
      for (const payment of ['invBPay1', 'invBPay2']) {
        const item = items26.find((i) => i.sourceId === payId('invB', payment));
        assert.ok(item);
        assert.equal(item.amountGross, 113);
        assert.equal(item.amountNet, 100);
      }
    });

    test('a bank row linked to an invoice is counted once, as the invoice payment', async () => {
      const viaInvoice = items26.find((i) => i.sourceType === 'invoice' && i.sourceId.startsWith(ids.invE));
      assert.ok(viaInvoice, 'the invoice payment is the cash item');
      assert.deepEqual([viaInvoice.date, viaInvoice.amountGross, viaInvoice.amountNet, viaInvoice.linkedViaInvoice], ['2026-04-02', 107, 100, true]);
      assert.ok(!items26.some((i) => i.sourceType === 'transaction' && i.counterparty === 'Kunde E'), 'the statement row is not a second income');
    });

    test('unlinking gives the bank row back and removes the invoice payment', async () => {
      const invF = await issueDated(h.api, { client: 'Kunde F', date: '2026-08-10', items: [line('Beratung', 50, 19)], servicePeriod: '2026-08-10' });
      await importBankRows(h.api, account, [['2026-08-15', 59.5, 'Kunde F', 'Zahlung Beratung']]);
      const tx = await txId('Kunde F');
      const before = await items();
      assert.ok(before.some((i) => i.sourceType === 'transaction' && i.sourceId === tx));
      await h.api.transactions.link({ transactionId: tx, invoiceId: invF.id, reason: 'zuordnen' } as never);
      const linked = await items();
      assert.ok(!linked.some((i) => i.sourceId === tx), 'linked: no bank item');
      const viaInvoice = linked.find((i) => i.sourceType === 'invoice' && i.sourceId.startsWith(invF.id));
      assert.ok(viaInvoice);
      assert.equal(viaInvoice.amountNet, 50);
      assert.equal(linked.length, before.length, 'one item replaced by one item');
      await h.api.transactions.unlink({ transactionId: tx } as never);
      const unlinked = await items();
      assert.ok(unlinked.some((i) => i.sourceType === 'transaction' && i.sourceId === tx), 'unlinked: bank item is back');
      assert.ok(!unlinked.some((i) => i.sourceType === 'invoice' && i.sourceId.startsWith(invF.id)), 'and the invoice payment is gone');
    });

    test('manual cash takes its net from the reviewed receipt, without receipt net equals gross', async () => {
      const withReceipt = items26.find((i) => i.sourceId === 'cash-receipt');
      const plain = items26.find((i) => i.sourceId === 'cash-plain');
      const income = items26.find((i) => i.sourceId === 'cash-income');
      assert.deepEqual([withReceipt?.sourceType, withReceipt?.flowType, withReceipt?.amountGross, withReceipt?.amountNet], ['manual', 'expense', 119, 100]);
      assert.deepEqual([plain?.amountGross, plain?.amountNet, plain?.flowType], [30, 30, 'expense']);
      assert.deepEqual([income?.amountGross, income?.amountNet, income?.flowType], [40, 40, 'income']);
    });

    test('matching a manual entry to its bank row counts it once, at the bank date, and unmatching restores both', async () => {
      await h.api.cash.saveEntry({ entry: { id: 'cash-match', cashDate: '2026-06-01', amountCents: -4200, currency: 'EUR', flowType: 'expense', counterparty: 'Tankstelle', purpose: 'Diesel' }, reason: 'Barzahlung' } as never);
      await importBankRows(h.api, account, [['2026-06-03', -42, 'Tankstelle', 'Karte Diesel']]);
      const tx = await txId('Tankstelle', 'Karte Diesel');
      const separate = await items();
      assert.ok(separate.some((i) => i.sourceId === 'cash-match' && i.date === '2026-06-01'));
      assert.ok(separate.some((i) => i.sourceId === tx));
      await h.api.cash.matchEntry({ id: 'cash-match', transactionId: tx, expectedCashDate: '2026-06-01', reason: 'Kartenzahlung zugeordnet' });
      const matched = await items();
      assert.equal(matched.filter((i) => i.amountGross === 42).length, 1, 'one expense of 42, not two');
      assert.equal(matched.find((i) => i.sourceId === 'cash-match')?.date, '2026-06-03', 'the bank date decides the period');
      assert.ok(!matched.some((i) => i.sourceId === tx));
      await h.api.cash.unmatchEntry({ id: 'cash-match', reason: 'falsch zugeordnet' });
      const restored = await items();
      assert.equal(restored.filter((i) => i.amountGross === 42).length, 2);
      assert.equal(restored.find((i) => i.sourceId === 'cash-match')?.date, '2026-06-01');
    });
  });

  describe('suggestions and rules', () => {
    const hosting = () => items().then((all) => all.find((i) => i.purpose === 'Hosting Server')!);
    const rules = (year = 2026) => h.api.eur.listRules({ taxYear: year });

    test('without rules: invoice payments suggest KZ 112, bank rows a keyword guess', async () => {
      const invoicePayment = items26.find((i) => i.sourceId === payId('invA', 'invAPay'))!;
      assert.equal(invoicePayment.suggestedLineId, YEAR_LINE(2026, '112'));
      const bank = await hosting();
      assert.equal(bank.suggestionLayer, 'keyword');
      assert.ok(bank.suggestedLineId);
      const telekom = (await items()).find((i) => i.counterparty === 'Telekom')!;
      assert.deepEqual([telekom.suggestedLineId, telekom.suggestionLayer], [YEAR_LINE(2026, '280'), 'keyword'], 'telephone costs');
    });

    test('a rule suggests its line; priority decides between two matching rules', async () => {
      const low = await h.api.eur.upsertRule({ taxYear: 2026, priority: 20, field: 'purpose', operator: 'contains', value: 'hosting', targetEurLineId: YEAR_LINE(2026, '228') });
      assert.equal(low.active, true);
      let item = await hosting();
      assert.deepEqual([item.suggestedLineId, item.suggestionLayer, item.suggestionReason], [YEAR_LINE(2026, '228'), 'rule', 'Ihre Zuordnungsregel']);
      const high = await h.api.eur.upsertRule({ taxYear: 2026, priority: 1, field: 'counterparty', operator: 'equals', value: 'HOSTER AG', targetEurLineId: YEAR_LINE(2026, '224') });
      item = await hosting();
      assert.equal(item.suggestedLineId, YEAR_LINE(2026, '224'), 'priority 1 beats 20; matching is case-insensitive');
      assert.deepEqual((await rules()).map((r) => r.id), [high.id, low.id], 'listed by priority');
      await h.api.eur.deleteRule({ id: high.id });
      assert.equal((await hosting()).suggestedLineId, YEAR_LINE(2026, '228'), 'deleted rule stops suggesting');
      await h.api.eur.deleteRule({ id: low.id });
      assert.equal((await hosting()).suggestionLayer, 'keyword', 'no rule left: back to the keyword guess');
    });

    test('startsWith, inactive rules and rules of another year', async () => {
      const startsWith = await h.api.eur.upsertRule({ taxYear: 2026, priority: 5, field: 'any', operator: 'startsWith', value: 'Hoster', targetEurLineId: YEAR_LINE(2026, '228') });
      assert.equal((await hosting()).suggestionLayer, 'rule');
      await h.api.eur.upsertRule({ id: startsWith.id, taxYear: 2026, priority: 5, field: 'any', operator: 'startsWith', value: 'Hoster', targetEurLineId: YEAR_LINE(2026, '228'), active: false });
      assert.equal((await hosting()).suggestionLayer, 'keyword', 'an inactive rule is ignored');
      await h.api.eur.upsertRule({ id: startsWith.id, taxYear: 2025, priority: 5, field: 'any', operator: 'startsWith', value: 'Hoster', targetEurLineId: YEAR_LINE(2025, '228') });
      assert.equal((await hosting()).suggestionLayer, 'keyword', 'a 2025 rule does not apply to 2026');
      assert.equal((await rules(2026)).length, 0);
      assert.equal((await rules(2025)).length, 1);
      await h.api.eur.deleteRule({ id: startsWith.id });
    });

    test('rule changes are audited with their reason', async () => {
      const csv = await h.api.audit.exportCsv();
      assert.ok(csv.includes('eur_rule.upsert') && csv.includes('eur_rule.delete'));
      assert.ok(csv.includes('EÜR-Klassifikationsregel gespeichert'));
    });

    test('deleting an unknown rule is a 404, a rule needs a value and a known year', async () => {
      await assert.rejects(h.api.eur.deleteRule({ id: 'does-not-exist' }), /EUR_RULE_NOT_FOUND/);
      const empty = await h.raw('POST', '/reports/eur/rules', { taxYear: 2026, priority: 1, field: 'any', operator: 'contains', value: '', targetEurLineId: YEAR_LINE(2026, '228'), reason: 'x' });
      assert.equal(empty.status, 400);
      const noReason = await h.raw('DELETE', '/reports/eur/rules/whatever', {});
      assert.equal(noReason.status, 400);
    });

    test('a rule may only point at an existing, matching line', async () => {
      const response = await h.raw('POST', '/reports/eur/rules', { taxYear: 2026, priority: 1, field: 'any', operator: 'contains', value: 'x', targetEurLineId: 'E2026_DOES_NOT_EXIST', reason: 'Regel' });
      assert.equal(response.status, 400, response.text);
    });
  });

  describe('classification and totals', () => {
    const incomeLine = YEAR_LINE(2026, '112');
    const classifiedGross = { income: 0, expense: 0 };

    test('nothing is income or expense until it is classified; the open items are counted', async () => {
      const report = await reportOf();
      assert.deepEqual(report.summary, { incomeTotal: 0, expenseTotal: 0, surplus: 0 });
      const all = await items();
      assert.equal(report.unclassifiedCount, all.length);
      assert.equal(report.catalog.delivery, 'print-form-only');
      assert.equal(report.catalog.elsterReady, false);
      assert.equal(report.from, '2026-01-01');
      assert.equal(report.to, '2026-12-31');
      assert.equal(report.catalog.id, 'anlage-euer-2026');
      assert.match(report.catalog.sourceHash, /^[a-f0-9]{64}$/);
      assert.equal(report.rows.length, 107, 'the 2026 print form has 107 lines');
      assert.equal(report.rows.filter((row) => row.kind === 'computed').length > 0, true);
      const report25 = await reportOf(2025);
      assert.equal(report25.catalog.id, 'anlage-euer-2025');
      assert.notEqual(report25.catalog.sourceHash, report.catalog.sourceHash, 'each year has its own catalog');
      assert.equal(report25.rows.length, 107);
      assert.ok(report25.rows.every((row) => row.lineId.startsWith('E2025_')) && report.rows.every((row) => row.lineId.startsWith('E2026_')));
    });

    test('classifying income books net to KZ 112 and the collected VAT to KZ 140 (total = cash received)', async () => {
      const income = [
        [payId('invA', 'invAPay'), 238], [payId('invA', 'invARefund'), -59.5], [payId('invB', 'invBPay1'), 113], [payId('invB', 'invBPay2'), 113],
        [payId('invD', 'invDPay2'), 119],
      ] as const;
      for (const [sourceId, gross] of income) {
        const saved = await classify(sourceId, incomeLine);
        assert.equal(saved.status, 200, saved.text);
        classifiedGross.income += gross;
      }
      const viaBank = await itemFor((i) => i.sourceType === 'invoice' && i.sourceId.startsWith(ids.invE));
      assert.equal((await classify(viaBank.sourceId, incomeLine)).status, 200);
      classifiedGross.income += 107;

      const report = await reportOf();
      // net: 200 - 50 + 100 + 100 + 100 + 100
      assert.equal(totalOf(report, '112'), 550);
      // vereinnahmte USt: 38 - 9.50 + 13 + 13 + 19 + 7
      assert.equal(totalOf(report, '140'), 80.5);
      assert.equal(report.summary.incomeTotal, 630.5);
      assert.equal(report.summary.incomeTotal, money(classifiedGross.income), 'EÜR income = the cash that actually came in');
      assert.equal(totalOf(report, '159'), 630.5, 'Summe Betriebseinnahmen');
      assert.equal(report.summary.expenseTotal, 0);
      assert.equal(report.summary.surplus, 630.5);
    });

    test('a bank income with a VAT rate is split net/VAT (net + collected VAT = the cash received)', async () => {
      const tx = await txId('Kunde X');
      const saved = await classify(tx, incomeLine, { vatMode: 'default', vatRate: 19 }, 'transaction');
      assert.equal(saved.status, 200, saved.text);
      assert.equal(saved.body.vatRate, 19);
      const report = await reportOf();
      assert.deepEqual(report.warnings, []);
      assert.equal(totalOf(report, '112'), money(550 + 500 / 1.19));
      assert.equal(totalOf(report, '140'), money(80.5 + (500 - 500 / 1.19)));
      assert.equal(report.summary.incomeTotal, 1130.5);
      classifiedGross.income += 500;
    });

    test('VAT mode "default" without a rate is flagged instead of silently booking 0 % VAT', async () => {
      const tx = await txId('Kunde X');
      try {
        await classify(tx, incomeLine, { vatMode: 'default' }, 'transaction');
        const report = await reportOf();
        assert.ok(report.warnings.some((w) => w.startsWith('VAT_RATE_REQUIRED')), `warnings: ${report.warnings}`);
      } finally {
        await classify(tx, incomeLine, { vatMode: 'default', vatRate: 19 }, 'transaction');
      }
    });

    test('a VAT rate outside 0..100 is refused', async () => {
      const tx = await txId('Kunde X');
      assert.equal((await classify(tx, incomeLine, { vatMode: 'default', vatRate: 101 }, 'transaction')).status, 400);
      assert.equal((await classify(tx, incomeLine, { vatMode: 'default', vatRate: -1 }, 'transaction')).status, 400);
      assert.equal((await reportOf()).summary.incomeTotal, 1130.5, 'the saved rate is untouched');
    });

    test('expenses: net to the chosen line, paid input VAT to KZ 185, neutral VAT-free rows as is', async () => {
      const hoster = await txId('Hoster AG');
      assert.equal((await classify(hoster, YEAR_LINE(2026, '228'), { vatMode: 'default', vatRate: 19 }, 'transaction')).status, 200);
      assert.equal((await classify('cash-receipt', YEAR_LINE(2026, '183'), {}, 'manual')).status, 200);
      assert.equal((await classify('cash-plain', YEAR_LINE(2026, '183'), {}, 'manual')).status, 200);
      for (const purpose of ['Telefon September', 'Telefon Dezember']) {
        assert.equal((await classify(await txId('Telekom', purpose), YEAR_LINE(2026, '280'), {}, 'transaction')).status, 200);
      }
      classifiedGross.expense += 59.5 + 119 + 30 + 12.5 + 10;
      const report = await reportOf();
      assert.equal(totalOf(report, '228'), 50, '59.50 gross at 19 %');
      assert.equal(totalOf(report, '183'), 130, '100 (receipt net) + 30 (no receipt, gross)');
      assert.equal(totalOf(report, '280'), 22.5);
      assert.equal(totalOf(report, '185'), 28.5, 'Vorsteuer 9.50 (bank) + 19 (receipt)');
      assert.equal(report.summary.expenseTotal, 231);
      assert.equal(report.summary.expenseTotal, money(classifiedGross.expense), 'EÜR expense = the cash that actually went out');
      assert.equal(totalOf(report, '199'), 231, 'Summe Betriebsausgaben');
    });

    test('the manual income without receipt can be tax-free income (KZ 103)', async () => {
      assert.equal((await classify('cash-income', YEAR_LINE(2026, '103'), {}, 'manual')).status, 200);
      classifiedGross.income += 40;
      const report = await reportOf();
      assert.equal(totalOf(report, '103'), 40);
      assert.equal(report.summary.incomeTotal, 1170.5);
      assert.equal(report.summary.surplus, 939.5);
      assert.equal(totalOf(report, '290'), 939.5, 'Korrigierter Gewinn');
      assert.equal(totalOf(report, '219'), 939.5, 'Steuerpflichtiger Gewinn');
    });

    test('moving an item to another line removes it from the old total', async () => {
      const before = await reportOf();
      const moved = await classify('cash-plain', YEAR_LINE(2026, '224'), { note: 'Werbematerial' }, 'manual');
      assert.equal(moved.status, 200);
      assert.equal(moved.body.eurLineId, YEAR_LINE(2026, '224'));
      assert.equal(moved.body.note, 'Werbematerial');
      const after = await reportOf();
      assert.equal(totalOf(after, '183'), money(totalOf(before, '183')! - 30));
      assert.equal(totalOf(after, '224'), 30);
      assert.equal(after.summary.surplus, before.summary.surplus, 'only the line changes, not the profit');
      const listed = await itemFor((i) => i.sourceId === 'cash-plain');
      assert.equal(listed.classification?.eurLineId, YEAR_LINE(2026, '224'));
    });

    test('an excluded item (private) drops out of the totals and is not "unclassified"', async () => {
      const before = await reportOf();
      const telekom = await txId('Telekom', 'Telefon Dezember');
      const excluded = await classify(telekom, undefined, { excluded: true, note: 'privat' }, 'transaction');
      assert.equal(excluded.status, 200);
      assert.equal(excluded.body.excluded, true);
      const after = await reportOf();
      assert.equal(after.summary.expenseTotal, money(before.summary.expenseTotal - 10));
      assert.equal(after.unclassifiedCount, before.unclassifiedCount);
      assert.equal((await items(2026, { status: 'excluded' })).length, 1);
      // and it can be put back
      assert.equal((await classify(telekom, YEAR_LINE(2026, '280'), { excluded: false }, 'transaction')).status, 200);
      assert.equal((await reportOf()).summary.expenseTotal, before.summary.expenseTotal);
    });

    test('a classification names a real, matching, non-computed line and a real source', async () => {
      const source = payId('invB', 'invBPay1');
      const wrongFlow = await classify(source, YEAR_LINE(2026, '280'));
      assert.equal(wrongFlow.status, 400);
      assert.match(wrongFlow.text, /EUR_LINE_FLOW_MISMATCH/);
      const computed = await classify(source, YEAR_LINE(2026, '159'));
      assert.equal(computed.status, 400);
      assert.match(computed.text, /EUR_COMPUTED_LINE_NOT_CLASSIFIABLE/);
      const unknownLine = await classify(source, 'E2026_KZ999');
      assert.equal(unknownLine.status, 400);
      assert.match(unknownLine.text, /EUR_LINE_NOT_FOUND/);
      const lineOfOtherYear = await classify(source, YEAR_LINE(2025, '112'));
      assert.equal(lineOfOtherYear.status, 400, 'a 2025 line cannot classify a 2026 item');
      const ghost = await classify('no-such-source', incomeLine, {}, 'transaction');
      assert.equal(ghost.status, 400);
      assert.match(ghost.text, /nicht vorhanden/);
      const outsideYear = await classify(await txId('Telekom', 'Telefon Dezember alt'), YEAR_LINE(2026, '280'), {}, 'transaction');
      assert.equal(outsideYear.status, 400, 'a 2025 bank row cannot be classified into 2026');
      assert.equal((await reportOf()).summary.incomeTotal, 1170.5, 'rejected calls change nothing');
    });

    test('every classification needs a reason and lands in the audit log', async () => {
      const source = payId('invB', 'invBPay1');
      assert.equal((await classify(source, incomeLine, { reason: '   ' })).status, 400);
      await assert.rejects(h.api.eur.upsertClassification({ sourceType: 'invoice', sourceId: source, taxYear: 2026, eurLineId: incomeLine, reason: '' }));
      const saved = await h.api.eur.upsertClassification({ sourceType: 'invoice', sourceId: source, taxYear: 2026, eurLineId: incomeLine, reason: 'Rechnung RE-B geprüft' });
      assert.equal(saved.eurLineId, incomeLine);
      const csv = await h.api.audit.exportCsv();
      assert.ok(csv.includes('eur_classification') && csv.includes('Rechnung RE-B geprüft'));
      assert.equal((await h.api.audit.verify()).ok, true);
    });

    test('a counterparty classified once is suggested for its other rows', async () => {
      const extra = 'Neue Telekom Rechnung';
      await importBankRows(h.api, account, [['2026-11-02', -9, 'Telekom', extra]]);
      const suggested = await itemFor((i) => i.purpose === extra);
      assert.deepEqual([suggested.suggestedLineId, suggested.suggestionLayer], [YEAR_LINE(2026, '280'), 'counterparty']);
    });
  });

  describe('list filters', () => {
    test('status, source, flow, account and search narrow the list; limit/offset page through it in date order', async () => {
      const all = await items();
      const unclassified = await items(2026, { status: 'unclassified' });
      const classified = await items(2026, { status: 'classified' });
      assert.equal(unclassified.length + classified.length + (await items(2026, { status: 'excluded' })).length, all.length);
      assert.ok(unclassified.every((i) => !i.classification?.eurLineId && !i.classification?.excluded));
      assert.deepEqual((await items(2026, { onlyUnclassified: true })).map((i) => i.sourceId), unclassified.map((i) => i.sourceId));
      assert.deepEqual((await items(2026, { onlyUnclassified: true, status: 'classified' })).map((i) => i.sourceId), unclassified.map((i) => i.sourceId), 'onlyUnclassified wins over status');
      assert.ok((await items(2026, { sourceType: 'manual' })).every((i) => i.sourceType === 'manual'));
      assert.equal((await items(2026, { sourceType: 'manual' })).length, 4, 'three plus the matched diesel entry');
      const expenses = await items(2026, { flowType: 'expense' });
      assert.ok(expenses.length > 0 && expenses.every((i) => i.flowType === 'expense'));
      assert.ok((await items(2026, { accountId: account })).every((i) => i.accountId === account));
      assert.deepEqual((await items(2026, { search: 'TELEKOM' })).map((i) => i.counterparty), Array(3).fill('Telekom'), 'case-insensitive');
      assert.equal((await items(2026, { search: 'no-such-text' })).length, 0);
      const page1 = await items(2026, { limit: 3, offset: 0 });
      const page2 = await items(2026, { limit: 3, offset: 3 });
      assert.deepEqual([...page1, ...page2].map((i) => i.sourceId), all.slice(0, 6).map((i) => i.sourceId));
      assert.deepEqual(all.map((i) => i.date), [...all.map((i) => i.date)].sort().reverse(), 'newest first');
      assert.deepEqual((await items(2026, { search: '2026-12-31' })).map((i) => i.purpose), ['Telefon Dezember'], 'the search also matches the date');
      assert.ok((await items(2026, { search: '59.5' })).some((i) => i.counterparty === 'Hoster AG'), 'and the amount');
    });

    test('filters are combined and the year decides the base set', async () => {
      const result = await items(2026, { sourceType: 'transaction', flowType: 'expense', search: 'telekom', status: 'classified' });
      assert.ok(result.length >= 2 && result.every((i) => i.sourceType === 'transaction' && i.flowType === 'expense' && i.counterparty === 'Telekom' && i.classification?.eurLineId));
      assert.deepEqual((await items(2025, { search: 'telekom' })).map((i) => i.purpose), ['Telefon Dezember alt']);
    });
  });

  describe('cash facts and annex facts', () => {
    const fact = (body: Record<string, unknown>) => h.raw('POST', '/reports/eur/facts/cash', { taxYear: 2026, reason: 'Beleg geprüft', ...body });

    test('a private withdrawal is neutral: it leaves the profit alone', async () => {
      await importBankRows(h.api, account, [['2026-07-01', -300, 'Max Muster', 'Privatentnahme']]);
      const tx = await txId('Max Muster', 'Privatentnahme');
      const before = await reportOf();
      const response = await fact({ sourceType: 'transaction', sourceId: tx, kind: 'private-withdrawal', amountNet: 300 });
      assert.equal(response.status, 200, response.text);
      const after = await reportOf();
      assert.deepEqual(after.summary, before.summary);
      assert.equal(after.unclassifiedCount, before.unclassifiedCount - 1, 'a typed fact is a decision');
      assert.ok((await items(2026, { status: 'classified' })).some((i) => i.sourceId === tx), 'listed as classified');
      assert.ok(!(await items(2026, { onlyUnclassified: true })).some((i) => i.sourceId === tx));
      const neutralWithLine = await fact({ sourceType: 'transaction', sourceId: tx, kind: 'private-withdrawal', amountNet: 300, eurLineId: YEAR_LINE(2026, '183') });
      assert.equal(neutralWithLine.status, 400);
      assert.match(neutralWithLine.text, /EUR_NEUTRAL_FACT_MUST_NOT_HAVE_LINE/);
    });

    test('a split books only the deductible part; the parts must add up to the amount', async () => {
      await importBankRows(h.api, account, [['2026-07-05', -100, 'Gastro GmbH', 'Bewirtung']]);
      const tx = await txId('Gastro GmbH');
      const split = (a: number, b: number) => [
        { amountNet: a, deductibility: 'deductible', lineId: YEAR_LINE(2026, '165'), reason: '70 % abziehbar' },
        { amountNet: b, deductibility: 'non-deductible', reason: '30 % nicht abziehbar' },
      ];
      const before = await reportOf();
      const wrong = await fact({ sourceType: 'transaction', sourceId: tx, kind: 'expense', flowType: 'expense', amountNet: 100, splits: split(70, 29.99) });
      assert.equal(wrong.status, 400);
      assert.match(wrong.text, /EUR_SPLIT_ALLOCATION_MISMATCH/);
      const noReason = await fact({ sourceType: 'transaction', sourceId: tx, kind: 'expense', flowType: 'expense', amountNet: 100, splits: [{ amountNet: 100, deductibility: 'deductible', lineId: YEAR_LINE(2026, '165'), reason: '' }] });
      assert.equal(noReason.status, 400);
      const ok = await fact({ sourceType: 'transaction', sourceId: tx, kind: 'expense', flowType: 'expense', amountNet: 100, splits: split(70, 30) });
      assert.equal(ok.status, 200, ok.text);
      const after = await reportOf();
      assert.equal(totalOf(after, '165'), 70);
      assert.equal(after.summary.expenseTotal, money(before.summary.expenseTotal + 70));
      const listed = await h.raw('GET', '/reports/eur/facts/cash?taxYear=2026');
      assert.ok(listed.body.some((f: { sourceId: string; provenance: { catalogId: string } }) => f.sourceId === tx && f.provenance.catalogId === 'anlage-euer-2026'));
    });

    test('an idempotency key replays the same fact and refuses a different one', async () => {
      await importBankRows(h.api, account, [['2026-07-10', -50, 'Ersatzteile AG', 'Teile']]);
      const tx = await txId('Ersatzteile AG');
      const body = { sourceType: 'transaction', sourceId: tx, kind: 'expense', flowType: 'expense', amountNet: 50, eurLineId: YEAR_LINE(2026, '183'), idempotencyKey: 'fact-1' };
      const first = await fact(body);
      const again = await fact(body);
      assert.equal(first.status, 200, first.text);
      assert.equal(again.body.id, first.body.id);
      const conflict = await fact({ ...body, eurLineId: YEAR_LINE(2026, '224') });
      assert.equal(conflict.status, 409);
      assert.equal(((await h.raw('GET', '/reports/eur/facts/cash?taxYear=2026')).body as unknown[]).filter((f: any) => f.sourceId === tx).length, 1);
    });

    test('facts name a real source, a matching line and a supported year', async () => {
      assert.equal((await fact({ sourceType: 'transaction', sourceId: 'ghost', kind: 'expense', flowType: 'expense', amountNet: 1 })).status, 400);
      const tx = await txId('Ersatzteile AG');
      assert.equal((await fact({ sourceType: 'transaction', sourceId: tx, kind: 'expense', flowType: 'income', amountNet: 50 })).status, 400, 'kind and flow must agree');
      assert.equal((await fact({ sourceType: 'transaction', sourceId: tx, kind: 'expense', flowType: 'expense', amountNet: -1 })).status, 400);
      assert.equal((await fact({ taxYear: 2027, sourceType: 'transaction', sourceId: tx, kind: 'expense', flowType: 'expense', amountNet: 1 })).status, 400);
      assert.equal((await fact({ reason: '', sourceType: 'transaction', sourceId: tx, kind: 'expense', flowType: 'expense', amountNet: 1 })).status, 400);
    });

    test('annex facts (AVEÜR, SZ) are stored per year with reason and provenance and replay by idempotency key', async () => {
      const annex = (body: Record<string, unknown>) => h.raw('POST', '/reports/eur/facts/annex', { taxYear: 2026, annex: 'AVEÜR', reason: 'Anlagenverzeichnis geprüft', ...body });
      const catalog = getEurAnnexCatalog(2026, 'AVEÜR');
      const input = catalog.lines.find((l) => l.kind === 'input')!;
      const computed = catalog.lines.find((l) => l.kind === 'computed' && (l.computedFromIds?.length || l.computedTerms?.length))!;
      const body = { lineId: input.id, amount: 1234.56, sourceId: 'asset-1', date: '2026-12-31', idempotencyKey: 'annex-1' };
      const saved = await annex(body);
      assert.equal(saved.status, 200, saved.text);
      assert.deepEqual([saved.body.annex, saved.body.lineId, saved.body.amount, saved.body.date], ['AVEÜR', input.id, 1234.56, '2026-12-31']);
      assert.equal(saved.body.provenance.catalogId, 'anlage-euer-2026');
      assert.equal((await annex(body)).body.id, saved.body.id, 'replay');
      assert.equal((await annex({ ...body, amount: 1 })).status, 409, 'same key, other amount');
      const listed = await h.raw('GET', '/reports/eur/facts/annex?taxYear=2026&annex=AVE%C3%9CR');
      assert.deepEqual(listed.body.map((f: { id: string }) => f.id), [saved.body.id]);
      assert.deepEqual((await h.raw('GET', '/reports/eur/facts/annex?taxYear=2025')).body, [], 'another year is separate');
      const sz = getEurAnnexCatalog(2026, 'SZ').lines.find((l) => l.kind === 'input')!;
      assert.equal((await annex({ annex: 'SZ', lineId: sz.id, amount: 5, idempotencyKey: 'annex-sz' })).status, 200);
      const computedFact = await annex({ lineId: computed.id, amount: 1 });
      assert.equal(computedFact.status, 400);
      assert.match(computedFact.text, /EUR_COMPUTED_LINE_NOT_CLASSIFIABLE/);
      const unknownLine = await annex({ lineId: 'AVEUER_2026_NOPE', amount: 1 });
      assert.equal(unknownLine.status, 400);
      assert.match(unknownLine.text, /EUR_ANNEX_LINE_NOT_FOUND/);
      const wrongYearDate = await annex({ lineId: input.id, amount: 1, date: '2025-12-31' });
      assert.equal(wrongYearDate.status, 400);
      assert.match(wrongYearDate.text, /EUR_ANNEX_DATE_INVALID/);
      assert.equal((await annex({ lineId: input.id, amount: 1, reason: '' })).status, 400);
      assert.equal((await annex({ taxYear: 2027, lineId: input.id, amount: 1 })).status, 400);
    });
  });

  describe('CSV export', () => {
    test('exports exactly the exportable rows with a BOM, German decimals and the report totals', async () => {
      const report = await reportOf();
      const csv = await h.api.eur.exportCsv({ taxYear: 2026 });
      assert.ok(csv.startsWith('﻿Kennziffer;Bezeichnung;Betrag\n'));
      const rows = csv.slice(1).split('\n').slice(1);
      const exportable = report.rows.filter((row) => row.exportable);
      assert.equal(rows.length, exportable.length);
      for (const row of exportable) {
        const expected = `${row.kennziffer ?? ''};${row.label};${row.total.toFixed(2).replace('.', ',')}`;
        assert.ok(rows.includes(expected) || rows.includes(`${row.kennziffer ?? ''};"${row.label.replaceAll('"', '""')}";${row.total.toFixed(2).replace('.', ',')}`), `missing row: ${expected}`);
      }
      assert.ok(rows.includes(`112;Umsatzsteuerpflichtige Betriebseinnahmen;${String(totalOf(report, '112')!.toFixed(2)).replace('.', ',')}`), 'the KZ 112 row carries the report total');
      assert.ok(rows.includes(`199;Summe Betriebsausgaben;${report.summary.expenseTotal.toFixed(2).replace('.', ',')}`));
      assert.ok(!csv.includes('Kalenderjahr'), 'general header rows are not exportable');
      assert.ok(!/\d\.\d{2}\b/.test(rows.map((row) => row.split(';').at(-1)).join(' ')), 'no decimal point in amounts');
    });

    test('the 2025 export is separate from 2026', async () => {
      await classify(payId('invC', 'invCPay'), YEAR_LINE(2025, '112'), {}, 'invoice', 2025);
      const csv25 = await h.api.eur.exportCsv({ taxYear: 2025 });
      assert.match(csv25, /^﻿Kennziffer;Bezeichnung;Betrag/);
      assert.ok(csv25.split('\n').some((row) => row.startsWith('112;') && row.endsWith(';100,00')), csv25);
      const report25 = await reportOf(2025);
      assert.equal(report25.summary.incomeTotal, 119);
      assert.equal(totalOf(report25, '140', 2025), 19);
    });
  });

  describe('boundaries', () => {
    test('unsupported tax years and partial-year ranges are rejected', async () => {
      await assert.rejects(h.api.eur.getReport({ taxYear: 2027 }), /EUR_CATALOG_UNAVAILABLE/);
      await assert.rejects(h.api.eur.listItems({ taxYear: 2027 } as never), /EUR_CATALOG_UNAVAILABLE/);
      await assert.rejects(h.api.eur.exportCsv({ taxYear: 2027 }), /EUR_CATALOG_UNAVAILABLE/);
      await assert.rejects(h.api.eur.getReport({ taxYear: 2024 }));
      await assert.rejects(h.api.eur.getReport({ taxYear: 2026, from: '2026-02-01' }), /EUR_RANGE_2026_REQUIRED/);
      await assert.rejects(h.api.eur.getReport({ taxYear: 2026, to: '2026-06-30' }), /EUR_RANGE_2026_REQUIRED/);
      for (const url of ['?taxYear=2027', '?taxYear=2026&from=2026-02-01', '?taxYear=2026&to=2026-11-30', '?taxYear=2025&from=2026-01-01', '?taxYear=abc', '?from=2026-01-01', '?taxYear=2026.5']) {
        assert.equal((await h.raw('GET', `/reports/eur${url}`)).status, 400, url);
        assert.equal((await h.raw('GET', `/reports/eur/items${url}`)).status, 400, `items${url}`);
      }
      assert.equal((await classify(payId('invB', 'invBPay1'), YEAR_LINE(2026, '112'), {}, 'invoice', 2027)).status, 400);
    });

    test('without a token nothing is readable or writable', async () => {
      for (const [method, path] of [['GET', '/reports/eur?taxYear=2026'], ['GET', '/reports/eur/items?taxYear=2026'], ['PUT', '/reports/eur/classifications'], ['GET', '/reports/eur/rules?taxYear=2026'], ['GET', '/reports/vat?from=2026-01-01&to=2026-01-31']] as const) {
        const response = await fetch(`${h.connection.baseUrl}/api/v1/lite${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'PUT' ? '{}' : undefined });
        assert.equal(response.status, 401, `${method} ${path}`);
      }
    });

    test('EÜR is only available for a sole proprietor with profit determination EÜR', async () => {
      const original = (await h.api.settings.get()) as any;
      await h.api.settings.set({ settings: { ...original, businessReportingProfile: { jurisdiction: 'DE', legalForm: 'gmbh', profitDetermination: 'double_entry', hgbSizeClass: 'small', chart: 'SKR03', vatMethod: 'soll', fiscalYearStart: '01-01' } } } as never);
      try {
        const blocked = await h.raw('GET', '/reports/eur?taxYear=2026');
        assert.equal(blocked.status, 409);
        assert.match(blocked.text, /Einzelunternehmen/);
        assert.equal((await h.raw('GET', '/reports/eur/items?taxYear=2026')).status, 409);
        assert.equal((await classify(payId('invB', 'invBPay1'), YEAR_LINE(2026, '112'))).status, 409);
        const vat = await h.api.vat.getReport({ from: '2026-01-01', to: '2026-01-31' });
        assert.ok(!vat.issues.some((issue) => issue.code === 'DE_PROFILE_REQUIRED'), 'the VAT preparation only needs a German profile, not EÜR');
      } finally {
        await h.api.settings.set({ settings: original } as never);
      }
      assert.equal((await h.raw('GET', '/reports/eur?taxYear=2026')).status, 200);
    });
  });

  describe('Kleinunternehmer (§ 19 UStG)', () => {
    const kuLine = YEAR_LINE(2025, '111');
    let kuInvoice: string;
    let kuPayment: string;
    before(async () => {
      await configureLite(h.api, { smallBusiness: true });
      const invoice = await issueDated(h.api, { client: 'KU Kunde', date: '2025-03-01', servicePeriod: '2025-03-01', taxMode: 'small_business_19_ustg', items: [line('Beratung', 300)] });
      kuInvoice = invoice.id;
      kuPayment = (await pay(h.api, invoice.id, 300, '2025-03-15')).id;
      await importBankRows(h.api, account, [['2025-03-20', -119, 'Lieferant KU', 'Material']]);
    });
    after(async () => { await configureLite(h.api, { smallBusiness: false }); });

    test('without VAT, net equals gross everywhere and the suggestion is KZ 111', async () => {
      const kuItems = await items(2025);
      const payment = kuItems.find((i) => i.sourceId === `${kuInvoice}:payment:${kuPayment}`);
      assert.ok(payment);
      assert.deepEqual([payment.amountGross, payment.amountNet, payment.suggestedLineId], [300, 300, kuLine]);
      assert.equal(kuItems.find((i) => i.counterparty === 'Lieferant KU')?.amountNet, 119);
      assert.equal((await classify(payment.sourceId, kuLine, {}, 'invoice', 2025)).status, 200);
      const expense = kuItems.find((i) => i.counterparty === 'Lieferant KU')!;
      assert.equal((await classify(expense.sourceId, YEAR_LINE(2025, '183'), { vatMode: 'default', vatRate: 19 }, 'transaction', 2025)).status, 200);
      const report = await reportOf(2025);
      assert.equal(totalOf(report, '111', 2025), 300);
      assert.equal(totalOf(report, '140', 2025) ?? 0, 0, 'no collected VAT');
      assert.equal(totalOf(report, '183', 2025), 119, 'a Kleinunternehmer cannot split off input VAT');
      assert.equal(totalOf(report, '185', 2025) ?? 0, 0);
    });

    test('the VAT preparation reports the sales as VAT-free (KZ 48) and never deducts input VAT', async () => {
      await saveReceiptFor('ku-eingang', 'KU-1');
      const q1 = await h.api.vat.getReport({ from: '2025-01-01', to: '2025-03-31' });
      assert.equal(q1.smallBusiness, true);
      assert.deepEqual([q1.positions.find((p) => p.code === '48')?.basisCents, q1.positions.find((p) => p.code === '48')?.taxCents], [30000, 0]);
      assert.equal(q1.outputVatCents, 0);
      assert.equal(q1.inputVatCents, 0, 'no Vorsteuerabzug for a Kleinunternehmer, whatever the receipt shows');
      assert.ok(q1.positions.filter((p) => p.direction === 'input').every((p) => p.taxCents === 0), 'input positions carry no tax');
    });

    test('cash income that shows VAT is held back for review instead of being booked', async () => {
      await saveReceiptFor('ku-income', 'KU-2', { deductiblePercent: 0 });
      await h.api.cash.saveEntry({ entry: { id: 'ku-sale', cashDate: '2025-03-25', amountCents: 11900, currency: 'EUR', flowType: 'income', counterparty: 'Barkunde', purpose: 'Barverkauf', receiptId: 'ku-income' }, reason: 'Barverkauf' } as never);
      const q1 = await h.api.vat.getReport({ from: '2025-01-01', to: '2025-03-31' });
      assert.ok(q1.issues.some((i) => i.code === 'KU_INCOME_VAT_REVIEW' && i.sourceId === 'ku-income'));
      assert.equal(q1.preparationComplete, false);
      assert.equal(q1.outputVatCents, 0, 'and it does not turn into output VAT on its own');
    });

    const saveReceiptFor = async (id: string, number: string, over: Record<string, unknown> = {}) => {
      await h.api.cash.saveReceipt({ receipt: { id, number, counterparty: 'Beleg GmbH', documentDate: '2025-03-10', receivedDate: '2025-03-10', serviceDate: '2025-03-10', grossAmountCents: 11900, taxMode: 'domestic', deductiblePercent: 100, reviewed: true, taxBreakdown: [{ rate: 19, netAmountCents: 10000, vatAmountCents: 1900 }], ...over }, reason: 'Beleg geprüft' } as never);
      await h.api.cash.uploadFile({ receiptId: id, fileName: `${id}.xml`, mimeType: 'application/xml', contentBase64: Buffer.from(`<R>${number}</R>`).toString('base64'), reason: 'Original' } as never);
    };
  });

  describe('persistence', () => {
    test('classifications, rules, reports and the audit chain survive an app restart', async () => {
      await configureLite(h.api, { smallBusiness: false });
      const rule = await h.api.eur.upsertRule({ taxYear: 2026, priority: 3, field: 'counterparty', operator: 'contains', value: 'persist', targetEurLineId: YEAR_LINE(2026, '228') });
      const before = { report: await reportOf(), items: await items(), items25: await items(2025), rules: await h.api.eur.listRules({ taxYear: 2026 }), vat: await h.api.vat.getReport({ from: '2026-04-01', to: '2026-04-30' }) };
      assert.ok(before.rules.some((r) => r.id === rule.id));
      await h.close({ keepData: true });
      const second = await startLite(null, 'reports-eur-restart', h.userDataPath);
      try {
        const after = { report: await second.api.eur.getReport({ taxYear: 2026 }), items: await second.api.eur.listItems({ taxYear: 2026 } as never), items25: await second.api.eur.listItems({ taxYear: 2025 } as never), rules: await second.api.eur.listRules({ taxYear: 2026 }) };
        assert.deepEqual(after.report, before.report);
        assert.deepEqual(after.items, before.items);
        assert.deepEqual(after.items25, before.items25);
        assert.deepEqual(after.rules, before.rules);
        const vat = await second.api.vat.getReport({ from: '2026-04-01', to: '2026-04-30' });
        assert.equal(vat.sourceHash, before.vat.sourceHash, 'unchanged data keeps its fingerprint');
        assert.deepEqual(vat.positions, before.vat.positions);
        assert.equal((await second.api.audit.verify()).ok, true);
      } finally {
        await second.close();
      }
    });
  });
});

describe('VAT preparation', () => {
  let h: LiteHarness;
  const account = 'bank-vat';
  const ids = {} as Record<string, string>;
  const report = (from: string, to: string) => h.api.vat.getReport({ from, to });
  const month = (m: number) => {
    const mm = String(m).padStart(2, '0');
    return report(`2026-${mm}-01`, `2026-${mm}-${new Date(Date.UTC(2026, m, 0)).getUTCDate()}`);
  };
  const position = (r: Awaited<ReturnType<typeof month>>, code: string, direction?: string) =>
    r.positions.find((p) => p.code === code && (direction === undefined || p.direction === direction));
  const setMethod = (vatMethod: 'soll' | 'ist') => configureLite(h.api, { vatMethod });
  const receipt = (over: Record<string, unknown>) => ({
    id: randomUUID(), number: 'R-1', counterparty: 'Lieferant GmbH', documentDate: '2026-02-10', receivedDate: '2026-02-11', serviceDate: '2026-02-01',
    grossAmountCents: 11900, taxMode: 'domestic', deductiblePercent: 100, reviewed: true, taxBreakdown: [{ rate: 19, netAmountCents: 10000, vatAmountCents: 1900 }], ...over,
  });
  const saveReceipt = async (over: Record<string, unknown>, withFile = true) => {
    const input = receipt(over);
    const existing = (await h.api.cash.listReceipts()).find((r) => r.id === input.id);
    await h.api.cash.saveReceipt({ receipt: input, expectedUpdatedAt: existing?.updatedAt, reason: 'Beleg geprüft' } as never);
    if (withFile) await h.api.cash.uploadFile({ receiptId: input.id, fileName: `beleg-${input.id}.xml`, mimeType: 'application/xml', contentBase64: Buffer.from(`<Receipt><ID>${input.number}</ID></Receipt>`).toString('base64'), reason: 'Original archiviert' } as never);
    return input;
  };
  const entry = (id: string, cashDate: string, amountCents: number, receiptId?: string) =>
    h.api.cash.saveEntry({ entry: { id, cashDate, amountCents, currency: 'EUR', flowType: amountCents < 0 ? 'expense' : 'income', counterparty: 'Lieferant GmbH', purpose: `Zahlung ${id}`, ...(receiptId ? { receiptId } : {}) }, reason: 'Zahlung erfasst' } as never);

  before(async () => {
    h = await startLite(null, 'reports-vat');
    await configureLite(h.api, { vatMethod: 'ist' });
    await h.api.accounts.upsert({ account: bankAccount(account) } as never);
    // Q2: 100 @19 % + 100 @7 %, paid in instalments, overpaid, then refunded.
    const mixed = await issueDated(h.api, { client: 'Mixed GmbH', date: '2026-04-01', servicePeriod: '2026-04-01', items: [line('Beratung', 100, 19), line('Fachbuch', 100, 7)] });
    ids.mixed = mixed.id;
    await pay(h.api, mixed.id, 113, '2026-04-30');
    await pay(h.api, mixed.id, 123, '2026-05-03');
    await pay(h.api, mixed.id, -10, '2026-06-01', 'refund');
    await pay(h.api, mixed.id, -56.5, '2026-06-02', 'refund');
    // July: every special tax treatment once (net 100 … 700).
    const meta = { taxRuleConfirmed: true, buyerVatId: 'ATU12345678', buyerCountryCode: 'AT', sellerCountryCode: 'DE' };
    const special: Array<[string, number]> = [['small_business_19_ustg', 100], ['reverse_charge_13b', 200], ['intra_eu_supply_6a', 300], ['intra_eu_service_reverse_charge', 400], ['export_third_country', 500], ['vat_exempt_4_ustg', 600], ['non_taxable_outside_scope', 700]];
    for (const [mode, net] of special) await issueDated(h.api, { client: `Sonder ${mode}`, date: '2026-07-10', servicePeriod: '2026-07-10', taxMode: mode as never, taxMeta: meta as never, items: [line(mode, net)] });
    await issueDated(h.api, { client: 'Unbestätigt', date: '2026-07-11', servicePeriod: '2026-07-11', taxMode: 'reverse_charge_13b', taxMeta: { buyerVatId: 'ATU12345678' } as never, items: [line('Unbestätigt', 50)] });
    // August: an unpaid invoice that is cancelled, and a draft.
    const cancelled = await issueDated(h.api, { client: 'Storno GmbH', date: '2026-08-05', servicePeriod: '2026-08-05', items: [line('Beratung', 100, 19)] });
    ids.cancelled = cancelled.id;
    await h.api.documents.chainIssue({ operation: 'correction', id: randomUUID(), invoiceId: cancelled.id, kind: 'cancellation_invoice', date: '2026-08-20', dueDate: '2026-08-20', reason: 'Storno' } as never);
    await draftInvoice(h.api, { client: 'Entwurf GmbH', date: '2026-08-06' });
    // September: partial credit note on an unpaid invoice.
    const credited = await issueDated(h.api, { client: 'Gutschrift GmbH', date: '2026-09-01', servicePeriod: '2026-09-01', items: [line('Beratung', 200, 19)] });
    ids.credited = credited.id;
    await h.api.documents.chainIssue({ operation: 'correction', id: randomUUID(), invoiceId: credited.id, kind: 'credit_note', amount: 59.5, date: '2026-09-15', dueDate: '2026-09-15', reason: 'Teilgutschrift' } as never);
    // Q1: input VAT from receipts.
    await saveReceipt({ id: 'r-feb-1', number: 'LIEF-100', documentDate: '2026-02-10', receivedDate: '2026-02-11', serviceDate: '2026-02-01' });
    await saveReceipt({ id: 'r-feb-2', number: 'LIEF-101', counterparty: 'Buchhandel', documentDate: '2026-02-12', receivedDate: '2026-02-12', serviceDate: '2026-02-12', grossAmountCents: 21400, deductiblePercent: 50, taxBreakdown: [{ rate: 7, netAmountCents: 20000, vatAmountCents: 1400 }] });
    await saveReceipt({ id: 'r-jan-inst', number: 'LIEF-099', documentDate: '2026-01-05', receivedDate: '2026-01-06', serviceDate: '2026-01-05' });
    await entry('inst-1', '2026-01-10', -5950, 'r-jan-inst');
    await entry('inst-2', '2026-02-10', -5950, 'r-jan-inst');
  });
  after(async () => { await h.close(); });

  describe('Ist-Versteuerung (cash basis)', () => {
    test('output VAT follows the payments of the month; the rate split is kept (81 = 19 %, 86 = 7 %)', async () => {
      const april = await month(4);
      assert.equal(april.method, 'ist');
      assert.equal(april.smallBusiness, false);
      assert.equal(april.outputVatCents, 1300);
      assert.deepEqual([position(april, '81')?.basisCents, position(april, '81')?.taxCents, position(april, '81')?.direction], [5000, 950, 'output']);
      assert.deepEqual([position(april, '86')?.basisCents, position(april, '86')?.taxCents], [5000, 350]);
      assert.deepEqual(april.reconciliation, { paymentCashCents: 11300, paymentRecognizedCents: 11300, paymentResidualCents: 0 });
      assert.equal(april.payableCents, 1300);
      assert.equal(april.submissionReady, false, 'the preparation never claims to be a submission');
      assert.deepEqual(april.sources.map((src) => [src.sourceType, src.sourceId, src.date, src.code, src.basisCents, src.taxCents]).sort(), [['invoice', ids.mixed, '2026-04-30', '81', 5000, 950], ['invoice', ids.mixed, '2026-04-30', '86', 5000, 350]].sort(), 'one source row per rate, dated by the payment');
    });

    test('an overpayment adds no VAT, is flagged, and its refund nets out in the month it is paid back', async () => {
      const may = await month(5);
      assert.equal(may.outputVatCents, 1300, 'only the remaining 113 of the invoice is taxed');
      assert.deepEqual(may.reconciliation, { paymentCashCents: 12300, paymentRecognizedCents: 11300, paymentResidualCents: 1000 });
      assert.ok(may.issues.some((i) => i.code === 'PAYMENT_RESIDUAL' && i.sourceId === ids.mixed));
      assert.equal(may.preparationComplete, false);
      const june = await month(6);
      assert.equal(june.outputVatCents, -650, 'the 56.50 refund reverses VAT, the 10.00 refund of the overpayment does not');
      assert.equal(position(june, '81')?.taxCents, -475);
      assert.equal(position(june, '86')?.taxCents, -175);
      assert.equal(june.payableCents, -650, 'a negative Zahllast is a refund claim');
    });

    test('a quarter and the year add up the months', async () => {
      const q2 = await report('2026-04-01', '2026-06-30');
      assert.equal(q2.outputVatCents, 1300 + 1300 - 650);
      assert.equal(q2.reconciliation.paymentCashCents, 11300 + 12300 - 6650);
      const year = await report('2026-01-01', '2026-12-31');
      assert.ok(year.outputVatCents >= q2.outputVatCents);
    });

    test('Soll-Versteuerung recognises the full VAT in the month of the service, whatever is paid', async () => {
      await setMethod('soll');
      try {
        const [april, may, june] = [await month(4), await month(5), await month(6)];
        assert.equal(april.method, 'soll');
        assert.equal(april.outputVatCents, 2600);
        assert.equal(may.outputVatCents, 0);
        assert.equal(june.outputVatCents, 0);
        assert.ok(june.issues.some((i) => i.code === 'REFUND_CORRECTION_REQUIRED'), 'under Soll a refund needs a correction document');
        assert.equal((await report('2026-04-01', '2026-06-30')).outputVatCents, 2600);
      } finally {
        await setMethod('ist');
      }
      assert.equal((await month(4)).outputVatCents, 1300, 'switching back restores the Ist result');
    });
  });

  describe('special tax treatments and corrections', () => {
    test('every non-standard mode lands in its own position without any output VAT', async () => {
      const july = await month(7);
      const expected: Array<[string, number]> = [['21', 40000], ['41', 30000], ['43', 50000], ['45', 70000], ['48', 70000], ['60', 20000 + 5000]];
      for (const [code, basis] of expected) {
        const p = position(july, code);
        assert.ok(p, `position ${code}`);
        assert.equal(p.basisCents, basis, `basis of ${code}`);
        assert.equal(p.taxCents, 0);
        assert.equal(p.direction, 'information');
      }
      assert.equal(july.outputVatCents, 0);
      assert.equal(july.inputVatCents, 0);
      assert.deepEqual(july.positions.map((p) => p.code), ['21', '41', '43', '45', '48', '60']);
      assert.equal(position(july, '48')?.basisWholeEuros, 700, 'the ELSTER form takes whole euros');
    });

    test('a special treatment nobody confirmed is flagged for review', async () => {
      const july = await month(7);
      const unconfirmed = july.issues.filter((i) => i.code === 'TAX_TREATMENT_REVIEW');
      assert.equal(unconfirmed.length, 1);
      assert.equal(july.preparationComplete, false);
    });

    test('drafts are not reported; a cancelled unpaid invoice and its cancellation net to zero (Soll)', async () => {
      assert.deepEqual((await month(8)).positions, [], 'Ist: nothing paid, nothing taxed');
      await setMethod('soll');
      try {
        const august = await month(8);
        assert.equal(august.outputVatCents, 0);
        const p81 = position(august, '81');
        assert.deepEqual([p81?.basisCents, p81?.taxCents], [0, 0], '+19.00 of the original, -19.00 of the cancellation');
        assert.equal(august.sources.filter((s) => s.taxCents === 1900).length, 1);
        assert.equal(august.sources.filter((s) => s.taxCents === -1900).length, 1);
        assert.ok(!august.sources.some((s) => s.label === 'ENTWURF'));
      } finally {
        await setMethod('ist');
      }
    });

    test('a partial credit note reduces the VAT of its month (Soll)', async () => {
      await setMethod('soll');
      try {
        const september = await month(9);
        assert.equal(position(september, '81')?.taxCents, 3800 - 950, '38.00 of the invoice minus 9.50 of the credit note');
        assert.equal(september.outputVatCents, 2850);
      } finally {
        await setMethod('ist');
      }
    });

    test('the service date decides the month under Soll; a missing one is flagged', async () => {
      const noServiceDate = await issueDated(h.api, { client: 'Ohne Leistungsdatum', date: '2026-03-03', items: [line('Beratung', 100, 19)] });
      await setMethod('soll');
      try {
        const march = await month(3);
        assert.ok(march.issues.some((i) => i.code === 'SERVICE_DATE_REQUIRED' && i.sourceId === noServiceDate.id));
        assert.ok(march.sources.some((s) => s.sourceId === noServiceDate.id && s.date === '2026-03-03'), 'falls back to the invoice date');
      } finally {
        await setMethod('ist');
      }
    });
  });

  describe('input VAT from receipts', () => {
    test('reviewed receipts with their original file give input VAT in the month of receipt/service (KZ 66)', async () => {
      const february = await month(2);
      const p66 = position(february, '66', 'input');
      assert.ok(p66);
      assert.equal(p66.taxCents, 1900 + 700, '19 % in full plus 50 % of the 7 % receipt');
      assert.equal(p66.basisCents, 10000 + 20000);
      assert.equal(february.inputVatCents, 2600);
      assert.equal(february.payableCents, february.outputVatCents - 2600);
    });

    test('instalments do not repeat the input VAT: it belongs to the receipt, not to each payment', async () => {
      const january = await month(1);
      assert.equal(january.inputVatCents, 1900, 'once, in January');
      assert.equal(january.sources.filter((s) => s.sourceId === 'r-jan-inst').length, 1);
      const feb = await month(2);
      assert.ok(!feb.sources.some((s) => s.sourceId === 'r-jan-inst'), 'the February instalment adds nothing');
    });

    test('an unreviewed receipt, one without its original and one without dates do not silently count', async () => {
      await saveReceipt({ id: 'r-open', number: 'LIEF-200', reviewed: false, documentDate: '2026-02-20', receivedDate: undefined, serviceDate: undefined });
      await saveReceipt({ id: 'r-nofile', number: 'LIEF-201', documentDate: '2026-02-21', receivedDate: '2026-02-21', serviceDate: '2026-02-21' }, false);
      const february = await month(2);
      assert.equal(february.inputVatCents, 2600 + 1900, 'the file-less receipt counts (flagged), the unreviewed one does not');
      assert.ok(february.issues.some((i) => i.code === 'RECEIPT_REVIEW_REQUIRED' && i.sourceId === 'r-nofile'));
      assert.ok(february.issues.some((i) => i.code === 'RECEIPT_REVIEW_REQUIRED' && i.sourceId === 'r-open'));
      assert.ok(!february.sources.some((s) => s.sourceId === 'r-open'));
      assert.equal(february.preparationComplete, false);
    });

    test('a reviewed receipt must be tax-complete: gross = net + VAT, rates 0/7/19, VAT matching the rate', async () => {
      const bad = (over: Record<string, unknown>) => h.raw('POST', '/cash/receipts', { receipt: receipt({ id: randomUUID(), ...over }), reason: 'Prüfung' });
      assert.equal((await bad({ grossAmountCents: 12000 })).status, 400, 'gross differs from net + VAT');
      assert.equal((await bad({ taxBreakdown: [{ rate: 19, netAmountCents: 10000, vatAmountCents: 1500 }] })).status, 400, 'VAT does not match 19 %');
      assert.equal((await bad({ taxBreakdown: [{ rate: 16, netAmountCents: 10000, vatAmountCents: 1600 }] })).status, 400, 'only 0/7/19 exist');
      assert.equal((await bad({ taxBreakdown: [] })).status, 400, 'a reviewed receipt needs a tax breakdown');
      assert.equal((await bad({ receivedDate: undefined })).status, 400);
      assert.equal((await bad({ taxMode: 'small_business', taxBreakdown: [{ rate: 19, netAmountCents: 10000, vatAmountCents: 1900 }] })).status, 400, 'a small-business supplier charges no VAT');
      assert.equal((await bad({ documentDate: '2026-02-30' })).status, 400);
      assert.equal((await bad({ grossAmountCents: 0 })).status, 400);
    });

    test('reverse charge (EU service): own output VAT (KZ 46/47) and the matching input VAT (KZ 67) cancel out', async () => {
      await saveReceipt({ id: 'r-eu', number: 'EU-1', counterparty: 'EU Supplier SA', documentDate: '2026-03-10', receivedDate: '2026-03-12', serviceDate: '2026-03-01', grossAmountCents: 10000, taxMode: 'eu_service' });
      const march = await month(3);
      const out = position(march, '46', 'output');
      assert.deepEqual([out?.taxCode, out?.taxCents, out?.basisCents], ['47', 1900, 10000]);
      assert.equal(position(march, '67', 'input')?.taxCents, 1900);
      assert.equal(march.outputVatCents, 1900);
      assert.equal(march.inputVatCents, 1900);
    });

    test('import VAT needs the customs date; a correction receipt needs its original and reason', async () => {
      await saveReceipt({ id: 'r-import', number: 'ZOLL-1', taxMode: 'import', documentDate: '2026-03-15', receivedDate: '2026-03-16', serviceDate: '2026-03-15' });
      let march = await month(3);
      assert.ok(march.issues.some((i) => i.code === 'IMPORT_TAX_DATE_REQUIRED' && i.sourceId === 'r-import'));
      assert.ok(!position(march, '62'));
      await saveReceipt({ id: 'r-import', number: 'ZOLL-1', taxMode: 'import', documentDate: '2026-03-15', receivedDate: '2026-03-16', serviceDate: '2026-03-15', importTaxDate: '2026-03-14' }, false);
      march = await month(3);
      assert.equal(position(march, '62', 'input')?.taxCents, 1900, 'Einfuhrumsatzsteuer');
      await saveReceipt({ id: 'r-neg', number: 'GS-1', documentDate: '2026-03-20', receivedDate: '2026-03-20', serviceDate: '2026-03-20', grossAmountCents: -2380, taxBreakdown: [{ rate: 19, netAmountCents: -2000, vatAmountCents: -380 }] });
      assert.ok((await month(3)).issues.some((i) => i.code === 'RECEIPT_CORRECTION_REQUIRED' && i.sourceId === 'r-neg'));
      await saveReceipt({ id: 'r-neg', number: 'GS-1', documentDate: '2026-03-20', receivedDate: '2026-03-20', serviceDate: '2026-03-20', grossAmountCents: -2380, taxBreakdown: [{ rate: 19, netAmountCents: -2000, vatAmountCents: -380 }], correctionOfReceiptId: 'r-feb-1', adjustmentDate: '2026-03-20', correctionReason: 'Preisnachlass' }, false);
      const afterFix = await month(3);
      assert.equal(afterFix.issues.some((i) => i.code === 'RECEIPT_CORRECTION_REQUIRED' && i.sourceId === 'r-neg'), false);
      assert.equal(position(afterFix, '66', 'input')?.taxCents, -380, 'the correction reduces the input VAT in the month of the adjustment');
    });

    test('intra-EU acquisition: own output VAT (KZ 89 for 19 %) and the matching input VAT (KZ 61), dated at the invoice, not at the payment', async () => {
      await saveReceipt({ id: 'r-ig', number: 'IGE-1', counterparty: 'FR Fournisseur', documentDate: '2025-12-10', receivedDate: '2025-12-11', serviceDate: '2025-12-05', grossAmountCents: 10000, taxMode: 'intra_eu_acquisition' });
      await entry('ig-pay', '2026-01-20', -10000, 'r-ig');
      const december = await report('2025-12-01', '2025-12-31');
      const out = position(december, '89', 'output');
      assert.deepEqual([out?.basisCents, out?.taxCents], [10000, 1900]);
      assert.equal(position(december, '61', 'input')?.taxCents, 1900);
      assert.equal(december.payableCents, 0);
      assert.equal((await report('2026-01-01', '2026-01-31')).sources.some((src) => src.sourceId === 'r-ig'), false, 'the January payment adds nothing');
    });

    test('other §13b supplies (KZ 84/85) are recognised at the invoice date, capped at the end of the month after the service', async () => {
      await saveReceipt({ id: 'r-13b', number: 'RC-1', counterparty: 'Bau Subunternehmer', documentDate: '2025-12-20', receivedDate: '2025-12-21', serviceDate: '2025-10-10', grossAmountCents: 10000, taxMode: 'reverse_charge' });
      const november = await report('2025-11-01', '2025-11-30');
      const out = position(november, '84', 'output');
      assert.deepEqual([out?.taxCode, out?.basisCents, out?.taxCents], ['85', 10000, 1900], 'service in October, invoice in December: due at the end of November');
      assert.equal(position(november, '67', 'input')?.taxCents, 1900);
      for (const [from, to] of [['2025-10-01', '2025-10-31'], ['2025-12-01', '2025-12-31']]) {
        assert.equal((await report(from, to)).sources.some((src) => src.sourceId === 'r-13b'), false, `${from}..${to}`);
      }
    });

    test('an advance payment gives input VAT pro rata when paid, the rest at the service date', async () => {
      await saveReceipt({ id: 'r-advance', number: 'ABS-1', counterparty: 'Lieferant GmbH', documentDate: '2025-08-15', receivedDate: '2025-08-16', serviceDate: '2025-09-15', grossAmountCents: 11900, advancePayment: true });
      await entry('adv-1', '2025-08-20', -5950, 'r-advance');
      await entry('adv-2', '2025-09-20', -5950, 'r-advance');
      const [august, september] = [await report('2025-08-01', '2025-08-31'), await report('2025-09-01', '2025-09-30')];
      assert.equal(august.inputVatCents, 950, 'half of the VAT for the half paid in advance');
      assert.equal(position(august, '66', 'input')?.basisCents, 5000);
      assert.equal(september.inputVatCents, 950, 'the rest at the service date; the payment after the service adds nothing');
    });

    test('bank rows and cash entries need tax evidence before the month counts as complete', async () => {
      await importBankRows(h.api, account, [['2026-01-20', -20, 'Unbelegt GmbH', 'Ohne Beleg']]);
      await entry('cash-orphan', '2026-01-22', -1000);
      let january = await month(1);
      const bank = (await h.api.transactions.list({} as never)).find((t) => t.counterparty === 'Unbelegt GmbH')!;
      assert.ok(january.issues.some((i) => i.code === 'BANK_TAX_EVIDENCE_REQUIRED' && i.sourceId === bank.id));
      assert.ok(january.issues.some((i) => i.code === 'CASH_RECEIPT_REQUIRED' && i.sourceId === 'cash-orphan'));
      assert.equal(january.preparationComplete, false);
      const privateWithdrawal = await h.raw('PUT', '/reports/eur/classifications', { sourceType: 'transaction', sourceId: bank.id, taxYear: 2026, excluded: true, reason: 'privat' });
      assert.equal(privateWithdrawal.status, 200, privateWithdrawal.text);
      january = await month(1);
      assert.ok(!january.issues.some((i) => i.code === 'BANK_TAX_EVIDENCE_REQUIRED'), 'a reviewed private/neutral decision settles the evidence');
      assert.ok(january.issues.some((i) => i.code === 'CASH_RECEIPT_REQUIRED'));
    });
  });

  describe('exports', () => {
    test('CSV: German decimals, a position and a source row per figure, formulas are neutralised', async () => {
      await saveReceipt({ id: 'r-evil', number: '=HYPERLINK("http://evil.example","klick")', counterparty: 'Evil', documentDate: '2026-02-25', receivedDate: '2026-02-25', serviceDate: '2026-02-25' });
      const exported = await h.api.vat.exportCsv({ from: '2026-02-01', to: '2026-02-28' });
      assert.equal(exported.mimeType, 'text/csv');
      assert.equal(exported.fileName, 'umsatzsteuer-vorbereitung-2026-02-01-2026-02-28.csv');
      const text = Buffer.from(exported.contentBase64, 'base64').toString('utf8');
      assert.ok(text.startsWith('﻿"Umsatzsteuer-Vorbereitung";"2026-02-01";"2026-02-28";"ist";"Prüfung offen";"Keine ELSTER-Übermittlung"'));
      const feb = await month(2);
      assert.ok(text.includes(`"Vorsteuer EUR";"${(feb.inputVatCents / 100).toFixed(2).replace('.', ',')}"`), 'input VAT with a decimal comma');
      assert.ok(text.includes('"66";"66";"Vorsteuer aus inländischen Rechnungen";"input";"'), 'position row');
      assert.ok(text.includes('"\'=HYPERLINK(""http://evil.example"",""klick"")"'), 'a receipt number starting with = is prefixed with an apostrophe');
      assert.ok(!/(^|;)"=HYPERLINK/.test(text), 'no cell starts with a formula');
      assert.ok(text.includes(feb.sourceHash));
    });

    test('PDF export is a real PDF named after the period', async () => {
      const exported = await h.api.vat.exportPdf({ from: '2026-04-01', to: '2026-06-30' });
      assert.equal(exported.mimeType, 'application/pdf');
      assert.equal(exported.fileName, 'umsatzsteuer-vorbereitung-2026-04-01-2026-06-30.pdf');
      assert.equal(Buffer.from(exported.contentBase64, 'base64').subarray(0, 5).toString(), '%PDF-');
    });

    test('the data fingerprint is stable for unchanged data and moves when a payment arrives', async () => {
      const first = await month(4);
      const second = await month(4);
      assert.equal(second.sourceHash, first.sourceHash);
      const invoice = await issueDated(h.api, { client: 'Hash GmbH', date: '2026-04-02', servicePeriod: '2026-04-02', items: [line('Beratung', 10, 19)] });
      await pay(h.api, invoice.id, 11.9, '2026-04-20');
      const third = await month(4);
      assert.notEqual(third.sourceHash, first.sourceHash);
      assert.equal(third.outputVatCents, first.outputVatCents + 190);
    });
  });

  describe('periods', () => {
    test('only whole months, calendar quarters and the calendar year of 2025/2026 are accepted', async () => {
      const bad: Array<[string, string]> = [
        ['2026-01-15', '2026-01-31'], ['2026-01-01', '2026-01-30'], ['2026-02-01', '2026-04-30'], ['2026-01-01', '2026-02-28'], ['2026-03-01', '2026-05-31'],
        ['2026-01-01', '2027-01-31'], ['2024-01-01', '2024-12-31'], ['2027-01-01', '2027-01-31'], ['2026-02-01', '2026-02-30'], ['2026-03-31', '2026-03-01'], ['26-01-01', '26-01-31'],
      ];
      for (const [from, to] of bad) {
        await assert.rejects(h.api.vat.getReport({ from, to }), Error, `${from}..${to}`);
        assert.equal((await h.raw('GET', `/reports/vat?from=${from}&to=${to}`)).status, 400, `${from}..${to}`);
        assert.equal((await h.raw('GET', `/reports/vat/export/csv?from=${from}&to=${to}`)).status, 400, `export ${from}..${to}`);
      }
      for (const [from, to] of [['2025-01-01', '2025-01-31'], ['2025-07-01', '2025-09-30'], ['2026-10-01', '2026-12-31'], ['2025-01-01', '2025-12-31'], ['2026-02-01', '2026-02-28']] as const) {
        assert.equal((await h.raw('GET', `/reports/vat?from=${from}&to=${to}`)).status, 200, `${from}..${to}`);
      }
      assert.equal((await h.raw('GET', '/reports/vat')).status, 400);
      assert.equal((await h.raw('GET', '/reports/vat/export/xml?from=2026-01-01&to=2026-01-31')).status, 400, 'only csv and pdf exist');
    });

    test('only a German business profile can be stored', async () => {
      const original = await h.api.settings.get() as any;
      const response = await h.raw('PUT', '/settings', { settings: { ...original, businessReportingProfile: { ...original.businessReportingProfile, jurisdiction: 'AT' } } });
      assert.equal(response.status, 400);
      assert.equal((await month(1)).issues.some((issue) => issue.code === 'DE_PROFILE_REQUIRED'), false);
    });
  });

  describe('tax data on documents', () => {
    test('tax mode, tax meta and the per-rate snapshot of invoices and offers survive saving and refetching', async () => {
      const meta = { sellerCountryCode: 'DE', buyerCountryCode: 'AT', buyerVatId: 'ATU12345678', taxRuleConfirmed: true };
      const invoice = await issueDated(h.api, { client: 'Alpen GmbH', date: '2026-08-06', servicePeriod: '2026-08-06', taxMode: 'intra_eu_service_reverse_charge', taxMeta: meta as never, items: [line('Beratung', 100, 19)] });
      const offerMeta = { sellerCountryCode: 'DE', buyerCountryCode: 'CH', taxRuleConfirmed: true };
      const offer = await draftOffer(h.api, { client: 'Swiss AG', taxMode: 'export_third_country', taxMeta: offerMeta as never, items: [line('Export', 100)] });
      const storedInvoice = (await h.api.invoices.list()).find((i) => i.id === invoice.id)!;
      const storedOffer = (await h.api.offers.list()).find((o) => o.id === offer.id)!;
      assert.equal(storedInvoice.taxMode, 'intra_eu_service_reverse_charge');
      assert.deepEqual(storedInvoice.taxMeta, meta);
      assert.deepEqual([storedInvoice.taxSnapshot?.netAmount, storedInvoice.taxSnapshot?.vatAmount, storedInvoice.taxSnapshot?.grossAmount, storedInvoice.taxSnapshot?.einvoiceCategoryCode], [100, 0, 100, 'AE']);
      assert.match(storedInvoice.taxSnapshot?.taxNotice ?? '', /Reverse Charge/);
      assert.equal(storedOffer.taxMode, 'export_third_country');
      assert.deepEqual(storedOffer.taxMeta, offerMeta);
      assert.deepEqual([storedOffer.taxSnapshot?.vatAmount, storedOffer.taxSnapshot?.einvoiceCategoryCode], [0, 'G']);
      assert.match(storedOffer.taxSnapshot?.taxNotice ?? '', /Ausfuhr/);
    });
  });

  describe('tax filing (fail-closed in Lite)', () => {
    const snapshotPayload = { taxYear: 2025, reportSnapshotId: 'snapshot-1', sourceSnapshotHash: 'a'.repeat(64), total: 42, lines: [] };
    const create = (body: Record<string, unknown> = {}) => h.raw('POST', '/tax-filings', {
      kind: 'euer', periodStart: '2025-01-01', periodEnd: '2025-12-31', payload: snapshotPayload, idempotencyKey: 'create-1', reason: 'EÜR vorbereiten', ...body,
    });
    const act = (id: string, action: string, key = `${action}-1`) => h.raw('POST', `/tax-filings/${id}/${action}`, { reason: `${action} geprüft`, idempotencyKey: key });
    let filing: { id: string; status: string; snapshotHash: string };

    test('nothing is filed yet: no provider, no certificate, no records', async () => {
      const status = await h.api.taxFiling.getStatus();
      assert.equal(status.provider.available, false);
      assert.equal(status.provider.errorCode, 'PROVIDER_UNAVAILABLE');
      assert.deepEqual(status.certificates, []);
      assert.deepEqual(await h.api.taxFiling.listRecords(), []);
      assert.deepEqual((await h.raw('GET', '/tax-filings')).body, []);
    });

    test('a filing starts as an immutable draft, is audited and replays by its idempotency key', async () => {
      const created = await create();
      assert.equal(created.status, 200, created.text);
      filing = created.body;
      assert.equal(filing.status, 'draft');
      assert.match(filing.snapshotHash, /^[a-f0-9]{64}$/);
      const again = await create();
      assert.equal(again.body.id, filing.id, 'same key, same snapshot: the same filing');
      assert.equal(((await h.raw('GET', '/tax-filings')).body as unknown[]).length, 1);
      assert.equal((await h.raw('GET', `/tax-filings/${filing.id}`)).body.id, filing.id);
      assert.equal((await h.raw('GET', '/tax-filings/unknown')).body, null);
      assert.ok((await h.api.audit.exportCsv()).includes('tax_filing.create'));
    });

    test('the same key for another snapshot, a wrong provider or an incomplete request is refused', async () => {
      const conflict = await create({ payload: { ...snapshotPayload, total: 43 } });
      assert.equal(conflict.status, 422);
      assert.match(conflict.text, /another filing snapshot/);
      assert.equal((await create({ idempotencyKey: 'k-provider', provider: 'eric_e_bilanz' })).status, 422, 'an EÜR cannot go through the E-Bilanz provider');
      assert.equal((await create({ idempotencyKey: 'k-reason', reason: ' ' })).status, 400);
      assert.equal((await create({ idempotencyKey: '' })).status, 400);
      assert.equal((await create({ idempotencyKey: 'k-date', periodStart: '01.01.2025' })).status, 400);
      assert.equal((await create({ idempotencyKey: 'k-kind', kind: 'umsatzsteuer' })).status, 400);
      assert.equal(((await h.raw('GET', '/tax-filings')).body as unknown[]).length, 1, 'rejected requests created nothing');
    });

    test('a draft cannot jump ahead: freeze, approval, queue and retry are invalid transitions', async () => {
      for (const action of ['freeze', 'request-second-approval', 'approve', 'queue', 'retry']) {
        const response = await act(filing.id, action);
        assert.equal(response.status, 409, `${action}: ${response.text}`);
      }
      assert.equal((await h.raw('GET', `/tax-filings/${filing.id}`)).body.status, 'draft');
      assert.equal((await h.raw('POST', `/tax-filings/${filing.id}/freeze`, { reason: 'x' })).status, 400, 'a mutation needs an idempotency key');
      assert.equal((await h.raw('POST', `/tax-filings/${filing.id}/explode`, { reason: 'x', idempotencyKey: 'k' })).status, 400, 'unknown action');
    });

    test('validation needs report-snapshot provenance that exists in the tenant', async () => {
      const missingProvenance = await create({ idempotencyKey: 'k-bare', payload: { taxYear: 2025 } });
      const bare = await act(missingProvenance.body.id, 'validate', 'validate-bare');
      assert.equal(bare.status, 422);
      assert.match(bare.text, /provenance is required/);
      const unknownSnapshot = await act(filing.id, 'validate');
      assert.equal(unknownSnapshot.status, 422);
      assert.match(unknownSnapshot.text, /snapshot is missing or has changed/);
      assert.equal((await h.raw('GET', `/tax-filings/${filing.id}`)).body.status, 'draft');
    });

    test('operations on the official provider fail closed and only run for the frozen snapshot', async () => {
      const record = { id: filing.id, kind: 'euer', periodStart: '2025-01-01', periodEnd: '2025-12-31', sourceHash: filing.snapshotHash, status: 'frozen' };
      for (const operation of ['validate', 'export', 'submit']) {
        const stale = await h.raw('POST', `/tax-filing/${operation}`, { record: { ...record, sourceHash: 'b'.repeat(64) } });
        assert.equal(stale.status, 409, `${operation} with a stale hash`);
        const unknown = await h.raw('POST', `/tax-filing/${operation}`, { record: { ...record, id: 'nope' } });
        assert.equal(unknown.status, 409, `${operation} for an unknown filing`);
      }
      for (const operation of ['validate', 'export'] as const) {
        const result = await h.api[`taxFiling`][operation]({ record } as never);
        assert.equal(result.status, 'failed');
        assert.deepEqual(result.issues.map((i) => i.code), ['PROVIDER_UNAVAILABLE']);
      }
      const submitted = await h.api.taxFiling.submit({ record } as never);
      assert.equal(submitted.status, 'failed', 'a draft is never submitted');
      assert.equal((await h.raw('GET', `/tax-filings/${filing.id}`)).body.status, 'draft');
    });

    describe('ELSTER certificates', () => {
      const pem = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUZm9vYmFyMTIzNDU2Nzg5MDEyMzQwCgYIKoZIzj0EAwIw\n-----END CERTIFICATE-----';
      const cert = (over: Record<string, unknown> = {}) => ({ id: 'elster-2026', pem, password: 'geheim', expiresAt: '2027-12-31T00:00:00.000Z', subject: 'CN=Muster', ...over });
      const saved = { key: process.env.TAX_FILING_CREDENTIAL_KEY, id: process.env.TAX_FILING_CREDENTIAL_KEY_ID };
      const restore = () => {
        if (saved.key === undefined) delete process.env.TAX_FILING_CREDENTIAL_KEY; else process.env.TAX_FILING_CREDENTIAL_KEY = saved.key;
        if (saved.id === undefined) delete process.env.TAX_FILING_CREDENTIAL_KEY_ID; else process.env.TAX_FILING_CREDENTIAL_KEY_ID = saved.id;
      };
      after(restore);

      test('without an encryption key nothing is stored', async () => {
        delete process.env.TAX_FILING_CREDENTIAL_KEY;
        delete process.env.TAX_FILING_CREDENTIAL_KEY_ID;
        const response = await h.raw('POST', '/tax-filing/certificates', cert());
        assert.equal(response.status, 503);
        assert.deepEqual((await h.api.taxFiling.getStatus()).certificates, []);
      });

      test('with a key a certificate is installed encrypted, listed by fingerprint only, audited and removable', async () => {
        process.env.TAX_FILING_CREDENTIAL_KEY_ID = 'test-key-1';
        process.env.TAX_FILING_CREDENTIAL_KEY = 'ab'.repeat(32);
        const installed = await h.api.taxFiling.installCertificate(cert() as never);
        assert.equal(installed.id, 'elster-2026');
        assert.match(installed.fingerprint, /^[a-f0-9]{64}$/);
        const listed = (await h.raw('GET', '/tax-filing/status')).body;
        assert.deepEqual(listed.certificates.map((c: { id: string }) => c.id), ['elster-2026']);
        assert.ok(!JSON.stringify(listed).includes('BEGIN CERTIFICATE') && !JSON.stringify(listed).includes('geheim'), 'the status never reveals PEM or password');
        assert.equal(await h.api.taxFiling.removeCertificate({ id: 'elster-2026' }), true);
        assert.deepEqual((await h.api.taxFiling.getStatus()).certificates, []);
        assert.equal(await h.api.taxFiling.removeCertificate({ id: 'elster-2026' }), false, 'removing twice reports that nothing was there');
        const csv = await h.api.audit.exportCsv();
        assert.ok(csv.includes('tax_filing.certificate_install') && csv.includes('tax_filing.certificate_remove'));
      });

      test('a certificate must be a PEM with a valid id and expiry', async () => {
        process.env.TAX_FILING_CREDENTIAL_KEY_ID = 'test-key-1';
        process.env.TAX_FILING_CREDENTIAL_KEY = 'ab'.repeat(32);
        assert.equal((await h.raw('POST', '/tax-filing/certificates', cert({ pem: 'not a certificate' }))).status, 400);
        assert.equal((await h.raw('POST', '/tax-filing/certificates', cert({ id: '../etc/passwd' }))).status, 400);
        assert.equal((await h.raw('POST', '/tax-filing/certificates', cert({ expiresAt: 'tomorrow' }))).status, 400);
        assert.equal((await h.raw('POST', '/tax-filing/certificates', cert({ id: 'x'.repeat(81) }))).status, 400);
        assert.deepEqual((await h.api.taxFiling.getStatus()).certificates, []);
      });
    });
  });
});
