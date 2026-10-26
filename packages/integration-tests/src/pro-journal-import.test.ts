import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { startPro, type ProHarness } from './harness.js';
import { assertLedgerConsistent, download, get, journal, setPeriod, type JournalEntry } from './pro-fixtures.js';

/**
 * Journal import (DATEV Buchungsstapel and journal CSV) of Billme Pro, through the HTTP surface of the embedded backend.
 *
 * How this can fail (each one has a test below):
 * - round trip: a DATEV stack exported by Billme that, imported into an empty tenant, gives other balances or another
 *   UStVA than the source (tax booked twice, net taken for gross, Vorsteuer and Umsatzsteuer swapped)
 * - DATEV keys: a BU 9 row without the Vorsteuer split, an Automatikkonto (8400) without its USt, a § 13b row (BU 94,
 *   Sachverhalt 1) without the self-assessed VSt/USt pair, a Personenkonto that is refused instead of booked on the
 *   receivables account
 * - journal CSV: a net line with its stated tax line split a second time, a gross line not split, a reverse-charge
 *   line without its tax pair, the tax figures missing from the UStVA
 * - all or nothing: a dry run that books, a file with one unknown account or one festgeschriebener month that books
 *   the rest, the same file imported twice that books twice, an import without a reason
 */

type ImportResult = {
  dryRun: boolean; posted: boolean; entryCount: number; newCount: number; importedCount: number; invalidCount: number; postedCount: number;
  missingAccounts: string[]; issues: Array<{ row: number; message: string; blocking: boolean }>;
  entries: Array<{ key: string; status: string; lines: Array<{ accountNumber: string; debitAmount: number; creditAmount: number; taxCaseKey?: string; taxAmount?: number }> }>;
};

const importFile = async (h: ProHarness, format: 'datev' | 'journal_csv', content: Buffer | string, dryRun: boolean, extra: Record<string, unknown> = {}) => {
  const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return h.raw('POST', '/accounting/journal/import', { reason: 'Übernahme aus der bisherigen Buchhaltung', format, fileName: `import.${format === 'datev' ? 'csv' : 'txt'}`, contentBase64: bytes.toString('base64'), dryRun, ...extra });
};
const ok = (response: { status: number; text: string; body: any }): ImportResult => {
  assert.equal(response.status, 200, response.text);
  return response.body as ImportResult;
};

const imported = async (h: ProHarness): Promise<JournalEntry[]> => (await journal(h)).filter((entry) => entry.sourceType === 'journal_import');
const linesOf = (entry: JournalEntry) => entry.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
const byReference = (entries: JournalEntry[], reference: string): JournalEntry => {
  const entry = entries.find((candidate) => candidate.reference === reference);
  assert.ok(entry, `entry ${reference} in ${JSON.stringify(entries.map((candidate) => candidate.reference))}`);
  return entry;
};
const balances = async (h: ProHarness) => new Map((await get<Array<{ accountNumber: string; closingBalance: number }>>(h, '/accounting/balances'))
  .filter((row) => Math.round(row.closingBalance * 100) !== 0).map((row) => [row.accountNumber, row.closingBalance]));
const vatRows = async (h: ProHarness, from: string, to: string) => (await get<{ rows: Array<{ taxCaseKey: string; netAmount: number; taxAmount: number }> }>(h, `/accounting/vat/summary?from=${from}&to=${to}`)).rows
  .map((row) => [row.taxCaseKey, row.netAmount, row.taxAmount]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));

const manual = (h: ProHarness, documentDate: string, reference: string, bookingText: string, lines: Array<{ accountNumber: string; debitAmount: number; creditAmount: number; taxCaseKey?: string }>) =>
  h.raw('POST', '/accounting/journal', { reason: 'Testbuchung', documentDate, reference, bookingText, idempotencyKey: randomUUID(), lines });

