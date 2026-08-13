import { expect, test } from '@playwright/test';
import { appUrl, launchDesktopApp, seedDesktopData } from '../support.mjs';

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedDesktopData(desktop.page, { app: 'pro' });
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('keeps exception mutations unavailable for the read-only Pro adapter', async () => {
  const { page, baseUrl } = desktop;

  await page.goto(appUrl(baseUrl, '/accounting'));
  await expect(page.getByRole('heading', { name: 'Pro Buchhaltung' })).toBeVisible();
  await page.getByRole('button', { name: 'Exceptions' }).click();
  await expect(page.getByRole('heading', { name: 'Exception Center' })).toBeVisible();

  await page.getByRole('button', { name: 'Ohne Beleg' }).click();
  await expect(page.getByText('Keine Einträge für den Filter.')).toHaveCount(0);

  await expect(page.getByRole('status')).toContainText('Änderungen an Ausnahmen sind in dieser Oberfläche nicht verfügbar.');
  await expect(page.getByPlaceholder('Was wurde geprüft/gelöst?')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Als gelöst markieren' })).toBeDisabled();
});
