import { expect, test } from '@playwright/test';
import { appUrl, launchDesktopApp, PRO_DOUBLE_ENTRY_SETTINGS, seedDesktopData } from '../support.mjs';

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedDesktopData(desktop.page, { app: 'pro', settingsOverrides: PRO_DOUBLE_ENTRY_SETTINGS });
  // Seeding writes past react-query; reload so views read the seeded rows.
  await desktop.page.reload();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('shows the SuSa from the seeded postings and keeps the other reports closed until their accounts are mapped', async () => {
  const { page, baseUrl } = desktop;

  await page.goto(appUrl(baseUrl, '/'));
  await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name: 'Auswertungen' }).click();
  await expect(page.getByRole('heading', { name: 'Auswertungen', level: 1 })).toBeVisible();
  const main = page.getByRole('main');
  const tabs = main.getByRole('group', { name: 'Bericht' });
  for (const label of ['SuSa', 'BWA01', 'Management-GuV', 'HGB-GuV', 'Bilanz']) {
    await expect(tabs.getByRole('button', { name: label, exact: true })).toBeVisible();
  }
  await expect(tabs.getByRole('button', { name: 'SuSa', exact: true })).toHaveAttribute('aria-pressed', 'true');

  // The seed issued RE-…200 (1.250 €, paid) and RE-…201 (3.450,50 €, open): receivable, revenue and the payment.
  const susa = main.getByRole('table', { name: 'Summen- und Saldenliste' });
  await expect(susa).toBeVisible();
  await expect(susa.getByRole('row', { name: /^1200 Bank 0,00 € 1\.250,00 € 0,00 € 1\.250,00 €/ })).toBeVisible();
  await expect(susa.getByRole('row', { name: /^1400 Forderungen aus Lieferungen und Leistungen 0,00 € 4\.700,50 € 1\.250,00 € 3\.450,50 €/ })).toBeVisible();
  await expect(susa.getByRole('row', { name: /^8400 Erlöse 19 % USt 0,00 € 0,00 € 4\.700,50 € -4\.700,50 €/ })).toBeVisible();
  // Double entry: debit turnover equals credit turnover and the closing balances net to zero.
  await expect(susa.getByRole('row', { name: /^Summen 0,00 € 5\.950,50 € 5\.950,50 € 0,00 €/ })).toBeVisible();
  await expect(main.getByText('Live-Daten')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('01-susa.png'), fullPage: true });

  // No mapping is guessed: every other report refuses to show numbers and to export.
  for (const [tab, label] of [['BWA01', 'BWA01'], ['Management-GuV', 'Management-GuV'], ['HGB-GuV', 'Gewinn- und Verlustrechnung nach HGB'], ['Bilanz', 'Bilanz']]) {
    await tabs.getByRole('button', { name: tab, exact: true }).click();
    await expect(tabs.getByRole('button', { name: tab, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(main.getByRole('alert').filter({ hasText: `Mapping unvollständig für ${label}` })).toBeVisible();
    await expect(main.getByRole('alert').filter({ hasText: 'Auswertung blockiert: Konten-Mapping unvollständig' })).toBeVisible();
    await expect(main.getByRole('button', { name: 'PDF' })).toBeDisabled();
    await expect(main.getByRole('button', { name: 'CSV' })).toBeDisabled();
    await page.screenshot({ path: test.info().outputPath(`02-${tab}-blocked.png`), fullPage: true });
  }
});
