import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';
import { answerNextFilePicker, createShooter, seedBankTransactions, useRegularVat, writeBankCsv } from './lite-support.mjs';

/**
 * Lite "Buchen" as a user does it, read back through the backend (EÜR, UStVA).
 *
 * How this can fail:
 * - the VAT rate typed in the form is not sent, so the expense lands gross in
 *   the EÜR and Kz 185 (Vorsteuer) stays empty while the form shows the net
 * - the rate field is empty although the settings carry a standard rate
 * - Bewirtung on the 70 % line without the split box books 100 % as deductible,
 *   or the split is computed from the gross amount
 * - overview and Auswertungen disagree on the open receivables because one of
 *   them ignores a partial payment; Auswertungen counts revenue gross by invoice
 *   date instead of the money received
 * - the liquidity shows only the opening balances and ignores imported bank lines
 * - the overview, the nav badge of "Buchen" and its queue count the same backlog
 *   differently
 * - CSV import: a file whose columns are not recognised cannot be mapped by hand;
 *   a German PayPal export is read as a generic file; importing the same file
 *   again says "imported"; a file of a closed month ends silently and leaves an
 *   empty batch
 * - a bank account cannot be edited; an IBAN with a wrong check digit is saved,
 *   or saved with spaces
 * - "Festschreiben" closes the month on the first click, without naming what is
 *   still open; a refusal in a closed month surfaces as a raw developer toast
 * - a bank line cannot get its receipt; the audit reason of the last entry stays
 *   in the field for the next one
 * - the bell stays empty while invoices are overdue and payments unbooked; Ctrl+K
 *   offers no booking actions
 * - the Anlage EÜR lists master-data fields as "0,00 €"; the coming year cannot be
 *   chosen
 * - "Vorschlag anwenden" on several entries books a regular-VAT expense gross
 *   without Vorsteuer, or guesses a rate nobody gave
 * - a Rücklastschrift can only be booked as an expense: the invoice stays paid
 *   and its income counts on
 * - a bank line already classified cannot get its receipt, or loses its
 *   category when it does; the receipt amount shows as "49.9"
 * - Ctrl+K does not find bank lines or receipts
 * - the overview's "Ergebnis" of the month leaves out the VAT received and the
 *   Vorsteuer paid, and counts the non-deductible 30 % of a Bewirtung, so it
 *   differs from the EÜR
 */

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp();
  await seedDesktopData(desktop.page);
  await seedBankTransactions(desktop.page);
  // The seed issues §19 invoices; regular VAT only afterwards.
  await useRegularVat(desktop.page);
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

const money = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

test('B7: an expense booked with 19 % lands net in its category and the Vorsteuer in Kz 185', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const taxYear = new Date().getFullYear();

  await page.goto(appUrl(baseUrl, '/eur'));
  await page.getByRole('button', { name: /Adobe Systems/ }).first().click();
  const panel = page.getByRole('region', { name: 'Klassifizierung' });
  await expect(panel.getByRole('heading', { name: 'Adobe Systems' })).toBeVisible();
  await expect(panel.getByRole('combobox', { name: 'Kategorie' })).toHaveValue(/.+/);
  await panel.getByRole('combobox', { name: 'USt. Modus' }).selectOption('default');
  // The standard rate from the settings is filled in.
  await expect(panel.getByRole('spinbutton', { name: 'USt.-Satz (%)' })).toHaveValue('19');
  await panel.getByRole('textbox', { name: 'Begründung für EÜR-Änderung' }).fill('Rechnung Adobe geprüft');
  await shot('adobe-19');
  await panel.getByRole('button', { name: 'Klassifizierung speichern' }).click();
  await expect(page.getByText('Klassifizierung gespeichert', { exact: true })).toBeVisible();

  const item = (await invokeDesktopIpc(page, 'eur:listItems', { taxYear, sourceType: 'transaction', status: 'all' })).find((row) => row.counterparty === 'Adobe Systems');
  expect(item.classification).toMatchObject({ vatMode: 'default', vatRate: 19 });
  const report = await invokeDesktopIpc(page, 'eur:getReport', { taxYear });
  const total = (predicate) => report.rows.find(predicate)?.total ?? 0;
  expect(total((row) => row.lineId === item.classification.eurLineId)).toBe(money(49.9 / 1.19));
  expect(total((row) => row.kennziffer === '185')).toBe(money(49.9 - 49.9 / 1.19));
  expect(report.warnings.filter((warning) => warning.startsWith('VAT_RATE_REQUIRED'))).toEqual([]);
});

