import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';
import { createShooter } from './lite-support.mjs';

/**
 * Contact persons, the CSV import of clients and articles, and duplicating a
 * document, through the Lite UI and verified through the backend.
 *
 * How this can fail:
 * - contacts: a second contact lost on save, the primary switch not persisted
 *   (or lost after a reload), contactPerson not following the primary contact,
 *   an invalid contact e-mail saved
 * - CSV import: the file not read, a duplicate (existing customer number) or a
 *   row with an invalid e-mail imported, the summary miscounting, "1.234,56"
 *   read as 1.23456 or 123456
 * - duplicate: the copy keeping the source's number or status, positions lost,
 *   the editor not opened in create mode, the reserved number not released on
 *   cancel (the next new invoice skipping it)
 */

let desktop;
const tempFiles = [];

test.beforeEach(async () => {
  desktop = await launchDesktopApp();
  await seedDesktopData(desktop.page);
  await desktop.page.reload();
});

test.afterEach(async () => {
  for (const file of tempFiles.splice(0)) fs.rmSync(file, { force: true });
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

const clients = (page) => invokeDesktopIpc(page, 'clients:list', {});
const articles = (page) => invokeDesktopIpc(page, 'articles:list', {});
const invoices = (page) => invokeDesktopIpc(page, 'invoices:list', {});
const pageTitle = (page) => page.getByRole('banner').getByRole('heading', { level: 1 });

const writeCsv = (name, content) => {
  const file = path.join(os.tmpdir(), `billme-e2e-${process.pid}-${Date.now()}-${name}`);
  fs.writeFileSync(file, content, 'utf8');
  tempFiles.push(file);
  return file;
};

test('a client with two contacts keeps the primary switch across a reload; an invalid contact e-mail is refused', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  await page.goto(appUrl(baseUrl, '/clients'));
  await page.getByRole('button', { name: 'Neuer Kunde' }).click();
  const dialog = page.getByRole('dialog', { name: 'Neuer Kunde' });
  await dialog.getByRole('textbox', { name: 'Firma', exact: true }).fill('Zweikontakt GmbH');
  await dialog.getByRole('textbox', { name: 'E-Mail-Adresse', exact: true }).first().fill('rechnung@zweikontakt.example');
  await dialog.getByRole('textbox', { name: 'Straße', exact: true }).first().fill('Kontaktweg 1');
  await dialog.getByRole('textbox', { name: 'PLZ', exact: true }).first().fill('10115');
  await dialog.getByRole('textbox', { name: 'Stadt', exact: true }).first().fill('Berlin');
  await dialog.getByRole('button', { name: '+ Ansprechpartner' }).click();
  await dialog.getByRole('button', { name: '+ Ansprechpartner' }).click();
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).first().fill('Anna Erste');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).last().fill('Bernd Zweiter');
  await dialog.getByRole('textbox', { name: 'Funktion', exact: true }).last().fill('Buchhaltung');

  // Negative path: an invalid contact e-mail blocks the save.
  await dialog.getByRole('textbox', { name: 'E-Mail', exact: true }).last().fill('kein-mail');
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(dialog.getByText('Ungültige E-Mail-Adresse: kein-mail').first()).toBeVisible();
  await shot('contact-invalid-email');
  expect((await clients(page)).some((client) => client.company === 'Zweikontakt GmbH')).toBe(false);

  await dialog.getByRole('textbox', { name: 'E-Mail', exact: true }).last().fill('bernd@zweikontakt.example');
  // The first contact starts as primary; switch it to the second.
  await expect(dialog.getByRole('button', { name: 'Primär' }).first()).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: 'Primär' }).last().click();
  await expect(dialog.getByRole('button', { name: 'Primär' }).last()).toHaveAttribute('aria-pressed', 'true');
  await shot('two-contacts');
  await dialog.getByRole('button', { name: 'Speichern' }).click();

  await expect.poll(async () => {
    const created = (await clients(page)).find((client) => client.company === 'Zweikontakt GmbH');
    return created ? [created.contactPerson, created.contacts.map((contact) => [contact.name, contact.isPrimary])] : null;
  }).toEqual(['Bernd Zweiter', [['Anna Erste', false], ['Bernd Zweiter', true]]]);
  await expect(page.getByRole('list', { name: 'Ansprechpartner' })).toContainText('Bernd Zweiter');

  // Switch back after a reload: the stored primary is shown, the change persists.
  await page.reload();
  await page.goto(appUrl(baseUrl, '/clients'));
  await page.getByRole('row', { name: 'Zweikontakt GmbH öffnen' }).click();
  await page.getByRole('button', { name: 'Kunde bearbeiten' }).click();
  const edit = page.getByRole('dialog', { name: 'Kunde bearbeiten' });
  await expect(edit.getByRole('button', { name: 'Primär' }).last()).toHaveAttribute('aria-pressed', 'true');
  await edit.getByRole('button', { name: 'Primär' }).first().click();
  await edit.getByRole('button', { name: 'Speichern' }).click();
  await expect.poll(async () => (await clients(page)).find((client) => client.company === 'Zweikontakt GmbH').contactPerson).toBe('Anna Erste');
  await page.reload();
  const stored = (await clients(page)).find((client) => client.company === 'Zweikontakt GmbH');
  expect(stored.contacts.map((contact) => [contact.name, contact.isPrimary])).toEqual([['Anna Erste', true], ['Bernd Zweiter', false]]);
  await shot('primary-switched');
});

