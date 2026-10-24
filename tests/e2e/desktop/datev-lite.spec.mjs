import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { appUrl, getDesktopSettings, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';
import { createShooter, seedBankTransactions } from './lite-support.mjs';

/**
 * DATEV export from the Lite EÜR (Auswertungen → EÜR), verified through the downloaded file and the backend.
 *
 * How this can fail:
 * - settings: Beraternummer/Mandantennummer/Kontenrahmen not persisted by "Einstellungen speichern",
 *   an invalid Beraternummer saved anyway
 * - export: the button exporting without DATEV numbers instead of naming them, the download not
 *   being a DATEV file (EXTF header) or missing the account of the classified item, an
 *   unclassified item dropped without being listed
 */

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp();
  await seedDesktopData(desktop.page);
  await desktop.page.reload();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

const section = (page, name) => page.getByRole('button', { name: new RegExp(`^${name}`) }).first();

test('DATEV numbers are set in the settings, a classified bank expense is exported as EXTF with its account', async () => {
  const { page, baseUrl, app } = desktop;
  const shot = createShooter(page);
  await seedBankTransactions(page);
  await page.reload();
  const taxYear = new Date().getFullYear();

  // Negative: without DATEV numbers the export names what is missing.
  await page.goto(appUrl(baseUrl, '/statistics?view=eur'));
  await page.getByLabel('DATEV-Zeitraum').selectOption({ label: `Jahr ${taxYear}` });
  await page.getByRole('button', { name: 'DATEV-Export' }).click();
  await expect(page.getByText(/Beraternummer und Mandantennummer/)).toBeVisible();
  await shot('datev-missing-numbers');

  // Settings → Finanzen: an invalid Beraternummer is refused, a valid pair is saved.
  await page.goto(appUrl(baseUrl, '/settings'));
  await section(page, 'Finanzen').click();
  await expect(page.getByText('DATEV-Export (für die Steuerberatung)')).toBeVisible();
  await page.getByLabel('Beraternummer').fill('12');
  await page.getByLabel('Mandantennummer').fill('42');
  await page.getByRole('button', { name: 'Einstellungen speichern' }).click();
  await expect(page.getByText(/DATEV-Export: Beraternummer/)).toBeVisible();
  expect((await getDesktopSettings(page)).datev).toBeUndefined();
  await page.getByLabel('Beraternummer').fill('1234567');
  await page.getByLabel('Kontenrahmen der Steuerberatung').selectOption('SKR03');
  await expect(page.getByText(/billme Lite führt selbst keine Konten/)).toBeVisible();
  await shot('datev-settings');
  await page.getByRole('button', { name: 'Einstellungen speichern' }).click();
  await expect.poll(async () => (await getDesktopSettings(page)).datev ?? null)
    .toEqual({ consultantNumber: '1234567', clientNumber: '42', accountLength: 4, chart: 'SKR03' });

  // Classify the seeded Adobe expense as "Software und IT" (Kz 228 → SKR03 4806).
  const adobe = async () => (await invokeDesktopIpc(page, 'eur:listItems', { taxYear, sourceType: 'transaction', status: 'all' })).find((item) => item.counterparty === 'Adobe Systems');
  await page.goto(appUrl(baseUrl, '/eur'));
  await page.getByLabel('Einträge durchsuchen').fill('Adobe');
  await page.getByRole('button', { name: /Adobe Systems/ }).first().click();
  const panel = page.getByRole('region', { name: 'Klassifizierung' });
  await panel.getByLabel('Kategorie').selectOption({ label: 'Software und IT' });
  await panel.getByRole('textbox', { name: 'Begründung für EÜR-Änderung' }).fill('Abo-Rechnung geprüft');
  await panel.getByRole('button', { name: 'Klassifizierung speichern' }).click();
  await expect.poll(async () => (await adobe()).classification?.eurLineId ?? null).toBe(`E${taxYear}_KZ228`);

  // Export the year; answer the save dialog in the main process.
  const target = path.join(os.tmpdir(), `billme-datev-${process.pid}-${Date.now()}.csv`);
  await app.evaluate(({ session }, file) => {
    session.defaultSession.once('will-download', (_event, item) => item.setSavePath(file));
  }, target);
  await page.goto(appUrl(baseUrl, '/statistics?view=eur'));
  await page.getByLabel('DATEV-Zeitraum').selectOption({ label: `Jahr ${taxYear}` });
  await page.getByRole('button', { name: 'DATEV-Export' }).click();
  await expect.poll(() => fs.existsSync(target) && fs.statSync(target).size > 0, { timeout: 15_000 }).toBe(true);
  const csv = fs.readFileSync(target, 'latin1');
  fs.copyFileSync(target, test.info().outputPath('EXTF_Buchungsstapel.csv'));
  fs.rmSync(target, { force: true });
  expect(csv.startsWith('"EXTF";700;21;"Buchungsstapel"')).toBe(true);
  expect(csv).toContain(';1234567;42;');
  const adobeRow = csv.split('\r\n').find((row) => row.includes('Adobe Systems'));
  expect(adobeRow?.split(';').slice(6, 8)).toEqual(['1200', '4806']);
  // The unclassified seeded income is not in the file but listed under the toolbar.
  await expect(page.getByRole('status', { name: 'Nicht exportierte Posten' })).toContainText('Noch keiner EÜR-Kategorie zugeordnet');
  await shot('datev-exported');

  // The same export through the backend reports the same rows.
  const result = await invokeDesktopIpc(page, 'eur:exportDatev', { from: `${taxYear}-01-01`, to: `${taxYear}-12-31` });
  expect(result.rowCount).toBe(csv.split('\r\n').slice(2).filter(Boolean).length);
  expect(result.errors.length).toBeGreaterThan(0);
});