test('B9: the 70 % Bewirtung line is always split 70/30 from the net, the Vorsteuer stays in full', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const taxYear = new Date().getFullYear();
  const file = writeBankCsv([{ date: `${taxYear}-03-12`, amount: -119, counterparty: 'Restaurant Krone', purpose: 'Bewirtung Kunde Alpha' }]);
  await invokeDesktopIpc(page, 'finance:importCommit', { path: file, accountId: 'acc1', profile: 'generic', mapping: { dateColumn: 'Datum', amountColumn: 'Betrag', counterpartyColumn: 'Gegenpartei', purposeColumn: 'Verwendungszweck' } });
  fs.rmSync(file, { force: true });
  const kz = (report, code) => report.rows.find((row) => row.kennziffer === code)?.total ?? 0;
  const before = await invokeDesktopIpc(page, 'eur:getReport', { taxYear });
  await page.reload();

  await page.goto(appUrl(baseUrl, '/eur'));
  await page.getByRole('button', { name: /Restaurant Krone/ }).first().click();
  const panel = page.getByRole('region', { name: 'Klassifizierung' });
  await panel.getByRole('combobox', { name: 'Kategorie' }).selectOption({ label: 'Bewirtung (abziehbarer Anteil, 70 %)' });
  await panel.getByRole('combobox', { name: 'USt. Modus' }).selectOption('default');
  const split = panel.getByRole('checkbox', { name: /Bewirtung aufteilen/ });
  await expect(split).toBeChecked();
  await expect(split).toBeDisabled();
  await expect(panel.getByText(/Abziehbar 70,00\s€, nicht abziehbar 30,00\s€/)).toBeVisible();
  await panel.getByRole('textbox', { name: 'Begründung für EÜR-Änderung' }).fill('Bewirtungsbeleg geprüft');
  await shot('bewirtung');
  await panel.getByRole('button', { name: 'Klassifizierung speichern' }).click();
  await expect(page.getByText('Klassifizierung gespeichert', { exact: true })).toBeVisible();

  const after = await invokeDesktopIpc(page, 'eur:getReport', { taxYear });
  expect(money(kz(after, '175') - kz(before, '175'))).toBe(70);
  expect(money(kz(after, '165') - kz(before, '165'))).toBe(30);
  expect(money(kz(after, '185') - kz(before, '185'))).toBe(19);
});

const euroIn = (text) => {
  const match = /(-?[\d.]+,\d{2})\s*€/.exec(text);
  return match ? Number(match[1].replace(/\./g, '').replace(',', '.')) : Number.NaN;
};

test('B21/B26: overview and Auswertungen agree on open receivables after a partial payment, liquidity includes bank lines, one backlog count', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const taxYear = new Date().getFullYear();
  await invokeDesktopIpc(page, 'invoices:savePayment', { invoiceId: 'inv-open-1', payment: { id: 'pay-part-1', date: `${taxYear}-10-01`, amount: 450.5, method: 'Bankueberweisung' }, reason: 'Teilzahlung' });
  const invoices = await invokeDesktopIpc(page, 'invoices:list', {});
  const expectedOpen = money(invoices
    .filter((inv) => ['open', 'overdue'].includes(inv.status) && !['order_confirmation', 'delivery_note', 'credit_note', 'cancellation_invoice'].includes(inv.documentKind ?? 'invoice'))
    .reduce((sum, inv) => sum + inv.amount - (inv.payments ?? []).reduce((paid, p) => paid + p.amount, 0), 0));
  const accounts = await invokeDesktopIpc(page, 'accounts:list');
  const transactions = await invokeDesktopIpc(page, 'transactions:list', {});
  const expectedLiquidity = money(accounts.reduce((sum, a) => sum + a.balance, 0) + transactions.filter((t) => t.status !== 'pending').reduce((sum, t) => sum + (t.type === 'income' ? 1 : -1) * Math.abs(t.amount), 0));
  const openItems = (await invokeDesktopIpc(page, 'eur:listItems', { taxYear })).filter((item) => !(item.classification?.eurLineId || item.classification?.excluded || item.kind)).length;
  expect(openItems).toBeGreaterThan(0);
  await page.reload();

  await page.goto(appUrl(baseUrl, '/'));
  const kpis = page.getByRole('region', { name: 'Kennzahlen' });
  const tile = (label) => kpis.locator('div.rounded-tile', { hasText: label });
  await expect(tile('Offene Forderungen')).toContainText('€');
  await expect.poll(async () => euroIn(await tile('Liquidität').innerText())).toBe(expectedLiquidity);
  expect(euroIn(await tile('Offene Forderungen').innerText())).toBe(expectedOpen);
  const backlog = page.getByRole('button', { name: /Zahlungen in „Buchen“ zuordnen/ });
  await expect(backlog).toContainText(String(openItems));
  await expect(page.getByRole('button', { name: /Zahlungseingänge abgleichen/ })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name: 'Buchen' })).toContainText(String(openItems));
  await shot('overview');

  await page.goto(appUrl(baseUrl, '/statistics'));
  const stats = page.getByRole('region', { name: 'Kennzahlen' });
  await expect(stats.locator('div.rounded-tile', { hasText: 'Offene Forderungen' })).toContainText('€');
  expect(euroIn(await stats.locator('div.rounded-tile', { hasText: 'Offene Forderungen' }).innerText())).toBe(expectedOpen);
  // §19 seed: net equals gross; the partial payment of October counts as revenue of this year.
  const paidThisYear = money(invoices.flatMap((inv) => inv.payments ?? []).filter((p) => p.date.startsWith(String(taxYear)) && !p.id.startsWith('skonto:')).reduce((sum, p) => sum + p.amount, 0));
  expect(euroIn(await stats.locator('div.rounded-tile', { hasText: 'Umsatz netto, bezahlt' }).innerText())).toBe(paidThisYear);
  await shot('statistics');
});

