import { expect, test } from '@playwright/test';
import { writeFile, unlink } from 'node:fs/promises';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData, setProAccountingPeriodStatus } from '../support.mjs';

let desktop;
let sequence = 0;
let postingAccounts;

const unique = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${sequence++}`;

const expectIpcError = async (operation, pattern) => {
  await expect(operation).rejects.toThrow(pattern);
};

const importPendingTransaction = async (page, label, amount = -120, date = '2026-04-01') => {
  const externalId = unique(`nonhappy-${label}`);
  const csvPath = `/tmp/${externalId}.csv`;
  await writeFile(
    csvPath,
    `date,amount,counterparty,purpose,status,externalId\n${date},${amount},E2E ${label},Nonhappy ${label},pending,${externalId}\n`,
    'utf8',
  );
  try {
    const imported = await invokeDesktopIpc(page, 'finance:importCommit', {
      path: csvPath,
      accountId: 'acc1',
      profile: 'generic',
      mapping: {
        dateColumn: 'date',
        amountColumn: 'amount',
        counterpartyColumn: 'counterparty',
        purposeColumn: 'purpose',
        statusColumn: 'status',
        externalIdColumn: 'externalId',
      },
    });
    expect(imported.imported).toBe(1);
  } finally {
    await unlink(csvPath).catch(() => undefined);
  }
  const transaction = (await invokeDesktopIpc(page, 'pro:listBankTransactions')).find((row) => row.purpose === `Nonhappy ${label}`);
  expect(transaction).toBeTruthy();
  const draft = await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: transaction.id });
  expect(draft?.id).toBeTruthy();
  return { transaction, draft };
};

const balancedDraft = ({ transaction, draft }, overrides = {}) => {
  const amount = Math.abs(Number(transaction.amount));
  const date = overrides.postingDate ?? transaction.date;
  const lineNonce = unique('line');
  return {
    ...draft,
    ...overrides,
    id: draft.id,
    tenantId: 'default',
    transactionId: transaction.id,
    workflowStatus: overrides.workflowStatus ?? 'approved',
    postingDate: date,
    documentDate: date,
    bookingText: overrides.bookingText ?? `E2E ${transaction.purpose}`,
    reference: transaction.id,
    period: date.slice(0, 7),
    fiscalYear: Number(date.slice(0, 4)),
    lines: overrides.lines ?? [
      {
        id: `line-${lineNonce}-expense`,
        accountNumber: postingAccounts.expense,
        debitAmount: amount,
        creditAmount: 0,
      },
      {
        id: `line-${lineNonce}-bank`,
        accountNumber: postingAccounts.bank,
        debitAmount: 0,
        creditAmount: amount,
      },
    ],
    validationIssues: [],
    updatedAt: new Date().toISOString(),
  };
};

const createIncomingInvoice = async (page, label, grossAmount = 119) => {
  const vendorId = unique(`vendor-${label}`);
  const invoiceId = unique(`incoming-${label}`);
  const now = new Date().toISOString();
  await invokeDesktopIpc(page, 'pro:upsertVendor', {
    vendor: { id: vendorId, tenantId: 'default', name: `E2E Vendor ${label}`, createdAt: now, updatedAt: now },
    reason: `E2E vendor ${label}`,
  });
  await invokeDesktopIpc(page, 'pro:upsertIncomingInvoice', {
    invoice: {
      id: invoiceId,
      tenantId: 'default',
      vendorId,
      number: `ER-${label}`,
      invoiceDate: '2026-04-10',
      dueDate: '2026-04-30',
      servicePeriod: '2026-04',
      netAmount: grossAmount - 19,
      taxAmount: 19,
      grossAmount,
      status: 'open',
      taxRate: 19,
      taxCaseKey: 'DE_STD_19',
      lines: [{
        id: unique(`incoming-line-${label}`),
        incomingInvoiceId: invoiceId,
        position: 0,
        description: `Hosting ${label}`,
        quantity: 1,
        unitPrice: grossAmount - 19,
        netAmount: grossAmount - 19,
        taxRate: 19,
        taxAmount: 19,
        taxCaseKey: 'DE_STD_19',
        grossAmount,
        accountNumber: postingAccounts.expense,
      }],
      accountingStatus: 'unposted',
      createdAt: now,
      updatedAt: now,
    },
    reason: `E2E incoming ${label}`,
  });
  const posted = await invokeDesktopIpc(page, 'pro:postIncomingInvoiceAccounting', { invoiceId, reason: `E2E post ${label}` });
  expect(posted.status).toBe('ready');
  const item = (await invokeDesktopIpc(page, 'pro:listOpenItems')).find((row) => row.sourceId === invoiceId);
  expect(item).toBeTruthy();
  return { invoiceId, vendorId, item };
};

const payment = ({ sourceId, partyType, partyId, amount, openItemId, allocationEventId = unique('allocation') }) => ({
  payment: {
    sourceType: 'manual',
    sourceId,
    partyType,
    partyId,
    paymentDate: '2026-04-20',
    amount,
    bankAccountNumber: postingAccounts.bank,
    method: 'E2E',
    allocations: [{ openItemId, amount: amount > 119 ? 119 : amount }],
    reason: `E2E allocation ${sourceId}`,
    allocationEventId,
  },
});

test.beforeEach(async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedDesktopData(desktop.page, { app: 'pro' });
  const policy = await invokeDesktopIpc(desktop.page, 'pro:getAccountingPolicy');
  const ledger = await invokeDesktopIpc(desktop.page, 'pro:listLedgerAccounts', { chart: policy.activeChart, limit: 3000, offset: 0 });
  postingAccounts = {
    chart: policy.activeChart,
    bank: ledger.find((row) => row.accountNumber === (policy.activeChart === 'SKR03' ? '1200' : '1800'))?.accountNumber ?? ledger.find((row) => row.accountNumber.startsWith('1'))?.accountNumber,
    expense: ledger.find((row) => row.accountNumber === '6000')?.accountNumber ?? ledger.find((row) => row.accountNumber.startsWith('6'))?.accountNumber ?? ledger.find((row) => !row.accountNumber.startsWith('1'))?.accountNumber,
  };
  expect(postingAccounts.bank).toBeTruthy();
  expect(postingAccounts.expense).toBeTruthy();
  postingAccounts.unmapped = ledger.find((row) => row.accountNumber.startsWith('9'))?.accountNumber
    ?? ledger.find((row) => row.accountNumber.startsWith('8') && row.accountNumber !== postingAccounts.expense)?.accountNumber
    ?? ledger.find((row) => row.accountNumber !== postingAccounts.bank && row.accountNumber !== postingAccounts.expense)?.accountNumber;
  expect(postingAccounts.unmapped).toBeTruthy();
  await invokeDesktopIpc(desktop.page, 'pro:upsertAccountingAccountMapping', { chart: policy.activeChart, role: 'accounts_payable', accountNumber: postingAccounts.expense });
  await invokeDesktopIpc(desktop.page, 'pro:upsertAccountingAccountMapping', { chart: policy.activeChart, role: 'input_vat', accountNumber: postingAccounts.expense });
  await invokeDesktopIpc(desktop.page, 'pro:upsertTaxCaseAccountMapping', { chart: policy.activeChart, taxCaseKey: 'DE_STD_19', role: 'input_tax', accountNumber: postingAccounts.expense, reason: 'E2E OPOS mapping' });
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('unbalanced draft remains unposted and keeps its blocking issue', async () => {
  const { page } = desktop;
    const before = await invokeDesktopIpc(page, 'pro:listJournalEntries', { limit: 500, offset: 0 });
    const source = await importPendingTransaction(page, 'unbalanced');
    const amount = Math.abs(Number(source.transaction.amount));
    const draft = balancedDraft(source, {
      lines: [
        { id: unique('unbalanced-debit'), accountNumber: postingAccounts.expense, debitAmount: amount, creditAmount: 0 },
        { id: unique('unbalanced-credit'), accountNumber: postingAccounts.bank, debitAmount: 0, creditAmount: amount - 1 },
      ],
    });
    const saved = await invokeDesktopIpc(page, 'pro:saveDraft', { draft });
    expect(saved.validationIssues.some((issue) => issue.code === 'UNBALANCED_ENTRY')).toBeTruthy();
    const posted = await invokeDesktopIpc(page, 'pro:postDraft', { draftId: saved.id, actorRole: 'accountant' });
    expect(posted.entry.id).toBe('');
    expect(posted.issues.some((issue) => issue.code === 'UNBALANCED_ENTRY' && issue.blocking)).toBeTruthy();
    const after = await invokeDesktopIpc(page, 'pro:listJournalEntries', { limit: 500, offset: 0 });
    expect(after).toHaveLength(before.length);
    expect((await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: source.transaction.id })).workflowStatus).toBe('incomplete');
});

test('invalid workflow transition is rejected without changing the draft', async () => {
  const { page } = desktop;
    const source = await importPendingTransaction(page, 'transition');
    await expectIpcError(
      invokeDesktopIpc(page, 'pro:dispatchDraftAction', { transactionId: source.transaction.id, action: 'approve' }),
      /Invalid workflow transition: (?:imported|incomplete) -> approved/,
    );
    expect(['imported', 'incomplete']).toContain((await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: source.transaction.id })).workflowStatus);
});

test('posting is source-idempotent and posted drafts are immutable', async () => {
  const { page } = desktop;
    const source = await importPendingTransaction(page, 'immutable');
    const saved = await invokeDesktopIpc(page, 'pro:saveDraft', { draft: balancedDraft(source) });
    const first = await invokeDesktopIpc(page, 'pro:postDraft', { draftId: saved.id, actorRole: 'accountant', idempotencyKey: unique('post') });
    expect(first.entry.id).toBeTruthy();
    const second = await invokeDesktopIpc(page, 'pro:postDraft', { draftId: saved.id, actorRole: 'accountant', idempotencyKey: unique('post-duplicate') });
    expect(second.entry.id).toBe(first.entry.id);
    const entries = await invokeDesktopIpc(page, 'pro:listJournalEntries', { limit: 500, offset: 0 });
    expect(entries.filter((entry) => entry.id === first.entry.id)).toHaveLength(1);
    await expectIpcError(
      invokeDesktopIpc(page, 'pro:saveDraft', { draft: { ...saved, bookingText: 'Illegally changed after posting' } }),
      /POSTED_DRAFT_IMMUTABLE/,
    );
    expect((await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: source.transaction.id })).bookingText).toBe(saved.bookingText);
});

test('duplicate reversal is typed-blocked and leaves one reversal', async () => {
  const { page } = desktop;
    const source = await importPendingTransaction(page, 'reverse');
    const saved = await invokeDesktopIpc(page, 'pro:saveDraft', { draft: balancedDraft(source) });
    const posted = await invokeDesktopIpc(page, 'pro:postDraft', { draftId: saved.id, actorRole: 'accountant' });
    const first = await invokeDesktopIpc(page, 'pro:reverseJournalEntry', { entryId: posted.entry.id, reason: 'E2E correction' });
    expect(first.ok).toBe(true);
    await expectIpcError(
      invokeDesktopIpc(page, 'pro:reverseJournalEntry', { entryId: posted.entry.id, reason: 'E2E duplicate correction' }),
      /cannot be reversed again/,
    );
    const entries = await invokeDesktopIpc(page, 'pro:listJournalEntries', { limit: 500, offset: 0 });
    expect(entries.filter((entry) => entry.id === posted.entry.id || entry.reversedEntryId === posted.entry.id)).toHaveLength(2);
});

test('OPOS rejects wrong party and preserves atomic residuals', async () => {
  const { page } = desktop;
    const first = await createIncomingInvoice(page, 'partial', 119);
    const second = await createIncomingInvoice(page, 'overpay', 119);
    await expectIpcError(
      invokeDesktopIpc(page, 'pro:allocateOpenItemPayment', payment({ sourceId: unique('wrong-party'), partyType: 'debtor', partyId: first.vendorId, amount: 50, openItemId: first.item.id })),
      /party|PARTY|creditor|mismatch/i,
    );
    let items = await invokeDesktopIpc(page, 'pro:listOpenItems');
    expect(items.find((item) => item.id === first.item.id).residualAmount).toBe(119);

    const partial = await invokeDesktopIpc(page, 'pro:allocateOpenItemPayment', payment({ sourceId: unique('partial-payment'), partyType: 'creditor', partyId: first.vendorId, amount: 50, openItemId: first.item.id }));
    expect(partial.allocatedAmount).toBe(50);
    let afterPartial = await invokeDesktopIpc(page, 'pro:listOpenItems');
    expect(afterPartial.find((item) => item.id === first.item.id).residualAmount).toBe(69);
    const overpaid = await invokeDesktopIpc(page, 'pro:allocateOpenItemPayment', payment({ sourceId: unique('overpaid-payment'), partyType: 'creditor', partyId: second.vendorId, amount: 150, openItemId: second.item.id }));
    expect(overpaid.residualAmount).toBe(31);
    expect(overpaid.status).toBe('overpaid');

    await expectIpcError(
      invokeDesktopIpc(page, 'pro:allocateOpenItemPayment', payment({ sourceId: unique('atomic-overallocation'), partyType: 'creditor', partyId: first.vendorId, amount: 200, openItemId: first.item.id })),
      /residual|allocated|exceed|overalloc/i,
    );
    items = await invokeDesktopIpc(page, 'pro:listOpenItems');
    expect(items.find((item) => item.id === first.item.id).residualAmount).toBe(69);
});

test('EU reverse-charge without evidence is blocked and UI makes no success claim', async () => {
  const { page, baseUrl } = desktop;
    const source = await importPendingTransaction(page, 'missing-evidence');
    const saved = await invokeDesktopIpc(page, 'pro:saveDraft', {
      draft: balancedDraft(source, {
        lines: [
          { id: unique('rc-expense'), accountNumber: postingAccounts.expense, debitAmount: 120, creditAmount: 0, taxCaseKey: 'EU_B2B_SERVICE_RC', taxCode: 'EU_B2B_SERVICE_RC', taxRate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 },
          { id: unique('rc-bank'), accountNumber: postingAccounts.bank, debitAmount: 0, creditAmount: 120 },
        ],
      }),
    });
    const check = await invokeDesktopIpc(page, 'pro:validateTaxCompliance', { draftId: saved.id });
    expect(check.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['MISSING_COUNTRY_CODE', 'MISSING_COUNTERPARTY_VAT_ID', 'MISSING_TAX_EVIDENCE']));
    const posted = await invokeDesktopIpc(page, 'pro:postDraft', { draftId: saved.id, actorRole: 'accountant' });
    expect(posted.entry.id).toBe('');
    expect(posted.issues.some((issue) => issue.blocking)).toBeTruthy();

    await page.goto(appUrl(baseUrl, '/accounting'));
    await expect(page.getByRole('heading', { name: 'Pro Buchhaltung' })).toBeVisible();
    const row = page.locator('tbody tr').filter({ hasText: source.transaction.counterparty }).first();
    await expect(row).toBeVisible();
    await row.click();
    const expand = page.getByRole('button', { name: 'Erweitern' });
    if (await expand.count()) await expand.click();
    await expect(page.getByText('Buchungssatz')).toBeVisible();
    await page.locator('select[id^="tax-case-"]').first().selectOption('EU_B2B_SERVICE_RC');
    await page.locator('input[id^="amount-"]').first().fill('121');
    await page.getByRole('button', { name: 'Speichern', exact: true }).click({ force: true });
    await expect(page.getByText('Blockiert', { exact: true })).toBeVisible();
    await expect(page.getByText(/Buchung erfolgreich|erfolgreich gebucht/i)).toHaveCount(0);
});

test('missing report mapping blocks the report and unsupported 2027 EÜR fails closed', async () => {
  const { page } = desktop;
    const source = await importPendingTransaction(page, 'unmapped-report');
    const saved = await invokeDesktopIpc(page, 'pro:saveDraft', { draft: balancedDraft(source, {
      lines: [
        { id: unique('unmapped'), accountNumber: postingAccounts.unmapped, debitAmount: 120, creditAmount: 0 },
        { id: unique('unmapped-bank'), accountNumber: postingAccounts.bank, debitAmount: 0, creditAmount: 120 },
      ],
    }) });
    const posted = await invokeDesktopIpc(page, 'pro:postDraft', { draftId: saved.id, actorRole: 'accountant' });
    expect(posted.entry.id).toBeTruthy();
    const report = await invokeDesktopIpc(page, 'pro:getGuvReport', { from: '2026-01-01', to: '2026-12-31' });
    expect(report.unmappedAccounts?.some((row) => row.accountNumber === postingAccounts.unmapped)).toBeTruthy();
    expect(report.blocking).toBe(true);
    await expectIpcError(invokeDesktopIpc(page, 'eur:getReport', { taxYear: 2027 }), /EUR_CATALOG_UNAVAILABLE|unavailable|2027/);
});

test('period soft-lock requires a runtime override reason before posting', async () => {
  const { page } = desktop;
  const assetAccount = (await invokeDesktopIpc(page, 'pro:listLedgerAccounts', {
    chart: postingAccounts.chart,
    limit: 3000,
    offset: 0,
  })).find((row) => row.accountNumber.startsWith('0'))?.accountNumber;
  expect(assetAccount).toBeTruthy();
  const assetId = unique('soft-lock-asset');
  const activated = await invokeDesktopIpc(page, 'pro:upsertAsset', {
    reason: 'E2E soft lock validation activation',
    asset: {
      id: assetId,
      assetNumber: unique('ANL'),
      name: 'Activated E2E soft-lock asset',
      assetClass: 'IT-Hardware',
      status: 'aktiv',
      activationDate: '2026-04-01',
      acquisitionCost: 1000,
      usefulLifeYears: 5,
      depreciationMethod: 'linear',
      costCenter: 'E2E',
      location: 'Berlin',
      receiptLinked: false,
      assetAccountNumber: assetAccount,
      acquisitionOffsetAccountNumber: postingAccounts.expense,
    },
  });
  expect(activated.status).toBe('aktiv');
  expect(activated.activationJournalEntryId).toBeTruthy();
  await expect(setProAccountingPeriodStatus(desktop, '2026-04')).resolves.toMatchObject({ period: '2026-04', status: 'soft_locked' });
  const depreciation = { assetId, year: 2026, postingDate: '2026-04-30', reason: 'E2E soft lock validation' };
  await expectIpcError(
    invokeDesktopIpc(page, 'pro:runDepreciation', depreciation),
    /SOFT_LOCK_OVERRIDE_REQUIRED/,
  );
  const overridden = await invokeDesktopIpc(page, 'pro:runDepreciation', { ...depreciation, softLockOverride: true, overrideReason: 'Owner approval' });
  expect(overridden.journalEntryId).toBeTruthy();
  expect(overridden.scheduleEntry).toMatchObject({ status: 'posted', journalEntryId: overridden.journalEntryId });
  expect((await invokeDesktopIpc(page, 'pro:listAssets')).find((asset) => asset.id === assetId)).toMatchObject({ id: assetId, status: 'aktiv' });
});

test('asset depreciation and disposal reject an unactivated asset', async () => {
  const { page } = desktop;
    const assetId = unique('asset');
    await invokeDesktopIpc(page, 'pro:upsertAsset', {
      reason: 'E2E invalid asset state',
      asset: {
        id: assetId,
        assetNumber: unique('ANL'),
        name: 'Unactivated E2E asset',
        assetClass: 'IT-Hardware',
        status: 'entwurf',
        activationDate: '2026-04-01',
        acquisitionCost: 1000,
        usefulLifeYears: 5,
        depreciationMethod: 'linear',
        costCenter: 'E2E',
        location: 'Berlin',
        receiptLinked: false,
        assetAccountNumber: '0440',
      },
    });
    await expectIpcError(invokeDesktopIpc(page, 'pro:runDepreciation', { assetId, year: 2026, postingDate: '2026-04-30', reason: 'E2E depreciation', actorRole: 'accountant' }), /active|aktiv|asset|schedule/i);
    await expectIpcError(invokeDesktopIpc(page, 'pro:disposeAsset', { assetId, disposalDate: '2026-04-30', proceeds: 10, reason: 'E2E disposal', actorRole: 'accountant' }), /active|aktiv|asset/i);
    const unchanged = (await invokeDesktopIpc(page, 'pro:listAssets')).find((asset) => asset.id === assetId);
    expect(unchanged?.status).toBe('entwurf');
});