/** A DATEV Buchungsstapel of March 2026 (SKR03, Sachkontenlänge 4) as DATEV writes it: CP1252, header, heading, rows. */
const datevStack = (rows: Array<{ amount: string; side: 'S' | 'H'; konto: string; gegenkonto: string; bu?: string; date: string; beleg: string; text: string; sachverhalt?: string; euLand?: string }>, period = { from: '20260301', to: '20260331' }) => {
  const header = ['"EXTF"', 700, 21, '"Buchungsstapel"', 13, '20260401120000000', '', '"RE"', '""', '""', '1234567', '12345', '20260101', '4', period.from, period.to, '"Altdaten"', '""', 1, 0, 0, '"EUR"', '', '""', '', '', '"03"', '', '', '""', '""'].join(';');
  const heading = ['Umsatz (ohne Soll/Haben-Kz)', 'Soll/Haben-Kennzeichen', 'WKZ Umsatz', 'Kurs', 'Basis-Umsatz', 'WKZ Basis-Umsatz', 'Konto', 'Gegenkonto (ohne BU-Schlüssel)', 'BU-Schlüssel', 'Belegdatum', 'Belegfeld 1', 'Belegfeld 2', 'Skonto', 'Buchungstext'].join(';');
  const body = rows.map((row) => {
    const fields: string[] = Array.from({ length: 125 }, () => '');
    Object.assign(fields, { 0: row.amount, 1: `"${row.side}"`, 2: '"EUR"', 6: row.konto, 7: row.gegenkonto, 8: row.bu ? `"${row.bu}"` : '', 9: row.date, 10: `"${row.beleg}"`, 13: `"${row.text}"` });
    if (row.euLand) fields[39] = `"${row.euLand}"`;
    if (row.sachverhalt) fields[42] = row.sachverhalt;
    return fields.join(';');
  });
  return Buffer.from(`${header}\r\n${heading}\r\n${body.join('\r\n')}\r\n`, 'latin1');
};

test('a DATEV stack exported by Billme imports into an empty tenant with the same balances and the same UStVA', async (t) => {
  const source = await startPro(t, 'pro-journal-import-source');
  const target = await startPro(t, 'pro-journal-import-target');
  const posted = [
    await manual(source, '2026-03-03', 'ER-100', 'Software 19 %', [{ accountNumber: '4920', debitAmount: 119, creditAmount: 0, taxCaseKey: 'DE_STD_19' }, { accountNumber: '1200', debitAmount: 0, creditAmount: 119 }]),
    await manual(source, '2026-03-04', 'ER-101', 'Bürobedarf 7 %', [{ accountNumber: '4930', debitAmount: 107, creditAmount: 0, taxCaseKey: 'DE_STD_7' }, { accountNumber: '1200', debitAmount: 0, creditAmount: 107 }]),
    await manual(source, '2026-03-10', 'AR-200', 'Beratung', [{ accountNumber: '1200', debitAmount: 238, creditAmount: 0 }, { accountNumber: '8400', debitAmount: 0, creditAmount: 238, taxCaseKey: 'DE_STD_19' }]),
    await manual(source, '2026-03-12', 'UB-1', 'Geldtransit', [{ accountNumber: '1360', debitAmount: 50, creditAmount: 0 }, { accountNumber: '1200', debitAmount: 0, creditAmount: 50 }]),
  ];
  for (const response of posted) assert.equal(response.status, 200, response.text);
  const exported = await download(source, '/api/v1/pro/accounting/datev/export.csv?from=2026-03-01&to=2026-03-31&consultantNumber=1234567&clientNumber=12345&fiscalYearStart=2026-01-01&accountLength=4&encoding=cp1252');
  assert.equal(exported.status, 200, exported.bytes.toString());

  const preview = ok(await importFile(target, 'datev', exported.bytes, true));
  assert.equal(preview.dryRun, true);
  assert.equal(preview.postedCount, 0);
  assert.equal(preview.newCount, 4, JSON.stringify(preview.issues));
  assert.deepEqual(preview.issues.filter((issue) => issue.blocking), []);
  assert.equal((await imported(target)).length, 0, 'a dry run books nothing');

  const run = ok(await importFile(target, 'datev', exported.bytes, false));
  assert.equal(run.postedCount, 4, JSON.stringify(run.issues));
  assert.deepEqual(Object.fromEntries(await balances(target)), Object.fromEntries(await balances(source)), 'the same balances');
  assert.deepEqual(await vatRows(target, '2026-03-01', '2026-03-31'), await vatRows(source, '2026-03-01', '2026-03-31'), 'the same UStVA figures');
  await assertLedgerConsistent(target);
});