const writeCsv = (name, text) => {
  const file = path.join(os.tmpdir(), `billme-e2e-${process.pid}-${Date.now()}-${name}`);
  fs.writeFileSync(file, text, 'utf8');
  return file;
};

test('B3/B4/B20: CSV columns are chosen by hand, a German PayPal export is recognised, a replay and a closed month say so', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const toasts = page.getByRole('region', { name: 'Aktionsmeldungen' });
  const dialog = page.getByRole('dialog', { name: 'CSV-Import prüfen' });
  const pick = async (file) => {
    await answerNextFilePicker(desktop, file);
    await page.getByRole('button', { name: 'CSV importieren' }).click();
    await expect(dialog).toBeVisible();
  };
  await page.goto(appUrl(baseUrl, '/accounts'));

  // Unknown layout: the amount comes first, so the generic guess is wrong until the user maps the columns.
  const odd = writeCsv('odd.csv', 'Betrag;Buchungsdatum;Empfänger;Text\n-12,50;03.09.2026;Bäckerei Krume;Bewirtung Team\n200,00;04.09.2026;Kunde Nord;Anzahlung\n');
  await pick(odd);
  await expect(dialog).toContainText('0 von 2 Zeilen gültig');
  await dialog.getByRole('combobox', { name: 'Spalte Datum' }).selectOption('Buchungsdatum');
  await dialog.getByRole('combobox', { name: 'Spalte Betrag' }).selectOption('Betrag');
  await dialog.getByRole('combobox', { name: 'Spalte Gegenpartei' }).selectOption('Empfänger');
  await dialog.getByRole('combobox', { name: 'Spalte Verwendungszweck' }).selectOption('Text');
  await expect(dialog).toContainText('2 von 2 Zeilen gültig');
  await shot('mapped');
  await dialog.getByRole('button', { name: '2 Buchungen importieren' }).click();
  await expect(toasts.getByText(/Erfolgreich 2 Transaktionen importiert/)).toBeVisible();
  const lines = await invokeDesktopIpc(page, 'transactions:list', { accountId: 'acc1' });
  expect(lines.filter((tx) => ['Bäckerei Krume', 'Kunde Nord'].includes(tx.counterparty)).map((tx) => [tx.counterparty, tx.amount, tx.date, tx.purpose]).sort()).toEqual([
    ['Bäckerei Krume', -12.5, '2026-09-03', 'Bewirtung Team'],
    ['Kunde Nord', 200, '2026-09-04', 'Anzahlung'],
  ]);

  // The same file again imports nothing and says so.
  await pick(odd);
  await dialog.getByRole('combobox', { name: 'Spalte Datum' }).selectOption('Buchungsdatum');
  await dialog.getByRole('combobox', { name: 'Spalte Betrag' }).selectOption('Betrag');
  await dialog.getByRole('button', { name: /Buchungen importieren/ }).click();
  await expect(toasts.getByText(/Keine neuen Buchungen/)).toBeVisible();

  // A German PayPal export.
  await pick(writeCsv('paypal.csv', '"Datum","Uhrzeit","Zeitzone","Name","Typ","Status","Währung","Brutto","Entgelt","Netto","Transaktionscode","Betreff"\n"05.09.2026","10:00:00","CEST","Delta Webshop","Zahlung","Abgeschlossen","EUR","119,00","-4,05","114,95","9XY12345AB678901C","Bestellung 17"\n'));
  await expect(dialog).toContainText('erkannt als PayPal');
  await expect(dialog).toContainText('1 von 1 Zeilen gültig');
  await expect(dialog.getByRole('combobox', { name: 'Spalte Betrag' })).toHaveValue('Brutto');
  await shot('paypal');
  await dialog.getByRole('button', { name: 'Abbrechen' }).click();

  // A file of a closed month: a clear refusal, no empty batch in the history.
  await invokeDesktopIpc(page, 'cash:closePeriod', { period: '2026-01', reason: 'Januar abgeschlossen' });
  const batchesBefore = (await invokeDesktopIpc(page, 'finance:listImportBatches', { accountId: 'acc1' })).length;
  await pick(writeCsv('jan.csv', 'Buchungstag;Betrag;Auftraggeber/Empfänger;Verwendungszweck\n10.01.2026;-39,95;Telekom;Januar\n'));
  await dialog.getByRole('button', { name: /Buchungen importieren/ }).click();
  await expect(page.getByRole('alert').filter({ hasText: /Monat 2026-01 ist festgeschrieben/ })).toBeVisible();
  expect((await invokeDesktopIpc(page, 'finance:listImportBatches', { accountId: 'acc1' })).length).toBe(batchesBefore);
  await shot('closed-month');
});

