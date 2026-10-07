import { expect, test } from '@playwright/test';
import { appUrl, importPendingProTransaction, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';

let desktop;

const ensureWorkflowDraft = async (page) => {
  const { transaction: tx, draft: importedDraft } = await importPendingProTransaction(page, 'workflow');
  const policy = await invokeDesktopIpc(page, 'pro:getAccountingPolicy');
  const ledger = await invokeDesktopIpc(page, 'pro:listLedgerAccounts', { chart: policy.activeChart, limit: 3000, offset: 0 });
  const bankAccount = ledger.find((row) => row.accountNumber === (policy.activeChart === 'SKR03' ? '1200' : '1800'))?.accountNumber
    ?? ledger.find((row) => row.accountNumber.startsWith('1'))?.accountNumber;
  const expenseAccount = ledger.find((row) => row.accountNumber.startsWith('6'))?.accountNumber
    ?? ledger.find((row) => row.accountNumber.startsWith('4'))?.accountNumber;
  expect(bankAccount).toBeTruthy();
  expect(expenseAccount).toBeTruthy();
  const postingDate = tx.date ?? new Date().toISOString().slice(0, 10);
  const amount = Math.abs(Number(tx.amount || 0)) || 1;
  const draft = await invokeDesktopIpc(page, 'pro:saveDraft', {
    draft: {
      ...importedDraft,
      workflowStatus: 'suggested',
      postingDate,
      documentDate: postingDate,
      bookingText: 'E2E Pro Workflow',
      reference: 'E2E-WF',
      period: postingDate.slice(0, 7),
      fiscalYear: Number(postingDate.slice(0, 4)),
      lines: [
        { ...importedDraft.lines[0], accountNumber: expenseAccount, debitAmount: amount, creditAmount: 0 },
        { ...importedDraft.lines[1], accountNumber: bankAccount, debitAmount: 0, creditAmount: amount },
      ],
      validationIssues: [],
      updatedAt: new Date().toISOString(),
    },
  });
  return { tx, draft };
};

test.beforeEach(async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedDesktopData(desktop.page, { app: 'pro' });
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('posts and reverses a pro draft while accounting health reflects transitions', async () => {
  const { page, baseUrl } = desktop;
  const { tx, draft } = await ensureWorkflowDraft(page);
  const healthBefore = await invokeDesktopIpc(page, 'pro:getAccountingHealth');
  const journalBefore = await invokeDesktopIpc(page, 'pro:listJournalEntries', { limit: 500, offset: 0 });

  await page.goto(appUrl(baseUrl, '/accounting'));
  await expect(page.getByRole('heading', { name: 'Buchen', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Gebucht 0' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('01-inbox-before-posting.png') });

  await invokeDesktopIpc(page, 'pro:dispatchDraftAction', { transactionId: tx.id, action: 'submit_for_review' });
  await invokeDesktopIpc(page, 'pro:dispatchDraftAction', { transactionId: tx.id, action: 'approve' });
  const postResult = await invokeDesktopIpc(page, 'pro:postDraft', { draftId: draft.id, actorRole: 'accountant' });
  expect(postResult.issues.filter((issue) => issue.blocking)).toEqual([]);

  const healthAfterPost = await invokeDesktopIpc(page, 'pro:getAccountingHealth');
  expect(healthAfterPost.postedCount).toBe(healthBefore.postedCount + 1);
  await page.reload();
  // The queue counts bank transactions whose draft is posted; the seeded invoices are not bank lines.
  await expect(page.getByRole('button', { name: 'Gebucht 1' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('02-inbox-after-posting.png') });

  const journalEntries = await invokeDesktopIpc(page, 'pro:listJournalEntries', { limit: 500, offset: 0 });
  expect(journalEntries).toHaveLength(journalBefore.length + 1);
  const postedEntry = journalEntries.find((entry) => entry.sourceDraftId === draft.id && entry.status === 'posted');
  expect(postedEntry?.id).toBeTruthy();
  expect(postedEntry.lines.map((line) => [line.debitAmount, line.creditAmount])).toEqual([[120, 0], [0, 120]]);

  const reversed = await invokeDesktopIpc(page, 'pro:reverseJournalEntry', { entryId: postedEntry.id, reason: 'E2E reverse flow', actorRole: 'accountant' });
  expect(reversed.ok).toBe(true);

  const journalAfterReverse = await invokeDesktopIpc(page, 'pro:listJournalEntries', { limit: 500, offset: 0 });
  const original = journalAfterReverse.find((entry) => entry.id === postedEntry.id);
  const reversal = journalAfterReverse.find((entry) => entry.id === reversed.reversalEntryId);
  expect(original).toMatchObject({ status: 'reversed', reversedEntryId: reversed.reversalEntryId });
  expect(reversal).toMatchObject({ status: 'posted', sourceKey: `reversal:${postedEntry.id}` });
  // The reversal books the original lines with debit and credit swapped.
  expect(reversal.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount])).toEqual(
    postedEntry.lines.map((line) => [line.accountNumber, line.creditAmount, line.debitAmount]),
  );
  await page.reload();
  await page.screenshot({ path: test.info().outputPath('03-inbox-after-reversal.png') });
});
