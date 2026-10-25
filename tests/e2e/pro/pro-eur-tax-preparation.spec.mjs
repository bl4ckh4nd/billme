import { writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { appUrl, importPendingProTransaction, invokeDesktopIpc, launchDesktopApp, seedDesktopData } from '../support.mjs';

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp({ app: 'pro' });
  await seedDesktopData(desktop.page, { app: 'pro' });
  // Seeding writes past react-query (and the onboarding gate); reload so the shell reads the seeded settings.
  await desktop.page.reload();
  await desktop.page.goto(appUrl(desktop.baseUrl, '/eur'));
  await expect(desktop.page.getByRole('heading', { name: 'Buchen', exact: true })).toBeVisible();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('persists 2026 EÜR private, pass-through, split, and annex facts with provenance', async () => {
  const { page } = desktop;
  const range = { taxYear: 2026, from: '2026-01-01', to: '2026-12-31' };
  const report = await invokeDesktopIpc(page, 'eur:getReport', range);
  expect(report).toMatchObject({ ...range, catalog: { id: 'anlage-euer-2026', elsterReady: false } });
  const expenseLine = report.rows.find((row) => row.kind === 'expense' && row.exportable);
  expect(expenseLine).toBeTruthy();

  // Pro's EÜR cash items are the payments allocated to open items, not bank lines (the Lite seed accounts' tx-1..3 do not exist here).
  // The seed paid RE-…200 in full; a partial payment on RE-…201 gives a second income, a paid incoming invoice the expense.
  const now = new Date().toISOString();
  await invokeDesktopIpc(page, 'pro:upsertVendor', { reason: 'E2E vendor', vendor: { id: 'v-eur', tenantId: 'default', name: 'E2E Adobe Reseller', createdAt: now, updatedAt: now } });
  await invokeDesktopIpc(page, 'pro:upsertIncomingInvoice', {
    reason: 'E2E incoming invoice',
    invoice: {
      id: 'in-eur', tenantId: 'default', vendorId: 'v-eur', number: 'ER-EUR-1', invoiceDate: '2026-04-10', dueDate: '2026-04-30', servicePeriod: '2026-04',
      netAmount: 100, taxAmount: 19, grossAmount: 119, status: 'open', taxRate: 19, taxCaseKey: 'DE_STD_19', accountingStatus: 'unposted', createdAt: now, updatedAt: now,
      lines: [{ id: 'in-eur-line', incomingInvoiceId: 'in-eur', position: 0, description: 'Creative Cloud', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 19, taxAmount: 19, taxCaseKey: 'DE_STD_19', grossAmount: 119, accountNumber: '4900' }],
    },
  });
  expect((await invokeDesktopIpc(page, 'pro:postIncomingInvoiceAccounting', { invoiceId: 'in-eur', reason: 'E2E post' })).status).toBe('ready');
  const pay = async (sourceId, openItemSourceId, amount) => {
    const item = (await invokeDesktopIpc(page, 'pro:listOpenItems')).find((row) => row.sourceId === openItemSourceId);
    expect(item, `open item of ${openItemSourceId}`).toBeTruthy();
    await invokeDesktopIpc(page, 'pro:allocateOpenItemPayment', {
      payment: {
        sourceType: 'manual', sourceId, partyType: item.partyType, partyId: item.partyId, paymentDate: '2026-04-20', amount, bankAccountNumber: '1200', method: 'E2E',
        allocations: [{ openItemId: item.id, amount }], reason: 'E2E payment', allocationEventId: `ev-${sourceId}`,
      },
    });
  };
  await pay('pay-eur-income', 'inv-open-1', 500);
  await pay('pay-eur-expense', 'in-eur', 119);
  const items = await invokeDesktopIpc(page, 'eur:listItems', range);
  expect(items.map((item) => [item.flowType, item.amountGross]).sort()).toEqual([['expense', 119], ['income', 1250], ['income', 500]]);
  const payment = items.find((item) => item.amountGross === 1250);
  const income = items.find((item) => item.amountGross === 500);
  const expense = items.find((item) => item.flowType === 'expense');

  const facts = [
    { sourceType: payment.sourceType, sourceId: payment.sourceId, taxYear: 2026, kind: 'private-withdrawal', amountNet: 25, reason: 'E2E private withdrawal', idempotencyKey: 'e2e-eur-private-2026' },
    { sourceType: income.sourceType, sourceId: income.sourceId, taxYear: 2026, kind: 'pass-through', amountNet: 40, reason: 'E2E pass-through', idempotencyKey: 'e2e-eur-pass-through-2026' },
    {
      sourceType: expense.sourceType, sourceId: expense.sourceId, taxYear: 2026, kind: 'expense', flowType: 'expense', amountNet: 100,
      splits: [
        { amountNet: 60, deductibility: 'deductible', lineId: expenseLine.lineId, reason: 'E2E business share' },
        { amountNet: 40, deductibility: 'non-deductible', reason: 'E2E private share' },
      ], reason: 'E2E split allocation', idempotencyKey: 'e2e-eur-split-2026',
    },
  ];
  for (const input of facts) {
    const saved = await invokeDesktopIpc(page, 'eur:saveCashFact', input);
    expect(saved).toMatchObject({ taxYear: 2026, sourceId: input.sourceId, kind: input.kind, provenance: { catalogId: 'anlage-euer-2026' } });
  }
  const savedFacts = await invokeDesktopIpc(page, 'eur:listCashFacts', { taxYear: 2026 });
  expect(savedFacts.map((fact) => fact.kind)).toEqual(expect.arrayContaining(['private-withdrawal', 'pass-through', 'expense']));
  expect(savedFacts.find((fact) => fact.sourceId === expense.sourceId).splits).toHaveLength(2);

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
  await page.screenshot({ path: test.info().outputPath('01-eur-workbench.png'), fullPage: true });
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
  expect(zmCheck.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['MISSING_TAX_COUNTRY', 'MISSING_COUNTERPARTY_VAT_ID', 'MISSING_TAX_EVIDENCE']));

  const oss = await taxDraft(page, 'EU_B2C_OSS');
  const ossCheck = await invokeDesktopIpc(page, 'pro:validateTaxCompliance', { draftId: oss.id });
  expect(ossCheck.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['MISSING_TAX_COUNTRY', 'MISSING_TAX_EVIDENCE']));

  // The same drafts are blocked in the workbench instead of being hidden.
  await page.goto(appUrl(desktop.baseUrl, '/accounting?view=inbox'));
  await expect(page.getByRole('heading', { name: 'Buchungs-Inbox', level: 2 })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Alle [3-9]/ })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath('01-tax-drafts-in-inbox.png'), fullPage: true });
});

