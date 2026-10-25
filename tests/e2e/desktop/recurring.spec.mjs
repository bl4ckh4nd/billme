import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';
import { createShooter, useRegularVat } from './lite-support.mjs';

/**
 * Recurring invoices through the Lite UI.
 *
 * How this can fail:
 * - "Jetzt ausführen" on one card running every due profile, or a paused one
 * - the tax treatment of a profile invisible and fixed in the dialog
 * - a profile created as Kleinunternehmer still billing §19 without VAT after the
 *   business switched to regular VAT
 * - the card amount unlabelled (net or gross?)
 */

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp();
  await seedDesktopData(desktop.page);
  // Seeding writes past react-query; reload so views read the seeded rows.
  await desktop.page.reload();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('creates a recurring profile and runs the generator', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  await page.goto(appUrl(baseUrl, '/recurring'));

  await expect(page.getByRole('banner').getByRole('heading', { name: 'Wiederkehrend', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Neues Abo' }).click();

  const dialog = page.getByRole('dialog', { name: 'Neues Abo' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Interne Bezeichnung' }).fill('Browser Test Abo');
  await dialog.getByRole('combobox', { name: 'Kunde' }).selectOption('c2');
  await dialog.getByRole('combobox', { name: 'Intervall' }).selectOption('monthly');
  await dialog.getByRole('textbox', { name: 'Start / Nächste Ausführung' }).fill('2026-04-01');
  await dialog.getByRole('textbox', { name: 'Beschreibung' }).fill('Monatliche Betreuung');
  await dialog.getByRole('spinbutton', { name: 'Preis (€)' }).fill('250');
  await shot('recurring-dialog');
  await dialog.getByRole('button', { name: 'Speichern' }).click();

  await expect(page.getByRole('heading', { name: 'Browser Test Abo', level: 2 })).toBeVisible();
  await shot('recurring-created');

  const profiles = await invokeDesktopIpc(page, 'recurring:list', {});
  const created = profiles.find((profile) => profile.name === 'Browser Test Abo');
  expect(created).toMatchObject({ clientId: 'c2', interval: 'monthly', amount: 250 });

  const invoicesBefore = (await invokeDesktopIpc(page, 'invoices:list', {})).length;
  const card = page.locator('div.group').filter({ has: page.getByRole('heading', { name: 'Browser Test Abo', level: 2 }) });
  await card.getByRole('button', { name: 'Jetzt ausführen' }).click();
  await expect(page.getByText(/\d+ erstellt, \d+ Profile? übersprungen/)).toBeVisible();
  await shot('recurring-ran');

  const invoices = await invokeDesktopIpc(page, 'invoices:list', {});
  expect(invoices.length).toBeGreaterThan(invoicesBefore);
  expect(invoices.some((invoice) => invoice.clientId === 'c2' && invoice.items.some((item) => item.description === 'Monatliche Betreuung'))).toBe(true);
});

test('"Jetzt ausführen" runs only its own card, never a paused one, and a former §19 profile bills with VAT', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  // The seed profile was stamped while the business was a Kleinunternehmer.
  await invokeDesktopIpc(page, 'recurring:upsert', { profile: { id: 'rec-paused', clientId: 'c2', active: false, name: 'Pausiertes Abo', interval: 'monthly', nextRun: '2026-04-01', amount: 80, items: [{ description: 'Pausiert', quantity: 1, price: 80, total: 80 }] } });
  await invokeDesktopIpc(page, 'recurring:upsert', { profile: { id: 'rec-other', clientId: 'c2', active: true, name: 'Anderes Abo', interval: 'monthly', nextRun: '2026-04-01', amount: 40, items: [{ description: 'Anderes', quantity: 1, price: 40, total: 40 }] } });
  await useRegularVat(page);
  await page.goto(appUrl(baseUrl, '/recurring'));

  const card = (name) => page.locator('div.group').filter({ has: page.getByRole('heading', { name, level: 2 }) });
  await expect(card('Pausiertes Abo').getByRole('button', { name: 'Jetzt ausführen' })).toBeDisabled();
  await expect(card('Wartungsvertrag Basis').getByText('Betrag (netto)')).toBeVisible();

  await card('Wartungsvertrag Basis').getByRole('button', { name: `Abo Wartungsvertrag Basis bearbeiten` }).click();
  const dialog = page.getByRole('dialog', { name: 'Abo bearbeiten' });
  await expect(dialog.getByRole('combobox', { name: 'Steuerbehandlung' })).toBeVisible();
  await expect(dialog.getByText(/nicht mehr Kleinunternehmer/)).toBeVisible();
  await shot('tax-in-dialog');
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();

  await card('Wartungsvertrag Basis').getByRole('button', { name: 'Jetzt ausführen' }).click();
  await expect(page.getByText(/1 erstellt/)).toBeVisible();
  const invoices = await invokeDesktopIpc(page, 'invoices:list', {});
  const generated = invoices.filter((invoice) => invoice.items.some((item) => ['Monatliche Wartung', 'Anderes', 'Pausiert'].includes(item.description)));
  expect(generated.map((invoice) => invoice.items[0].description)).toEqual(['Monatliche Wartung']);
  expect({ mode: generated[0].taxMode, amount: generated[0].amount }).toEqual({ mode: 'standard_vat', amount: 178.5 });
  await shot('ran-one');
});
