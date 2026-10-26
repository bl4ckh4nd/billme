import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, PRO_DOUBLE_ENTRY_SETTINGS, seedDesktopData } from '../support.mjs';

/**
 * Prüfungen and Geschäftspartner of a double-entry business on an imported journal, and the analysis year that
 * follows a person from one analysis to the next.
 *
 * How this can fail:
 * - the navigation shows no count of open findings, or keeps the old count after a finding is marked OK
 * - a finding is marked OK without a reason
 * - a partner does not open its bookings
 * - the year chosen in Geschäftspartner is not the one Steuer and Geldkonten open on
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

const journalCsv = () => [
  'Buchung;Datum;Belegnr;Buchungstext;Konto;Soll;Haben;Steuerfall',
  `1;05.03.${Y2};ER-AWS;AWS Emea aws.amazon USD;4920;119,00;;VSt19`,
  '1;;;;1200;;119,00;',
  `2;10.03.${Y2};D-1;Strom Beispiel Energie;4210;80,00;;`,
  '2;;;;1200;;80,00;',
  `3;12.03.${Y2};D-2;Strom Beispiel Energie;4210;80,00;;`,
  '3;;;;1200;;80,00;',
  `4;15.03.${Y2};AR-1;Kunde Beispiel GmbH;1200;1190,00;;`,
  '4;;;;8400;;1190,00;USt19',
  `5;15.06.${Y1};AR-0;Kunde Beispiel GmbH;1200;595,00;;`,
  '5;;;;8400;;595,00;USt19',
].join('\n');

test('Prüfungen count in the navigation, a finding is marked OK with a reason, partners open their bookings, the year carries over', async () => {
  const { page, baseUrl } = desktop;
  const shot = (name) => page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
  const imported = await invokeDesktopIpc(page, 'pro:importJournal', {
    reason: 'Übernahme', format: 'journal_csv', fileName: 'journal.csv', contentBase64: Buffer.from(journalCsv()).toString('base64'), dryRun: false,
  });
  expect(imported.postedCount, JSON.stringify(imported.issues)).toBe(5);
  const before = await invokeDesktopIpc(page, 'pro:getLedgerChecks', {});
  const openBefore = before.openErrors + before.openWarnings;
  expect(openBefore).toBeGreaterThanOrEqual(2);

  await page.goto(appUrl(baseUrl, '/accounting?view=checks'));
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await expect(nav.getByRole('button', { name: /Prüfungen/ })).toContainText(String(openBefore));
  const view = page.getByTestId('checks-view');
  await view.getByRole('button', { name: /Auslandsanbieter mit deutscher Vorsteuer/ }).click();
  const findings = page.getByTestId('check-findings');
  await expect(findings.getByRole('row', { name: /ER-AWS/ })).toBeVisible();
  await shot('checks');

  await findings.getByRole('row', { name: /ER-AWS/ }).getByRole('button', { name: 'Als OK markieren' }).click();
  await expect(findings.getByRole('alert')).toContainText('Begründung');
  await findings.getByLabel('Begründung für OK').fill('Rechnung von AWS EMEA SARL mit deutscher USt-IdNr.');
  await findings.getByRole('row', { name: /ER-AWS/ }).getByRole('button', { name: 'Als OK markieren' }).click();
  await expect(findings.getByRole('row', { name: /ER-AWS/ })).toHaveCount(0);
  await expect(nav.getByRole('button', { name: /Prüfungen/ })).toContainText(String(openBefore - 1));
  await findings.getByRole('radio', { name: /^OK/ }).click();
  await expect(findings.getByRole('row', { name: /ER-AWS/ })).toContainText('Rechnung von AWS EMEA SARL');

  await page.goto(appUrl(baseUrl, '/accounting?view=partners'));
  const partners = page.getByTestId('partners-view');
  await partners.getByLabel('Jahr der Geschäftspartner').selectOption(String(Y2));
  const table = partners.getByRole('table', { name: 'Geschäftspartner' });
  await expect(table.getByRole('row', { name: /Strom Beispiel Energie/ })).toContainText('160,00');
  await table.getByRole('row', { name: /Kunde Beispiel GmbH/ }).click();
  const detail = page.getByTestId('partner-detail');
  await expect(detail).toContainText('Kunde Beispiel GmbH');
  await expect(detail.getByRole('table', { name: /Buchungen Kunde Beispiel GmbH/ })).toContainText('AR-1');
  await shot('partners');

  // The year chosen here opens Steuer and Geldkonten.
  await page.goto(appUrl(baseUrl, '/accounting?view=tax'));
  await expect(page.getByRole('combobox', { name: 'Steuerjahr' })).toHaveValue(String(Y2));
  await page.goto(appUrl(baseUrl, '/accounting?view=money'));
  await expect(page.getByTestId('money-account-view')).toContainText(`Bestand 1.1.${Y2}`);
});
