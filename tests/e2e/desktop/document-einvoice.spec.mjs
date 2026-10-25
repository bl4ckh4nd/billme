import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { appUrl, getDesktopSettings, invokeDesktopIpc, launchDesktopApp, readEmbeddedFacturX, seedDesktopData, setDesktopSettings } from '../support.mjs';
import { createShooter, useRegularVat } from './lite-support.mjs';

/**
 * Follow-up documents and e-invoices from the Lite invoice detail.
 *
 * How this can fail:
 * - ZUGFeRD: a client address typed in one line ("Straße 1, 12345 Ort") blocks every
 *   PDF of that client with "Käufer PLZ fehlt" and a technical error
 * - Abschlag/Teilgutschrift with 19 % and 7 % lines: a round gross amount refused as
 *   "nicht centgenau"; on any refusal the dialog closes and the typed amount is gone
 * - XRechnung without Leitweg-ID on an issued invoice: no hint how to add it
 * - Rabatt: no field for a position discount in the editor (the template has a
 *   "Rabatt" column), percent or EUR discount not saved, totals or PDF without it
 */

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

const invoices = (page) => invokeDesktopIpc(page, 'invoices:list', {});

const issueInvoice = async (page, overrides) => {
  const reservation = await invokeDesktopIpc(page, 'numbers:reserve', { kind: 'invoice' });
  const draft = await invokeDesktopIpc(page, 'invoices:upsert', {
    reason: 'E2E Entwurf',
    invoice: {
      id: `inv-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`, number: reservation.number, numberReservationId: reservation.reservationId,
      clientId: 'c1', client: 'Musterfirma GmbH', clientEmail: 'buchhaltung@musterfirma.de', clientAddress: 'Musterstrasse 123, 12345 Musterstadt',
      date: '2026-10-01', dueDate: '2026-10-15', servicePeriod: '2026-10-01', amount: 100, status: 'draft', taxMode: 'small_business_19_ustg',
      items: [{ kind: 'item', description: 'Leistung', quantity: 1, price: 100, total: 100 }], payments: [], history: [],
      ...overrides,
    },
  });
  return invokeDesktopIpc(page, 'invoices:upsert', { reason: 'E2E gestellt', invoice: { ...draft, status: 'open' } });
};

const openInvoice = async (page, baseUrl, number) => {
  await page.goto(appUrl(baseUrl, '/documents'));
  await page.getByRole('row', { name: new RegExp(`${number} öffnen`) }).click();
  await expect(page.getByRole('heading', { name: number })).toBeVisible();
};

test('with ZUGFeRD on, an invoice to a client with a one-line address gets its PDF with the embedded XML', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const settings = await getDesktopSettings(page);
  await setDesktopSettings(page, { ...settings, eInvoice: { ...settings.eInvoice, enabled: true } });
  const invoice = await issueInvoice(page, {});
  await page.reload();
  await openInvoice(page, baseUrl, invoice.number);

  const exportsDir = path.join(desktop.userDataDir, 'exports');
  const before = fs.existsSync(exportsDir) ? fs.readdirSync(exportsDir) : [];
  await page.getByRole('button', { name: 'PDF', exact: true }).click();
  await expect(page.getByText('PDF gespeichert')).toBeVisible();
  await expect(page.getByText(/Käufer PLZ/)).toHaveCount(0);
  await shot('pdf-saved');
  const [file] = fs.readdirSync(exportsDir).filter((name) => !before.includes(name));
  const bytes = fs.readFileSync(path.join(exportsDir, file));
  fs.writeFileSync(test.info().outputPath('zugferd.pdf'), bytes);
  const xml = await readEmbeddedFacturX(bytes);
  expect(xml).toContain('<ram:PostcodeCode>12345</ram:PostcodeCode>');
  expect(xml).toContain('<ram:CityName>Musterstadt</ram:CityName>');
});