test('B1/B2: a bank account is edited; an IBAN with a wrong check digit is refused, a valid one saved without spaces', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  await page.goto(appUrl(baseUrl, '/accounts'));
  await page.getByRole('button', { name: 'Aktionen für Hauptgeschaeftskonto' }).click();
  await page.getByRole('menuitem', { name: 'Bearbeiten' }).click();
  const dialog = page.getByRole('dialog', { name: 'Bankkonto bearbeiten' });
  await expect(dialog).toBeVisible();
  const iban = dialog.getByLabel('IBAN (optional)');
  await iban.fill('DE89 3704 0044 0532 0130 01');
  await iban.blur();
  await expect(dialog.getByText(/Prüfziffer/)).toBeVisible();
  await shot('iban-invalid');
  await iban.fill('de89 3704 0044 0532 0130 00');
  await dialog.getByLabel('Kontoname').fill('Geschäftskonto Sparkasse');
  await dialog.getByRole('button', { name: /Speichern/ }).click();
  await expect(dialog).toBeHidden();
  const account = (await invokeDesktopIpc(page, 'accounts:list')).find((row) => row.id === 'acc1');
  expect([account.name, account.iban]).toEqual(['Geschäftskonto Sparkasse', 'DE89370400440532013000']);
  await expect(page.getByRole('table', { name: 'Ihre Konten' })).toContainText('DE89 3704 0044 0532 0130 00');
});

