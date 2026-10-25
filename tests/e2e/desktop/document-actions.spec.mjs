import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';
import { createShooter, readEditorTotals } from './lite-support.mjs';

/**
 * Document list and detail actions of the Lite UI, verified through the backend.
 *
 * How this can fail:
 * - list: the status filter or the search showing documents that do not match
 * - delete: a draft deleted without a reason, an issued invoice deletable, the
 *   deleted draft still listed
 * - corrections: a credit note or Stornorechnung created with the wrong amount or
 *   not linked to its source, the cancelled source still shown (and dunned) as open,
 *   no trace in the history, a refusal shown as an English technical error
 * - editor: removing a position not changing the totals, "discard" saving anyway
 * - list: "Offen" listing order confirmations or delivery notes, no period filter,
 *   invoice chips (Bezahlt/Überfällig) on the offer tab
 * - detail: a credit note shown as a positive payment request; the source not
 *   showing what is left after the credit; a delivery note with prices; the chain
 *   of an invoice from an offer without the offer
 * - issuing: one icon click issues a draft without asking; an issued invoice opening
 *   the editor only to fail with 409 on save; browser back leaving the editor and
 *   dropping unsaved changes without asking
 * - payments: a partial payment shown as "Noch nicht bezahlt", an overpayment taken or
 *   refused without a reason, raw audit keys (invoice.payment.create) in the history
 */

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp();
  await seedDesktopData(desktop.page);
  await desktop.page.reload();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

const invoices = (page) => invokeDesktopIpc(page, 'invoices:list', {});
/** The seed issues through the numbering sequence, so the numbers come from the backend. */
const numberOf = async (page, id) => (await invoices(page)).find((invoice) => invoice.id === id).number;

