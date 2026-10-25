import { expect, test } from '@playwright/test';
import { appUrl, getDesktopSettings, invokeDesktopIpc, launchDesktopApp, PRO_DOUBLE_ENTRY_SETTINGS, seedDesktopData, setDesktopSettings } from '../support.mjs';

/**
 * Sonderbuchungen of the Pro workspace that had no browser coverage: Skonto,
 * Forderungsausfall and a Gesellschafter-Einlage, each verified through its source run.
 *
 * How this can fail:
 * - a Skonto larger than the invoice booked, or a refusal shown as success
 * - a posting without journal entry, or the same source posted twice
 * - a bad-debt write-off without its original document reference, or the Quellbeleg
 *   (id or invoice number) not taken as the original; a server code shown instead of text
 * - periods: a lock or Festschreibung confirmed without a written reason, a festgeschriebener
 *   month that still offers an action, a list that disagrees with the server after the change
 * - free entry (Buchungssatz): posted without Belegnummer or unbalanced, the Privat preset on
 *   the wrong accounts or offered to a GmbH, a journal entry without account names or without a
 *   Storno (or one without reason), a posted entry that the journal does not list, the bank/ledger
 *   reconciliation missing from the Abgleich
 * - Skonto / Forderungsausfall only through expert JSON with sample values, the VAT split
 *   typed in by hand, the workflow jumping back to "Korrektur" after a posting
 * - Jahresabschluss: only through JSON with sample balances, a preview that differs from
 *   the booking, a close booked without confirmation, Erfolgskonten that open the next year
 *   with last year's balance
 */

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedDesktopData(desktop.page, { app: 'pro', settingsOverrides: PRO_DOUBLE_ENTRY_SETTINGS });
  const settings = await getDesktopSettings(desktop.page);
  await setDesktopSettings(desktop.page, { ...settings, legal: { ...settings.legal, smallBusinessRule: false, defaultVatRate: 19 } });
  await desktop.page.reload();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