test('B14/B10/B18/B19: a receipt is entered for a bank line and matched to it, the reason starts empty, Festschreiben asks first, a closed month answers in German', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const taxYear = new Date().getFullYear();
  const adobeTx = (await invokeDesktopIpc(page, 'transactions:list', {})).find((tx) => tx.counterparty === 'Adobe Systems');
  await page.goto(appUrl(baseUrl, '/eur'));
  const panel = page.getByRole('region', { name: 'Klassifizierung' });

  // B10: a reason typed for one entry is gone when the next one opens.
  await page.getByRole('button', { name: /StartUp Berlin AG/ }).first().click();
  await panel.getByRole('textbox', { name: 'Begründung für EÜR-Änderung' }).fill('Gutschrift geprüft');
  await page.getByRole('button', { name: /Adobe Systems/ }).first().click();
  await expect(panel.getByRole('heading', { name: 'Adobe Systems' })).toBeVisible();
  await expect(panel.getByRole('textbox', { name: 'Begründung für EÜR-Änderung' })).toHaveValue('');

  // B14: "Beleg erfassen" opens the manual entry from the bank line; saving matches it to that line.
  await panel.getByRole('button', { name: 'Beleg erfassen' }).click();
  const form = page.getByRole('dialog', { name: 'Manuelle Buchung' });
  await expect(form.getByLabel('Betrag in EUR')).toHaveValue('49,90');
  await expect(form.getByLabel('Zahlungsart')).toHaveValue('bank');
  await form.getByLabel('Belegnummer').fill('AD-2026-0205');
  await form.getByLabel('Netto 1 in EUR').fill('41.93');
  await form.getByLabel('Begründung', { exact: true }).fill('Rechnung Adobe Februar');
  await shot('receipt-for-bank-line');
  await form.getByRole('button', { name: 'Buchung speichern' }).click();
  await expect(form).toBeHidden();
  const entry = (await invokeDesktopIpc(page, 'cash:listEntries')).find((row) => row.matchedTransactionId === adobeTx.id);
  expect(entry, 'the manual entry is matched to the Adobe bank line').toBeTruthy();
  const receipt = (await invokeDesktopIpc(page, 'cash:listReceipts')).find((row) => row.id === entry.receiptId);
  expect([receipt.number, receipt.grossAmountCents]).toEqual(['AD-2026-0205', 4990]);

  // B18: Festschreiben asks and names the open payments; cancel keeps the month open.
  await page.getByText(/Monate festschreiben/).click();
  await page.getByLabel('Monat', { exact: true }).fill(`${taxYear}-02`);
  await page.getByRole('button', { name: 'Festschreiben', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: /festschreiben/i });
  await expect(confirm).toContainText(/noch offen/);
  await shot('close-confirm');
  await confirm.getByRole('button', { name: 'Abbrechen' }).click();
  expect((await invokeDesktopIpc(page, 'cash:listClosedPeriods')).map((row) => row.period)).not.toContain(`${taxYear}-02`);
  await page.getByRole('button', { name: 'Festschreiben', exact: true }).click();
  await confirm.getByRole('button', { name: 'Endgültig festschreiben' }).click();
  await expect.poll(async () => (await invokeDesktopIpc(page, 'cash:listClosedPeriods')).map((row) => row.period)).toContain(`${taxYear}-02`);

  // B19: classifying in the closed month: the server's German sentence as a toast, no developer overlay.
  await page.getByRole('button', { name: /StartUp Berlin AG/ }).first().click();
  await panel.getByRole('textbox', { name: 'Begründung für EÜR-Änderung' }).fill('Gutschrift geprüft');
  await panel.getByRole('button', { name: 'Klassifizierung speichern' }).click();
  await expect(page.getByRole('region', { name: 'Aktionsmeldungen' }).getByText(/festgeschrieben/)).toBeVisible();
  await expect(page.getByText(/unhandledrejection|Error: /)).toHaveCount(0);
  await shot('closed-month-toast');
});

test('B29/B30: the bell lists overdue invoices, unbooked payments and the Voranmeldung; Ctrl+K opens the manual booking', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  await page.goto(appUrl(baseUrl, '/'));
  await page.getByRole('button', { name: 'Benachrichtigungen' }).click();
  const tasks = page.getByRole('list', { name: 'Offene Aufgaben' });
  await expect(tasks).toContainText(/Zahlungen? nicht gebucht/);
  await expect(tasks).toContainText(/Umsatzsteuer-Voranmeldung/);
  const invoices = await invokeDesktopIpc(page, 'invoices:list', {});
  if (invoices.some((inv) => inv.status === 'overdue')) await expect(tasks).toContainText(/überfällig/);
  await shot('bell');
  await tasks.getByRole('button', { name: /nicht gebucht/ }).click();
  await expect(page).toHaveURL(/\/eur/);

  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: 'Suche und Befehle' });
  await page.keyboard.type('manuelle');
  await expect(page.getByRole('option', { name: /Manuelle Buchung erfassen/ })).toBeVisible();
  await shot('palette');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Manuelle Buchung' })).toBeVisible();
  await expect(palette).toBeHidden();
});

