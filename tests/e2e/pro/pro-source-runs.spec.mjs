import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
import { appUrl, invokeDesktopIpc, launchDesktopApp, seedDesktopData, setProAccountingPeriodStatus } from '../support.mjs';

let desktop;
let sequence = 0;

const unique = (prefix) => `${prefix}-${process.pid}-${Date.now()}-${sequence++}`;

const stableJson = (value) => {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).filter((key) => value[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
};

const snapshotHash = (snapshot) => createHash('sha256').update(stableJson(snapshot)).digest('hex');

const sourceFact = ({ sourceType = 'standalone_source', sourceId = unique('source'), sourceRevision = 'r1', lines, date = '2026-04-15' } = {}) => ({
  sourceType,
  sourceId,
  sourceRevision,
  effectiveDate: date,
  postingDate: date,
  period: date.slice(0, 7),
  fiscalYear: Number(date.slice(0, 4)),
  currency: 'EUR',
  bookingText: `E2E ${sourceId}`,
  lines,
});

const pickPostingAccounts = async (page) => {
  const policy = await invokeDesktopIpc(page, 'pro:getAccountingPolicy');
  const ledger = await invokeDesktopIpc(page, 'pro:listLedgerAccounts', { chart: policy.activeChart, limit: 3000, offset: 0 });
  const pick = (predicate, fallback) => ledger.find((row) => predicate(row))?.accountNumber ?? ledger.find((row) => row.accountNumber === fallback)?.accountNumber;
  const describe = (row) => `${row.name} ${(row.keywords ?? []).join(' ')}`;
  const bank = pick((row) => row.accountNumber === (policy.activeChart === 'SKR03' ? '1200' : '1800') || /\bbank\b/i.test(describe(row)), '1200');
  const revenue = pick((row) => row.accountNumber === (policy.activeChart === 'SKR03' ? '8400' : '4400') || (row.accountNumber.startsWith('8') && /erlöse|erträge/i.test(describe(row))), policy.activeChart === 'SKR03' ? '8400' : '4400');
  const expense = pick((row) => row.accountNumber === '6000' || row.accountNumber === '4900', policy.activeChart === 'SKR03' ? '4900' : '6300');
  const retained = pick((row) => row.accountNumber === '9000' || row.accountNumber === '0860', '9000');
  const inventory = pick((row) => row.accountNumber.startsWith('0'), policy.activeChart === 'SKR03' ? '0480' : '0200');
  const provision = pick((row) => row.accountNumber.startsWith('3') || row.accountNumber.startsWith('4'), expense);
  const gain = pick((row) => row.accountNumber.startsWith('8'), revenue);
  const loss = pick((row) => row.accountNumber.startsWith('6'), expense);
  for (const [name, value] of Object.entries({ bank, revenue, expense, retained, inventory, provision, gain, loss })) expect(value, name).toBeTruthy();
  return { chart: policy.activeChart, bank, revenue, expense, retained, inventory, provision, gain, loss };
};

const journalLines = (accounts, amount = 100) => [
  { accountNumber: accounts.expense, debitAmount: amount, creditAmount: 0 },
  { accountNumber: accounts.bank, debitAmount: 0, creditAmount: amount },
];

const seedClosingBalances = async (page, accounts, asOfDate) => {
  await invokeDesktopIpc(page, 'pro:postAccountingSource', {
    source: sourceFact({ sourceId: unique('closing-ledger'), date: '2026-04-01', lines: [
      { accountNumber: accounts.bank, debitAmount: 100, creditAmount: 0 },
      { accountNumber: accounts.revenue, debitAmount: 0, creditAmount: 100 },
      { accountNumber: accounts.expense, debitAmount: 50, creditAmount: 0 },
      { accountNumber: accounts.bank, debitAmount: 0, creditAmount: 50 },
    ] }),
    chart: accounts.chart,
    reason: 'E2E real balances before closing',
  });
  return (await invokeDesktopIpc(page, 'pro:getLedgerBalances', { asOfDate }))
    .filter((row) => [accounts.revenue, accounts.expense].includes(row.accountNumber));
};

const sourceJournalIds = async (page) => (await invokeDesktopIpc(page, 'pro:listAccountingSourceRuns'))
  .map((run) => run.journalEntryId)
  .filter(Boolean);

const accountingStateIds = async (page) => ({
  sourceRuns: (await invokeDesktopIpc(page, 'pro:listAccountingSourceRuns')).map((run) => run.id).sort(),
  journalEntries: (await invokeDesktopIpc(page, 'pro:listJournalEntries', { limit: 500, offset: 0 })).map((entry) => entry.id).sort(),
});

test.beforeEach(async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedDesktopData(desktop.page, { app: 'pro' });
  // Seeding writes past react-query and the onboarding gate; reload so the shell reads the seeded settings.
  await desktop.page.reload();
  await desktop.page.goto(appUrl(desktop.baseUrl, '/accounting?view=special'));
  await expect(desktop.page.getByRole('heading', { name: 'Sonderbuchungen & Abschluss', level: 2 })).toBeVisible();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

// The posting asks once with a summary (B10); the booking only runs after "Verbindlich buchen".
const confirmPost = async (page) => {
  const dialog = page.getByRole('dialog').filter({ has: page.getByTestId('special-entry-confirm-summary') });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Verbindlich buchen' }).click();
  await expect(dialog).toHaveCount(0);
};

test('posts, replays, and conflict-blocks one immutable source revision', async () => {
  const { page } = desktop;
  const accounts = await pickPostingAccounts(page);
  const source = sourceFact({ sourceId: unique('replay'), lines: journalLines(accounts) });

  const first = await invokeDesktopIpc(page, 'pro:postAccountingSource', { source, chart: accounts.chart, reason: 'E2E source posting' });
  expect(first).toMatchObject({ status: 'posted', sourceRun: { status: 'posted', sourceId: source.sourceId, sourceRevision: 'r1' } });
  expect(first.sourceRun.journalEntryId).toBeTruthy();

  const replay = await invokeDesktopIpc(page, 'pro:postAccountingSource', { source, chart: accounts.chart, reason: 'E2E source replay' });
  expect(replay).toMatchObject({ status: 'duplicate', sourceRun: { id: first.sourceRun.id } });

  // Other lines under the same source revision are a conflict, answered as a typed error; nothing is booked.
  await expect(invokeDesktopIpc(page, 'pro:postAccountingSource', {
    source: { ...source, lines: journalLines(accounts, 90) },
    chart: accounts.chart,
    reason: 'E2E source conflict',
  })).rejects.toThrow(/ACCOUNTING_SOURCE_RUN_CONFLICT/);
  expect((await sourceJournalIds(page)).filter((id) => id === first.sourceRun.journalEntryId)).toHaveLength(1);
  expect((await invokeDesktopIpc(page, 'pro:getAccountingSourceRun', { id: first.sourceRun.id })).fact.sourceId).toBe(source.sourceId);

  await page.reload();
  await expect(page.locator('section[aria-labelledby="source-run-history-heading"] li').filter({ hasText: source.sourceId })).toContainText('Gebucht');
  await page.screenshot({ path: test.info().outputPath('01-source-run-history.png'), fullPage: true });
});

test('posts a Sonderbuchung through the browser and opens inline journal details', async () => {
  const { page } = desktop;
  const accounts = await pickPostingAccounts(page);
  const sourceId = unique('ui-source');


  await expect(page.getByRole('status').filter({ hasText: 'Audit-Grund ist erforderlich.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prüfen & verbindlich buchen' })).toBeDisabled();
  await page.screenshot({ path: test.info().outputPath('01-sonderbuchung-incomplete.png'), fullPage: true });

  await page.getByRole('textbox', { name: 'Quellbeleg' }).fill(sourceId);
  await page.getByRole('textbox', { name: 'Buchungsdatum' }).fill('2026-04-15');
  // The year-end close has its own panel (FiscalYearClosePanel) and is covered through IPC below; the form books a Rückstellung.
  await page.getByRole('combobox', { name: 'Workflow' }).selectOption('provision');
  await page.getByText('Fachdaten für Experten bearbeiten').click();
  const factsField = page.getByRole('textbox', { name: 'Domain-Fakten (JSON)' });
  const facts = JSON.parse(await factsField.inputValue());
  expect(facts.effectiveDate).toBe('2026-04-15');
  await factsField.fill(JSON.stringify({
    ...facts,
    previousAmount: 0,
    targetAmount: 100,
    expenseAccount: accounts.expense,
    provisionAccount: accounts.provision,
  }, null, 2));
  await page.getByRole('textbox', { name: 'Audit-Grund', exact: true }).fill('E2E browser source posting');
  await page.getByRole('button', { name: 'Prüfen & verbindlich buchen' }).click();
  await confirmPost(page);

  await expect(page.getByText('Sonderbuchung wurde erfolgreich gebucht.')).toBeVisible();
  const historyRow = page.locator('section[aria-labelledby="source-run-history-heading"] li').filter({ hasText: sourceId });
  await expect(historyRow).toContainText('Gebucht');
  const journalButton = historyRow.getByRole('button', { name: 'Journal öffnen' });
  await expect(journalButton).toBeVisible();
  await journalButton.click();
  const journalDialog = page.getByRole('dialog', { name: 'Journalbuchung' });
  await expect(journalDialog).toBeVisible();
  await expect(journalDialog.getByRole('heading', { name: /Journal \d+/ })).toBeVisible();
  await expect(journalDialog.getByText(`Konto ${accounts.expense}`)).toBeVisible();
  await expect(journalDialog.getByText(`Konto ${accounts.provision}`)).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('02-journal-detail.png'), fullPage: true });
});

