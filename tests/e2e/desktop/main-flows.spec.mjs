// The three main functions of the Lite app, driven only through the UI: invoices, offers and bank transactions.
// IPC is used for seeding and for reading back what was persisted; every state change below is a click or a keystroke.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';
import { answerNextFilePicker, createShooter, readEditorTotals, useRegularVat } from './lite-support.mjs';

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp();
  await seedDesktopData(desktop.page);
  // Seeding writes past react-query; reload so views read the seeded rows. The seeded company is a
  // small business, which has no VAT lines: switch to regular VAT so 19 % and 7 % positions are priced.
  await useRegularVat(desktop.page);
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

const alertRegion = (page) => page.getByRole('region', { name: 'Aktionsmeldungen' });
const pageTitle = (page) => page.getByRole('banner').getByRole('heading', { level: 1 });
const listInvoices = (page) => invokeDesktopIpc(page, 'invoices:list', {});
const listOffers = (page) => invokeDesktopIpc(page, 'offers:list', {});
const byId = (rows, id) => rows.find((row) => row.id === id);
const text = (file) => execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
const normalized = async (locator) => ((await locator.innerText()) ?? '').replace(/\s+/g, ' ').trim();

const openNewDocument = async (page, baseUrl, kind = 'invoice') => {
  await page.goto(appUrl(baseUrl, kind === 'offer' ? '/documents?kind=offer' : '/documents'));
  await page.getByRole('banner').getByRole('button', { name: kind === 'offer' ? 'Neues Angebot' : 'Neue Rechnung' }).click();
  await expect(pageTitle(page)).toHaveText(kind === 'offer' ? 'Angebot erstellen' : 'Rechnung erstellen');
  return await page.getByRole('textbox', { name: kind === 'offer' ? 'Angebots-Nr.' : 'Rechnungs-Nr.' }).inputValue();
};

const pickClient = async (page, search, company) => {
  await page.getByRole('combobox', { name: 'Kunde auswählen' }).fill(search);
  await page.getByRole('option').filter({ hasText: company }).click();
  await expect(page.getByRole('combobox', { name: 'Kunde auswählen' })).toHaveValue(company);
};

/** Adds one billing position through the sheet; `index` is the 1-based position number. */
const addPosition = async (page, index, { description, quantity = 1, price, vatRate }) => {
  await page.getByRole('button', { name: 'Position hinzufügen' }).click();
  await page.getByRole('combobox', { name: `Beschreibung Position ${index}`, exact: true }).fill(description);
  const row = page.getByRole('row').filter({ has: page.getByRole('combobox', { name: `Beschreibung Position ${index}`, exact: true }) });
  await row.getByRole('spinbutton', { name: 'Menge' }).fill(String(quantity));
  await page.getByRole('spinbutton', { name: `Einzelpreis ${index}` }).fill(String(price));
  if (vatRate !== undefined) await page.getByRole('combobox', { name: `Umsatzsteuer Position ${index}` }).selectOption(String(vatRate));
};

