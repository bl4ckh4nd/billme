import { expect, test } from '@playwright/test';
import { appUrl, importPendingProTransaction, invokeDesktopIpc, launchDesktopApp, PRO_DOUBLE_ENTRY_SETTINGS, seedDesktopData } from '../support.mjs';
import { shooter } from './pro-p3-support.mjs';

/**
 * Last follow-ups of the Pro walkthrough (24.10.2026), clicked like the user and read back through the backend.
 *
 * How this can fail:
 * - Pro EÜR profile: a new bank account refused because nobody picked an SKR account (B27)
 * - "Bearbeiten" on a Pro bank account opens an empty dialog and saving creates a second account
 * - inbox: a line keeps "Ohne Beleg" after its Beleg was attached in the editor, until a reload
 */

let desktop;

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

const startPro = async (settingsOverrides) => {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedDesktopData(desktop.page, { app: 'pro', ...(settingsOverrides ? { settingsOverrides } : {}) });
  await desktop.page.reload();
  return desktop;
};

test('Pro EÜR: a bank account is created without an SKR choice and books on the bank role (B27)', async () => {
  const { page, baseUrl } = await startPro();
  const shot = shooter(page);
  expect((await invokeDesktopIpc(page, 'settings:get')).businessReportingProfile.profitDetermination).toBe('eur');
  await page.goto(appUrl(baseUrl, '/accounts'));
  await page.getByRole('button', { name: 'Neues Konto' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Neues Bankkonto' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel(/Standard-SKR-Konto/), 'no SKR choice under EÜR').toHaveCount(0);
  await dialog.getByLabel('Kontoname').fill('EÜR Geschäftskonto');
  await shot('eur-bank-account');
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(dialog).toHaveCount(0);
  const account = (await invokeDesktopIpc(page, 'accounts:list')).find((row) => row.name === 'EÜR Geschäftskonto');
  expect(account?.defaultSkrAccountNumber).toBe('1200');
});

test('the inbox shows a line "mit Beleg" right after the Beleg is attached in the editor, without a reload', async () => {
  const { page, baseUrl } = await startPro(PRO_DOUBLE_ENTRY_SETTINGS);
  const shot = shooter(page);
  await importPendingProTransaction(page, 'inbox-beleg', { counterparty: 'Inbox Beleg Händler', amount: -35.7 });
  await page.reload();
  await page.goto(appUrl(baseUrl, '/accounting?view=inbox'));
  const preview = page.locator('aside').filter({ hasText: 'Transaktionsdetails' });
  await page.getByText('Inbox Beleg Händler').first().click();
  await expect(preview.getByText('Ohne Beleg', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Erweitern' }).click();
  const aside = page.getByRole('complementary', { name: 'Beleg, Prüfungen und Verlauf' });
  await aside.locator('input[type="file"]').setInputFiles({ name: 'kassenbon.pdf', mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4\n${Date.now()}`) });
  await expect(aside.getByTestId('receipt-message')).toHaveText(/Beleg archiviert/);
  await page.getByRole('button', { name: 'Zurück zur Inbox' }).click();

  await page.getByText('Inbox Beleg Händler').first().click();
  await expect(preview.getByText('Inbox Beleg Händler').first()).toBeVisible();
  await expect(preview.getByText('Ohne Beleg', { exact: true }), 'the line is "mit Beleg" without a reload').toHaveCount(0);
  await shot('inbox-mit-beleg');
});

test('"Bearbeiten" changes the Pro bank account itself instead of creating a second one', async () => {
  const { page, baseUrl } = await startPro(PRO_DOUBLE_ENTRY_SETTINGS);
  const before = await invokeDesktopIpc(page, 'accounts:list');
  const original = before[0];
  await page.goto(appUrl(baseUrl, '/accounts'));
  await page.getByRole('button', { name: `Aktionen für ${original.name}` }).first().click();
  await page.getByRole('menuitem', { name: 'Bearbeiten' }).click();
  const dialog = page.getByRole('dialog', { name: 'Bankkonto bearbeiten' });
  await expect(dialog.getByLabel('Kontoname')).toHaveValue(original.name);
  await dialog.getByLabel('Kontoname').fill('Umbenanntes Geschäftskonto');
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(dialog).toHaveCount(0);
  const after = await invokeDesktopIpc(page, 'accounts:list');
  expect(after).toHaveLength(before.length);
  const edited = after.find((row) => row.id === original.id);
  expect(edited?.name).toBe('Umbenanntes Geschäftskonto');
  expect(edited?.defaultSkrAccountNumber, 'the ledger account stays').toBe(original.defaultSkrAccountNumber);
});
