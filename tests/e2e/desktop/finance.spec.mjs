import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp();
  await seedDesktopData(desktop.page);
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('links an open bank transaction to an invoice', async () => {
  const { page, baseUrl } = desktop;
  await page.goto(appUrl(baseUrl, '/accounts'));

  await expect(page.getByRole('heading', { name: 'Konten & Transaktionen' })).toBeVisible();
  await page.getByRole('button', { name: 'Transaktionen zuordnen' }).click();
  await expect(page.getByRole('heading', { name: 'Transaktionen bearbeiten' })).toBeVisible();

  await page.getByPlaceholder('Transaktion suchen...').fill('Gutschrift');
  await page.getByText('StartUp Berlin AG').first().click();
  await page.getByRole('button', { name: 'Zuordnen und als bezahlt markieren' }).first().click();

  await expect(page.getByText(/erfolgreich zugeordnet/i)).toBeVisible();

  const invoices = await invokeDesktopIpc(page, 'invoices:list', {});
  const linkedInvoice = invoices.find((invoice) => invoice.id === 'inv-open-1');
  expect(linkedInvoice?.status).toBe('paid');

  const linkedTransactions = await invokeDesktopIpc(page, 'transactions:list', {
    accountId: 'acc1',
    linkedOnly: true,
  });
  expect(linkedTransactions.some((tx) => tx.id === 'tx-1' && tx.linkedInvoiceId === 'inv-open-1')).toBeTruthy();
});

test('classifies an EÜR entry and exports CSV and PDF', async () => {
  const { page, baseUrl } = desktop;
  const taxYear = new Date().getFullYear();

  const unclassified = await invokeDesktopIpc(page, 'eur:listItems', {
    taxYear,
    sourceType: 'transaction',
    status: 'all',
  });
  const targetItem = unclassified.find((item) => item.counterparty === 'Adobe Systems') ?? unclassified[0];
  expect(targetItem).toBeTruthy();

  await invokeDesktopIpc(page, 'eur:upsertClassification', {
    sourceType: targetItem.sourceType,
    sourceId: targetItem.sourceId,
    taxYear,
    excluded: true,
    vatMode: 'none',
    note: 'E2E Klassifizierung',
  });

  await page.goto(appUrl(baseUrl, '/eur'));

  await expect(page.getByRole('heading', { name: 'Buchen', exact: true })).toBeVisible();

  const classifiedItems = await invokeDesktopIpc(page, 'eur:listItems', {
    taxYear,
    sourceType: 'transaction',
    status: 'excluded',
  });
  expect(classifiedItems.some((item) => item.sourceId === targetItem.sourceId)).toBeTruthy();

  await page.getByRole('button', { name: 'CSV exportieren' }).click();
  const csvContent = await invokeDesktopIpc(page, 'eur:exportCsv', { taxYear });
  expect(csvContent).toContain('Kennziffer');

  await page.getByRole('button', { name: 'PDF exportieren' }).click();
  await expect(page.getByText(/PDF gespeichert:/)).toBeVisible();
});
