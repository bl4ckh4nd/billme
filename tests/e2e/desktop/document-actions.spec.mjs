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

  // A Stornorechnung cannot follow a credit note: the refusal is shown, nothing is created.
  await page.getByRole('button', { name: 'Zurück zur Liste' }).click();
  await page.getByRole('row', { name: `Rechnung ${number} öffnen` }).click();
  await page.getByRole('button', { name: 'Storno', exact: true }).click();
  await page.getByRole('dialog', { name: /Storno.* erstellen/ }).getByRole('button', { name: /Storno.* erstellen/ }).click();
  const refusal = page.getByText(/Dokument konnte nicht erstellt werden/).first();
  await expect(refusal).toBeVisible();
  await expect(refusal, 'the reason is shown in German, without a technical prefix').toHaveText(/Dokument konnte nicht erstellt werden: Zu dieser Rechnung gibt es schon eine Gutschrift oder Stornorechnung/);
  await expect(refusal).not.toHaveText(/Error:/);
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
