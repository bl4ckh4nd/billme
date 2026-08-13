import { expect, test } from '@playwright/test';
import { appUrl, importPendingProTransaction, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';

let desktop;

const resolveLedgerAccounts = async (page) => {
  const policy = await invokeDesktopIpc(page, 'pro:getAccountingPolicy');
  const chart = policy.activeChart;
  const ledger = await invokeDesktopIpc(page, 'pro:listLedgerAccounts', {
    chart,
    limit: 3000,
    offset: 0,
  });
  const bankAccount =
    ledger.find((row) => row.accountNumber === (chart === 'SKR03' ? '1200' : '1800'))?.accountNumber
    ?? ledger.find((row) => row.accountNumber.startsWith('1'))?.accountNumber
    ?? ledger[0]?.accountNumber;
  const trainingAccount =
    ledger.find((row) => /^[4567]/.test(row.accountNumber))?.accountNumber
    ?? ledger.find((row) => !/^[0123]/.test(row.accountNumber))?.accountNumber;

  expect(bankAccount).toBeTruthy();
  expect(trainingAccount).toBeTruthy();
  return { chart, bankAccount, trainingAccount };
};

const postExpenseDraft = async (page, { txId, amount, trainingAccount, bankAccount, bookingText }) => {
  const tx = (await invokeDesktopIpc(page, 'pro:listBankTransactions')).find((row) => row.id === txId);
  expect(tx).toBeTruthy();
  const existingDraft = await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', {
    transactionId: txId,
  });
  expect(existingDraft?.id).toBeTruthy();

  const abs = Math.abs(Number(amount));
  const postingDate = tx.date;
  const lineNonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const draft = {
    id: existingDraft.id,
    tenantId: 'default',
    transactionId: txId,
    workflowStatus: 'approved',
    postingDate,
    documentDate: postingDate,
    bookingText,
    reference: txId,
    period: postingDate.slice(0, 7),
    fiscalYear: Number(postingDate.slice(0, 4)),
      lines: [
        {
          id: `line-${txId}-1-${lineNonce}`,
          accountNumber: trainingAccount,
          debitAmount: abs,
          creditAmount: 0,
          taxCaseKey: 'DE_STD_19',
          taxCode: 'USt19',
          taxRate: 19,
          netAmount: 100,
          taxAmount: 19,
          grossAmount: 119,
        },
      {
        id: `line-${txId}-2-${lineNonce}`,
        accountNumber: bankAccount,
        debitAmount: 0,
        creditAmount: abs,
      },
    ],
    validationIssues: [],
    updatedAt: new Date().toISOString(),
  };

  const saved = await invokeDesktopIpc(page, 'pro:saveDraft', { draft });
  const post = await invokeDesktopIpc(page, 'pro:postDraft', {
    draftId: saved.id,
    actorRole: 'accountant',
  });
  const blocking = post.issues.filter((issue) => issue.blocking);
  expect(blocking).toEqual([]);
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

test('covers rule engine and ML suggestion layers (rule, counterparty, bayes)', async () => {
  const { page, baseUrl } = desktop;
  await page.goto(appUrl(baseUrl, '/accounting'));
  await expect(page.getByRole('heading', { name: 'Pro Buchhaltung' })).toBeVisible();

  const { chart, bankAccount, trainingAccount } = await resolveLedgerAccounts(page);
  const trainingCounterparty = `E2E ML Training ${process.pid}-${Date.now()}`;
  const { transaction: trainingTx } = await importPendingProTransaction(page, 'ml-training', {
    amount: -119,
    counterparty: trainingCounterparty,
    purpose: 'E2E ML training',
  });
  const { transaction: bayesProbeTx } = await importPendingProTransaction(page, 'ml-probe', {
    counterparty: `E2E ML Probe ${process.pid}-${Date.now()}`,
    purpose: 'E2E ML probe',
  });

  const ruleNeedle = String(bayesProbeTx.counterparty || '').trim();
  expect(ruleNeedle.length).toBeGreaterThan(1);
  await invokeDesktopIpc(page, 'pro:upsertAccountSuggestionRule', {
    chart,
    priority: 1,
    field: 'counterparty',
    operator: 'equals',
    value: ruleNeedle,
    targetAccountNumber: trainingAccount,
    flowType: 'any',
    active: true,
  });

  await expect
    .poll(async () => {
      const rows = await invokeDesktopIpc(page, 'pro:listBankTransactions');
      return rows.find((row) => row.id === bayesProbeTx.id)?.suggestionLayer;
    })
    .toBe('rule');

  const rulesAfter = await invokeDesktopIpc(page, 'pro:listAccountSuggestionRules', { chart });
  const addedRule = rulesAfter.find((row) => row.value === ruleNeedle);
  if (addedRule?.id) {
    await invokeDesktopIpc(page, 'pro:deleteAccountSuggestionRule', { id: addedRule.id });
  }
  await postExpenseDraft(page, {
    txId: trainingTx.id,
    amount: Number(trainingTx.amount || 0),
    trainingAccount,
    bankAccount,
    bookingText: 'E2E Counterparty Memory Training',
  });

  await expect
    .poll(async () => {
      const rows = await invokeDesktopIpc(page, 'pro:listBankTransactions');
      return rows.find((row) => row.id === trainingTx.id)?.suggestionLayer;
    })
    .toBe('counterparty');

  for (let i = 0; i < 22; i += 1) {
    const { transaction: repeatTx } = await importPendingProTransaction(page, `ml-bayes-${i}`, {
      amount: -119,
      counterparty: trainingCounterparty,
      purpose: `E2E ML training repeat ${i}`,
    });
    await postExpenseDraft(page, {
      txId: repeatTx.id,
      amount: Number(repeatTx.amount || 0),
      trainingAccount,
      bankAccount,
      bookingText: `E2E Bayes Training Repeat ${i}`,
    });
  }

  await expect
    .poll(async () => {
      const rows = await invokeDesktopIpc(page, 'pro:listBankTransactions');
      const target = rows.find((row) => row.id === bayesProbeTx.id);
      if (!target) return null;
      return { layer: target.suggestionLayer, confidence: target.suggestionConfidence ?? 0 };
    })
    .toMatchObject({ layer: 'bayes' });
});