test('invoice lifecycle: draft, issue, refused edit, partial and full payment, PDF', async () => {
  const { page, baseUrl, userDataDir } = desktop;
  const shot = createShooter(page);
  const invoicesBefore = await listInvoices(page);

  // --- New invoice with a 19 % and a 7 % position. ---
  const reservedNumber = await openNewDocument(page, baseUrl);
  expect(reservedNumber).toMatch(/^RE-\d{4}-\d{3}$/);
  await pickClient(page, 'Musterfirma', 'Musterfirma GmbH');
  await addPosition(page, 1, { description: 'Beratung Lifecycle', quantity: 2, price: 100, vatRate: 19 });
  await addPosition(page, 2, { description: 'Fachbuch Lifecycle', quantity: 1, price: 50, vatRate: 7 });

  // Net 250,00; 19 % of 200,00 = 38,00; 7 % of 50,00 = 3,50; gross 291,50.
  await expect.poll(() => readEditorTotals(page)).toEqual([
    ['Nettobetrag', '250,00 €'],
    ['USt. 19 % auf 200,00 €', '38,00 €'],
    ['USt. 7 % auf 50,00 €', '3,50 €'],
    ['Gesamtbetrag', '291,50 €'],
  ]);
  await shot('editor-two-vat-rates');
  await page.getByRole('button', { name: 'Vorschau' }).click();
  const preview = page.getByTestId('document-preview');
  await expect(preview).toContainText(reservedNumber);
  await expect(preview).toContainText('Musterfirma GmbH');
  await expect(preview).toContainText('291,50 €');
  await shot('preview');
  await page.getByRole('button', { name: 'Bearbeiten', exact: true }).click();

  // --- Save as draft: it shows up in the list and is persisted as a draft. ---
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect(page).toHaveURL(/#\/documents(?:\?|$)/);
  await expect(page.getByRole('row', { name: `Rechnung ${reservedNumber} öffnen` })).toBeVisible();
  await page.getByRole('radio', { name: 'Entwurf' }).click();
  const draftRow = page.getByRole('row', { name: `Rechnung ${reservedNumber} öffnen` });
  await expect(draftRow).toBeVisible();
  await expect(draftRow).toContainText('Entwurf');
  await expect(draftRow).toContainText('291,50');
  await shot('list-draft');

  const created = (await listInvoices(page)).find((invoice) => invoice.number === reservedNumber);
  expect(created).toMatchObject({ status: 'draft', clientId: 'c1', client: 'Musterfirma GmbH', amount: 291.5, documentKind: 'invoice' });
  expect(created.items.map((item) => [item.description, item.quantity, item.price, item.taxRate ?? 19])).toEqual([
    ['Beratung Lifecycle', 2, 100, 19],
    ['Fachbuch Lifecycle', 1, 50, 7],
  ]);
  expect(created.taxSnapshot).toMatchObject({ netAmount: 250, vatAmount: 41.5, grossAmount: 291.5 });
  expect(created.taxSnapshot.vatBreakdown).toEqual([
    { rate: 19, netAmount: 200, vatAmount: 38 },
    { rate: 7, netAmount: 50, vatAmount: 3.5 },
  ]);
  expect(created.payments).toEqual([]);
  expect((await listInvoices(page)).length).toBe(invoicesBefore.length + 1);

  // --- Issue it: draft -> open, number kept, layout frozen. ---
  await draftRow.click();
  await expect(pageTitle(page)).toHaveText(reservedNumber);
  await expect(page.getByRole('button', { name: 'Zahlung', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Stellen', exact: true }).click();
  await page.getByRole('dialog', { name: 'Rechnung stellen' }).getByRole('button', { name: 'Stellen', exact: true }).click();
  await expect(alertRegion(page).getByText('Rechnung als gestellt markiert')).toBeVisible();
  await expect(page.getByRole('main')).toContainText('Offen');
  await expect(page.getByRole('button', { name: 'Zahlung', exact: true })).toBeEnabled();
  await shot('issued');

  const issued = byId(await listInvoices(page), created.id);
  expect(issued).toMatchObject({ status: 'open', number: reservedNumber, amount: 291.5 });
  expect(issued.layout?.snapshot).toBeTruthy();

  // --- An issued invoice opens read-only: no editor, a hint to revision / cancellation, and the backend refuses a change. ---
  await expect(page.getByRole('banner').getByRole('button', { name: 'Bearbeiten', exact: true })).toHaveCount(0);
  await expect(page.getByRole('note').filter({ hasText: 'schreibgeschützt' })).toContainText('Gutschrift, Storno oder Revision');
  await shot('issued-read-only');
  const refusedEdit = await invokeDesktopIpc(page, 'invoices:upsert', { reason: 'Betrag angepasst', invoice: { ...issued, items: issued.items.map((item, index) => (index === 0 ? { ...item, price: 1000 } : item)) } })
    .then(() => null, (error) => String(error));
  expect(refusedEdit).toContain('Gestellte Rechnungen bleiben unverändert');
  const afterRefusedEdit = byId(await listInvoices(page), created.id);
  expect(afterRefusedEdit).toMatchObject({ status: 'open', amount: 291.5 });
  expect(afterRefusedEdit.items.map((item) => item.price)).toEqual([100, 50]);
  await page.getByRole('button', { name: 'Zurück zur Liste' }).click();
  await page.getByRole('radiogroup', { name: 'Status' }).getByRole('radio', { name: 'Alle' }).click();

  // --- Partial payment keeps it open, the rest pays it. ---
  await page.getByRole('row', { name: `Rechnung ${reservedNumber} öffnen` }).click();
  await expect(pageTitle(page)).toHaveText(reservedNumber);
  await page.getByRole('button', { name: 'Zahlung', exact: true }).click();
  const paymentDialog = page.getByRole('dialog', { name: 'Zahlung erfassen' });
  await expect(paymentDialog.getByLabel('Betrag (EUR)')).toHaveValue('291.50');
  await paymentDialog.getByLabel('Betrag (EUR)').fill('100,00');
  await paymentDialog.getByLabel('Grund (Pflicht)').fill('Teilzahlung laut Kontoauszug');
  await shot('payment-partial-dialog');
  await paymentDialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(paymentDialog).toHaveCount(0);
  await expect.poll(() => normalized(page.getByRole('main'))).toContain('Bezahlt 100,00 € Noch offen 191,50 €');
  await shot('partially-paid');
  const partiallyPaid = byId(await listInvoices(page), created.id);
  expect(partiallyPaid.status).toBe('open');
  expect(partiallyPaid.payments.map((payment) => payment.amount)).toEqual([100]);

  await page.getByRole('button', { name: 'Zahlung', exact: true }).click();
  await expect(paymentDialog.getByLabel('Betrag (EUR)')).toHaveValue('191.50');
  await paymentDialog.getByLabel('Grund (Pflicht)').fill('Restzahlung laut Kontoauszug');
  await paymentDialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(paymentDialog).toHaveCount(0);
  await expect(page.getByText(/^Bezahlt am /)).toBeVisible();
  await expect.poll(() => normalized(page.getByRole('main'))).toContain('Noch offen 0,00 €');
  await shot('paid');
  const paid = byId(await listInvoices(page), created.id);
  expect(paid.status).toBe('paid');
  expect(paid.payments.map((payment) => payment.amount).sort((a, b) => a - b)).toEqual([100, 191.5]);

  // --- Export the PDF from the detail page; number, totals and client are printed. ---
  await page.getByRole('banner').getByRole('button', { name: 'PDF', exact: true }).click();
  await expect(alertRegion(page).getByText('PDF gespeichert')).toBeVisible();
  const exportsDir = path.join(userDataDir, 'exports');
  await expect.poll(() => fs.existsSync(exportsDir) && fs.readdirSync(exportsDir).some((file) => file.includes(reservedNumber))).toBe(true);
  const pdfFile = path.join(exportsDir, fs.readdirSync(exportsDir).find((file) => file.includes(reservedNumber)));
  fs.copyFileSync(pdfFile, test.info().outputPath('invoice-lifecycle.pdf'));
  const pdfText = text(pdfFile);
  for (const expected of [reservedNumber, 'Musterfirma GmbH', 'Beratung Lifecycle', 'Fachbuch Lifecycle', '250,00', '38,00', '3,50', '291,50']) {
    expect(pdfText).toContain(expected);
  }
  expect(pdfText).not.toContain('ENTWURF');
  await shot('pdf-exported');
});

test('offer to invoice: create, accept by phone, convert once, same items and amount', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);

  // --- New offer with a 19 % and a 7 % position. ---
  const offerNumber = await openNewDocument(page, baseUrl, 'offer');
  expect(offerNumber).toMatch(/^ANG-\d{4}-\d{3}$/);
  await pickClient(page, 'StartUp', 'StartUp Berlin AG');
  await addPosition(page, 1, { description: 'Workshop Angebot', quantity: 3, price: 80, vatRate: 19 });
  await addPosition(page, 2, { description: 'Handbuch Angebot', quantity: 1, price: 40, vatRate: 7 });
  // Net 280,00; 19 % of 240,00 = 45,60; 7 % of 40,00 = 2,80; gross 328,40.
  await expect.poll(() => readEditorTotals(page)).toEqual([
    ['Nettobetrag', '280,00 €'],
    ['USt. 19 % auf 240,00 €', '45,60 €'],
    ['USt. 7 % auf 40,00 €', '2,80 €'],
    ['Gesamtbetrag', '328,40 €'],
  ]);
  await shot('offer-editor');
  await page.getByRole('button', { name: 'Speichern' }).click();
  await expect(page).toHaveURL(/#\/documents\?kind=offer$/);
  const offerRow = page.getByRole('row', { name: new RegExp(`${offerNumber} öffnen`) });
  await expect(offerRow).toContainText('Entwurf');
  await expect(offerRow).toContainText('328,40');
  await shot('offer-list');

  const offer = (await listOffers(page)).find((row) => row.number === offerNumber);
  expect(offer).toMatchObject({ clientId: 'c2', amount: 328.4, status: 'draft' });
  expect(offer.shareDecision ?? null).toBeNull();

  // --- Phone acceptance. ---
  await offerRow.click();
  await expect(pageTitle(page)).toHaveText(offerNumber);
  await expect(page.getByText('Noch keine Entscheidung')).toBeVisible();
  await expect(page.getByRole('button', { name: 'In Rechnung umwandeln' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Angenommen' }).click();
  await expect(alertRegion(page).getByText('Angebot als angenommen markiert.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'In Rechnung umwandeln' })).toBeVisible();
  await shot('offer-accepted');
  expect(byId(await listOffers(page), offer.id).shareDecision).toBe('accepted');

  // --- Convert: a new draft invoice with the same items and amount and its own number. ---
  const invoicesBefore = await listInvoices(page);
  await page.getByRole('button', { name: 'In Rechnung umwandeln' }).click();
  await expect(alertRegion(page).getByText('Rechnung erfolgreich erstellt!')).toBeVisible();
  // The view switches to the new invoice's detail page by itself.
  await expect(pageTitle(page)).toHaveText(/^RE-\d{4}-\d{3}$/, { timeout: 15_000 });
  const invoiceNumber = (await pageTitle(page).innerText()).trim();
  await expect(page.getByRole('main')).toContainText(`aus Angebot ${offerNumber} übernommen`);
  await shot('converted-invoice');

  const invoicesAfter = await listInvoices(page);
  expect(invoicesAfter.length).toBe(invoicesBefore.length + 1);
  const invoice = invoicesAfter.find((row) => row.number === invoiceNumber);
  expect(invoice.number).not.toBe(offerNumber);
  expect(invoice).toMatchObject({ documentKind: 'invoice', status: 'draft', clientId: 'c2', client: 'StartUp Berlin AG', amount: offer.amount, sourceDocumentId: offer.id });
  expect(invoice.items.map((item) => [item.description, item.quantity, item.price, item.taxRate ?? 19])).toEqual(
    offer.items.map((item) => [item.description, item.quantity, item.price, item.taxRate ?? 19]),
  );
  expect(invoice.taxSnapshot).toMatchObject({ netAmount: 280, vatAmount: 48.4, grossAmount: 328.4 });
  expect(await normalized(page.getByRole('main'))).toContain('Gesamt 328,40 €');
  // The offer itself stays what it was.
  expect(byId(await listOffers(page), offer.id)).toMatchObject({ number: offerNumber, amount: 328.4, shareDecision: 'accepted' });

  // --- Converting the same offer again must not create a second invoice. ---
  await page.getByRole('button', { name: 'Zurück zur Liste' }).click();
  await page.getByRole('radio', { name: 'Angebote' }).click();
  await page.getByRole('row', { name: new RegExp(`${offerNumber} öffnen`) }).click();
  await page.getByRole('button', { name: 'In Rechnung umwandeln' }).click();
  await expect(pageTitle(page)).toHaveText(invoiceNumber, { timeout: 15_000 });
  expect((await listInvoices(page)).length).toBe(invoicesAfter.length);

  // The invoice carries the link back to the offer (above); the offer's own page shows nothing about the conversion.
  await page.getByRole('button', { name: 'Zurück zur Liste' }).click();
  await page.getByRole('radio', { name: 'Angebote' }).click();
  await page.getByRole('row', { name: new RegExp(`${offerNumber} öffnen`) }).click();
  await expect(pageTitle(page)).toHaveText(offerNumber);
  await expect(page.getByRole('main')).toContainText(invoiceNumber);
});

/** Writes a German bank export (FinTS-style columns, ';' delimiter, dd.mm.yyyy dates, decimal commas). */
const writeStatement = (openInvoice) => {
  const file = path.join(os.tmpdir(), `billme-e2e-main-flow-${process.pid}-${Date.now()}.csv`);
  const rows = [
    ['01.10.2026', '3.450,50', 'StartUp Berlin AG', `Zahlung ${openInvoice.number}`],
    ['02.10.2026', '25,00', 'Unbekannt GmbH', 'Sonstige Einnahme'],
    ['02.10.2026', '-49,90', 'Adobe Systems', 'Creative Cloud Abo'],
  ];
  fs.writeFileSync(file, `Buchungstag;Betrag;Auftraggeber/Empfänger;Verwendungszweck\n${rows.map((row) => row.join(';')).join('\n')}\n`, 'utf8');
  return file;
};

/** Imports the statement through "CSV importieren"; the OS file chooser is answered in the main process. */
const importStatement = async (desktop, csv, shot) => {
  const { page, baseUrl } = desktop;
  await answerNextFilePicker(desktop, csv);
  await page.goto(appUrl(baseUrl, '/accounts'));
  await expect(page.getByText('Keine offenen Transaktionen')).toBeVisible();
  await page.getByRole('button', { name: 'CSV importieren' }).click();
  const importDialog = page.getByRole('dialog', { name: 'CSV-Import prüfen' });
  await expect(importDialog).toContainText('erkannt als Bank (FinTS-Export)');
  await expect(importDialog).toContainText('3 von 3 Zeilen gültig');
  await shot('csv-preview');
  await importDialog.getByRole('button', { name: '3 Buchungen importieren' }).click();
  await expect(alertRegion(page).getByText('Erfolgreich 3 Transaktionen importiert')).toBeVisible();

  const imported = await invokeDesktopIpc(page, 'transactions:list', { accountId: 'acc1' });
  expect(imported.map((tx) => [tx.counterparty, tx.amount, tx.type, tx.date]).sort()).toEqual([
    ['Adobe Systems', -49.9, 'expense', '2026-10-02'],
    ['StartUp Berlin AG', 3450.5, 'income', '2026-10-01'],
    ['Unbekannt GmbH', 25, 'income', '2026-10-02'],
  ]);
  expect(imported.every((tx) => !tx.linkedInvoiceId)).toBe(true);
  // The open income rows are queued for matching; the expense is not.
  await expect(page.getByRole('heading', { name: '2 offene Transaktionen' })).toBeVisible();
  return imported.find((tx) => tx.counterparty === 'StartUp Berlin AG');
};

const unlinkSelected = async (page) => {
  await page.getByRole('button', { name: 'Zuordnung aufheben' }).click();
  await page.getByRole('dialog', { name: 'Zuordnung wirklich aufheben?' }).getByRole('button', { name: 'Ja, aufheben' }).click();
  await expect(alertRegion(page).getByText('Zuordnung erfolgreich aufgehoben')).toBeVisible();
};

test('bank statement CSV: import in the UI, match to an open invoice, pay it, unlink', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const openInvoice = byId(await listInvoices(page), 'inv-open-1');
  expect(openInvoice).toMatchObject({ status: 'open', amount: 3450.5, client: 'StartUp Berlin AG' });
  const csv = writeStatement(openInvoice);
  try {
    fs.copyFileSync(csv, test.info().outputPath('bank-statement.csv'));
    const bankTx = await importStatement(desktop, csv, shot);

    // --- Matching: the invoice with the same amount and customer name is suggested first. ---
    await page.getByRole('button', { name: /StartUp Berlin AG.*3\.450,50/ }).click();
    await expect(page.getByText(openInvoice.number, { exact: true })).toBeVisible();
    await expect(page.getByText('Hohe Übereinstimmung')).toBeVisible();
    await expect(page.getByRole('textbox', { name: `Zuordnungsbetrag ${openInvoice.number} in EUR` })).toHaveValue('3450.5');
    await shot('match-suggestion');
    await page.getByRole('button', { name: 'Zahlung zuordnen' }).click();
    await expect(alertRegion(page).getByText(/Zahlung zugeordnet/)).toBeVisible();

    const paid = byId(await listInvoices(page), openInvoice.id);
    expect(paid.status).toBe('paid');
    expect(paid.payments.map((payment) => payment.amount)).toEqual([3450.5]);
    const linkedTx = (await invokeDesktopIpc(page, 'transactions:list', { accountId: 'acc1' })).find((tx) => tx.id === bankTx.id);
    expect(linkedTx).toMatchObject({ linkedInvoiceId: openInvoice.id, appliedAmountCents: 345050 });
    await expect(page.getByRole('heading', { name: '1 offene Transaktion' })).toBeVisible();
    await shot('linked');

    // The invoice detail agrees.
    await page.goto(appUrl(baseUrl, '/documents'));
    await page.getByRole('row', { name: `Rechnung ${openInvoice.number} öffnen` }).click();
    await expect(page.getByText(/^Bezahlt am /)).toBeVisible();
    await shot('invoice-paid-by-bank');

    // --- Unlink: the invoice is open again and the booking is back in the queue. ---
    await page.goto(appUrl(baseUrl, '/accounts'));
    await page.getByRole('button', { name: 'Alle anzeigen' }).click();
    await page.getByRole('button', { name: /StartUp Berlin AG.*Zugeordnet/ }).click();
    await expect(page.getByText('Bereits zugeordnet.')).toBeVisible();
    await unlinkSelected(page);
    const reopened = byId(await listInvoices(page), openInvoice.id);
    expect(reopened.status).toBe('open');
    expect(reopened.payments).toEqual([]);
    expect(await invokeDesktopIpc(page, 'transactions:list', { accountId: 'acc1', linkedOnly: true })).toEqual([]);
    await expect(page.getByRole('heading', { name: '2 offene Transaktionen' })).toBeVisible();
    await shot('unlinked');

    // --- Importing the same file again adds nothing (same file hash, same import batch). ---
    await answerNextFilePicker(desktop, csv);
    await page.getByRole('button', { name: 'CSV importieren' }).click();
    const importDialog = page.getByRole('dialog', { name: 'CSV-Import prüfen' });
    await importDialog.getByRole('button', { name: '3 Buchungen importieren' }).click();
    await expect(importDialog).toHaveCount(0);
    await expect.poll(async () => (await invokeDesktopIpc(page, 'finance:listImportBatches', {})).length).toBe(1);
    expect((await invokeDesktopIpc(page, 'transactions:list', { accountId: 'acc1' })).length).toBe(3);
    await shot('reimport');
  } finally {
    fs.rmSync(csv, { force: true });
  }
});

test('bank statement CSV: a partial allocation keeps the invoice open and can be undone', async () => {
  const { page } = desktop;
  const shot = createShooter(page);
  const openInvoice = byId(await listInvoices(page), 'inv-open-1');
  const csv = writeStatement(openInvoice);
  try {
    const bankTx = await importStatement(desktop, csv, shot);
    await page.getByRole('button', { name: /StartUp Berlin AG.*3\.450,50/ }).click();
    const allocation = page.getByRole('textbox', { name: `Zuordnungsbetrag ${openInvoice.number} in EUR` });
    await allocation.fill('1000');
    await expect(page.getByText('Rest aus dieser Bankzahlung: 2.450,50 €')).toBeVisible();
    await page.getByRole('button', { name: 'Zahlung zuordnen' }).click();
    await expect(alertRegion(page).getByText(/Zahlung zugeordnet/)).toBeVisible();

    const partlyPaid = byId(await listInvoices(page), openInvoice.id);
    expect(partlyPaid.status).toBe('open');
    expect(partlyPaid.payments.map((payment) => payment.amount)).toEqual([1000]);
    const linkedTx = (await invokeDesktopIpc(page, 'transactions:list', { accountId: 'acc1' })).find((tx) => tx.id === bankTx.id);
    expect(linkedTx).toMatchObject({ linkedInvoiceId: openInvoice.id, appliedAmountCents: 100000, unallocatedAmountCents: 245050 });

    await page.getByRole('button', { name: 'Alle anzeigen' }).click();
    await page.getByRole('button', { name: /StartUp Berlin AG.*Zugeordnet/ }).click();
    await expect(page.getByText('1.000,00 € für die Rechnung; Rest 2.450,50 €')).toBeVisible();
    await shot('linked-partial');
    await unlinkSelected(page);
    const reopened = byId(await listInvoices(page), openInvoice.id);
    expect(reopened.status).toBe('open');
    expect(reopened.payments).toEqual([]);

    // Selecting the booking again suggests the invoice with its full open amount.
    await page.getByRole('button', { name: /StartUp Berlin AG.*3\.450,50/ }).click();
    await shot('suggestion-after-unlink');
    await expect(page.getByText('3.450,50 € offen')).toBeVisible();
  } finally {
    fs.rmSync(csv, { force: true });
  }
});

test.describe('negative paths', () => {
  const validationSummary = (page) => page.getByText('Bitte korrigiere die markierten Pflichtfelder.').first();

  test('an invoice without a client is refused and nothing is persisted', async () => {
    const { page, baseUrl } = desktop;
    const shot = createShooter(page);
    const invoicesBefore = await listInvoices(page);
    await openNewDocument(page, baseUrl);
    await addPosition(page, 1, { description: 'Leistung ohne Kunde', price: 100, vatRate: 19 });
    await page.getByRole('button', { name: 'Speichern' }).click();

    await expect(validationSummary(page)).toBeVisible();
    await expect(page.getByText('Kunde: Kunde ist erforderlich.').first()).toBeVisible();
    await expect(pageTitle(page)).toHaveText('Rechnung erstellen');
    await expect(page).toHaveURL(/#\/documents\/edit$/);
    await shot('no-client');
    expect(await listInvoices(page)).toEqual(invoicesBefore);

    // Leaving the editor still persists nothing.
    await page.getByRole('button', { name: 'Zurück' }).click();
    await page.getByRole('button', { name: 'Änderungen verwerfen' }).click();
    expect(await listInvoices(page)).toEqual(invoicesBefore);
  });

  test('an invoice without positions is refused and nothing is persisted', async () => {
    const { page, baseUrl } = desktop;
    const shot = createShooter(page);
    const invoicesBefore = await listInvoices(page);
    await openNewDocument(page, baseUrl);
    await pickClient(page, 'Musterfirma', 'Musterfirma GmbH');
    await page.getByRole('button', { name: 'Speichern' }).click();
    await shot('no-positions');

    // The editor's validate() only checks number, date, client and the description of positions that exist.
    const saved = (await listInvoices(page)).length !== invoicesBefore.length;
    await expect(validationSummary(page)).toBeVisible();
    await expect(pageTitle(page)).toHaveText('Rechnung erstellen');
    expect(await listInvoices(page)).toEqual(invoicesBefore);
  });

  test('cancelling a new draft releases its number for the next invoice', async () => {
    const { page, baseUrl } = desktop;
    const shot = createShooter(page);
    const invoicesBefore = await listInvoices(page);

    // An untouched draft leaves without a prompt.
    const first = await openNewDocument(page, baseUrl);
    await page.getByRole('button', { name: 'Zurück' }).click();
    await expect(page.getByText('Ungespeicherte Änderungen verwerfen?')).toHaveCount(0);
    await expect(pageTitle(page)).toHaveText('Rechnungen & Angebote');

    // An edited one asks first, then discards.
    const second = await openNewDocument(page, baseUrl);
    expect(second).toBe(first);
    await pickClient(page, 'Musterfirma', 'Musterfirma GmbH');
    await addPosition(page, 1, { description: 'Verworfene Leistung', price: 10, vatRate: 19 });
    await page.getByRole('button', { name: 'Zurück' }).click();
    await expect(page.getByRole('dialog', { name: 'Ungespeicherte Änderungen verwerfen?' })).toBeVisible();
    await shot('discard-prompt');
    await page.getByRole('button', { name: 'Änderungen verwerfen' }).click();
    await expect(pageTitle(page)).toHaveText('Rechnungen & Angebote');
    expect(await listInvoices(page)).toEqual(invoicesBefore);

    // The next invoice that is actually saved gets that number.
    const third = await openNewDocument(page, baseUrl);
    expect(third).toBe(first);
    await pickClient(page, 'Musterfirma', 'Musterfirma GmbH');
    await addPosition(page, 1, { description: 'Gespeicherte Leistung', price: 10, vatRate: 19 });
    await page.getByRole('button', { name: 'Speichern' }).click();
    await expect(page).toHaveURL(/#\/documents(?:\?|$)/);
    const saved = (await listInvoices(page)).find((invoice) => invoice.items.some((item) => item.description === 'Gespeicherte Leistung'));
    expect(saved.number).toBe(first);

    // And the one after that moves on.
    const fourth = await openNewDocument(page, baseUrl);
    expect(fourth).not.toBe(first);
    await page.getByRole('button', { name: 'Zurück' }).click();
    await shot('numbers');
  });
});

test('the detail page prices a mixed-rate invoice per VAT rate', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const number = await openNewDocument(page, baseUrl);
  await pickClient(page, 'Musterfirma', 'Musterfirma GmbH');
  await addPosition(page, 1, { description: 'Gemischt 19', price: 100, vatRate: 19 });
  await addPosition(page, 2, { description: 'Gemischt 7', price: 50, vatRate: 7 });
  await page.getByRole('button', { name: 'Speichern' }).click();
  await page.getByRole('row', { name: `Rechnung ${number} öffnen` }).click();
  await expect(pageTitle(page)).toHaveText(number);
  await shot('mixed-rate-detail');
  // Totals add up: net 150,00 + VAT 22,50 = gross 172,50.
  const summary = await normalized(page.getByRole('main'));
  expect(summary).toContain('Netto 150,00 €');
  expect(summary).toContain('Gesamt 172,50 €');
  expect(summary).toContain('USt 19% auf 100,00 € 19,00 €');
  expect(summary).toContain('USt 7% auf 50,00 € 3,50 €');
});