test('does not claim success for a noop or source-run conflict in the browser', async () => {
  const { page } = desktop;
  const accounts = await pickPostingAccounts(page);

  await page.getByRole('combobox', { name: 'Workflow' }).selectOption('provision');
  const noopId = unique('ui-noop');
  await page.getByRole('textbox', { name: 'Quellbeleg' }).fill(noopId);
  await page.getByRole('textbox', { name: 'Audit-Grund', exact: true }).fill('E2E noop must not book');
  await page.getByText('Fachdaten für Experten bearbeiten').click();
  const factsField = page.getByRole('textbox', { name: 'Domain-Fakten (JSON)' });
  const noopFacts = JSON.parse(await factsField.inputValue());
  await factsField.fill(JSON.stringify({ ...noopFacts, expenseAccount: accounts.expense, provisionAccount: accounts.provision, previousAmount: 25, targetAmount: 25 }, null, 2));
  await page.getByRole('button', { name: 'Prüfen & verbindlich buchen' }).click();
  await confirmPost(page);
  await expect(page.getByRole('alert')).toContainText('Keine Buchung vorgenommen');
  await expect(page.getByText('Sonderbuchung wurde erfolgreich gebucht.')).toHaveCount(0);

  const conflictId = unique('ui-conflict');
  const conflictDate = '2026-04-15';
  const conflictSource = sourceFact({ sourceType: 'provision', sourceId: conflictId, date: conflictDate, lines: journalLines(accounts) });
  conflictSource.sourceRevision = '1';
  const first = await invokeDesktopIpc(page, 'pro:postAccountingCommand', {
    kind: 'standalone',
    source: conflictSource,
    chart: accounts.chart,
    reason: 'E2E conflict seed',
  });
  expect(first.status).toBe('posted');

  await page.getByRole('combobox', { name: 'Workflow' }).selectOption('provision');
  await page.getByRole('textbox', { name: 'Quellbeleg' }).fill(conflictId);
  await page.getByRole('textbox', { name: 'Buchungsdatum' }).fill(conflictDate);
  const conflictFactsField = page.getByRole('textbox', { name: 'Domain-Fakten (JSON)' });
  const changedFacts = JSON.parse(await conflictFactsField.inputValue());
  await conflictFactsField.fill(JSON.stringify({ ...changedFacts, expenseAccount: accounts.expense, provisionAccount: accounts.provision, previousAmount: 0, targetAmount: 11 }, null, 2));
  await page.getByRole('textbox', { name: 'Audit-Grund', exact: true }).fill('E2E conflict must not book');
  await page.getByRole('button', { name: 'Prüfen & verbindlich buchen' }).click();
  await confirmPost(page);
  await expect(page.getByRole('alert')).toContainText(/Source revision already exists|Konflikt beim Quelllauf|schon einen Buchungslauf mit anderen Angaben/);
  await expect(page.getByText('Sonderbuchung wurde erfolgreich gebucht.')).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath('01-conflict-not-reported-as-success.png'), fullPage: true });
});

