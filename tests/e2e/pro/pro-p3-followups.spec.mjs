import { expect, test } from '@playwright/test';
import {
  appUrl, approveProDraft, importPendingProTransaction, invokeDesktopIpc, launchDesktopApp, PRO_DOUBLE_ENTRY_SETTINGS, seedDesktopData, setProAccountingPeriodStatus,
} from '../support.mjs';
import { balancedBankDraft, shooter } from './pro-p3-support.mjs';

/**
 * Follow-ups of the Pro user walkthrough (24.10.2026), each clicked like the user and read back through the backend.
 *
 * How this can fail:
 * - OPOS: booked payments without invoice and customer, or the action column cut off (B3)
 * - InvoicesView: a payment into a soft-locked month failing without a way to confirm it (SOFT_LOCK)
 * - Belege: the due date staying put when the invoice date moves (B6); "Kunden" in the sidebar
 *   keeping the open customer instead of showing the list (B7)
 * - assets: Kostenstelle/Standort required (B16), no Anlagenspiegel (B16), the yearly AfA booked in
 *   full in mid-year or answered with a raw code (B17)
 * - bank drafts: no way to attach a Beleg, a line that stays "Beleg fehlt", a posting that does not
 *   name the Beleg (B21); a reversed line that cannot be kontiert again; 3120 searched without a hint (B19)
 * - Pro EÜR profile: an imported bank line missing from the classification, the onboarding dialog
 *   back after every reload (B27)
 * - Steuer: the ELSTER export page not reachable (/tax-filing)
 * - asset sale: no way to sell to a customer with an outgoing invoice, or the proceeds booked twice (by the
 *   invoice and the disposal) (B18)
 */

let desktop;

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

const startPro = async (settingsOverrides = PRO_DOUBLE_ENTRY_SETTINGS) => {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedDesktopData(desktop.page, { app: 'pro', settingsOverrides });
  await desktop.page.reload();
  return desktop;
};
const invoiceNumber = async (page, id) => (await invokeDesktopIpc(page, 'invoices:list', {})).find((invoice) => invoice.id === id).number;

test('OPOS: a booked payment names its invoice and customer, and its action stays visible (B3)', async () => {
  const { page, baseUrl } = await startPro();
  const shot = shooter(page);
  const number = await invoiceNumber(page, 'inv-paid-1');
  await page.goto(appUrl(baseUrl, '/accounting?view=opos'));
  const table = page.getByRole('table', { name: 'Gebuchte Zahlungen' });
  await expect(table.getByRole('columnheader', { name: 'Kunde / Lieferant' })).toBeVisible();
  const row = table.getByRole('row').filter({ hasText: number });
  await expect(row).toContainText('Musterfirma GmbH');
  await table.scrollIntoViewIfNeeded();
  await expect(row.getByRole('button', { name: 'Umbuchen' }), 'the action column is not cut off').toBeInViewport();
  await shot('opos-payments');
});

