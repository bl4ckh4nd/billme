import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startPro } from './harness.js';
import { get } from './pro-fixtures.js';

/**
 * Overview figures from the journal (GET /pro/accounting/analytics/overview), through the HTTP surface of the
 * embedded backend, on a ledger that came in by journal import (no bank lines, no invoices).
 *
 * How this can fail:
 * - Erträge and Aufwand: the gross amount instead of the net, the tax lines counted as Aufwand, a refund that
 *   raises the Aufwand, a transfer between own accounts counted as either, a month without bookings missing
 * - liquidity: an account outside the money range counted (Geldtransit), the balance after `to` included
 * - breakdown: Aufwand grouped by account number instead of the BWA position, a wrong position label
 * - range: an inverted range answered instead of refused
 */

type Overview = {
  months: Array<{ period: string; revenue: number; expense: number; result: number }>;
  firstPeriod?: string; lastPeriod?: string;
  liquidity: { total: number; accounts: Array<{ accountNumber: string; balance: number }> };
  expenseBreakdown: Array<{ key: string; label: string; value: number }>;
  revenueBreakdown: Array<{ key: string; label: string; value: number }>;
};

test('the overview reads Erträge, Aufwand, money accounts and BWA cost types from an imported journal', async (t) => {
  const h = await startPro(t, 'pro-ledger-overview');
  const csv = [
    'Buchung;Datum;Belegnr;Buchungstext;Konto;Soll;Haben;Steuerfall',
    '1;15.01.2026;AR-1;Beratung;1200;1190,00;;',
    '1;;;;8400;;1190,00;USt19',
    '2;20.01.2026;ER-1;Büromaterial;4930;119,00;;VSt19',
    '2;;;;1200;;119,00;',
    '3;28.02.2026;LG-1;Gehalt;4120;2000,00;;',
    '3;;;;1200;;2000,00;',
    '4;05.03.2026;GS-1;Gutschrift Büromaterial;1200;59,50;;',
    '4;;;;4930;;50,00;VSt19',
    '4;;;;1576;;9,50;',
    '5;10.03.2026;UB-1;Kreditkarte;1360;500,00;;',
    '5;;;;1200;;500,00;',
    '6;02.04.2026;AR-2;Beratung April;1200;119,00;;',
    '6;;;;8400;;119,00;USt19',
    '7;10.06.2021;ER-2021;Miete 2021;4210;500,00;;',
    '7;;;;1200;;500,00;',
  ].join('\n');
  const imported = await h.raw('POST', '/accounting/journal/import', { reason: 'Übernahme', format: 'journal_csv', contentBase64: Buffer.from(csv).toString('base64'), dryRun: false });
  assert.equal(imported.status, 200, imported.text);
  assert.equal(imported.body.postedCount, 7, JSON.stringify(imported.body.issues));

  const overview = await get<Overview>(h, '/accounting/analytics/overview?from=2026-01-01&to=2026-03-31');
  assert.deepEqual(overview.months, [
    { period: '2026-01', revenue: 1000, expense: 100, result: 900 },
    { period: '2026-02', revenue: 0, expense: 2000, result: -2000 },
    { period: '2026-03', revenue: 0, expense: -50, result: 50 },
  ], 'net amounts per month; the refund lowers the Aufwand, the transfer is neither');
  assert.equal(overview.firstPeriod, '2021-06');
  assert.equal(overview.lastPeriod, '2026-04', 'the extent covers the whole journal, not only the range');
  assert.deepEqual(overview.liquidity.accounts.map((account) => [account.accountNumber, account.balance]), [['1200', -1869.5]], 'only money accounts, at the end of the range, earlier years included');
  assert.equal(overview.liquidity.total, -1869.5);
  assert.deepEqual(overview.expenseBreakdown.map((line) => [line.key, line.label, line.value]), [
    ['personnel-expense', 'Personalkosten', 2000],
    ['other-operating-expense', 'Sonstige Kosten', 50],
  ]);
  assert.deepEqual(overview.revenueBreakdown.map((line) => [line.key, line.label, line.value]), [['revenue', 'Umsatzerlöse', 1000]]);

  const april = await get<Overview>(h, '/accounting/analytics/overview?from=2026-04-01&to=2026-04-30');
  assert.deepEqual(april.months, [{ period: '2026-04', revenue: 100, expense: 0, result: 100 }]);
  assert.equal(april.liquidity.total, -1750.5, 'the balance at the end of April includes it');

  // A year before the first report catalogue (2025): the labels still come out.
  const old = await get<Overview>(h, '/accounting/analytics/overview?from=2021-01-01&to=2021-12-31');
  assert.equal(old.months.length, 12);
  assert.deepEqual(old.expenseBreakdown.map((line) => [line.key, line.label, line.value]), [['space-expense', 'Raumkosten', 500]]);

  const inverted = await h.raw('GET', '/accounting/analytics/overview?from=2026-04-01&to=2026-01-01');
  assert.equal(inverted.status, 400, inverted.text);
});