test('B22/B24: the Anlage EÜR hides master data and empty lines, offers the coming year; Lite settings show no Kontenrahmen', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const next = new Date().getFullYear() + 1;
  await page.goto(appUrl(baseUrl, '/statistics?view=eur'));
  const table = page.getByRole('table', { name: 'EÜR-Report' });
  await expect(table).toBeVisible();
  await expect(table.getByRole('cell', { name: 'Kalenderjahr', exact: true })).toHaveCount(0);
  await expect(table.getByRole('cell', { name: '0,00 €' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Steuerjahr' }).locator('option', { hasText: `${next} (vorläufig)` })).toHaveCount(1);
  await shot('eur-table');
  await page.getByLabel('Auch Zeilen ohne Betrag zeigen').check();
  await expect(table.getByRole('cell', { name: '0,00 €' }).first()).toBeVisible();
  await expect(table.getByRole('cell', { name: 'Kalenderjahr', exact: true })).toHaveCount(0);
});

test('bulk "Vorschlag anwenden": a known rate goes with the line, an unknown one is left out with a hint, never booked gross', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const taxYear = new Date().getFullYear();
  const items = () => invokeDesktopIpc(page, 'eur:listItems', { taxYear, status: 'all' });
  const adobeFeb = (await items()).find((row) => row.counterparty === 'Adobe Systems');
  await invokeDesktopIpc(page, 'eur:upsertClassification', { sourceType: 'transaction', sourceId: adobeFeb.sourceId, taxYear, eurLineId: adobeFeb.suggestedLineId, vatMode: 'default', vatRate: 19, reason: 'Rechnung Adobe Februar' });
  const file = writeBankCsv([
    { date: `${taxYear}-03-05`, amount: -49.9, counterparty: 'Adobe Systems', purpose: 'Creative Cloud Abo März' },
    { date: `${taxYear}-03-06`, amount: -39.95, counterparty: 'Telekom Deutschland', purpose: 'Telefon März' },
  ]);
  await invokeDesktopIpc(page, 'finance:importCommit', { path: file, accountId: 'acc1', profile: 'generic', mapping: { dateColumn: 'Datum', amountColumn: 'Betrag', counterpartyColumn: 'Gegenpartei', purposeColumn: 'Verwendungszweck' } });
  fs.rmSync(file, { force: true });
  const before = new Map((await items()).map((row) => [row.sourceId, row]));
  const march = [...before.values()].find((row) => row.purpose === 'Creative Cloud Abo März');
  const telekom = [...before.values()].find((row) => row.counterparty === 'Telekom Deutschland');
  expect(telekom.suggestedLineId, 'Telekom has a line suggestion but no known rate').toBeTruthy();
  const reportBefore = await invokeDesktopIpc(page, 'eur:getReport', { taxYear });
  await page.reload();

  await page.goto(appUrl(baseUrl, '/eur'));
  await page.getByRole('checkbox', { name: /ausgewählt/ }).check();
  await page.getByRole('textbox', { name: 'Begründung für EÜR-Änderung' }).first().fill('Vorschläge geprüft');
  await page.getByRole('button', { name: 'Vorschlag anwenden' }).click();
  await expect(page.getByRole('region', { name: 'Aktionsmeldungen' }).getByText(/ausgelassen/)).toBeVisible();
  await shot('bulk-skipped');

  const after = await items();
  const of = (id) => after.find((row) => row.sourceId === id);
  expect(of(march.sourceId).classification).toMatchObject({ eurLineId: march.suggestedLineId, vatMode: 'default', vatRate: 19 });
  expect(of(telekom.sourceId).classification?.eurLineId, 'no known rate: left open').toBeUndefined();
  for (const row of after) {
    const was = before.get(row.sourceId);
    if (!was || was.classification || !row.classification?.eurLineId) continue;
    expect([row.sourceId, row.classification.vatMode, row.classification.vatRate], 'applied only with the suggested VAT').toEqual([row.sourceId, was.suggestedVatMode, was.suggestedVatRate]);
  }
  const report = await invokeDesktopIpc(page, 'eur:getReport', { taxYear });
  const kz = (r, code) => r.rows.find((row) => row.kennziffer === code)?.total ?? 0;
  expect(money(kz(report, '185') - kz(reportBefore, '185'))).toBe(money(49.9 - 49.9 / 1.19));
});

test('B13: a Rücklastschrift takes the payment back from the invoice right from Buchen; the invoice is open again', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const taxYear = new Date().getFullYear();
  const paid = (await invokeDesktopIpc(page, 'invoices:list', {})).find((inv) => inv.client === 'Musterfirma GmbH' && inv.status === 'paid');
  const file = writeBankCsv([{ date: `${taxYear}-03-10`, amount: -paid.amount, counterparty: 'Musterfirma GmbH', purpose: `Rücklastschrift ${paid.number}` }]);
  await invokeDesktopIpc(page, 'finance:importCommit', { path: file, accountId: 'acc1', profile: 'generic', mapping: { dateColumn: 'Datum', amountColumn: 'Betrag', counterpartyColumn: 'Gegenpartei', purposeColumn: 'Verwendungszweck' } });
  fs.rmSync(file, { force: true });
  const tx = (await invokeDesktopIpc(page, 'transactions:list', {})).find((row) => row.purpose === `Rücklastschrift ${paid.number}`);
  const reportBefore = await invokeDesktopIpc(page, 'eur:getReport', { taxYear });
  // The user had already filed the line as an expense; the Rücklastschrift must still take it out of the EÜR at once.
  await invokeDesktopIpc(page, 'eur:upsertClassification', { sourceType: 'transaction', sourceId: tx.id, taxYear, eurLineId: reportBefore.rows.find((row) => row.kind === 'expense').lineId, vatMode: 'none', reason: 'zuerst als Ausgabe erfasst' });
  expect((await invokeDesktopIpc(page, 'eur:getReport', { taxYear })).summary.expenseTotal).toBeGreaterThan(reportBefore.summary.expenseTotal);
  await page.reload();

  await page.goto(appUrl(baseUrl, `/eur?item=transaction:${tx.id}&year=${taxYear}`));
  const panel = page.getByRole('region', { name: 'Klassifizierung' });
  const refund = panel.getByRole('group', { name: 'Rücklastschrift oder Erstattung' });
  await expect(refund).toContainText(paid.number);
  await shot('refund-offer');
  await refund.getByRole('button', { name: `Zahlung an ${paid.number} zurücknehmen` }).click();
  const confirm = page.getByRole('dialog', { name: 'Zahlung zurücknehmen?' });
  await expect(confirm).toContainText('wieder offen');
  await confirm.getByRole('button', { name: 'Zahlung zurücknehmen' }).click();
  await expect(page.getByRole('region', { name: 'Aktionsmeldungen' }).getByText(`Zahlung zurückgenommen: ${paid.number} ist wieder offen.`)).toBeVisible();
  await shot('refund-done');

  const invoice = (await invokeDesktopIpc(page, 'invoices:list', {})).find((inv) => inv.id === paid.id);
  expect(['open', 'overdue']).toContain(invoice.status);
  expect(money(invoice.payments.reduce((sum, p) => sum + p.amount, 0))).toBe(0);
  expect((await invokeDesktopIpc(page, 'eur:listItems', { taxYear, status: 'all' })).some((row) => row.sourceId === tx.id), 'no expense item left').toBe(false);
  const report = await invokeDesktopIpc(page, 'eur:getReport', { taxYear });
  expect(report.summary.expenseTotal).toBe(reportBefore.summary.expenseTotal);
});

