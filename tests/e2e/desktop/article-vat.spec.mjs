import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';
import { createShooter, readEditorTotals } from './lite-support.mjs';

for (const app of ['desktop', 'pro']) {
  test(`${app} preserves article VAT through invoice save and reload`, async () => {
    const desktop = await launchDesktopApp({ app });
    try {
      const { page, baseUrl } = desktop;
      const shot = createShooter(page);
      await seedDesktopData(page, {
        app,
        settingsOverrides: { legal: { smallBusinessRule: false, defaultVatRate: 19 } },
      });
      // Seeding writes past react-query; reload so the editor prices with the regular-VAT settings.
      await page.reload();
      await page.goto(appUrl(baseUrl, '/articles'));

      const createArticle = async (title, price, rate) => {
        await page.getByRole('button', { name: 'Neuer Artikel' }).click();
        const dialog = page.getByRole('dialog', { name: 'Neuer Artikel' });
        await dialog.getByRole('textbox', { name: 'Bezeichnung' }).fill(title);
        await dialog.getByRole('spinbutton', { name: 'Preis (Netto)' }).fill(price);
        await dialog.getByRole('group', { name: 'Umsatzsteuer (USt)' }).getByRole('button', { name: `${rate}%`, exact: true }).click();
        await shot(`article-${rate}-percent`);
        await dialog.getByRole('button', { name: 'Erstellen', exact: true }).click();
        await expect(page.getByText('Artikel erstellt.')).toBeVisible();
        await expect(dialog).toHaveCount(0);
      };
      await createArticle('E2E Zero VAT', '50', 0);
      await createArticle('E2E Reduced VAT', '100', 7);

      const articles = await invokeDesktopIpc(page, 'articles:list');
      expect(articles.find((article) => article.title === 'E2E Zero VAT')?.taxRate).toBe(0);
      expect(articles.find((article) => article.title === 'E2E Reduced VAT')?.taxRate).toBe(7);

      await page.goto(appUrl(baseUrl, '/documents'));
      await page.getByRole('button', { name: 'Neue Rechnung' }).click();
      await expect(page.getByRole('heading', { name: 'Rechnung erstellen' })).toBeVisible();
      await page.getByRole('combobox', { name: 'Kunde auswählen' }).fill('Musterfirma');
      await page.getByRole('option').filter({ hasText: 'Musterfirma GmbH' }).click();
      await page.getByRole('button', { name: 'Position hinzufügen' }).click();
      const description = page.getByRole('combobox', { name: 'Beschreibung Position 1' });
      await description.fill('E2E Reduced VAT');
      await page.getByRole('option').filter({ hasText: 'E2E Reduced VAT' }).click();

      // The article's own rate is applied to the line and priced in the totals.
      await expect(page.getByRole('combobox', { name: 'Umsatzsteuer Position 1' })).toHaveValue('7');
      await expect.poll(() => readEditorTotals(page)).toEqual([
        ['Nettobetrag', '100,00 €'],
        ['USt. 7 %', '7,00 €'],
        ['Gesamtbetrag', '107,00 €'],
      ]);
      await shot('invoice-with-reduced-vat-article');
      await page.getByRole('button', { name: 'Speichern' }).click();
      await expect(page).toHaveURL(/#\/documents(?:\?|$)/);

      const invoices = await invokeDesktopIpc(page, 'invoices:list', {});
      const invoice = invoices.find((candidate) =>
        candidate.items.some((item) => item.description === 'E2E Reduced VAT'),
      );
      expect(invoice?.items[0]?.taxRate).toBe(7);
      expect(invoice?.taxSnapshot?.vatAmount).toBe(7);
      expect(invoice?.taxSnapshot?.grossAmount).toBe(107);
      expect(invoice?.amount).toBe(107);

      // Reopening the saved draft keeps the rate.
      await page.reload();
      await page.getByRole('row', { name: `Rechnung ${invoice.number} öffnen` }).click();
      await expect(page.getByRole('heading', { name: invoice.number, level: 1 })).toBeVisible();
      await shot('invoice-reopened');
    } finally {
      await desktop.close();
    }
  });
}
