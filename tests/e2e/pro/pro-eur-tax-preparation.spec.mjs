import { expect, test } from '@playwright/test';
import { appUrl, importPendingProTransaction, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedDesktopData(desktop.page, { app: 'pro' });
  await desktop.page.goto(appUrl(desktop.baseUrl, '/eur'));
  await expect(desktop.page.getByRole('heading', { name: 'Anlage EÜR' })).toBeVisible();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('persists 2026 EÜR private, pass-through, split, and annex facts with provenance', async () => {
  const { page } = desktop;
  const report = await invokeDesktopIpc(page, 'eur:getReport', { taxYear: 2026, from: '2026-01-01', to: '2026-12-31' });
  expect(report).toMatchObject({ taxYear: 2026, from: '2026-01-01', to: '2026-12-31', catalog: { id: 'anlage-euer-2026', elsterReady: false } });
  const expenseLine = report.rows.find((row) => row.kind === 'expense' && row.exportable);
  expect(expenseLine).toBeTruthy();

  const facts = [
    { sourceType: 'transaction', sourceId: 'tx-1', taxYear: 2026, kind: 'private-withdrawal', amountNet: 25, reason: 'E2E private withdrawal', idempotencyKey: 'e2e-eur-private-2026' },
    { sourceType: 'transaction', sourceId: 'tx-3', taxYear: 2026, kind: 'pass-through', amountNet: 40, reason: 'E2E pass-through', idempotencyKey: 'e2e-eur-pass-through-2026' },
    {
      sourceType: 'transaction', sourceId: 'tx-2', taxYear: 2026, kind: 'expense', flowType: 'expense', amountNet: 49.9,
      splits: [
        { amountNet: 30, deductibility: 'deductible', lineId: expenseLine.lineId, reason: 'E2E business share' },
        { amountNet: 19.9, deductibility: 'non-deductible', reason: 'E2E private share' },
      ], reason: 'E2E split allocation', idempotencyKey: 'e2e-eur-split-2026',
    },
  ];
  for (const input of facts) {
    const saved = await invokeDesktopIpc(page, 'eur:saveCashFact', input);
    expect(saved).toMatchObject({ taxYear: 2026, sourceId: input.sourceId, kind: input.kind, provenance: { catalogId: 'anlage-euer-2026' } });
  }
  const savedFacts = await invokeDesktopIpc(page, 'eur:listCashFacts', { taxYear: 2026 });
  expect(savedFacts.map((fact) => fact.kind)).toEqual(expect.arrayContaining(['private-withdrawal', 'pass-through', 'expense']));
  expect(savedFacts.find((fact) => fact.sourceId === 'tx-2').splits).toHaveLength(2);

  const annexFacts = [
    { taxYear: 2026, annex: 'AVEÜR', lineId: 'AVEÜR_2026_GB_100', amount: 100, sourceId: 'asset-e2e-1', date: '2026-04-15', reason: 'E2E AVEÜR opening', idempotencyKey: 'e2e-aveur-2026' },
    { taxYear: 2026, annex: 'SZ', lineId: 'SZ_2026_L05', amount: 250, sourceId: 'sz-e2e-1', date: '2026-04-15', reason: 'E2E SZ input', idempotencyKey: 'e2e-sz-2026' },
  ];
  for (const input of annexFacts) {
    const saved = await invokeDesktopIpc(page, 'eur:saveAnnexFact', input);
    expect(saved).toMatchObject({ taxYear: 2026, annex: input.annex, lineId: input.lineId, amount: input.amount, provenance: { catalogId: 'anlage-euer-2026' } });
  }
  expect(await invokeDesktopIpc(page, 'eur:listAnnexFacts', { taxYear: 2026, annex: 'AVEÜR' })).toHaveLength(1);
  expect(await invokeDesktopIpc(page, 'eur:listAnnexFacts', { taxYear: 2026, annex: 'SZ' })).toHaveLength(1);
  await expect(invokeDesktopIpc(page, 'eur:saveAnnexFact', {
    taxYear: 2026, annex: 'AVEÜR', lineId: 'AVEÜR_2026_GB_106', amount: 1, reason: 'E2E computed annex rejection',
  })).rejects.toThrow(/EUR_COMPUTED_LINE_NOT_CLASSIFIABLE|computed/i);
});

const taxDraft = async (page, taxCaseKey) => {
  const { transaction, draft } = await importPendingProTransaction(page, `tax-prep-${taxCaseKey}`, { amount: -119, purpose: `E2E ${taxCaseKey}` });
  const gross = taxCaseKey === 'EU_B2C_OSS' ? 120 : 100;
  const policy = await invokeDesktopIpc(page, 'pro:getAccountingPolicy');
  const ledger = await invokeDesktopIpc(page, 'pro:listLedgerAccounts', { chart: policy.activeChart, limit: 3000, offset: 0 });
  const bank = ledger.find((row) => row.accountNumber === (policy.activeChart === 'SKR03' ? '1200' : '1800'))?.accountNumber ?? ledger.find((row) => row.accountNumber.startsWith('1'))?.accountNumber;
  const revenue = ledger.find((row) => row.accountNumber === (policy.activeChart === 'SKR03' ? '8400' : '4400'))?.accountNumber ?? ledger.find((row) => row.accountNumber.startsWith('8') || row.accountNumber.startsWith('4'))?.accountNumber;
  const saved = await invokeDesktopIpc(page, 'pro:saveDraft', {
    draft: {
      ...draft,
      workflowStatus: 'suggested',
      postingDate: transaction.date,
      documentDate: transaction.date,
      period: transaction.date.slice(0, 7),
      fiscalYear: Number(transaction.date.slice(0, 4)),
      lines: [
        { id: `${draft.id}-tax`, accountNumber: revenue, debitAmount: 0, creditAmount: gross, taxCaseKey, taxRate: taxCaseKey === 'EU_B2C_OSS' ? 20 : 0, netAmount: 100, taxAmount: taxCaseKey === 'EU_B2C_OSS' ? 20 : 0, grossAmount: gross },
        { id: `${draft.id}-bank`, accountNumber: bank, debitAmount: gross, creditAmount: 0 },
      ],
      validationIssues: [],
      updatedAt: new Date().toISOString(),
    },
  });
  return saved;
};

test('blocks UStVA/ZM/OSS preparation inputs until country, identity, and evidence are captured', async () => {
  const { page } = desktop;
  const ustva = await taxDraft(page, 'DE_KU19');
  const ustvaCheck = await invokeDesktopIpc(page, 'pro:validateTaxCompliance', { draftId: ustva.id });
  expect(ustvaCheck.issues.map((issue) => issue.code)).toContain('MISSING_TAX_EVIDENCE');

  const zm = await taxDraft(page, 'EU_B2B_SERVICE_RC');
  const zmCheck = await invokeDesktopIpc(page, 'pro:validateTaxCompliance', { draftId: zm.id });
  expect(zmCheck.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['MISSING_COUNTRY_CODE', 'MISSING_COUNTERPARTY_VAT_ID', 'MISSING_TAX_EVIDENCE']));

  const oss = await taxDraft(page, 'EU_B2C_OSS');
  const ossCheck = await invokeDesktopIpc(page, 'pro:validateTaxCompliance', { draftId: oss.id });
  expect(ossCheck.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['MISSING_COUNTRY_CODE', 'MISSING_TAX_EVIDENCE']));
});

test('reports the desktop tax provider as unavailable instead of simulating a filing', async () => {
  const { page } = desktop;
  await page.goto(appUrl(desktop.baseUrl, '/accounting'));
  await expect(page.getByRole('heading', { name: 'Pro Buchhaltung' })).toBeVisible();
  await page.getByRole('button', { name: 'Sonderbuchungen & Abschluss' }).click();
  await expect(page.getByRole('heading', { name: 'Sonderbuchungen & Abschluss' })).toBeVisible();
  await expect(page.getByText(/Provider bleibt nicht verfügbar/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Vorbereitung erstellen' })).toBeDisabled();
});