test('B14/B25: a bank line already classified gets its receipt; the category moves with it, the receipt amount reads 49,90', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const taxYear = new Date().getFullYear();
  const adobe = (await invokeDesktopIpc(page, 'eur:listItems', { taxYear, status: 'all' })).find((row) => row.counterparty === 'Adobe Systems');
  await invokeDesktopIpc(page, 'eur:upsertClassification', { sourceType: 'transaction', sourceId: adobe.sourceId, taxYear, eurLineId: adobe.suggestedLineId, vatMode: 'default', vatRate: 19, reason: 'Rechnung Adobe geprüft' });
  await page.reload();

  await page.goto(appUrl(baseUrl, '/eur'));
  await page.getByRole('button', { name: 'Klassifiziert', exact: false }).first().click();
  await page.getByRole('button', { name: /Adobe Systems/ }).first().click();
  const panel = page.getByRole('region', { name: 'Klassifizierung' });
  await panel.getByRole('button', { name: 'Beleg erfassen' }).click();
  const form = page.getByRole('dialog', { name: 'Manuelle Buchung' });
  await expect(form.getByLabel('Gesamtbetrag des Belegs in EUR')).toHaveValue('49,90');
  await form.getByLabel('Belegnummer').fill('AD-2026-0205');
  await form.getByLabel('Netto 1 in EUR').fill('41,93');
  await form.getByLabel('Begründung', { exact: true }).fill('Rechnung Adobe Februar');
  await shot('receipt-classified-line');
  await form.getByRole('button', { name: 'Buchung speichern' }).click();
  await expect(form).toBeHidden();

  const entry = (await invokeDesktopIpc(page, 'cash:listEntries')).find((row) => row.matchedTransactionId === adobe.sourceId);
  expect(entry).toBeTruthy();
  const items = await invokeDesktopIpc(page, 'eur:listItems', { taxYear, status: 'all' });
  expect(items.find((row) => row.sourceId === entry.id)?.classification).toMatchObject({ eurLineId: adobe.suggestedLineId, vatMode: 'default', vatRate: 19 });
  expect(items.some((row) => row.sourceId === adobe.sourceId)).toBe(false);
});

