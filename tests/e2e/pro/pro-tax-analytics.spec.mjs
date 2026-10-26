import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, PRO_DOUBLE_ENTRY_SETTINGS, seedDesktopData } from '../support.mjs';

/**
 * Steuer-Übersicht and Geldkonten of a double-entry business, read from an imported journal.
 *
 * How this can fail:
 * - the Steuer area shows no UStVA per period, or a Fristen row that opens another period in the Kennzahlen below
 * - the payments to the tax office mix Lohnsteuer into Umsatzsteuer, or count nothing
 * - Geldkonten opens without the account and year of the link, or the year arrows go past the booked years
 * - the liquidity tile of the overview does not lead to Geldkonten
 */

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedDesktopData(desktop.page, { app: 'pro', settingsOverrides: PRO_DOUBLE_ENTRY_SETTINGS });
  await desktop.page.reload();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

const Y2 = new Date().getFullYear() - 2;
const Y1 = Y2 - 1;

const journalCsv = () => {
  const rows = ['Buchung;Datum;Belegnr;Buchungstext;Konto;Soll;Haben;Steuerfall'];
  let entry = 0;
  const add = (date, reference, text, lines) => {
    entry += 1;
    lines.forEach(([account, debit, credit, tax], index) => rows.push([entry, index ? '' : date, index ? '' : reference, index ? '' : text, account, debit, credit, tax ?? ''].join(';')));
  };
  for (const year of [Y1, Y2]) {
    for (let month = 1; month <= 12; month += 1) {
      const mm = String(month).padStart(2, '0');
      add(`15.${mm}.${year}`, `AR-${year}-${mm}`, 'Kunde Beispiel GmbH – Beratung', [['1200', '1190,00', ''], ['8400', '', '1190,00', 'USt19']]);
      add(`20.${mm}.${year}`, `ER-${year}-${mm}`, 'Büro Beispiel – Material', [['4930', '119,00', '', 'VSt19'], ['1200', '', '119,00']]);
      add(`10.${mm}.${year}`, `LS-${year}-${mm}`, 'Finanzamt Lohnsteuer', [['1741', '200,00', ''], ['1200', '', '200,00']]);
    }
  }
  add(`10.03.${Y2}`, `UV-${Y2}-02`, 'Finanzamt Umsatzsteuer Februar', [['1780', '171,00', ''], ['1200', '', '171,00']]);
  return rows.join('\n');
};

test('the Steuer area shows UStVA per period with Fristen and the tax payments; Geldkonten shows one account per year', async () => {
  const { page, baseUrl } = desktop;
  const shot = (name) => page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
  const imported = await invokeDesktopIpc(page, 'pro:importJournal', {
    reason: 'Übernahme', format: 'journal_csv', fileName: 'journal.csv', contentBase64: Buffer.from(journalCsv()).toString('base64'), dryRun: false,
  });
  expect(imported.postedCount, JSON.stringify(imported.issues)).toBe(73);

  await page.goto(appUrl(baseUrl, '/accounting?view=tax'));
  const panel = page.getByTestId('tax-analytics-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('combobox', { name: 'Steuerjahr' }).selectOption(String(Y2));
  const fristen = panel.getByRole('table', { name: 'Voranmeldungen und Fristen' });
  await expect(fristen.getByRole('row')).toHaveCount(13);
  // Every month: 190 € USt, 19 € Vorsteuer, Zahllast 171 €; Frist of March is the 10th of April (or the next workday).
  const march = fristen.getByRole('row', { name: new RegExp(`März ${Y2}`) });
  await expect(march).toContainText('171,00');
  await expect(march).toContainText(`.04.${Y2}`);
  await expect(march).toContainText('nicht in Billme');
  await shot('tax-overview');

  await march.click();
  await expect(page.getByTestId('ustva-panel').getByLabel('UStVA-Zeitraum')).toHaveValue('month');
  await expect(page.getByLabel('UStVA-Monat')).toHaveValue(`${Y2}-03`);

  await panel.getByRole('radio', { name: 'Zahlungen ans Finanzamt' }).click();
  const payments = panel.getByTestId('tax-analytics-payments');
  await payments.getByRole('button', { name: /^Lohnsteuer/ }).click();
  await expect(payments).toContainText('2.400,00');
  await payments.getByRole('button', { name: /^Umsatzsteuer/ }).click();
  await expect(payments.getByRole('table', { name: 'Zahlungen Umsatzsteuer' })).toContainText(`UV-${Y2}-02`);
  await shot('tax-payments');

  await panel.getByRole('radio', { name: 'Größte USt-Posten' }).click();
  await expect(panel.getByRole('table', { name: 'Größte Umsatzsteuer-Posten' }).getByRole('row')).toHaveCount(21);

  await page.goto(appUrl(baseUrl, `/accounting?view=money&account=1200&year=${Y2}`));
  const money = page.getByTestId('money-account-view');
  await expect(money).toBeVisible();
  await expect(money.getByLabel('Geldkonto', { exact: true })).toHaveValue('1200');
  // Each year: 12 × 1.190 in, 12 × (119 + 200) out; Y2 also the USt payment of 171 (3.999 €).
  await expect(money.getByLabel('Kennzahlen Geldkonto')).toContainText('14.280,00');
  await expect(money.getByLabel('Kennzahlen Geldkonto')).toContainText('3.999,00');
  await expect(money.getByRole('table', { name: 'Gegenkonten' })).toContainText('8400');
  await shot('money-account');
  await money.getByRole('button', { name: 'Vorjahr' }).click();
  await expect(money).toContainText(String(Y1));
  await expect(money.getByRole('button', { name: 'Vorjahr' })).toBeDisabled();

  await page.goto(appUrl(baseUrl, '/'));
  await page.locator('section[aria-label="Kennzahlen"]').getByRole('button', { name: /Geldkonten|Konto 1200/ }).click();
  await expect(page).toHaveURL(/view=money/);
  await expect(page.getByTestId('money-account-view')).toBeVisible();
});