test('an Abschlag of 500 € on a 19 %/7 % order is created; a refused amount keeps the dialog open with the input', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  await useRegularVat(page);
  const offer = await invokeDesktopIpc(page, 'offers:upsert', {
    reason: 'E2E gemischt',
    offer: {
      id: 'offer-mixed-1', clientId: 'c2', clientNumber: 'KD-0002', number: 'ANG-2026-095', client: 'StartUp Berlin AG', clientEmail: 'hello@startup-berlin.io',
      clientAddress: 'Torstrasse 5\n10119 Berlin', date: '2026-10-01', dueDate: '2026-10-31', amount: 1318.4, status: 'open', taxMode: 'standard_vat',
      items: [
        { kind: 'item', description: 'Leistung 19', quantity: 2, price: 500, total: 1000, taxRate: 19 },
        { kind: 'item', description: 'Buch 7', quantity: 3, price: 40, total: 120, taxRate: 7 },
      ],
      payments: [], history: [], shareDecision: 'accepted', acceptedAt: '2026-10-02T12:00:00.000Z', acceptedBy: 'Julia Design', acceptedEmail: 'hello@startup-berlin.io', acceptedUserAgent: 'Playwright E2E',
    },
  });
  const order = await invokeDesktopIpc(page, 'documents:chainIssue', { id: crypto.randomUUID(), operation: 'order_confirmation', offerId: offer.id, date: '2026-10-02', reason: 'E2E AB' });
  await page.reload();
  await openInvoice(page, baseUrl, order.number);

  await page.getByRole('button', { name: 'Abschlag', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Abschlagsrechnung erstellen' });
  await dialog.getByLabel('Betrag (EUR)').fill('5000');
  await dialog.getByRole('button', { name: 'Abschlagsrechnung erstellen' }).click();
  await expect(dialog.getByRole('alert'), 'the refusal is shown in the dialog').toBeVisible();
  await expect(dialog.getByLabel('Betrag (EUR)')).toHaveValue('5000');
  await shot('refused-in-dialog');

  await dialog.getByLabel('Betrag (EUR)').fill('500');
  await dialog.getByRole('button', { name: 'Abschlagsrechnung erstellen' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await invoices(page)).filter((invoice) => invoice.documentKind === 'advance_invoice' && invoice.sourceDocumentId === order.id).map((invoice) => invoice.taxSnapshot?.grossAmount))
    .toEqual([500]);
  await shot('advance-created');
});

test('XRechnung without Leitweg-ID tells how to add it: by revision, or after a credit note by Storno and a new invoice', async () => {
  const { page, baseUrl } = desktop;
  const invoice = await issueInvoice(page, {});
  await page.reload();
  await openInvoice(page, baseUrl, invoice.number);
  await page.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'XRechnung (XML)' }).click();
  await expect(page.getByText(/Leitweg-ID.*Revision/)).toBeVisible();

  await invokeDesktopIpc(page, 'documents:chainIssue', { id: crypto.randomUUID(), operation: 'correction', kind: 'credit_note', invoiceId: invoice.id, amount: 10, date: '2026-10-02', reason: 'E2E Gutschrift' });
  await page.reload();
  await openInvoice(page, baseUrl, invoice.number);
  await page.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'XRechnung (XML)' }).click();
  await expect(page.getByText(/Leitweg-ID.*(Storno|neue Rechnung)/)).toBeVisible();
});

test('a position discount in percent and in EUR is entered in the editor, saved and printed', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  await useRegularVat(page);
  await page.goto(appUrl(baseUrl, '/documents'));
  await page.getByRole('button', { name: 'Neue Rechnung' }).first().click();
  await page.getByRole('combobox', { name: 'Kunde auswählen' }).fill('Musterfirma');
  await page.getByRole('option').filter({ hasText: 'Musterfirma GmbH' }).click();
  for (const [index, description, quantity, price] of [[1, 'Leuchte', '2', '89'], [2, 'Montage', '1', '100']]) {
    await page.getByRole('button', { name: 'Position hinzufügen' }).click();
    await page.getByRole('combobox', { name: `Beschreibung Position ${index}`, exact: true }).or(page.getByRole('textbox', { name: `Beschreibung ${index}`, exact: true })).fill(description);
    await page.getByRole('spinbutton', { name: 'Menge' }).nth(index - 1).fill(quantity);
    await page.getByRole('textbox', { name: `Einzelpreis ${index}` }).or(page.getByRole('spinbutton', { name: `Einzelpreis ${index}` })).fill(price);
  }
  await page.getByRole('spinbutton', { name: 'Rabatt Position 1', exact: true }).fill('10');
  await page.getByRole('combobox', { name: 'Rabattart Position 2', exact: true }).selectOption('amount');
  await page.getByRole('spinbutton', { name: 'Rabatt Position 2', exact: true }).fill('20');
  await expect(page.locator('[data-document-totals]')).toContainText('285,84');
  await shot('editor-discount');

  await page.locator('button').filter({ hasText: 'Speichern' }).click();
  await expect(page).toHaveURL(/#\/documents(?:\?|$)/);
  const saved = (await invoices(page)).find((invoice) => invoice.items.some((item) => item.description === 'Leuchte'));
  expect(saved.items.map((item) => [item.description, item.discountPercent, item.discountAmount, item.total])).toEqual([['Leuchte', 10, undefined, 160.2], ['Montage', undefined, 20, 80]]);
  expect(saved.amount).toBe(285.84);
  const exported = await invokeDesktopIpc(page, 'pdf:export', { kind: 'invoice', id: saved.id });
  fs.copyFileSync(exported.path, test.info().outputPath('invoice-discount.pdf'));
  const text = execFileSync('pdftotext', ['-layout', exported.path, '-'], { encoding: 'utf8' });
  expect(text).toContain('285,84');
  expect(text, 'the discount is printed even though the template hides the column').toContain('10 %');
  expect(text, 'the EUR discount stays on one line').toMatch(/−\s20,00/);
});