// A schedule is one source run; it books one journal entry per period (sourceKey carries the source id and the schedule position).
const entriesOfSource = async (page, sourceType, sourceId) =>
  (await invokeDesktopIpc(page, 'pro:listJournalEntries', { limit: 500, offset: 0 }))
    .filter((entry) => entry.sourceType === sourceType && entry.sourceKey?.includes(`${sourceId.length}:${sourceId}`))
    .sort((a, b) => a.postingDate.localeCompare(b.postingDate));

test('persists unique journal entries for multi-period accrual and loan schedules on replay', async () => {
  const { page } = desktop;
  const accounts = await pickPostingAccounts(page);
  const accrualId = unique('accrual-schedule');
  const accrual = {
    sourceId: accrualId,
    sourceRevision: 'r1',
    startDate: '2026-01-15',
    endDate: '2026-03-15',
    period: '2026-01',
    fiscalYear: 2026,
    currency: 'EUR',
    totalAmount: 300,
    expenseAccount: accounts.expense,
    deferralAccount: accounts.provision,
  };
  const postAccrual = (reason) => invokeDesktopIpc(page, 'pro:postAccountingCommand', {
    kind: 'accrual',
    source: sourceFact({ sourceType: 'accrual', sourceId: accrualId, date: accrual.startDate, lines: journalLines(accounts) }),
    domainFacts: accrual,
    chart: accounts.chart,
    reason,
  });
  const firstAccrual = await postAccrual('E2E multi-period accrual');
  expect(firstAccrual.status).toBe('posted');
  const accrualRuns = (await invokeDesktopIpc(page, 'pro:listAccountingSourceRuns')).filter((run) => run.sourceType === 'accrual' && run.sourceId === accrualId);
  expect(accrualRuns).toHaveLength(1);
  const accrualEntries = await entriesOfSource(page, 'accrual', accrualId);
  expect(accrualEntries).toHaveLength(3);
  expect(new Set(accrualEntries.map((entry) => entry.id)).size).toBe(3);
  expect(accrualEntries.map((entry) => entry.postingDate)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
  // 300 € over three months: one third per month, expense on the debit side, deferral on the credit side.
  for (const entry of accrualEntries) {
    expect(entry.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount])).toEqual([[accounts.expense, 100, 0], [accounts.provision, 0, 100]]);
  }
  expect(accrualRuns[0].journalEntryId).toBe(accrualEntries[0].id);
  const replayAccrual = await postAccrual('E2E multi-period accrual replay');
  expect(replayAccrual.status).toBe('duplicate');
  expect((await invokeDesktopIpc(page, 'pro:listAccountingSourceRuns')).filter((run) => run.sourceType === 'accrual' && run.sourceId === accrualId)).toHaveLength(1);
  expect((await entriesOfSource(page, 'accrual', accrualId)).map((entry) => entry.id)).toEqual(accrualEntries.map((entry) => entry.id));

  const loanId = unique('loan-schedule');
  const loan = {
    sourceId: loanId,
    sourceRevision: 'r1',
    startDate: '2026-01-01',
    period: '2026-01',
    fiscalYear: 2026,
    currency: 'EUR',
    principal: 300,
    annualInterestRate: 0,
    termMonths: 3,
    liabilityAccount: accounts.provision,
    interestAccount: accounts.expense,
    cashAccount: accounts.bank,
  };
  const postLoan = (reason) => invokeDesktopIpc(page, 'pro:postAccountingCommand', {
    kind: 'loan_schedule',
    source: sourceFact({ sourceType: 'loan_schedule', sourceId: loanId, date: loan.startDate, lines: journalLines(accounts) }),
    domainFacts: loan,
    chart: accounts.chart,
    reason,
  });
  const firstLoan = await postLoan('E2E multi-period loan');
  expect(firstLoan.status).toBe('posted');
  const loanRuns = (await invokeDesktopIpc(page, 'pro:listAccountingSourceRuns')).filter((run) => run.sourceType === 'loan_schedule' && run.sourceId === loanId);
  expect(loanRuns).toHaveLength(1);
  const loanEntries = await entriesOfSource(page, 'loan_schedule', loanId);
  expect(loanEntries).toHaveLength(3);
  expect(new Set(loanEntries.map((entry) => entry.id)).size).toBe(3);
  const replayLoan = await postLoan('E2E multi-period loan replay');
  expect(replayLoan.status).toBe('duplicate');
  expect((await invokeDesktopIpc(page, 'pro:listAccountingSourceRuns')).filter((run) => run.sourceType === 'loan_schedule' && run.sourceId === loanId)).toHaveLength(1);
  expect((await entriesOfSource(page, 'loan_schedule', loanId)).map((entry) => entry.id)).toEqual(loanEntries.map((entry) => entry.id));

  // The schedule is visible as the last booking runs in the browser.
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Letzte Buchungsläufe' })).toBeVisible();
  await expect(page.locator('section[aria-labelledby="source-run-history-heading"] li').filter({ hasText: accrualId })).toContainText('Gebucht');
  await page.screenshot({ path: test.info().outputPath('01-schedules-in-history.png'), fullPage: true });
});

