import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';

/**
 * An incoming invoice typed with an account the chart does not know: it cannot be released, the same form corrects
 * the same document (no second invoice, no second vendor), and the corrected invoice is released and posted.
 * A vendor's Standard-Aufwandskonto is set in the form and books positions without account; the same name again
 * reuses that vendor visibly, and a differing account is refused instead of being dropped silently.
 */
let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedDesktopData(desktop.page, { app: 'pro' });
  await desktop.page.reload();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('an incoming invoice with an unknown account is refused on release, corrected in place and then posted', async () => {
  const { page, baseUrl } = desktop;
  const number = `ER-KORR-${Date.now().toString(36)}`;
  const vendor = `Bau Schmidt ${Date.now().toString(36)}`;
  await page.goto(appUrl(baseUrl, '/accounting?view=opos'));
  await page.getByLabel('Rechnungsnummer').fill(number);
  await page.getByLabel('Kreditorname').fill(vendor);
  await page.getByLabel('Rechnungsdatum').fill('2026-05-04');
  await page.getByLabel('Fällig am').fill('2026-05-18');
  await page.getByLabel('Position', { exact: true }).fill('Bauleistung');
  await page.getByLabel('Menge', { exact: true }).fill('1');
  await page.getByLabel('Einzelpreis', { exact: true }).fill('1000');
  await page.getByLabel('Steuersatz', { exact: true }).fill('19');
  await page.getByLabel('Konto', { exact: true }).fill('4400');
  await page.getByLabel('Begründung', { exact: true }).last().fill('Rechnung erfasst');
  await page.getByRole('button', { name: 'Entwurf speichern' }).click();
  await expect(page.getByText(/als Entwurf gespeichert/).first()).toBeVisible();

  await page.getByRole('button', { name: 'Für Buchung freigeben' }).click();
  await expect(page.getByText(/Das Konto 4400 ist nicht im Kontenrahmen SKR03/).first()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('01-release-refused.png'), fullPage: true });

  await page.getByLabel('Konto', { exact: true }).fill('3100');
  await page.getByRole('button', { name: 'Entwurf speichern' }).click();
  await expect(page.getByText(/als Entwurf gespeichert/).first()).toBeVisible();
  const mine = (await invokeDesktopIpc(page, 'pro:listIncomingInvoices')).filter((invoice) => invoice.number === number);
  expect(mine.map((invoice) => [invoice.status, invoice.lines[0].accountNumber]), 'the same document was corrected').toEqual([['draft', '3100']]);
  expect((await invokeDesktopIpc(page, 'pro:listVendors')).filter((candidate) => candidate.name === vendor)).toHaveLength(1);

  await page.getByRole('button', { name: 'Für Buchung freigeben' }).click();
  await expect(page.getByText(/zur Buchung freigegeben/).first()).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: 'Buchen', exact: true }).click();
  await expect.poll(async () => (await invokeDesktopIpc(page, 'pro:listIncomingInvoices')).find((invoice) => invoice.id === mine[0].id).accountingStatus).toBe('posted');
  await page.screenshot({ path: test.info().outputPath('02-corrected-and-posted.png'), fullPage: true });
});

test('a new vendor gets its Standard-Aufwandskonto from the form; the same name again opens that vendor, a differing account is refused', async () => {
  const { page, baseUrl } = desktop;
  const stamp = Date.now().toString(36);
  const vendor = `Hosting Kunz ${stamp}`;
  const fill = async (number, { account } = {}) => {
    await page.getByLabel('Rechnungsnummer').fill(number);
    await page.getByLabel('Kreditor', { exact: true }).selectOption('');
    await page.getByLabel('Kreditorname').fill(vendor);
    if (account !== undefined) await page.getByLabel('Standard-Aufwandskonto').fill(account);
    await page.getByLabel('Rechnungsdatum').fill('2026-05-04');
    await page.getByLabel('Fällig am').fill('2026-05-18');
    await page.getByLabel('Position', { exact: true }).fill('Hosting');
    await page.getByLabel('Menge', { exact: true }).fill('1');
    await page.getByLabel('Einzelpreis', { exact: true }).fill('100');
    await page.getByLabel('Steuersatz', { exact: true }).fill('19');
    await page.getByLabel('Konto', { exact: true }).fill('');
    await page.getByLabel('Begründung', { exact: true }).last().fill('Rechnung erfasst');
    await page.getByRole('button', { name: 'Entwurf speichern' }).click();
  };
  await page.goto(appUrl(baseUrl, '/accounting?view=opos'));

  await fill(`ER-STD-${stamp}`, { account: '4930' });
  await expect(page.getByText(/als Entwurf gespeichert/).first()).toBeVisible();
  const vendors = async () => (await invokeDesktopIpc(page, 'pro:listVendors')).filter((candidate) => candidate.name === vendor);
  expect((await vendors()).map((candidate) => candidate.defaultExpenseAccount)).toEqual(['4930']);
  await expect(page.getByLabel('Konto', { exact: true })).toHaveAttribute('placeholder', 'Standard 4930');
  await page.getByRole('button', { name: 'Für Buchung freigeben' }).click();
  await expect(page.getByText(/zur Buchung freigegeben/).first()).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: 'Buchen', exact: true }).click();
  const first = (await invokeDesktopIpc(page, 'pro:listIncomingInvoices')).find((invoice) => invoice.number === `ER-STD-${stamp}`);
  await expect.poll(async () => (await invokeDesktopIpc(page, 'pro:listIncomingInvoices')).find((invoice) => invoice.id === first.id).accountingStatus).toBe('posted');
  const entry = (await invokeDesktopIpc(page, 'pro:listJournalEntries', {})).find((candidate) => candidate.reference === `ER-STD-${stamp}`);
  expect(entry.lines.find((line) => line.debitAmount === 100)?.accountNumber, 'the position without account is booked on the vendor default').toBe('4930');

  // "Neuen Kreditor anlegen" with the same name uses the existing vendor and says so.
  await fill(`ER-STD2-${stamp}`);
  await expect(page.getByText(`Lieferant „${vendor}“ existiert bereits und wurde verwendet.`, { exact: false }).first()).toBeVisible();
  expect(await vendors()).toHaveLength(1);

  // The same name with another Standard-Aufwandskonto is refused instead of dropping the difference.
  await fill(`ER-STD3-${stamp}`, { account: '4920' });
  await expect(page.getByText(/existiert bereits, abweichend: Standard-Aufwandskonto/).first()).toBeVisible();
  expect((await vendors()).map((candidate) => candidate.defaultExpenseAccount)).toEqual(['4930']);
  expect((await invokeDesktopIpc(page, 'pro:listIncomingInvoices')).some((invoice) => invoice.number === `ER-STD3-${stamp}`)).toBe(false);
  await page.screenshot({ path: test.info().outputPath('03-vendor-exists.png'), fullPage: true });
});
