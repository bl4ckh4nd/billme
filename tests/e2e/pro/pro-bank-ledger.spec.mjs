import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { appUrl, importPendingProTransaction, invokeDesktopIpc, launchDesktopApp, PRO_DOUBLE_ENTRY_SETTINGS, seedDesktopData } from '../support.mjs';

/**
 * The bank account and its bookings the way a user sets them up: a new bank account books on the bank account of
 * the chart (not the first account of the Kontenplan), and a bank expense with a tax case books its Vorsteuer.
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

const shape = (entry) => entry.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount]);

test('a new bank account books on 1200 Bank when the user does not touch the ledger account, and only money accounts are offered', async () => {
  const { page, baseUrl } = desktop;
  // Picking the ledger account is a double-entry choice; under EÜR the dialog books on the bank role without asking.
  const settings = await invokeDesktopIpc(page, 'settings:get');
  await invokeDesktopIpc(page, 'settings:set', { settings: { ...settings, ...PRO_DOUBLE_ENTRY_SETTINGS } });
  await page.reload();
  await page.goto(appUrl(baseUrl, '/accounts'));
  await page.getByRole('button', { name: 'Neues Konto', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const ledger = dialog.getByLabel('Standard-SKR-Konto (SKR03)');
  await expect(ledger).toHaveValue('1200');
  const offered = await ledger.locator('option').evaluateAll((options) => options.map((option) => option.value));
  expect(offered).toContain('1000');
  expect(offered).not.toContain('0005');
  expect(offered.every((value) => /^1[0-2]\d\d$|^133\d$/.test(value)), offered.join(',')).toBe(true);
  await page.screenshot({ path: test.info().outputPath('01-new-bank-account.png') });

  const name = `Geschäftskonto ${Date.now()}`;
  await dialog.getByLabel('Kontoname').fill(name);
  await dialog.getByRole('button', { name: 'Speichern', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const saved = (await invokeDesktopIpc(page, 'accounts:list')).find((account) => account.name === name);
  expect(saved).toMatchObject({ defaultSkrAccountNumber: '1200' });
});

test('a bank expense booked in the workbench with the tax case Inland 19 % books its Vorsteuer and shows in the UStVA', async () => {
  const { page, baseUrl } = desktop;
  const { transaction, draft } = await importPendingProTransaction(page, 'vorsteuer', { amount: -35.7, counterparty: 'Telekom Deutschland', purpose: 'Rechnung 99 Telefon', date: '2026-04-14' });
  const month = { from: '2026-04-01', to: '2026-04-30' };
  const inputTaxBefore = (await invokeDesktopIpc(page, 'pro:getVatSummary', month)).kennzahlen.inputTaxAmount;
  // The expense account is the user's choice (Telefon); the tax case is picked in the editor below.
  await invokeDesktopIpc(page, 'pro:saveDraft', {
    draft: { ...draft, workflowStatus: 'suggested', lines: draft.lines.map((line, index) => ({ ...line, accountNumber: index === 0 ? '4920' : '1200' })) },
  });

  await page.goto(appUrl(baseUrl, '/accounting?view=inbox'));
  await page.getByRole('button', { name: `${transaction.counterparty} öffnen` }).click();
  await page.getByRole('button', { name: 'Erweitern' }).click();
  await page.getByRole('combobox', { name: 'Steuerfall' }).first().selectOption('DE_STD_19');
  await expect(page.getByRole('note', { name: /Steuer automatisch: Vorsteuer 19 %/ })).toContainText('5,70');
  await page.getByRole('button', { name: 'Entwurf speichern' }).click();
  await expect.poll(async () => (await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: transaction.id })).lines[0]?.taxCaseKey).toBe('DE_STD_19');

  const main = page.getByRole('main');
  await main.getByRole('button', { name: 'Zur Prüfung geben' }).click();
  await expect.poll(async () => (await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: transaction.id })).workflowStatus).toBe('pending_approval');
  await main.getByRole('button', { name: 'Freigeben', exact: true }).click();
  await expect.poll(async () => (await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: transaction.id })).workflowStatus).toBe('approved');
  await main.getByRole('button', { name: 'Buchen', exact: true }).click();
  await expect.poll(async () => (await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: transaction.id })).workflowStatus).toBe('posted');
  await page.screenshot({ path: test.info().outputPath('02-booked-with-vorsteuer.png'), fullPage: true });

  const entries = await invokeDesktopIpc(page, 'pro:listJournalEntries', { limit: 200, offset: 0 });
  const entry = entries.find((candidate) => candidate.sourceType === 'booking_draft' && candidate.bookingText === 'Rechnung 99 Telefon');
  expect(entry, 'the booking is in the journal').toBeTruthy();
  expect(shape(entry)).toEqual([['4920', 30, 0], ['1576', 5.7, 0], ['1200', 0, 35.7]]);
  const vat = await invokeDesktopIpc(page, 'pro:getVatSummary', month);
  expect(Math.round((vat.kennzahlen.inputTaxAmount - inputTaxBefore) * 100) / 100).toBe(5.7);
});

test('a rule made after the line was opened is taken over by the workbench, and a line without a proposal shows none', async () => {
  const { page, baseUrl } = desktop;
  const u = Date.now().toString(36);
  const { transaction } = await importPendingProTransaction(page, `hosting-${u}`, { amount: -29.99, counterparty: `Hosting ${u} AG`, purpose: 'Server Oktober', date: '2026-04-15' });
  const { transaction: plain } = await importPendingProTransaction(page, `plain-${u}`, { amount: -14.5, counterparty: `Unbekannt ${u}`, purpose: 'Sonstiges', date: '2026-04-16' });
  await invokeDesktopIpc(page, 'pro:upsertAccountSuggestionRule', { chart: 'SKR03', priority: 10, field: 'counterparty', operator: 'contains', value: `hosting ${u}`, targetAccountNumber: '4910', flowType: 'expense', active: true });

  await page.goto(appUrl(baseUrl, '/accounting?view=reconciliation'));
  await page.getByRole('button', { name: new RegExp(`^Unbekannt ${u}`) }).click();
  await expect(page.getByText(/Kein Vorschlag\s*Kontierungsvorschlag/)).toBeVisible();
  await expect(page.getByText(/Sicherheit 30 %/)).toHaveCount(0);

  await page.getByRole('button', { name: new RegExp(`^Hosting ${u} AG`) }).click();
  await expect(page.getByText(/4910\s*Kontierungsvorschlag\s*Sicherheit 99 %/)).toBeVisible();
  await expect.poll(async () => (await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: transaction.id })).lines.map((line) => line.accountNumber)).toEqual(['4910', '1200']);
  const next = page.getByRole('button', { name: 'Nächste Aktion' });
  await expect(next).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath('03-rule-taken-over.png'), fullPage: true });
  await next.click();
  await expect.poll(async () => (await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: transaction.id })).workflowStatus).toBe('pending_approval');
  expect((await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: plain.id })).lines[0].accountNumber).toBe('4900');
});

/** A bank line the bank has booked (no status column), imported like a statement file. */
const importBookedLine = async (page, { date, amount, counterparty, purpose }) => {
  const csvPath = path.join(os.tmpdir(), `billme-e2e-booked-${process.pid}-${Date.now()}.csv`);
  fs.writeFileSync(csvPath, `date,amount,counterparty,purpose\n${date},${amount},${counterparty},${purpose}\n`);
  try {
    await invokeDesktopIpc(page, 'finance:importCommit', { path: csvPath, accountId: 'acc1', profile: 'generic', mapping: { dateColumn: 'date', amountColumn: 'amount', counterpartyColumn: 'counterparty', purposeColumn: 'purpose' } });
  } finally {
    fs.rmSync(csvPath, { force: true });
  }
};

