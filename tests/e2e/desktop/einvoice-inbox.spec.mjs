import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';
import { createShooter } from './lite-support.mjs';

/**
 * E-invoices in Lite: a received XRechnung is read in Buchen, checked in the
 * readable view, taken over into the receipt and archived as the original file;
 * an issued invoice is exported as XRechnung (CII) from the document detail.
 *
 * How this can fail:
 * - reading: the file input does not reach `einvoice:parse`, the readable view
 *   misses seller, number, lines, VAT or totals, a non-e-invoice is accepted
 *   silently instead of a German error
 * - taking over: number, issuer, dates, gross amount or VAT per rate not
 *   prefilled, the saved receipt carries other amounts than the file
 * - archiving: the original XML is not attached to the saved receipt
 *   (GoBD: the original format is the record), or it cannot be shown again
 * - export: no XRechnung action, the download is not the XRechnung profile or
 *   loses the Leitweg-ID, a missing Leitweg-ID exports anyway or fails without
 *   a German message
 */

const UBL_FIXTURE = fileURLToPath(new URL('../../../packages/integration-tests/src/fixtures/xrechnung-ubl.xml', import.meta.url));
const XRECHNUNG_ID = 'urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0';

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

/** An issued §19 invoice for StartUp Berlin AG, optionally with a Leitweg-ID (BT-10). */
const issueInvoice = async (page, buyerReference) => {
  const reservation = await invokeDesktopIpc(page, 'numbers:reserve', { kind: 'invoice' });
  const draft = {
    id: crypto.randomUUID(), clientId: 'c2', clientNumber: 'KD-0002', number: reservation.number, numberReservationId: reservation.reservationId,
    client: 'StartUp Berlin AG', clientEmail: 'hello@startup-berlin.io', clientAddress: 'Torstrasse 5\n10119 Berlin',
    date: '2026-02-20', dueDate: '2026-03-06', servicePeriod: '2026-02-20', amount: 480, status: 'draft', dunningLevel: 0,
    items: [{ kind: 'item', description: 'Wartungsvertrag Februar', quantity: 4, price: 120, total: 480 }],
    payments: [], history: [], taxMode: 'small_business_19_ustg', ...(buyerReference ? { taxMeta: { buyerReference } } : {}),
  };
  await invokeDesktopIpc(page, 'invoices:upsert', { reason: 'E2E XRechnung', invoice: draft });
  await invokeDesktopIpc(page, 'invoices:upsert', { reason: 'E2E XRechnung gestellt', invoice: { ...draft, status: 'open' } });
  return draft;
};

test('a received UBL XRechnung is read, checked, taken over into a receipt and archived as the original file', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  await page.goto(appUrl(baseUrl, '/eur'));
  await page.getByRole('button', { name: 'Manuelle Buchung' }).click();
  const dialog = page.getByRole('dialog', { name: 'Manuelle Buchung' });
  const picker = dialog.getByLabel('E-Rechnung auswählen');

  // Negative: an XML that is no invoice is refused with a German message, nothing is prefilled.
  await picker.setInputFiles({ name: 'bestellung.xml', mimeType: 'application/xml', buffer: Buffer.from('<?xml version="1.0"?><Order><ID>1</ID></Order>') });
  await expect(dialog.getByRole('alert')).toContainText('Keine E-Rechnung gefunden');
  await expect(dialog.getByRole('region', { name: 'E-Rechnung Sichtprüfung' })).toHaveCount(0);
  await shot('not-an-einvoice');

  await picker.setInputFiles(UBL_FIXTURE);
  const review = dialog.getByRole('region', { name: 'E-Rechnung Sichtprüfung' });
  await expect(review).toBeVisible();
  await expect(review.getByRole('heading', { name: 'Rechnung 0815-2026-17' })).toBeVisible();
  await expect(review).toContainText('XRechnung (UBL)');
  await expect(review).toContainText('Bürobedarf Schulz & Partner GmbH');
  await expect(review).toContainText('DE987654321');
  await expect(review).toContainText('DE75512108001245126199');
  await expect(review.getByRole('table', { name: 'Rechnungspositionen' }).getByRole('row')).toHaveCount(3);
  await expect(review.getByRole('table', { name: 'Rechnungspositionen' })).toContainText('Druckerpapier A4, 5 000 Blatt');
  await expect(review.getByRole('table', { name: 'Umsatzsteuer je Steuersatz' })).toContainText('19 %');
  await expect(review.getByRole('table', { name: 'Umsatzsteuer je Steuersatz' })).toContainText('7 %');
  await expect(review.getByLabel('Summen der E-Rechnung')).toContainText('140,40');
  await shot('einvoice-review');

  await dialog.getByRole('button', { name: 'Übernehmen' }).click();
  await expect(review).toHaveCount(0);
  await expect(dialog.getByLabel('Belegnummer', { exact: true })).toHaveValue('0815-2026-17');
  await expect(dialog.getByLabel('Belegaussteller', { exact: true })).toHaveValue('Bürobedarf Schulz & Partner GmbH');
  await expect(dialog.getByLabel('Belegdatum', { exact: true })).toHaveValue('2026-03-10');
  await expect(dialog.getByLabel('Leistung abgeschlossen am', { exact: true })).toHaveValue('2026-03-05');
  await expect(dialog.getByLabel('Gesamtbetrag des Belegs in EUR', { exact: true })).toHaveValue('140,40');
  await expect(dialog.getByText('Die Originaldatei xrechnung-ubl.xml wird beim Speichern an den Beleg angehängt.')).toBeVisible();

  await dialog.getByLabel('Zahlungsart', { exact: true }).selectOption('cash');
  await dialog.getByLabel('Zahlungsdatum', { exact: true }).fill('2026-03-12');
  await dialog.getByLabel('Betrag in EUR', { exact: true }).fill('140.40');
  await dialog.getByLabel('Begründung', { exact: true }).fill('E-Rechnung Bürobedarf erfasst');
  await shot('receipt-prefilled');
  await dialog.getByRole('button', { name: 'Buchung speichern' }).click();
  await expect(dialog).toHaveCount(0);

  const findReceipt = async () => (await invokeDesktopIpc(page, 'cash:listReceipts')).find((row) => row.number === '0815-2026-17');
  await expect.poll(async () => (await findReceipt())?.fileCount).toBe(1);
  const receipt = await findReceipt();
  expect([receipt.counterparty, receipt.documentDate, receipt.serviceDate, receipt.grossAmountCents, receipt.taxMode, receipt.reviewed])
    .toEqual(['Bürobedarf Schulz & Partner GmbH', '2026-03-10', '2026-03-05', 14040, 'domestic', false]);
  expect(receipt.taxBreakdown).toEqual([{ rate: 19, netAmountCents: 10000, vatAmountCents: 1900 }, { rate: 7, netAmountCents: 2000, vatAmountCents: 140 }]);
  const files = await invokeDesktopIpc(page, 'cash:listFiles', { receiptId: receipt.id });
  expect(files.map((file) => [file.fileName, file.mimeType, file.byteLength])).toEqual([['xrechnung-ubl.xml', 'application/xml', fs.statSync(UBL_FIXTURE).size]]);
  const entry = (await invokeDesktopIpc(page, 'cash:listEntries')).find((row) => row.receiptId === receipt.id);
  expect([entry.amountCents, entry.counterparty, entry.purpose]).toEqual([-14040, 'Bürobedarf Schulz & Partner GmbH', 'Rechnung 0815-2026-17']);

  // The archived original is shown again in the readable view.
  await page.getByText(/Manuelle Zahlungen und Belege/).click();
  await page.getByRole('button', { name: 'Beleg', exact: true }).first().click();
  const archive = page.getByRole('dialog', { name: 'Originalbelege' });
  await archive.getByRole('button', { name: 'xrechnung-ubl.xml anzeigen' }).click();
  await expect(archive.getByRole('region', { name: 'E-Rechnung Sichtprüfung' })).toContainText('Bürobedarf Schulz & Partner GmbH');
  await shot('archived-einvoice-view');
});

