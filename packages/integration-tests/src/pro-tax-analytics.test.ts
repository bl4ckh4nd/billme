import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { startPro } from './harness.js';
import { get } from './pro-fixtures.js';

/**
 * Tax and money-account analyses from the journal (GET /pro/accounting/analytics/vat, /tax-payments,
 * /money-account), through the HTTP surface of the embedded backend, on an imported SKR03 journal.
 *
 * How this can fail:
 * - UStVA per period: another figure than the UStVA computation, a quarter that is not the sum of its months,
 *   a Frist on a weekend or without the 10th of the following month, a prepared UStVA not shown as prepared
 * - tax payments: an accrual (no money moved) counted as a payment, a refund counted as paid, a topic that
 *   mixes Lohnsteuer and Umsatzsteuer
 * - money account: a wrong opening or closing balance, the VAT line counted as a counter account, a non-money
 *   account accepted
 */

type Vat = { periods: Array<{ key: string; outputTax: number; inputTax: number; payable: number; deadline: string; status: string }>; totals: { payable: number }; topLines: Array<{ reference?: string; taxAmount: number }> };
type Payments = { topics: Array<{ key: string; paid: number; refunded: number; net: number; entries: Array<{ reference?: string; amount: number }> }> };
type MoneyYear = { accounts: Array<{ accountNumber: string; firstYear: number }>; openingBalance: number; closingBalance: number; inflow: number; outflow: number; months: Array<{ period: string; balance: number }>; counterAccounts: Array<{ accountNumber: string; name?: string; position?: string; inflow: number; outflow: number; count: number }>; topOutflows: Array<{ label: string; amount: number }> };

test('UStVA per period with Frist and status, payments to the tax offices and a money account over the year', async (t) => {
  const h = await startPro(t, 'pro-tax-analytics');
  const csv = [
    'Buchung;Datum;Belegnr;Buchungstext;Konto;Soll;Haben;Steuerfall',
    '1;15.01.2025;AR-1;Kunde Beispiel GmbH – Beratung;1200;1190,00;;',
    '1;;;;8400;;1190,00;USt19',
    '2;20.01.2025;ER-1;Büro Beispiel – Papier;4930;119,00;;VSt19',
    '2;;;;1200;;119,00;',
    '3;10.02.2025;LS-1;Finanzamt Lohnsteuer Januar;1741;300,00;;',
    '3;;;;1200;;300,00;',
    '4;12.02.2025;KS-1;Finanzamt Körperschaftsteuer;2200;500,00;;',
    '4;;;;1200;;500,00;',
    '5;10.03.2025;UV-1;Finanzamt USt Januar;1780;171,00;;',
    '5;;;;1200;;171,00;',
    '6;20.03.2025;UE-1;Finanzamt Erstattung USt;1200;50,00;;',
    '6;;;;1780;;50,00;',
    '7;31.03.2025;RL-1;Rückstellung KSt (kein Geld bewegt);2200;80,00;;',
    '7;;;;0970;;80,00;',
    '8;15.04.2025;AR-2;Kunde Beispiel GmbH – Beratung;1200;238,00;;',
    '8;;;;8400;;238,00;USt19',
  ].join('\n');
  const imported = await h.raw('POST', '/accounting/journal/import', { reason: 'Übernahme', format: 'journal_csv', contentBase64: Buffer.from(csv).toString('base64'), dryRun: false });
  assert.equal(imported.status, 200, imported.text);
  assert.equal(imported.body.postedCount, 8, JSON.stringify(imported.body.issues));

  const prepared = await h.raw('POST', '/accounting/tax-exports/prepare', { kind: 'ustva', period: '2025-01', year: 2025, idempotencyKey: `ustva-${randomUUID()}`, reason: 'UStVA Januar vorbereitet' });
  assert.equal(prepared.status, 200, prepared.text);

  const months = await get<Vat>(h, '/accounting/analytics/vat?from=2025-01-01&to=2025-04-30&granularity=month');
  assert.deepEqual(months.periods.map((period) => [period.key, period.outputTax, period.inputTax, period.payable]), [
    ['2025-01', 190, 19, 171], ['2025-02', 0, 0, 0], ['2025-03', 0, 0, 0], ['2025-04', 38, 0, 38],
  ]);
  assert.deepEqual(months.periods.map((period) => period.deadline), ['2025-02-10', '2025-03-10', '2025-04-10', '2025-05-12'], '10th of the next month, 10 May 2025 is a Saturday');
  assert.equal(months.periods[0]!.status, 'prepared');
  assert.equal(months.periods[3]!.status, 'past', 'long past and not prepared in Billme');
  assert.equal(months.totals.payable, 209);
  assert.deepEqual(months.topLines.map((line) => [line.reference, line.taxAmount]).slice(0, 3), [['AR-1', 190], ['AR-2', 38], ['ER-1', 19]]);

  const quarters = await get<Vat>(h, '/accounting/analytics/vat?from=2025-01-01&to=2025-06-30&granularity=quarter');
  assert.deepEqual(quarters.periods.map((period) => [period.key, period.payable, period.deadline]), [['2025-Q1', 171, '2025-04-10'], ['2025-Q2', 38, '2025-07-10']]);

  const payments = await get<Payments>(h, '/accounting/analytics/tax-payments?from=2025-01-01&to=2025-12-31');
  const topic = (key: string) => payments.topics.find((entry) => entry.key === key)!;
  assert.deepEqual([topic('vat').paid, topic('vat').refunded, topic('vat').net], [171, 50, 121], 'the refund lowers what was paid');
  assert.deepEqual([topic('wage').paid, topic('wage').net], [300, 300]);
  assert.deepEqual([topic('income').paid, topic('income').entries.map((entry) => entry.reference)], [500, ['KS-1']], 'the accrual without a money movement is no payment');
  assert.equal(topic('other').net, 0);

  const giro = await get<MoneyYear>(h, '/accounting/analytics/money-account?accountNumber=1200&year=2025');
  assert.deepEqual(giro.accounts.map((account) => [account.accountNumber, account.firstYear]), [['1200', 2025]]);
  assert.deepEqual([giro.openingBalance, giro.inflow, giro.outflow, giro.closingBalance], [0, 1478, 1090, 388]);
  assert.deepEqual(giro.months.slice(0, 4).map((month) => month.balance), [1071, 271, 150, 388]);
  assert.deepEqual(giro.counterAccounts.find((account) => account.accountNumber === '8400'), { accountNumber: '8400', name: giro.counterAccounts.find((account) => account.accountNumber === '8400')!.name, position: 'Umsatzerlöse', inflow: 1428, outflow: 0, count: 2 }, 'the whole receipt goes to the revenue account, not part of it to the VAT account');
  assert.ok(!giro.counterAccounts.some((account) => account.accountNumber === '1776'), 'no VAT account among the counter accounts');
  assert.deepEqual(giro.topOutflows[0], { label: 'Finanzamt Körperschaftsteuer', amount: 500, count: 1 });

  assert.equal((await h.raw('GET', '/accounting/analytics/money-account?accountNumber=4930&year=2025')).status, 400, 'not a money account');
  assert.equal((await h.raw('GET', '/accounting/analytics/vat?from=2025-04-01&to=2025-01-01')).status, 400);
});
