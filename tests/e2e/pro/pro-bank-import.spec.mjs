import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedDesktopData(desktop.page, { app: 'pro' });
  // Seeding writes past react-query; reload so views read the seeded rows.
  await desktop.page.reload();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

// A plain bank export: no status column, the bank reports every row as settled ("gebucht").
const importBankExport = async (page) => {
  const csvPath = path.join(os.tmpdir(), `billme-bank-export-${process.pid}-${Date.now()}.csv`);
  fs.writeFileSync(csvPath, [
    'Buchungstag;Verwendungszweck;Empfänger;Betrag',
    '22.09.2026;Miete September;Hausverwaltung Nord;-1.190,00',
    '21.09.2026;Zahlung Projekt;Audit Kunde AG;428,40',
  ].join('\n'));
  try {
    const [account] = await invokeDesktopIpc(page, 'accounts:list');
    const preview = await invokeDesktopIpc(page, 'finance:importPreview', { path: csvPath, profile: 'auto', accountIdForDedupHash: account.id });
    return await invokeDesktopIpc(page, 'finance:importCommit', { path: csvPath, accountId: account.id, profile: preview.profile, mapping: preview.suggestedMapping });
  } finally {
    fs.rmSync(csvPath, { force: true });
  }
};

const draftFor = async (page, purpose) => {
  const transaction = (await invokeDesktopIpc(page, 'pro:listBankTransactions')).find((row) => row.purpose === purpose);
  return invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: transaction.id });
};

test('imports a settled bank export as open work, not as posted bookings', async () => {
  const { page } = desktop;
  expect((await importBankExport(page)).imported).toBe(2);

  const rent = await draftFor(page, 'Miete September');
  expect(rent.workflowStatus).not.toBe('posted');
  expect(rent.isVirtualProjection).toBeFalsy();
  // Expense on the debit side, bank on the credit side.
  const [expenseLine, bankLine] = rent.lines;
  expect(expenseLine).toMatchObject({ debitAmount: 1190, creditAmount: 0 });
  expect(bankLine).toMatchObject({ debitAmount: 0, creditAmount: 1190 });

  const income = await draftFor(page, 'Zahlung Projekt');
  expect(income.lines[0]).toMatchObject({ debitAmount: 428.4, creditAmount: 0 });
  expect(income.lines[1]).toMatchObject({ debitAmount: 0, creditAmount: 428.4 });

  expect(await invokeDesktopIpc(page, 'pro:listJournalEntries', { limit: 50, offset: 0 })).toHaveLength(0);
});

test('ships the core SKR accounts the default drafts book against', async () => {
  const { page } = desktop;
  const numbers = async (chart) => new Set((await invokeDesktopIpc(page, 'pro:listLedgerAccounts', { chart, limit: 10_000 })).map((row) => row.accountNumber));
  const skr03 = await numbers('SKR03');
  const skr04 = await numbers('SKR04');
  for (const account of ['1000', '1200', '1400', '1576', '1600', '1776', '4900', '8400']) expect(skr03.has(account), `SKR03 ${account}`).toBe(true);
  for (const account of ['1200', '1406', '1800', '3300', '3806', '4400', '6300']) expect(skr04.has(account), `SKR04 ${account}`).toBe(true);

  await importBankExport(page);
  const rent = await draftFor(page, 'Miete September');
  const reviewed = await invokeDesktopIpc(page, 'pro:dispatchDraftAction', { transactionId: rent.transactionId, action: 'submit_for_review' });
  expect(reviewed.validationIssues.filter((issue) => issue.code === 'UNKNOWN_ACCOUNT')).toEqual([]);
});

test('shows a blocked draft in the inbox queues instead of hiding it', async () => {
  const { page, baseUrl } = desktop;
  await importBankExport(page);
  const [account] = await invokeDesktopIpc(page, 'accounts:list');
  // Point the bank account at a number that does not exist in the active chart.
  await invokeDesktopIpc(page, 'accounts:upsert', { account: { ...account, defaultSkrAccountNumber: '0001' } });
  const rent = await draftFor(page, 'Miete September');
  await invokeDesktopIpc(page, 'pro:saveDraft', {
    draft: { ...rent, lines: rent.lines.map((line, index) => (index === 1 ? { ...line, accountNumber: '0001' } : line)) },
  });
  await invokeDesktopIpc(page, 'pro:dispatchDraftAction', { transactionId: rent.transactionId, action: 'submit_for_review' });

  await page.goto(appUrl(baseUrl, '/accounting'));
  await expect(page.getByRole('button', { name: /^Fehler [1-9]/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Unvollständig [1-9]/ })).toBeVisible();
});
