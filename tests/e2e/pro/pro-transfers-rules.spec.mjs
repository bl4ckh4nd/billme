import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';

// Umbuchungen between own accounts (Bankabgleich → Ausnahmen) and booking rules
// (Bankabgleich → Einstellungen › Buchungsregeln → Probelauf → Bankabgleich).
// Data comes in through the API; the browser only does what a user does.

let desktop;

const GIRO_IBAN = 'DE89370400440532013000';
const CARD_IBAN = 'DE21500105170000004021';

test.beforeEach(async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedDesktopData(desktop.page, { app: 'pro' });
  const { page } = desktop;
  expect((await invokeDesktopIpc(page, 'pro:getAccountingPolicy')).activeChart).toBe('SKR03');
  const giro = (await invokeDesktopIpc(page, 'accounts:list')).find((account) => account.id === 'acc1');
  await invokeDesktopIpc(page, 'accounts:upsert', { account: { ...giro, name: 'Girokonto', iban: GIRO_IBAN, defaultSkrAccountNumber: '1200' } });
  await invokeDesktopIpc(page, 'accounts:upsert', { account: { id: 'acc-card', name: 'Firmenkarte', iban: CARD_IBAN, balance: 0, transactions: [], type: 'credit', color: 'bg-white', defaultSkrAccountNumber: '1240' } });
  await page.reload();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

/** A FinTS-style export with the counterparty IBAN column, imported like the import dialog does. */
const importCsv = async (page, accountId, rows) => {
  const csvPath = path.join(os.tmpdir(), `billme-umb-${process.pid}-${Date.now()}-${accountId}.csv`);
  fs.writeFileSync(csvPath, ['Buchungstag;Auftraggeber/Empfänger;IBAN;Verwendungszweck;Betrag;Währung', ...rows].join('\n'));
  try {
    const preview = await invokeDesktopIpc(page, 'finance:importPreview', { path: csvPath, profile: 'fints', accountIdForDedupHash: accountId });
    expect(preview.suggestedMapping.counterpartyIbanColumn).toBe('IBAN');
    return await invokeDesktopIpc(page, 'finance:importCommit', { path: csvPath, accountId, profile: 'fints', mapping: preview.suggestedMapping });
  } finally {
    fs.rmSync(csvPath, { force: true });
  }
};

const lineBy = async (page, accountId, amount) => (await invokeDesktopIpc(page, 'pro:listBankTransactions')).find((row) => row.accountId === accountId && row.amount === amount);

test('a transfer between own accounts is booked over Geldtransit, and an open side finds its partner in Ausnahmen', async () => {
  const { page, baseUrl } = desktop;
  await importCsv(page, 'acc1', ['03.10.2026;American Express;DE21 5001 0517 0000 0040 21;Kartenabrechnung 09/2026;-1.248,30;EUR', '21.10.2026;Gutschrift American Express;;Rückzahlung Guthaben;42,10;EUR']);
  await importCsv(page, 'acc-card', ['05.10.2026;Zahlung erhalten;;Vielen Dank;1.248,30;EUR', '12.10.2026;Guthaben zurückerstattet;;Rückzahlung;-42,10;EUR']);
  // A side booked on Geldtransit earlier; its partner arrived nine days later, outside the 7-day window.
  const cardRefund = await lineBy(page, 'acc-card', -42.1);
  expect(cardRefund.transfer).toBeUndefined();
  await invokeDesktopIpc(page, 'pro:confirmTransfer', { transactionId: cardRefund.id, post: true });
  await page.reload();

  await page.goto(appUrl(baseUrl, '/accounting?view=reconciliation'));
  const amexRow = page.getByRole('button', { name: /American Express.*Umbuchung · Firmenkarte/ });
  await expect(amexRow).toBeVisible();
  await amexRow.click();
  const section = page.getByRole('region', { name: 'Umbuchung zwischen eigenen Konten' });
  await expect(section.getByText('Gegen-IBAN ist Ihr Konto „Firmenkarte“', { exact: false })).toBeVisible();
  await expect(section.getByText('Kein Steuerfall, kein Beleg nötig.', { exact: false })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('01-bankabgleich-umbuchung.png') });
  await section.getByRole('button', { name: 'Als Umbuchung buchen' }).click();
  await expect.poll(async () => [(await lineBy(page, 'acc1', -1248.3)).status, (await lineBy(page, 'acc-card', 1248.3)).status]).toEqual(['booked', 'booked']);

  await page.goto(appUrl(baseUrl, '/accounting?view=exceptions'));
  await page.getByRole('button', { name: /Geldtransit offen/ }).click();
  await expect(page.getByText('Partner gesucht').first()).toBeVisible();
  await expect(page.getByText('außerhalb des Zeitfensters')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('02-ausnahmen-geldtransit-offen.png') });
  await page.getByRole('button', { name: 'Als Gegenseite zuordnen' }).click();
  await expect(page.getByText('Geldtransit ist ausgeglichen.')).toBeVisible();
  const transit = await invokeDesktopIpc(page, 'pro:getTransitOverview');
  expect(transit.transitAccountNumber).toBe('1360');
  expect(transit.openBalance).toBe(0);
  expect(transit.months.find((month) => month.period === '2026-10')).toMatchObject({ balance: 0 });
  await page.screenshot({ path: test.info().outputPath('03-geldtransit-ausgeglichen.png') });
});