/** A draft the way the app creates one: reserved number, then saved as draft. */
const createDraft = async (page, client, items) => {
  const reservation = await invokeDesktopIpc(page, 'numbers:reserve', { kind: 'invoice' });
  const draft = {
    id: `draft-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, number: reservation.number, numberReservationId: reservation.reservationId,
    clientId: 'c1', client, clientEmail: 'entwurf@example.com', clientAddress: 'Weg 1\n10115 Berlin', date: '2026-04-01', dueDate: '2026-04-15',
    amount: items.reduce((sum, item) => sum + item.total, 0), status: 'draft', items, payments: [], history: [], taxMode: 'small_business_19_ustg',
  };
  return invokeDesktopIpc(page, 'invoices:upsert', { reason: 'E2E Entwurf', invoice: draft });
};

test('the status filter and the search narrow the list; a draft is deleted with a reason, an issued invoice cannot be', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const draft = await createDraft(page, 'Entwurf Löschkandidat', [{ kind: 'item', description: 'Test', quantity: 1, price: 10, total: 10 }]);
  const open = await numberOf(page, 'inv-open-1');
  const paid = await numberOf(page, 'inv-paid-1');
  await page.reload();
  await page.goto(appUrl(baseUrl, '/documents'));
  const status = page.getByRole('radiogroup', { name: 'Status' });
  await status.getByRole('radio', { name: 'Entwurf' }).click();
  await expect(page.getByRole('row', { name: `Rechnung ${draft.number} öffnen` })).toBeVisible();
  await expect(page.getByRole('row', { name: `Rechnung ${open} öffnen` })).toHaveCount(0);
  await status.getByRole('radio', { name: 'Bezahlt' }).click();
  await expect(page.getByRole('row', { name: `Rechnung ${paid} öffnen` })).toBeVisible();
  await expect(page.getByRole('row', { name: `Rechnung ${draft.number} öffnen` })).toHaveCount(0);
  await status.getByRole('radio', { name: 'Alle' }).click();
  await page.getByLabel('Rechnungen und Angebote durchsuchen').fill('Löschkandidat');
  await expect(page.getByRole('row', { name: `Rechnung ${draft.number} öffnen` })).toBeVisible();
  await expect(page.getByRole('row', { name: `Rechnung ${paid} öffnen` })).toHaveCount(0);
  await shot('search');

  await page.getByRole('checkbox', { name: `${draft.number} auswählen` }).check();
  await page.getByRole('button', { name: 'Löschen' }).first().click();
  const confirm = page.getByRole('dialog', { name: 'Löschen bestätigen' });
  await expect(confirm.getByRole('button', { name: 'Löschen', exact: true })).toBeDisabled();
  await confirm.getByLabel('Grund (Pflicht)').fill('Testdaten');
  await confirm.getByRole('button', { name: 'Löschen', exact: true }).click();
  await expect.poll(async () => (await invoices(page)).some((invoice) => invoice.id === draft.id)).toBe(false);
  await expect(page.getByRole('row', { name: `Rechnung ${draft.number} öffnen` })).toHaveCount(0);

  // The backend refuses deleting an issued invoice, whatever the UI offers.
  await expect(invokeDesktopIpc(page, 'invoices:delete', { id: 'inv-open-1', reason: 'versehentlich' })).rejects.toThrow();
  expect((await invoices(page)).some((invoice) => invoice.id === 'inv-open-1')).toBe(true);
});

test('a partial credit note is created from the detail page, a Storno after it is refused, and a Stornorechnung cancels an untouched invoice', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const number = await numberOf(page, 'inv-open-1');
  await page.goto(appUrl(baseUrl, '/documents'));
  await page.getByRole('row', { name: `Rechnung ${number} öffnen` }).click();
  await expect(page.getByRole('heading', { name: number })).toBeVisible();

  await page.getByRole('button', { name: 'Gutschrift', exact: true }).click();
  const amount = page.getByRole('dialog', { name: 'Gutschrift erstellen' });
  await expect(amount.getByLabel('Betrag (EUR)')).toHaveValue('3450.50');
  await amount.getByLabel('Betrag (EUR)').fill('450.50');
  await amount.getByRole('button', { name: 'Gutschrift erstellen' }).click();
  await expect.poll(async () => (await invoices(page)).filter((invoice) => invoice.documentKind === 'credit_note' && invoice.sourceDocumentId === 'inv-open-1').map((invoice) => [invoice.amount, invoice.status]))
    .toEqual([[450.5, 'open']]);
  expect((await invoices(page)).find((invoice) => invoice.id === 'inv-open-1').status, 'a partial credit leaves the source open').toBe('open');
  await shot('credit-note');

  // A Stornorechnung cannot follow a credit note: the button is gone and the backend refuses it, nothing is created.
  await page.getByRole('button', { name: 'Zurück zur Liste' }).click();
  await page.getByRole('row', { name: `Rechnung ${number} öffnen` }).click();
  await expect(page.getByRole('button', { name: 'Gutschrift', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Storno', exact: true }), 'no Storno is offered after a credit note').toHaveCount(0);
  const refused = await invokeDesktopIpc(page, 'documents:chainIssue', { operation: 'correction', kind: 'cancellation_invoice', invoiceId: 'inv-open-1', id: crypto.randomUUID(), date: '2026-02-10', reason: 'E2E' })
    .then(() => null, (error) => String(error));
  expect(refused, 'the backend refuses a Storno after a credit note').toMatch(/Stornorechnung ist nicht mehr möglich|Gutschrift oder Stornorechnung/);
  await shot('storno-refused');
  expect((await invoices(page)).some((invoice) => invoice.documentKind === 'cancellation_invoice')).toBe(false);

  // A Stornorechnung of an untouched invoice cancels it.
  const target = await createDraft(page, 'Storno Kunde', [{ kind: 'item', description: 'Leistung', quantity: 1, price: 300, total: 300 }]);
  await invokeDesktopIpc(page, 'invoices:upsert', { reason: 'gestellt', invoice: { ...target, status: 'open' } });
  const targetNumber = await numberOf(page, target.id);
  await page.reload();
  await page.goto(appUrl(baseUrl, '/documents'));
  await page.getByRole('row', { name: `Rechnung ${targetNumber} öffnen` }).click();
  await page.getByRole('button', { name: 'Storno', exact: true }).click();
  await page.getByRole('dialog', { name: /Storno.* erstellen/ }).getByRole('button', { name: /Storno.* erstellen/ }).click();
  await expect.poll(async () => (await invoices(page)).find((invoice) => invoice.id === target.id).status).toBe('cancelled');
  const cancellation = (await invoices(page)).find((invoice) => invoice.documentKind === 'cancellation_invoice' && invoice.sourceDocumentId === target.id);
  expect(cancellation, 'the Stornorechnung is linked to its source').toBeTruthy();

  await page.getByRole('button', { name: 'Zurück zur Liste' }).click();
  await page.getByRole('row', { name: `Rechnung ${targetNumber} öffnen` }).click();
  await expect(page.getByText('Storniert').first()).toBeVisible();
  const history = page.getByRole('region', { name: /Verlauf|Berlauf/ }).or(page.getByText('Verlauf').locator('..'));
  await expect(history.first()).toBeVisible();
  await shot('cancelled-source');
  await page.getByRole('button', { name: 'Zurück zur Liste' }).click();
  await page.getByRole('radiogroup', { name: 'Status' }).getByRole('radio', { name: 'Offen' }).click();
  await expect(page.getByRole('row', { name: `Rechnung ${targetNumber} öffnen` }), 'a cancelled invoice is not listed as open').toHaveCount(0);
});

test('removing a position changes the totals, and "Änderungen verwerfen" leaves the stored draft untouched', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const draft = await createDraft(page, 'Editor Verwerfen', [
    { kind: 'item', description: 'Erste Position', quantity: 1, price: 100, total: 100 },
    { kind: 'item', description: 'Zweite Position', quantity: 1, price: 50, total: 50 },
  ]);
  await page.reload();
  await page.goto(appUrl(baseUrl, '/documents'));
  await page.getByRole('button', { name: `${draft.number} bearbeiten` }).click();
  await expect(page.getByTestId('document-editor')).toBeVisible();
  const before = JSON.stringify(await readEditorTotals(page));
  // The row tools appear on hover or keyboard focus of their line.
  await page.getByRole('button', { name: 'Zeile 2 löschen' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(async () => JSON.stringify(await readEditorTotals(page))).not.toBe(before);
  await shot('position-removed');

  await page.getByRole('button', { name: 'Zurück' }).click();
  const discard = page.getByRole('dialog', { name: 'Ungespeicherte Änderungen verwerfen?' });
  await discard.getByRole('button', { name: 'Weiter bearbeiten' }).click();
  await expect(page.getByTestId('document-editor'), 'cancel keeps the editor open').toBeVisible();
  await page.getByRole('button', { name: 'Zurück' }).click();
  await discard.getByRole('button', { name: 'Änderungen verwerfen' }).click();
  await expect(page.getByTestId('document-editor')).toHaveCount(0);
  const stored = (await invoices(page)).find((invoice) => invoice.id === draft.id);
  expect(stored.items.map((item) => item.description)).toEqual(['Erste Position', 'Zweite Position']);
  expect(stored.amount).toBe(150);
});

const localToday = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

test('"Offen" lists only invoices, the period filter narrows by date, and the offer tab has offer chips', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const open = await numberOf(page, 'inv-open-1');
  const current = await createDraft(page, 'Aktueller Monat', [{ kind: 'item', description: 'Leistung', quantity: 1, price: 50, total: 50 }]);
  await invokeDesktopIpc(page, 'invoices:upsert', { reason: 'gestellt', invoice: { ...current, date: localToday(), dueDate: localToday(), status: 'open' } });
  const order = await invokeDesktopIpc(page, 'documents:chainIssue', { id: crypto.randomUUID(), operation: 'order_confirmation', offerId: 'offer-open-1', date: '2026-03-06', reason: 'E2E AB' });
  await page.reload();
  await page.goto(appUrl(baseUrl, '/documents'));
  const status = page.getByRole('radiogroup', { name: 'Status' });
  await status.getByRole('radio', { name: 'Offen' }).click();
  await expect(page.getByRole('row', { name: `Rechnung ${current.number} öffnen` })).toBeVisible();
  await expect(page.getByRole('row', { name: new RegExp(`${order.number} öffnen`) }), 'an order confirmation is no open receivable').toHaveCount(0);

  await status.getByRole('radio', { name: 'Alle' }).click();
  await expect(page.getByRole('row', { name: new RegExp(`${order.number} öffnen`) })).toBeVisible();
  await page.getByRole('combobox', { name: 'Zeitraum' }).selectOption({ label: 'Dieser Monat' });
  await expect(page.getByRole('row', { name: `Rechnung ${current.number} öffnen` })).toBeVisible();
  await expect(page.getByRole('row', { name: `Rechnung ${open} öffnen` })).toHaveCount(0);
  await shot('period-this-month');
  await page.getByRole('combobox', { name: 'Zeitraum' }).selectOption({ label: 'Gesamter Zeitraum' });

  await page.getByRole('radiogroup', { name: 'Dokumentart' }).getByRole('radio', { name: 'Angebote' }).click();
  await expect(status.getByRole('radio', { name: 'Bezahlt' })).toHaveCount(0);
  await status.getByRole('radio', { name: 'Angenommen' }).click();
  await expect(page.getByRole('row', { name: 'Angebot ANG-2026-001 öffnen' })).toBeVisible();
  await status.getByRole('radio', { name: 'Abgelehnt' }).click();
  await expect(page.getByRole('row', { name: 'Angebot ANG-2026-001 öffnen' })).toHaveCount(0);
  await shot('offer-chips');
});

test('a credit note reads as a correction, the source shows the rest, a delivery note has no prices and the chain starts at the offer', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const open = await numberOf(page, 'inv-open-1');
  const credit = await invokeDesktopIpc(page, 'documents:chainIssue', { id: crypto.randomUUID(), operation: 'correction', kind: 'credit_note', invoiceId: 'inv-open-1', amount: 450.5, date: '2026-02-10', reason: 'E2E Gutschrift' });
  const order = await invokeDesktopIpc(page, 'documents:chainIssue', { id: crypto.randomUUID(), operation: 'order_confirmation', offerId: 'offer-open-1', date: '2026-03-06', reason: 'E2E AB' });
  const delivery = await invokeDesktopIpc(page, 'documents:chainIssue', { id: crypto.randomUUID(), operation: 'delivery_note', orderId: order.id, date: '2026-03-07', reason: 'E2E LS' });
  await page.reload();
  await page.goto(appUrl(baseUrl, '/documents'));

  await page.getByRole('row', { name: `Gutschrift ${credit.number} öffnen` }).click();
  const main = page.getByRole('main');
  await expect(main).toContainText('Keine Zahlungsaufforderung');
  await expect(main).not.toContainText('Bitte überweisen');
  await expect(main).toContainText(/[-−]\s?450,50/);
  await shot('credit-note');

  await page.getByRole('button', { name: 'Zurück zur Liste' }).click();
  await page.getByRole('row', { name: `Rechnung ${open} öffnen` }).click();
  await expect(main.getByText('Gutgeschrieben')).toBeVisible();
  await expect(main).toContainText(/Noch offen\s*3\.000,00/);
  await shot('source-after-credit');

  await page.getByRole('button', { name: 'Zurück zur Liste' }).click();
  await page.getByRole('row', { name: `Lieferschein ${delivery.number} öffnen` }).click();
  await expect(main).toContainText('Lieferschein ohne Preise');
  await expect(main.getByRole('columnheader', { name: /Einzel/ })).toHaveCount(0);
  const chain = page.getByTestId('document-chain-panel');
  await expect(chain).toContainText('Angebot · ANG-2026-001');
  await expect(chain).toContainText('3 Dokumente');
  await shot('delivery-note-chain');
});

test('"Stellen" asks first, an issued invoice opens read-only, and browser back from the editor warns about unsaved changes', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const draft = await createDraft(page, 'Stellen Kunde', [{ kind: 'item', description: 'Leistung', quantity: 1, price: 80, total: 80 }]);
  const other = await createDraft(page, 'Zurück Kunde', [{ kind: 'item', description: 'Leistung', quantity: 1, price: 20, total: 20 }]);
  await page.reload();
  await page.goto(appUrl(baseUrl, '/documents'));
  await page.getByRole('row', { name: `Rechnung ${draft.number} öffnen` }).click();
  await page.getByRole('button', { name: 'Stellen', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Rechnung stellen' });
  await expect(confirm).toContainText('nicht mehr bearbeiten');
  await confirm.getByRole('button', { name: 'Abbrechen' }).click();
  expect((await invoices(page)).find((invoice) => invoice.id === draft.id).status, 'cancel keeps the draft').toBe('draft');
  await page.getByRole('button', { name: 'Stellen', exact: true }).click();
  await confirm.getByRole('button', { name: 'Stellen', exact: true }).click();
  await expect.poll(async () => (await invoices(page)).find((invoice) => invoice.id === draft.id).status).toBe('open');
  await expect(page.getByRole('banner').getByRole('button', { name: 'Bearbeiten', exact: true })).toHaveCount(0);
  await expect(page.getByRole('note').filter({ hasText: 'schreibgeschützt' })).toBeVisible();
  await shot('issued-read-only');

  await page.getByRole('button', { name: 'Zurück zur Liste' }).click();
  await expect(page.getByRole('button', { name: `${draft.number} bearbeiten` }), 'no editor for an issued invoice').toHaveCount(0);
  await page.getByRole('button', { name: `${other.number} bearbeiten` }).click();
  await expect(page).toHaveURL(/#\/documents\/edit/);
  await page.getByRole('textbox', { name: 'Einzelpreis 1' }).or(page.getByRole('spinbutton', { name: 'Einzelpreis 1' })).fill('25');
  await page.goBack();
  const discard = page.getByRole('dialog', { name: 'Ungespeicherte Änderungen verwerfen?' });
  await expect(discard).toBeVisible();
  await shot('back-warns');
  await discard.getByRole('button', { name: 'Weiter bearbeiten' }).click();
  await expect(page).toHaveURL(/#\/documents\/edit/);
  await page.goBack();
  await discard.getByRole('button', { name: 'Änderungen verwerfen' }).click();
  await expect(page).not.toHaveURL(/#\/documents\/edit/);
  expect((await invoices(page)).find((invoice) => invoice.id === other.id).items[0].price, 'nothing saved').toBe(20);

  // Saving a draft change still asks for the GoBD reason, with one-click suggestions.
  await page.getByRole('button', { name: `${other.number} bearbeiten` }).click();
  await page.getByRole('textbox', { name: 'Einzelpreis 1' }).or(page.getByRole('spinbutton', { name: 'Einzelpreis 1' })).fill('25');
  await page.locator('button').filter({ hasText: 'Speichern' }).click();
  const reason = page.getByRole('dialog', { name: 'Grund der Änderung' });
  await reason.getByRole('button', { name: 'Betrag angepasst' }).click();
  await reason.getByRole('button', { name: 'Speichern' }).click();
  await expect.poll(async () => (await invoices(page)).find((invoice) => invoice.id === other.id).items[0].price).toBe(25);
});

test('a partial payment reads "Teilbezahlt", an overpayment is refused with the reason, and the history has no raw keys', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const draft = await createDraft(page, 'Teilzahler', [{ kind: 'item', description: 'Leistung', quantity: 1, price: 300, total: 300 }]);
  await invokeDesktopIpc(page, 'invoices:upsert', { reason: 'gestellt', invoice: { ...draft, date: localToday(), dueDate: '2099-12-31', status: 'open' } });
  await invokeDesktopIpc(page, 'invoices:savePayment', { invoiceId: draft.id, payment: { id: crypto.randomUUID(), date: localToday(), amount: 200, method: 'Überweisung' }, reason: 'E2E Teilzahlung' });
  await page.reload();
  await page.goto(appUrl(baseUrl, '/documents'));
  await page.getByRole('row', { name: `Rechnung ${draft.number} öffnen` }).click();
  const main = page.getByRole('main');
  await expect(main.getByText('Teilbezahlt').first()).toBeVisible();
  await expect(main).toContainText('Zahlung erfasst');
  await expect(main).not.toContainText('invoice.payment');
  await shot('partial');

  await page.getByRole('button', { name: 'Zahlung', exact: true }).click();
  const payment = page.getByRole('dialog', { name: 'Zahlung erfassen' });
  await payment.getByLabel('Betrag (EUR)').fill('300,00');
  await payment.getByLabel('Grund (Pflicht)').fill('Überzahlung');
  await payment.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByText(/übersteigt den offenen Betrag von 100,00 €.*Guthaben/)).toBeVisible();
  await expect(page.getByText(/Error:/)).toHaveCount(0);
  expect((await invoices(page)).find((invoice) => invoice.id === draft.id).payments.map((entry) => entry.amount)).toEqual([200]);
  await shot('overpaid');
});