test('keeps the Pro accounting workspace within a 390px viewport', async () => {
  const { page } = desktop;
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sonderbuchungen & Abschluss', level: 2 })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth || document.body.scrollWidth > document.body.clientWidth);
  expect(overflow).toBe(false);
  await page.screenshot({ path: test.info().outputPath('01-390px.png'), fullPage: true });
});

test('keeps invalid account, zero amount, and closed-period postings atomic', async () => {
  const accounts = await pickPostingAccounts(desktop.page);
  const before = await sourceJournalIds(desktop.page);
  // Refusals are typed errors; none of them leaves a run or an entry behind.
  await expect(invokeDesktopIpc(desktop.page, 'pro:postAccountingSource', {
    source: sourceFact({ sourceId: unique('invalid'), lines: [
      { accountNumber: '999999', debitAmount: 100, creditAmount: 0 },
      { accountNumber: accounts.bank, debitAmount: 0, creditAmount: 100 },
    ] }),
    chart: accounts.chart,
    reason: 'E2E invalid source',
  })).rejects.toThrow(/UNKNOWN_ACCOUNT:999999/);
  expect(await sourceJournalIds(desktop.page)).toEqual(before);

  await expect(invokeDesktopIpc(desktop.page, 'pro:postAccountingSource', {
    source: sourceFact({ sourceId: unique('zero-lines'), lines: [
      { accountNumber: '999999', debitAmount: 0, creditAmount: 0 },
      { accountNumber: accounts.bank, debitAmount: 0, creditAmount: 0 },
    ] }),
    chart: accounts.chart,
    reason: 'E2E zero source',
  })).rejects.toThrow(/journal line|Debit and credit/i);
  expect(await sourceJournalIds(desktop.page)).toEqual(before);

  const wrongPeriod = sourceFact({ sourceId: unique('wrong-period'), lines: journalLines(accounts) });
  await expect(invokeDesktopIpc(desktop.page, 'pro:postAccountingSource', {
    source: { ...wrongPeriod, period: '2026-05' },
    chart: accounts.chart,
    reason: 'E2E period does not contain the posting date',
  })).rejects.toThrow(/PERIOD_MISMATCH/);
  expect(await sourceJournalIds(desktop.page)).toEqual(before);

  // A closed period is not a route: the app is restarted around the period row (see setProAccountingPeriodStatus).
  const lockedSource = sourceFact({ sourceId: unique('closed'), lines: journalLines(accounts) });
  await expect(setProAccountingPeriodStatus(desktop, lockedSource.period, 'closed')).resolves.toMatchObject({ status: 'closed' });
  const { page } = desktop;
  await expect(invokeDesktopIpc(page, 'pro:postAccountingSource', { source: lockedSource, chart: accounts.chart, reason: 'E2E closed period' })).rejects.toThrow(/POSTING_DATE_IN_CLOSED_PERIOD/);
  expect(await sourceJournalIds(page)).toEqual(before);
  await page.goto(appUrl(desktop.baseUrl, '/accounting?view=special'));
  await expect(page.getByRole('heading', { name: 'Sonderbuchungen & Abschluss', level: 2 })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('01-after-refusals.png'), fullPage: true });
});

