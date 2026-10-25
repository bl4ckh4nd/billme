import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { appUrl, importPendingProTransaction, approveProDraft, getDesktopSettings, invokeDesktopIpc, launchDesktopApp, PRO_DOUBLE_ENTRY_SETTINGS, seedDesktopData, setDesktopSettings } from '../support.mjs';

/**
 * The main Pro flows through the visible UI, with the ledger as the witness (Playwright against the real Electron app):
 *  1. issue an invoice -> balanced entry (Forderung / Erlös / USt) -> Offene Posten -> bank line settles the item
 *  2. bank import -> rule suggestion accepted in the workbench -> posting in the journal
 *  3. BWA01 / HGB-GuV show the year's postings on the SKR range defaults, Management-GuV once its accounts are mapped
 *  4. DATEV Buchungsstapel export from the UI produces a file
 * Setup that is not the flow under test (seeding, rules, the rent posting) goes through the typed IPC bridge.
 */

let desktop;

// Double-entry GmbH (so Ausnahmen, Belege and Offene Posten are in the rail) that charges VAT.
const SETTINGS = { ...PRO_DOUBLE_ENTRY_SETTINGS, legal: { smallBusinessRule: false, defaultVatRate: 19 } };

test.beforeEach(async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
  // The seed issues Kleinunternehmer invoices, so it runs under KU; the flows then charge VAT.
  await seedDesktopData(desktop.page, { app: 'pro', settingsOverrides: PRO_DOUBLE_ENTRY_SETTINGS });
  const settings = await getDesktopSettings(desktop.page);
  await setDesktopSettings(desktop.page, { ...settings, legal: { ...settings.legal, ...SETTINGS.legal } });
  // Seeding writes past react-query and the onboarding gate; reload so the shell reads the seeded rows.
  await desktop.page.reload();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

const shot = (name) => test.info().outputPath(`${name}.png`);
const today = () => new Date().toISOString().slice(0, 10);
const germanDate = (iso) => iso.split('-').reverse().join('.');
const journal = (page) => invokeDesktopIpc(page, 'pro:listJournalEntries', { limit: 500, offset: 0 });
const shape = (entry) => entry.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]);
const nav = (page, label) => page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name: label, exact: true }).click();

/** Creates a 19 % invoice in the editor and issues it ("Als gestellt markieren"); returns the stored invoice. */
const issueInvoiceThroughUi = async ({ page, baseUrl }, { description, net }) => {
  await page.goto(appUrl(baseUrl, '/documents'));
  await page.getByRole('button', { name: 'Neue Rechnung' }).first().click();
  await page.getByRole('combobox', { name: 'Kunde auswählen' }).fill('Musterfirma');
  await page.getByRole('option').filter({ hasText: 'Musterfirma GmbH' }).click();
  await page.getByRole('button', { name: 'Position hinzufügen' }).click();
  await page.getByRole('combobox', { name: 'Beschreibung Position 1', exact: true }).or(page.getByRole('textbox', { name: 'Beschreibung 1', exact: true })).fill(description);
  await page.getByRole('textbox', { name: 'Einzelpreis 1' }).or(page.getByRole('spinbutton', { name: 'Einzelpreis 1' })).fill(String(net));
  await page.locator('button').filter({ hasText: 'Speichern' }).click();
  await expect(page).toHaveURL(/#\/documents(?:\?|$)/);

  const find = async () => (await invokeDesktopIpc(page, 'invoices:list', {})).find((candidate) => candidate.items.some((item) => item.description === description));
  await expect.poll(async () => (await find())?.status).toBe('draft');
  const draft = await find();
  await page.getByText(draft.number, { exact: true }).first().click();
  await page.screenshot({ path: shot(`invoice-${draft.number}-draft`), fullPage: true });
  await page.getByRole('button', { name: 'Stellen', exact: true }).click();
  await page.getByRole('dialog', { name: 'Rechnung stellen' }).getByRole('button', { name: 'Stellen', exact: true }).click();
  await expect.poll(async () => (await find())?.status).toBe('open');
  return await find();
};

/** Imports a bank export through the CSV dialog of Konten (the native file picker is answered with the file). */
const importBankExportThroughUi = async ({ page, app, baseUrl }, rows) => {
  const csvPath = path.join(os.tmpdir(), `billme-e2e-bank-${process.pid}-${Date.now()}.csv`);
  fs.writeFileSync(csvPath, ['Buchungstag;Verwendungszweck;Empfänger;Betrag', ...rows].join('\n'));
  try {
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }); }, csvPath);
    const before = (await invokeDesktopIpc(page, 'pro:listBankTransactions')).length;
    await page.goto(appUrl(baseUrl, '/accounts'));
    await page.getByRole('button', { name: 'CSV importieren' }).click();
    const preview = page.getByRole('dialog', { name: 'CSV-Import prüfen' });
    await expect(preview).toBeVisible();
    await page.screenshot({ path: shot('bank-import-preview') });
    await preview.getByRole('button', { name: `${rows.length} Buchungen importieren` }).click();
    await expect(preview).toBeHidden();
    await expect.poll(async () => (await invokeDesktopIpc(page, 'pro:listBankTransactions')).length).toBe(before + rows.length);
    // The booking workbench keeps its list for 10 s (staleTime) and the import only invalidates the Konten queries.
    await page.reload();
  } finally {
    fs.rmSync(csvPath, { force: true });
  }
};

