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
const CARD_IBAN = 'DE03500105170000004021';

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

/** Review, approval and posting of one line; the browser part of these tests is elsewhere. */
const post = async (page, transactionId) => {
  await invokeDesktopIpc(page, 'pro:dispatchDraftAction', { transactionId, action: 'submit_for_review' });
  const approved = await invokeDesktopIpc(page, 'pro:dispatchDraftAction', { transactionId, action: 'approve' });
  expect((await invokeDesktopIpc(page, 'pro:postDraft', { draftId: approved.id, postingDate: approved.postingDate })).issues).toEqual([]);
};

test('a payment to an own IBAN is proposed on Geldtransit by the built-in rule, and Ausnahmen shows Geldtransit open until the other side is booked', async () => {
  const { page, baseUrl } = desktop;
  await importCsv(page, 'acc1', ['03.10.2026;American Express;DE03 5001 0517 0000 0040 21;Kartenabrechnung 09/2026;-1.248,30;EUR']);
  // The card statement names no IBAN: that side is booked like any other line.
  await importCsv(page, 'acc-card', ['05.10.2026;Zahlung erhalten;;Vielen Dank;1.248,30;EUR']);
  await page.reload();

  await page.goto(appUrl(baseUrl, '/accounting?view=reconciliation'));
  await page.getByRole('button', { name: /American Express/ }).click();
  await expect(page.getByText(/1360\s*Kontierungsvorschlag/)).toBeVisible();
  await expect(page.getByRole('list', { name: 'Regel-Trace' })).toContainText('Basis „Umbuchung zwischen eigenen Konten“ setzt Konto, Buchungstext');
  await page.screenshot({ path: test.info().outputPath('01-bankabgleich-umbuchung.png') });

  const giroSide = await lineBy(page, 'acc1', -1248.3);
  await post(page, giroSide.id);
  await page.goto(appUrl(baseUrl, '/accounting?view=exceptions'));
  await page.getByRole('button', { name: /Geldtransit offen/ }).click();
  await expect(page.getByRole('cell', { name: '1.248,30 €' }).last()).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('02-ausnahmen-geldtransit-offen.png') });

  const cardSide = await lineBy(page, 'acc-card', 1248.3);
  const cardDraft = await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: cardSide.id });
  await invokeDesktopIpc(page, 'pro:saveDraft', { draft: { ...cardDraft, lines: cardDraft.lines.map((line) => (line.accountNumber === '1240' ? line : { ...line, accountNumber: '1360', taxCaseKey: undefined })) } });
  await post(page, cardSide.id);
  await page.reload();
  await page.getByRole('button', { name: /Geldtransit offen/ }).click();
  await expect(page.getByText('Geldtransit ist ausgeglichen.')).toBeVisible();
  expect((await invokeDesktopIpc(page, 'pro:getTransitOverview')).openBalance).toBe(0);
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