// The incoming invoice a correction or settlement refers to, booked with the default mappings.
const postOriginalIncomingInvoice = async (page, accounts) => {
  const vendorId = unique('correction-vendor');
  const originalId = unique('correction-original');
  const timestamp = new Date().toISOString();
  await invokeDesktopIpc(page, 'pro:upsertVendor', {
    reason: 'E2E correction original',
    vendor: { id: vendorId, tenantId: 'default', vendorNumber: unique('vendor-number'), name: 'E2E Correction Vendor', email: 'correction-vendor@example.test', createdAt: timestamp, updatedAt: timestamp },
  });
  await invokeDesktopIpc(page, 'pro:upsertIncomingInvoice', {
    reason: 'E2E correction original',
    invoice: {
      id: originalId, tenantId: 'default', vendorId, number: unique('ER-correction'), invoiceDate: '2026-04-01', dueDate: '2026-04-30', servicePeriod: '2026-04',
      netAmount: 100, taxAmount: 19, grossAmount: 119, taxRate: 19, status: 'open', accountingStatus: 'unposted', createdAt: timestamp, updatedAt: timestamp,
      lines: [{ id: unique('correction-original-line'), incomingInvoiceId: originalId, position: 0, description: 'E2E correction original', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 19, taxAmount: 19, grossAmount: 119, accountNumber: accounts.expense }],
    },
  });
  const posting = await invokeDesktopIpc(page, 'pro:postIncomingInvoiceAccounting', { invoiceId: originalId, reason: 'E2E correction original posting' });
  expect(posting).toMatchObject({ status: 'ready', snapshot: { sourceId: originalId } });
  const original = (await invokeDesktopIpc(page, 'pro:listIncomingInvoices')).find((invoice) => invoice.id === originalId);
  expect(original?.accountingSnapshot).toBeTruthy();
  const snapshotHashOfOriginal = snapshotHash(original.accountingSnapshot);
  const correctionSource = sourceFact({ sourceType: 'standalone_source', sourceId: unique('correction'), lines: journalLines(accounts, 11.9) });
  const correctionFacts = {
    id: unique('linked-correction'),
    idempotencyKey: unique('correction-key'),
    correctionDate: '2026-04-15',
    documentType: 'incoming_invoice',
    original: {
      documentId: original.id,
      documentNumber: original.number,
      revision: original.accountingSnapshot.sourceVersion,
      snapshotHash: snapshotHashOfOriginal,
      currentSnapshotHash: snapshotHashOfOriginal,
      taxEffectiveDate: original.invoiceDate,
      taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }],
    },
    deltas: [{ rate: 19, grossAmount: 11.9 }],
  };
  return { original, correctionSource, correctionFacts };
};