test('a payment into a soft-locked month asks first and is booked with the reason (SOFT_LOCK)', async () => {
  await startPro();
  await setProAccountingPeriodStatus(desktop, '2026-03');
  const { page, baseUrl } = desktop;
  const shot = shooter(page);
  const number = await invoiceNumber(page, 'inv-open-1');
  await page.goto(appUrl(baseUrl, '/documents'));
  await page.getByRole('row', { name: `Rechnung ${number} öffnen` }).click();
  await page.getByRole('button', { name: 'Zahlung', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Zahlung erfassen' });
  await dialog.getByLabel('Datum').fill('2026-03-10');
  await dialog.getByLabel('Betrag (EUR)').fill('100,00');
  await dialog.getByLabel('Grund (Pflicht)').fill('Teilzahlung März, Monat geprüft');
  await dialog.getByRole('button', { name: 'Speichern' }).click();
  await expect(dialog.getByTestId('payment-soft-lock')).toContainText('vorläufig gesperrt');
  await expect(dialog).not.toContainText('SOFT_LOCK');
  await shot('soft-lock-asks');
  await dialog.getByRole('button', { name: 'Trotzdem buchen' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await invokeDesktopIpc(page, 'invoices:list', {})).find((invoice) => invoice.id === 'inv-open-1').payments.map((payment) => payment.amount)).toContain(100);
  await shot('soft-lock-booked');
});

test('the due date follows a new invoice date (B6), and "Kunden" leads from a customer back to the list (B7)', async () => {
  const { page, baseUrl } = await startPro();
  const shot = shooter(page);
  await page.goto(appUrl(baseUrl, '/clients'));
  await page.getByRole('row', { name: 'Musterfirma GmbH öffnen' }).click();
  await expect(page).toHaveURL(/id=c1/);
  await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name: 'Kunden' }).click();
  await expect(page).not.toHaveURL(/id=c1/);
  await expect(page.getByRole('row', { name: 'StartUp Berlin AG öffnen' })).toBeVisible();
  await shot('clients-list-again');

  const reservation = await invokeDesktopIpc(page, 'numbers:reserve', { kind: 'invoice' });
  const draft = await invokeDesktopIpc(page, 'invoices:upsert', {
    reason: 'E2E Entwurf',
    invoice: {
      id: `draft-b6-${Date.now()}`, number: reservation.number, numberReservationId: reservation.reservationId, clientId: 'c1', client: 'Musterfirma GmbH',
      clientEmail: 'entwurf@example.com', clientAddress: 'Weg 1\n10115 Berlin', date: '2026-04-01', dueDate: '2026-04-15', amount: 100, status: 'draft',
      items: [{ kind: 'item', description: 'Leistung', quantity: 1, price: 100, total: 100 }], payments: [], history: [], taxMode: 'small_business_19_ustg',
      taxMeta: { datevEvidenceType: 'exemption', datevEvidenceReference: '§19 UStG' },
    },
  });
  await page.reload();
  await page.goto(appUrl(baseUrl, '/documents'));
  await page.getByRole('button', { name: `${draft.number} bearbeiten` }).click();
  await page.getByLabel('Datum', { exact: true }).fill('2026-04-10');
  await expect(page.getByLabel('Fälligkeit', { exact: true }), 'the 14 days Zahlungsziel stay').toHaveValue('2026-04-24');
  await shot('due-date-follows');
});

test('an asset without Kostenstelle and Standort is activated, the AfA waits for the year end, the Anlagenspiegel adds up (B16, B17)', async () => {
  const { page, baseUrl } = await startPro();
  const shot = shooter(page);
  await page.goto(appUrl(baseUrl, '/accounting?view=assets'));
  await page.getByRole('button', { name: 'Neue Anlage' }).first().click();
  const form = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Neue Anlage' }) });
  await form.getByLabel('Anlagennummer').fill('ANL-P3-1');
  await form.getByLabel('Bezeichnung').fill('Notebook P3');
  await form.getByLabel('Anlagenklasse').fill('IT-Hardware');
  await form.getByLabel('Anlagenkonto').fill('0420');
  await form.getByLabel('Aktivierungsdatum').fill('2026-01-15');
  await form.getByLabel('Anschaffungskosten netto').fill('3600');
  await form.getByLabel('Nutzungsdauer in Jahren').fill('3');
  await form.getByLabel('Status').selectOption('aktiv');
  await form.getByLabel('Zugang gebucht über').selectOption('account');
  await form.getByLabel('Gegenkonto').fill('1200');
  await form.getByLabel('Audit-Grund').fill('Notebook gekauft');
  await form.getByRole('button', { name: 'Anlage speichern' }).click();
  await expect(page.getByTestId('asset-mutation-feedback')).toHaveText(/Anlage gespeichert/);
  const asset = (await invokeDesktopIpc(page, 'pro:listAssets')).find((candidate) => candidate.assetNumber === 'ANL-P3-1');
  expect([asset.status, asset.costCenter, asset.location]).toEqual(['aktiv', '', '']);

  const afa = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Abschreibung buchen' }) });
  await afa.getByLabel('Geschäftsjahr').fill('2026');
  await expect(afa.getByLabel('Buchungsdatum'), 'the year end is preset').toHaveValue('2026-12-31');
  await afa.getByLabel('Buchungsdatum').fill('2026-06-30');
  await afa.getByLabel('Audit-Grund').fill('AfA 2026');
  await afa.getByRole('button', { name: 'AfA buchen' }).click();
  await expect(page.getByTestId('asset-mutation-feedback')).toHaveText(/Ende des Wirtschaftsjahres \(31\.12\.2026\)/);
  await expect(page.getByTestId('asset-mutation-feedback')).not.toContainText('INVALID_');
  expect((await invokeDesktopIpc(page, 'pro:getDepreciationSchedule', { assetId: asset.id }))[0].status, 'nothing booked in June').toBe('planned');
  await shot('afa-mid-year-refused');
  await afa.getByLabel('Buchungsdatum').fill('2026-12-31');
  await afa.getByRole('button', { name: 'AfA buchen' }).click();
  await expect(page.getByTestId('asset-mutation-feedback')).toHaveText(/AfA 2026 gebucht/);

  await page.getByRole('button', { name: 'Anlagenspiegel' }).click();
  const dialog = page.getByRole('dialog', { name: 'Anlagenspiegel' });
  await dialog.getByLabel('Geschäftsjahr').fill('2026');
  const row = dialog.getByTestId('asset-register').getByRole('row').filter({ hasText: 'ANL-P3-1' });
  await expect(row).toContainText('3.600,00');
  await expect(row).toContainText('1.200,00');
  await expect(row).toContainText('2.400,00');
  await shot('anlagenspiegel');
});