test('B30: Ctrl+K finds a bank line and a receipt and opens them in Buchen', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const taxYear = new Date().getFullYear();
  const receiptId = `rc-${Date.now()}`;
  await invokeDesktopIpc(page, 'cash:saveReceipt', { receipt: { id: receiptId, number: 'BH-7781', counterparty: 'Bürohaus Papier', documentDate: `${taxYear}-03-02`, receivedDate: `${taxYear}-03-02`, serviceDate: `${taxYear}-03-02`, grossAmountCents: 2380, taxMode: 'domestic', deductiblePercent: 100, reviewed: true, taxBreakdown: [{ rate: 19, netAmountCents: 2000, vatAmountCents: 380 }] }, reason: 'Beleg erfasst' });
  await invokeDesktopIpc(page, 'cash:saveEntry', { entry: { id: `ce-${Date.now()}`, cashDate: `${taxYear}-03-02`, amountCents: -2380, currency: 'EUR', flowType: 'expense', counterparty: 'Bürohaus Papier', purpose: 'Druckerpapier', receiptId, paymentMethod: 'cash' }, reason: 'Barkauf' });
  await page.reload();
  await page.goto(appUrl(baseUrl, '/'));

  const palette = page.getByRole('dialog', { name: 'Suche und Befehle' });
  const panel = page.getByRole('region', { name: 'Klassifizierung' });
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Adobe');
  const bankHit = palette.getByRole('option', { name: /Adobe Systems.*Bankumsatz/ });
  await expect(bankHit).toBeVisible();
  await shot('palette-bank');
  await bankHit.click();
  await expect(page).toHaveURL(/\/eur/);
  await expect(panel.getByRole('heading', { name: 'Adobe Systems' })).toBeVisible();

  await page.keyboard.press('Control+k');
  await page.keyboard.type('BH-7781');
  const receiptHit = palette.getByRole('option', { name: /Bürohaus Papier.*Beleg/ });
  await expect(receiptHit).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('heading', { name: 'Bürohaus Papier' })).toBeVisible();
  await shot('palette-receipt');
});

test('B26: the overview\'s result of the month is the EÜR surplus of that month (VAT received and paid, Bewirtung 70/30)', async () => {
  const { page, baseUrl } = desktop;
  const shot = createShooter(page);
  const now = new Date();
  const taxYear = now.getFullYear();
  const day = `${taxYear}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  const file = writeBankCsv([
    { date: day, amount: -119, counterparty: 'Restaurant Krone', purpose: 'Bewirtung Kunde Nord' },
    { date: day, amount: 238, counterparty: 'Kunde Web', purpose: 'Bestellung 4711' },
  ]);
  await invokeDesktopIpc(page, 'finance:importCommit', { path: file, accountId: 'acc1', profile: 'generic', mapping: { dateColumn: 'Datum', amountColumn: 'Betrag', counterpartyColumn: 'Gegenpartei', purposeColumn: 'Verwendungszweck' } });
  fs.rmSync(file, { force: true });
  const before = await invokeDesktopIpc(page, 'eur:getReport', { taxYear });
  const items = await invokeDesktopIpc(page, 'eur:listItems', { taxYear, status: 'all' });
  const line = (code) => before.rows.find((row) => row.kennziffer === code && (row.kind === 'income' || row.kind === 'expense')).lineId;
  const restaurant = items.find((row) => row.counterparty === 'Restaurant Krone');
  const web = items.find((row) => row.counterparty === 'Kunde Web');
  await invokeDesktopIpc(page, 'eur:upsertClassification', { sourceType: 'transaction', sourceId: restaurant.sourceId, taxYear, eurLineId: line('175'), vatMode: 'default', vatRate: 19, splits: [
    { amountNet: 70, deductibility: 'deductible', lineId: line('175'), reason: '70 % abziehbar' },
    { amountNet: 30, deductibility: 'non-deductible', lineId: line('165'), reason: '30 % nicht abziehbar' },
  ], reason: 'Bewirtungsbeleg geprüft' });
  await invokeDesktopIpc(page, 'eur:upsertClassification', { sourceType: 'transaction', sourceId: web.sourceId, taxYear, eurLineId: line('112'), vatMode: 'default', vatRate: 19, reason: 'Webshop-Umsatz' });
  const after = await invokeDesktopIpc(page, 'eur:getReport', { taxYear });
  const monthSurplus = money(after.summary.surplus - before.summary.surplus);
  expect(monthSurplus, '238 in, 119 - 30 not deductible out').toBe(149);
  await page.reload();

  await page.goto(appUrl(baseUrl, '/'));
  const tile = page.getByRole('region', { name: 'Kennzahlen' }).locator('div.rounded-tile', { hasText: 'Ergebnis' });
  await expect.poll(async () => euroIn(await tile.innerText())).toBe(monthSurplus);
  await shot('month-result');
});