test('a CSV import of three clients imports one, skips the duplicate and reports the invalid e-mail', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const before = await clients(page);
  const csv = writeCsv('kunden.csv', '﻿Firma;Kundennummer;Ansprechpartner;E-Mail;PLZ;Ort\r\n'
    + 'Importhaus GmbH;;Ida Import;ida@importhaus.example;20095;Hamburg\r\n'
    + 'Musterfirma Doppelt;KD-0001;;;;\r\n'
    + 'Falschpost AG;;;keine-mail;;\r\n');

  await page.goto(appUrl(baseUrl, '/clients'));
  await page.getByRole('button', { name: 'Importieren (CSV)' }).click();
  const dialog = page.getByRole('dialog', { name: 'Kunden importieren (CSV)' });
  await dialog.getByLabel('CSV-Datei auswählen').setInputFiles(csv);
  const preview = dialog.getByRole('table', { name: 'Importvorschau' });
  await expect(preview.getByRole('row')).toHaveCount(4);
  await expect(preview).toContainText('übersprungen (Duplikat)');
  await expect(preview).toContainText('Ungültige E-Mail: keine-mail');
  await shot('client-import-preview');
  await dialog.getByRole('button', { name: '1 importieren' }).click();
  await expect(dialog.getByRole('status')).toHaveText('1 importiert, 1 übersprungen, 1 fehlerhaft');
  await shot('client-import-summary');

  const after = await clients(page);
  expect(after.length).toBe(before.length + 1);
  const imported = after.find((client) => client.company === 'Importhaus GmbH');
  expect(imported.customerNumber).toMatch(/^KD-/);
  expect(imported.contactPerson).toBe('Ida Import');
  expect(after.filter((client) => client.customerNumber === 'KD-0001').length).toBe(1);
  expect(after.some((client) => client.company === 'Falschpost AG')).toBe(false);
});

test('a CSV import of articles reads the German price "1.234,56"', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const csv = writeCsv('leistungen.csv', 'Artikelnummer;Bezeichnung;Preis;USt;Einheit\nE2E-IMP-1;Workshop Import;1.234,56;19;Tag\nDEV-001;Doppelt;10;19;Std\n');

  await page.goto(appUrl(baseUrl, '/articles'));
  await page.getByRole('button', { name: 'Importieren (CSV)' }).click();
  const dialog = page.getByRole('dialog', { name: 'Leistungen importieren (CSV)' });
  await dialog.getByLabel('CSV-Datei auswählen').setInputFiles(csv);
  await expect(dialog.getByRole('table', { name: 'Importvorschau' })).toContainText('übersprungen (Duplikat)');
  await dialog.getByRole('button', { name: '1 importieren' }).click();
  await expect(dialog.getByRole('status')).toHaveText('1 importiert, 1 übersprungen, 0 fehlerhaft');
  await shot('article-import-summary');

  const imported = (await articles(page)).find((article) => article.sku === 'E2E-IMP-1');
  expect([imported.title, imported.price, imported.taxRate, imported.unit]).toEqual(['Workshop Import', 1234.56, 19, 'Tag']);
});

test('duplicating an issued invoice opens the editor with a new number and the same positions; cancelling releases the number', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const source = (await invoices(page)).find((invoice) => invoice.id === 'inv-open-1');
  const invoicesBefore = await invoices(page);

  await page.goto(appUrl(baseUrl, '/documents'));
  await page.getByText(source.number, { exact: true }).first().click();
  await expect(page.getByRole('heading', { name: source.number })).toBeVisible();
  await page.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'Duplizieren' }).click();

  await expect(pageTitle(page)).toHaveText('Rechnung erstellen');
  const copyNumber = await page.getByRole('textbox', { name: 'Rechnungs-Nr.' }).inputValue();
  expect(copyNumber).not.toBe(source.number);
  for (const [index, item] of source.items.entries()) {
    await expect(page.getByRole('combobox', { name: `Beschreibung Position ${index + 1}`, exact: true })).toHaveValue(item.description);
  }
  await shot('duplicate-editor');

  // Cancel: nothing is saved and the number goes back to the pool.
  await page.getByRole('button', { name: 'Zurück' }).click();
  // An untouched copy may leave without the discard prompt; wait briefly in case it does appear.
  const prompted = await page.getByRole('dialog', { name: 'Ungespeicherte Änderungen verwerfen?' })
    .waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false);
  if (prompted) await page.getByRole('button', { name: 'Änderungen verwerfen' }).click();
  await expect(pageTitle(page)).toHaveText('Rechnungen & Angebote');
  expect(await invoices(page)).toEqual(invoicesBefore);

  await page.getByRole('banner').getByRole('button', { name: 'Neue Rechnung' }).click();
  await expect(pageTitle(page)).toHaveText('Rechnung erstellen');
  await expect(page.getByRole('textbox', { name: 'Rechnungs-Nr.' })).toHaveValue(copyNumber);
  await shot('number-reused');
});
