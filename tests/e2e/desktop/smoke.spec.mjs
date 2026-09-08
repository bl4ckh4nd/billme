import { expect, test } from '@playwright/test';
import { appUrl, launchDesktopApp, seedDesktopData } from '../support.mjs';

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp();
  await seedDesktopData(desktop.page);
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('covers the major shell routes', async () => {
  const { page, baseUrl } = desktop;
  await page.goto(appUrl(baseUrl, '/'));

  await page.goto(appUrl(baseUrl, '/clients'));
  await expect(page.getByRole('heading', { name: 'Kunden' })).toBeVisible();

  await page.goto(appUrl(baseUrl, '/projects'));
  await expect(page.getByRole('heading', { name: 'Projekte' })).toBeVisible();

  await page.goto(appUrl(baseUrl, '/articles'));
  await expect(page.getByRole('heading', { name: 'Produkte & Leistungen' })).toBeVisible();

  await page.goto(appUrl(baseUrl, '/statistics'));
  await expect(page.getByRole('heading', { name: 'Statistiken' })).toBeVisible();

  await page.goto(appUrl(baseUrl, '/accounts'));
  await expect(page.getByRole('heading', { name: 'Konten & Transaktionen' })).toBeVisible();

  await page.goto(appUrl(baseUrl, '/eur'));
  await expect(page.getByRole('heading', { name: 'Anlage EÜR' })).toBeVisible();

  await page.goto(appUrl(baseUrl, '/documents'));
  await expect(page.getByRole('button', { name: 'Vorlagen' })).toBeVisible();

  await page.getByRole('button', { name: 'Vorlagen' }).click({ force: true });
  await expect(page.getByRole('heading', { name: 'Vorlagen' })).toBeVisible();

  await page.goto(appUrl(baseUrl, '/documents'));
  await page.getByRole('button', { name: 'Abos' }).click({ force: true });
  await expect(page.getByRole('heading', { name: 'Abo-Rechnungen' })).toBeVisible();

  await page.goto(appUrl(baseUrl, '/settings'));
  await expect(page.getByRole('heading', { name: 'Einstellungen' })).toBeVisible();
});

test('global search opens a deep link result', async () => {
  const { page, baseUrl } = desktop;
  await page.goto(appUrl(baseUrl, '/'));

  await page.getByLabel('Globale Suche').fill('KD-0001');
  const clientSearchResult = page.locator('button').filter({ hasText: 'Musterfirma GmbH' }).filter({ hasText: 'KD-0001' }).first();
  await expect(clientSearchResult).toBeVisible();
  await clientSearchResult.click();
  await expect(page).toHaveURL(/\/clients\?id=c1$/);
  await expect(page.getByRole('heading', { name: 'Musterfirma GmbH' })).toBeVisible();
  await expect(page.getByText('Musterfirma GmbH')).toBeVisible();
});