test('rejects a settlement or a correction against a missing original without booking anything', async () => {
  const { page } = desktop;
  const accounts = await pickPostingAccounts(page);
  const { correctionSource, correctionFacts } = await postOriginalIncomingInvoice(page, accounts);

  const beforeMissingSettlement = await accountingStateIds(page);
  await expect(invokeDesktopIpc(page, 'pro:postAccountingCommand', {
    kind: 'bad_debt',
    source: sourceFact({ sourceType: 'standalone_source', sourceId: unique('missing-settlement'), lines: journalLines(accounts) }),
    domainFacts: {
      taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }],
      writeOffGrossAmount: 119,
      badDebtExpenseAccount: accounts.expense,
      facts: { legalBasis: '§17 UStG', reason: 'bad_debt', originalDocumentId: unique('missing-settlement-original'), originalDocumentNumber: 'ER-MISSING', originalTaxEffectiveDate: '2026-04-01', adjustmentDate: '2026-04-15', evidenceReference: 'E2E Insolvenzbeschluss' },
    },
    chart: accounts.chart,
    reason: 'E2E missing settlement original',
  })).rejects.toThrow(/ORIGINAL_DOCUMENT_NOT_FOUND/);
  expect(await accountingStateIds(page)).toEqual(beforeMissingSettlement);

  const beforeCorrection = await sourceJournalIds(page);
  await expect(invokeDesktopIpc(page, 'pro:postAccountingCommand', {
    kind: 'correction',
    source: correctionSource,
    domainFacts: { ...correctionFacts, original: { ...correctionFacts.original, documentId: unique('missing-original') } },
    chart: accounts.chart,
    reason: 'E2E correction missing original',
  })).rejects.toThrow(/ORIGINAL_DOCUMENT_NOT_FOUND/);
  expect(await sourceJournalIds(page)).toEqual(beforeCorrection);
  expect(await accountingStateIds(page)).toEqual(beforeMissingSettlement);
  await page.screenshot({ path: test.info().outputPath('01-special-workspace.png'), fullPage: true });
});