test('a rule made from a bank line proposes the full booking, and the dry run updates only untouched drafts', async () => {
  const { page, baseUrl } = desktop;
  await importCsv(page, 'acc1', ['20.10.2026;Telekom Deutschland GmbH;;Mobilfunk Rechnung 10/2026;-119,00;EUR', '22.10.2026;Telekom Deutschland GmbH;;Festnetz 10/2026;-59,50;EUR']);
  const mobile = await lineBy(page, 'acc1', -119);
  const landline = await lineBy(page, 'acc1', -59.5);
  // Both drafts exist before the rule; the landline one is changed by hand and must stay as it is.
  await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: mobile.id });
  const landlineDraft = await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: landline.id });
  await invokeDesktopIpc(page, 'pro:saveDraft', { draft: { ...landlineDraft, lines: landlineDraft.lines.map((line) => (line.accountNumber === '1200' ? line : { ...line, accountNumber: '4930' })) } });
  await page.reload();

  await page.goto(appUrl(baseUrl, '/accounting?view=reconciliation'));
  await page.getByRole('button', { name: /Telekom Deutschland GmbH.*119,00/ }).click();
  await page.getByRole('button', { name: 'Regel aus diesem Umsatz' }).click();

  await expect(page).toHaveURL(/section=rules/);
  await expect(page.getByLabel('Name')).toHaveValue('Telekom Deutschland GmbH');
  await expect(page.getByLabel('Wert')).toHaveValue('Telekom Deutschland GmbH');
  await expect(page.getByText('2 von', { exact: false })).toBeVisible();
  await page.getByLabel('Konto', { exact: true }).fill('4920');
  await page.getByLabel('Steuerfall').selectOption('DE_STD_19');
  await page.getByLabel('Vorsteuer abzugsfähig (%)').fill('50');
  await page.screenshot({ path: test.info().outputPath('04-regel-editor.png') });
  await page.getByRole('button', { name: 'Regel speichern' }).click();
  await expect(page.getByRole('list', { name: 'Regeln' }).getByText('Telekom Deutschland GmbH', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Probelauf starten' }).click();
  const dryRun = page.getByRole('table', { name: 'Probelauf' });
  await expect(dryRun.getByText('wird geändert')).toBeVisible();
  await expect(dryRun.getByText('Von Hand geändert')).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('05-probelauf.png') });
  await page.getByRole('button', { name: '1 Entwurf neu vorschlagen' }).click();
  await expect(page.getByText('1 Entwurf neu vorgeschlagen.')).toBeVisible();

  const lines = (draft) => draft.lines.map((line) => `${line.accountNumber}:${line.debitAmount ? 'S' : 'H'}${line.debitAmount || line.creditAmount}`);
  expect(lines(await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: mobile.id }))).toEqual(['4920:S109.5', '1576:S9.5', '1200:H119']);
  expect(lines(await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: landline.id }))).toEqual(['4930:S59.5', '1200:H59.5']);

  await page.goto(appUrl(baseUrl, '/accounting?view=reconciliation'));
  await page.getByRole('button', { name: /Telekom Deutschland GmbH.*119,00/ }).click();
  await expect(page.getByRole('list', { name: 'Regel-Trace' })).toContainText('Basis „Telekom Deutschland GmbH“ setzt Konto, Steuerfall, Abzug');
  await page.screenshot({ path: test.info().outputPath('06-bankabgleich-regel-trace.png') });
});
