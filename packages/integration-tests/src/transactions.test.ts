import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { PRODUCTS, startProduct, type LiteHarness } from './harness.js';
import { datevEvidence, draftInvoice, issueInvoice, today } from './fixtures.js';

/**
 * Bank accounts, CSV import, bank matching and manual cash end to end through
 * the Lite desktop backend (embedded Fastify on PGlite, the renderer's HTTP
 * client). Imports go through the file-path flow the Electron file picker uses,
 * the base64 upload flow of the browser shell has its own tests.
 *
 * How this can fail (each one has a test below):
 * - accounts: malformed accounts accepted, an update creating a second account,
 *   a delete silently erasing the bookings (and import history) of the account
 * - CSV parsing: German decimals/thousands/negatives, ISO/DE/US dates, `;` `,`
 *   tab delimiters, BOM, CRLF, quoted multi-line fields, blank lines, short and
 *   long rows, Windows-1252, foreign currency, status column, missing columns,
 *   empty files; an impossible calendar date silently moved to another day
 * - preview: writing anything, hashing rows across accounts, a bad row failing
 *   the whole file, the row cap
 * - upload: unsafe names, non-canonical base64, replay, handles of expired or
 *   committed imports, unbounded open handles
 * - commit: bad rows poisoning good rows, a half-written import after a database
 *   error, duplicates on re-import or overlapping files, identical bank lines of
 *   one file collapsed, a failed first attempt (wrong mapping) or a rolled-back
 *   batch blocking a corrected re-import, import into an unknown account
 * - rollback: removing another batch's rows, removing rows that already pay an
 *   invoice or are matched to a cash entry, running twice, no reason, no audit,
 *   rolled-back rows still visible in lists/reports/link
 * - linking: wrong payment identity, wrong status after partial/over/full
 *   payment, one bank line paying two invoices, two lines over-paying one
 *   invoice under concurrency, drafts/cancelled/credit notes/paid invoices/
 *   expenses/pending lines accepted, no audit, unlink removing the wrong payment
 * - suggestions: bad ranking, paid/draft/credit documents suggested, more than
 *   five, partial payments ignored
 * - cash entries: lost updates (expectedUpdatedAt), edits of matched entries,
 *   bad amounts/dates/currencies/references, a sign that contradicts the flow,
 *   deleted ids reused, double counting in the EÜR once matched to the bank
 * - receipts and files: lost updates, unreviewed tax data marked reviewed, file
 *   bytes changed, wrong mime/content, XML entities, size and count limits
 * - persistence: imports, batches, links, cash, receipts and file bytes lost on
 *   restart, dedup forgotten on restart
 * - auth: any of these routes reachable without the local token
 */
const YEAR = new Date().getFullYear();
const MAP = { dateColumn: 'Date', amountColumn: 'Amount', counterpartyColumn: 'Name', purposeColumn: 'Purpose' };
const HEADER = 'Date,Amount,Name,Purpose';
const unique = (label: string) => `${label} ${randomUUID().slice(0, 8)}`;

/** Bytes of a valid-looking PDF of exactly `size` bytes; `seed` makes the hash differ. */
const pdfBytes = (size: number, seed = 0) => {
  const bytes = Buffer.alloc(size, 0x20);
  bytes.write(`%PDF-1.4\n${String(seed).padStart(8, '0')}`);
  return bytes;
};
const b64 = (bytes: Buffer | string) => Buffer.from(bytes).toString('base64');