test('the workbench offers an invoice with what is still open, and says why a reserved line has no candidates', async () => {
  const { page, baseUrl } = desktop;
  const invoice = (await invokeDesktopIpc(page, 'invoices:list', {})).find((candidate) => candidate.id === 'inv-open-1');
  const item = (await invokeDesktopIpc(page, 'pro:listOpenItems')).find((row) => row.sourceId === invoice.id);
  await invokeDesktopIpc(page, 'pro:allocateOpenItemPayment', { payment: { sourceType: 'manual', sourceId: 'e2e-part-1', partyType: item.partyType, partyId: item.partyId, paymentDate: '2026-04-02', amount: 450.5, bankAccountNumber: '1200', method: 'Überweisung', allocations: [{ openItemId: item.id, amount: 450.5 }], reason: 'Teilzahlung', allocationEventId: 'e2e-part-1' } });
  await importBookedLine(page, { date: '2026-04-20', amount: 3000, counterparty: invoice.client, purpose: `Restzahlung ${invoice.number}` });
  await importPendingProTransaction(page, 'vorgemerkt', { amount: 120, counterparty: 'Vorgemerkt Kunde', purpose: 'Anzahlung', date: '2026-04-21' });

  await page.goto(appUrl(baseUrl, '/accounting?view=reconciliation'));
  await page.getByRole('button', { name: new RegExp(`^${invoice.client}`) }).first().click();
  const candidate = page.getByRole('listitem', { name: `Rechnung ${invoice.number}` });
  await expect(candidate).toContainText('3.000,00');
  await expect(candidate).not.toContainText('3.450,50');
  await page.screenshot({ path: test.info().outputPath('04-candidate-residual.png'), fullPage: true });

  await page.getByRole('button', { name: /^Vorgemerkt Kunde/ }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Die Bank hat diesen Umsatz nur vorgemerkt.' })).toBeVisible();
  await expect(page.getByText('Keine offene Rechnung passt zu diesem Umsatz.')).toHaveCount(0);
});
