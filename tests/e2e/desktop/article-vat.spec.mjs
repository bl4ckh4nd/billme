import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';

for (const app of ['desktop', 'pro']) {
  test(`${app} preserves article VAT through invoice save and reload`, async () => {
    const desktop = await launchDesktopApp({ app });
    try {
      const { page, baseUrl } = desktop;
      await seedDesktopData(page, {
        app,
        settingsOverrides: { legal: { smallBusinessRule: false, defaultVatRate: 19 } },
      });
      await page.goto(appUrl(baseUrl, '/articles'));

      await page.getByRole('button', { name: 'Neuer Artikel' }).click();
      await page.getByPlaceholder('z.B. Webdesign').fill('E2E Zero VAT');
      await page.locator('input[type="number"]').first().fill('50');
      await page.getByRole('button', { name: '0%', exact: true }).click();
      await page.getByRole('button', { name: 'Erstellen', exact: true }).click();
      await expect(page.getByText('Artikel erstellt.')).toBeVisible();

      await page.getByRole('button', { name: 'Neuer Artikel' }).click();
      await page.getByPlaceholder('z.B. Webdesign').fill('E2E Reduced VAT');
      await page.locator('input[type="number"]').first().fill('100');
      await page.getByRole('button', { name: '7%', exact: true }).click();
      await page.getByRole('button', { name: 'Erstellen', exact: true }).click();
      await expect(page.getByText('Artikel erstellt.')).toBeVisible();

      const articles = await invokeDesktopIpc(page, 'articles:list');
      expect(articles.find((article) => article.title === 'E2E Zero VAT')?.taxRate).toBe(0);
      expect(articles.find((article) => article.title === 'E2E Reduced VAT')?.taxRate).toBe(7);

      await page.goto(appUrl(baseUrl, '/documents'));
      await page.getByTitle('Neue Rechnung').click();
      await expect(page.getByRole('heading', { name: 'Rechnung erstellen' })).toBeVisible();
      await page.getByRole('combobox', { name: 'Kunde auswählen' }).selectOption({ label: 'Musterfirma GmbH' });
      await page.getByRole('combobox', { name: 'Artikel auswählen' }).selectOption({ label: 'E2E Reduced VAT' });
      await page.getByRole('button', { name: 'Hinzufügen' }).click();

      await expect(page.getByRole('combobox', { name: 'Umsatzsteuer Position 1' })).toHaveValue('7');
      if (app === 'desktop') await expect(page.getByText('Regelbesteuerung (7%)')).toBeVisible();
      await expect(page.getByText('107,00 €', { exact: true })).toBeVisible();
      await page.locator('button').filter({ hasText: 'Speichern' }).click();
      await expect(page).toHaveURL(/#\/documents$/);

      const invoices = await invokeDesktopIpc(page, 'invoices:list', {});
      const invoice = invoices.find((candidate) =>
        candidate.items.some((item) => item.description === 'E2E Reduced VAT'),
      );
      expect(invoice?.items[0]?.taxRate).toBe(7);
      if (app === 'desktop') {
        expect(invoice?.taxSnapshot?.vatAmount).toBe(7);
        expect(invoice?.taxSnapshot?.grossAmount).toBe(107);
      }
      expect(invoice?.amount).toBe(107);
    } finally {
      await desktop.close();
    }
  });
}
