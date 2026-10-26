import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, PRO_DOUBLE_ENTRY_SETTINGS, seedDesktopData } from '../support.mjs';

/**
 * Journal import in the Sonderbuchungen of the Pro workspace: a file from another bookkeeping is checked first and
 * booked only on the second, explicit step.
 *
 * How this can fail:
 * - the check books, or the import button is offered before a check
 * - a file with an unknown account offers the import, or books its valid entries anyway
 * - the import reports success without the entries appearing in the journal, or books them twice on a second click
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

const csv = (rows) => Buffer.from(['Buchung;Datum;Belegnr;Buchungstext;Konto;Soll;Haben;Steuerfall', ...rows].join('\n'), 'utf8');
const imported = async (page) => (await invokeDesktopIpc(page, 'pro:listJournalEntries', { limit: 500 })).filter((entry) => entry.sourceType === 'journal_import');

test('a journal CSV is checked, refused with an unknown account and booked once after the explicit import', async () => {
  const { page, baseUrl } = desktop;
  const shot = (name) => page.screenshot({ path: test.info().outputPath(`${name}.png`), fullPage: true });
  await page.goto(appUrl(baseUrl, '/accounting?view=special'));
  const panel = page.getByTestId('journal-import-panel');
  await expect(panel).toBeVisible();
  const check = panel.getByRole('button', { name: 'Datei prüfen' });
  const book = panel.getByRole('button', { name: /Buchungen verbindlich importieren/ });

  await panel.getByLabel('Importdatei').setInputFiles({ name: 'falsch.csv', mimeType: 'text/csv', buffer: csv(['1;05.03.2026;B-1;Bürobedarf;4930;10,00;;', '1;;;;12;;10,00;']) });
  await expect(panel.getByRole('combobox', { name: 'Format' })).toHaveValue('journal_csv');
  await panel.getByRole('textbox', { name: 'Begründung des Imports' }).fill('Übernahme aus der Altbuchhaltung');
  await check.click();
  await expect(panel.getByTestId('journal-import-blocking')).toContainText('Konto 12');
  await expect(book).toBeDisabled();
  await shot('journal-import-refused');

  await panel.getByLabel('Importdatei').setInputFiles({ name: 'journal.csv', mimeType: 'text/csv', buffer: csv([
    '1;05.03.2026;ER-1;Bürobedarf netto;4930;100,00;;VSt19',
    '1;;;;1576;19,00;;',
    '1;;;;1200;;119,00;',
    '2;06.03.2026;AR-1;Beratung brutto;1200;238,00;;',
    '2;;;;8400;;238,00;USt19',
  ]) });
  await expect(book).toBeDisabled();
  await check.click();
  await expect(panel.getByTestId('journal-import-new')).toHaveText('2');
  expect(await imported(page), 'the check books nothing').toEqual([]);
  await shot('journal-import-checked');

  await book.click();
  await expect(panel.getByTestId('journal-import-feedback')).toHaveText('2 Buchungen importiert.');
  await expect(book).toBeDisabled();
  const entries = await imported(page);
  expect(entries.map((entry) => entry.reference).sort()).toEqual(['AR-1', 'ER-1']);
  await shot('journal-import-booked');

  await check.click();
  await expect(panel.getByTestId('journal-import-new')).toHaveText('0');
  expect(await imported(page), 'the same file books once').toHaveLength(2);
});
