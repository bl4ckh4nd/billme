import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';
import { createShooter, seedBankTransactions } from './lite-support.mjs';

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp();
  await seedDesktopData(desktop.page);
  await seedBankTransactions(desktop.page);
  // Seeding writes past react-query; reload so views read the seeded rows.
  await desktop.page.reload();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('links an open bank transaction to an invoice', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  await page.goto(appUrl(baseUrl, '/accounts'));

  await expect(page.getByRole('banner').getByRole('heading', { name: 'Bankabgleich', level: 1 })).toBeVisible();
  await page.getByRole('textbox', { name: 'Transaktion suchen' }).fill('Gutschrift');
  await page.getByRole('button', { name: /StartUp Berlin AG.*Gutschrift/ }).click();
  await expect(page.getByText('RE-2026-201', { exact: true })).toBeVisible();
  await shot('suggested-invoice');
  await page.getByRole('button', { name: 'Zahlung zuordnen' }).click();

  await expect(page.getByText(/Zahlung zugeordnet/)).toBeVisible();
  await shot('linked');

  const invoices = await invokeDesktopIpc(page, 'invoices:list', {});
  expect(invoices.find((invoice) => invoice.id === 'inv-open-1')?.status).toBe('paid');

  const linkedTransactions = await invokeDesktopIpc(page, 'transactions:list', { accountId: 'acc1', linkedOnly: true });
  expect(linkedTransactions.some((tx) => tx.counterparty === 'StartUp Berlin AG' && tx.linkedInvoiceId === 'inv-open-1')).toBeTruthy();
});

test('classifies an EÜR entry and exports the report', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const taxYear = new Date().getFullYear();
  const bankItems = async (status) => await invokeDesktopIpc(page, 'eur:listItems', { taxYear, sourceType: 'transaction', status });

  const target = (await bankItems('all')).find((item) => item.counterparty === 'Adobe Systems');
  expect(target).toBeTruthy();
  expect(target.classification).toBeUndefined();

  await page.goto(appUrl(baseUrl, '/eur'));
  await expect(page.getByRole('banner').getByRole('heading', { name: 'Buchen', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: /Adobe Systems/ }).click();
  const panel = page.getByRole('region', { name: 'Klassifizierung' });
  await expect(panel.getByRole('heading', { name: 'Adobe Systems' })).toBeVisible();
  await expect(panel.getByRole('combobox', { name: 'Kategorie' })).toHaveValue(/.+/);
  await panel.getByRole('textbox', { name: 'Begründung für EÜR-Änderung' }).fill('E2E Klassifizierung');
  await shot('classification-form');
  await panel.getByRole('button', { name: 'Klassifizierung speichern' }).click();
  await expect(page.getByText('Klassifizierung gespeichert', { exact: true })).toBeVisible();

  const classified = (await bankItems('all')).find((item) => item.sourceId === target.sourceId);
  expect(classified.classification).toMatchObject({ excluded: false });
  expect(classified.classification.eurLineId).toBeTruthy();

  // The classified expense lands in the Anlage EÜR.
  await page.goto(appUrl(baseUrl, '/statistics?view=eur'));
  await expect(page.getByRole('heading', { name: /^Anlage EÜR/ })).toBeVisible();
  await expect(page.getByText(/Ausgaben\s*49,90\s*€/)).toBeVisible();
  await shot('eur-report');

  // ponytail: the CSV button starts a Chromium download, which opens a native save dialog the E2E run cannot answer; the content comes through the same IPC route.
  const csvContent = await invokeDesktopIpc(page, 'eur:exportCsv', { taxYear });
  expect(csvContent).toContain('Kennziffer');
  expect(csvContent).toContain('49,90');

  await page.getByRole('button', { name: 'PDF exportieren' }).click();
  await expect(page.getByText(/PDF gespeichert:/)).toBeVisible();
  await shot('eur-pdf-exported');
});
