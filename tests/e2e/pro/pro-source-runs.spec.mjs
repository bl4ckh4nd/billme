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

const sourceJournalIds = async (page) => (await invokeDesktopIpc(page, 'pro:listAccountingSourceRuns'))
  .map((run) => run.journalEntryId)
  .filter(Boolean);

test.beforeEach(async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedDesktopData(desktop.page, { app: 'pro' });
  await desktop.page.goto(appUrl(desktop.baseUrl, '/accounting'));
  await expect(desktop.page.getByRole('heading', { name: 'Pro Buchhaltung' })).toBeVisible();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('posts, replays, and conflict-blocks one immutable source revision', async () => {
  const { page } = desktop;
  const accounts = await pickPostingAccounts(page);
  const source = sourceFact({ sourceId: unique('replay'), lines: journalLines(accounts) });

  const first = await invokeDesktopIpc(page, 'pro:postAccountingSource', { source, chart: accounts.chart, reason: 'E2E source posting' });
  expect(first).toMatchObject({ status: 'posted', sourceRun: { status: 'posted', sourceId: source.sourceId, sourceRevision: 'r1' } });
  expect(first.sourceRun.journalEntryId).toBeTruthy();

  const replay = await invokeDesktopIpc(page, 'pro:postAccountingSource', { source, chart: accounts.chart, reason: 'E2E source replay' });
  expect(replay).toMatchObject({ status: 'duplicate', sourceRun: { id: first.sourceRun.id } });

  const conflict = await invokeDesktopIpc(page, 'pro:postAccountingSource', {
    source: { ...source, lines: journalLines(accounts, 90) },
    chart: accounts.chart,
    reason: 'E2E source conflict',
  });
  expect(conflict.status).toBe('rejected');
  expect(conflict.errors.map((issue) => issue.code)).toContain('DUPLICATE_SOURCE_REVISION');
  expect((await sourceJournalIds(page)).filter((id) => id === first.sourceRun.journalEntryId)).toHaveLength(1);
  expect((await invokeDesktopIpc(page, 'pro:getAccountingSourceRun', { id: first.sourceRun.id })).fact.sourceId).toBe(source.sourceId);
});

test('posts a Sonderbuchung through the browser and refetches its journal link', async () => {
  const { page } = desktop;
  const sourceId = unique('ui-source');

  await page.getByRole('button', { name: 'Sonderbuchungen & Abschluss' }).click();
  await expect(page.getByRole('heading', { name: 'Sonderbuchungen & Abschluss' })).toBeVisible();

  await page.getByRole('button', { name: 'Sonderbuchung speichern' }).click();
  await expect(page.getByRole('alert')).toContainText('Audit-Grund ist erforderlich.');

  await page.getByRole('textbox', { name: 'Quellbeleg' }).fill(sourceId);
  await page.getByRole('textbox', { name: 'Buchungsdatum' }).fill('2026-04-15');
  await page.getByRole('combobox', { name: 'Workflow' }).selectOption('fiscal_close');
  await page.getByRole('textbox', { name: 'Audit-Grund', exact: true }).fill('E2E browser source posting');
  await page.getByRole('button', { name: 'Sonderbuchung speichern' }).click();

  await expect(page.getByRole('status')).toContainText('Sonderbuchung gespeichert und refetched.');
  const historyRow = page.locator('section[aria-labelledby="source-run-history-heading"] li').filter({ hasText: sourceId });
  await expect(historyRow).toContainText('fiscal_close');
  await expect(historyRow).toContainText('posted');
  const journalLink = historyRow.getByRole('link', { name: /^Journal / });
  await expect(journalLink).toBeVisible();
  await expect(journalLink).toHaveAttribute('href', /#\/accounting\/journal\/.+/);
});

test('keeps invalid account, zero amount, and closed-period postings atomic', async () => {
  const { page } = desktop;
  const accounts = await pickPostingAccounts(page);
  const before = await sourceJournalIds(page);
  const invalid = await invokeDesktopIpc(page, 'pro:postAccountingSource', {
    source: sourceFact({ sourceId: unique('invalid'), lines: [
      { accountNumber: '999999', debitAmount: 0, creditAmount: 0 },
      { accountNumber: accounts.bank, debitAmount: 0, creditAmount: 0 },
    ] }),
    chart: accounts.chart,
    reason: 'E2E invalid source',
  });
  expect(invalid.status).toBe('rejected');
  expect(invalid.errors.map((issue) => issue.code)).toEqual(expect.arrayContaining(['INVALID_ACCOUNT', 'INVALID_AMOUNT']));
  expect(await sourceJournalIds(page)).toEqual(before);

  const lockedSource = sourceFact({ sourceId: unique('closed'), lines: journalLines(accounts) });
  await expect(setProAccountingPeriodStatus(desktop, lockedSource.period, 'closed')).resolves.toMatchObject({ status: 'closed' });
  const locked = await invokeDesktopIpc(page, 'pro:postAccountingSource', { source: lockedSource, chart: accounts.chart, reason: 'E2E closed period' });
  expect(locked.status).toBe('rejected');
  expect(locked.errors.map((issue) => issue.code)).toContain('PERIOD_MISMATCH');
  expect(await sourceJournalIds(page)).toEqual(before);
});

test('posts correction and close/provision/inventory/FX command workflows, while rejecting missing originals', async () => {
  const { page } = desktop;
  const accounts = await pickPostingAccounts(page);
  await invokeDesktopIpc(page, 'pro:upsertTaxCaseAccountMapping', {
    chart: accounts.chart,
    taxCaseKey: 'DE_STD_19',
    role: 'input_tax',
    accountNumber: accounts.expense,
  });
  await invokeDesktopIpc(page, 'pro:upsertAccountingAccountMapping', {
    chart: accounts.chart,
    role: 'input_vat',
    accountNumber: accounts.expense,
  });
  const vendorId = unique('correction-vendor');
  const originalId = unique('correction-original');
  const originalLineId = unique('correction-original-line');
  const timestamp = new Date().toISOString();
  await invokeDesktopIpc(page, 'pro:upsertVendor', {
    reason: 'E2E correction original',
    vendor: {
      id: vendorId,
      tenantId: 'default',
      vendorNumber: unique('vendor-number'),
      name: 'E2E Correction Vendor',
      email: 'correction-vendor@example.test',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  });
  await invokeDesktopIpc(page, 'pro:upsertIncomingInvoice', {
    reason: 'E2E correction original',
    invoice: {
      id: originalId,
      tenantId: 'default',
      vendorId,
      number: unique('ER-correction'),
      invoiceDate: '2026-04-01',
      dueDate: '2026-04-30',
      servicePeriod: '2026-04',
      netAmount: 100,
      taxAmount: 19,
      grossAmount: 119,
      taxRate: 19,
      status: 'open',
      lines: [{
        id: originalLineId,
        incomingInvoiceId: originalId,
        position: 0,
        description: 'E2E correction original',
        quantity: 1,
        unitPrice: 100,
        netAmount: 100,
        taxRate: 19,
        taxAmount: 19,
        grossAmount: 119,
        accountNumber: accounts.expense,
      }],
      accountingStatus: 'unposted',
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  });
  const originalPosting = await invokeDesktopIpc(page, 'pro:postIncomingInvoiceAccounting', {
    invoiceId: originalId,
    reason: 'E2E correction original posting',
  });
  expect(originalPosting).toMatchObject({ status: 'ready', snapshot: { sourceId: originalId } });
  const original = (await invokeDesktopIpc(page, 'pro:listIncomingInvoices')).find((invoice) => invoice.id === originalId);
  expect(original?.accountingSnapshot).toBeTruthy();
  const originalSnapshot = original.accountingSnapshot;
  const originalSnapshotHash = snapshotHash(originalSnapshot);
  const correctionSource = sourceFact({ sourceType: 'standalone_source', sourceId: unique('correction'), lines: journalLines(accounts, 11.9) });
  const correctionFacts = {
    id: unique('linked-correction'),
    idempotencyKey: unique('correction-key'),
    correctionDate: '2026-04-15',
    documentType: 'incoming_invoice',
    original: {
      documentId: original.id,
      documentNumber: original.number,
      revision: originalSnapshot.sourceVersion,
      snapshotHash: originalSnapshotHash,
      currentSnapshotHash: 'changed-snapshot',
      taxEffectiveDate: original.invoiceDate,
      taxBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19, grossAmount: 119 }],
    },
    deltas: [{ rate: 19, grossAmount: 11.9 }],
  };
  const beforeCorrection = await sourceJournalIds(page);
  await expect(invokeDesktopIpc(page, 'pro:postAccountingCommand', {
    kind: 'correction',
    source: correctionSource,
    domainFacts: {
      ...correctionFacts,
      original: { ...correctionFacts.original, documentId: unique('missing-original'), currentSnapshotHash: originalSnapshotHash },
    },
    chart: accounts.chart,
    reason: 'E2E correction missing original',
  })).rejects.toThrow(/ORIGINAL_DOCUMENT_NOT_FOUND/);
  expect(await sourceJournalIds(page)).toEqual(beforeCorrection);

  const validCorrection = await invokeDesktopIpc(page, 'pro:postAccountingCommand', {
    kind: 'correction',
    source: correctionSource,
    domainFacts: { ...correctionFacts, id: unique('linked-correction-ok'), idempotencyKey: unique('correction-key-ok'), original: { ...correctionFacts.original, currentSnapshotHash: originalSnapshotHash } },
    chart: accounts.chart,
    reason: 'E2E correction accepted',
  });
  expect(validCorrection.status).toBe('posted');

  const close = await invokeDesktopIpc(page, 'pro:postAccountingCommand', {
    kind: 'fiscal_close',
    source: sourceFact({ sourceType: 'fiscal_close', sourceId: unique('close-input'), lines: journalLines(accounts) }),
    domainFacts: {
      sourceId: unique('fiscal-close'), sourceRevision: 'r1', fiscalYear: 2026, period: '2026-04', closingDate: '2026-04-30', currency: 'EUR',
      revenueAccounts: [accounts.revenue], expenseAccounts: [accounts.expense], retainedEarningsAccount: accounts.retained,
      balances: [
        { accountNumber: accounts.revenue, openingBalance: 0, debitTurnover: 0, creditTurnover: 100, closingBalance: -100 },
        { accountNumber: accounts.expense, openingBalance: 0, debitTurnover: 50, creditTurnover: 0, closingBalance: 50 },
      ],
    },
    chart: accounts.chart,
    reason: 'E2E fiscal close',
  });
  expect(close.status).toBe('posted');

  const generated = [
    ['provision', { sourceId: unique('provision'), sourceRevision: 'r1', effectiveDate: '2026-04-15', period: '2026-04', fiscalYear: 2026, currency: 'EUR', previousAmount: 10, targetAmount: 25, expenseAccount: accounts.expense, provisionAccount: accounts.provision }],
    ['inventory_closing', { sourceId: unique('inventory'), sourceRevision: 'r1', effectiveDate: '2026-04-15', period: '2026-04', fiscalYear: 2026, currency: 'EUR', items: [{ id: 'stock-1', quantity: 10, unitCost: 10, unitMarketValue: 8, inventoryAccount: accounts.inventory, expenseAccount: accounts.expense }] }],
    ['fx_valuation', { sourceId: unique('fx'), sourceRevision: 'r1', effectiveDate: '2026-04-15', period: '2026-04', fiscalYear: 2026, foreignCurrency: 'USD', functionalCurrency: 'EUR', foreignAmount: 100, closingRate: 1, carryingAmount: 90, position: 'asset', positionAccount: accounts.bank, gainAccount: accounts.gain, lossAccount: accounts.loss }],
  ];
  for (const [kind, domainFacts] of generated) {
    const result = await invokeDesktopIpc(page, 'pro:postAccountingCommand', {
      kind,
      source: sourceFact({ sourceType: kind, sourceId: `${domainFacts.sourceId}-input`, lines: journalLines(accounts) }),
      domainFacts,
      chart: accounts.chart,
      reason: `E2E ${kind}`,
    });
    if (kind === 'provision') {
      expect(result.status, kind).toBe('noop');
      expect(result.sourceRun?.result).toMatchObject({ result: { commandId: expect.stringContaining('provision') }, status: 'noop' });
    } else {
      expect(result.status, kind).toBe('posted');
    }
  }

  const runs = await invokeDesktopIpc(page, 'pro:listAccountingSourceRuns');
  expect(runs.map((run) => run.sourceType)).toEqual(expect.arrayContaining(['standalone_source', 'fiscal_close', 'provision', 'inventory_closing', 'fx_valuation']));
  expect(runs.find((run) => run.fact.provenance?.commandKind === 'correction')?.fact.provenance).toMatchObject({ commandKind: 'correction' });
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
  const invalid = await invokeDesktopIpc(page, 'pro:postAccountingCommand', {
    kind: 'payroll_batch',
    source: sourceFact({ sourceType: 'payroll_batch', sourceId: unique('payroll-bad'), lines: journalLines(accounts) }),
    domainFacts: {
      batchId: unique('payroll-batch-bad'), sourceRevision: 'r1', effectiveDate: '2026-04-15', period: '2026-04', fiscalYear: 2026, currency: 'EUR',
      lines: [{ employeeId: 'employee-1', gross: 3000, employeeTaxes: 600, otherDeductions: 100, net: 2200 }],
    },
    chart: accounts.chart,
    reason: 'E2E payroll invalid',
  });
  expect(invalid.status).toBe('rejected');
  expect(invalid.errors.map((issue) => issue.code)).toContain('GROSS_TO_NET_MISMATCH');
  expect(await sourceJournalIds(page)).toEqual(before);
});
