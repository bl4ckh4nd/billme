import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';
import { createShooter } from './lite-support.mjs';

/**
 * A long document list renders its first 100 rows and the rest on request.
 *
 * How this can fail:
 * - every row rendered at once again (the list freezes the window for seconds)
 * - the remaining documents unreachable: no "Weitere anzeigen", or it adds nothing
 * - search or the status filter only looking at the rendered rows
 * - a raised limit leaking into another search, so the count no longer matches
 */

let desktop;

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('the document list pages long lists without hiding documents from search', async () => {
  desktop = await launchDesktopApp();
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  await seedDesktopData(page);

  const drafts = 120;
  const lastNumber = await page.evaluate(async (count) => {
    let number = '';
    for (let i = 0; i < count; i++) {
      const reservation = await window.billmeApi.numbers.reserve({ kind: 'invoice' });
      number = reservation.number;
      await window.billmeApi.invoices.upsert({
        reason: 'E2E Liste',
        invoice: {
          id: `paging-${i}`, number, numberReservationId: reservation.reservationId, clientId: 'c1', clientNumber: 'KD-0001',
          client: `Paging Kunde ${i}`, clientEmail: 'paging@example.de', clientAddress: 'Musterstrasse 1\n12345 Musterstadt',
          date: '2026-03-01', dueDate: '2026-03-15', amount: 100, status: 'draft', dunningLevel: 0,
          taxMode: 'small_business_19_ustg', items: [{ kind: 'item', description: 'Leistung', quantity: 1, price: 100, total: 100 }], payments: [], history: [],
        },
      });
    }
    return number;
  }, drafts);
  const total = (await invokeDesktopIpc(page, 'invoices:list')).length;
  expect(total).toBeGreaterThan(drafts);

  await page.goto(appUrl(baseUrl, '/documents'));
  await page.reload(); // the renderer cached the list before the drafts existed
  const table = page.getByRole('table', { name: 'Rechnungen' });
  const rows = table.locator('tbody tr');
  await expect(rows).toHaveCount(100);
  await expect(page.getByText(`100 von ${total} angezeigt`)).toBeVisible();
  await shot('first-page');

  // Search covers all documents, not only the rendered ones.
  const search = page.getByRole('searchbox', { name: 'Rechnungen und Angebote durchsuchen' });
  await search.fill(lastNumber);
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(lastNumber);
  await expect(page.getByRole('button', { name: 'Weitere anzeigen' })).toHaveCount(0);
  await search.fill('');
  await expect(rows).toHaveCount(100);

  await page.getByRole('button', { name: 'Weitere anzeigen' }).click();
  await expect(rows).toHaveCount(total);
  await expect(page.getByRole('button', { name: 'Weitere anzeigen' })).toHaveCount(0);
  await shot('all-rows');

  // A new search starts from the first page again.
  await search.fill('Paging Kunde');
  await expect(rows).toHaveCount(100);
  await expect(page.getByText(`100 von ${drafts} angezeigt`)).toBeVisible();
});