test('DATEV keys, Automatikkonten, § 13b and Personenkonten become the lines Billme itself would book', async (t) => {
  const h = await startPro(t, 'pro-journal-import-datev-keys');
  const stack = datevStack([
    { amount: '119,00', side: 'S', konto: '4920', gegenkonto: '1200', bu: '9', date: '0203', beleg: 'ER-1', text: 'Telefon BU 9' },
    { amount: '238,00', side: 'S', konto: '1200', gegenkonto: '8400', date: '0503', beleg: 'AR-1', text: 'Erlös Automatikkonto' },
    { amount: '100,00', side: 'S', konto: '4920', gegenkonto: '1200', bu: '94', sachverhalt: '1', date: '0703', beleg: 'ER-2', text: 'Cloud USA 13b', euLand: 'US' },
    { amount: '119,00', side: 'S', konto: '10001', gegenkonto: '8400', date: '1003', beleg: 'AR-2', text: 'Rechnung an Debitor' },
    { amount: '59,50', side: 'H', konto: '4920', gegenkonto: '1200', bu: '9', date: '1103', beleg: 'GS-1', text: 'Gutschrift Telefon' },
  ]);
  const run = ok(await importFile(h, 'datev', stack, false));
  assert.equal(run.postedCount, 5, JSON.stringify(run.issues));
  const entries = await imported(h);
  assert.deepEqual(linesOf(byReference(entries, 'ER-1')), [['1200', 0, 119], ['1576', 19, 0], ['4920', 100, 0]], 'BU 9: gross split into net and Vorsteuer');
  assert.deepEqual(linesOf(byReference(entries, 'AR-1')), [['1200', 238, 0], ['1776', 0, 38], ['8400', 0, 200]], 'Automatikkonto 8400: USt split without BU');
  assert.deepEqual(linesOf(byReference(entries, 'ER-2')), [['1200', 0, 100], ['1577', 19, 0], ['1787', 0, 19], ['4920', 100, 0]], 'BU 94 / Sachverhalt 1: the § 13b pair');
  assert.deepEqual(linesOf(byReference(entries, 'AR-2')), [['1400', 119, 0], ['1776', 0, 19], ['8400', 0, 100]], 'Personenkonto 10001 on the receivables account');
  assert.match(byReference(entries, 'AR-2').lines.find((line) => line.accountNumber === '1400')!.memo ?? '', /Personenkonto 10001/);
  assert.deepEqual(linesOf(byReference(entries, 'GS-1')), [['1200', 59.5, 0], ['1576', 0, 9.5], ['4920', 0, 50]], 'a refund (H) books the Vorsteuer back');
  const vat = await vatRows(h, '2026-03-01', '2026-03-31');
  assert.deepEqual(vat.find((row) => row[0] === 'NON_EU_SERVICE_RC'), ['NON_EU_SERVICE_RC', 100, 19], 'the § 13b row reaches the UStVA');
  // The summary adds both directions: Vorsteuer 19 and USt 38 + 19, the refund lowers its Vorsteuer by 9.50.
  assert.deepEqual(vat.find((row) => row[0] === 'DE_STD_19'), ['DE_STD_19', 350, 66.5]);
  assert.equal(byReference(entries, 'GS-1').lines.find((line) => line.accountNumber === '4920')!.taxAmount, -9.5, 'a Vorsteuer refund carries negative figures');
  await assertLedgerConsistent(h);
});

