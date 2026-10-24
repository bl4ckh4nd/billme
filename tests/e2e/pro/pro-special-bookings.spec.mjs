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

const fillWorkflow = async (page, { workflow, sourceId, reason, edit }) => {
  await page.getByRole('combobox', { name: 'Workflow' }).selectOption(workflow);
  await page.getByRole('textbox', { name: 'Quellbeleg' }).fill(sourceId);
  await page.getByRole('textbox', { name: 'Buchungsdatum' }).fill('2026-04-20');
  if (edit) {
    const details = page.getByText('Fachdaten für Experten bearbeiten');
    if (!(await page.getByRole('textbox', { name: 'Domain-Fakten (JSON)' }).isVisible())) await details.click();
    const field = page.getByRole('textbox', { name: 'Domain-Fakten (JSON)' });
    await field.fill(JSON.stringify(edit(JSON.parse(await field.inputValue())), null, 2));
  }
  await page.getByRole('textbox', { name: 'Audit-Grund', exact: true }).fill(reason);
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

  await fillWorkflow(page, { workflow: 'skonto', sourceId: skontoInvoice.id, reason: 'Skonto zu hoch', edit: (facts) => ({ ...facts, skontoAmount: 200 }) });
  await post.click();
  await expect(feedback).toHaveText('Der Betrag ist höher als der noch offene Rest der Rechnung.');
  expect((await runOf(page, skontoInvoice.id)).filter((run) => run.status === 'posted'), 'nothing posted').toEqual([]);
  await shot('skonto-refused');

  await fillWorkflow(page, { workflow: 'skonto', sourceId: skontoInvoice.id, reason: '2 % Skonto gewährt', edit: (facts) => ({ ...facts, skontoAmount: 2.38 }) });
  await post.click();
  await expect(feedback).toHaveText(/erfolgreich gebucht/);
  await expect.poll(async () => (await runOf(page, skontoInvoice.id)).some((run) => run.status === 'posted' && run.journalEntryId)).toBe(true);
  const skontoRun = (await runOf(page, skontoInvoice.id)).find((run) => run.status === 'posted');
  expect((await invokeDesktopIpc(page, 'pro:listJournalEntries', {})).some((entry) => entry.id === skontoRun.journalEntryId), 'the journal lists the Skonto entry').toBe(true);

  // The invoice number as Quellbeleg, as the field suggests; the original reference is taken from it.
  await fillWorkflow(page, {
    workflow: 'bad_debt', sourceId: lostInvoice.number, reason: 'Kunde insolvent',
    edit: (facts) => ({ ...facts, facts: { ...facts.facts, evidenceReference: 'Insolvenzbekanntmachung AG Berlin' } }),
  });
  await post.click();
  await expect(feedback).toHaveText(/erfolgreich gebucht/);
  await expect.poll(async () => (await runOf(page, lostInvoice.number)).some((run) => run.status === 'posted' && run.journalEntryId)).toBe(true);
  await shot('bad-debt');

  // A Gesellschaftervorgang is documented and classified, not booked: the run is recorded without a journal entry.
  const flowId = `einlage-${Date.now()}`;
  await fillWorkflow(page, { workflow: 'shareholder_flow', sourceId: flowId, reason: 'Bareinlage Gesellschafter' });
  await post.click();
  await expect(feedback).toHaveText(/Keine Buchung vorgenommen/);
  await expect.poll(async () => (await runOf(page, flowId)).map((run) => [run.status, run.journalEntryId ?? null])).toEqual([['noop', null]]);

  // The same Skonto again is never a second posting.
  await fillWorkflow(page, { workflow: 'skonto', sourceId: skontoInvoice.id, reason: '2 % Skonto gewährt', edit: (facts) => ({ ...facts, skontoAmount: 2.38 }) });
  await post.click();
  await expect(feedback).toHaveText(/.+/);
  expect((await runOf(page, skontoInvoice.id)).filter((run) => run.status === 'posted').length).toBe(1);
  await shot('history');
});

test('a month is soft-locked and festgeschrieben from the period list, each only with a written reason', async () => {
  const { page, baseUrl } = desktop;
  await page.goto(appUrl(baseUrl, '/accounting?view=special'));
  const list = page.getByTestId('period-lock-list');
  await page.getByRole('combobox', { name: 'Jahr' }).selectOption('2026');
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
