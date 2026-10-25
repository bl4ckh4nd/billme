import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { appUrl, getDesktopSettings, invokeDesktopIpc, launchDesktopApp, seedDesktopData, setDesktopSettings } from '../support.mjs';
import { createShooter } from './lite-support.mjs';

/**
 * Mahnwesen through the Lite UI, as a new and as an existing user.
 *
 * How this can fail:
 * - a new profile has no dunning levels and the settings offer no way to add one,
 *   so no reminder can ever carry a fee or a text
 * - added or removed levels not saved, the remaining levels not numbered 1..n
 *   (the invoice's dunning level points at the level number)
 * - an existing profile with no levels left without a way back to the defaults
 * - "Mahnung erstellen" in the invoice detail doing nothing until the user goes back
 *   to the list; the badge naming another level than the one created; a reminder
 *   beyond the last level still offered; the charged fees not visible in the invoice
 * - the dunning letter only reachable by e-mail: no preview and no PDF per level
 *   from the invoice detail or the Mahnlauf dialog
 */

let desktop;

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

const openDunningSettings = async (page, baseUrl) => {
  await page.goto(appUrl(baseUrl, '/settings'));
  await page.getByRole('button', { name: /^Mahnwesen/ }).click();
};

test('a new profile starts with three dunning levels; levels can be added, removed and restored', async () => {
  desktop = await launchDesktopApp();
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Billme einrichten' })).toBeVisible();
  // The wizard keeps every setting it does not ask for; finish it with the company data only.
  const fresh = await getDesktopSettings(page);
  await setDesktopSettings(page, { ...fresh, onboardingCompleted: true, company: { ...fresh.company, name: 'Neu GmbH', street: 'Weg 1', zip: '10115', city: 'Berlin' } });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Billme einrichten' })).toHaveCount(0);

  await openDunningSettings(page, baseUrl);
  await expect(page.getByLabel('Name der Mahnstufe 1')).toHaveValue('Zahlungserinnerung');
  await expect(page.getByLabel('Name der Mahnstufe 2')).toHaveValue('1. Mahnung');
  await expect(page.getByLabel('Name der Mahnstufe 3')).toHaveValue('2. Mahnung');
  await shot('default-levels');

  await page.getByRole('button', { name: 'Stufe hinzufügen' }).click();
  await page.getByLabel('Name der Mahnstufe 4').fill('Letzte Mahnung');
  await page.getByRole('button', { name: 'Mahnstufe 2 entfernen' }).click();
  await page.getByRole('button', { name: 'Einstellungen speichern' }).click();
  await expect(page.getByText('Einstellungen gespeichert!')).toBeVisible();
  const saved = (await getDesktopSettings(page)).dunning.levels;
  expect(saved.map((level) => [level.id, level.name])).toEqual([[1, 'Zahlungserinnerung'], [2, '2. Mahnung'], [3, 'Letzte Mahnung']]);
  await shot('levels-edited');

  // An older profile saved without any level gets the defaults back with one click.
  const settings = await getDesktopSettings(page);
  await setDesktopSettings(page, { ...settings, dunning: { ...settings.dunning, levels: [] } });
  await page.reload();
  await openDunningSettings(page, baseUrl);
  await page.getByRole('button', { name: 'Standardstufen anlegen' }).click();
  await expect(page.getByLabel('Name der Mahnstufe 3')).toHaveValue('2. Mahnung');
  await page.getByRole('button', { name: 'Einstellungen speichern' }).click();
  await expect(page.getByText('Einstellungen gespeichert!').first()).toBeVisible();
  expect((await getDesktopSettings(page)).dunning.levels.map((level) => level.fee)).toEqual([0, 2.5, 5]);
  await shot('defaults-restored');
});

test('"Mahnung erstellen" works in the detail view, stops at the last level, and every level letter can be previewed and saved as PDF', async () => {
  desktop = await launchDesktopApp();
  const { page, baseUrl } = desktop;
  await seedDesktopData(page);
  const shot = createShooter(page);
  const number = (await invokeDesktopIpc(page, 'invoices:list', {})).find((invoice) => invoice.id === 'inv-open-1').number;
  await page.goto(appUrl(baseUrl, '/documents'));
  await page.getByRole('row', { name: `Rechnung ${number} öffnen` }).click();
  await expect(page.getByRole('heading', { name: number })).toBeVisible();

  for (const [level, name, fees] of [[1, 'Zahlungserinnerung', null], [2, '1. Mahnung', '2,50'], [3, '2. Mahnung', '7,50']]) {
    await page.getByRole('button', { name: 'Mahnung erstellen' }).click();
    const confirm = page.getByRole('dialog', { name: 'Mahnung erstellen' });
    await expect(confirm, 'the confirmation opens in the detail view').toBeVisible();
    await expect(confirm).toContainText(name);
    await confirm.getByRole('button', { name: 'Erstellen' }).click();
    await expect.poll(async () => (await invokeDesktopIpc(page, 'invoices:list', {})).find((invoice) => invoice.id === 'inv-open-1').dunningLevel).toBe(level);
    await expect(page.getByRole('heading', { name: number }), 'still in the detail view').toBeVisible();
    await expect(page.getByTestId('dunning-badge')).toHaveText(name);
    if (fees) await expect(page.getByTestId('dunning-fees'), 'the fees charged so far').toContainText(fees);
    else await expect(page.getByTestId('dunning-fees')).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: 'Mahnung erstellen' }), 'no reminder beyond the last level').toHaveCount(0);
  await shot('last-level');

  await page.getByRole('button', { name: 'Mahnschreiben' }).click();
  const letter = page.getByRole('dialog', { name: 'Mahnschreiben' });
  await expect(letter).toBeVisible();
  await letter.getByLabel('Mahnstufe').selectOption({ label: '1. Mahnung' });
  await expect(letter.getByTestId('dunning-letter-preview')).toContainText(number);
  await expect(letter.getByTestId('dunning-letter-preview')).toContainText('2,50');
  await shot('letter-preview');
  const exportsDir = path.join(desktop.userDataDir, 'exports');
  const before = fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir) : [];
  await letter.getByRole('button', { name: 'PDF erstellen' }).click();
  await expect(page.getByText('PDF gespeichert')).toBeVisible();
  const created = fs.readdirSync(exportsDir).filter((file) => !before.includes(file));
  expect(created.length).toBe(1);
  expect(created[0]).toMatch(/1\. Mahnung/);
  fs.copyFileSync(path.join(exportsDir, created[0]), test.info().outputPath('dunning-letter.pdf'));
  await letter.getByRole('button', { name: 'Schließen', exact: true }).click();

  // The Mahnlauf dialog shows the same letter per invoice.
  await page.getByRole('button', { name: 'Zurück zur Liste' }).click();
  await page.getByRole('radiogroup', { name: 'Status' }).getByRole('radio', { name: 'Überfällig' }).click();
  await page.getByRole('button', { name: /Mahnlauf \(\d+\)/ }).click();
  const run = page.getByRole('dialog', { name: 'Mahnlauf starten' });
  await run.getByRole('button', { name: `Mahnschreiben ${number} ansehen` }).click();
  await expect(page.getByRole('dialog', { name: 'Mahnschreiben' }).getByTestId('dunning-letter-preview')).toContainText(number);
  await shot('letter-from-run');
});