test('a journal CSV keeps stated tax lines (also a refund in Haben), splits gross lines and adds the reverse-charge pair; the same file books once', async (t) => {
  const h = await startPro(t, 'pro-journal-import-csv');
  const csv = [
    'Buchung;Datum;Belegnr;Buchungstext;Konto;Soll;Haben;Steuerfall;Land',
    '1;05.03.2026;ER-10;Büromaterial netto;4930;100,00;;VSt19;',
    '1;;;;1576;19,00;;;',
    '1;;;;1200;;119,00;;',
    '2;06.03.2026;AR-10;Erlös brutto;1200;238,00;;;',
    '2;;;;8400;;238,00;USt19;',
    '3;07.03.2026;ER-11;AWS;4920;100,00;;NON_EU_SERVICE_RC;US',
    '3;;;;1200;;100,00;;',
    '4;08.03.2026;UB-10;Kreditkartenabrechnung;1360;500,00;;;',
    '4;;;;1200;;500,00;;',
    '5;09.03.2026;GS-10;Gutschrift Büromaterial;1200;59,50;;;',
    '5;;;;4930;;50,00;VSt19;',
    '5;;;;1576;;9,50;;',
  ].join('\n');
  const preview = ok(await importFile(h, 'journal_csv', csv, true));
  assert.equal(preview.newCount, 5, JSON.stringify(preview.issues));
  assert.equal((await imported(h)).length, 0);
  const run = ok(await importFile(h, 'journal_csv', csv, false));
  assert.equal(run.postedCount, 5, JSON.stringify(run.issues));
  const entries = await imported(h);
  const net = byReference(entries, 'ER-10');
  assert.deepEqual(linesOf(net), [['1200', 0, 119], ['1576', 19, 0], ['4930', 100, 0]], 'the stated tax line is not split again');
  assert.equal(net.lines.find((line) => line.accountNumber === '4930')!.taxAmount, 19);
  assert.deepEqual(linesOf(byReference(entries, 'AR-10')), [['1200', 238, 0], ['1776', 0, 38], ['8400', 0, 200]], 'a gross line is split');
  assert.deepEqual(linesOf(byReference(entries, 'ER-11')), [['1200', 0, 100], ['1577', 19, 0], ['1787', 0, 19], ['4920', 100, 0]], 'reverse charge gets its tax pair');
  assert.deepEqual(linesOf(byReference(entries, 'UB-10')), [['1200', 0, 500], ['1360', 500, 0]]);
  const refund = byReference(entries, 'GS-10');
  assert.deepEqual(linesOf(refund), [['1200', 59.5, 0], ['1576', 0, 9.5], ['4930', 0, 50]], 'a Vorsteuer refund in Haben keeps its stated tax line');
  assert.equal(refund.lines.find((line) => line.accountNumber === '4930')!.taxAmount, -9.5);
  assert.deepEqual(await vatRows(h, '2026-03-01', '2026-03-31'), [['DE_STD_19', 250, 47.5], ['NON_EU_SERVICE_RC', 100, 19]]);

  const again = ok(await importFile(h, 'journal_csv', csv, false));
  assert.equal(again.importedCount, 5);
  assert.equal(again.postedCount, 0, 'the same file books nothing twice');
  assert.equal((await imported(h)).length, 5);
  await assertLedgerConsistent(h);
});

test('one unknown account or one festgeschriebener month stops the whole file; an import needs a reason', async (t) => {
  const h = await startPro(t, 'pro-journal-import-refusals');
  const unknown = [
    'Buchung;Datum;Belegnr;Buchungstext;Konto;Soll;Haben',
    '1;05.03.2026;B-1;gut;4930;10,00;',
    '1;;;;1200;;10,00',
    '2;06.03.2026;B-2;Konto fehlt;12;10,00;',
    '2;;;;1200;;10,00',
  ].join('\n');
  const refused = ok(await importFile(h, 'journal_csv', unknown, false));
  assert.equal(refused.postedCount, 0);
  assert.deepEqual(refused.missingAccounts, ['12']);
  assert.ok(refused.issues.some((issue) => issue.blocking && /Konto 12/.test(issue.message)), JSON.stringify(refused.issues));
  assert.equal((await imported(h)).length, 0, 'the valid entry of the file is not booked either');

  const closed = await setPeriod(h, '2026-01', 'closed', 'Januar festgeschrieben');
  assert.equal(closed.status, 200, closed.text);
  const january = datevStack([
    { amount: '10,00', side: 'S', konto: '4930', gegenkonto: '1200', date: '1501', beleg: 'J-1', text: 'Januar' },
    { amount: '10,00', side: 'S', konto: '4930', gegenkonto: '1200', date: '1502', beleg: 'F-1', text: 'Februar' },
  ], { from: '20260101', to: '20260228' });
  const locked = ok(await importFile(h, 'datev', january, false));
  assert.equal(locked.postedCount, 0);
  assert.ok(locked.issues.some((issue) => issue.blocking && /2026-01 ist festgeschrieben/.test(issue.message)), JSON.stringify(locked.issues));
  assert.equal((await imported(h)).length, 0);

  const noReason = await h.raw('POST', '/accounting/journal/import', { reason: ' ', format: 'journal_csv', contentBase64: Buffer.from(unknown).toString('base64'), dryRun: true });
  assert.equal(noReason.status, 400, noReason.text);
});
