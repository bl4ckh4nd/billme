import { expect, test } from '@playwright/test';
import { appUrl, createDesktopSettings, getDesktopSettings, launchDesktopApp, setDesktopSettings } from '../support.mjs';

/**
 * Pro: a sole proprietor, GbR or e.K. may keep books (§ 238 HGB or voluntarily); GmbH/UG must.
 *
 * How this can fail:
 * - the onboarding disables "Doppelte Buchführung" for these forms or refuses the step
 *   ("Diese Rechtsform wird im aktuellen Umfang mit EÜR eingerichtet"), so Pro's own default
 *   (sole proprietor on double entry) cannot be finished
 * - wizard and settings offer different legal forms
 * - the e.K. with double entry gets EÜR screens instead of the double-entry reports (Bilanz, HGB-GuV),
 *   Konten asks the EÜR endpoint (409) and talks about EÜR, the Privatkonten presets are missing
 */

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('a sole proprietor sets up Pro with double-entry bookkeeping, and settings offer the same legal forms', async () => {
  const { page, baseUrl } = desktop;
  await setDesktopSettings(page, createDesktopSettings({ onboardingCompleted: false, company: { name: '' } }));
  await page.goto(appUrl(baseUrl, '/'));
  await page.reload();
  const wizard = page.getByRole('dialog', { name: /einrichten/ });
  await expect(wizard).toBeVisible();
  await wizard.getByLabel('Firmenname').fill('Tischlerei Holm e.K.');
  await wizard.getByRole('button', { name: 'Weiter zu Abrechnung' }).click();

  await wizard.getByRole('button', { name: 'Weitere Angaben anzeigen' }).click();
  await wizard.getByLabel('Rechtsform').selectOption('ek');
  await expect(wizard.getByLabel('Gewinnermittlung').locator('option[value="double_entry"]')).toBeEnabled();
  await wizard.getByLabel('Gewinnermittlung').selectOption('double_entry');
  await expect(wizard.getByLabel('Kontenrahmen')).toHaveValue('SKR03');
  await page.screenshot({ path: test.info().outputPath('01-ek-double-entry.png') });
  await wizard.getByRole('button', { name: 'Weiter zu Weitere Angaben' }).click();
  await wizard.getByRole('button', { name: 'Einrichtung abschließen' }).click();
  await expect(wizard).toHaveCount(0);

  const stored = await getDesktopSettings(page);
  expect([stored.businessReportingProfile.legalForm, stored.businessReportingProfile.profitDetermination, stored.businessReportingProfile.chart])
    .toEqual(['ek', 'double_entry', 'SKR03']);

  await page.goto(appUrl(baseUrl, '/settings'));
  await page.getByRole('button', { name: /^Rechtliches/ }).first().click();
  await expect(page.getByLabel('Rechtsform').locator('option')).toHaveText(['Einzelunternehmen', 'GbR', 'e.K.', 'GmbH', 'UG (haftungsbeschränkt)']);
  await expect(page.getByLabel('Rechtsform')).toHaveValue('ek');
  await expect(page.getByTestId('profit-determination-value')).toHaveText('Doppelte Buchführung');
  await page.screenshot({ path: test.info().outputPath('02-settings-same-list.png') });

  // The books of a double-entry e.K.: full reports, no EÜR on Konten, Privatkonten instead of Gesellschafterkonten.
  const eurRequests = [];
  page.on('request', (request) => { if (request.url().includes('/reports/eur/')) eurRequests.push(request.url()); });
  const nav = page.getByRole('navigation', { name: 'Hauptnavigation' });
  await nav.getByRole('button', { name: 'Auswertungen' }).click();
  const tabs = page.getByRole('main').getByRole('group', { name: 'Bericht' });
  for (const label of ['SuSa', 'BWA01', 'Management-GuV', 'HGB-GuV', 'Bilanz']) await expect(tabs.getByRole('button', { name: label, exact: true })).toBeVisible();
  await nav.getByRole('button', { name: 'Konten' }).click();
  await expect(page.getByRole('heading', { name: 'Konten', level: 1 })).toBeVisible();
  await expect(page.getByRole('main')).not.toContainText('EÜR');
  await expect(page.getByRole('radio', { name: 'EÜR klassifizieren' }).or(page.getByRole('button', { name: 'EÜR klassifizieren' }))).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('03-konten-without-eur.png'), fullPage: true });
  await page.goto(appUrl(baseUrl, '/accounting?view=special'));
  await expect(page.getByTestId('manual-entry-panel').getByRole('button', { name: 'Privatentnahme bar' })).toBeVisible();
  expect(eurRequests, 'no EÜR request in double entry').toEqual([]);
});