/** 100 € net at 19 %, issued (and so posted) the way the app does it. */
const issueInvoice = async (page, client) => {
  const reservation = await invokeDesktopIpc(page, 'numbers:reserve', { kind: 'invoice' });
  const draft = {
    id: `inv-special-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, number: reservation.number, numberReservationId: reservation.reservationId,
    clientId: 'c1', client, clientEmail: 'kunde@example.com', clientAddress: 'Weg 1\n10115 Berlin', date: '2026-04-01', dueDate: '2026-04-15', amount: 119,
    status: 'draft', items: [{ kind: 'item', description: 'Leistung', quantity: 1, price: 100, total: 100, taxRate: 19 }], payments: [], history: [], taxMode: 'standard_vat',
  };
  await invokeDesktopIpc(page, 'invoices:upsert', { reason: 'E2E', invoice: draft });
  return invokeDesktopIpc(page, 'invoices:upsert', { reason: 'E2E gestellt', invoice: { ...draft, status: 'open' } });
};

const fillWorkflow = async (page, { workflow, sourceId, reason, edit, amount, evidence }) => {
  await page.getByRole('combobox', { name: 'Workflow' }).selectOption(workflow);
  await page.getByRole('textbox', { name: 'Quellbeleg' }).fill(sourceId);
  await page.getByRole('textbox', { name: 'Buchungsdatum' }).fill('2026-04-20');
  if (amount !== undefined) await page.getByRole('textbox', { name: 'Betrag (brutto)' }).fill(amount);
  if (evidence !== undefined) await page.getByRole('textbox', { name: 'Nachweis des Ausfalls' }).fill(evidence);
  if (edit) {
    const details = page.getByText('Fachdaten für Experten bearbeiten');
    if (!(await page.getByRole('textbox', { name: 'Domain-Fakten (JSON)' }).isVisible())) await details.click();
    const field = page.getByRole('textbox', { name: 'Domain-Fakten (JSON)' });
    await field.fill(JSON.stringify(edit(JSON.parse(await field.inputValue())), null, 2));
  }
  await page.getByRole('textbox', { name: 'Audit-Grund', exact: true }).fill(reason);
};

// The posting asks once with a summary (B10); the booking only runs after "Verbindlich buchen".
const confirmPost = async (page) => {
  const dialog = page.getByRole('dialog').filter({ has: page.getByTestId('special-entry-confirm-summary') });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Verbindlich buchen' }).click();
  await expect(dialog).toHaveCount(0);
};
const runOf = async (page, sourceId) => (await invokeDesktopIpc(page, 'pro:listAccountingSourceRuns', {})).filter((run) => run.sourceId === sourceId);

test('a Skonto above the invoice is refused; a valid Skonto and a bad-debt write-off are posted once, an Einlage is documented without a posting', async () => {
  const { page, baseUrl } = desktop;
  const shot = (name) => page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
  const skontoInvoice = await issueInvoice(page, 'Skonto Kunde');
  const lostInvoice = await issueInvoice(page, 'Insolvenz Kunde');
  await page.goto(appUrl(baseUrl, '/accounting?view=special'));
  await expect(page.getByTestId('sonderbuchungen-workspace')).toBeVisible();
  const post = page.getByRole('button', { name: 'Prüfen & verbindlich buchen' });
  const feedback = page.getByTestId('sonderbuchungen-feedback');

  // The mask: invoice number and the gross Skonto, no JSON; the VAT split comes from the invoice.
  await fillWorkflow(page, { workflow: 'skonto', sourceId: skontoInvoice.number, reason: 'Skonto zu hoch', amount: '200,00' });
  await expect(page.getByRole('textbox', { name: 'Domain-Fakten (JSON)' }), 'no expert JSON for a Skonto').toHaveCount(0);
  await post.click();
  await confirmPost(page);
  await expect(feedback).toHaveText('Der Betrag ist höher als der noch offene Rest der Rechnung.');
  expect((await runOf(page, skontoInvoice.number)).filter((run) => run.status === 'posted'), 'nothing posted').toEqual([]);
  await shot('skonto-refused');

  await fillWorkflow(page, { workflow: 'skonto', sourceId: skontoInvoice.number, reason: '2 % Skonto gewährt', amount: '2,38' });
  await post.click();
  // B10: one question with the summary first; cancelling books nothing.
  const summary = page.getByTestId('special-entry-confirm-summary');
  await expect(summary).toContainText(skontoInvoice.number);
  await expect(summary).toContainText('2,38 €');
  await expect(summary).toContainText('2 % Skonto gewährt');
  await shot('skonto-confirm');
  await page.getByRole('dialog').getByRole('button', { name: 'Abbrechen' }).click();
  expect((await runOf(page, skontoInvoice.number)).filter((run) => run.status === 'posted'), 'cancel books nothing').toEqual([]);
  await post.click();
  await confirmPost(page);
  await expect(feedback).toHaveText(/erfolgreich gebucht/);
  await expect(page.getByRole('combobox', { name: 'Workflow' }), 'the workflow stays on Skonto').toHaveValue('skonto');
  await expect.poll(async () => (await runOf(page, skontoInvoice.number)).some((run) => run.status === 'posted' && run.journalEntryId)).toBe(true);
  const skontoRun = (await runOf(page, skontoInvoice.number)).find((run) => run.status === 'posted');
  const skontoEntry = (await invokeDesktopIpc(page, 'pro:listJournalEntries', {})).find((entry) => entry.id === skontoRun.journalEntryId);
  expect(skontoEntry, 'the journal lists the Skonto entry').toBeTruthy();
  expect(skontoEntry.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]), 'net, VAT and receivable from the invoice split').toEqual([['8736', 2, 0], ['1776', 0.38, 0], ['1400', 0, 2.38]]);

  // The invoice number as Quellbeleg, as the field suggests; the original reference is taken from it.
  await fillWorkflow(page, { workflow: 'bad_debt', sourceId: lostInvoice.number, reason: 'Kunde insolvent', amount: '119,00', evidence: 'Insolvenzbekanntmachung AG Berlin' });
  await post.click();
  await confirmPost(page);
  await expect(feedback).toHaveText(/erfolgreich gebucht/);
  await expect.poll(async () => (await runOf(page, lostInvoice.number)).some((run) => run.status === 'posted' && run.journalEntryId)).toBe(true);
  await shot('bad-debt');

  // A Gesellschaftervorgang is documented and classified, not booked: the run is recorded without a journal entry.
  const flowId = `einlage-${Date.now()}`;
  await fillWorkflow(page, { workflow: 'shareholder_flow', sourceId: flowId, reason: 'Bareinlage Gesellschafter' });
  await post.click();
  await confirmPost(page);
  await expect(feedback).toHaveText(/Keine Buchung vorgenommen/);
  await expect.poll(async () => (await runOf(page, flowId)).map((run) => [run.status, run.journalEntryId ?? null])).toEqual([['noop', null]]);

  // The same Skonto again is never a second posting.
  await fillWorkflow(page, { workflow: 'skonto', sourceId: skontoInvoice.number, reason: '2 % Skonto gewährt', amount: '2,38' });
  await post.click();
  await confirmPost(page);
  await expect(feedback).toHaveText(/.+/);
  expect((await runOf(page, skontoInvoice.number)).filter((run) => run.status === 'posted').length).toBe(1);
  await shot('history');
});

test('the Jahresabschluss: pick the year, see the closing and opening entries, confirm; the next year opens Erfolgskonten at 0', async () => {
  const { page, baseUrl } = desktop;
  const book = (reference, date, lines) => invokeDesktopIpc(page, 'pro:postManualJournalEntry', { reason: 'E2E Vorjahr', documentDate: date, postingDate: date, reference, bookingText: reference, idempotencyKey: `${reference}-${Date.now()}`, lines: lines.map(([accountNumber, debitAmount, creditAmount]) => ({ accountNumber, debitAmount, creditAmount })) });
  await book('AR-2025-1', '2025-06-10', [['1200', 1190, 0], ['8400', 0, 1000], ['1776', 0, 190]]);
  await book('BU-2025-1', '2025-07-01', [['4930', 100, 0], ['1200', 0, 100]]);
  await page.goto(appUrl(baseUrl, '/accounting?view=special'));
  const panel = page.locator('section', { has: page.getByRole('heading', { name: 'Jahresabschluss und Saldovortrag' }) });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('combobox', { name: 'Geschäftsjahr' })).toHaveValue('2025');
  await expect(panel.getByRole('textbox', { name: 'Ergebniskonto' }), 'a GmbH closes into the Gewinnvortrag').toHaveValue('0860');
  await panel.getByRole('button', { name: 'Vorschau berechnen' }).click();
  const preview = panel.getByTestId('fiscal-close-preview');
  await expect(preview).toContainText('Abschlussbuchung zum 31.12.2025');
  await expect(preview).toContainText('Saldovortrag zum 01.01.2026');
  await expect(panel.getByTestId('fiscal-close-result')).toContainText('Gewinn');
  await expect(panel.getByTestId('fiscal-close-result')).toContainText('900,00');
  const journalBefore = (await invokeDesktopIpc(page, 'pro:listJournalEntries', {})).length;
  expect(journalBefore, 'the preview books nothing').toBeGreaterThan(0);
  await expect(panel.getByRole('button', { name: 'Abschluss buchen' }), 'no booking without a reason').toBeDisabled();
  await panel.getByRole('textbox', { name: 'Audit-Grund Jahresabschluss' }).fill('Jahresabschluss 2025 erstellt');
  await panel.getByRole('button', { name: 'Abschluss buchen' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('vorläufig gesperrt');
  await page.screenshot({ path: test.info().outputPath('fiscal-close-preview.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Abschluss buchen' }).click();
  await expect(panel.getByRole('status').filter({ hasText: 'abgeschlossen' })).toBeVisible();

  const runs = await invokeDesktopIpc(page, 'pro:listAccountingSourceRuns', {});
  const closeRun = runs.find((run) => run.sourceId === 'JA-2025' && run.status === 'posted');
  const carryRun = runs.find((run) => run.sourceId === 'EB-2026' && run.status === 'posted');
  expect(closeRun && carryRun, 'close and carry-forward are booked').toBeTruthy();
  const closeEntry = await invokeDesktopIpc(page, 'pro:getJournalEntryById', { entryId: closeRun.journalEntryId });
  expect(closeEntry.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount])).toEqual([['8400', 1000, 0], ['4930', 0, 100], ['0860', 0, 900]]);
  const susa = await invokeDesktopIpc(page, 'pro:getSusaReport', { from: '2026-01-01', to: '2026-12-31' });
  const opening = (account) => susa.rows.find((row) => row.accountNumber === account)?.openingBalance ?? 0;
  expect([opening('8400'), opening('4930'), opening('0860'), opening('1200')], 'Erfolgskonten start 2026 at 0, the result opens on 0860').toEqual([0, 0, -900, 1090]);
  await page.screenshot({ path: test.info().outputPath('fiscal-close-booked.png'), fullPage: true });
});

test('a month is soft-locked and festgeschrieben from the period list, each only with a written reason', async () => {
  const { page, baseUrl } = desktop;
  await page.goto(appUrl(baseUrl, '/accounting?view=special'));
  const list = page.getByTestId('period-lock-list');
  await page.getByRole('combobox', { name: 'Jahr', exact: true }).selectOption('2026');
  const month = (period) => list.locator(`li[data-period="${period}"]`);
  await expect(month('2026-01')).toContainText('Offen');

  await month('2026-01').getByRole('button', { name: 'Sperren' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Sperren' }), 'no lock without a reason').toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Begründung (Pflicht)' }).fill('UStVA Januar abgegeben');
  await dialog.getByRole('button', { name: 'Sperren' }).click();
  await expect(month('2026-01')).toContainText('Vorläufig gesperrt');

  await month('2026-02').getByRole('button', { name: 'Festschreiben' }).click();
  await expect(dialog).toContainText('alle Monate davor');
  await dialog.getByRole('textbox', { name: 'Begründung (Pflicht)' }).fill('Februar abgeschlossen');
  await dialog.getByRole('button', { name: 'Endgültig festschreiben' }).click();
  for (const period of ['2026-01', '2026-02']) {
    await expect(month(period)).toContainText('Festgeschrieben');
    await expect(month(period).getByRole('button'), 'a festgeschriebener month offers no action').toHaveCount(0);
  }
  await expect(month('2026-03')).toContainText('Offen');
  await page.screenshot({ path: test.info().outputPath('periods-festgeschrieben.png'), fullPage: true });
});

test('a Privatentnahme is booked as a free entry with its Beleg, reversed from the journal, and the Abgleich shows bank against ledger', async () => {
  const { page, baseUrl } = desktop;
  await page.goto(appUrl(baseUrl, '/accounting?view=special'));
  const panel = page.getByTestId('manual-entry-panel');
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Privatentnahme bar' }), 'a GmbH has no Privatkonten').toHaveCount(0);

  // A sole proprietor with double entry books Privatentnahmen.
  const settings = await getDesktopSettings(page);
  await setDesktopSettings(page, { ...settings, businessReportingProfile: { ...settings.businessReportingProfile, legalForm: 'sole_proprietor', profitDetermination: 'double_entry' } });
  await page.reload();
  await expect(panel).toBeVisible();
  const post = panel.getByRole('button', { name: 'Verbindlich buchen' });

  await panel.getByRole('button', { name: 'Privatentnahme bar' }).click();
  await expect(panel.getByRole('textbox', { name: 'Buchungstext' })).toHaveValue('Privatentnahme');
  await panel.getByRole('textbox', { name: 'Belegdatum' }).fill('2026-04-20');
  await panel.getByRole('textbox', { name: 'Betrag Zeile 1' }).fill('50,00');
  await panel.getByRole('textbox', { name: 'Betrag Zeile 2' }).fill('49,00');
  await panel.getByRole('textbox', { name: 'Begründung' }).fill('Barentnahme laut Kassenbeleg');
  await expect(post, 'no posting without Belegnummer and balance').toBeDisabled();
  await expect(panel.getByTestId('manual-entry-problems')).toContainText('Belegnummer fehlt');
  await expect(panel.getByTestId('manual-entry-problems')).toContainText('Soll und Haben unterscheiden sich');
  await panel.getByRole('textbox', { name: 'Belegnummer' }).fill('KB-2026-0420');
  await panel.getByRole('textbox', { name: 'Betrag Zeile 2' }).fill('50,00');
  await expect(post).toBeEnabled();
  await post.click();
  await expect(panel.getByTestId('manual-entry-feedback')).toHaveText(/Buchung Nr\. \d+ gebucht\./);

  // The journal entry opens with account names and a Storno that asks for a reason.
  await panel.getByRole('button', { name: 'Buchung ansehen' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Konto 1800')).toBeVisible();
  await expect(dialog.getByLabel('Buchungszeilen')).toContainText(/Privat/);
  await expect(dialog).toContainText('KB-2026-0420');
  await dialog.getByRole('button', { name: 'Buchung stornieren' }).click();
  const storno = dialog.getByRole('button', { name: 'Storno buchen' });
  await expect(storno, 'no Storno without a reason').toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Grund für das Storno' }).fill('Doppelt erfasst');
  await storno.click();
  await expect(dialog.getByText('Storniert', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Buchung stornieren' })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('journal-storno.png'), fullPage: true });
  await dialog.getByRole('button', { name: 'Journalansicht schließen' }).click();

  const entries = await invokeDesktopIpc(page, 'pro:listJournalEntries', {});
  const entry = entries.find((candidate) => candidate.reference === 'KB-2026-0420' && candidate.sourceType === 'manual');
  expect(entry, 'the journal lists the free entry').toBeTruthy();
  expect([entry.sourceType, entry.postingDate, entry.bookingText, entry.status]).toEqual(['manual', '2026-04-20', 'Privatentnahme', 'reversed']);
  const reversal = entries.find((candidate) => candidate.id === entry.reversedEntryId);
  expect(reversal.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]), 'the Storno books the lines back').toEqual([['1800', 0, 50], ['1000', 50, 0]]);
  expect(entry.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount])).toEqual([['1800', 50, 0], ['1000', 0, 50]]);
  await page.screenshot({ path: test.info().outputPath('free-entry-privatentnahme.png'), fullPage: true });

  await page.goto(appUrl(baseUrl, '/accounting?view=reconciliation'));
  await expect(page.getByTestId('bank-ledger-reconciliation')).toBeVisible();
  await expect(page.getByTestId('bank-ledger-reconciliation')).toContainText('Abstimmung Bank und Hauptbuch');
  await page.screenshot({ path: test.info().outputPath('bank-ledger-reconciliation.png'), fullPage: true });
});