test('a § 13b purchase shows up in the UStVA with Kz 84/85 and 67, drills down to its journal entry, and is prepared without any transmission', async () => {
  const { page, baseUrl } = desktop;
  const now = new Date().toISOString();
  // February 2026: no seeded document falls into it, so the Kennzahlen are exactly this purchase.
  await invokeDesktopIpc(page, 'pro:upsertVendor', { reason: 'E2E vendor', vendor: { id: 'v-13b', tenantId: 'default', name: 'E2E Bau GmbH', createdAt: now, updatedAt: now } });
  await invokeDesktopIpc(page, 'pro:upsertIncomingInvoice', {
    reason: 'E2E § 13b',
    invoice: {
      id: 'in-13b', tenantId: 'default', vendorId: 'v-13b', number: 'ER-13B-1', invoiceDate: '2026-02-10', dueDate: '2026-02-28', servicePeriod: '2026-02',
      netAmount: 1000, taxAmount: 0, grossAmount: 1000, status: 'open', taxRate: 19, taxCaseKey: 'DE_RC_13B_DOMESTIC', accountingStatus: 'unposted', createdAt: now, updatedAt: now,
      taxMeta: { vendorCountryCode: 'DE', evidenceType: 'rechnung', evidenceReference: 'Bauleistung § 13b' },
      lines: [{ id: 'in-13b-line', incomingInvoiceId: 'in-13b', position: 0, description: 'Estrich', quantity: 1, unitPrice: 1000, netAmount: 1000, taxRate: 19, taxAmount: 0, taxCaseKey: 'DE_RC_13B_DOMESTIC', grossAmount: 1000, accountNumber: '4900' }],
    },
  });
  expect((await invokeDesktopIpc(page, 'pro:postIncomingInvoiceAccounting', { invoiceId: 'in-13b', reason: 'E2E post § 13b' })).status).toBe('ready');

  // The UStVA lives under Steuer in the sidebar, not among the Sonderbuchungen.
  await page.goto(appUrl(baseUrl, '/accounting?view=special'));
  await expect(page.getByTestId('tax-moved-hint')).toBeVisible();
  await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name: 'Steuer' }).click();
  await expect(page).toHaveURL(/view=tax/);
  const panel = page.getByTestId('ustva-panel');
  await expect(panel).toBeVisible();
  await panel.getByRole('textbox', { name: 'UStVA-Monat' }).fill('2026-02');
  await expect(panel.getByText('2026-02-01 bis 2026-02-28')).toBeVisible();
  const table = panel.getByRole('table', { name: 'UStVA-Kennzahlen' });
  const kz84 = table.locator('tr[data-kennziffer="84"]');
  await expect(kz84).toContainText('84 / 85');
  await expect(kz84).toContainText('1.000,00');
  await expect(kz84).toContainText('190,00');
  await expect(table.locator('tr[data-kennziffer="67"]')).toContainText('190,00');
  await expect(table.locator('tr[data-kennziffer="83"]')).toContainText('0,00');

  await kz84.getByRole('button', { name: '1 Buchung' }).click();
  await panel.getByRole('button', { name: 'Journal öffnen' }).click();
  const lines = page.getByLabel('Buchungszeilen');
  await expect(lines).toContainText('1577');
  await expect(lines).toContainText('1787');
  await page.screenshot({ path: test.info().outputPath('01-ustva-13b-drilldown.png'), fullPage: true });
  await page.getByRole('button', { name: 'Journalansicht schließen' }).click();

  // The frozen preparation states plainly that nothing goes to ELSTER; the filing itself stays unavailable.
  await expect(page.getByText(/Keine Übermittlung an ELSTER oder das BZSt\./)).toBeVisible();
  await page.getByRole('combobox', { name: 'Steuervorbereitung' }).selectOption('ustva');
  await page.getByRole('textbox', { name: 'Steuerzeitraum' }).fill('2026-02');
  await page.getByRole('textbox', { name: 'Audit-Grund Steuerexport' }).fill('UStVA Februar vorbereitet');
  await page.getByRole('button', { name: 'Vorbereitung erstellen' }).click();
  await expect(page.getByText(/vorbereitet und eingefroren – keine offizielle Übermittlung\. Die Monate des Zeitraums sind jetzt vorläufig gesperrt\./)).toBeVisible();
  await expect(page.getByTestId('period-lock-list').locator('li[data-period="2026-02"]'), 'the soft lock is visible next to the preparation').toContainText('Vorläufig gesperrt');
  await page.screenshot({ path: test.info().outputPath('02-ustva-prepared.png'), fullPage: true });

  const run = (await invokeDesktopIpc(page, 'pro:listAccountingSourceRuns', undefined)).find((item) => item.sourceType === 'tax_export_ustva');
  const artifact = await invokeDesktopIpc(page, 'pro:getTaxExportArtifact', { kind: 'ustva', id: run.id });
  writeFileSync(test.info().outputPath('ustva-2026-02.json'), JSON.stringify(artifact, null, 2));
  expect(artifact).toMatchObject({ submissionReady: false, providerValidation: 'unavailable', catalog: { formYear: 2026, provisional: false } });
  expect(artifact.rows.map((row) => [row.kennziffer, row.direction, row.netAmount, row.taxAmount])).toEqual([['67', 'input', 1000, 190], ['84', 'output', 1000, 190], ['83', 'total', 0, 0]]);
});
