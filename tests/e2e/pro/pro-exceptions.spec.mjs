import { expect, test } from '@playwright/test';
import { appUrl, importPendingProTransaction, launchDesktopApp, PRO_DOUBLE_ENTRY_SETTINGS, seedDesktopData } from '../support.mjs';

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedDesktopData(desktop.page, { app: 'pro', settingsOverrides: PRO_DOUBLE_ENTRY_SETTINGS });
  await importPendingProTransaction(desktop.page, 'exception');
  await desktop.page.reload();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('keeps exception mutations unavailable for the read-only Pro adapter', async () => {
  const { page, baseUrl } = desktop;

  await page.goto(appUrl(baseUrl, '/'));
  await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name: 'Ausnahmen' }).click();
  await expect(page.getByRole('heading', { name: 'Ausnahmen', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ausnahmen', level: 2 })).toBeVisible();

  await page.getByRole('button', { name: 'Ohne Beleg', exact: true }).click();
  await expect(page.getByText('Keine Einträge für den Filter.')).toHaveCount(0);
  await page.getByRole('button', { name: /E2E exception/ }).click();
  await page.screenshot({ path: test.info().outputPath('01-exception-center-read-only.png') });

  await expect(page.getByRole('status').filter({ hasText: 'Änderungen an Ausnahmen sind in dieser Oberfläche nicht verfügbar.' })).toBeVisible();
  await expect(page.getByPlaceholder('Was wurde geprüft/gelöst?')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Als gelöst markieren' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Zuweisen' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Pausieren' })).toBeDisabled();
});
