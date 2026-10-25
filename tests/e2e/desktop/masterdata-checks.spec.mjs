import { expect, test } from '@playwright/test';
import { appUrl, createDesktopSettings, getDesktopSettings, invokeDesktopIpc, launchDesktopApp, seedDesktopData, setDesktopSettings } from '../support.mjs';
import { createShooter, useRegularVat } from './lite-support.mjs';

/**
 * Master data checks the way a user meets them: onboarding, settings, clients, projects,
 * the client CSV import and the dashboard links into the document list.
 *
 * How this can fail:
 * - a bad IBAN/BIC (or PLZ, USt-IdNr.) only fails in the backend: a raw Zod JSON box nobody can
 *   close covers the wizard buttons, nothing is said at the field, the draft is lost
 * - settings: the Soll/Ist switch is overwritten by a second control on save
 * - clients: a German PLZ "XYZ" or USt-IdNr. "NONSENSE" stored (it lands on §14 invoices); the
 *   Leitweg-ID of a public buyer not kept or not taken into a new invoice
 * - a client with invoices first reported "Kunde gelöscht", then restored after the undo delay
 * - projects: end before start refused by the server without a message, errors under "Grund"
 * - client CSV from Excel (Windows-1252) imported as "W�hrungs GmbH"
 * - dashboard: "Fällig in 7 Tagen" and "Alle ansehen" open the plain or the "Offen" list
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
const noFatalOverlay = async (page) => expect(page.locator('#__app_debug_overlay'), 'no global error box').toHaveCount(0);

test('onboarding checks PLZ, USt-IdNr., IBAN and BIC at the field and finishes once they are right', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  await setDesktopSettings(page, createDesktopSettings({ onboardingCompleted: false, company: { name: '' }, finance: { iban: '', bic: '', bankName: '' } }));
  await page.goto(appUrl(baseUrl, '/'));
  await page.reload();
  const wizard = page.getByRole('dialog', { name: 'Billme einrichten' });
  await expect(wizard).toBeVisible();

  await wizard.getByLabel('Firmenname').fill('Prüfwerk GmbH');
  await wizard.getByLabel('PLZ', { exact: true }).fill('ABC');
  await wizard.getByRole('button', { name: 'Weiter zu Abrechnung' }).click();
  await expect(wizard.getByLabel('PLZ', { exact: true })).toHaveAccessibleDescription(/fünf Ziffern/);
  await shot('wizard-plz');
  await wizard.getByLabel('PLZ', { exact: true }).fill('10115');
  await wizard.getByRole('button', { name: 'Weiter zu Abrechnung' }).click();

  await wizard.getByLabel('USt-IdNr.').fill('XX123');
  await wizard.getByRole('button', { name: 'Weiter zu Weitere Angaben' }).click();
  await expect(wizard.getByLabel('USt-IdNr.')).toHaveAccessibleDescription(/Ländercode/);
  await wizard.getByLabel('USt-IdNr.').fill('DE123456789');
  await wizard.getByRole('button', { name: 'Weiter zu Weitere Angaben' }).click();

  await wizard.getByLabel('Bankname').fill('Testbank');
  await wizard.getByLabel('IBAN').fill('DE00 1234');
  await wizard.getByLabel('BIC').fill('xx');
  await wizard.getByRole('button', { name: 'Einrichtung abschließen' }).click();
  await expect(wizard.getByLabel('IBAN')).toHaveAccessibleDescription(/IBAN/);
  await expect(wizard.getByLabel('BIC')).toHaveAccessibleDescription(/8 oder 11 Zeichen/);
  await noFatalOverlay(page);
  await shot('wizard-bank-errors');

  // "Später fortsetzen" with a bad IBAN keeps the wizard open at the field instead of failing in the backend.
  await wizard.getByRole('button', { name: 'Später fortsetzen' }).click();
  await expect(wizard).toBeVisible();
  await noFatalOverlay(page);

  await wizard.getByLabel('IBAN').fill('DE89 3704 0044 0532 0130 00');
  await wizard.getByLabel('BIC').fill('COBADEFFXXX');
  await wizard.getByRole('button', { name: 'Einrichtung abschließen' }).click();
  await expect(wizard).toHaveCount(0);
  const stored = await getDesktopSettings(page);
  expect([stored.company.zip, stored.finance.vatId, stored.finance.iban.replaceAll(' ', ''), stored.finance.bic, stored.onboardingCompleted])
    .toEqual(['10115', 'DE123456789', 'DE89370400440532013000', 'COBADEFFXXX', true]);
});

test('settings refuse a bad IBAN at the field, and the Soll/Ist switch is what gets saved', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  await useRegularVat(page);
  const before = await getDesktopSettings(page);
  await page.goto(appUrl(baseUrl, '/settings'));

  await section(page, 'Finanzen').click();
  await page.getByLabel('IBAN').fill('DE00123');
  await page.getByRole('button', { name: 'Einstellungen speichern' }).click();
  await expect(page.getByLabel('IBAN')).toHaveAccessibleDescription(/IBAN/);
  await expect(page.getByText('Einstellungen gespeichert!')).toHaveCount(0);
  await noFatalOverlay(page);
  expect((await getDesktopSettings(page)).finance.iban, 'nothing saved').toBe(before.finance.iban);
  await shot('settings-bad-iban');
  await page.getByLabel('IBAN').fill(before.finance.iban);

  await section(page, 'Rechtliches').click();
  const basis = page.getByRole('radiogroup', { name: 'Umsatzsteuer-Basis' });
  await basis.getByRole('radio', { name: 'Ist' }).click();
  await page.getByRole('button', { name: 'Einstellungen speichern' }).click();
  await expect(page.getByText('Einstellungen gespeichert!')).toBeVisible();
  await expect.poll(async () => {
    const saved = await getDesktopSettings(page);
    return [saved.businessReportingProfile?.vatMethod, saved.legal.taxAccountingMethod];
  }).toEqual(['ist', 'ist']);
  await page.reload();
  await page.goto(appUrl(baseUrl, '/settings'));
  await section(page, 'Rechtliches').click();
  await expect(page.getByRole('radiogroup', { name: 'Umsatzsteuer-Basis' }).getByRole('radio', { name: 'Ist' })).toHaveAttribute('aria-checked', 'true');
  // One control for the method, and the seat is Germany only.
  await expect(page.getByLabel('Umsatzsteuer-Methode')).toHaveCount(0);
  await expect(page.getByLabel('Sitzland des Verkäufers').locator('option')).toHaveText(['Deutschland']);
  await shot('settings-ist-after-reload');
});

test('a client with a bad PLZ or USt-IdNr. is refused at the field; the Leitweg-ID goes into the new invoice', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  await page.goto(appUrl(baseUrl, '/clients'));
  await page.getByRole('button', { name: 'Neuer Kunde' }).click();
  const dialog = page.getByRole('dialog', { name: 'Neuer Kunde' });
  await dialog.getByRole('textbox', { name: 'Firma', exact: true }).fill('Stadt Musterhausen');
  await dialog.getByRole('textbox', { name: 'E-Mail-Adresse', exact: true }).first().fill('rechnung@musterhausen.example');
  await dialog.getByRole('textbox', { name: 'Straße', exact: true }).first().fill('Rathausplatz 1');
  await dialog.getByRole('textbox', { name: 'PLZ', exact: true }).first().fill('XYZ');
  await dialog.getByRole('textbox', { name: 'Stadt', exact: true }).first().fill('Musterhausen');
  await dialog.getByLabel('USt-IdNr.').fill('nonsense');
  await dialog.getByLabel('Leitweg-ID (Käuferreferenz)').fill('04011000-12345-67');
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(dialog.getByRole('textbox', { name: 'PLZ', exact: true }).first()).toHaveAccessibleDescription(/fünf Ziffern/);
  await expect(dialog.getByLabel('USt-IdNr.')).toHaveAccessibleDescription(/Ländercode/);
  await shot('client-bad-plz-vatid');
  const clients = () => invokeDesktopIpc(page, 'clients:list');
  expect((await clients()).some((client) => client.company === 'Stadt Musterhausen'), 'nothing saved').toBe(false);

  await dialog.getByRole('textbox', { name: 'PLZ', exact: true }).first().fill('12345');
  await dialog.getByLabel('USt-IdNr.').fill('');
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect.poll(async () => (await clients()).find((client) => client.company === 'Stadt Musterhausen')?.taxProfile?.buyerReference)
    .toBe('04011000-12345-67');

  await expect(page.getByRole('heading', { name: 'Stadt Musterhausen', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Neue Rechnung' }).click();
  await expect(page.getByLabel('Käuferreferenz (Leitweg-ID)')).toHaveValue('04011000-12345-67');
  await shot('invoice-with-leitweg-id');
});

test('a client with invoices is not reported as deleted', async () => {
  const { page, baseUrl } = desktop;
  await page.goto(appUrl(baseUrl, '/clients'));
  await page.getByText('StartUp Berlin AG').first().click();
  await page.getByRole('button', { name: 'Kunde löschen' }).click();
  await expect(page.getByText(/Für diesen Kunden gibt es Rechnungen/)).toBeVisible();
  await expect(page.getByText('Kunde gelöscht')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'StartUp Berlin AG', level: 1 }), 'the detail stays open').toBeVisible();
  expect((await invokeDesktopIpc(page, 'clients:list')).some((client) => client.id === 'c2')).toBe(true);
});

test('a project ending before it starts gets the message at the end date', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  await page.goto(appUrl(baseUrl, '/projects'));
  await page.getByRole('button', { name: 'Neues Projekt' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Neues Projekt' });
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(dialog.getByRole('textbox', { name: 'Projektname (Pflicht)' })).toHaveAccessibleDescription(/Projektnamen/);
  await dialog.getByRole('combobox', { name: 'Kunde (Pflicht)' }).selectOption('c2');
  await dialog.getByRole('textbox', { name: 'Projektname (Pflicht)' }).fill('Relaunch');
  await dialog.getByLabel('Start').fill('2026-10-01');
  await dialog.getByLabel('Ende (optional)').fill('2026-09-01');
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(dialog.getByLabel('Ende (optional)')).toHaveAccessibleDescription(/nicht vor dem Start/);
  await expect(dialog.getByLabel('Grund (Pflicht)')).not.toHaveAccessibleDescription(/Projekt|Kunde|Ende/);
  await shot('project-end-before-start');
  await dialog.getByLabel('Ende (optional)').fill('2026-12-31');
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('01.10.2026 – 31.12.2026')).toBeVisible();
});

test('a client CSV saved by Excel (Windows-1252) keeps its umlauts', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  await page.goto(appUrl(baseUrl, '/clients'));
  await page.getByRole('button', { name: /Importieren/ }).click();
  const csv = Buffer.from('Firma;E-Mail;Straße;PLZ;Ort\nWährungs GmbH;info@waehrung.example;Grünstr. 4;20095;Hamburg\n', 'latin1');
  await page.getByLabel('CSV-Datei auswählen').setInputFiles({ name: 'kunden-excel.csv', mimeType: 'text/csv', buffer: csv });
  await expect(page.getByRole('table', { name: 'Importvorschau' }).getByText('Währungs GmbH')).toBeVisible();
  await expect(page.getByText(/Windows-1252/)).toBeVisible();
  await shot('csv-windows-1252');
  await page.getByRole('button', { name: '1 importieren' }).click();
  await expect.poll(async () => (await invokeDesktopIpc(page, 'clients:list')).some((client) => client.company === 'Währungs GmbH')).toBe(true);
});

test('the dashboard opens the document list on what the tile counts', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  // One invoice due in three days next to the seeded overdue one.
  const due = new Date();
  due.setDate(due.getDate() + 3);
  const iso = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const reservation = await invokeDesktopIpc(page, 'numbers:reserve', { kind: 'invoice' });
  const draft = {
    id: 'inv-due-soon', clientId: 'c1', clientNumber: 'KD-0001', number: reservation.number, numberReservationId: reservation.reservationId,
    client: 'Musterfirma GmbH', clientEmail: 'buchhaltung@musterfirma.de', clientAddress: 'Musterstrasse 123\n12345 Musterstadt',
    date: iso(new Date()), dueDate: iso(due), amount: 400, status: 'draft', taxMode: 'small_business_19_ustg', dunningLevel: 0,
    items: [{ kind: 'item', description: 'Wartung', quantity: 1, price: 400, total: 400 }], payments: [], history: [],
  };
  await invokeDesktopIpc(page, 'invoices:upsert', { reason: 'E2E', invoice: draft });
  await invokeDesktopIpc(page, 'invoices:upsert', { reason: 'E2E gestellt', invoice: { ...draft, status: 'open' } });
  const numberOf = async (id) => (await invokeDesktopIpc(page, 'invoices:list')).find((invoice) => invoice.id === id).number;
  const overdueNumber = await numberOf('inv-open-1');
  const paidNumber = await numberOf('inv-paid-1');
  await page.reload();
  await page.goto(appUrl(baseUrl, '/'));

  await page.getByRole('button', { name: /erwartete Eingänge/ }).click();
  await expect(page.getByText('Fällig in den nächsten 7 Tagen')).toBeVisible();
  await expect(page.getByText(reservation.number).first()).toBeVisible();
  await expect(page.getByText(overdueNumber), 'the overdue invoice is not due soon').toHaveCount(0);
  await shot('due-soon-list');

  await page.goto(appUrl(baseUrl, '/'));
  await page.getByRole('button', { name: /Alle ansehen/ }).click();
  await expect(page.getByText('Offene Forderungen (offen und überfällig)')).toBeVisible();
  await expect(page.getByText(reservation.number).first()).toBeVisible();
  await expect(page.getByText(overdueNumber).first()).toBeVisible();
  await expect(page.getByText(paidNumber), 'a paid invoice is no open receivable').toHaveCount(0);
  await shot('unpaid-list');
});
