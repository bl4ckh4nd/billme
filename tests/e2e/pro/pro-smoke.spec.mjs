import { expect, test } from '@playwright/test';
import { appUrl, launchDesktopApp, seedDesktopData } from '../support.mjs';

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedDesktopData(desktop.page, { app: 'pro' });
  await desktop.page.reload();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('old finance hub link lands on Konten and the rail reaches the accounting areas', async () => {
  const { page, baseUrl } = desktop;
  await page.goto(appUrl(baseUrl, '/finance'));

  await expect(page).toHaveURL(/\/accounts/);
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  for (const label of ['Buchen', 'Bankabgleich', 'Auswertungen', 'Steuer']) {
    await expect(nav.getByRole('button', { name: label })).toBeVisible();
  }
  await page.screenshot({ path: test.info().outputPath('01-konten-with-rail.png') });
});
