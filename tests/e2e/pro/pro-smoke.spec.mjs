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

test('pro finance hub opens accounting workspace and core tabs', async () => {
  const { page, baseUrl } = desktop;
  await page.goto(appUrl(baseUrl, '/finance'));

  await expect(page.getByRole('heading', { name: 'Finanzen' })).toBeVisible();
  await page.getByRole('button', { name: 'Pro Buchhaltung' }).click();
  await expect(page.getByRole('heading', { name: 'Pro Buchhaltung' })).toBeVisible();

  await expect(page.getByRole('button', { name: 'Inbox', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Abgleich', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ausnahmen', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Anlagen', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Auswertungen', exact: true })).toBeVisible();
});