test('an issued invoice with Leitweg-ID downloads as XRechnung; without Leitweg-ID the export names what is missing', async () => {
  const { page, baseUrl, app } = desktop;
  const shot = createShooter(page);
  const withReference = await issueInvoice(page, '04011000-12345-67');
  const withoutReference = await issueInvoice(page);
  // Written past react-query: reload so the list shows both invoices.
  await page.reload();
  const target = path.join(os.tmpdir(), `billme-xrechnung-${process.pid}-${Date.now()}.xml`);
  // The export is a browser download; answer the save dialog in the main process.
  await app.evaluate(({ session }, file) => {
    session.defaultSession.once('will-download', (_event, item) => item.setSavePath(file));
  }, target);

  await page.goto(appUrl(baseUrl, '/documents'));
  await page.getByRole('row', { name: `Rechnung ${withReference.number} öffnen` }).click();
  await expect(page.getByRole('heading', { name: withReference.number })).toBeVisible();
  await page.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'XRechnung (XML)' }).click();
  await expect.poll(() => fs.existsSync(target) && fs.statSync(target).size > 0, { timeout: 15_000 }).toBe(true);
  const xml = fs.readFileSync(target, 'utf8');
  fs.rmSync(target, { force: true });
  expect(xml).toContain(`<ram:ID>${XRECHNUNG_ID}</ram:ID>`);
  expect(xml).toContain('<ram:BuyerReference>04011000-12345-67</ram:BuyerReference>');
  expect(xml).toContain(`<ram:ID>${withReference.number}</ram:ID>`);
  expect(xml).toContain('<ram:URIID schemeID="EM">hello@startup-berlin.io</ram:URIID>');
  await expect(page.getByText(/_xrechnung\.xml heruntergeladen/)).toBeVisible();
  await shot('xrechnung-downloaded');

  // The same file through the backend: it reads back as the invoice.
  const parsed = await invokeDesktopIpc(page, 'einvoice:parse', { fileName: 'x.xml', contentBase64: Buffer.from(xml).toString('base64') });
  expect([parsed.number, parsed.profile, parsed.totals.gross]).toEqual([withReference.number, XRECHNUNG_ID, 480]);

  // Negative: no Leitweg-ID, the export is refused with the missing field named.
  await page.getByRole('button', { name: 'Zurück zur Liste' }).click();
  await page.getByRole('row', { name: `Rechnung ${withoutReference.number} öffnen` }).click();
  await expect(page.getByRole('heading', { name: withoutReference.number })).toBeVisible();
  await page.getByRole('button', { name: 'Weitere Aktionen' }).click();
  await page.getByRole('menuitem', { name: 'XRechnung (XML)' }).click();
  await expect(page.getByText(/XRechnung nicht möglich, es fehlt: Leitweg-ID\/Käuferreferenz \(BT-10\)/)).toBeVisible();
  await shot('xrechnung-missing-leitweg-id');
  const refused = await invokeDesktopIpc(page, 'documents:exportXRechnung', { id: withoutReference.id }).then(() => null, (error) => String(error));
  expect(refused).toMatch(/Leitweg-ID/);
});