test('a Beleg is attached to a bank draft and named in the posting; after a Storno the line is kontiert again (B21, B19)', async () => {
  const { page, baseUrl } = await startPro();
  const shot = shooter(page);
  const source = await importPendingProTransaction(page, 'beleg', { counterparty: 'Beleg Lieferant GmbH', amount: -59.5 });
  await page.reload();
  await page.goto(appUrl(baseUrl, '/accounting?view=reconciliation'));
  await page.getByText('Beleg Lieferant GmbH').first().click();
  await page.getByRole('button', { name: 'Im Editor öffnen' }).click();
  const aside = page.getByRole('complementary', { name: 'Beleg, Prüfungen und Verlauf' });
  await expect(aside).toContainText('Beleg fehlt');
  await aside.locator('input[type="file"]').setInputFiles({ name: 'quittung.pdf', mimeType: 'application/pdf', buffer: Buffer.from(`%PDF-1.4\n${Date.now()}`) });
  await expect(aside.getByTestId('receipt-message')).toHaveText(/Beleg archiviert/);
  await expect(aside).toContainText('Beleg vorhanden');
  await expect(aside.getByRole('button', { name: 'quittung.pdf' })).toBeVisible();
  await shot('beleg-attached');
  expect((await invokeDesktopIpc(page, 'pro:listBankTransactionDocuments', { transactionId: source.transaction.id })).map((doc) => doc.originalFilename)).toEqual(['quittung.pdf']);
  expect((await invokeDesktopIpc(page, 'pro:listBankTransactions')).find((tx) => tx.id === source.transaction.id).receiptDocumentCount).toBe(1);

  const approved = await approveProDraft(page, balancedBankDraft(source));
  const posted = await invokeDesktopIpc(page, 'pro:postDraft', { draftId: approved.id, actorRole: 'accountant' });
  expect(posted.entry.lines.map((line) => line.evidenceReference)).toEqual(['quittung.pdf', 'quittung.pdf']);
  await invokeDesktopIpc(page, 'pro:reverseJournalEntry', { entryId: posted.entry.id, reason: 'Falsches Konto' });

  // The reversed line sits under "Gebucht" (posted, reversed, corrected) in the inbox.
  await page.reload();
  await page.goto(appUrl(baseUrl, '/accounting?view=inbox'));
  await page.getByRole('button', { name: /^Gebucht/ }).click();
  await page.getByText('Beleg Lieferant GmbH').first().click();
  await page.getByRole('button', { name: 'Erweitern' }).click();
  await page.getByRole('button', { name: 'Neu kontieren' }).click();
  await expect.poll(async () => (await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: source.transaction.id })).workflowStatus).toBe('corrected');
  await expect(page.getByText(/Original und Storno bleiben im Journal/)).toBeVisible();
  await shot('neu-kontieren');

  // B19: 3120 is a DATEV Automatikkonto; the search explains the Steuerfall instead of an empty list.
  await page.getByRole('combobox', { name: 'Konto suchen' }).first().fill('3120');
  await expect(page.getByText(/Automatikkonten für § 13b/)).toBeVisible();
  await shot('3120-hint');
});