test('issues an invoice, books Forderung/Erlös/USt, lists the open item and settles it against the imported bank line', async () => {
  const { page } = desktop;
  const invoice = await issueInvoiceThroughUi(desktop, { description: 'E2E Beratung Hauptfluss', net: 1000 });
  expect(invoice).toMatchObject({ status: 'open', amount: 1190, client: 'Musterfirma GmbH' });
  await page.screenshot({ path: shot('01-invoice-issued'), fullPage: true });

  // The issued invoice is one posted, balanced entry: receivable (gross) against revenue (net) and output VAT.
  const entry = (await journal(page)).find((candidate) => candidate.sourceKey === `outgoing-invoice:${invoice.id}`);
  expect(entry, 'journal entry of the issued invoice').toBeTruthy();
  expect(entry.status).toBe('posted');
  expect(shape(entry)).toEqual([['1400', 1190, 0], ['8400', 0, 1000], ['1776', 0, 190]]);
  expect(entry.lines.reduce((sum, line) => sum + line.debitAmount - line.creditAmount, 0)).toBe(0);

  // ...and it is visible in the accounting UI: the SuSa carries it, the drilldown names the invoice.
  await nav(page, 'Auswertungen');
  await expect(page.getByRole('heading', { name: 'Auswertungen', level: 1 })).toBeVisible();
  const susa = page.getByRole('table', { name: 'Summen- und Saldenliste' });
  // Seeded: 1.250 € paid + 3.450,50 € open without VAT; this invoice adds 1.190 € / 1.000 € / 190 €.
  await expect(susa.getByRole('row', { name: /^1400 Forderungen aus Lieferungen und Leistungen 0,00 € 5\.890,50 € 1\.250,00 € 4\.640,50 €/ })).toBeVisible();
  // The seed issues as Kleinunternehmer (Erlöse § 19 UStG on 8195); only this invoice is on 8400.
  await expect(susa.getByRole('row', { name: /^8400 Erlöse 19 % USt 0,00 € 0,00 € 1\.000,00 € -1\.000,00 €/ })).toBeVisible();
  await expect(susa.getByRole('row', { name: /^8195 .* 0,00 € 0,00 € 4\.700,50 € -4\.700,50 €/ })).toBeVisible();
  await expect(susa.getByRole('row', { name: /^1776 Umsatzsteuer 19 % 0,00 € 0,00 € 190,00 € -190,00 €/ })).toBeVisible();
  await susa.getByRole('button', { name: '1776', exact: true }).click();
  const drilldown = page.getByRole('complementary').filter({ has: page.getByRole('button', { name: 'Drilldown schließen' }) });
  await expect(drilldown).toContainText(`Rechnung ${invoice.number}`);
  await expect(drilldown).toContainText('Haben');
  await expect(drilldown).toContainText('190,00 €');
  await page.screenshot({ path: shot('02-susa-with-invoice'), fullPage: true });

  // Offene Posten shows the receivable as open.
  await nav(page, 'Offene Posten');
  const receivables = page.getByRole('table', { name: 'Forderungen' });
  await expect(receivables.getByRole('row', { name: new RegExp(`^${invoice.number} \\d\\d\\.\\d\\d\\.\\d{4} 1\\.190,00 € Offen`) })).toBeVisible();
  await page.screenshot({ path: shot('03-opos-open'), fullPage: true });
  const openItem = (await invokeDesktopIpc(page, 'pro:listOpenItems')).find((item) => item.sourceId === invoice.id);
  expect(openItem).toMatchObject({ partyType: 'debtor', originalAmount: 1190, residualAmount: 1190, status: 'open', journalEntryId: entry.id });

  // The customer pays: the bank export is imported and the workbench proposes the invoice.
  await importBankExportThroughUi(desktop, [`${germanDate(today())};Zahlung ${invoice.number};Musterfirma GmbH;1.190,00`]);
  await nav(page, 'Bankabgleich');
  await expect(page.getByRole('heading', { name: 'Bankabgleich Workbench' })).toBeVisible();
  const candidate = page.getByRole('listitem', { name: `Rechnung ${invoice.number}` });
  await expect(candidate).toBeVisible();
  await expect(candidate).toContainText('Betrag stimmt überein');
  await page.screenshot({ path: shot('04-reconciliation-candidate'), fullPage: true });

  // Settling happens in Offene Posten, where the payment becomes a ledger entry.
  await page.getByRole('button', { name: `Rechnung ${invoice.number} in Offene Posten ausgleichen` }).click();
  await expect(page.getByRole('heading', { name: 'OPOS', level: 2 })).toBeVisible();
  await page.getByRole('button', { name: invoice.number, exact: true }).click();
  const bankPayment = page.getByRole('combobox', { name: 'Bankzahlung' });
  await bankPayment.selectOption({ index: 1 });
  await page.getByRole('textbox', { name: 'Begründung' }).first().fill('E2E Kontoauszug geprüft');
  await page.getByRole('button', { name: 'Zahlung zuordnen' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Zahlung vollständig zugeordnet.' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Forderungen' }).getByRole('row', { name: new RegExp(`^${invoice.number} .* 0,00 € Bezahlt`) })).toBeVisible();
  await page.screenshot({ path: shot('05-opos-settled'), fullPage: true });

  // Persisted: the item is settled, the invoice is paid and the bank line is booked as 1200 against 1400.
  const settled = (await invokeDesktopIpc(page, 'pro:listOpenItems')).find((item) => item.sourceId === invoice.id);
  expect(settled).toMatchObject({ residualAmount: 0, status: 'paid' });
  expect((await invokeDesktopIpc(page, 'invoices:list', {})).find((candidateInvoice) => candidateInvoice.id === invoice.id)?.status).toBe('paid');
  const bankLine = (await invokeDesktopIpc(page, 'pro:listBankTransactions')).find((row) => row.purpose === `Zahlung ${invoice.number}`);
  expect(bankLine).toMatchObject({ status: 'booked', linkedInvoiceId: invoice.id, amount: 1190 });
  const paymentEntry = (await journal(page)).find((candidateEntry) => candidateEntry.sourceKey === `payment:bank_transaction:${bankLine.id}`);
  expect(paymentEntry, 'journal entry of the bank payment').toBeTruthy();
  expect(shape(paymentEntry)).toEqual([['1200', 1190, 0], ['1400', 0, 1190]]);
  // The whole ledger still balances.
  const all = await journal(page);
  expect(all.flatMap((candidateEntry) => candidateEntry.lines).reduce((sum, line) => Math.round((sum + line.debitAmount - line.creditAmount) * 100) / 100, 0)).toBe(0);

  // Zahlungsstorno: the payment was wrong. It is reversed in Offene Posten with a written reason; the mirror
  // entry is in the journal and receivable, invoice and bank line are open again.
  const payments = page.getByRole('table', { name: 'Gebuchte Zahlungen' });
  const paymentRow = payments.getByRole('row').filter({ hasText: 'Bank' }).filter({ hasText: '1.190,00 €' });
  await paymentRow.getByRole('button', { name: 'Stornieren' }).click();
  const correction = page.getByTestId('opos-payment-correction');
  await correction.getByRole('button', { name: 'Zahlung stornieren' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Begründung ist erforderlich.' })).toBeVisible();
  await correction.getByRole('textbox', { name: 'Begründung' }).fill('E2E falscher Kunde');
  await correction.getByRole('button', { name: 'Zahlung stornieren' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Zahlung storniert.' })).toBeVisible();
  await expect(payments.getByRole('row').filter({ hasText: 'Storniert' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Forderungen' }).getByRole('row', { name: new RegExp(`^${invoice.number} .* 1\\.190,00 € Offen`) })).toBeVisible();
  await page.screenshot({ path: shot('06-opos-payment-reversed'), fullPage: true });
  const reversedEntry = (await journal(page)).find((candidateEntry) => candidateEntry.id === paymentEntry.id);
  expect(reversedEntry.status).toBe('reversed');
  const mirror = (await journal(page)).find((candidateEntry) => candidateEntry.sourceKey === `reversal:${paymentEntry.id}`);
  expect(shape(mirror)).toEqual([['1200', 0, 1190], ['1400', 1190, 0]]);
  expect(mirror.bookingText).toContain('E2E falscher Kunde');
  expect((await invokeDesktopIpc(page, 'invoices:list', {})).find((candidateInvoice) => candidateInvoice.id === invoice.id)?.status).toBe('open');
  expect((await invokeDesktopIpc(page, 'pro:listBankTransactions')).find((row) => row.id === bankLine.id)?.status).toBe('pending');
});

test('Bankabgleich opens Offene Posten with the matched invoice preselected', async () => {
  const { page } = desktop;
  const invoice = await issueInvoiceThroughUi(desktop, { description: 'E2E Beratung Vorauswahl', net: 500 });
  await importBankExportThroughUi(desktop, [`${germanDate(today())};Zahlung ${invoice.number};Musterfirma GmbH;595,00`]);
  await nav(page, 'Bankabgleich');
  await page.getByRole('button', { name: `Rechnung ${invoice.number} in Offene Posten ausgleichen` }).click();
  await expect(page.getByRole('heading', { name: 'OPOS', level: 2 })).toBeVisible();

  await expect(page.getByRole('button', { name: invoice.number, exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('combobox', { name: 'Bankzahlung' })).toBeEnabled();
});

test('imports a bank file, accepts the rule suggestion in the workbench and books it into the journal', async () => {
  const { page } = desktop;
  const journalBefore = await journal(page);
  // The accountant's rule (also managed under Einstellungen › Buchungsregeln, see pro-transfers-rules.spec.mjs): rent goes to 4210.
  await invokeDesktopIpc(page, 'pro:upsertAccountSuggestionRule', { chart: 'SKR03', priority: 1, field: 'counterparty', operator: 'contains', value: 'Hausverwaltung', targetAccountNumber: '4210', flowType: 'expense', active: true });

  await importBankExportThroughUi(desktop, [
    '22.09.2026;Miete Oktober;Hausverwaltung Nord;-1.190,00',
    '21.09.2026;Zahlung Projekt;Audit Kunde AG;428,40',
  ]);
  // Imported lines are open work, not postings.
  expect(await journal(page)).toEqual(journalBefore);
  const rent = (await invokeDesktopIpc(page, 'pro:listBankTransactions')).find((row) => row.purpose === 'Miete Oktober');
  expect(rent).toMatchObject({ suggestedAccountNumber: '4210', suggestionLayer: 'rule', suggestionConfidence: 0.99, status: 'pending' });

  await nav(page, 'Bankabgleich');
  await expect(page.getByRole('heading', { name: 'Bankabgleich Workbench' })).toBeVisible();
  const rentRow = page.getByRole('button', { name: /^Hausverwaltung Nord/ });
  await expect(rentRow).toContainText('Vorschlag');
  // Only the rule hit is a sure match; the payment without rule or invoice stays a person's decision.
  await expect(page.getByRole('button', { name: 'Sichere Treffer bestätigen (1)' })).toBeVisible();
  await rentRow.click();
  await expect(page.getByText(/4210\s*Kontierungsvorschlag\s*Sicherheit 99 %/)).toBeVisible();
  await page.screenshot({ path: shot('01-rule-suggestion'), fullPage: true });

  // Accept: the sure match goes to review; Freigeben and Buchen follow in the inbox.
  await page.getByRole('button', { name: 'Sichere Treffer bestätigen (1)' }).click();
  const confirm = page.getByRole('dialog', { name: '1 sichere Treffer bestätigen?' });
  await expect(confirm.getByRole('list', { name: 'Betroffene Umsätze' })).toContainText('Hausverwaltung Nord');
  await confirm.getByRole('button', { name: 'Bestätigen' }).click();
  await expect(page.getByRole('status').filter({ hasText: '1 sichere Treffer weitergeführt.' })).toBeVisible();
  await expect.poll(async () => (await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: rent.id }))?.workflowStatus).toBe('pending_approval');
  await page.screenshot({ path: shot('02-confirmed-for-review'), fullPage: true });

  await nav(page, 'Buchen');
  await expect(page.getByRole('heading', { name: 'Buchungs-Inbox', level: 2 })).toBeVisible();
  // "Zur Prüfung geben" puts the draft in the review queue; once freigegeben it waits under "Freigegeben".
  await page.getByRole('button', { name: /^Zur Prüfung \d/ }).click();
  await page.getByRole('checkbox', { name: 'Hausverwaltung Nord markieren' }).check();
  await page.getByRole('button', { name: 'Freigeben', exact: true }).click();
  await expect.poll(async () => (await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: rent.id }))?.workflowStatus).toBe('approved');
  await page.getByRole('button', { name: /^Freigegeben \d/ }).click();
  await page.getByRole('checkbox', { name: 'Hausverwaltung Nord markieren' }).check();
  await page.getByRole('button', { name: 'Sammel-Buchen' }).click();
  // The rule knows the account, not the VAT: the batch leaves the rent for a decision instead of booking it gross.
  await expect(page.getByRole('status').filter({ hasText: 'Sammelaktion Buchen: 0 erfolgreich, 0 übersprungen. 1 ohne Steuerfall ausgelassen' })).toBeVisible();
  expect(await journal(page)).toEqual(journalBefore);
  await page.getByRole('button', { name: /^Hausverwaltung Nord/ }).click();
  await page.getByRole('combobox', { name: 'Steuerfall' }).selectOption('DE_STD_19');
  await expect.poll(async () => (await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: rent.id }))?.lines.find((line) => line.accountNumber === '4210')?.taxCaseKey).toBe('DE_STD_19');
  // Changing the Kontierung of a freigegebener draft sends it through review again.
  expect((await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: rent.id })).workflowStatus).toBe('incomplete');
  // It left the Freigegeben queue; the preview of the line stays open under Alle.
  await page.getByRole('button', { name: /^Alle \d/ }).click();
  const preview = page.getByRole('complementary').last();
  await preview.getByRole('button', { name: 'Zur Prüfung geben', exact: true }).click();
  await expect.poll(async () => (await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: rent.id }))?.workflowStatus).toBe('pending_approval');
  await preview.getByRole('button', { name: 'Freigeben', exact: true }).click();
  await expect.poll(async () => (await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: rent.id }))?.workflowStatus).toBe('approved');
  await page.getByRole('button', { name: /^Freigegeben \d/ }).click();
  await page.getByRole('checkbox', { name: 'Hausverwaltung Nord markieren' }).check();
  await page.getByRole('button', { name: 'Sammel-Buchen' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Sammelaktion Buchen: 1 erfolgreich, 0 übersprungen.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Gebucht 1' })).toBeVisible();
  await page.screenshot({ path: shot('03-posted-in-inbox'), fullPage: true });
  // B26: a posted bank line offers its Storno instead of "Keine Aktion".
  // The preview stays on the line it was opened for.
  await page.getByRole('button', { name: 'Gebucht 1' }).click();
  await expect(page.getByRole('complementary').last().getByRole('button', { name: 'Stornieren …' })).toBeVisible();

  // The posting is in the journal: expense on the rule's account, bank credited; the other line is untouched.
  const posted = (await journal(page)).filter((entry) => entry.sourceType === 'booking_draft');
  expect(posted).toHaveLength(1);
  expect(posted[0]).toMatchObject({ bookingText: 'Miete Oktober', postingDate: '2026-09-22', status: 'posted' });
  // Gewerbemiete with VAT: net on the rule's account, Vorsteuer split off, not 1.190 gross on 4210.
  expect(shape(posted[0])).toEqual([['4210', 1000, 0], ['1576', 190, 0], ['1200', 0, 1190]]);
  expect((await invokeDesktopIpc(page, 'pro:listBankTransactions')).find((row) => row.purpose === 'Zahlung Projekt')?.status).toBe('pending');
  expect(await journal(page)).toHaveLength(journalBefore.length + 1);

  // ...and in the accounting UI: the SuSa carries the net rent on 4210.
  await nav(page, 'Auswertungen');
  await expect(page.getByRole('table', { name: 'Summen- und Saldenliste' }).getByRole('row', { name: /^4210 .* 1\.000,00 € 0,00 € 1\.000,00 €/ })).toBeVisible();
  await page.screenshot({ path: shot('04-susa-with-rent'), fullPage: true });
});

