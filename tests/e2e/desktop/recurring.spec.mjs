import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';
import { createShooter } from './lite-support.mjs';

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
