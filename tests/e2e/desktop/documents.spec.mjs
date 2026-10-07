import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';
import { createShooter } from './lite-support.mjs';

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp();
  await seedDesktopData(desktop.page);
  // Seeding writes past react-query; reload so views read the seeded rows.
  await desktop.page.reload();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('opens a document and converts an accepted offer to an invoice', async () => {
  const { page, baseUrl } = desktop;
  const invoicesBefore = await invokeDesktopIpc(page, 'invoices:list', {});
  const invoiceIdsBefore = new Set(invoicesBefore.map((invoice) => invoice.id));
  const acceptedOffer = (await invokeDesktopIpc(page, 'offers:list', {})).find(
    (offer) =>
      offer.acceptedAt
      || offer.acceptedBy
      || offer.shareDecision === 'accepted'
      || offer.status === 'accepted',
  );
  expect(acceptedOffer).toBeTruthy();

  const shot = createShooter(page);

  await page.goto(appUrl(baseUrl, '/documents'));

  await expect(page.getByRole('banner').getByRole('button', { name: 'Vorlagen' })).toBeVisible();
  const firstRow = page.getByRole('row', { name: /^Rechnung RE-\d{4}-\d{3} öffnen$/ }).first();
  await expect(firstRow).toBeVisible();
  const openedInvoiceNumber = /RE-\d{4}-\d{3}/.exec((await firstRow.getAttribute('aria-label')) ?? '')?.[0];
  expect(openedInvoiceNumber).toBeTruthy();
  await shot('invoice-list');
  await firstRow.click();
  await expect(page.getByRole('heading', { name: openedInvoiceNumber, level: 1 })).toBeVisible();
  await shot('invoice-detail');
  await invokeDesktopIpc(page, 'documents:convertOfferToInvoice', { offerId: acceptedOffer.id });

  const invoicesAfter = await invokeDesktopIpc(page, 'invoices:list', {});
  expect(invoicesAfter).toHaveLength(invoicesBefore.length + 1);
  const createdInvoice = invoicesAfter.find((invoice) => !invoiceIdsBefore.has(invoice.id));
  expect(createdInvoice?.clientId).toBe(acceptedOffer.clientId);
  expect(createdInvoice?.amount).toBe(acceptedOffer.amount);
});
