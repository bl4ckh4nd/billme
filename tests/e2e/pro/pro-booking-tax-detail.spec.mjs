import { expect, test } from '@playwright/test';
import { appUrl, approveProDraft, importPendingProTransaction, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';

let desktop;

const pickAccounts = async (page) => {
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
  const expenseAccount =
    ledger.find((row) => row.accountNumber.startsWith('6'))?.accountNumber
    ?? ledger.find((row) => row.accountNumber.startsWith('4'))?.accountNumber
    ?? ledger.find((row) => !/^[01]/.test(row.accountNumber))?.accountNumber;
  const inputTaxAccount =
    ledger.find((row) => row.accountNumber.startsWith('157'))?.accountNumber
    ?? ledger.find((row) => row.accountNumber.startsWith('140'))?.accountNumber
    ?? expenseAccount;
  const outputTaxAccount =
    ledger.find((row) => row.accountNumber.startsWith('177'))?.accountNumber
    ?? ledger.find((row) => row.accountNumber.startsWith('380'))?.accountNumber
    ?? expenseAccount;

  expect(bankAccount).toBeTruthy();
  expect(expenseAccount).toBeTruthy();
  expect(inputTaxAccount).toBeTruthy();
  expect(outputTaxAccount).toBeTruthy();
  return { chart, bankAccount, expenseAccount, inputTaxAccount, outputTaxAccount };
};

const saveDraftForTx = async (page, { txId, accountNumber, bankAccount, taxCaseKey, taxPayload }) => {
  const tx = (await invokeDesktopIpc(page, 'pro:listBankTransactions')).find((row) => row.id === txId);
  expect(tx).toBeTruthy();
  const existing = await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', {
    transactionId: txId,
  });
  expect(existing?.id).toBeTruthy();

  const abs = Math.abs(Number(tx.amount));
  const postingDate = tx.date;
  const lineNonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const draft = await approveProDraft(page, {
    id: existing.id,
    tenantId: 'default',
    transactionId: txId,
    workflowStatus: 'suggested',
    postingDate,
    documentDate: postingDate,
    bookingText: `E2E Tax ${taxCaseKey}`,
    reference: txId,
    period: postingDate.slice(0, 7),
    fiscalYear: Number(postingDate.slice(0, 4)),
    lines: [
      {
        id: `line-${txId}-1-${lineNonce}`,
        accountNumber,
        debitAmount: abs,
        creditAmount: 0,
        taxCaseKey,
        taxCode: taxCaseKey,
        taxRate: taxPayload?.taxRate,
        netAmount: taxPayload?.netAmount,
        taxAmount: taxPayload?.taxAmount,
        grossAmount: taxPayload?.grossAmount,
        destinationVatRate: taxPayload?.destinationVatRate,
        countryCode: taxPayload?.countryCode,
        counterpartyVatId: taxPayload?.counterpartyVatId,
        evidenceType: taxPayload?.evidenceType,
        evidenceReference: taxPayload?.evidenceReference,
        datevSachverhaltLl: taxPayload?.datevSachverhaltLl,
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
  });

  return draft;
};

test.beforeEach(async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedDesktopData(desktop.page, { app: 'pro' });
  // Seeding writes past react-query and the onboarding gate; reload so the shell reads the seeded settings.
  await desktop.page.reload();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('booking detail UI enforces tax-case requirements and clears blockers after field completion', async () => {
  const { page, baseUrl } = desktop;
  const { transaction: targetTx, draft: editableDraft } = await importPendingProTransaction(page, 'tax-detail');
  const { chart, expenseAccount, bankAccount } = await pickAccounts(page);
  await invokeDesktopIpc(page, 'pro:upsertTaxCaseAccountMapping', {
    chart,
    taxCaseKey: 'EU_B2B_SERVICE_RC',
    role: 'datev_bu',
    accountNumber: expenseAccount,
    datevBuKey: '94',
  });
  await invokeDesktopIpc(page, 'pro:saveDraft', {
    draft: {
      ...editableDraft,
      lines: editableDraft.lines.map((line, index) => ({
        ...line,
        accountNumber: index === 0 ? expenseAccount : bankAccount,
      })),
      workflowStatus: 'suggested',
    },
  });

  await page.goto(appUrl(baseUrl, '/accounting?view=inbox'));
  await expect(page.getByRole('heading', { name: 'Buchen', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: `${targetTx.counterparty} öffnen` }).click();
  await page.getByRole('button', { name: 'Erweitern' }).click();

  await expect(page.getByRole('heading', { name: 'Buchung erfassen' })).toBeVisible();
  await expect(page.getByRole('heading', { name: /^Buchungssatz/ })).toBeVisible();
  const taxCaseSelect = page.getByRole('combobox', { name: 'Steuerfall' }).first();
  await expect(taxCaseSelect).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('01-booking-editor.png'), fullPage: true });

  await taxCaseSelect.selectOption('DE_KU19');
  await page.getByRole('button', { name: 'Entwurf speichern' }).click();

  let check = await invokeDesktopIpc(page, 'pro:validateTaxCompliance', { transactionId: targetTx.id });
  expect(check.issues.some((issue) => issue.code === 'MISSING_TAX_EVIDENCE')).toBeTruthy();

  await page.getByLabel('Nachweisart').fill('KU-Hinweis');
  await page.getByLabel('Nachweis-Referenz').fill('KU-REF-001');
  await page.getByRole('button', { name: 'Entwurf speichern' }).click();

  check = await invokeDesktopIpc(page, 'pro:validateTaxCompliance', { transactionId: targetTx.id });
  expect(check.issues.some((issue) => issue.code === 'MISSING_TAX_EVIDENCE')).toBe(false);

  await taxCaseSelect.selectOption('EU_B2B_SERVICE_RC');
  await page.getByRole('button', { name: 'Entwurf speichern' }).click();

  check = await invokeDesktopIpc(page, 'pro:validateTaxCompliance', { transactionId: targetTx.id });
  expect(check.issues.some((issue) => issue.code === 'MISSING_TAX_COUNTRY')).toBeTruthy();
  expect(check.issues.some((issue) => issue.code === 'MISSING_COUNTERPARTY_VAT_ID')).toBeTruthy();

  await page.getByLabel('Land', { exact: true }).fill('FR');
  await page.getByLabel('USt-IdNr.').fill('FR12345678901');
  await page.getByLabel('Nachweisart').fill('Invoice PDF');
  await page.getByLabel('Nachweis-Referenz').fill('RC-REF-001');
  await page.getByRole('button', { name: 'Entwurf speichern' }).click();

  check = await invokeDesktopIpc(page, 'pro:validateTaxCompliance', { transactionId: targetTx.id });
  expect(check.issues.some((issue) => issue.code === 'MISSING_TAX_COUNTRY')).toBe(false);
  expect(check.issues.some((issue) => issue.code === 'MISSING_COUNTERPARTY_VAT_ID')).toBe(false);
  expect(check.issues.some((issue) => issue.code === 'MISSING_TAX_EVIDENCE')).toBe(false);
  // The editor's Steuersatz % doubles as the destination rate; only the DATEV Sachverhalt has no control in the editor.
  expect(check.issues.map((issue) => issue.code)).toEqual(['MISSING_DATEV_SACHVERHALT']);
  await page.screenshot({ path: test.info().outputPath('02-reverse-charge-fields.png'), fullPage: true });

  // The current booking editor has no controls for these DATEV-only fields.
  // Seed them through the typed IPC contract, then validate and explicitly
  // re-approve the draft so the approval state reflects the final evidence.
  const persisted = await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: targetTx.id });
  expect(persisted?.id).toBeTruthy();
  const rcLine = persisted.lines.find((line) => line.taxCaseKey === 'EU_B2B_SERVICE_RC');
  expect(rcLine).toBeTruthy();
  const enriched = await invokeDesktopIpc(page, 'pro:saveDraft', {
    draft: {
      ...persisted,
      workflowStatus: 'suggested',
      lines: persisted.lines.map((line) => line.id === rcLine.id
        ? { ...line, destinationVatRate: 20, datevSachverhaltLl: '13' }
        : line),
    },
  });
  expect(enriched.validationIssues.some((issue) => issue.code === 'MISSING_DESTINATION_VAT_RATE')).toBe(false);
  expect(enriched.validationIssues.some((issue) => issue.code === 'MISSING_DATEV_SACHVERHALT')).toBe(false);

  check = await invokeDesktopIpc(page, 'pro:validateTaxCompliance', { transactionId: targetTx.id });
  expect(check.ok).toBe(true);
  expect(check.issues.filter((issue) => issue.blocking)).toEqual([]);
  await invokeDesktopIpc(page, 'pro:dispatchDraftAction', { transactionId: targetTx.id, action: 'submit_for_review' });
  const approved = await invokeDesktopIpc(page, 'pro:dispatchDraftAction', {
    transactionId: targetTx.id,
    action: 'approve',
  });
  expect(approved.workflowStatus).toBe('approved');
});

