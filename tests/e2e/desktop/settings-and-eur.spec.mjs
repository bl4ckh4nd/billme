import { expect, test } from '@playwright/test';
import { appUrl, getDesktopSettings, invokeDesktopIpc, launchDesktopApp, seedDesktopData, setDesktopSettings, setStoredLiteSettings } from '../support.mjs';
import fs from 'node:fs';
import { createShooter, seedBankTransactions, writeBankCsv } from './lite-support.mjs';

/**
 * Settings sections and the EÜR worklist of the Lite UI, verified through the backend.
 *
 * How this can fail:
 * - settings: a new category, the payment term or a dunning fee not persisted by
 *   "Einstellungen speichern"; a mail test that reports success without a server;
 *   the audit check not reachable; the dark theme lost after a reload; the shortcut
 *   overview not opening; Lite offering GmbH or double-entry bookkeeping (it keeps
 *   no ledger, so that would switch it to SKR accounts it cannot book)
 * - EÜR: search or direction filter showing other rows; "exclude as private" not
 *   persisted or not reachable through the "Ausgeschl." filter; undo leaving the
 *   classification behind; a bank line marked regelmäßig wiederkehrend (10-Tage-Regel)
 *   staying in the year it flowed, or the mark not reachable from the line
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

test('Lite stays on EÜR: no GmbH, no double-entry switch, no Kontenrahmen', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  await page.goto(appUrl(baseUrl, '/settings'));
  await section(page, 'Rechtliches').click();
  await expect(page.getByTestId('profit-determination-value')).toHaveText('EÜR');
  await expect(page.getByLabel('Rechtsform').locator('option')).toHaveText(['Einzelunternehmen']);
  await expect(page.getByRole('button', { name: 'Ändern…' })).toHaveCount(0);
  await expect(page.getByText('Doppelte Buchführung mit Kontenrahmen gibt es in billme Pro.')).toBeVisible();
  await expect(page.getByLabel('Kontenrahmen')).toHaveCount(0);
  await shot('lite-eur-only');
});

test('a Lite GmbH profile left on double-entry gets back to EÜR through the legal form', async () => {
  const profile = { jurisdiction: 'DE', legalForm: 'gmbh', profitDetermination: 'double_entry', hgbSizeClass: 'micro', chart: 'SKR03', fiscalYearStart: '01-01', vatMethod: 'soll' };
  const refused = await setDesktopSettings(desktop.page, { ...(await getDesktopSettings(desktop.page)), businessReportingProfile: profile }).then(() => null, (error) => String(error));
  expect(refused, 'the Lite backend refuses double entry').toMatch(/nur mit EÜR/);
  await setStoredLiteSettings(desktop, (settings) => ({ ...settings, businessReportingProfile: profile }));
  const { page, baseUrl } = desktop;
  await page.goto(appUrl(baseUrl, '/settings'));
  await section(page, 'Rechtliches').click();
  await expect(page.getByTestId('profit-determination-value')).toHaveText('Doppelte Buchführung');
  await expect(page.getByText('billme Lite rechnet nur mit EÜR. Stelle die Rechtsform auf Einzelunternehmen um.')).toBeVisible();
  await expect(page.getByLabel('Kontenrahmen'), 'Lite never shows a chart of accounts').toHaveCount(0);
  await page.getByLabel('Rechtsform').selectOption('sole_proprietor');
  await expect(page.getByTestId('profit-determination-value')).toHaveText('EÜR');
  await page.getByRole('button', { name: 'Einstellungen speichern' }).click();
  await expect.poll(async () => (await getDesktopSettings(page)).businessReportingProfile?.profitDetermination).toBe('eur');
  await page.reload();
  await page.goto(appUrl(baseUrl, '/settings'));
  await section(page, 'Rechtliches').click();
  await expect(page.getByLabel('Rechtsform').locator('option'), 'GmbH is gone once left').toHaveText(['Einzelunternehmen']);
});

test('categories, payment term and dunning fee are saved; the mail test, the audit check, the theme and the shortcuts work', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const before = await getDesktopSettings(page);
  const level2 = before.dunning.levels[1];
  await page.goto(appUrl(baseUrl, '/settings'));

  await section(page, 'Kategorien').click();
  const categoryCount = before.catalog.categories.length;
  await page.getByRole('button', { name: 'Kategorie', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).nth(categoryCount).fill('Workshops');

  await section(page, 'Rechtliches').click();
  await page.getByLabel('Zahlungsziel (Tage)').fill('21');

  await section(page, 'Mahnwesen').click();
  await page.getByRole('switch', { name: 'Mahnwesen aktivieren' }).click();
  await page.getByLabel(`${level2.name}: Gebühr in Euro`).fill('7.5');
  await shot('dunning-fee');

  await page.getByRole('button', { name: 'Einstellungen speichern' }).click();
  await expect.poll(async () => {
    const saved = await getDesktopSettings(page);
    return [saved.catalog.categories.map((category) => category.name).includes('Workshops'), saved.legal.paymentTermsDays, saved.dunning.levels[1].fee, saved.automation.dunningEnabled];
  }).toEqual([true, 21, 7.5, true]);

  // A mail server that does not answer: the test must report the failure, never success.
  await section(page, 'E-Mail').click();
  await page.getByRole('button', { name: /^SMTP/ }).click();
  await page.getByLabel('Server (Host)').fill('127.0.0.1');
  await page.getByLabel('Port', { exact: true }).fill('1');
  await page.getByLabel('Benutzername', { exact: true }).fill('test@example.com');
  await page.getByLabel('Passwort', { exact: true }).fill('geheim');
  await page.getByRole('button', { name: 'Verbindung testen' }).click();
  const banner = page.locator('p.text-error-text, p[class*="error"]').filter({ hasText: /.+/ }).first();
  await expect(banner).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('p[class*="success-text"]')).toHaveCount(0);
  await shot('mail-test-failed');

  await section(page, 'System').click();
  await page.getByRole('button', { name: 'Prüfen', exact: true }).click();
  await expect(page.getByText(/Audit-Log ist intakt: .* geprüft, keine Fehler\./)).toBeVisible();

  await section(page, 'Darstellung').click();
  await page.getByRole('radiogroup', { name: 'Farbschema' }).getByRole('radio', { name: 'Dunkel' }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? document.documentElement.className)).toMatch(/dark/);
  await page.reload();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.theme ?? document.documentElement.className)).toMatch(/dark/);
  await shot('dark-theme');

  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('?');
  await expect(page.getByRole('dialog', { name: 'Tastenkürzel' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Tastenkürzel' })).toHaveCount(0);
});

test('the EÜR worklist searches and filters, an expense is booked as Privatentnahme and the undo removes it again', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  await seedBankTransactions(page);
  await page.reload();
  const taxYear = new Date().getFullYear();
  const adobe = async () => (await invokeDesktopIpc(page, 'eur:listItems', { taxYear, sourceType: 'transaction', status: 'all' })).find((item) => item.counterparty === 'Adobe Systems');
  expect((await adobe()).classification).toBeUndefined();

  await page.goto(appUrl(baseUrl, '/eur'));
  await page.getByLabel('Einträge durchsuchen').fill('Adobe');
  await expect(page.getByRole('button', { name: /Adobe Systems/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /StartUp Berlin AG/ })).toHaveCount(0);
  await page.getByLabel('Zahlungsrichtung filtern').selectOption({ label: 'Einnahmen' });
  await expect(page.getByRole('button', { name: /Adobe Systems/ })).toHaveCount(0);
  await page.getByLabel('Zahlungsrichtung filtern').selectOption({ label: 'Ausgaben' });
  await page.getByRole('button', { name: /Adobe Systems/ }).first().click();

  const panel = page.getByRole('region', { name: 'Klassifizierung' });
  const kinds = panel.getByRole('radiogroup', { name: 'Art des Vorgangs' });
  // Lite separates Privatentnahme and Geldtransit; an outgoing payment offers no Privateinlage, and nothing is a blanket "exclude".
  await expect(kinds.getByRole('radio', { name: 'Geldtransit' })).toBeVisible();
  await expect(kinds.getByRole('radio', { name: /Privateinlage|ausschließen/ })).toHaveCount(0);
  await kinds.getByRole('radio', { name: 'Privatentnahme' }).click();
  await expect(panel.getByText(/keine Betriebsausgabe\. Zählt nicht in der EÜR/)).toBeVisible();
  await panel.getByRole('textbox', { name: 'Begründung für EÜR-Änderung' }).fill('Privat bezahlt');
  await panel.getByRole('button', { name: 'Klassifizierung speichern' }).click();
  await expect.poll(async () => (await adobe()).kind ?? null).toBe('private-withdrawal');
  expect((await adobe()).classification?.excluded ?? false).toBe(false);
  await shot('private-withdrawal');

  await page.getByLabel('Einträge durchsuchen').fill('');
  await page.getByRole('button', { name: /^Klassifiziert/ }).click();
  await expect(page.getByRole('button', { name: /Adobe Systems/ }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Rückgängig' }).click();
  // Undo writes the previous state back: no line, no kind, i.e. open again.
  await expect.poll(async () => (await invokeDesktopIpc(page, 'eur:listItems', { taxYear, sourceType: 'transaction', status: 'unclassified' })).some((item) => item.counterparty === 'Adobe Systems')).toBe(true);
  expect((await adobe()).kind).toBeUndefined();
  await page.getByRole('button', { name: /^Offen/ }).click();
  await expect(page.getByRole('button', { name: /Adobe Systems/ }).first()).toBeVisible();
  await shot('undone');
});

test('a VAT prepayment paid on 8 January, marked regelmäßig wiederkehrend, moves to the year it is for', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const file = writeBankCsv([{ date: '2026-01-08', amount: -1900, counterparty: 'Finanzamt', purpose: 'USt-VA 12-2025' }]);
  try {
    expect((await invokeDesktopIpc(page, 'finance:importCommit', { path: file, accountId: 'acc1', profile: 'generic', mapping: { dateColumn: 'Datum', amountColumn: 'Betrag', counterpartyColumn: 'Gegenpartei', purposeColumn: 'Verwendungszweck' } })).imported).toBe(1);
  } finally {
    fs.rmSync(file, { force: true });
  }
  await page.reload();
  const listed = async (taxYear) => (await invokeDesktopIpc(page, 'eur:listItems', { taxYear, sourceType: 'transaction', status: 'all' })).filter((item) => item.counterparty === 'Finanzamt');

  await page.goto(appUrl(baseUrl, '/eur'));
  await page.getByLabel('Steuerjahr').selectOption('2026');
  await page.getByRole('button', { name: /Finanzamt/ }).first().click();
  const panel = page.getByRole('region', { name: 'Klassifizierung' });
  const mark = panel.getByRole('checkbox', { name: /Regelmäßig wiederkehrend.*zählt in 2025/ });
  await expect(mark).not.toBeChecked();
  await shot('unmarked-2026');
  await mark.click();
  await expect.poll(async () => (await listed(2025)).length).toBe(1);
  expect(await listed(2026)).toHaveLength(0);
  await expect(page.getByRole('button', { name: /Finanzamt/ })).toHaveCount(0);

  await page.getByLabel('Steuerjahr').selectOption('2025');
  await page.getByRole('button', { name: /Finanzamt/ }).first().click();
  await expect(panel.getByText(/10-Tage-Regel, § 11 EStG\)/).first()).toBeVisible();
  await expect(panel.getByRole('checkbox', { name: /Regelmäßig wiederkehrend/ })).toBeChecked();
  expect((await listed(2025))[0].taxYear).toBe(2025);
  await shot('marked-2025');
});