for (const product of PRODUCTS) describe(`transactions, banking and cash (${product})`, () => {
  let h: LiteHarness;
  let dir: string;
  let fileNo = 0;

  before(async () => {
    h = await startProduct(product, null, 'transactions');
    dir = await mkdtemp(join(tmpdir(), 'billme-it-csv-'));
  });
  after(async () => {
    await h.close();
    await rm(dir, { recursive: true, force: true });
  });

  const writeCsv = async (content: string | Buffer) => {
    const path = join(dir, `import-${fileNo++}.csv`);
    await writeFile(path, content);
    return path;
  };
  const newAccount = async (overrides: Record<string, unknown> = {}) => h.api.accounts.upsert({
    account: { id: randomUUID(), name: unique('Girokonto'), iban: 'DE02120300000000202051', balance: 0, transactions: [], type: 'bank', color: '#112233', defaultSkrAccountNumber: '1200', ...overrides },
  } as never);
  const commit = async (accountId: string, content: string | Buffer, extra: Record<string, unknown> = {}) =>
    h.api.finance.importCommit({ path: await writeCsv(content), accountId, mapping: MAP, profile: 'generic', ...extra } as never);
  /** One CSV, one account: lines are `date,amount,name,purpose` rows without the header. */
  const importRows = async (accountId: string, lines: string[]) => commit(accountId, `${HEADER}\n${lines.join('\n')}\n`);
  const preview = async (content: string | Buffer, extra: Record<string, unknown> = {}) =>
    h.api.finance.importPreview({ path: await writeCsv(content), ...extra } as never);
  const txsOf = (accountId: string) => h.api.transactions.list({ accountId });
  const invoiceOf = async (id: string) => (await h.api.invoices.list()).find((invoice) => invoice.id === id)!;
  const newInvoice = (label = 'Kunde') => issueInvoice(h.api, { client: unique(label) });
  const euerItems = async () => h.api.eur.listItems({ taxYear: YEAR, limit: 1000 });
  /** The Lite EÜR is built from payments and bank lines; Pro reports from its journal (pro-reporting). */
  const liteEur = product === 'lite';
  const auditCsv = () => h.api.audit.exportCsv();
  const txPaymentId = (transactionId: string) => `transaction-payment:${transactionId}`;
  /** Imports a single booked line and returns it. */
  const bankLine = async (amount: number, extra: { date?: string; name?: string; purpose?: string; status?: string; accountId?: string } = {}) => {
    const accountId = extra.accountId ?? (await newAccount()).id;
    const name = extra.name ?? unique('Zahler');
    const csv = `Date,Amount,Name,Purpose,Status\n${extra.date ?? today()},${amount},${name},${extra.purpose ?? 'Zahlung'},${extra.status ?? 'gebucht'}\n`;
    await commit(accountId, csv, { mapping: { ...MAP, statusColumn: 'Status' } });
    return (await txsOf(accountId)).find((tx) => tx.counterparty === name)!;
  };
  const entryInput = (overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(), cashDate: `${YEAR}-08-05`, amountCents: -5950, currency: 'EUR' as const, flowType: 'expense' as const,
    counterparty: 'Kiosk', purpose: 'Briefmarken', ...overrides,
  });
  const saveEntry = (overrides: Record<string, unknown> = {}) => h.api.cash.saveEntry({ entry: entryInput(overrides), reason: 'Barzahlung erfasst' } as never);
  const receiptInput = (overrides: Record<string, unknown> = {}) => ({
    id: randomUUID(), number: unique('B'), counterparty: 'Papierhandel', documentDate: `${YEAR}-08-01`, grossAmountCents: 11900,
    taxMode: 'domestic' as const, deductiblePercent: 100, reviewed: false, taxBreakdown: [], ...overrides,
  });
  const uploadRaw = (receiptId: string, body: Record<string, unknown>) =>
    h.raw('POST', `/cash/receipts/${receiptId}/files`, { fileName: 'beleg.pdf', mimeType: 'application/pdf', contentBase64: b64(pdfBytes(64)), reason: 'Beleg archiviert', ...body });

  describe('bank accounts', () => {
    test('an account is created, then updated in place instead of duplicated', async () => {
      const account = await newAccount({ name: 'Hauptkonto' });
      assert.deepEqual(account.transactions, []);
      const renamed = await h.api.accounts.upsert({ account: { ...account, name: 'Geschäftskonto', iban: 'DE89370400440532013000', balance: 250.5, color: '#abcdef' } });
      assert.equal(renamed.id, account.id);
      const matching = (await h.api.accounts.list()).filter((entry) => entry.id === account.id);
      assert.equal(matching.length, 1);
      assert.equal(matching[0]!.name, 'Geschäftskonto');
      assert.equal(matching[0]!.iban, 'DE89370400440532013000');
      assert.equal(matching[0]!.balance, 250.5);
      assert.equal(matching[0]!.color, '#abcdef');
    });

    test('malformed accounts are rejected with 400 and not stored', async () => {
      const base = { id: randomUUID(), name: 'Kaputt', iban: '', balance: 0, transactions: [], type: 'bank', color: '#000000' };
      const bad: Array<[string, Record<string, unknown>]> = [
        ['unknown type', { ...base, type: 'bogus' }],
        ['balance as text', { ...base, balance: 'viel' }],
        ['missing name', { ...base, name: undefined }],
        ['missing iban', { ...base, iban: undefined }],
        ['missing id', { ...base, id: undefined }],
      ];
      for (const [label, account] of bad) {
        const response = await h.raw('POST', '/accounts', { account });
        assert.equal(response.status, 400, `${label}: ${response.text}`);
      }
      assert.equal((await h.raw('POST', '/accounts', {})).status, 400);
      assert.ok(!(await h.api.accounts.list()).some((entry) => entry.id === base.id));
    });

    test('an account without bookings can be deleted; deleting an unknown id is a harmless no-op', async () => {
      const account = await newAccount();
      assert.deepEqual(await h.api.accounts.delete({ id: account.id }), { ok: true });
      assert.ok(!(await h.api.accounts.list()).some((entry) => entry.id === account.id));
      assert.deepEqual(await h.api.accounts.delete({ id: 'gibt-es-nicht' }), { ok: true });
    });

    test('an account holding bookings cannot be deleted, so no booking, import history or paid link is lost', async () => {
      const account = await newAccount();
      await importRows(account.id, [`${today()},238,Kunde Löschtest,RE`, `${today()},-20,Hoster,Hosting`]);
      const [paying] = (await txsOf(account.id)).filter((tx) => tx.amount === 238);
      const invoice = await newInvoice('Löschtest');
      await h.api.transactions.link({ transactionId: paying!.id, invoiceId: invoice.id });

      const response = await h.raw('DELETE', `/accounts/${account.id}`);
      assert.equal(response.status, 409, response.text);
      assert.equal((await txsOf(account.id)).length, 2, 'bookings are still there');
      assert.equal((await h.api.finance.listImportBatches({ accountId: account.id })).length, 1, 'import history is still there');
      assert.equal((await invoiceOf(invoice.id)).payments.length, 1);
      await h.api.transactions.unlink({ transactionId: paying!.id });
      assert.equal((await invoiceOf(invoice.id)).status, 'open');
    });
  });

  describe('CSV preview', () => {
    test('a German bank export is detected as FinTS and parsed (decimal commas, thousands dots, negatives, DD.MM.YYYY)', async () => {
      const csv = [
        'Buchungstag;Valuta;Auftraggeber/Empfänger;Verwendungszweck;Betrag;Währung',
        '01.08.2026;01.08.2026;Muster GmbH;RE-2026-001;"1.234,56";EUR',
        '02.08.2026;02.08.2026;Hoster AG;Hosting August;-20,00;EUR',
        '03.08.2026;03.08.2026;Finanzamt;Erstattung;(15,50);EUR',
        '04.08.2026;04.08.2026;Kasse;Einzahlung;€ 12,00;EUR',
        '05.08.2026;05.08.2026;Ganzzahl;nur Euro;1234;EUR',
        '06.08.2026;06.08.2026;Cent;unter einem Euro;0,5;EUR',
      ].join('\n');
      const result = await preview(csv);
      assert.equal(result.profile, 'fints');
      assert.equal(result.delimiter, ';');
      assert.deepEqual(result.suggestedMapping, {
        dateColumn: 'Buchungstag', amountColumn: 'Betrag', counterpartyColumn: 'Auftraggeber/Empfänger',
        purposeColumn: 'Verwendungszweck', currencyColumn: 'Währung', currencyExpected: 'EUR',
      });
      assert.deepEqual(result.stats, { totalRows: 6, previewRows: 6, validRows: 6, errorRows: 0 });
      assert.deepEqual(
        result.rows.map((row) => [row.parsed.date, row.parsed.amount, row.parsed.type]),
        [['2026-08-01', 1234.56, 'income'], ['2026-08-02', -20, 'expense'], ['2026-08-03', -15.5, 'expense'], ['2026-08-04', 12, 'income'], ['2026-08-05', 1234, 'income'], ['2026-08-06', 0.5, 'income']],
      );
      assert.equal(result.rows[0]!.parsed.counterparty, 'Muster GmbH');
      assert.equal(result.rows[0]!.rowIndex, 2, 'row numbers count the header line');
    });

    test('comma files with BOM, CRLF, quoted delimiters, quoted line breaks and blank lines parse cleanly', async () => {
      const csv = '﻿Datum,Betrag,Name,Zweck\r\n"2026-08-01","1.234,56","Müller, Hans","Zeile 1\nZeile 2"\r\n\r\n\r\n2026-08-02,-5,Foo,Bar\r\n   \r\n';
      const result = await preview(csv);
      assert.equal(result.delimiter, ',');
      assert.deepEqual(result.headers, ['Datum', 'Betrag', 'Name', 'Zweck'], 'the BOM is not part of the first header');
      assert.deepEqual(result.stats, { totalRows: 2, previewRows: 2, validRows: 2, errorRows: 0 });
      assert.equal(result.rows[0]!.parsed.counterparty, 'Müller, Hans');
      assert.equal(result.rows[0]!.parsed.purpose, 'Zeile 1\nZeile 2');
      assert.equal(result.rows[0]!.parsed.amount, 1234.56);
      assert.equal(result.rows[1]!.parsed.amount, -5);
    });

    test('tab separated files are detected and an explicit delimiter overrides detection', async () => {
      const tab = await preview('Date\tAmount\tName\tPurpose\n2026-08-01\t10,5\tA\tB\n');
      assert.equal(tab.delimiter, '\t');
      assert.equal(tab.rows[0]!.parsed.amount, 10.5);
      const forced = await preview('Date;Amount;Name;Purpose\n2026-08-01;10;A, Inc.;B\n', { delimiter: ';' });
      assert.equal(forced.delimiter, ';');
      assert.equal(forced.rows[0]!.parsed.counterparty, 'A, Inc.');
    });

    test('ISO, German and US date formats are understood; unsupported or impossible dates become row errors', async () => {
      const csv = [
        HEADER,
        '2026-08-01,1,A,iso',
        '2026-08-02T10:15:00Z,1,A,iso with time',
        '03.08.2026,1,A,german',
        '8/4/2026,1,A,us',
        '31.02.2026,1,A,impossible german',
        '13/1/2026,1,A,month 13',
        '1.8.26,1,A,short german',
        ',1,A,empty',
      ].join('\n');
      const result = await preview(csv);
      assert.deepEqual(result.rows.slice(0, 4).map((row) => row.parsed.date), ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04']);
      for (const row of result.rows.slice(4)) {
        assert.equal(row.parsed.date, undefined, `row ${row.rowIndex}`);
        assert.match(row.errors.join(' '), /Invalid date/);
      }
      assert.deepEqual(result.stats, { totalRows: 8, previewRows: 8, validRows: 4, errorRows: 4 });
    });

    test('an ISO date that does not exist is rejected like the German format and not moved to another day', async () => {
      const result = await preview(`${HEADER}\n2026-02-30,10,A,B\n2026-04-31,10,A,B\n`);
      for (const row of result.rows) {
        assert.ok(row.errors.length > 0, `${row.raw.Date} must not parse to ${row.parsed.date}`);
      }
    });

    test('Windows-1252 files decode umlauts when that encoding is chosen', async () => {
      const bytes = Buffer.from('Buchungstag;Betrag;Auftraggeber;Verwendungszweck\n01.08.2026;10,00;Müller & Söhne GmbH;Rechnung für Größe\n', 'latin1');
      const result = await preview(bytes, { encoding: 'win1252' });
      assert.equal(result.rows[0]!.parsed.counterparty, 'Müller & Söhne GmbH');
      assert.equal(result.rows[0]!.parsed.purpose, 'Rechnung für Größe');
    });

    test('a currency column keeps foreign currency rows out; EUR in any case and empty cells pass', async () => {
      const csv = 'Date,Amount,Currency,Name\n2026-08-01,10,USD,A\n2026-08-02,10,eur,A\n2026-08-03,10,,A\n2026-08-04,10,CHF,A\n';
      const result = await preview(csv, { mapping: { dateColumn: 'Date', amountColumn: 'Amount', currencyColumn: 'Currency', counterpartyColumn: 'Name', currencyExpected: 'EUR' } });
      assert.deepEqual(result.rows.map((row) => row.errors.length > 0), [true, false, false, true]);
      assert.match(result.rows[0]!.errors[0]!, /Unsupported currency: "USD"/);
      const accountId = (await newAccount()).id;
      const committed = await commit(accountId, csv, { mapping: { dateColumn: 'Date', amountColumn: 'Amount', currencyColumn: 'Currency', counterpartyColumn: 'Name' } });
      assert.equal(committed.imported, 2, 'the EUR row and the row without a currency');
      assert.deepEqual(committed.errors.map((error) => error.rowIndex), [2, 5]);
      assert.deepEqual((await txsOf(accountId)).map((tx) => tx.date).sort(), ['2026-08-02', '2026-08-03']);
    });

    test('a status column maps pending/offen to pending and everything else to booked', async () => {
      const csv = 'Date,Amount,Status\n2026-08-01,10,Pending\n2026-08-02,10,Gebucht\n2026-08-03,10,offen\n2026-08-04,10,\n';
      const result = await preview(csv, { mapping: { dateColumn: 'Date', amountColumn: 'Amount', statusColumn: 'Status' } });
      assert.deepEqual(result.rows.map((row) => row.parsed.status), ['pending', 'booked', 'pending', 'booked']);
    });

    test('PayPal and Stripe exports are detected; net amount and created date are used, other currencies flagged', async () => {
      const paypal = await preview('Date,Time,Name,Type,Status,Currency,Gross,Fee,Net,Transaction ID\n01.08.2026,10:00,Max,Payment,Completed,EUR,"1.234,56","-35,00","1.199,56",ABC123\n');
      assert.equal(paypal.profile, 'paypal');
      assert.equal(paypal.suggestedMapping.amountColumn, 'Net');
      assert.equal(paypal.suggestedMapping.externalIdColumn, 'Transaction ID');
      assert.equal(paypal.rows[0]!.parsed.amount, 1199.56);
      assert.equal(paypal.rows[0]!.parsed.externalId, 'ABC123');
      const stripe = await preview('id,Created (UTC),Amount,Currency,Description,Customer\nch_1,2026-08-01 10:00,12.34,eur,Order 1,cus_1\nch_2,2026-08-01 10:00,12.34,usd,Order 2,cus_1\n');
      assert.equal(stripe.profile, 'stripe');
      assert.equal(stripe.suggestedMapping.dateColumn, 'Created (UTC)');
      assert.deepEqual(stripe.rows.map((row) => row.errors.length), [0, 1]);
      assert.equal(stripe.rows[0]!.parsed.date, '2026-08-01');
    });

    test('mapping a column that is not in the file yields row errors, not a crash', async () => {
      const result = await preview('Date,Amount\n2026-08-01,10\n', { mapping: { dateColumn: 'Nope', amountColumn: 'Amount' } });
      assert.deepEqual(result.stats, { totalRows: 1, previewRows: 1, validRows: 0, errorRows: 1 });
      assert.match(result.rows[0]!.errors.join(), /Invalid date/);
      const unmapped = await h.raw('POST', '/finance/import/preview', { path: await writeCsv(`${HEADER}\n2026-08-01,1,A,B\n`), mapping: { dateColumn: '', amountColumn: 'Amount' } });
      assert.equal(unmapped.status, 400, 'an empty column name is refused at the boundary');
    });

    test('header-only, empty and blank-line files preview as zero rows', async () => {
      for (const content of [`${HEADER}\n`, '', '\n\n  \n']) {
        const result = await preview(content);
        assert.deepEqual(result.stats, { totalRows: 0, previewRows: 0, validRows: 0, errorRows: 0 }, JSON.stringify(content));
        assert.deepEqual(result.rows, []);
      }
    });

    test('maxRows caps the preview but not the row count; out-of-range values are refused', async () => {
      const lines = Array.from({ length: 10 }, (_, index) => `2026-08-${String(index + 1).padStart(2, '0')},${index + 1},A,B`);
      const result = await preview(`${HEADER}\n${lines.join('\n')}\n`, { maxRows: 3 });
      assert.deepEqual(result.stats, { totalRows: 10, previewRows: 3, validRows: 3, errorRows: 0 });
      for (const maxRows of [0, 201, 1.5]) {
        const response = await h.raw('POST', '/finance/import/preview', { path: await writeCsv(`${HEADER}\n2026-08-01,1,A,B\n`), maxRows });
        assert.equal(response.status, 400, `maxRows ${maxRows}`);
      }
    });

    test('a row with more fields than the header still previews', async () => {
      const path = await writeCsv(`${HEADER}\n2026-08-01,10,A,B\n2026-08-02,20,A,B,EXTRA,MORE\n`);
      const response = await h.raw('POST', '/finance/import/preview', { path, mapping: MAP });
      assert.equal(response.status, 200, response.text);
      assert.equal(response.body.stats.totalRows, 2);
    });

    test('a row with fewer fields than the header previews with empty cells', async () => {
      const result = await preview(`${HEADER}\n2026-08-01,10\n`);
      assert.equal(result.rows[0]!.parsed.amount, 10);
      assert.equal(result.rows[0]!.parsed.counterparty, undefined);
    });

    test('previewing writes nothing: no bookings, no import batch, no audit entry', async () => {
      const before = { transactions: (await h.api.transactions.list({})).length, batches: (await h.api.finance.listImportBatches({})).length, audit: (await auditCsv()).split('\n').length };
      await preview(`${HEADER}\n2026-08-01,10,A,B\n`, { accountIdForDedupHash: 'whatever' });
      assert.deepEqual({ transactions: (await h.api.transactions.list({})).length, batches: (await h.api.finance.listImportBatches({})).length, audit: (await auditCsv()).split('\n').length }, before);
    });

    test('row hashes exist only with an account, are stable and differ per account', async () => {
      const csv = `${HEADER}\n2026-08-01,10,A,B\n`;
      const without = await preview(csv);
      assert.equal(without.rows[0]!.dedupHash, undefined);
      const first = await preview(csv, { accountIdForDedupHash: 'konto-1' });
      const again = await preview(csv, { accountIdForDedupHash: 'konto-1' });
      const other = await preview(csv, { accountIdForDedupHash: 'konto-2' });
      assert.match(first.rows[0]!.dedupHash!, /^[a-f0-9]{64}$/);
      assert.equal(first.rows[0]!.dedupHash, again.rows[0]!.dedupHash);
      assert.notEqual(first.rows[0]!.dedupHash, other.rows[0]!.dedupHash);
      assert.equal(first.fileSha256, other.fileSha256);
    });

    test('a file path that does not exist is an error, and the server keeps serving', async () => {
      const response = await h.raw('POST', '/finance/import/preview', { path: join(dir, 'nicht-da.csv') });
      assert.ok(response.status >= 400, response.text);
      assert.match(response.body.message, /CSV/);
      assert.equal((await h.raw('GET', '/accounts')).status, 200);
    });
  });

  describe('CSV upload (browser flow)', () => {
    const upload = (name: string, content: string | Buffer, extra: Record<string, unknown> = {}) =>
      h.api.finance.importPreview({ fileName: name, contentBase64: b64(content), profile: 'generic', mapping: MAP, ...extra } as never);

    test('an upload previews under a handle, commits through it and replays by file hash', async () => {
      const accountId = (await newAccount()).id;
      const marker = unique('Upload');
      const preview1 = await upload('bank.csv', `${HEADER}\n2026-08-05,10,${marker},Load\n`);
      assert.match(preview1.path, /^import-upload:/);
      assert.equal(preview1.fileName, 'bank.csv');
      assert.equal(preview1.stats.validRows, 1);
      const first = await h.api.finance.importCommit({ path: preview1.path, accountId, mapping: MAP, profile: 'generic' });
      assert.equal(first.imported, 1);
      const replay = await h.api.finance.importCommit({ path: preview1.path, accountId, mapping: MAP, profile: 'generic' });
      assert.equal(replay.batchId, first.batchId);
      assert.equal((await txsOf(accountId)).length, 1);
      const reuse = await h.api.finance.importPreview({ path: preview1.path, profile: 'generic', mapping: MAP });
      assert.equal(reuse.stats.validRows, 1, 'a committed handle can still be previewed');
      assert.equal((await h.api.finance.listImportBatches({ accountId }))[0]!.fileName, 'bank.csv');
    });

    test('unsafe or malformed uploads are refused before anything is stored', async () => {
      const content = b64(`${HEADER}\n2026-08-01,1,A,B\n`);
      const attempts: Array<[string, Record<string, unknown>, number]> = [
        ['not a csv extension', { fileName: 'bank.txt', contentBase64: content }, 400],
        ['path traversal in the name', { fileName: '../bank.csv', contentBase64: content }, 400],
        ['directory in the name', { fileName: 'a/b.csv', contentBase64: content }, 400],
        ['control character in the name', { fileName: 'a\u0001.csv', contentBase64: content }, 400],
        ['missing file name', { contentBase64: content }, 400],
        ['non-canonical base64', { fileName: 'bank.csv', contentBase64: 'not base64!!' }, 400],
        ['empty content', { fileName: 'bank.csv', contentBase64: '' }, 400],
        ['unknown handle', { path: 'import-upload:gibt-es-nicht' }, 404],
        ['no source at all', {}, 400],
      ];
      for (const [label, body, status] of attempts) {
        const response = await h.raw('POST', '/finance/import/preview', body);
        assert.equal(response.status, status, `${label}: ${response.text}`);
      }
      const commitUnknown = await h.raw('POST', '/finance/import/commit', { path: 'import-upload:bogus', accountId: (await newAccount()).id, mapping: MAP });
      assert.equal(commitUnknown.status, 404);
    });

    test('at most five uploads can wait for a commit; committing one frees a slot', async () => {
      const accountId = (await newAccount()).id;
      const handles: string[] = [];
      let refused: { status: number; text: string } | undefined;
      for (let index = 0; index < 8 && !refused; index += 1) {
        const response = await h.raw('POST', '/finance/import/preview', { fileName: `cap-${index}.csv`, contentBase64: b64(`${HEADER}\n2026-08-0${index + 1},${index + 1},Cap,${randomUUID()}\n`), profile: 'generic', mapping: MAP });
        if (response.status === 200) handles.push(response.body.path); else refused = response;
      }
      assert.ok(refused, 'the sixth pending upload must be refused');
      assert.equal(refused.status, 429);
      assert.match(refused.text, /Zu viele offene Importe/);
      assert.ok(handles.length <= 5);
      const committed = await h.api.finance.importCommit({ path: handles[0]!, accountId, mapping: MAP, profile: 'generic' });
      assert.equal(committed.imported, 1);
      const retry = await h.raw('POST', '/finance/import/preview', { fileName: 'again.csv', contentBase64: b64(`${HEADER}\n2026-08-01,1,Again,B\n`), profile: 'generic', mapping: MAP });
      assert.equal(retry.status, 200, retry.text);
      for (const handle of [...handles.slice(1), retry.body.path]) await h.api.finance.importCommit({ path: handle, accountId, mapping: MAP, profile: 'generic' }); // leave no open handles behind
    });
  });

  describe('import commit', () => {
    test('valid rows are booked, bad rows are reported by row number, and the batch records both', async () => {
      const accountId = (await newAccount()).id;
      const result = await importRows(accountId, [
        '2026-08-01,119.00,Kunde A,RE-1',
        '2026-08-02,-20.00,Hoster,Hosting',
        '2026-08-03,nope,Kaputt,Betrag falsch',
        '31.02.2026,5,Kaputt,Datum falsch',
      ]);
      assert.equal(result.imported, 2);
      assert.equal(result.skipped, 0);
      assert.deepEqual(result.errors.map((error) => error.rowIndex), [4, 5]);
      assert.match(result.errors[0]!.message, /Invalid amount: "nope"/);
      assert.match(result.errors[1]!.message, /Invalid date/);
      const stored = await txsOf(accountId);
      assert.deepEqual(stored.map((tx) => [tx.date, tx.amount, tx.type, tx.status, tx.accountId, tx.importBatchId]), [
        ['2026-08-02', -20, 'expense', 'booked', accountId, result.batchId],
        ['2026-08-01', 119, 'income', 'booked', accountId, result.batchId],
      ]);
      const [batch] = await h.api.finance.listImportBatches({ accountId });
      assert.deepEqual([batch!.importedCount, batch!.skippedCount, batch!.errorCount, batch!.profile], [2, 0, 2, 'generic']);
      assert.equal(batch!.fileSha256, result.fileSha256);
      assert.deepEqual((batch!.mappingJson as { mapping: unknown }).mapping, { ...MAP, currencyExpected: 'EUR' });
    });

    test('the import is audited with the file name', async () => {
      const accountId = (await newAccount()).id;
      const result = await importRows(accountId, ['2026-08-01,1,A,B']);
      const line = (await auditCsv()).split('\n').find((row) => row.includes(result.batchId) && row.includes('finance_import.commit'));
      assert.ok(line, 'finance_import.commit entry');
      assert.match(line, /CSV-Import import-\d+\.csv/);
      assert.equal((await h.api.audit.verify()).ok, true);
    });

    test('a database error half way leaves no batch, no booking and no audit entry; the corrected file imports', async () => {
      const accountId = (await newAccount()).id;
      const auditBefore = (await auditCsv()).split('\n').length;
      const response = await h.raw('POST', '/finance/import/commit', {
        path: await writeCsv(`${HEADER}\n2026-08-01,10,Gut,ok\n2026-08-02,20,Schlecht\u0000Name,nul\n`), accountId, mapping: MAP, profile: 'generic',
      });
      assert.equal(response.status, 500, response.text);
      assert.deepEqual(await txsOf(accountId), []);
      assert.deepEqual(await h.api.finance.listImportBatches({ accountId }), []);
      assert.equal((await auditCsv()).split('\n').length, auditBefore);
      const fixed = await importRows(accountId, ['2026-08-01,10,Gut,ok', '2026-08-02,20,Schlecht,fixed']);
      assert.equal(fixed.imported, 2);
    });

    test('importing the same file again changes nothing and returns the same batch', async () => {
      const accountId = (await newAccount()).id;
      const path = await writeCsv(`${HEADER}\n2026-08-01,10,A,B\n2026-08-02,20,A,B\n`);
      const first = await h.api.finance.importCommit({ path, accountId, mapping: MAP, profile: 'generic' });
      const again = await h.api.finance.importCommit({ path, accountId, mapping: MAP, profile: 'generic' });
      const copy = await h.api.finance.importCommit({ path: await writeCsv(`${HEADER}\n2026-08-01,10,A,B\n2026-08-02,20,A,B\n`), accountId, mapping: MAP, profile: 'generic' });
      assert.equal(again.batchId, first.batchId);
      assert.equal(copy.batchId, first.batchId, 'a byte-identical copy under another file name is the same file');
      assert.equal((await txsOf(accountId)).length, 2);
      assert.equal((await h.api.finance.listImportBatches({ accountId })).length, 1);
    });

    test('an overlapping file imports only the new rows and rolls back without touching the older batch', async () => {
      const accountId = (await newAccount()).id;
      const first = await importRows(accountId, ['2026-08-01,10,A,B', '2026-08-02,20,A,B']);
      const second = await importRows(accountId, ['2026-08-02,20,A,B', '2026-08-03,30,A,B', '2026-08-04,40,A,B']);
      assert.notEqual(second.batchId, first.batchId);
      assert.equal(second.imported, 2);
      assert.equal(second.skipped, 1);
      assert.equal((await txsOf(accountId)).length, 4);
      const secondRows = (await txsOf(accountId)).filter((tx) => tx.importBatchId === second.batchId);
      assert.deepEqual(secondRows.map((tx) => tx.amount).sort((a, b) => a - b), [30, 40]);
      await h.api.finance.rollbackImportBatch({ batchId: second.batchId, reason: 'falscher Zeitraum' });
      assert.deepEqual((await txsOf(accountId)).map((tx) => tx.importBatchId), [first.batchId, first.batchId]);
    });

    test('the same file can be imported into a second account', async () => {
      const [a, b] = [(await newAccount()).id, (await newAccount()).id];
      const path = await writeCsv(`${HEADER}\n2026-08-01,10,A,B\n`);
      const one = await h.api.finance.importCommit({ path, accountId: a, mapping: MAP, profile: 'generic' });
      const two = await h.api.finance.importCommit({ path, accountId: b, mapping: MAP, profile: 'generic' });
      assert.notEqual(one.batchId, two.batchId);
      assert.equal(two.imported, 1);
      assert.equal((await txsOf(a)).length + (await txsOf(b)).length, 2);
    });

    test('identical lines inside one file are collapsed and the skipped one is reported; an external id tells twins apart', async () => {
      // By design (transactionImport.ts seenHashes): two real payments with the same day, amount, counterparty and purpose and no
      // external id look like one line. The skip is not silent, the user sees skipped = 1.
      const accountId = (await newAccount()).id;
      const result = await importRows(accountId, ['2026-08-01,5,Kiosk,Kaffee', '2026-08-01,5,Kiosk,Kaffee']);
      assert.deepEqual([result.imported, result.skipped, result.errors.length], [1, 1, 0]);
      assert.equal((await txsOf(accountId)).length, 1);
      const [batch] = await h.api.finance.listImportBatches({ accountId });
      assert.deepEqual([batch!.importedCount, batch!.skippedCount], [1, 1]);
    });

    test('lines that differ only by an external id are both booked', async () => {
      const accountId = (await newAccount()).id;
      const csv = 'Date,Amount,Name,Purpose,Id\n2026-08-01,5,Kiosk,Kaffee,tx-1\n2026-08-01,5,Kiosk,Kaffee,tx-2\n';
      const result = await commit(accountId, csv, { mapping: { ...MAP, externalIdColumn: 'Id' } });
      assert.equal(result.imported, 2);
    });

    test('an unknown account is refused with 404 and creates no batch', async () => {
      const batches = (await h.api.finance.listImportBatches({})).length;
      const response = await h.raw('POST', '/finance/import/commit', { path: await writeCsv(`${HEADER}\n2026-08-01,1,A,B\n`), accountId: 'gibt-es-nicht', mapping: MAP });
      assert.equal(response.status, 404, response.text);
      assert.equal((await h.api.finance.listImportBatches({})).length, batches);
    });

    test('a commit without a mapping or account is refused at the boundary', async () => {
      const path = await writeCsv(`${HEADER}\n2026-08-01,1,A,B\n`);
      const accountId = (await newAccount()).id;
      assert.equal((await h.raw('POST', '/finance/import/commit', { path, accountId })).status, 400);
      assert.equal((await h.raw('POST', '/finance/import/commit', { path, mapping: MAP })).status, 400);
      assert.equal((await h.raw('POST', '/finance/import/commit', { accountId, mapping: MAP })).status, 400);
      assert.equal((await h.raw('POST', '/finance/import/commit', { path, accountId, mapping: { dateColumn: 'Date' } })).status, 400);
    });

    test('a file whose first attempt matched nothing can be imported with a corrected mapping', async () => {
      const accountId = (await newAccount()).id;
      const path = await writeCsv('Datum,Betrag,Gegenpart,Zweck\n2026-08-01,10,A,B\n2026-08-02,20,A,B\n');
      const wrong = await h.api.finance.importCommit({ path, accountId, mapping: MAP, profile: 'generic' });
      assert.equal(wrong.imported, 0);
      assert.equal(wrong.errors.length, 2);
      const right = await h.api.finance.importCommit({ path, accountId, mapping: { dateColumn: 'Datum', amountColumn: 'Betrag', counterpartyColumn: 'Gegenpart', purposeColumn: 'Zweck' }, profile: 'generic' });
      assert.equal(right.imported, 2);
      assert.equal((await txsOf(accountId)).length, 2);
    });

    test('a file whose batch was rolled back can be imported again', async () => {
      const accountId = (await newAccount()).id;
      const path = await writeCsv(`${HEADER}\n2026-08-01,10,A,B\n2026-08-02,20,A,B\n`);
      const first = await h.api.finance.importCommit({ path, accountId, mapping: MAP, profile: 'generic' });
      await h.api.finance.rollbackImportBatch({ batchId: first.batchId, reason: 'falsches Konto geprüft' });
      assert.deepEqual(await txsOf(accountId), []);
      const again = await h.api.finance.importCommit({ path, accountId, mapping: MAP, profile: 'generic' });
      assert.notEqual(again.batchId, first.batchId);
      assert.equal(again.imported, 2);
      assert.equal((await txsOf(accountId)).length, 2);
    });
  });

  describe('import batches and rollback', () => {
    test('batches list newest first, filter by account and honour the limit', async () => {
      const [a, b] = [(await newAccount()).id, (await newAccount()).id];
      const one = await importRows(a, ['2026-08-01,1,A,one']);
      const two = await importRows(a, ['2026-08-01,2,A,two']);
      const other = await importRows(b, ['2026-08-01,3,A,other']);
      assert.deepEqual((await h.api.finance.listImportBatches({ accountId: a })).map((batch) => batch.id), [two.batchId, one.batchId]);
      assert.deepEqual((await h.api.finance.listImportBatches({ accountId: b })).map((batch) => batch.id), [other.batchId]);
      assert.equal((await h.api.finance.listImportBatches({ accountId: a, limit: 1 })).length, 1);
      assert.deepEqual(await h.api.finance.listImportBatches({ accountId: 'gibt-es-nicht' }), []);
      const all = await h.api.finance.listImportBatches({});
      assert.ok([one, two, other].every((result) => all.some((batch) => batch.id === result.batchId)));
      assert.equal((await h.raw('GET', '/finance/import-batches?limit=0')).status, 400);
      assert.equal((await h.raw('GET', '/finance/import-batches?limit=abc')).status, 400);
    });

    test('batch details list exactly the batch bookings and say whether a rollback is possible', async () => {
      const accountId = (await newAccount()).id;
      const first = await importRows(accountId, ['2026-08-01,1,A,one', '2026-08-02,2,A,two']);
      await importRows(accountId, ['2026-08-03,3,A,three']);
      const details = await h.api.finance.getImportBatchDetails({ batchId: first.batchId });
      assert.equal(details.batch.id, first.batchId);
      assert.equal(details.transactions.length, 2);
      assert.deepEqual(details.transactions.map((tx) => tx.amount).sort(), [1, 2]);
      assert.equal(details.canRollback, true);
      assert.equal(details.linkedInvoiceCount, 0);
      const missing = await h.raw('GET', '/finance/import-batches/gibt-es-nicht');
      assert.equal(missing.status, 404);
    });

    test('a rollback removes only its own bookings everywhere, records reason and time, and is audited', async () => {
      const accountId = (await newAccount()).id;
      const keep = await importRows(accountId, [`${YEAR}-08-01,111,Behalten,keep`]);
      const drop = await importRows(accountId, [`${YEAR}-08-02,222,Verwerfen,drop`, `${YEAR}-08-03,-33,Verwerfen,drop`]);
      const dropped = (await txsOf(accountId)).filter((tx) => tx.importBatchId === drop.batchId);
      assert.equal(dropped.length, 2);
      if (liteEur) assert.ok((await euerItems()).some((item) => item.sourceId === dropped[0]!.id), 'visible in the EÜR before');

      const result = await h.api.finance.rollbackImportBatch({ batchId: drop.batchId, reason: 'Falsche Datei gewählt' });
      assert.deepEqual(result, { success: true, deletedCount: 2 });
      assert.deepEqual((await txsOf(accountId)).map((tx) => tx.importBatchId), [keep.batchId]);
      if (liteEur) assert.ok(!(await euerItems()).some((item) => dropped.some((tx) => tx.id === item.sourceId)), 'gone from the EÜR');
      const details = await h.api.finance.getImportBatchDetails({ batchId: drop.batchId });
      assert.equal(details.transactions.length, 0);
      assert.equal(details.canRollback, false);
      assert.equal(details.batch.rollbackReason, 'Falsche Datei gewählt');
      assert.ok(details.batch.rolledBackAt);
      assert.equal((await h.api.finance.getImportBatchDetails({ batchId: keep.batchId })).canRollback, true);
      const line = (await auditCsv()).split('\n').find((row) => row.includes(drop.batchId) && row.includes('finance_import.rollback'));
      assert.ok(line && line.includes('Falsche Datei gewählt'));
    });

    test('rolling back twice is refused and changes nothing the second time', async () => {
      const accountId = (await newAccount()).id;
      const batch = await importRows(accountId, ['2026-08-04,42,Kunde,RE']);
      await h.api.finance.rollbackImportBatch({ batchId: batch.batchId, reason: 'erster Versuch' });
      const second = await h.raw('POST', `/finance/import-batches/${batch.batchId}/rollback`, { reason: 'zweiter Versuch' });
      assert.equal(second.status, 409, second.text);
      assert.match(second.text, /IMPORT_BATCH_ALREADY_ROLLED_BACK/);
      const details = await h.api.finance.getImportBatchDetails({ batchId: batch.batchId });
      assert.equal(details.batch.rollbackReason, 'erster Versuch');
      const rollbacks = (await auditCsv()).split('\n').filter((row) => row.includes(batch.batchId) && row.includes('finance_import.rollback'));
      assert.equal(rollbacks.length, 1);
    });

    test('a rollback needs a reason and an existing batch', async () => {
      const accountId = (await newAccount()).id;
      const batch = await importRows(accountId, ['2026-08-04,42,Kunde,RE']);
      for (const body of [{}, { reason: '' }, { reason: '   ' }]) {
        const response = await h.raw('POST', `/finance/import-batches/${batch.batchId}/rollback`, body);
        assert.equal(response.status, 400, JSON.stringify(body));
      }
      assert.equal((await txsOf(accountId)).length, 1, 'nothing was removed');
      assert.equal((await h.raw('POST', '/finance/import-batches/gibt-es-nicht/rollback', { reason: 'x' })).status, 404);
    });

    test('a batch with a booking that pays an invoice cannot be rolled back until the link is removed', async () => {
      const accountId = (await newAccount()).id;
      const batch = await importRows(accountId, [`${today()},238,Kunde,RE`, `${today()},-5,Andere,Gebühr`]);
      const invoice = await newInvoice();
      const paying = (await txsOf(accountId)).find((tx) => tx.amount === 238)!;
      await h.api.transactions.link({ transactionId: paying.id, invoiceId: invoice.id });

      const details = await h.api.finance.getImportBatchDetails({ batchId: batch.batchId });
      assert.equal(details.canRollback, false);
      assert.equal(details.linkedInvoiceCount, 1);
      const refused = await h.raw('POST', `/finance/import-batches/${batch.batchId}/rollback`, { reason: 'zu früh' });
      assert.equal(refused.status, 409, refused.text);
      assert.match(refused.text, /IMPORT_BATCH_LINKED/);
      assert.equal((await txsOf(accountId)).length, 2, 'all-or-nothing: the unlinked line stays too');
      assert.equal((await invoiceOf(invoice.id)).status, 'paid');

      await h.api.transactions.unlink({ transactionId: paying.id });
      assert.deepEqual(await h.api.finance.rollbackImportBatch({ batchId: batch.batchId, reason: 'jetzt frei' }), { success: true, deletedCount: 2 });
    });

    if (product === 'lite') test('a batch with a booking matched to a cash entry cannot be rolled back until it is unmatched', async () => {
      const accountId = (await newAccount()).id;
      const tx = await bankLine(-59.5, { accountId, date: `${YEAR}-08-05` });
      const entry = await saveEntry({ amountCents: -5950 });
      await h.api.cash.matchEntry({ id: entry.id, transactionId: tx.id, expectedCashDate: entry.originalCashDate, reason: 'Kontoauszug' });
      const details = await h.api.finance.getImportBatchDetails({ batchId: tx.importBatchId! });
      assert.equal(details.canRollback, false);
      const refused = await h.raw('POST', `/finance/import-batches/${tx.importBatchId}/rollback`, { reason: 'zu früh' });
      assert.equal(refused.status, 409, refused.text);
      assert.equal((await txsOf(accountId)).length, 1);
      await h.api.cash.unmatchEntry({ id: entry.id, reason: 'Zuordnung gelöst' });
      assert.equal((await h.api.finance.rollbackImportBatch({ batchId: tx.importBatchId!, reason: 'jetzt frei' })).deletedCount, 1);
    });

    test('a booking of a rolled-back batch can neither be linked nor unlinked', async () => {
      const accountId = (await newAccount()).id;
      const batch = await importRows(accountId, [`${today()},238,Kunde,RE`]);
      const tx = (await txsOf(accountId))[0]!;
      const invoice = await newInvoice();
      await h.api.finance.rollbackImportBatch({ batchId: batch.batchId, reason: 'falsche Datei' });
      const link = await h.raw('POST', `/transactions/${tx.id}/link`, { invoiceId: invoice.id, reason: 'x' });
      assert.equal(link.status, 404, link.text);
      assert.match(link.text, /TRANSACTION_NOT_FOUND/);
      const unlink = await h.raw('POST', `/transactions/${tx.id}/unlink`, { reason: 'x' });
      assert.equal(unlink.status, 404);
      assert.equal((await invoiceOf(invoice.id)).payments.length, 0);
    });
  });

  describe('transaction list', () => {
    test('filters by account, type, and link state; contradictory link filters yield nothing', async () => {
      const accountId = (await newAccount()).id;
      await importRows(accountId, [`${today()},238,Kunde,RE`, `${today()},-20,Hoster,Hosting`, `${today()},10,Klein,Rest`]);
      const invoice = await newInvoice();
      const paying = (await txsOf(accountId)).find((tx) => tx.amount === 238)!;
      await h.api.transactions.link({ transactionId: paying.id, invoiceId: invoice.id });

      assert.equal((await h.api.transactions.list({ accountId })).length, 3);
      assert.deepEqual((await h.api.transactions.list({ accountId, type: 'expense' })).map((tx) => tx.amount), [-20]);
      assert.deepEqual((await h.api.transactions.list({ accountId, type: 'income' })).map((tx) => tx.amount), [238, 10]);
      assert.deepEqual((await h.api.transactions.list({ accountId, linkedOnly: true })).map((tx) => tx.linkedInvoiceId), [invoice.id]);
      assert.deepEqual((await h.api.transactions.list({ accountId, unlinkedOnly: true })).map((tx) => tx.amount), [10, -20]);
      assert.deepEqual(await h.api.transactions.list({ accountId, linkedOnly: true, unlinkedOnly: true }), []);
      assert.deepEqual(await h.api.transactions.list({ accountId: 'gibt-es-nicht' }), []);
    });

    test('bookings are sorted by date, then amount, newest and largest first; import metadata is carried', async () => {
      const accountId = (await newAccount()).id;
      const result = await importRows(accountId, ['2026-03-01,5,A,eins', '2026-03-02,1,A,zwei', '2026-03-02,9,A,drei', '2026-01-15,100,A,vier']);
      const list = await txsOf(accountId);
      assert.deepEqual(list.map((tx) => [tx.date, tx.amount]), [['2026-03-02', 9], ['2026-03-02', 1], ['2026-03-01', 5], ['2026-01-15', 100]]);
      assert.ok(list.every((tx) => tx.importBatchId === result.batchId && /^[a-f0-9]{64}$/.test(tx.dedupHash ?? '')));
    });

    test('invalid filters are refused with 400', async () => {
      assert.equal((await h.raw('GET', '/transactions?type=foo')).status, 400);
      assert.equal((await h.raw('GET', '/transactions?linkedOnly=maybe')).status, 400);
    });
  });

  describe('linking a bank transaction to an invoice', () => {
    test('a full payment settles the invoice with a payment derived from the transaction', async () => {
      const invoice = await newInvoice();
      const tx = await bankLine(invoice.amount, { date: today() });
      const result = await h.api.transactions.link({ transactionId: tx.id, invoiceId: invoice.id });
      assert.equal(result.success, true);
      assert.equal(result.invoice!.status, 'paid');
      const stored = await invoiceOf(invoice.id);
      assert.equal(stored.status, 'paid');
      assert.deepEqual(stored.payments.map((payment) => [payment.id, payment.date, payment.amount, payment.method]), [[txPaymentId(tx.id), tx.date, invoice.amount, 'Überweisung']]);
      const listed = (await txsOf(tx.accountId!)).find((entry) => entry.id === tx.id)!;
      assert.equal(listed.linkedInvoiceId, invoice.id);
      assert.equal(listed.appliedAmountCents, Math.round(invoice.amount * 100));
      assert.equal(listed.unallocatedAmountCents, 0);
      assert.ok(!(await h.api.transactions.list({ unlinkedOnly: true })).some((entry) => entry.id === tx.id));
    });

    if (liteEur) test('the paid invoice is counted once in the EÜR, as a payment, not once more as the bank line', async () => {
      const invoice = await newInvoice();
      const tx = await bankLine(invoice.amount, { date: `${YEAR}-09-01` });
      assert.equal((await euerItems()).filter((item) => item.sourceId === tx.id).length, 1, 'before: the bank line');
      await h.api.transactions.link({ transactionId: tx.id, invoiceId: invoice.id });
      const items = await euerItems();
      assert.equal(items.filter((item) => item.sourceId === tx.id).length, 0, 'after: not as a bank line');
      const paid = items.filter((item) => item.sourceId === `${invoice.id}:payment:${txPaymentId(tx.id)}`);
      assert.equal(paid.length, 1);
      assert.equal(paid[0]!.amountGross, invoice.amount);
      await h.api.transactions.unlink({ transactionId: tx.id });
      const restored = await euerItems();
      assert.equal(restored.filter((item) => item.sourceId === tx.id).length, 1, 'unlinked: the bank line is back');
      assert.ok(!restored.some((item) => item.sourceId.startsWith(`${invoice.id}:payment`)));
    });

    test('a partial amount leaves the invoice open; the remaining payment closes it', async () => {
      const invoice = await newInvoice();
      const [first, second] = [await bankLine(100), await bankLine(138)];
      const partly = await h.api.transactions.link({ transactionId: first.id, invoiceId: invoice.id });
      assert.equal(partly.invoice!.status, 'open');
      assert.equal(partly.invoice!.payments.length, 1);
      const done = await h.api.transactions.link({ transactionId: second.id, invoiceId: invoice.id });
      assert.equal(done.invoice!.status, 'paid');
      assert.deepEqual(done.invoice!.payments.map((payment) => payment.amount).sort((a, b) => a - b), [100, 138]);
    });

    test('an explicit applied amount splits one bank line: the rest stays unallocated', async () => {
      const invoice = await newInvoice();
      const tx = await bankLine(500);
      const result = await h.raw('POST', `/transactions/${tx.id}/link`, { invoiceId: invoice.id, appliedAmountCents: 10_000, reason: 'Teilzahlung geprüft' });
      assert.equal(result.status, 200, result.text);
      assert.equal(result.body.invoice.status, 'open');
      assert.equal(result.body.invoice.payments[0].amount, 100);
      const listed = (await txsOf(tx.accountId!)).find((entry) => entry.id === tx.id)!;
      assert.equal(listed.appliedAmountCents, 10_000);
      assert.equal(listed.unallocatedAmountCents, 40_000);
      if (!liteEur) return;
      const items = await euerItems();
      const paid = items.filter((item) => item.sourceId.startsWith(`${invoice.id}:payment:`));
      const remainder = items.filter((item) => item.sourceId === tx.id);
      assert.deepEqual([paid.length, paid[0]!.amountGross, remainder.length, remainder[0]!.amountGross], [1, 100, 1, 400], 'the EÜR sees the 500 EUR once: 100 as invoice payment, 400 as bank line');
    });

    test('a bank line larger than the invoice settles only what is owed and reports the rest', async () => {
      const invoice = await newInvoice();
      const tx = await bankLine(300);
      const result = await h.api.transactions.link({ transactionId: tx.id, invoiceId: invoice.id });
      assert.equal(result.invoice!.status, 'paid');
      assert.equal(result.invoice!.payments[0]!.amount, invoice.amount);
      const listed = (await txsOf(tx.accountId!)).find((entry) => entry.id === tx.id)!;
      assert.equal(listed.unallocatedAmountCents, 30_000 - Math.round(invoice.amount * 100));
    });

    test('payments already recorded by hand reduce what the bank line settles', async () => {
      const invoice = await newInvoice();
      await h.api.invoices.savePayment({ invoiceId: invoice.id, payment: { id: randomUUID(), date: today(), amount: 38, method: 'cash' }, reason: 'bar kassiert' });
      const tx = await bankLine(238);
      const result = await h.api.transactions.link({ transactionId: tx.id, invoiceId: invoice.id });
      assert.equal(result.invoice!.status, 'paid');
      assert.deepEqual(result.invoice!.payments.map((payment) => payment.amount).sort((a, b) => a - b), [38, 200]);
      const listed = (await txsOf(tx.accountId!)).find((entry) => entry.id === tx.id)!;
      assert.equal(listed.unallocatedAmountCents, 3800);
    });

    test('the applied amount must be positive, whole cents, within the bank amount and within what is owed', async () => {
      const invoice = await newInvoice();
      const tx = await bankLine(150);
      const attempts: Array<[string, number]> = [['zero', 0], ['negative', -100], ['fractional cents', 12.5], ['more than the bank line', 15_001], ['more than owed', 99_999_999]];
      for (const [label, appliedAmountCents] of attempts) {
        const response = await h.raw('POST', `/transactions/${tx.id}/link`, { invoiceId: invoice.id, appliedAmountCents, reason: 'x' });
        assert.equal(response.status, 400, `${label}: ${response.text}`);
      }
      const owed = await newInvoice();
      const large = await bankLine(1000);
      const tooMuch = await h.raw('POST', `/transactions/${large.id}/link`, { invoiceId: owed.id, appliedAmountCents: Math.round(owed.amount * 100) + 1, reason: 'x' });
      assert.equal(tooMuch.status, 400, tooMuch.text);
      assert.equal((await invoiceOf(invoice.id)).payments.length, 0);
      assert.equal((await invoiceOf(owed.id)).payments.length, 0);
      assert.equal((await txsOf(tx.accountId!))[0]!.linkedInvoiceId, undefined);
    });

    test('linking the same pair twice is idempotent and never doubles the payment', async () => {
      const invoice = await newInvoice();
      const tx = await bankLine(100);
      await h.api.transactions.link({ transactionId: tx.id, invoiceId: invoice.id });
      const again = await h.api.transactions.link({ transactionId: tx.id, invoiceId: invoice.id });
      assert.equal(again.invoice!.payments.length, 1);
      assert.equal(again.invoice!.status, 'open');
      const explicit = await h.raw('POST', `/transactions/${tx.id}/link`, { invoiceId: invoice.id, appliedAmountCents: 5000, reason: 'anderer Betrag' });
      assert.equal(explicit.status, 409, 'a different amount for an existing link is a conflict');
      assert.equal((await invoiceOf(invoice.id)).payments.length, 1);
    });

    test('resending a stale copy of the invoice without its payments does not drop the bank payment', async () => {
      const invoice = await newInvoice();
      const tx = await bankLine(100);
      await h.api.transactions.link({ transactionId: tx.id, invoiceId: invoice.id });
      const resent = await h.api.invoices.upsert({ reason: 'veraltete Kopie gespeichert', invoice: { ...invoice, payments: [], status: 'open' } });
      assert.deepEqual(resent.payments.map((payment) => payment.id), [txPaymentId(tx.id)]);
      assert.equal((await txsOf(tx.accountId!))[0]!.linkedInvoiceId, invoice.id);
      const paid = await bankLine(138);
      const settled = await h.api.transactions.link({ transactionId: paid.id, invoiceId: invoice.id });
      assert.equal(settled.invoice!.status, 'paid');
      const again = await h.api.invoices.upsert({ reason: 'noch eine veraltete Kopie', invoice: { ...invoice, payments: [], status: 'open' } });
      assert.equal(again.status, 'paid', 'a stale status does not reopen a settled invoice');
      assert.equal(again.payments.length, 2);
    });

    test('a refund on an invoice settled by the bank is a negative EÜR item, is idempotent, and leaves the bank link alone', async () => {
      const invoice = await newInvoice();
      const tx = await bankLine(invoice.amount);
      await h.api.transactions.link({ transactionId: tx.id, invoiceId: invoice.id });
      const refund = { id: randomUUID(), date: today(), amount: -50, method: 'Erstattung' };
      assert.equal((await h.raw('POST', `/invoices/${invoice.id}/payments`, { payment: refund, reason: 'Teilerstattung' })).status, 200);
      assert.equal((await h.raw('POST', `/invoices/${invoice.id}/payments`, { payment: refund, reason: 'Wiederholung' })).status, 200);
      const stored = await invoiceOf(invoice.id);
      assert.equal(stored.payments.length, 2);
      assert.equal(stored.status, 'open', '188 of 238 is paid after the refund');
      const refundItems = (await euerItems()).filter((item) => item.sourceId === `${invoice.id}:payment:${refund.id}`);
      if (liteEur) assert.equal(refundItems.length, 1);
      if (liteEur) assert.equal(refundItems[0]!.amountGross, -50);
      await h.raw('POST', `/invoices/${invoice.id}/payments/${refund.id}/reverse`, { reason: 'Erstattung storniert', expectedPayment: refund });
      if (liteEur) assert.ok(!(await euerItems()).some((item) => item.sourceId === `${invoice.id}:payment:${refund.id}`));
      assert.equal((await invoiceOf(invoice.id)).status, 'paid');
      assert.equal((await txsOf(tx.accountId!))[0]!.linkedInvoiceId, invoice.id);
    });

    test('one bank line cannot pay a second invoice', async () => {
      const [first, second] = [await newInvoice(), await newInvoice()];
      const tx = await bankLine(238);
      await h.api.transactions.link({ transactionId: tx.id, invoiceId: first.id });
      const response = await h.raw('POST', `/transactions/${tx.id}/link`, { invoiceId: second.id, reason: 'doppelt' });
      assert.equal(response.status, 409, response.text);
      assert.match(response.text, /TRANSACTION_ALREADY_LINKED/);
      assert.equal((await invoiceOf(second.id)).payments.length, 0);
      assert.equal((await invoiceOf(second.id)).status, 'open');
      assert.equal((await invoiceOf(first.id)).payments.length, 1);
    });

    test('concurrent links of one bank line to two invoices pay exactly one of them', async () => {
      const [first, second] = [await newInvoice(), await newInvoice()];
      const tx = await bankLine(238);
      const outcomes = await Promise.allSettled([
        h.api.transactions.link({ transactionId: tx.id, invoiceId: first.id }),
        h.api.transactions.link({ transactionId: tx.id, invoiceId: second.id }),
      ]);
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      const payments = (await invoiceOf(first.id)).payments.length + (await invoiceOf(second.id)).payments.length;
      assert.equal(payments, 1);
    });

    test('two bank lines linked concurrently cannot overpay one invoice', async () => {
      const invoice = await newInvoice();
      const account = (await newAccount()).id;
      await importRows(account, [`${today()},238,Zahler Eins,x`, `${today()},238,Zahler Zwei,y`]);
      const lines = await txsOf(account);
      const outcomes = await Promise.allSettled(lines.map((tx) => h.api.transactions.link({ transactionId: tx.id, invoiceId: invoice.id })));
      assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
      const rejected = outcomes.find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult;
      assert.match(String(rejected.reason), /PAYMENT_ALLOCATION_INVALID/);
      const stored = await invoiceOf(invoice.id);
      assert.equal(stored.payments.length, 1);
      assert.equal(stored.payments.reduce((sum, payment) => sum + payment.amount, 0), invoice.amount);
      assert.equal((await txsOf(account)).filter((tx) => tx.linkedInvoiceId).length, 1, 'the loser stays unlinked');
    });

    test('a draft, a paid, a credit note and a cancellation invoice cannot receive a bank payment', async () => {
      const tx = await bankLine(10);
      const draft = await draftInvoice(h.api, { client: unique('Entwurf') });
      const paid = await newInvoice();
      await h.api.invoices.savePayment({ invoiceId: paid.id, payment: { id: randomUUID(), date: today(), amount: paid.amount, method: 'cash' }, reason: 'bar' });
      const source = await newInvoice();
      const credit = await h.api.documents.chainIssue({ operation: 'correction', id: randomUUID(), invoiceId: source.id, kind: 'credit_note', amount: 10, date: today(), dueDate: today(), reason: 'Gutschrift' } as never);
      const cancellation = await h.api.documents.chainIssue({ operation: 'correction', id: randomUUID(), invoiceId: (await newInvoice()).id, kind: 'cancellation_invoice', date: today(), dueDate: today(), reason: 'Storno' } as never);
      for (const [label, target] of [['draft', draft.id], ['paid', paid.id], ['credit note', credit.id], ['cancellation invoice', cancellation.id]] as const) {
        const response = await h.raw('POST', `/transactions/${tx.id}/link`, { invoiceId: target, reason: 'x' });
        assert.equal(response.status, 400, `${label}: ${response.text}`);
        assert.match(response.text, /PAYMENT_ALLOCATION_INVALID/);
      }
      assert.equal((await txsOf(tx.accountId!))[0]!.linkedInvoiceId, undefined);
    });

    test('a cancelled invoice cannot receive a bank payment', async () => {
      const source = await newInvoice();
      const tx = await bankLine(source.amount);
      const revision = await h.api.documents.chainIssue({ operation: 'revision', id: randomUUID(), invoiceId: source.id, date: today(), dueDate: today(), reason: 'Adresse falsch' } as never);
      await h.api.invoices.upsert({ reason: 'Ersatz stellen', invoice: { ...revision, status: 'open' } });
      assert.equal((await invoiceOf(source.id)).status, 'cancelled');
      const response = await h.raw('POST', `/transactions/${tx.id}/link`, { invoiceId: source.id, reason: 'x' });
      assert.equal(response.status, 400, response.text);
    });

    test('an outgoing payment cannot pay an invoice', async () => {
      const invoice = await newInvoice();
      const tx = await bankLine(-238);
      const response = await h.raw('POST', `/transactions/${tx.id}/link`, { invoiceId: invoice.id, reason: 'x' });
      assert.equal(response.status, 400, response.text);
      assert.equal((await invoiceOf(invoice.id)).payments.length, 0);
    });

    test('a pending bank line cannot pay an invoice before the bank has booked it', async () => {
      const invoice = await newInvoice();
      const tx = await bankLine(invoice.amount, { status: 'pending' });
      assert.equal(tx.status, 'pending');
      const response = await h.raw('POST', `/transactions/${tx.id}/link`, { invoiceId: invoice.id, reason: 'x' });
      assert.equal(response.status, 400, response.text);
      assert.equal((await invoiceOf(invoice.id)).status, 'open');
    });

    test('unknown transactions and invoices are 404; reason and ids are required', async () => {
      const invoice = await newInvoice();
      const tx = await bankLine(10);
      assert.equal((await h.raw('POST', `/transactions/gibt-es-nicht/link`, { invoiceId: invoice.id, reason: 'x' })).status, 404);
      assert.equal((await h.raw('POST', `/transactions/${tx.id}/link`, { invoiceId: 'gibt-es-nicht', reason: 'x' })).status, 404);
      assert.equal((await h.raw('POST', `/transactions/${tx.id}/link`, { invoiceId: invoice.id, reason: ' ' })).status, 400);
      assert.equal((await h.raw('POST', `/transactions/${tx.id}/link`, { reason: 'x' })).status, 400);
      assert.equal((await h.raw('POST', `/transactions/${tx.id}/unlink`, { reason: '' })).status, 400);
      assert.equal((await txsOf(tx.accountId!))[0]!.linkedInvoiceId, undefined);
    });

    test('link and unlink are audited on both the transaction and the invoice with the caller reason', async () => {
      const invoice = await newInvoice();
      const tx = await bankLine(invoice.amount);
      const linkReason = unique('Kontoauszug geprüft');
      const unlinkReason = unique('Irrtum erkannt');
      assert.equal((await h.raw('POST', `/transactions/${tx.id}/link`, { invoiceId: invoice.id, reason: linkReason })).status, 200);
      assert.equal((await h.raw('POST', `/transactions/${tx.id}/unlink`, { reason: unlinkReason })).status, 200);
      const rows = (await auditCsv()).split('\n');
      const has = (id: string, action: string, reason: string) => rows.some((row) => row.includes(`"${id}"`) && row.includes(`"${action}"`) && row.includes(reason));
      assert.ok(has(tx.id, 'link_invoice', linkReason));
      assert.ok(has(invoice.id, 'payment_linked', linkReason));
      assert.ok(has(invoice.id, 'payment_unlinked', unlinkReason));
      assert.ok(has(tx.id, 'unlink_invoice', unlinkReason));
      assert.equal((await h.api.audit.verify()).ok, true);
    });
  });

  describe('unlinking', () => {
    test('unlinking reopens the invoice and frees the bank line for another invoice', async () => {
      const [first, second] = [await newInvoice(), await newInvoice()];
      const tx = await bankLine(238);
      await h.api.transactions.link({ transactionId: tx.id, invoiceId: first.id });
      assert.deepEqual(await h.api.transactions.unlink({ transactionId: tx.id }), { success: true });
      const reopened = await invoiceOf(first.id);
      assert.equal(reopened.status, 'open');
      assert.deepEqual(reopened.payments, []);
      assert.equal((await txsOf(tx.accountId!))[0]!.linkedInvoiceId, undefined);
      const relinked = await h.api.transactions.link({ transactionId: tx.id, invoiceId: second.id });
      assert.equal(relinked.invoice!.status, 'paid');
    });

    test('unlinking removes only that transaction payment, even next to a manual payment of the same date and amount', async () => {
      const invoice = await newInvoice();
      const [first, second] = [await bankLine(100, { date: today() }), await bankLine(38, { date: today() })];
      const manual = { id: randomUUID(), date: today(), amount: 100, method: 'cash' };
      await h.api.invoices.savePayment({ invoiceId: invoice.id, payment: manual, reason: 'bar' });
      await h.api.transactions.link({ transactionId: first.id, invoiceId: invoice.id });
      await h.api.transactions.link({ transactionId: second.id, invoiceId: invoice.id });
      assert.equal((await invoiceOf(invoice.id)).status, 'paid');
      await h.api.transactions.unlink({ transactionId: first.id });
      const stored = await invoiceOf(invoice.id);
      assert.deepEqual(stored.payments.map((payment) => payment.id).sort(), [manual.id, txPaymentId(second.id)].sort());
      assert.equal(stored.status, 'open', '138 of 238 is paid');
    });

    test('unlinking a line that is not linked is a 409, an unknown line a 404', async () => {
      const tx = await bankLine(10);
      const response = await h.raw('POST', `/transactions/${tx.id}/unlink`, { reason: 'x' });
      assert.equal(response.status, 409, response.text);
      assert.match(response.text, /TRANSACTION_NOT_LINKED/);
      assert.equal((await h.raw('POST', '/transactions/gibt-es-nicht/unlink', { reason: 'x' })).status, 404);
    });

    test('a bank payment cannot be edited or removed through the manual payment routes', async () => {
      const invoice = await newInvoice();
      const tx = await bankLine(100);
      const linked = await h.api.transactions.link({ transactionId: tx.id, invoiceId: invoice.id });
      const payment = linked.invoice!.payments[0]!;
      const reverse = await h.raw('POST', `/invoices/${invoice.id}/payments/${encodeURIComponent(payment.id)}/reverse`, { reason: 'x', expectedPayment: payment });
      assert.equal(reverse.status, 409, reverse.text);
      assert.equal((await invoiceOf(invoice.id)).payments.length, 1);
    });
  });

  describe('invoice suggestions for a bank line', () => {
    const open = (label: string, amount: number, extra: { client?: string; taxMode?: 'vat_exempt_4_ustg' } = {}) =>
      issueInvoice(h.api, {
        client: extra.client ?? unique(label), date: '2020-01-10', taxMode: 'vat_exempt_4_ustg', taxMeta: datevEvidence(product) as never,
        items: [{ kind: 'item', description: label, quantity: 1, price: amount, total: amount }],
      });
    /** Bank line dated far from every due date so only amount, number and name rules can fire. */
    const farLine = (amount: number, extra: { name?: string; purpose?: string; status?: string } = {}) =>
      bankLine(amount, { date: '2020-03-01', name: extra.name ?? 'Zzqx Zahler', purpose: extra.purpose ?? 'Zahlung', status: extra.status });
    const suggest = async (transactionId: string) => (await h.api.transactions.findMatches({ transactionId })).suggestions;

    test('suggestions rank by confidence first and by amount difference second; unrelated invoices are absent', async () => {
      const exact = await open('exact', 4000);
      const close = await open('close', 4003);
      const similar = await open('similar', 4300);
      const unrelated = await open('unrelated', 9000);
      const byName = await open('byname', 9000, { client: 'Zzqx Rangfolge GmbH' });
      const byNumber = await open('bynumber', 9000);
      const tx = await farLine(4000, { purpose: `Zahlung ${byNumber.number}` });

      const result = await suggest(tx.id);
      assert.deepEqual(result.map((s) => s.invoice.id), [exact.id, close.id, byNumber.id, similar.id, byName.id]);
      assert.deepEqual(result.map((s) => s.confidence), ['high', 'high', 'high', 'medium', 'medium']);
      assert.ok(!result.some((s) => s.invoice.id === unrelated.id));
      assert.match(result[0]!.matchReasons.join(), /Betrag stimmt überein/);
      assert.match(result[2]!.matchReasons.join(), /Rechnungsnummer in Verwendungszweck/);
      assert.match(result[3]!.matchReasons.join(), /Betrag ähnlich/);
      assert.match(result[4]!.matchReasons.join(), /Kundenname im Auftraggeber/);
      assert.deepEqual(result.slice(0, 2).map((s) => s.amountDiff), [0, 3]);
    });

    test('a due date within 14 days adds a reason and lifts an otherwise unrelated invoice to medium', async () => {
      const invoice = await issueInvoice(h.api, { client: unique('Fällig'), date: '2020-02-01', dueDate: '2020-02-15', taxMode: 'vat_exempt_4_ustg', taxMeta: datevEvidence(product) as never, items: [{ kind: 'item', description: 'x', quantity: 1, price: 77_000, total: 77_000 }] });
      const tx = await bankLine(5, { date: '2020-02-20', name: 'Zzqx Fristzahler' });
      const hit = (await suggest(tx.id)).find((s) => s.invoice.id === invoice.id)!;
      assert.equal(hit.confidence, 'medium');
      assert.match(hit.matchReasons.join(), /Zahlung nahe Fälligkeitsdatum/);
    });

    test('only the open remainder of a partly paid invoice is compared with the bank amount', async () => {
      const invoice = await open('partly', 2468);
      await h.api.invoices.savePayment({ invoiceId: invoice.id, payment: { id: randomUUID(), date: today(), amount: 1234, method: 'cash' }, reason: 'Anzahlung' });
      const tx = await farLine(1234);
      const hit = (await suggest(tx.id)).find((s) => s.invoice.id === invoice.id)!;
      assert.equal(hit.confidence, 'high');
      assert.equal(hit.amountDiff, 0);
    });

    test('paid, draft and cancelled invoices are never suggested; the open replacement is', async () => {
      const paid = await open('paid', 20_000);
      await h.api.invoices.savePayment({ invoiceId: paid.id, payment: { id: randomUUID(), date: today(), amount: 20_000, method: 'cash' }, reason: 'bar' });
      const draft = await draftInvoice(h.api, { client: unique('Entwurf'), taxMode: 'vat_exempt_4_ustg', items: [{ kind: 'item', description: 'x', quantity: 1, price: 20_000, total: 20_000 }] });
      const source = await open('cancelled', 20_000);
      const revision = await h.api.documents.chainIssue({ operation: 'revision', id: randomUUID(), invoiceId: source.id, date: '2020-01-10', dueDate: '2020-01-24', reason: 'Fehler' } as never);
      const replacement = await h.api.invoices.upsert({ reason: 'Ersatz stellen', invoice: { ...revision, status: 'open' } });
      assert.equal((await invoiceOf(source.id)).status, 'cancelled');
      const tx = await farLine(20_000);
      const ids = (await suggest(tx.id)).map((s) => s.invoice.id);
      assert.ok(ids.includes(replacement.id), 'the open replacement is suggested');
      for (const [label, id] of [['paid', paid.id], ['draft', draft.id], ['cancelled', source.id]] as const) assert.ok(!ids.includes(id), `${label} invoice must not be suggested`);
    });

    test('credit notes and cancellation invoices are not suggested because they cannot be paid by a bank line', async () => {
      const source = await open('gutschrift quelle', 22_222);
      const credit = await h.api.documents.chainIssue({ operation: 'correction', id: randomUUID(), invoiceId: source.id, kind: 'credit_note', amount: 11_111, date: '2020-01-10', dueDate: '2020-01-24', reason: 'Gutschrift' } as never);
      const tx = await farLine(11_111);
      const ids = (await suggest(tx.id)).map((s) => s.invoice.id);
      assert.ok(!ids.includes(credit.id), 'credit note suggested');
    });

    test('at most five suggestions are returned', async () => {
      for (let index = 0; index < 7; index += 1) await open(`gleich ${index}`, 31_000 + index);
      const tx = await farLine(31_003);
      const result = await suggest(tx.id);
      assert.equal(result.length, 5);
      assert.ok(result.every((s) => s.confidence === 'high'));
      assert.equal(result[0]!.amountDiff, 0);
    });

    test('suggestions refuse pending lines and unknown ids, and return the transaction itself', async () => {
      const pending = await farLine(10, { status: 'pending' });
      await assert.rejects(h.api.transactions.findMatches({ transactionId: pending.id }), /PAYMENT_ALLOCATION_INVALID/);
      assert.equal((await h.raw('GET', `/transactions/${pending.id}/matches`)).status, 400);
      assert.equal((await h.raw('GET', '/transactions/gibt-es-nicht/matches')).status, 404);
      const booked = await farLine(10);
      assert.equal((await h.api.transactions.findMatches({ transactionId: booked.id })).transaction.id, booked.id);
    });

    test('an outgoing bank line gets no amount match for an invoice', async () => {
      const invoice = await open('ausgehend', 15_000);
      const tx = await farLine(-15_000);
      assert.ok(!(await suggest(tx.id)).some((s) => s.invoice.id === invoice.id));
    });
  });

  // Pro hides the cash book (EurView); its routes are Lite-only.
  if (product === 'lite') describe('manual cash entries', () => {
    test('an entry is saved, listed, and updated with the stamp of the version it was read from', async () => {
      const saved = await saveEntry({ purpose: 'Briefmarken' });
      assert.ok(saved.updatedAt);
      assert.equal(saved.originalCashDate, saved.cashDate);
      assert.ok((await h.api.cash.listEntries()).some((entry) => entry.id === saved.id));
      const updated = await h.api.cash.saveEntry({ entry: { ...entryInput({ id: saved.id }), purpose: 'Briefmarken und Papier', amountCents: -6100 }, expectedUpdatedAt: saved.updatedAt, reason: 'Betrag korrigiert' });
      assert.equal(updated.purpose, 'Briefmarken und Papier');
      assert.equal(updated.amountCents, -6100);
      assert.ok(updated.updatedAt > saved.updatedAt);
      const line = (await auditCsv()).split('\n').find((row) => row.includes(saved.id) && row.includes('lite.cash.update'));
      assert.ok(line, 'update is audited');
    });

    test('updating with a stale or missing stamp is a 409 and leaves the entry unchanged', async () => {
      const saved = await saveEntry();
      const current = await h.api.cash.saveEntry({ entry: { ...entryInput({ id: saved.id }), purpose: 'Zweite Fassung' }, expectedUpdatedAt: saved.updatedAt, reason: 'zweite Fassung' });
      const edit = { ...entryInput({ id: saved.id }), purpose: 'Dritte Fassung' };
      const stale = await h.raw('POST', '/cash/entries', { entry: edit, expectedUpdatedAt: saved.updatedAt, reason: 'veraltet' });
      assert.equal(stale.status, 409, stale.text);
      assert.match(stale.body.message, /inzwischen geändert/);
      const missing = await h.raw('POST', '/cash/entries', { entry: edit, reason: 'ohne Stempel' });
      assert.equal(missing.status, 409, missing.text);
      const stored = (await h.api.cash.listEntries()).find((entry) => entry.id === saved.id)!;
      assert.equal(stored.purpose, 'Zweite Fassung');
      assert.equal(stored.updatedAt, current.updatedAt);
    });

    test('saving identical content again is idempotent and creates no new version', async () => {
      const saved = await saveEntry();
      const again = await h.api.cash.saveEntry({ entry: entryInput({ id: saved.id }), reason: 'Wiederholung' } as never);
      assert.equal(again.updatedAt, saved.updatedAt);
      const audits = (await auditCsv()).split('\n').filter((row) => row.includes(saved.id) && row.includes('lite.cash.'));
      assert.equal(audits.length, 1);
    });

    test('malformed entries are rejected with 400 and nothing is stored', async () => {
      const base = entryInput();
      const bad: Array<[string, Record<string, unknown>]> = [
        ['zero amount', { ...base, amountCents: 0 }],
        ['fractional cents', { ...base, amountCents: 12.5 }],
        ['foreign currency', { ...base, currency: 'USD' }],
        ['impossible date', { ...base, cashDate: `${YEAR}-02-30` }],
        ['month 13', { ...base, cashDate: `${YEAR}-13-01` }],
        ['german date', { ...base, cashDate: '05.08.2026' }],
        ['blank counterparty', { ...base, counterparty: '  ' }],
        ['blank purpose', { ...base, purpose: '' }],
        ['unknown flow type', { ...base, flowType: 'transfer' }],
        ['missing id', { ...base, id: '' }],
      ];
      for (const [label, entry] of bad) {
        const response = await h.raw('POST', '/cash/entries', { entry, reason: 'x' });
        assert.equal(response.status, 400, `${label}: ${response.text}`);
      }
      assert.equal((await h.raw('POST', '/cash/entries', { entry: base, reason: '  ' })).status, 400, 'reason is required');
      assert.ok(!(await h.api.cash.listEntries()).some((entry) => entry.id === base.id));
    });

    test('an entry must reference an existing receipt', async () => {
      const response = await h.raw('POST', '/cash/entries', { entry: entryInput({ receiptId: 'gibt-es-nicht' }), reason: 'x' });
      assert.equal(response.status, 400, response.text);
      const receipt = await h.api.cash.saveReceipt({ receipt: receiptInput(), reason: 'Beleg erfasst' } as never);
      const linked = await saveEntry({ receiptId: receipt.id });
      assert.equal(linked.receiptId, receipt.id);
    });

    test('the sign of the amount must agree with the flow type', async () => {
      const expense = await h.raw('POST', '/cash/entries', { entry: entryInput({ flowType: 'expense', amountCents: 1234 }), reason: 'x' });
      assert.equal(expense.status, 400, expense.text);
      const income = await h.raw('POST', '/cash/entries', { entry: entryInput({ flowType: 'income', amountCents: -1234 }), reason: 'x' });
      assert.equal(income.status, 400, income.text);
    });

    test('a deleted entry disappears from list and EÜR, can be deleted only once, and its id is not reused', async () => {
      const saved = await saveEntry();
      assert.ok((await euerItems()).some((item) => item.sourceType === 'manual' && item.sourceId === saved.id));
      const stale = await h.raw('DELETE', `/cash/entries/${saved.id}`, { expectedUpdatedAt: '2000-01-01T00:00:00.000Z', reason: 'x' });
      assert.equal(stale.status, 409, stale.text);
      assert.deepEqual(await h.api.cash.deleteEntry({ id: saved.id, expectedUpdatedAt: saved.updatedAt, reason: 'Fehlbuchung' }), { ok: true });
      assert.ok(!(await h.api.cash.listEntries()).some((entry) => entry.id === saved.id));
      assert.ok(!(await euerItems()).some((item) => item.sourceId === saved.id));
      const again = await h.raw('DELETE', `/cash/entries/${saved.id}`, { expectedUpdatedAt: saved.updatedAt, reason: 'x' });
      assert.equal(again.status, 404);
      const reuse = await h.raw('POST', '/cash/entries', { entry: entryInput({ id: saved.id }), reason: 'x' });
      assert.equal(reuse.status, 400, reuse.text);
      assert.ok((await auditCsv()).split('\n').some((row) => row.includes(saved.id) && row.includes('lite.cash.reverse')));
    });

    test('a deletion needs the expected stamp and a reason', async () => {
      const saved = await saveEntry();
      assert.equal((await h.raw('DELETE', `/cash/entries/${saved.id}`, { reason: 'x' })).status, 400);
      assert.equal((await h.raw('DELETE', `/cash/entries/${saved.id}`, { expectedUpdatedAt: saved.updatedAt, reason: '' })).status, 400);
      assert.ok((await h.api.cash.listEntries()).some((entry) => entry.id === saved.id));
    });
  });

  // Pro hides the cash book (EurView); its routes are Lite-only.
  if (product === 'lite') describe('matching cash entries to bank lines', () => {
    const matchedPair = async (amount = -59.5) => {
      const accountId = (await newAccount()).id;
      const tx = await bankLine(amount, { accountId, date: `${YEAR}-10-03` });
      const entry = await saveEntry({ cashDate: `${YEAR}-09-30`, amountCents: Math.round(amount * 100), flowType: amount < 0 ? 'expense' : 'income' });
      return { accountId, tx, entry };
    };

    test('matching moves the entry to the bank date, keeps the original, ties both sides and counts the money once', async () => {
      const { accountId, tx, entry } = await matchedPair();
      assert.ok((await euerItems()).some((item) => item.sourceId === tx.id), 'before: the bank line is an EÜR item');
      const matched = await h.api.cash.matchEntry({ id: entry.id, transactionId: tx.id, expectedCashDate: entry.originalCashDate, reason: 'Kontoauszug 10/2026 geprüft' });
      assert.equal(matched.matchedTransactionId, tx.id);
      assert.equal(matched.cashDate, `${YEAR}-10-03`);
      assert.equal(matched.originalCashDate, `${YEAR}-09-30`);
      assert.equal(matched.accountId, accountId);
      const listed = (await txsOf(accountId))[0]!;
      assert.equal(listed.matchedManualEntryId, entry.id);
      assert.ok(!(await h.api.transactions.list({ unlinkedOnly: true })).some((candidate) => candidate.id === tx.id));
      const items = await euerItems();
      assert.equal(items.filter((item) => item.sourceId === entry.id).length, 1, 'one manual item');
      assert.equal(items.filter((item) => item.sourceId === tx.id).length, 0, 'no second item for the bank line');
      assert.ok((await auditCsv()).split('\n').some((row) => row.includes(entry.id) && row.includes('lite.cash.match')));
    });

    test('an EÜR classification given to the manual entry survives matching and unmatching', async () => {
      const report = await h.api.eur.getReport({ taxYear: YEAR });
      const eurLineId = report.rows.find((row) => row.kind === 'expense')!.lineId;
      const { tx, entry } = await matchedPair();
      await h.api.eur.upsertClassification({ sourceType: 'manual', sourceId: entry.id, taxYear: YEAR, eurLineId, vatMode: 'none', reason: 'Betriebsausgabe geprüft' });
      const classified = async () => (await euerItems()).find((item) => item.sourceId === entry.id)!.classification?.eurLineId;
      assert.equal(await classified(), eurLineId);
      await h.api.cash.matchEntry({ id: entry.id, transactionId: tx.id, expectedCashDate: entry.originalCashDate, reason: 'geprüft' });
      assert.equal(await classified(), eurLineId, 'classification kept after the match');
      await h.api.cash.unmatchEntry({ id: entry.id, reason: 'gelöst' });
      assert.equal(await classified(), eurLineId, 'classification kept after the unmatch');
    });

    test('matching the same pair twice is idempotent', async () => {
      const { tx, entry } = await matchedPair();
      const args = { id: entry.id, transactionId: tx.id, expectedCashDate: entry.originalCashDate, reason: 'geprüft' };
      const first = await h.api.cash.matchEntry(args);
      const second = await h.api.cash.matchEntry(args);
      assert.equal(second.updatedAt, first.updatedAt);
    });

    test('a match needs the same signed amount, a booked line, a free line, the current cash date and an existing line', async () => {
      const { tx, entry } = await matchedPair();
      const post = (id: string, body: Record<string, unknown>) => h.raw('POST', `/cash/entries/${id}/match`, { reason: 'geprüft', ...body });
      const other = await saveEntry({ amountCents: -5951 });
      const income = await saveEntry({ amountCents: 5950, flowType: 'income' });
      const pending = await bankLine(-59.5, { status: 'pending' });
      const invoice = await newInvoice();
      const paying = await bankLine(invoice.amount);
      await h.api.transactions.link({ transactionId: paying.id, invoiceId: invoice.id });
      const cases: Array<[string, string, Record<string, unknown>, number]> = [
        ['amount differs by one cent', other.id, { transactionId: tx.id, expectedCashDate: other.originalCashDate }, 409],
        ['sign differs', income.id, { transactionId: tx.id, expectedCashDate: income.originalCashDate }, 409],
        ['bank line is pending', entry.id, { transactionId: pending.id, expectedCashDate: entry.originalCashDate }, 409],
        ['bank line pays an invoice', (await saveEntry({ amountCents: Math.round(invoice.amount * 100), flowType: 'income' })).id, { transactionId: paying.id, expectedCashDate: `${YEAR}-08-05` }, 409],
        ['stale cash date', entry.id, { transactionId: tx.id, expectedCashDate: '1999-01-01' }, 409],
        ['unknown bank line', entry.id, { transactionId: 'gibt-es-nicht', expectedCashDate: entry.originalCashDate }, 409],
        ['no bank line given', entry.id, { expectedCashDate: entry.originalCashDate }, 400],
        ['no cash date given', entry.id, { transactionId: tx.id }, 400],
        ['unknown entry', 'gibt-es-nicht', { transactionId: tx.id, expectedCashDate: entry.originalCashDate }, 404],
      ];
      for (const [label, id, body, status] of cases) {
        const response = await post(id, body);
        assert.equal(response.status, status, `${label}: ${response.text}`);
      }
      assert.equal((await h.api.cash.listEntries()).find((candidate) => candidate.id === entry.id)!.matchedTransactionId, undefined, 'nothing was matched');
    });

    test('one bank line cannot be matched to two entries', async () => {
      const { tx, entry } = await matchedPair();
      const twin = await saveEntry({ cashDate: entry.originalCashDate, amountCents: entry.amountCents });
      await h.api.cash.matchEntry({ id: entry.id, transactionId: tx.id, expectedCashDate: entry.originalCashDate, reason: 'geprüft' });
      const response = await h.raw('POST', `/cash/entries/${twin.id}/match`, { transactionId: tx.id, expectedCashDate: twin.originalCashDate, reason: 'doppelt' });
      assert.equal(response.status, 409, response.text);
    });

    test('a matched entry can be neither edited nor deleted, and its bank line cannot pay an invoice', async () => {
      const { tx, entry } = await matchedPair();
      const matched = await h.api.cash.matchEntry({ id: entry.id, transactionId: tx.id, expectedCashDate: entry.originalCashDate, reason: 'geprüft' });
      const edit = await h.raw('POST', '/cash/entries', { entry: { ...entryInput({ id: entry.id }), purpose: 'geändert' }, expectedUpdatedAt: matched.updatedAt, reason: 'x' });
      assert.equal(edit.status, 409, edit.text);
      assert.match(edit.body.message, /Bankabgleich/);
      const del = await h.raw('DELETE', `/cash/entries/${entry.id}`, { expectedUpdatedAt: matched.updatedAt, reason: 'x' });
      assert.equal(del.status, 409, del.text);
      const invoice = await newInvoice();
      const incomeTx = await bankLine(invoice.amount);
      const incomeEntry = await saveEntry({ cashDate: `${YEAR}-08-05`, amountCents: Math.round(invoice.amount * 100), flowType: 'income' });
      await h.api.cash.matchEntry({ id: incomeEntry.id, transactionId: incomeTx.id, expectedCashDate: incomeEntry.originalCashDate, reason: 'geprüft' });
      const link = await h.raw('POST', `/transactions/${incomeTx.id}/link`, { invoiceId: invoice.id, reason: 'x' });
      assert.equal(link.status, 409, link.text);
      assert.equal((await invoiceOf(invoice.id)).payments.length, 0);
    });

    test('unmatching restores the original date and the bank line, and is repeatable; then the entry can be edited and deleted again', async () => {
      const { accountId, tx, entry } = await matchedPair();
      await h.api.cash.matchEntry({ id: entry.id, transactionId: tx.id, expectedCashDate: entry.originalCashDate, reason: 'geprüft' });
      const unmatched = await h.api.cash.unmatchEntry({ id: entry.id, reason: 'falsche Zuordnung' });
      assert.equal(unmatched.matchedTransactionId, undefined);
      assert.equal(unmatched.cashDate, `${YEAR}-09-30`);
      assert.equal((await txsOf(accountId))[0]!.matchedManualEntryId, undefined);
      assert.equal((await h.api.cash.unmatchEntry({ id: entry.id, reason: 'nochmal' })).matchedTransactionId, undefined);
      const items = await euerItems();
      assert.equal(items.filter((item) => item.sourceId === tx.id).length, 1, 'bank line is an EÜR item again');
      const edited = await h.api.cash.saveEntry({ entry: { ...entryInput({ id: entry.id, amountCents: entry.amountCents }), purpose: 'jetzt editierbar' }, expectedUpdatedAt: (await h.api.cash.listEntries()).find((candidate) => candidate.id === entry.id)!.updatedAt, reason: 'x' });
      assert.equal(edited.purpose, 'jetzt editierbar');
      assert.equal((await h.raw('POST', '/cash/entries/gibt-es-nicht/unmatch', { reason: 'x' })).status, 404);
      assert.ok((await auditCsv()).split('\n').some((row) => row.includes(entry.id) && row.includes('lite.cash.unmatch')));
    });
  });

  // Pro hides the cash book (EurView); its routes are Lite-only.
  if (product === 'lite') describe('receipts and receipt files', () => {
    const reviewedReceipt = (overrides: Record<string, unknown> = {}) => receiptInput({
      reviewed: true, receivedDate: `${YEAR}-08-02`, serviceDate: `${YEAR}-08-01`,
      taxBreakdown: [{ rate: 19, netAmountCents: 10_000, vatAmountCents: 1900 }], ...overrides,
    });

    test('a receipt is saved and updated with the current stamp; a stale stamp is a 409', async () => {
      const receipt = receiptInput();
      const saved = await h.api.cash.saveReceipt({ receipt, reason: 'Beleg erfasst' } as never);
      assert.equal(saved.fileCount, 0);
      assert.ok((await h.api.cash.listReceipts()).some((entry) => entry.id === receipt.id));
      const updated = await h.api.cash.saveReceipt({ receipt: { ...receipt, counterparty: 'Papier AG' }, expectedUpdatedAt: saved.updatedAt, reason: 'Name korrigiert' } as never);
      assert.equal(updated.counterparty, 'Papier AG');
      const stale = await h.raw('POST', '/cash/receipts', { receipt: { ...receipt, counterparty: 'Veraltet' }, expectedUpdatedAt: saved.updatedAt, reason: 'x' });
      assert.equal(stale.status, 409, stale.text);
      const missing = await h.raw('POST', '/cash/receipts', { receipt: { ...receipt, counterparty: 'Ohne Stempel' }, reason: 'x' });
      assert.equal(missing.status, 409, missing.text);
      assert.equal((await h.api.cash.listReceipts()).find((entry) => entry.id === receipt.id)!.counterparty, 'Papier AG');
      const again = await h.api.cash.saveReceipt({ receipt: { ...receipt, counterparty: 'Papier AG' }, reason: 'Wiederholung' } as never);
      assert.equal(again.updatedAt, updated.updatedAt, 'identical content is idempotent');
    });

    test('a receipt marked reviewed needs both dates and a tax breakdown that adds up to the gross amount and to the tax rate', async () => {
      const attempts: Array<[string, Record<string, unknown>]> = [
        ['no dates and no breakdown', receiptInput({ reviewed: true })],
        ['missing service date', reviewedReceipt({ serviceDate: undefined })],
        ['empty breakdown', reviewedReceipt({ taxBreakdown: [] })],
        ['breakdown differs from gross', reviewedReceipt({ taxBreakdown: [{ rate: 19, netAmountCents: 10_000, vatAmountCents: 1800 }] })],
        ['vat does not match the rate', reviewedReceipt({ taxBreakdown: [{ rate: 19, netAmountCents: 10_000, vatAmountCents: 1900 }, { rate: 7, netAmountCents: 0, vatAmountCents: 5 }], grossAmountCents: 11_905 })],
        ['vat on a small business receipt', reviewedReceipt({ taxMode: 'small_business' })],
      ];
      for (const [label, receipt] of attempts) {
        const response = await h.raw('POST', '/cash/receipts', { receipt, reason: 'x' });
        assert.equal(response.status, 400, `${label}: ${response.text}`);
        assert.ok(!(await h.api.cash.listReceipts()).some((entry) => entry.id === receipt.id), `${label}: stored anyway`);
      }
      const good = await h.api.cash.saveReceipt({ receipt: reviewedReceipt(), reason: 'geprüft' } as never);
      assert.equal(good.reviewed, true);
    });

    test('malformed receipts are rejected at the boundary', async () => {
      const bad: Array<[string, Record<string, unknown>]> = [
        ['zero gross', receiptInput({ grossAmountCents: 0 })],
        ['unknown tax mode', receiptInput({ taxMode: 'magic' })],
        ['deductible over 100', receiptInput({ deductiblePercent: 101 })],
        ['unsupported tax rate', receiptInput({ taxBreakdown: [{ rate: 16, netAmountCents: 1, vatAmountCents: 0 }] })],
        ['bad document date', receiptInput({ documentDate: '31.12.2026' })],
        ['blank number', receiptInput({ number: ' ' })],
      ];
      for (const [label, receipt] of bad) {
        const response = await h.raw('POST', '/cash/receipts', { receipt, reason: 'x' });
        assert.equal(response.status, 400, `${label}: ${response.text}`);
      }
    });

    test('a correction receipt must reference another existing receipt with the same tax mode', async () => {
      const original = await h.api.cash.saveReceipt({ receipt: reviewedReceipt(), reason: 'Original' } as never);
      const correction = receiptInput({ correctionOfReceiptId: original.id, grossAmountCents: -11_900, taxMode: 'domestic', correctionReason: 'Rückgabe' });
      assert.equal((await h.raw('POST', '/cash/receipts', { receipt: { ...correction, correctionOfReceiptId: 'gibt-es-nicht' }, reason: 'x' })).status, 400);
      assert.equal((await h.raw('POST', '/cash/receipts', { receipt: { ...correction, correctionOfReceiptId: correction.id }, reason: 'x' })).status, 400);
      assert.equal((await h.raw('POST', '/cash/receipts', { receipt: { ...correction, taxMode: 'exempt' }, reason: 'x' })).status, 400);
      const saved = await h.api.cash.saveReceipt({ receipt: correction, reason: 'Korrektur' } as never);
      assert.equal(saved.correctionOfReceiptId, original.id);
    });

    test('a PDF comes back byte for byte with its hash, is listed, and counts on the receipt', async () => {
      const receipt = await h.api.cash.saveReceipt({ receipt: receiptInput(), reason: 'Beleg' } as never);
      const bytes = pdfBytes(5000, 1);
      bytes.write('Ünïcode ÿ', 100, 'latin1');
      const file = await h.api.cash.uploadFile({ receiptId: receipt.id, fileName: 'Rechnung März.pdf', mimeType: 'application/pdf', contentBase64: b64(bytes), reason: 'Original archiviert' });
      assert.equal(file.byteLength, 5000);
      assert.equal(file.sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.equal(file.fileName, 'Rechnung März.pdf');
      const downloaded = await h.api.cash.downloadFile({ id: file.id });
      assert.equal(downloaded.contentBase64, b64(bytes));
      assert.deepEqual((await h.api.cash.listFiles({ receiptId: receipt.id })).map((entry) => entry.id), [file.id]);
      assert.equal((await h.api.cash.listReceipts()).find((entry) => entry.id === receipt.id)!.fileCount, 1);
      assert.ok((await auditCsv()).split('\n').some((row) => row.includes(receipt.id) && row.includes('lite.receipt.upload')));
    });

    test('uploading identical bytes twice returns the same file, other bytes a new one', async () => {
      const receipt = await h.api.cash.saveReceipt({ receipt: receiptInput(), reason: 'Beleg' } as never);
      const body = { receiptId: receipt.id, fileName: 'a.pdf', mimeType: 'application/pdf' as const, contentBase64: b64(pdfBytes(300, 7)), reason: 'x' };
      const first = await h.api.cash.uploadFile(body);
      const second = await h.api.cash.uploadFile({ ...body, fileName: 'umbenannt.pdf' });
      assert.equal(second.id, first.id);
      const third = await h.api.cash.uploadFile({ ...body, contentBase64: b64(pdfBytes(300, 8)) });
      assert.notEqual(third.id, first.id);
      assert.equal((await h.api.cash.listFiles({ receiptId: receipt.id })).length, 2);
    });

    test('images and well-formed XML are accepted with their own signatures', async () => {
      const receipt = await h.api.cash.saveReceipt({ receipt: receiptInput(), reason: 'Beleg' } as never);
      const png = Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), Buffer.alloc(32)]);
      const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
      const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32)]);
      const xml = Buffer.from('<?xml version="1.0" encoding="UTF-8"?><Invoice><ID>B-1</ID></Invoice>');
      for (const [fileName, mimeType, bytes] of [['a.png', 'image/png', png], ['a.jpg', 'image/jpeg', jpeg], ['a.webp', 'image/webp', webp], ['a.xml', 'application/xml', xml], ['b.xml', 'text/xml', Buffer.from('<root>ü</root>')]] as const) {
        const file = await h.api.cash.uploadFile({ receiptId: receipt.id, fileName, mimeType, contentBase64: b64(bytes), reason: 'x' });
        assert.equal((await h.api.cash.downloadFile({ id: file.id })).contentBase64, b64(bytes), fileName);
      }
    });

    test('files whose content does not match, that carry XML entities or unsafe names, or that exceed a limit are refused', async () => {
      const receipt = await h.api.cash.saveReceipt({ receipt: receiptInput(), reason: 'Beleg' } as never);
      const xmlBody = (text: string) => ({ fileName: 'a.xml', mimeType: 'application/xml', contentBase64: b64(text) });
      const attempts: Array<[string, Record<string, unknown>, number]> = [
        ['png that is text', { fileName: 'a.png', mimeType: 'image/png', contentBase64: b64('hello') }, 400],
        ['pdf that is a png', { mimeType: 'application/pdf', contentBase64: b64(Buffer.from('\x89PNG\r\n\x1a\n', 'latin1')) }, 400],
        ['jpeg that is a pdf', { fileName: 'a.jpg', mimeType: 'image/jpeg', contentBase64: b64(pdfBytes(40)) }, 400],
        ['executable mime type', { fileName: 'a.exe', mimeType: 'application/x-msdownload', contentBase64: b64('MZ') }, 400],
        ['svg', { fileName: 'a.svg', mimeType: 'image/svg+xml', contentBase64: b64('<svg/>') }, 400],
        ['XML with DOCTYPE and entity', xmlBody('<!DOCTYPE Invoice [<!ENTITY x SYSTEM "file:///etc/passwd">]><Invoice>&x;</Invoice>'), 400],
        ['XML with a plain DOCTYPE', xmlBody('<!DOCTYPE Invoice><Invoice/>'), 400],
        ['XML declared as ISO-8859-1', xmlBody('<?xml version="1.0" encoding="ISO-8859-1"?><Invoice/>'), 400],
        ['text that is not XML', xmlBody('just text'), 400],
        ['XML with invalid UTF-8', { fileName: 'a.xml', mimeType: 'application/xml', contentBase64: b64(Buffer.from([0x3c, 0x61, 0x3e, 0xff, 0xfe, 0x3c, 0x2f, 0x61, 0x3e])) }, 400],
        ['path separator in the name', { fileName: '../a.pdf' }, 400],
        ['backslash in the name', { fileName: 'a\\b.pdf' }, 400],
        ['control character in the name', { fileName: 'a\u0007.pdf' }, 400],
        ['empty name', { fileName: '' }, 400],
        ['empty content', { contentBase64: '' }, 400],
        ['non-canonical base64', { contentBase64: 'AAA' }, 400],
        ['no reason', { reason: '' }, 400],
      ];
      for (const [label, body, status] of attempts) {
        const response = await uploadRaw(receipt.id, body);
        assert.equal(response.status, status, `${label}: ${response.text}`);
      }
      assert.deepEqual(await h.api.cash.listFiles({ receiptId: receipt.id }), [], 'nothing was stored');
    });

    test('files of unknown receipts and unknown files are 404', async () => {
      assert.equal((await uploadRaw('gibt-es-nicht', {})).status, 404);
      assert.equal((await h.raw('GET', '/cash/files/gibt-es-nicht')).status, 404);
      assert.deepEqual(await h.api.cash.listFiles({ receiptId: 'gibt-es-nicht' }), []);
    });

    test('a receipt holds at most ten different files', async () => {
      const receipt = await h.api.cash.saveReceipt({ receipt: receiptInput(), reason: 'Beleg' } as never);
      for (let seed = 0; seed < 10; seed += 1) {
        const response = await uploadRaw(receipt.id, { fileName: `f${seed}.pdf`, contentBase64: b64(pdfBytes(64, seed)) });
        assert.equal(response.status, 200, response.text);
      }
      const eleventh = await uploadRaw(receipt.id, { fileName: 'f10.pdf', contentBase64: b64(pdfBytes(64, 10)) });
      assert.equal(eleventh.status, 400, eleventh.text);
      const repeat = await uploadRaw(receipt.id, { fileName: 'f3.pdf', contentBase64: b64(pdfBytes(64, 3)) });
      assert.equal(repeat.status, 200, 'an already stored file is still accepted (idempotent)');
      assert.equal((await h.api.cash.listFiles({ receiptId: receipt.id })).length, 10);
    });

    test('exactly 10 MiB is accepted, one byte more is refused', { timeout: 60_000 }, async () => {
      const receipt = await h.api.cash.saveReceipt({ receipt: receiptInput(), reason: 'Beleg' } as never);
      const limit = 10 * 1024 * 1024;
      const refused = await uploadRaw(receipt.id, { fileName: 'zu-gross.pdf', contentBase64: b64(pdfBytes(limit + 1)) });
      assert.equal(refused.status, 400, refused.text);
      const accepted = await uploadRaw(receipt.id, { fileName: 'grenze.pdf', contentBase64: b64(pdfBytes(limit, 99)) });
      assert.equal(accepted.status, 200, accepted.text);
      assert.equal(accepted.body.byteLength, limit);
      const downloaded = await h.api.cash.downloadFile({ id: accepted.body.id });
      assert.equal(Buffer.from(downloaded.contentBase64, 'base64').length, limit);
    });

    test('a request body beyond the transport limit is answered with a 4xx, not a server error', async () => {
      const receipt = await h.api.cash.saveReceipt({ receipt: receiptInput(), reason: 'Beleg' } as never);
      const response = await uploadRaw(receipt.id, { fileName: 'riesig.pdf', contentBase64: b64(pdfBytes(11 * 1024 * 1024)) });
      assert.ok(response.status >= 400 && response.status < 500, `${response.status} ${response.text}`);
    });
  });

  describe('access and audit', () => {
    test('banking and cash routes refuse requests without or with a wrong local token', async () => {
      const routes: Array<[string, string, unknown?]> = [
        ['GET', '/accounts'], ['POST', '/accounts', { account: {} }], ['DELETE', '/accounts/x'],
        ['GET', '/transactions'], ['GET', '/transactions/x/matches'], ['POST', '/transactions/x/link', { invoiceId: 'i', reason: 'r' }], ['POST', '/transactions/x/unlink', { reason: 'r' }],
        ['POST', '/finance/import/preview', {}], ['POST', '/finance/import/commit', {}], ['GET', '/finance/import-batches'], ['GET', '/finance/import-batches/x'], ['POST', '/finance/import-batches/x/rollback', { reason: 'r' }],
        ['GET', '/cash/entries'], ['POST', '/cash/entries', {}], ['DELETE', '/cash/entries/x', {}], ['POST', '/cash/entries/x/match', {}], ['POST', '/cash/entries/x/unmatch', {}],
        ['GET', '/cash/receipts'], ['POST', '/cash/receipts', {}], ['GET', '/cash/receipts/x/files'], ['POST', '/cash/receipts/x/files', {}], ['GET', '/cash/files/x'],
      ];
      for (const [method, path, body] of routes) {
        for (const headers of [{}, { 'x-billme-local-token': 'falsch' }] as Array<Record<string, string>>) {
          const response = await fetch(`${h.connection.baseUrl}/api/v1/${product}${path}`, {
            method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body),
          });
          assert.equal(response.status, 401, `${method} ${path} with ${JSON.stringify(headers)}`);
        }
      }
    });

    test('after all of the above the audit chain still verifies', async () => {
      const verify = await h.api.audit.verify();
      assert.equal(verify.ok, true, JSON.stringify(verify));
    });
  });

  describe('restart', () => {
    if (product === 'lite') test('imports, links, cash matches, receipts and files survive an app restart; upload handles do not', { timeout: 180_000 }, async () => {
      const first = h;
      const path = await writeCsv(`${HEADER}\n${today()},238,Kunde Neustart,RE\n${YEAR}-08-05,-59.50,Papierhandel,Material\n${YEAR}-08-06,-10.00,Zusatz,Rollback\nkaputt,1,A,B\n`);
      const account = await newAccount({ name: 'Neustart-Konto', balance: 12.5, color: '#123456' });
      const imported = await first.api.finance.importCommit({ path, accountId: account.id, mapping: MAP, profile: 'generic' } as never);
      assert.equal(imported.imported, 3);
      assert.equal(imported.errors.length, 1);
      const lines = await txsOf(account.id);
      const paying = lines.find((tx) => tx.amount === 238)!;
      const outgoing = lines.find((tx) => tx.amount === -59.5)!;
      const invoice = await issueInvoice(first.api, { client: 'Kunde Neustart' });
      await first.api.transactions.link({ transactionId: paying.id, invoiceId: invoice.id });
      const entry = await saveEntry({ cashDate: `${YEAR}-08-05`, amountCents: -5950 });
      await first.api.cash.matchEntry({ id: entry.id, transactionId: outgoing.id, expectedCashDate: entry.originalCashDate, reason: 'Kontoauszug' });
      const receipt = await first.api.cash.saveReceipt({ receipt: receiptInput({ number: 'B-NEUSTART' }), reason: 'Beleg' } as never);
      const bytes = pdfBytes(4096, 42);
      const file = await first.api.cash.uploadFile({ receiptId: receipt.id, fileName: 'beleg.pdf', mimeType: 'application/pdf', contentBase64: b64(bytes), reason: 'archiviert' });
      const second = await commit(account.id, `${HEADER}\n${YEAR}-09-01,5,Zweite Datei,x\n`);
      await first.api.finance.rollbackImportBatch({ batchId: second.batchId, reason: 'Testdatei verworfen' });
      const handle = (await first.api.finance.importPreview({ fileName: 'a.csv', contentBase64: b64(`${HEADER}\n2026-08-01,1,A,B\n`), profile: 'generic', mapping: MAP } as never)).path;
      await first.close({ keepData: true });

      const reopened = await startProduct(product, null, 'transactions-restart', first.userDataPath);
      h = reopened;
      assert.deepEqual((await reopened.api.accounts.list()).find((candidate) => candidate.id === account.id), account);
      const restored = await reopened.api.transactions.list({ accountId: account.id });
      assert.equal(restored.length, 3);
      const restoredPaying = restored.find((tx) => tx.id === paying.id)!;
      assert.equal(restoredPaying.linkedInvoiceId, invoice.id);
      assert.equal(restoredPaying.appliedAmountCents, 23_800);
      assert.equal(restored.find((tx) => tx.id === outgoing.id)!.matchedManualEntryId, entry.id);
      const stored = (await reopened.api.invoices.list()).find((candidate) => candidate.id === invoice.id)!;
      assert.equal(stored.status, 'paid');
      assert.equal(stored.payments[0]!.id, `transaction-payment:${paying.id}`);
      const batches = await reopened.api.finance.listImportBatches({ accountId: account.id });
      assert.equal(batches.length, 2);
      const rolledBack = batches.find((batch) => batch.id === second.batchId)!;
      assert.equal(rolledBack.rollbackReason, 'Testdatei verworfen');
      assert.ok(rolledBack.rolledBackAt);
      const cash = (await reopened.api.cash.listEntries()).find((candidate) => candidate.id === entry.id)!;
      assert.equal(cash.matchedTransactionId, outgoing.id);
      assert.equal(cash.originalCashDate, `${YEAR}-08-05`);
      assert.equal((await reopened.api.cash.listReceipts()).find((candidate) => candidate.id === receipt.id)!.fileCount, 1);
      assert.equal((await reopened.api.cash.downloadFile({ id: file.id })).contentBase64, b64(bytes));

      const replay = await reopened.api.finance.importCommit({ path, accountId: account.id, mapping: MAP, profile: 'generic' } as never);
      assert.equal(replay.batchId, imported.batchId, 'the file hash is remembered across restarts');
      assert.equal((await reopened.api.transactions.list({ accountId: account.id })).length, 3);
      const stillLinked = await reopened.raw('POST', `/finance/import-batches/${imported.batchId}/rollback`, { reason: 'nach Neustart' });
      assert.equal(stillLinked.status, 409, 'link protection survives the restart');
      const expired = await reopened.raw('POST', '/finance/import/preview', { path: handle });
      assert.equal(expired.status, 404, 'an upload handle belongs to the session that created it');
      const next = await reopened.api.numbers.reserve({ kind: 'invoice' });
      assert.ok(next.number > invoice.number, 'numbering continues');
      assert.equal((await reopened.api.audit.verify()).ok, true);
    });
  });
});
