import { expect, test } from '@playwright/test';
import { writeFile, unlink } from 'node:fs/promises';
import { appUrl, approveProDraft, invokeDesktopIpc, launchDesktopApp, seedDesktopData, setProAccountingPeriodStatus } from '../support.mjs';

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
    // The server owns the workflow: drafts are saved as suggested and walked on with approveProDraft.
    workflowStatus: overrides.workflowStatus ?? 'suggested',
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
  // Seeding writes past react-query and the onboarding gate; reload so the shell reads the seeded settings.
  await desktop.page.reload();
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
    await page.goto(appUrl(desktop.baseUrl, '/accounting?view=inbox'));
    await expect(page.getByRole('button', { name: /^Unvollständig [1-9]/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Gebucht 0' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('01-unbalanced-stays-incomplete.png'), fullPage: true });
});

test('invalid workflow transition is rejected without changing the draft', async () => {
  const { page } = desktop;
    const source = await importPendingTransaction(page, 'transition');
    await expectIpcError(
      invokeDesktopIpc(page, 'pro:dispatchDraftAction', { transactionId: source.transaction.id, action: 'approve' }),
      /Invalid workflow transition: (?:imported|incomplete) -> approved/,
    );
    expect(['imported', 'incomplete']).toContain((await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: source.transaction.id })).workflowStatus);
    await page.goto(appUrl(desktop.baseUrl, '/accounting?view=inbox'));
    await expect(page.getByRole('button', { name: 'Freigegeben 0' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('01-no-transition.png'), fullPage: true });
});

test('posting is source-idempotent and posted drafts are immutable', async () => {
  const { page } = desktop;
    const source = await importPendingTransaction(page, 'immutable');
    const saved = await approveProDraft(page, balancedDraft(source));
    const key = unique('post');
    const first = await invokeDesktopIpc(page, 'pro:postDraft', { draftId: saved.id, actorRole: 'accountant', idempotencyKey: key });
    expect(first.entry.id).toBeTruthy();
    // The same key is a replay: it answers with the entry that was booked.
    const replay = await invokeDesktopIpc(page, 'pro:postDraft', { draftId: saved.id, actorRole: 'accountant', idempotencyKey: key });
    expect(replay.entry.id).toBe(first.entry.id);
    // Another key on an already posted draft is refused instead of booking it a second time.
    const journalBeforeRefusal = await invokeDesktopIpc(page, 'pro:listJournalEntries', { limit: 500, offset: 0 });
    await expectIpcError(
      invokeDesktopIpc(page, 'pro:postDraft', { draftId: saved.id, actorRole: 'accountant', idempotencyKey: unique('post-other') }),
      /PAYMENT_SOURCE_ALREADY_BOOKED/,
    );
    const entries = await invokeDesktopIpc(page, 'pro:listJournalEntries', { limit: 500, offset: 0 });
    expect(entries).toEqual(journalBeforeRefusal);
    expect(entries.filter((entry) => entry.sourceDraftId === saved.id)).toHaveLength(1);
    await page.goto(appUrl(desktop.baseUrl, '/accounting?view=inbox'));
    await expect(page.getByRole('button', { name: 'Gebucht 1' })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('01-posted-once.png'), fullPage: true });
    await expectIpcError(
      invokeDesktopIpc(page, 'pro:saveDraft', { draft: { ...saved, workflowStatus: 'suggested', bookingText: 'Illegally changed after posting' } }),
      /POSTED_DRAFT_IMMUTABLE|immutable|posted/i,
    );
    expect((await invokeDesktopIpc(page, 'pro:getDraftByTransactionId', { transactionId: source.transaction.id })).bookingText).toBe(saved.bookingText);
});

test('duplicate reversal is typed-blocked and leaves one reversal', async () => {
  const { page } = desktop;
    const source = await importPendingTransaction(page, 'reverse');
    const saved = await approveProDraft(page, balancedDraft(source));
    const posted = await invokeDesktopIpc(page, 'pro:postDraft', { draftId: saved.id, actorRole: 'accountant' });
    const first = await invokeDesktopIpc(page, 'pro:reverseJournalEntry', { entryId: posted.entry.id, reason: 'E2E correction' });
    expect(first.ok).toBe(true);
    await expectIpcError(
      invokeDesktopIpc(page, 'pro:reverseJournalEntry', { entryId: posted.entry.id, reason: 'E2E duplicate correction' }),
      /cannot be reversed again/,
    );
    const entries = await invokeDesktopIpc(page, 'pro:listJournalEntries', { limit: 500, offset: 0 });
    // The original points at its reversal; there is exactly one reversal entry for it.
    expect(entries.find((entry) => entry.id === posted.entry.id)).toMatchObject({ status: 'reversed', reversedEntryId: first.reversalEntryId });
    expect(entries.filter((entry) => entry.sourceKey === `reversal:${posted.entry.id}`)).toHaveLength(1);
    await page.goto(appUrl(desktop.baseUrl, '/accounting?view=inbox'));
    await expect(page.getByRole('heading', { name: 'Buchungs-Inbox', level: 2 })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('01-after-reversal.png'), fullPage: true });
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
    // An overpayment settles the item; the surplus stays on the payment (partially allocated), see the OPOS integration tests.
    expect(overpaid.status).toBe('partially_allocated');

    await expectIpcError(
      invokeDesktopIpc(page, 'pro:allocateOpenItemPayment', payment({ sourceId: unique('atomic-overallocation'), partyType: 'creditor', partyId: first.vendorId, amount: 200, openItemId: first.item.id })),
      /residual|allocated|exceed|overalloc/i,
    );
    items = await invokeDesktopIpc(page, 'pro:listOpenItems');
    expect(items.find((item) => item.id === first.item.id).residualAmount).toBe(69);
    await page.goto(appUrl(desktop.baseUrl, '/accounting?view=opos'));
    await expect(page.getByRole('table', { name: 'Verbindlichkeiten' }).getByRole('row', { name: /^ER-partial .* 69,00 € Teilweise bezahlt/ })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('01-opos-residuals.png'), fullPage: true });
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
    expect(check.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['MISSING_TAX_COUNTRY', 'MISSING_COUNTERPARTY_VAT_ID', 'MISSING_TAX_EVIDENCE']));
    const posted = await invokeDesktopIpc(page, 'pro:postDraft', { draftId: saved.id, actorRole: 'accountant' });
    expect(posted.entry.id).toBe('');
    expect(posted.issues.some((issue) => issue.blocking)).toBeTruthy();

    await page.goto(appUrl(baseUrl, '/accounting?view=inbox'));
    await page.getByRole('button', { name: `${source.transaction.counterparty} öffnen` }).click();
    await page.getByRole('button', { name: 'Erweitern' }).click();
    await expect(page.getByRole('heading', { name: 'Buchung erfassen' })).toBeVisible();
    await page.getByRole('combobox', { name: 'Steuerfall' }).first().selectOption('EU_B2B_SERVICE_RC');
    await page.getByRole('spinbutton', { name: 'Betrag' }).first().fill('121');
    await page.getByRole('button', { name: 'Speichern', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Entwurf gespeichert' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /Zur Prüfung geben gesperrt/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Fehler [1-9]/ })).toBeVisible();
    await expect(page.getByText(/Buchung erfolgreich|erfolgreich gebucht/i)).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath('01-reverse-charge-blocked.png'), fullPage: true });
});

