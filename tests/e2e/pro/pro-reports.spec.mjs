import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedDesktopData(desktop.page, {
    app: 'pro',
    settingsOverrides: {
      businessReportingProfile: {
        jurisdiction: 'DE',
        legalForm: 'gmbh',
        profitDetermination: 'double_entry',
        hgbSizeClass: 'small',
        fiscalYearStart: '01-01',
        chart: 'SKR03',
        vatMethod: 'soll',
      },
    },
  });
  const settings = await invokeDesktopIpc(desktop.page, 'settings:get');
  expect(settings.businessReportingProfile?.legalForm).toBe('gmbh');
  await desktop.page.reload();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('shows pro report summaries and opens Auswertungen workspace', async () => {
  const { page, baseUrl } = desktop;

  await page.goto(appUrl(baseUrl, '/accounting'));
  await expect(page.getByRole('heading', { name: 'Pro Buchhaltung' })).toBeVisible();

  await page.getByRole('button', { name: 'Auswertungen' }).click();
  await expect(page.getByRole('heading', { name: 'EÜR und Finanzberichte' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'SuSa' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'BWA01' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Management-GuV' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'HGB-GuV' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Bilanz' })).toBeVisible();

  const susaAccountsCard = page.locator('div.rounded-xl').filter({ hasText: 'Konten' }).first();
  const susaWarningsCard = page.locator('div.rounded-xl').filter({ hasText: 'Warnungen' }).first();
  await expect(susaAccountsCard).toContainText(/\d+/);
  await expect(susaWarningsCard).toContainText(/\d+/);
  await expect(page.getByText('Summen- und Saldenliste', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'BWA01' }).click();
  await expect(page.getByText('BWA01', { exact: true }).last()).toBeVisible();
  await expect(page.locator('div.rounded-xl').filter({ hasText: 'Ergebnis' }).first()).toContainText('€');
  await expect(page.getByText('Alle Konten sind report-spezifisch zugeordnet.')).toBeVisible();
  await expect(page.getByText(/Live-Daten/)).toBeVisible();

  await page.getByRole('button', { name: 'Management-GuV' }).click();
  const guvRevenueCard = page.locator('div.rounded-xl').filter({ hasText: 'Umsätze' }).first();
  const guvResultCard = page.locator('div.rounded-xl').filter({ hasText: 'Ergebnis' }).first();
  await expect(guvRevenueCard).toContainText('€');
  await expect(guvResultCard).toContainText('€');
  await expect(page.getByRole('button', { name: 'Management-GuV' })).toBeVisible();

  await page.getByRole('button', { name: 'HGB-GuV' }).click();
  await expect(page.getByText('Gewinn- und Verlustrechnung nach HGB', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Bilanz' }).click();
  const bilanzAktivaCard = page.locator('div.rounded-xl').filter({ hasText: 'Aktiva' }).first();
  const bilanzDifferenzCard = page.locator('div.rounded-xl').filter({ hasText: 'Differenz' }).first();
  await expect(bilanzAktivaCard).toContainText('€');
  await expect(bilanzDifferenzCard).toContainText('€');
  await expect(page.getByText('Bilanz (HGB)')).toBeVisible();
});
