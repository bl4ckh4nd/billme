import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { startPro, type ProHarness } from './harness.js';
import { addBankAccount, approveDraft, bankTransactions, getDraft, importCsv, postDraft, type BankTx } from './pro-fixtures.js';

/**
 * How the account suggestion for a bank line is chosen, through the Pro
 * workbench: explicit rule > remembered counterparty > naive Bayes > keyword >
 * fallback. A fresh tenant, so the training set is exactly what the test posts.
 *
 * How this can fail (each one has a test below):
 * - the model answers before it has 20 posted bookings to learn from
 * - the model answers with a low-confidence guess for text it has not seen
 * - a learned guess outranks a remembered counterparty or an explicit rule
 * - the remembered counterparty is the oldest booking, not the newest
 * - rules do not match across umlaut / case / ß spelling
 * - a suggested draft that a batch posts gross: the partner's one known tax case is not taken over,
 *   or a mixed history is guessed instead of left open
 */
describe('pro account suggestions learn from posted bookings', () => {
  let h: ProHarness;
  let bank: string;
  before(async () => { h = await startPro(null, 'pro-suggestions'); bank = await addBankAccount(h, 'bank-learn'); });
  after(async () => { await h.close(); });

  const suggestion = async (counterparty: string, purpose?: string): Promise<BankTx> => {
    const found = (await bankTransactions(h)).find((tx) => tx.counterparty === counterparty && (purpose === undefined || tx.purpose === purpose));
    assert.ok(found, `${counterparty} is in the workbench`);
    return found;
  };
  /** Book a pending line on a chosen expense account, as the accountant accepts or overrides the suggestion. */
  const book = async (tx: BankTx, account: string) => {
    const d = await getDraft(h, tx.id);
    await approveDraft(h, d, [{ ...d.lines[0]!, accountNumber: account }, d.lines[1]!], { postingDate: tx.date });
    assert.equal((await postDraft(h, d.id, { postingDate: tx.date })).status, 200);
  };
  const addRule = (body: Record<string, unknown>) => h.raw('POST', '/accounting/account-suggestion-rules', { chart: 'SKR03', priority: 10, field: 'counterparty', operator: 'contains', targetAccountNumber: '4920', flowType: 'expense', reason: 'Regel', ...body });
  const officePurpose = 'Büromaterial Bestellung Papier Toner';
  const phonePurpose = 'Telefon Mobilfunk Rechnung Vertrag';
  const training = async (from: number, to: number) => {
    const rows = Array.from({ length: to - from + 1 }, (_, index) => {
      const n = from + index;
      return n % 2 === 0
        ? { date: `2026-03-${String(n).padStart(2, '0')}`, amount: -(10 + n), counterparty: `Papierhandel ${String(n).padStart(2, '0')}`, purpose: officePurpose, account: '4930' }
        : { date: `2026-03-${String(n).padStart(2, '0')}`, amount: -(10 + n), counterparty: `Mobilanbieter ${String(n).padStart(2, '0')}`, purpose: phonePurpose, account: '4920' };
    });
    await importCsv(h, bank, rows);
    for (const row of rows) await book(await suggestion(row.counterparty), row.account);
  };

  test('below 20 posted bookings only the remembered counterparty and the fallback answer; no model guesses', async () => {
    await importCsv(h, bank, [{ date: '2026-04-01', amount: -33, counterparty: 'Unbekannter Neuer', purpose: officePurpose }]);
    assert.equal((await suggestion('Unbekannter Neuer')).suggestionLayer, 'fallback');
    await training(1, 18);
    const after18 = await suggestion('Unbekannter Neuer');
    assert.equal(after18.suggestionLayer, 'fallback', '18 bookings are not enough to train');
    assert.deepEqual([(await suggestion('Papierhandel 02')).suggestionLayer, (await suggestion('Papierhandel 02')).suggestedAccountNumber], ['counterparty', '4930'], 'a booked counterparty is remembered at once');
  });

  test('from the 20th posted booking the model suggests the learned account per kind of text, and stays silent for text it does not know', async () => {
    await training(19, 20);
    const office = await suggestion('Unbekannter Neuer');
    assert.deepEqual([office.suggestionLayer, office.suggestedAccountNumber], ['bayes', '4930']);
    assert.match(office.suggestionReason ?? '', /^KI-Vorschlag \(\d+%\)$/);
    const confidence = (await h.raw('GET', '/accounting/transactions')).body.find((tx: any) => tx.counterparty === 'Unbekannter Neuer').suggestionConfidence;
    assert.ok(confidence >= 0.6 && confidence <= 1, `confidence ${confidence}`);
    await importCsv(h, bank, [
      { date: '2026-04-02', amount: -41, counterparty: 'Neuer Mobilfunk', purpose: 'Telefon Mobilfunk Tarif' },
      { date: '2026-04-02', amount: -900, counterparty: 'Ferienhaus Sylt', purpose: 'Miete Ferienwohnung Strandkorb' },
    ]);
    const phone = await suggestion('Neuer Mobilfunk');
    assert.deepEqual([phone.suggestionLayer, phone.suggestedAccountNumber], ['bayes', '4920']);
    const unrelated = await suggestion('Ferienhaus Sylt');
    assert.notEqual(unrelated.suggestionLayer, 'bayes', 'words the model has never seen are not guessed');
    assert.equal(unrelated.suggestionLayer, 'fallback');
  });

  test('a remembered counterparty beats the model and the newest booking is the one remembered', async () => {
    assert.equal((await suggestion('Unbekannter Neuer')).suggestionLayer, 'bayes');
    await book(await suggestion('Unbekannter Neuer'), '4900');
    await importCsv(h, bank, [{ date: '2026-04-03', amount: -12, counterparty: 'Unbekannter Neuer', purpose: 'Zweite Bestellung' }]);
    const second = await suggestion('Unbekannter Neuer', 'Zweite Bestellung');
    assert.deepEqual([second.suggestionLayer, second.suggestedAccountNumber], ['counterparty', '4900'], 'memory outranks the model (which says 4930)');
    await book(second, '4940');
    await importCsv(h, bank, [{ date: '2026-04-04', amount: -13, counterparty: 'Unbekannter Neuer', purpose: 'Dritte Bestellung' }]);
    const third = await suggestion('Unbekannter Neuer', 'Dritte Bestellung');
    assert.deepEqual([third.suggestionLayer, third.suggestedAccountNumber], ['counterparty', '4940'], 'the newest booking wins');
  });

  test('an explicit rule beats memory and model, and rule matching ignores case, umlauts and ß', async () => {
    const rule = await addRule({ value: 'UNBEKANNTER neuer', operator: 'equals', targetAccountNumber: '4920' });
    assert.equal(rule.status, 200, rule.text);
    const ruled = await suggestion('Unbekannter Neuer', 'Dritte Bestellung');
    assert.deepEqual([ruled.suggestionLayer, ruled.suggestedAccountNumber], ['rule', '4920']);
    await importCsv(h, bank, [{ date: '2026-04-05', amount: -44, counterparty: 'Müller & Söhne Straße', purpose: 'Reparatur' }]);
    assert.notEqual((await suggestion('Müller & Söhne Straße')).suggestionLayer, 'rule');
    assert.equal((await addRule({ value: 'mueller & soehne strasse', operator: 'equals', targetAccountNumber: '4950' })).status, 200);
    const folded = await suggestion('Müller & Söhne Straße');
    assert.deepEqual([folded.suggestionLayer, folded.suggestedAccountNumber], ['rule', '4950'], 'ue/ü, oe/ö and ss/ß are the same spelling');
  });

  test('a suggested draft takes over the tax case the partner always had, so posting splits the Vorsteuer; a mixed history stays open', async () => {
    const bookWithTax = async (tx: BankTx, taxCaseKey?: string) => {
      const d = await getDraft(h, tx.id);
      await approveDraft(h, d, [{ ...d.lines[0]!, accountNumber: '4930', ...(taxCaseKey ? { taxCaseKey } : { taxCaseKey: undefined }) }, d.lines[1]!], { postingDate: tx.date });
      assert.equal((await postDraft(h, d.id, { postingDate: tx.date })).status, 200);
    };
    await importCsv(h, bank, [
      { date: '2026-05-04', amount: -119, counterparty: 'Steuerhaus Buero', purpose: 'Bestellung 1' },
      { date: '2026-05-04', amount: -119, counterparty: 'Gemischt Handel', purpose: 'Bestellung A' },
      { date: '2026-05-05', amount: -50, counterparty: 'Gemischt Handel', purpose: 'Bestellung B' },
    ]);
    await bookWithTax(await suggestion('Steuerhaus Buero'), 'DE_STD_19');
    await bookWithTax(await suggestion('Gemischt Handel', 'Bestellung A'), 'DE_STD_19');
    await bookWithTax(await suggestion('Gemischt Handel', 'Bestellung B'));
    await importCsv(h, bank, [
      { date: '2026-05-06', amount: -238, counterparty: 'Steuerhaus Buero', purpose: 'Bestellung 2' },
      { date: '2026-05-06', amount: -60, counterparty: 'Gemischt Handel', purpose: 'Bestellung C' },
    ]);
    const known = await getDraft(h, (await suggestion('Steuerhaus Buero', 'Bestellung 2')).id);
    const expense = known.lines.find((line) => line.accountNumber === '4930')!;
    assert.equal(expense.taxCaseKey, 'DE_STD_19', 'the one tax case of this partner on 4930 is suggested with the account');
    const mixed = await getDraft(h, (await suggestion('Gemischt Handel', 'Bestellung C')).id);
    assert.equal(mixed.lines.find((line) => line.accountNumber === '4930')?.taxCaseKey, undefined, 'with and without tax before: no guess');
    await approveDraft(h, known, known.lines, { postingDate: '2026-05-06' });
    const posted = await postDraft(h, known.id, { postingDate: '2026-05-06' });
    assert.equal(posted.status, 200, posted.text);
    const lines = (posted.body.entry.lines as Array<{ accountNumber: string; debitAmount: number; creditAmount: number }>).map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]);
    assert.deepEqual(lines.sort(), [['1200', 0, 238], ['1576', 38, 0], ['4930', 200, 0]].sort(), 'net and Vorsteuer, not 238 gross on 4930');
  });

  test('the posted bookings stay balanced and the audit chain verifies', async () => {
    const journal = (await h.raw('GET', '/accounting/journal?limit=5000')).body as Array<{ lines: Array<{ debitAmount: number; creditAmount: number }> }>;
    assert.ok(journal.length >= 22);
    for (const entry of journal) assert.equal(Math.round(entry.lines.reduce((sum, line) => sum + line.debitAmount - line.creditAmount, 0) * 100), 0);
    assert.equal((await h.api.audit.verify()).ok, true);
  });
});