test('missing report mapping blocks the report and unsupported 2027 EÜR fails closed', async () => {
  const { page, baseUrl } = desktop;
    const source = await importPendingTransaction(page, 'unmapped-report');
    const saved = await approveProDraft(page, balancedDraft(source, {
      lines: [
        { id: unique('unmapped'), accountNumber: postingAccounts.expense, debitAmount: 120, creditAmount: 0 },
        { id: unique('unmapped-bank'), accountNumber: postingAccounts.bank, debitAmount: 0, creditAmount: 120 },
      ],
    }));
    const posted = await invokeDesktopIpc(page, 'pro:postDraft', { draftId: saved.id, actorRole: 'accountant' });
    expect(posted.entry.id).toBeTruthy();
    // EÜR income reports require expense mappings and exclude balance-sheet accounts.
    const report = await invokeDesktopIpc(page, 'pro:getReportingReport', { kind: 'management-guv', from: '2026-01-01', to: '2026-12-31' });
    expect(report.mappingHealth.blocking).toBe(true);
    expect(report.mappingHealth.unmappedAccounts).toContain(postingAccounts.expense);
    expect(report.mappingHealth.unmappedAccounts).not.toContain(postingAccounts.bank);
    expect(report.rows).toEqual([]);
    const health = await invokeDesktopIpc(page, 'pro:getReportMappingHealth', { chart: postingAccounts.chart, statement: 'management-guv', asOfDate: '2026-12-31' });
    expect(health.unmapped.map((row) => row.accountNumber)).toContain(postingAccounts.expense);
    expect(health.unmapped.map((row) => row.accountNumber)).not.toContain(postingAccounts.bank);
    await expectIpcError(invokeDesktopIpc(page, 'eur:getReport', { taxYear: 2027 }), /EUR_CATALOG_UNAVAILABLE|Unsupported EÜR year|unavailable|2027/);

    await page.goto(appUrl(baseUrl, '/accounting?view=reports'));
    await page.getByRole('group', { name: 'Bericht' }).getByRole('button', { name: 'Management-GuV', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Auswertung blockiert: Konten-Mapping unvollständig' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'PDF' })).toBeDisabled();
    await page.screenshot({ path: test.info().outputPath('01-report-blocked.png'), fullPage: true });
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
  // No route soft-locks a period: setProAccountingPeriodStatus restarts the app around the period row, so read desktop.page afterwards.
  await expect(setProAccountingPeriodStatus(desktop, '2026-12')).resolves.toMatchObject({ period: '2026-12', status: 'soft_locked' });
  const { page: restartedPage } = desktop;
  const depreciation = { assetId, year: 2026, postingDate: '2026-12-31', reason: 'E2E soft lock validation' };
  await expectIpcError(
    invokeDesktopIpc(restartedPage, 'pro:runDepreciation', depreciation),
    /SOFT_LOCK_OVERRIDE_REQUIRED/,
  );
  const overridden = await invokeDesktopIpc(restartedPage, 'pro:runDepreciation', { ...depreciation, softLockOverride: true, overrideReason: 'Owner approval' });
  expect(overridden.journalEntryId).toBeTruthy();
  expect(overridden.scheduleEntry).toMatchObject({ status: 'posted', journalEntryId: overridden.journalEntryId });
  expect((await invokeDesktopIpc(restartedPage, 'pro:listAssets')).find((asset) => asset.id === assetId)).toMatchObject({ id: assetId, status: 'aktiv' });
  await restartedPage.goto(appUrl(desktop.baseUrl, '/accounting?view=assets'));
  await expect(restartedPage.getByRole('heading', { name: 'Anlagen', level: 1 })).toBeVisible();
  await restartedPage.screenshot({ path: test.info().outputPath('01-assets-after-override.png'), fullPage: true });
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
    await page.goto(appUrl(desktop.baseUrl, '/accounting?view=assets'));
    await expect(page.getByRole('heading', { name: 'Anlagen', level: 1 })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath('01-assets-unchanged.png'), fullPage: true });
});
