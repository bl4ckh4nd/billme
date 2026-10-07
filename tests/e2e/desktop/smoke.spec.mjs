import { expect, test } from '@playwright/test';
import { appUrl, launchDesktopApp, seedDesktopData } from '../support.mjs';
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

test('covers the major shell routes', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const pageTitle = (name) => page.getByRole('banner').getByRole('heading', { name, level: 1, exact: true });
  await page.goto(appUrl(baseUrl, '/'));
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).toBeVisible();
  await shot('dashboard');

  await page.goto(appUrl(baseUrl, '/clients'));
  await expect(pageTitle('Kunden')).toBeVisible();
  await shot('clients');

  await page.goto(appUrl(baseUrl, '/projects'));
  await expect(pageTitle('Projekte')).toBeVisible();

  await page.goto(appUrl(baseUrl, '/articles'));
  await expect(pageTitle('Leistungen')).toBeVisible();
  await shot('articles');

  await page.goto(appUrl(baseUrl, '/statistics'));
  await expect(pageTitle('Auswertungen')).toBeVisible();
  await shot('statistics');

  await page.goto(appUrl(baseUrl, '/accounts'));
  await expect(pageTitle('Bankabgleich')).toBeVisible();
  await shot('bank-matching');

  await page.goto(appUrl(baseUrl, '/eur'));
  await expect(pageTitle('Buchen')).toBeVisible();

  await page.goto(appUrl(baseUrl, '/documents'));
  await expect(pageTitle('Rechnungen & Angebote')).toBeVisible();
  await shot('documents');

  // The page header and the sidebar both offer "Vorlagen"; the header button is the one on this page.
  await page.getByRole('banner').getByRole('button', { name: 'Vorlagen' }).click();
  await expect(pageTitle('Vorlagen')).toBeVisible();

  await page.goto(appUrl(baseUrl, '/documents'));
  await page.getByRole('banner').getByRole('button', { name: 'Abos' }).click();
  await expect(pageTitle('Wiederkehrend')).toBeVisible();

  await page.goto(appUrl(baseUrl, '/settings'));
  await expect(pageTitle('Einstellungen')).toBeVisible();
});

test('global search opens a deep link result', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  await page.goto(appUrl(baseUrl, '/'));

  // The palette only exists while it is open; both the button and Ctrl+K open it.
  await page.getByRole('button', { name: /Suchen oder Befehl/ }).click();
  const palette = page.getByRole('dialog', { name: 'Suche und Befehle' });
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox', { name: 'Suche und Befehle' }).fill('KD-0001');
  const clientSearchResult = palette.getByRole('option').filter({ hasText: 'Musterfirma GmbH' }).filter({ hasText: 'KD-0001' }).first();
  await expect(clientSearchResult).toBeVisible();
  await shot('palette-result');
  await clientSearchResult.click();
  await expect(page).toHaveURL(/\/clients\?id=c1$/);
  await expect(page.getByRole('heading', { name: 'Musterfirma GmbH' })).toBeVisible();
  await shot('client-detail');

  // The keyboard shortcut opens the same palette.
  await page.keyboard.press('Control+K');
  await expect(page.getByRole('dialog', { name: 'Suche und Befehle' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Suche und Befehle' })).toHaveCount(0);
});
