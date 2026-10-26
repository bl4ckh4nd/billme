import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, PRO_DOUBLE_ENTRY_SETTINGS, seedDesktopData } from '../support.mjs';

/**
 * The overview of a double-entry business read from the journal: a ledger taken over by journal import (no bank
 * lines, no invoices) fills the KPIs and charts, a month of the chart opens its BWA, and the GuV/BWA compare with
 * the previous year.
 *
 * How this can fail:
 * - the overview stays empty ("Noch keine Zahlungen") because it only reads bank lines
 * - the liquidity ignores the ledger balance of the bank account, the year comparison is missing
 * - a month of the chart opens Auswertungen on another range or tab
 * - "Vergleich: Vorjahr" shows no Vorjahr column, or the wrong amounts in it
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

// Two years before the seed's own postings (current year), so the comparison reads only the imported ones.
const Y2 = new Date().getFullYear() - 2;
const Y1 = Y2 - 1;

const journalCsv = () => {
  const rows = ['Buchung;Datum;Belegnr;Buchungstext;Konto;Soll;Haben;Steuerfall'];
  let entry = 0;
  const add = (date, reference, text, lines) => {
    entry += 1;
    lines.forEach(([account, debit, credit, tax], index) => rows.push([entry, index ? '' : date, index ? '' : reference, index ? '' : text, account, debit, credit, tax ?? ''].join(';')));
  };
  // Y1: 12 × 1.000 € net revenue, 600 € rent; Y2: 12 × 1.500 €, 600 € rent, 1.000 € wages in March.
  for (const [year, revenue] of [[Y1, '1190,00'], [Y2, '1785,00']]) {
    for (let month = 1; month <= 12; month += 1) {
      const mm = String(month).padStart(2, '0');
      add(`15.${mm}.${year}`, `AR-${year}-${mm}`, 'Beratung', [['1200', revenue, ''], ['8400', '', revenue, 'USt19']]);
      add(`01.${mm}.${year}`, `MI-${year}-${mm}`, 'Miete', [['4210', '600,00', ''], ['1200', '', '600,00']]);
    }
  }
  add(`31.03.${Y2}`, `LG-${Y2}-03`, 'Gehalt', [['4120', '1000,00', ''], ['1200', '', '1000,00']]);
  return rows.join('\n');
};

test('a ledger taken over by journal import fills the overview; a month opens its BWA, which compares with the Vorjahr', async () => {
  const { page, baseUrl } = desktop;
  const shot = (name) => page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
  const imported = await invokeDesktopIpc(page, 'pro:importJournal', {
    reason: 'Übernahme', format: 'journal_csv', fileName: 'journal.csv', contentBase64: Buffer.from(journalCsv()).toString('base64'), dryRun: false,
  });
  expect(imported.postedCount, JSON.stringify(imported.issues)).toBe(49);

  await page.goto(appUrl(baseUrl, '/'));
  const flows = page.locator('section', { has: page.locator('#dashboard-ledger-flows') });
  await expect(flows).toBeVisible();
  await expect(page.getByText('Noch keine Zahlungen')).toHaveCount(0);
  await expect(flows.getByRole('option', { name: String(Y1) })).toHaveCount(1);
  await flows.getByRole('combobox', { name: 'Zeitraum' }).selectOption(String(Y2));
  await expect(flows.getByText(`Erträge ${Y2}`)).toBeVisible();
  await expect(flows.locator('dd').first()).toHaveText(/18\.000,00/);
  // The liquidity is the ledger balance of the bank account, the one the server reports.
  const overview = await invokeDesktopIpc(page, 'pro:getLedgerOverview', {});
  expect(overview.liquidity.accounts.map((account) => account.accountNumber)).toContain('1200');
  await expect(page.getByText(/Laut Buchhaltung/)).toBeVisible();
  await expect(page.locator('section[aria-label="Kennzahlen"]')).toContainText(new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(overview.liquidity.total));
  await expect(page.locator('#dashboard-ledger-years')).toBeVisible();
  await expect(page.locator('#dashboard-ledger-expenses')).toBeVisible();
  await expect(page.locator('section', { has: page.locator('#dashboard-ledger-expenses') })).toContainText('Raumkosten');
  await shot('ledger-dashboard');

  await flows.getByRole('combobox', { name: 'Zeitraum' }).selectOption('all');
  await expect(flows.getByText('Erträge aller Jahre')).toBeVisible();
  await shot('ledger-dashboard-all-years');

  // The screen-reader table carries a button per month; the chart click calls the same handler.
  await flows.getByRole('button', { name: `BWA öffnen: März ${Y2}` }).dispatchEvent('click');
  await expect(page).toHaveURL(/view=reports/);
  await expect(page).toHaveURL(/tab=bwa01/);
  await expect(page).toHaveURL(new RegExp(`from=${Y2}-03-01`));
  await expect(page.getByLabel('Periode von')).toHaveValue(`${Y2}-03`);
  await expect(page.getByLabel('Periode bis')).toHaveValue(`${Y2}-03`);

  await page.getByRole('combobox', { name: 'Vergleich' }).selectOption('prev_year');
  const table = page.getByRole('table').filter({ has: page.getByRole('columnheader', { name: 'Vorjahr' }) });
  await expect(table).toBeVisible();
  // Umsatzerlöse in March of Y2: 1.500 against 1.000 in March of Y1.
  const revenueRow = table.getByRole('row').filter({ hasText: 'Umsatzerlöse' });
  await expect(revenueRow).toContainText('1.500,00');
  await expect(revenueRow).toContainText('1.000,00');
  await expect(revenueRow).toContainText('+50');
  await shot('bwa-compared');
});