test('posts tax-case variants and verifies VAT summary rows for mixed tax versions', async () => {
  const { page, baseUrl } = desktop;
  await page.goto(appUrl(baseUrl, '/accounting?view=inbox'));
  await expect(page.getByRole('heading', { name: 'Buchen', level: 1 })).toBeVisible();

  const { transaction: txStd } = await importPendingProTransaction(page, 'tax-standard');
  const { transaction: txRc } = await importPendingProTransaction(page, 'tax-reverse-charge');
  const { transaction: txReduced } = await importPendingProTransaction(page, 'tax-reduced', { amount: -107, date: '2026-04-03' });
  expect(txStd).toBeTruthy();
  expect(txRc).toBeTruthy();

  const { chart, bankAccount, expenseAccount, inputTaxAccount, outputTaxAccount } = await pickAccounts(page);

  await invokeDesktopIpc(page, 'pro:upsertTaxCaseAccountMapping', {
    chart,
    taxCaseKey: 'EU_B2B_SERVICE_RC',
    role: 'input_tax',
    accountNumber: inputTaxAccount,
  });
  await invokeDesktopIpc(page, 'pro:upsertTaxCaseAccountMapping', {
    chart,
    taxCaseKey: 'EU_B2B_SERVICE_RC',
    role: 'output_tax',
    accountNumber: outputTaxAccount,
  });
  await invokeDesktopIpc(page, 'pro:upsertTaxCaseAccountMapping', {
    chart,
    taxCaseKey: 'EU_B2B_SERVICE_RC',
    role: 'datev_bu',
    accountNumber: expenseAccount,
    datevBuKey: '94',
  });

  const stdDraft = await saveDraftForTx(page, {
    txId: txStd.id,
    accountNumber: expenseAccount,
    bankAccount,
    taxCaseKey: 'DE_STD_19',
    taxPayload: {
      taxRate: 19,
      netAmount: 100,
      taxAmount: 19,
      grossAmount: 119,
    },
  });

  let post = await invokeDesktopIpc(page, 'pro:postDraft', {
    draftId: stdDraft.id,
    actorRole: 'accountant',
  });
  expect(post.issues.filter((issue) => issue.blocking)).toEqual([]);

  const reducedDraft = await saveDraftForTx(page, {
    txId: txReduced.id,
    accountNumber: expenseAccount,
    bankAccount,
    taxCaseKey: 'DE_STD_7',
    taxPayload: {
      taxRate: 7,
      netAmount: 100,
      taxAmount: 7,
      grossAmount: 107,
    },
  });
  post = await invokeDesktopIpc(page, 'pro:postDraft', {
    draftId: reducedDraft.id,
    actorRole: 'accountant',
  });
  expect(post.issues.filter((issue) => issue.blocking)).toEqual([]);

  const rcDraft = await saveDraftForTx(page, {
    txId: txRc.id,
    accountNumber: expenseAccount,
    bankAccount,
    taxCaseKey: 'EU_B2B_SERVICE_RC',
    taxPayload: {
      taxRate: 19,
      netAmount: 100,
      taxAmount: 19,
      grossAmount: 119,
      countryCode: 'FR',
      counterpartyVatId: 'FR12345678901',
      evidenceType: 'Invoice',
      evidenceReference: 'RC-2026-03-12',
      destinationVatRate: 20,
      datevSachverhaltLl: '13',
    },
  });

  post = await invokeDesktopIpc(page, 'pro:postDraft', {
    draftId: rcDraft.id,
    actorRole: 'accountant',
  });
  expect(post.issues.filter((issue) => issue.blocking)).toEqual([]);

  const entries = await invokeDesktopIpc(page, 'pro:listJournalEntries', { limit: 500, offset: 0 });
  const stdEntry = entries.find((entry) => entry.sourceDraftId === stdDraft.id && entry.status === 'posted');
  const rcEntry = entries.find((entry) => entry.sourceDraftId === rcDraft.id && entry.status === 'posted');
  expect(stdEntry).toBeTruthy();
  expect(rcEntry).toBeTruthy();
  const keys = [
    ...stdEntry.lines.map((line) => line.taxCaseKey).filter(Boolean),
    ...rcEntry.lines.map((line) => line.taxCaseKey).filter(Boolean),
  ];
  expect(keys).toContain('DE_STD_19');
  expect(keys).toContain('EU_B2B_SERVICE_RC');

  const vatSummary = await invokeDesktopIpc(page, 'pro:getVatSummary', {
    from: '2026-04-01',
    to: '2026-04-03',
  });
  const vatByCase = new Map(vatSummary.rows.map((row) => [row.taxCaseKey, row]));
  expect(vatByCase.get('DE_STD_19')).toMatchObject({ netAmount: 100, taxAmount: 19, grossAmount: 119 });
  expect(vatByCase.get('DE_STD_7')).toMatchObject({ netAmount: 100, taxAmount: 7, grossAmount: 107 });
  expect(vatByCase.get('EU_B2B_SERVICE_RC')).toMatchObject({
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    lineCount: 1,
  });

  // The workbench shows the three tax-case drafts as booked.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Gebucht 3' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('01-three-tax-cases-posted.png'), fullPage: true });
});