test('after confirming sure matches the workbench offers the next step of the draft', async () => {
  const { page } = desktop;
  await invokeDesktopIpc(page, 'pro:upsertAccountSuggestionRule', { chart: 'SKR03', priority: 1, field: 'counterparty', operator: 'contains', value: 'Hausverwaltung', targetAccountNumber: '4210', flowType: 'expense', active: true });
  await importBankExportThroughUi(desktop, ['22.09.2026;Miete Oktober;Hausverwaltung Nord;-1.190,00']);
  await nav(page, 'Bankabgleich');
  await page.getByRole('button', { name: /^Hausverwaltung Nord/ }).click();
  await page.getByRole('button', { name: 'Sichere Treffer bestätigen (1)' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Bestätigen' }).click();
  await expect(page.getByRole('status').filter({ hasText: '1 sichere Treffer weitergeführt.' })).toBeVisible();
  await page.getByRole('button', { name: /^Hausverwaltung Nord/ }).click();

  await expect(page.getByRole('main').getByRole('button', { name: 'Zur Prüfung geben' })).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('button', { name: 'Freigeben', exact: true })).toBeVisible();
});

/** Rent posted as a booking draft (the setup of the report tests): 1.190 € on 4210 against the bank 1200. */
const bookRent = async (page) => {
  const { transaction, draft } = await importPendingProTransaction(page, 'rent', { amount: -1190, counterparty: 'Hausverwaltung Nord', purpose: 'Miete Oktober', date: '2026-04-01' });
  const approved = await approveProDraft(page, {
    ...draft,
    lines: [
      { ...draft.lines[0], accountNumber: '4210', debitAmount: 1190, creditAmount: 0 },
      { ...draft.lines[1], accountNumber: '1200', debitAmount: 0, creditAmount: 1190 },
    ],
  });
  const posted = await invokeDesktopIpc(page, 'pro:postDraft', { draftId: approved.id, actorRole: 'accountant' });
  expect(posted.issues.filter((issue) => issue.blocking)).toEqual([]);
  return transaction;
};

/** Maps one account for one report catalog in "Report-Konten einrichten" and waits until it leaves the open list. */
const mapAccount = async (page, account, statement, positionLabel) => {
  const main = page.getByRole('main');
  const position = page.locator(`[id="report-mapping-position-${account}:${statement}"]`);
  await main.getByRole('textbox', { name: 'Audit-Grund für Mapping-Änderungen' }).fill('E2E Kontenzuordnung');
  await position.selectOption({ label: positionLabel });
  await main.locator('div').filter({ has: position }).filter({ has: page.getByRole('button', { name: 'Zuordnen' }) }).last().getByRole('button', { name: 'Zuordnen' }).click();
  await position.waitFor({ state: 'detached' });
};

/** A year with revenue (invoice + seeded invoices) and one expense; the expected figures come from the posted ledger. */
const prepareYear = async () => {
  const { page } = desktop;
  await issueInvoiceThroughUi(desktop, { description: 'E2E Beratung Jahr', net: 1000 });
  await bookRent(page);
  const entries = await journal(page);
  const net = (account) => Math.round(entries.flatMap((entry) => entry.lines).filter((line) => line.accountNumber === account).reduce((sum, line) => sum + line.creditAmount - line.debitAmount, 0) * 100) / 100;
  // The seeded invoices are Kleinunternehmer revenue (8195), the UI invoice is 19 % revenue (8400).
  const revenue = Math.round((net('8400') + net('8195')) * 100) / 100;
  const rent = -net('4210');
  expect([revenue, rent]).toEqual([5700.5, 1190]);
  return { revenue, rent, result: Math.round((revenue - rent) * 100) / 100 };
};

const openReports = async (page) => {
  await nav(page, 'Auswertungen');
  await expect(page.getByRole('heading', { name: 'Auswertungen', level: 1 })).toBeVisible();
  return page.getByRole('main').getByRole('group', { name: 'Bericht' });
};

const metric = (page, label) => page.getByRole('main').locator('div.rounded-tile').filter({ has: page.getByText(label, { exact: true }) });

test('BWA01 and HGB-GuV show the year from the postings on the SKR range defaults, without a manual mapping', async () => {
  const { page } = desktop;
  const { revenue, rent, result } = await prepareYear();
  const tabs = await openReports(page);

  // Nothing is mapped yet: the BWA runs on the SKR03 range defaults and says so.
  await tabs.getByRole('button', { name: 'BWA01', exact: true }).click();
  await expect(page.getByRole('main').getByRole('status').filter({ hasText: /^Standardzuordnung nach Kontenbereich \(SKR03\): .*4210.*8400/ })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Auswertung blockiert' })).toHaveCount(0);
  // 8400/8195 land on Umsatzerlöse and 4210 Miete on Raumkosten by their range.
  const bwa = page.getByRole('table', { name: 'BWA01' });
  await expect(bwa).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Auswertung blockiert' })).toHaveCount(0);
  await expect(metric(page, 'Ergebnis')).toContainText('4.510,50 €');
  await expect(metric(page, 'Umsätze')).toContainText('5.700,50 €');
  await expect(metric(page, 'Aufwendungen')).toContainText('1.190,00 €');
  await expect(bwa.getByRole('row', { name: /^Umsatzerlöse Konten: .*8400.* 5\.700,50 €/ })).toBeVisible();
  await expect(bwa.getByRole('row', { name: /^Raumkosten Konten: 4210 .*1\.190,00 €/ })).toBeVisible();
  expect([revenue, rent, result]).toEqual([5700.5, 1190, 4510.5]);
  await page.screenshot({ path: shot('02-bwa-defaults'), fullPage: true });

  // The position drilldown lists the postings behind it.
  await bwa.getByRole('button', { name: /^Umsatzerlöse/ }).click();
  const drilldown = page.getByRole('complementary').filter({ has: page.getByRole('button', { name: 'Drilldown schließen' }) });
  await expect(drilldown).toContainText('Konto');
  await expect(drilldown).toContainText('8400');
  await page.screenshot({ path: shot('03-bwa-drilldown'), fullPage: true });

  // HGB-GuV: the same accounts land on their § 275 positions by SKR range without a manual mapping, same result.
  await tabs.getByRole('button', { name: 'HGB-GuV', exact: true }).click();
  const hgb = page.getByRole('table', { name: 'Gewinn- und Verlustrechnung nach HGB' });
  await expect(hgb.getByRole('row', { name: /^1\. Umsatzerlöse Konten: .*8400.* 5\.700,50 €/ })).toBeVisible();
  await expect(hgb.getByRole('row', { name: /^8\. Sonstige betriebliche Aufwendungen Konten: 4210 -1\.190,00 €/ })).toBeVisible();
  await expect(metric(page, 'Ergebnis')).toContainText('4.510,50 €');
  await expect(metric(page, 'Aufwendungen')).toContainText('1.190,00 €');
  await page.screenshot({ path: shot('04-hgb-guv'), fullPage: true });
});

test('Management-GuV shows the year from the postings once its accounts are mapped', async () => {
  const { page } = desktop;
  await prepareYear();
  const tabs = await openReports(page);

  // The balance-sheet accounts fall to their SKR range default; the P&L accounts need a management position.
  await tabs.getByRole('button', { name: 'Management-GuV', exact: true }).click();
  await mapAccount(page, '8400', 'management-guv', 'Betriebliche Erlöse');
  await mapAccount(page, '8195', 'management-guv', 'Betriebliche Erlöse');
  await mapAccount(page, '4210', 'management-guv', 'Fixkosten');
  await tabs.getByRole('button', { name: 'Management-GuV', exact: true }).click();
  const guv = page.getByRole('table', { name: 'Management-GuV' });
  await expect(guv.getByRole('row', { name: /^Betriebliche Erlöse Konten: .*8400.* 5\.700,50 €/ })).toBeVisible();
  await expect(guv.getByRole('row', { name: /^Fixkosten Konten: 4210 -1\.190,00 €/ })).toBeVisible();
  await expect(guv.getByRole('row', { name: /^Managementergebnis .* 4\.510,50 €/ })).toBeVisible();
  await expect(metric(page, 'Ergebnis')).toContainText('4.510,50 €');
  await expect(metric(page, 'Aufwendungen')).toContainText('1.190,00 €');
  await page.screenshot({ path: shot('01-management-guv'), fullPage: true });

  await expect(metric(page, 'Umsätze')).toContainText('5.700,50 €');
});

test('Übersicht shows the result of the month from the postings', async () => {
  const { page } = desktop;
  // One invoice of 1.000 € net in this month, no expense: the month's Umsatz minus Aufwand is 1.000 €.
  await issueInvoiceThroughUi(desktop, { description: 'E2E Beratung Übersicht', net: 1000 });
  await nav(page, 'Übersicht');
  await expect(page.getByRole('heading', { name: 'Übersicht', level: 1 })).toBeVisible();
  await expect(page.getByText('Umsatz im laufenden Monat')).toBeVisible();
  const tile = page.getByText('Berichtskontenzuordnung unvollständig').locator('..');
  await expect(tile).toContainText(/Ergebnis/);
  await expect(tile).not.toContainText('0,00 €');
  await page.screenshot({ path: shot('01-overview'), fullPage: true });
  const tabs = await openReports(page);
  await tabs.getByRole('button', { name: 'Management-GuV', exact: true }).click();
  await mapAccount(page, '8400', 'management-guv', 'Betriebliche Erlöse');
  // The seeded Kleinunternehmer revenue account blocks the management GuV until it has a position too.
  await mapAccount(page, '8195', 'management-guv', 'Betriebliche Erlöse');
  const month = today().slice(0, 7);
  const monthEnd = `${month}-${String(new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate()).padStart(2, '0')}`;
  expect(await invokeDesktopIpc(page, 'pro:getGuvReport', { from: `${month}-01`, to: monthEnd })).toMatchObject({ blocking: false, netResult: 1000 });
  await nav(page, 'Übersicht');
  await expect(page.getByText('Umsatz minus Aufwand').locator('..')).toContainText('1.000,00 €');
});

test('exports the DATEV Buchungsstapel from the UI and leaves the file', async () => {
  const { page, app } = desktop;
  const invoice = await issueInvoiceThroughUi(desktop, { description: 'E2E Beratung DATEV', net: 1000 });
  const month = today().slice(0, 7);
  const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const target = test.info().outputPath('datev-buchungsstapel.csv');
  // The renderer saves through a download link; Electron's session decides where the file goes.
  await app.evaluate(({ session }, file) => { session.defaultSession.once('will-download', (_event, item) => item.setSavePath(file)); }, target);

  const tabs = await openReports(page);
  await expect(tabs.getByRole('button', { name: 'SuSa', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const panel = page.getByRole('region', { name: 'DATEV Buchungsstapel' });
  await expect(panel.getByRole('button', { name: 'Buchungsstapel exportieren' })).toBeEnabled();
  await panel.getByLabel('Von', { exact: true }).fill(`${month}-01`);
  await panel.getByLabel('Bis', { exact: true }).fill(lastDay);
  await panel.getByLabel('Wirtschaftsjahresbeginn').fill(`${month.slice(0, 4)}-01-01`);
  await panel.getByLabel('Beraternummer').fill('1001');
  await panel.getByLabel('Mandantennummer').fill('1');
  await page.screenshot({ path: shot('01-datev-form'), fullPage: true });
  await panel.getByRole('button', { name: 'Buchungsstapel exportieren' }).click();

  const success = panel.getByRole('status').filter({ hasText: 'DATEV-Datei heruntergeladen' });
  await expect(success).toBeVisible();
  await expect(success).toContainText('1 Buchung.');
  await expect.poll(() => fs.existsSync(target) && fs.statSync(target).size > 0).toBe(true);
  await page.screenshot({ path: shot('02-datev-exported'), fullPage: true });

  // The file is a DATEV Buchungsstapel (EXTF header, CP1252) with the invoice as one gross booking 1190,00 from the
  // customer's Debitor on the Automatikkonto 8400 (no BU key, DATEV derives the 19 % VAT) and the invoice number as Belegfeld 1.
  const text = fs.readFileSync(target).toString('latin1');
  const [header, columns, ...rows] = text.split(/\r?\n/).filter(Boolean);
  expect(header).toMatch(/^"EXTF";700;21;"Buchungsstapel";/);
  expect(header).toContain(';1001;1;');
  expect(columns).toContain('Umsatz (ohne Soll/Haben-Kz)');
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatch(/^1190,00;"S";"EUR";;;;1\d{4};8400;;/);
  expect(rows[0]).toContain(`"${invoice.number}"`);
  const debitor = rows[0].split(';')[6];

  // The names behind the Personenkonten go to the tax adviser as their own Stammdaten stack.
  const parties = test.info().outputPath('datev-debitoren-kreditoren.csv');
  await app.evaluate(({ session }, file) => { session.defaultSession.once('will-download', (_event, item) => item.setSavePath(file)); }, parties);
  await panel.getByLabel('Inhalt').selectOption({ label: 'Debitoren/Kreditoren (Stammdaten)' });
  await panel.getByRole('button', { name: 'Stammdaten exportieren' }).click();
  await expect(panel.getByRole('status').filter({ hasText: /\d+ Personenkont/ })).toBeVisible();
  await expect.poll(() => fs.existsSync(parties) && fs.statSync(parties).size > 0).toBe(true);
  const [partyHeader, partyColumns, ...partyRows] = fs.readFileSync(parties).toString('latin1').split(/\r?\n/).filter(Boolean);
  expect(partyHeader).toMatch(/^"EXTF";700;16;"Debitoren\/Kreditoren";5;/);
  expect(partyColumns).toMatch(/^Konto;Name \(Adressatentyp Unternehmen\);/);
  expect(partyRows.some((row) => row.startsWith(`${debitor};`))).toBe(true);
  await page.screenshot({ path: shot('03-datev-parties-exported'), fullPage: true });

  // Both exports are listed as immutable history.
  await expect(panel.getByLabel('Unveränderlicher DATEV-Exportverlauf').getByRole('listitem')).toHaveCount(2);
});