test('posts a linked correction against a booked incoming invoice', async () => {
  const { page } = desktop;
  const accounts = await pickPostingAccounts(page);
  const { correctionSource, correctionFacts } = await postOriginalIncomingInvoice(page, accounts);
  const entriesBefore = (await invokeDesktopIpc(page, 'pro:listJournalEntries', { limit: 500, offset: 0 })).length;

  const validCorrection = await invokeDesktopIpc(page, 'pro:postAccountingCommand', {
    kind: 'correction',
    source: correctionSource,
    domainFacts: correctionFacts,
    chart: accounts.chart,
    reason: 'E2E correction accepted',
  });
  expect(validCorrection.status).toBe('posted');
  expect((await invokeDesktopIpc(page, 'pro:listJournalEntries', { limit: 500, offset: 0 })).length).toBeGreaterThan(entriesBefore);
});

test('posts provision, inventory and FX before the close; the close soft-locks the month', async () => {
  const { page } = desktop;
  const accounts = await pickPostingAccounts(page);
  // Year-end order: provisions, inventory and FX valuation first, then the close. The close soft-locks April, so a
  // later posting into April needs an override with a reason (P1); the test books in the order a bookkeeper would.
  const generated = [
    ['provision', { sourceId: unique('provision'), sourceRevision: 'r1', effectiveDate: '2026-04-15', period: '2026-04', fiscalYear: 2026, currency: 'EUR', previousAmount: 10, targetAmount: 25, expenseAccount: accounts.expense, provisionAccount: accounts.provision }],
    ['inventory_closing', { sourceId: unique('inventory'), sourceRevision: 'r1', effectiveDate: '2026-04-15', period: '2026-04', fiscalYear: 2026, currency: 'EUR', items: [{ id: 'stock-1', quantity: 10, unitCost: 10, unitMarketValue: 8, inventoryAccount: accounts.inventory, expenseAccount: accounts.expense }] }],
    ['fx_valuation', { sourceId: unique('fx'), sourceRevision: 'r1', effectiveDate: '2026-04-15', period: '2026-04', fiscalYear: 2026, foreignCurrency: 'USD', functionalCurrency: 'EUR', foreignAmount: 100, closingRate: 1, carryingAmount: 90, position: 'asset', positionAccount: accounts.bank, gainAccount: accounts.gain, lossAccount: accounts.loss }],
  ];
  const results = {};
  for (const [kind, domainFacts] of generated) {
    results[kind] = await invokeDesktopIpc(page, 'pro:postAccountingCommand', {
      kind,
      source: sourceFact({ sourceType: kind, sourceId: `${domainFacts.sourceId}-input`, lines: journalLines(accounts) }),
      domainFacts,
      chart: accounts.chart,
      reason: `E2E ${kind}`,
    });
    expect(results[kind].status, kind).toBe('posted');
  }
  // Raising the provision from 10 € to 25 books the difference: expense on the debit side, provision on the credit side.
  const provisionEntry = (await invokeDesktopIpc(page, 'pro:listJournalEntries', { limit: 500, offset: 0 })).find((entry) => entry.id === results.provision.sourceRun.journalEntryId);
  expect(provisionEntry).toBeTruthy();
  expect(provisionEntry.lines.map((line) => [line.accountNumber, line.debitAmount, line.creditAmount])).toEqual([[accounts.expense, 15, 0], [accounts.provision, 0, 15]]);

  const balances = await seedClosingBalances(page, accounts, '2026-04-30');
  const closingCommand = {
    kind: 'fiscal_close',
    source: sourceFact({ sourceType: 'fiscal_close', sourceId: unique('close-input'), lines: journalLines(accounts) }),
    domainFacts: {
      sourceId: unique('fiscal-close'), sourceRevision: 'r1', fiscalYear: 2026, period: '2026-04', closingDate: '2026-04-30', currency: 'EUR',
      revenueAccounts: [accounts.revenue], expenseAccounts: [accounts.expense], retainedEarningsAccount: accounts.retained,
      balances,
    },
    chart: accounts.chart,
    reason: 'E2E fiscal close',
  };
  const beforeMismatch = await accountingStateIds(page);
  await expect(invokeDesktopIpc(page, 'pro:postAccountingCommand', {
    ...closingCommand,
    domainFacts: { ...closingCommand.domainFacts, balances: balances.map((row, index) => index === 0 ? { ...row, closingBalance: row.closingBalance + 1 } : row) },
  })).rejects.toThrow(/LEDGER_BALANCE_MISMATCH/);
  expect(await accountingStateIds(page)).toEqual(beforeMismatch);
  const close = await invokeDesktopIpc(page, 'pro:postAccountingCommand', closingCommand);
  expect(close.status).toBe('posted');

  // After the close April is soft-locked: a late provision without an override is refused and books nothing.
  const afterClose = await accountingStateIds(page);
  await expect(invokeDesktopIpc(page, 'pro:postAccountingCommand', {
    kind: 'provision',
    source: sourceFact({ sourceType: 'provision', sourceId: unique('late-provision-input'), lines: journalLines(accounts) }),
    domainFacts: { sourceId: unique('late-provision'), sourceRevision: 'r1', effectiveDate: '2026-04-20', period: '2026-04', fiscalYear: 2026, currency: 'EUR', previousAmount: 25, targetAmount: 30, expenseAccount: accounts.expense, provisionAccount: accounts.provision },
    chart: accounts.chart,
    reason: 'E2E late provision',
  })).rejects.toThrow(/SOFT_LOCK_OVERRIDE_REQUIRED/);
  expect(await accountingStateIds(page)).toEqual(afterClose);

  const runs = await invokeDesktopIpc(page, 'pro:listAccountingSourceRuns');
  expect(runs.map((run) => run.sourceType)).toEqual(expect.arrayContaining(['fiscal_close', 'provision', 'inventory_closing', 'fx_valuation']));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Letzte Buchungsläufe' })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('01-closing-runs.png'), fullPage: true });
});