test('Pro EÜR: an imported bank line is offered for classification, and a postponed onboarding stays closed on reload (B27)', async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
  const { page, baseUrl } = desktop;
  const shot = shooter(page);
  await page.goto(appUrl(baseUrl, '/'));
  await page.reload();
  const wizard = page.getByRole('dialog', { name: /einrichten$/ });
  await expect(wizard).toBeVisible();
  await wizard.getByRole('button', { name: 'Später fortsetzen' }).click();
  await expect(wizard).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation' })).toBeVisible();
  await expect(wizard, 'not back after a reload').toHaveCount(0);
  await shot('onboarding-postponed');

  await seedDesktopData(page, { app: 'pro' });
  await importPendingProTransaction(page, 'eur', { counterparty: 'EÜR Fachbuch Verlag', amount: -42, date: '2026-04-12' });
  const items = await invokeDesktopIpc(page, 'eur:listItems', { taxYear: 2026, from: '2026-01-01', to: '2026-12-31' });
  expect(items.filter((item) => item.counterparty === 'EÜR Fachbuch Verlag').map((item) => [item.flowType, item.amountGross])).toEqual([['expense', 42]]);
  await page.reload();
  await page.goto(appUrl(baseUrl, '/eur'));
  await expect(page.getByText('EÜR Fachbuch Verlag').first()).toBeVisible();
  await shot('eur-bank-line');
});

test('Steuer leads to the ELSTER export page (/tax-filing)', async () => {
  const { page, baseUrl } = await startPro();
  await page.goto(appUrl(baseUrl, '/accounting?view=tax'));
  await page.getByRole('button', { name: 'ELSTER-Export öffnen' }).click();
  await expect(page).toHaveURL(/tax-filing/);
  await page.screenshot({ path: test.info().outputPath('tax-filing.png'), fullPage: true });
});

test('an asset sold to a customer leaves a draft invoice „Verkauf Anlage …“ under Rechnungen, the disposal books only the book value (B18)', async () => {
  const { page, baseUrl } = await startPro();
  const shot = shooter(page);
  const [customer] = await invokeDesktopIpc(page, 'clients:list');
  const asset = await invokeDesktopIpc(page, 'pro:upsertAsset', {
    reason: 'E2E Anlage für Verkauf',
    asset: {
      id: 'p3-sale-asset', assetNumber: 'ANL-P3-SALE', name: 'Drucker', assetClass: 'IT-Hardware', status: 'aktiv', activationDate: '2026-01-01',
      acquisitionCost: 1200, usefulLifeYears: 1, depreciationMethod: 'linear', costCenter: '', location: '', receiptLinked: false,
      assetAccountNumber: '0420', acquisitionOffsetAccountNumber: '1200',
    },
  });
  await page.goto(appUrl(baseUrl, '/accounting?view=assets'));
  await page.getByRole('button', { name: /ANL-P3-SALE/ }).click();
  const form = page.locator('form').filter({ has: page.getByRole('heading', { name: 'Anlage ausbuchen' }) });
  await form.getByLabel('Ausbuchungsdatum').fill('2026-01-31');
  await form.getByLabel('Verkaufserlös netto').fill('1500');
  await form.getByLabel('Umsatzsteuersatz').selectOption('19');
  await form.getByLabel('Käufer (Kunde)').selectOption(customer.id);
  await expect(form.getByLabel('Erlöskonto / Zahlungskonto'), 'the invoice decides the accounts').toHaveCount(0);
  await form.getByLabel('Audit-Grund').fill('Drucker verkauft');
  await form.getByLabel(/Ich bestätige die Ausbuchung/).check();
  await form.getByRole('button', { name: 'Ausbuchung bestätigen' }).click();
  const feedback = page.getByTestId('asset-mutation-feedback');
  await expect(feedback).toHaveText(/Rechnungsentwurf .+ angelegt/);
  await shot('asset-sold-with-invoice');

  const invoice = (await invokeDesktopIpc(page, 'invoices:list', {})).find((row) => row.taxMeta?.assetSaleAssetId === asset.id);
  expect([invoice.status, invoice.clientId, invoice.items[0].description, invoice.items[0].taxRate]).toEqual(['draft', customer.id, 'Verkauf Anlage ANL-P3-SALE Drucker', 19]);
  const disposal = (await invokeDesktopIpc(page, 'pro:listAssets')).find((row) => row.id === asset.id);
  expect(disposal.status).toBe('verkauft');

  await page.goto(appUrl(baseUrl, '/documents'));
  await expect(page.getByText(invoice.number).first()).toBeVisible();
  await shot('draft-invoice-in-documents');
});