test('records valid payroll control totals and rejects a gross-to-net mismatch without a journal', async () => {
  const { page } = desktop;
  const accounts = await pickPostingAccounts(page);
  const valid = await invokeDesktopIpc(page, 'pro:postAccountingCommand', {
    kind: 'payroll_batch',
    source: sourceFact({ sourceType: 'payroll_batch', sourceId: unique('payroll-ok'), lines: journalLines(accounts) }),
    domainFacts: {
      batchId: unique('payroll-batch'), sourceRevision: 'r1', effectiveDate: '2026-04-15', period: '2026-04', fiscalYear: 2026, currency: 'EUR',
      lines: [{ employeeId: 'employee-1', gross: 3000, employeeTaxes: 600, otherDeductions: 100, net: 2300, employerContributions: 500 }],
    },
    chart: accounts.chart,
    reason: 'E2E payroll valid',
  });
  expect(valid).toMatchObject({ status: 'noop', sourceRun: { sourceType: 'payroll_batch', status: 'noop' } });
  expect(valid.sourceRun.result.result.controlTotals).toMatchObject({ employeeCount: 1, gross: 3000, net: 2300, totalEmployerCost: 3500 });

  const before = await sourceJournalIds(page);
  await expect(invokeDesktopIpc(page, 'pro:postAccountingCommand', {
    kind: 'payroll_batch',
    source: sourceFact({ sourceType: 'payroll_batch', sourceId: unique('payroll-bad'), lines: journalLines(accounts) }),
    domainFacts: {
      batchId: unique('payroll-batch-bad'), sourceRevision: 'r1', effectiveDate: '2026-04-15', period: '2026-04', fiscalYear: 2026, currency: 'EUR',
      lines: [{ employeeId: 'employee-1', gross: 3000, employeeTaxes: 600, otherDeductions: 100, net: 2200 }],
    },
    chart: accounts.chart,
    reason: 'E2E payroll invalid',
  })).rejects.toThrow(/GROSS_TO_NET_MISMATCH/);
  expect(await sourceJournalIds(page)).toEqual(before);
  await page.screenshot({ path: test.info().outputPath('01-payroll.png'), fullPage: true });
});
