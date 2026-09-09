import { createHmac } from 'node:crypto';
import { expect } from '@playwright/test';
import { readServerHarnessState } from '../harness.mjs';
import {
  PRO_SESSION_STORAGE_KEY,
  createOwnerCredentials,
  ensureHarnessSession,
  openProShell,
  requestJson,
  requestText,
  seedHarnessProTenant,
} from './helpers.mjs';

const proOwner = createOwnerCredentials('pro');
const liteOwner = createOwnerCredentials('lite');

const viewerTokenFor = (state, ownerToken) => {
  const [payload] = ownerToken.split('.');
  if (!payload || !state.env?.BILLME_SESSION_SECRET) throw new Error('Harness session secret is unavailable.');
  const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  const viewerPayload = Buffer.from(JSON.stringify({
    ...session,
    role: 'viewer',
    user: { ...session.user, role: 'viewer' },
  })).toString('base64url');
  const signature = createHmac('sha256', state.env.BILLME_SESSION_SECRET).update(viewerPayload).digest('base64url');
  return `${viewerPayload}.${signature}`;
};

const proAccountingHeading = (page) =>
  page.getByRole('heading', { name: /Pro Buchhaltung|Pro Kontenrahmen fehlt/ });

const completeProOnboardingIfVisible = async (page, scenarioKey = 'server-pro') => {
  const heading = page.getByRole('heading', { name: 'Richte deinen Firmenkopf ein' });
  const workspaceHeading = proAccountingHeading(page);

  // Authentication only starts refreshData. Wait for either the onboarding
  // dialog or the hydrated workspace before deciding that no setup is needed.
  // Otherwise the logout button can win the race and be covered by the dialog.
  await expect.poll(async () => {
    if (await heading.isVisible().catch(() => false)) return 'onboarding';
    if (await workspaceHeading.isVisible().catch(() => false)) return 'ready';
    return 'loading';
  }, { timeout: 30_000 }).toMatch(/^(onboarding|ready)$/);

  if (!(await heading.isVisible().catch(() => false))) return;

  const slug = scenarioKey.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();

  await page.getByLabel('Firmenname').fill(`Billme Pro ${slug}`);
  await page.getByLabel('Inhaber oder Geschäftsführung').fill('Billme Pro Owner');
  await page.getByLabel('Strasse und Hausnummer').fill('Teststrasse 1');
  await page.getByLabel('PLZ').fill('10115');
  await page.getByLabel('Stadt').fill('Berlin');
  await page.getByLabel('E-Mail für Angebote und Rechnungen').fill(`pro+${slug}@billme-e2e.local`);
  await page.getByRole('button', { name: 'Weiter zu Abrechnung' }).click();

  await page.getByLabel('Steuernummer').fill('12/345/67890');
  await page.getByLabel('Zahlungsziel in Tagen').fill('14');
  await page.getByLabel('Rechnungs-Praefix').fill('RE-%Y-');
  await page.getByLabel('Angebots-Praefix').fill('ANG-%Y-');
  await page.getByLabel('Rechtsform').selectOption('sole_proprietor');
  await page.getByLabel('Gewinnermittlung').selectOption('eur');
  await page.getByLabel('Umsatzsteuer-Methode').selectOption('ist');
  await page.getByRole('button', { name: 'Weiter zu Weitere Angaben' }).click();
  await expect(page.getByRole('heading', { name: 'Ergänze Zahlungs- und Kontaktdaten' })).toBeVisible();

  await page.getByLabel('Bankname').fill('Berliner Testbank');
  await page.getByLabel('IBAN').fill('DE12100500001234567890');
  await page.getByRole('button', { name: 'Zu Angeboten und Rechnungen' }).click();
  await expect(heading).toHaveCount(0);
};

export const runProSmokeScenario = async (page) => {
  const state = await readServerHarnessState();

  await page.goto(state.urls.webPro, { waitUntil: 'networkidle' });

  await expect(page.getByRole('heading', { name: 'Echte Pro-UI, servergestützt im Browser.' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Initialisieren & anmelden|Anmelden/ })).toBeVisible();
  await expect(page.getByText('billme-server-api')).toBeVisible();
  await expect(page.getByText(/Erststart|Anmelden/, { exact: true })).toBeVisible();
};

export const runProAuthRestoreScenario = async (page) => {
  const state = await readServerHarnessState();
  await openProShell(page, state, { route: 'accounting' });

  await expect(page.getByRole('heading', { name: /Pro-Mandant initialisieren|Mit Billme Pro verbinden/ })).toBeVisible();
  await page.getByLabel('Vollständiger Name').fill(proOwner.fullName);
  await page.getByLabel('E-Mail').fill(proOwner.email);
  await page.getByLabel('Passwort').fill(proOwner.password);

  const bootstrapButton = page.getByRole('button', { name: 'Initialisieren & anmelden' });
  const loginButton = page.getByRole('button', { name: 'Anmelden', exact: true });

  if (await bootstrapButton.isVisible().catch(() => false)) {
    await bootstrapButton.click();
  } else {
    await loginButton.click();
  }

  await completeProOnboardingIfVisible(page, 'auth-restore');

  await expect(page).toHaveURL(/#\/accounting$/);
  await expect(page.getByRole('button', { name: 'Abmelden' })).toBeVisible();

  await page.reload({ waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/#\/accounting$/);
  await expect(page.getByRole('button', { name: 'Abmelden' })).toBeVisible();

  await page.getByRole('button', { name: 'Abmelden' }).click();
  await expect(page.getByRole('button', { name: 'Anmelden', exact: true })).toBeVisible();

  await page.getByLabel('E-Mail').fill(proOwner.email);
  await page.getByLabel('Passwort').fill(proOwner.password);
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();

  await expect(page).toHaveURL(/#\/accounting$/);
  await expect(page.getByRole('button', { name: 'Abmelden' })).toBeVisible();
};

export const runProCatalogScenario = async (page) => {
  const state = await readServerHarnessState();
  const session = await ensureHarnessSession(state, {
    product: 'pro',
    ...proOwner,
  });

  await seedHarnessProTenant(state, {
    tenantId: session.tenantId,
    namespace: 'catalog-regression',
  });

  await openProShell(page, state, {
    route: 'articles',
    session,
  });

  await expect(page.getByRole('heading', { name: 'Produkte & Leistungen' })).toBeVisible();
  await expect(page.getByText('Senior Consulting')).toBeVisible();

  const articleTitle = `Playwright Katalog ${Date.now()}`;
  await page.getByRole('button', { name: 'Neuer Artikel' }).click();
  await expect(page.getByRole('heading', { name: 'Neuer Artikel', exact: true })).toBeVisible();
  await page.getByPlaceholder('z.B. Webdesign').fill(articleTitle);
  await page.locator('input[type="number"]').fill('321.5');
  await page.getByPlaceholder('Details zum Produkt...').fill('Browser-seitig angelegter Regressionseintrag');
  await page.getByRole('button', { name: 'Erstellen' }).click();
  await expect(page.getByText('Artikel erstellt.')).toBeVisible();
  await expect(page.getByText(articleTitle)).toBeVisible();

  await page.reload({ waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/#\/articles$/);
  await expect(page.getByText(articleTitle)).toBeVisible();

  await openProShell(page, state, { route: 'accounts', session });
  await expect(page.getByRole('heading', { name: 'Konten & Transaktionen' })).toBeVisible();

  await openProShell(page, state, { route: 'templates', session });
  await expect(page.getByRole('heading', { name: 'Vorlagen' })).toBeVisible();
};

export const runProAccountingScenario = async (page) => {
  const state = await readServerHarnessState();
  const session = await ensureHarnessSession(state, {
    product: 'pro',
    ...proOwner,
  });

  await seedHarnessProTenant(state, {
    tenantId: session.tenantId,
    namespace: 'accounting-regression',
    includeEurCashFixtures: true,
  });

  const gmbhProfile = {
    jurisdiction: 'DE',
    legalForm: 'gmbh',
    profitDetermination: 'double_entry',
    hgbSizeClass: 'micro',
    fiscalYearStart: '01-01',
    chart: 'SKR03',
    vatMethod: 'soll',
  };
  const settings = await requestJson(state, session, '/api/v1/pro/settings');
  const settingsWithGmbhProfile = { ...settings, businessReportingProfile: gmbhProfile };
  await requestJson(state, session, '/api/v1/pro/settings', undefined, {
    method: 'PUT',
    body: { settings: settingsWithGmbhProfile },
  });

  await openProShell(page, state, {
    route: 'accounting',
    session,
  });

  await expect(page.getByRole('heading', { name: 'Pro Buchhaltung' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Buchhaltungsbereiche' })).toBeVisible();
  await expect(page.getByText('Hosting Partner GmbH').first()).toBeVisible();

  await requestJson(
    state,
    session,
    '/api/v1/pro/accounting/tax-case-account-mappings',
    undefined,
    {
      method: 'POST',
      body: {
        id: `pro-e2e-input-tax-${Date.now()}`,
        reason: 'Playwright Pro accounting mapping regression',
        chart: 'SKR03',
        taxCaseKey: 'DE_STD_19',
        role: 'input_tax',
        accountNumber: '1576',
        datevBuKey: '93',
      },
    },
  );

  const mappings = await requestJson(
    state,
    session,
    '/api/v1/pro/accounting/tax-case-account-mappings',
    { chart: 'SKR03' },
  );
  expect(
    mappings.some(
      (mapping) =>
        mapping.taxCaseKey === 'DE_STD_19' &&
        mapping.role === 'input_tax' &&
        mapping.accountNumber === '1576',
    ),
  ).toBe(true);

  const ruleNeedle = `Playwright Rule ${Date.now()}`;
  await requestJson(
    state,
    session,
    '/api/v1/pro/accounting/account-suggestion-rules',
    undefined,
    {
      method: 'POST',
      body: {
        reason: 'Playwright Pro accounting suggestion regression',
        chart: 'SKR03',
        priority: 42,
        field: 'purpose',
        operator: 'contains',
        value: ruleNeedle,
        targetAccountNumber: '8400',
        flowType: 'income',
      },
    },
  );

  const rulesAfterCreate = await requestJson(
    state,
    session,
    '/api/v1/pro/accounting/account-suggestion-rules',
    { chart: 'SKR03', activeOnly: 'false' },
  );
  const createdRule = rulesAfterCreate.find((rule) => rule.value === ruleNeedle);
  expect(createdRule?.targetAccountNumber).toBe('8400');

  await requestJson(
    state,
    session,
    `/api/v1/pro/accounting/account-suggestion-rules/${encodeURIComponent(createdRule.id)}`,
    undefined,
    { method: 'DELETE', body: { reason: 'Playwright Pro accounting suggestion cleanup' } },
  );
  await expect
    .poll(async () => {
      const workflowRules = await requestJson(
        state,
        session,
        '/api/v1/pro/accounting/account-suggestion-rules',
        { chart: 'SKR03', activeOnly: 'false' },
      );
      return workflowRules.some((rule) => rule.value === ruleNeedle);
    })
    .toBe(false);

  const transactions = await requestJson(state, session, '/api/v1/pro/accounting/transactions');
  const workflowTransaction = transactions.find((transaction) => transaction.counterparty === 'Hosting Partner GmbH');
  expect(workflowTransaction).toBeTruthy();
  const transactionId = workflowTransaction?.id;
  if (!transactionId) {
    throw new Error('Seeded Pro accounting transaction was not persisted.');
  }

  const draftBefore = await requestJson(
    state,
    session,
    `/api/v1/pro/accounting/drafts/${encodeURIComponent(transactionId)}`,
  );
  expect(draftBefore?.id).toBeTruthy();
  const draftId = draftBefore?.id;
  if (!draftId) {
    throw new Error('Seeded Pro accounting draft was not persisted.');
  }

  const draftSaved = await requestJson(
    state,
    session,
    '/api/v1/pro/accounting/drafts',
    undefined,
    {
      method: 'POST',
      body: {
        reason: 'Playwright canonical draft save',
        draft: {
          ...draftBefore,
          workflowStatus: 'ready_for_review',
          bookingText: 'Playwright canonical persisted booking',
          lines: [
            { id: `${draftId}-expense`, accountNumber: '3125', debitAmount: 119, creditAmount: 0 },
            { id: `${draftId}-bank`, accountNumber: '1200', debitAmount: 0, creditAmount: 119 },
          ],
        },
      },
    },
  );
  expect(draftSaved.workflowStatus).toBe('incomplete');

  const draftRefetched = await requestJson(
    state,
    session,
    `/api/v1/pro/accounting/drafts/${encodeURIComponent(transactionId)}`,
  );
  expect(draftRefetched).toMatchObject({
    id: draftId,
    transactionId,
    bookingText: 'Playwright canonical persisted booking',
    workflowStatus: 'incomplete',
  });
  expect(draftRefetched.lines).toEqual([
    expect.objectContaining({ accountNumber: '3125', debitAmount: 119, creditAmount: 0 }),
    expect.objectContaining({ accountNumber: '1200', debitAmount: 0, creditAmount: 119 }),
  ]);

  const submitForReview = await requestJson(
    state,
    session,
    `/api/v1/pro/accounting/drafts/${encodeURIComponent(transactionId)}/action`,
    undefined,
    { method: 'POST', body: { reason: 'Playwright submit canonical draft', action: 'submit_for_review' } },
  );
  expect(submitForReview.workflowStatus).toBe('pending_approval');

  const approvedDraft = await requestJson(
    state,
    session,
    `/api/v1/pro/accounting/drafts/${encodeURIComponent(transactionId)}/action`,
    undefined,
    { method: 'POST', body: { reason: 'Playwright approve canonical draft', action: 'approve' } },
  );
  expect(approvedDraft.workflowStatus).toBe('approved');

  const postedDraft = await requestJson(
    state,
    session,
    `/api/v1/pro/accounting/drafts/${encodeURIComponent(draftId)}/post`,
    undefined,
    {
      method: 'POST',
      body: {
        reason: 'Playwright post canonical draft',
        postingDate: '2026-03-05',
        idempotencyKey: `playwright-draft-${Date.now()}`,
      },
    },
  );
  expect(postedDraft.issues).toEqual([]);
  expect(postedDraft.entry).toMatchObject({ id: expect.any(String), status: 'posted', sourceDraftId: draftId });

  const reportMappingFixtures = [
    { statementType: 'bwa01', accountNumber: '8400', positionKey: 'revenue', positionLabel: 'Umsatzerlöse' },
    { statementType: 'bwa01', accountNumber: '3125', positionKey: 'material-expense', positionLabel: 'Material/Wareneinkauf' },
    { statementType: 'management-guv', accountNumber: '8400', positionKey: 'revenue', positionLabel: 'Betriebliche Erlöse' },
    { statementType: 'management-guv', accountNumber: '3125', positionKey: 'variable-costs', positionLabel: 'Variable Kosten' },
    { statementType: 'hgb-guv', accountNumber: '8400', positionKey: 'revenue', positionLabel: '1. Umsatzerlöse' },
    { statementType: 'hgb-guv', accountNumber: '3125', positionKey: 'material.services', positionLabel: 'b) Aufwendungen für bezogene Leistungen' },
    { statementType: 'hgb-bilanz', accountNumber: '1200', positionKey: 'assets.current', positionLabel: 'B. Umlaufvermögen', balanceSide: 'asset' },
    { statementType: 'hgb-bilanz', accountNumber: '1576', positionKey: 'assets.current', positionLabel: 'B. Umlaufvermögen', balanceSide: 'asset' },
    { statementType: 'hgb-bilanz', accountNumber: '1776', positionKey: 'liabilities', positionLabel: 'C. Verbindlichkeiten', balanceSide: 'liability' },
  ];
  for (const mapping of reportMappingFixtures) {
    const savedMapping = await requestJson(state, session, '/api/v1/pro/accounting/mappings/overrides', undefined, {
      method: 'PUT',
      body: { reason: `Playwright explicit ${mapping.statementType} mapping`, chart: 'SKR03', asOfDate: '2026-03-31', ...mapping },
    });
    expect(savedMapping).toMatchObject({ reportType: mapping.statementType, chart: 'SKR03', accountNumber: mapping.accountNumber, positionKey: expect.any(String) });
  }

  const guvReport = await requestJson(state, session, '/api/v1/pro/accounting/reports/guv', {
    from: '2026-03-05',
    to: '2026-03-05',
  });
  expect(Array.isArray(guvReport.rows)).toBe(true);
  expect(Number.isFinite(guvReport.netResult)).toBe(true);

  const datevExport = await requestText(state, session, '/api/v1/pro/accounting/datev/export.csv', {
    from: '2026-03-05',
    to: '2026-03-05',
    consultantNumber: '1001',
    clientNumber: '7',
    fiscalYearStart: '2026-01-01',
    accountLength: 4,
    encoding: 'utf8-bom',
    reason: 'Playwright immutable DATEV export',
  });
  expect(datevExport.body).toContain('"EXTF";700;21;"Buchungsstapel";13;');
  expect(datevExport.body).toContain(';1001;7;20260101;4;20260305;20260305;');
  expect(datevExport.body).toContain('Playwright canonical persisted booking');
  expect(datevExport.headers.get('content-type')).toContain('charset=utf-8');
  const datevExportId = datevExport.headers.get('x-billme-datev-export-id');
  const datevContentHash = datevExport.headers.get('x-billme-datev-content-sha256');
  expect(datevExportId).toBeTruthy();
  expect(datevContentHash).toMatch(/^[a-f0-9]{64}$/);

  const datevExports = await requestJson(state, session, '/api/v1/pro/accounting/datev/exports');
  expect(datevExports).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: datevExportId, contentSha256: datevContentHash }),
    ]),
  );
  const datevRefetched = await requestText(
    state,
    session,
    `/api/v1/pro/accounting/datev/exports/${encodeURIComponent(datevExportId)}`,
  );
  expect(datevRefetched.body).toBe(datevExport.body);
  expect(datevRefetched.headers.get('x-billme-datev-content-sha256')).toBe(datevContentHash);
  expect(datevRefetched.headers.get('content-type')).toContain('charset=utf-8');

  const eurProfile = {
    jurisdiction: 'DE',
    legalForm: 'sole_proprietor',
    profitDetermination: 'eur',
    fiscalYearStart: '01-01',
    vatMethod: 'soll',
  };
  await requestJson(state, session, '/api/v1/pro/settings', undefined, {
    method: 'PUT',
    body: { settings: { ...settingsWithGmbhProfile, businessReportingProfile: eurProfile } },
  });

  const eurFrom = '2025-01-01';
  const eurTo = '2025-12-31';
  const eurItems = await requestJson(state, session, '/api/v1/pro/accounting/reports/eur/items', { from: eurFrom, to: eurTo });
  expect(eurItems).toEqual(expect.arrayContaining([
    expect.objectContaining({ sourceType: 'transaction', date: '2025-03-01', flowType: 'income', amountGross: 119 }),
    expect.objectContaining({ sourceType: 'transaction', date: '2025-03-02', flowType: 'expense', amountGross: 59.5 }),
  ]));
  for (const item of eurItems) {
    const lineId = item.flowType === 'income' ? 'E2025_KZ112' : 'E2025_KZ280';
    const classification = await requestJson(state, session, '/api/v1/pro/accounting/reports/eur/classifications', undefined, {
      method: 'PUT',
      body: {
        sourceType: item.sourceType,
        sourceId: item.sourceId,
        taxYear: 2025,
        eurLineId: lineId,
        vatMode: 'default',
        vatRate: 19,
        note: `Playwright reasoned EÜR classification ${item.flowType}`,
        reason: `Playwright EÜR Belegprüfung ${item.flowType}`,
      },
    });
    expect(classification).toMatchObject({ sourceType: item.sourceType, sourceId: item.sourceId, taxYear: 2025, eurLineId: lineId });
  }
  const eurItemsRefetched = await requestJson(state, session, '/api/v1/pro/accounting/reports/eur/items', { from: eurFrom, to: eurTo });
  expect(eurItemsRefetched).toEqual(expect.arrayContaining([
    expect.objectContaining({ sourceId: expect.any(String), classification: expect.objectContaining({ eurLineId: 'E2025_KZ112', note: expect.stringContaining('reasoned EÜR') }) }),
    expect.objectContaining({ sourceId: expect.any(String), classification: expect.objectContaining({ eurLineId: 'E2025_KZ280', note: expect.stringContaining('reasoned EÜR') }) }),
  ]));

  const eurReport = await requestJson(state, session, '/api/v1/pro/accounting/reports/eur', { from: eurFrom, to: eurTo });
  expect(eurReport).toMatchObject({
    taxYear: 2025,
    from: eurFrom,
    to: eurTo,
    summary: { incomeTotal: 100, expenseTotal: 50, surplus: 50 },
    unclassifiedCount: 0,
    catalog: { id: expect.any(String), version: expect.any(String), sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/), delivery: 'print-form-only', elsterReady: false },
  });
  expect(eurReport.rows).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'E2025_KZ112', total: 100, providerPath: expect.any(String) }),
    expect.objectContaining({ id: 'E2025_KZ280', total: 50, providerPath: expect.any(String) }),
    expect.objectContaining({ id: 'E2025_KZ290', total: 50 }),
  ]));

  const eurSnapshot = await requestJson(state, session, '/api/v1/pro/accounting/reports/snapshots', undefined, {
    method: 'POST',
    body: { reportType: 'eur', from: eurFrom, to: eurTo, reason: 'Playwright save signed EÜR result' },
  });
  expect(eurSnapshot).toMatchObject({ id: expect.any(String), reportType: 'eur', sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  const eurSnapshotsRefetched = await requestJson(state, session, '/api/v1/pro/accounting/reports/snapshots', { reportType: 'eur' });
  const eurSnapshotRefetched = eurSnapshotsRefetched.find((snapshot) => snapshot.id === eurSnapshot.id);
  expect(eurSnapshotRefetched).toMatchObject({ id: eurSnapshot.id, reportType: 'eur', sourceHash: eurSnapshot.sourceHash });
  expect(JSON.parse(eurSnapshotRefetched?.payloadJson ?? '{}')).toMatchObject({ taxYear: 2025, summary: { surplus: 50 }, catalog: { sourceHash: eurReport.catalog.sourceHash } });

  const viewerToken = viewerTokenFor(state, session.token);
  const viewerMutation = await fetch(`${state.urls.api}/api/v1/pro/accounting/reports/eur/classifications`, {
    method: 'PUT',
    headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${viewerToken}` },
    body: JSON.stringify({ sourceType: eurItems[0]?.sourceType, sourceId: eurItems[0]?.sourceId, taxYear: 2025, eurLineId: 'E2025_KZ112', reason: 'Viewer must not mutate EÜR' }),
  });
  expect(viewerMutation.status).toBe(403);

  await requestJson(state, session, '/api/v1/pro/settings', undefined, {
    method: 'PUT',
    body: { settings: settingsWithGmbhProfile },
  });

  const mappingRequests = [
    ['accounts_receivable', '1200'],
    ['accounts_payable', '1200'],
    ['input_vat', '3125'],
    ['output_vat', '8400'],
    ['revenue', '8400'],
  ];
  for (const [role, accountNumber] of mappingRequests) {
    const mapping = await requestJson(
      state,
      session,
      '/api/v1/pro/accounting/mappings',
      undefined,
      {
        method: 'POST',
        body: {
          reason: `Playwright prepare incoming invoice ${role}`,
          chart: 'SKR03',
          role,
          accountNumber,
        },
      },
    );
    expect(mapping).toMatchObject({ chart: 'SKR03', role, accountNumber });
  }

  const suffix = `${Date.now()}`;
  const vendorId = `playwright-vendor-${suffix}`;
  const vendor = await requestJson(
    state,
    session,
    '/api/v1/pro/accounting/vendors',
    undefined,
    {
      method: 'POST',
      body: {
        reason: 'Playwright persist vendor',
        vendor: {
          id: vendorId,
          vendorNumber: `V-${suffix}`,
          name: 'Playwright Hosting Vendor',
          email: `vendor-${suffix}@billme-e2e.local`,
          defaultExpenseAccount: '3125',
        },
      },
    },
  );
  expect(vendor).toMatchObject({ id: vendorId, name: 'Playwright Hosting Vendor' });
  const vendorsRefetched = await requestJson(state, session, '/api/v1/pro/accounting/vendors');
  expect(vendorsRefetched).toEqual(expect.arrayContaining([expect.objectContaining({ id: vendorId })]));

  const incomingInvoiceId = `playwright-incoming-${suffix}`;
  const incomingInvoice = await requestJson(
    state,
    session,
    '/api/v1/pro/accounting/incoming-invoices',
    undefined,
    {
      method: 'POST',
      body: {
        reason: 'Playwright persist incoming invoice',
        invoice: {
          id: incomingInvoiceId,
          vendorId,
          number: `ER-${suffix}`,
          invoiceDate: '2026-03-06',
          dueDate: '2026-03-20',
          netAmount: 100,
          taxAmount: 19,
          grossAmount: 119,
          status: 'open',
          taxRate: 19,
          taxCaseKey: 'DE_STD_19',
          notes: 'Playwright incoming invoice persistence',
          accountingStatus: 'unposted',
          lines: [
            {
              id: `${incomingInvoiceId}-line-1`,
              incomingInvoiceId,
              position: 0,
              description: 'Managed hosting',
              quantity: 1,
              unitPrice: 100,
              netAmount: 100,
              taxRate: 19,
              taxAmount: 19,
              grossAmount: 119,
              accountNumber: '3125',
            },
          ],
        },
      },
    },
  );
  expect(incomingInvoice).toMatchObject({ id: incomingInvoiceId, accountingStatus: 'unposted' });
  const incomingInvoicesRefetched = await requestJson(state, session, '/api/v1/pro/accounting/incoming-invoices');
  expect(incomingInvoicesRefetched).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: incomingInvoiceId, vendorId })]),
  );

  const incomingPreview = await requestJson(
    state,
    session,
    '/api/v1/pro/accounting/incoming-invoices/preview',
    undefined,
    {
      method: 'POST',
      body: { reason: 'Playwright preview incoming invoice', invoiceId: incomingInvoiceId },
    },
  );
  expect(incomingPreview).toMatchObject({ sourceType: 'incoming_invoice', sourceId: incomingInvoiceId, status: 'ready' });

  const incomingPosted = await requestJson(
    state,
    session,
    '/api/v1/pro/accounting/incoming-invoices/post',
    undefined,
    {
      method: 'POST',
      body: { reason: 'Playwright post incoming invoice', invoiceId: incomingInvoiceId },
    },
  );
  expect(incomingPosted).toMatchObject({ sourceType: 'incoming_invoice', sourceId: incomingInvoiceId, status: 'ready' });
  const incomingAfterPost = await requestJson(state, session, '/api/v1/pro/accounting/incoming-invoices');
  expect(incomingAfterPost).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: incomingInvoiceId, accountingStatus: 'posted' })]),
  );

  const clients = await requestJson(state, session, '/api/v1/pro/clients');
  const outgoingClient = clients.find((client) => client.company === 'Beta Digital AG');
  expect(outgoingClient).toBeTruthy();
  const outgoingClientId = outgoingClient?.id;
  if (!outgoingClientId) {
    throw new Error('Seeded Pro accounting client was not persisted.');
  }

  const outgoingInvoiceId = `playwright-outgoing-${suffix}`;
  const numberReservation = await requestJson(
    state,
    session,
    '/api/v1/pro/numbers/reserve',
    undefined,
    { method: 'POST', body: { kind: 'invoice' } },
  );
  expect(numberReservation).toMatchObject({ reservationId: expect.any(String), number: expect.any(String) });

  const outgoingInvoice = await requestJson(
    state,
    session,
    '/api/v1/pro/invoices',
    undefined,
    {
      method: 'POST',
      body: {
        reason: 'Playwright persist outgoing invoice',
        invoice: {
          kind: 'invoice',
          id: outgoingInvoiceId,
          clientId: outgoingClientId,
          clientNumber: outgoingClient?.customerNumber,
          number: numberReservation.number,
          client: outgoingClient?.company,
          clientEmail: outgoingClient?.email,
          clientAddress: outgoingClient?.address,
          taxMode: 'standard_vat',
          taxSnapshot: {
            vatRateApplied: 19,
            vatAmount: 19,
            netAmount: 100,
            grossAmount: 119,
            einvoiceCategoryCode: 'S',
            vatBreakdown: [{ rate: 19, netAmount: 100, vatAmount: 19 }],
          },
          date: '2026-03-08',
          dueDate: '2026-03-22',
          servicePeriod: '2026-03',
          amount: 119,
          status: 'open',
          dunningLevel: 0,
          items: [{ description: 'Playwright outgoing service', quantity: 1, price: 119, total: 119, taxRate: 19 }],
          payments: [],
          history: [],
        },
      },
    },
  );
  expect(outgoingInvoice).toMatchObject({ id: outgoingInvoiceId, number: numberReservation.number, status: 'open' });

  await requestJson(
    state,
    session,
    '/api/v1/pro/numbers/finalize',
    undefined,
    {
      method: 'POST',
      body: { reservationId: numberReservation.reservationId, documentId: outgoingInvoiceId },
    },
  );

  const outgoingPreview = await requestJson(
    state,
    session,
    '/api/v1/pro/accounting/outgoing-invoices/preview',
    undefined,
    {
      method: 'POST',
      body: { reason: 'Playwright preview outgoing invoice', invoiceId: outgoingInvoiceId },
    },
  );
  expect(outgoingPreview).toMatchObject({ sourceType: 'outgoing_invoice', sourceId: outgoingInvoiceId, status: 'ready' });

  const outgoingPosted = await requestJson(
    state,
    session,
    '/api/v1/pro/accounting/outgoing-invoices/post',
    undefined,
    {
      method: 'POST',
      body: {
        reason: 'Playwright post outgoing invoice',
        invoiceId: outgoingInvoiceId,
        reservationId: numberReservation.reservationId,
      },
    },
  );
  expect(outgoingPosted).toMatchObject({ sourceType: 'outgoing_invoice', sourceId: outgoingInvoiceId, status: 'ready' });

  // Prove the persisted immutable tax evidence reaches DATEV fields 40/41/43
  // rather than only testing the generic header/parameter path above.
  const taxCases = await requestJson(state, session, '/api/v1/pro/accounting/tax-cases');
  expect(taxCases).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'EU_B2B_SERVICE_RC', requiresCountry: true, requiresCounterpartyVatId: true, requiresEvidence: true })]));
  {
    const specialId = `playwright-eu-rc-${Date.now()}`;
    const specialReservation = await requestJson(state, session, '/api/v1/pro/numbers/reserve', undefined, { method: 'POST', body: { kind: 'invoice' } });
    await requestJson(state, session, '/api/v1/pro/invoices', undefined, { method: 'POST', body: { reason: 'Playwright persist EU reverse-charge evidence', invoice: {
      kind: 'invoice', id: specialId, clientId: outgoingClientId, clientNumber: outgoingClient?.customerNumber, number: specialReservation.number, client: outgoingClient?.company, clientEmail: outgoingClient?.email, clientAddress: outgoingClient?.address,
      taxMode: 'intra_eu_service_reverse_charge', taxMeta: { buyerCountryCode: 'AT', buyerVatId: 'ATU12345678', destinationVatRate: 20, datevSachverhaltLl: '13', datevEvidenceType: 'reverse_charge', datevEvidenceReference: 'playwright-proof' },
      taxSnapshot: { vatRateApplied: 0, vatAmount: 0, netAmount: 100, grossAmount: 100, einvoiceCategoryCode: 'S', vatBreakdown: [{ rate: 0, netAmount: 100, vatAmount: 0, taxCaseKey: 'EU_B2B_SERVICE_RC' }] }, date: '2026-03-09', dueDate: '2026-03-23', amount: 100, status: 'open', dunningLevel: 0, items: [{ description: 'Playwright EU service', quantity: 1, price: 100, total: 100, taxRate: 0 }], payments: [], history: [],
    } } });
    await requestJson(state, session, '/api/v1/pro/numbers/finalize', undefined, { method: 'POST', body: { reservationId: specialReservation.reservationId, documentId: specialId } });
    const specialPosted = await requestJson(state, session, '/api/v1/pro/accounting/outgoing-invoices/post', undefined, { method: 'POST', body: { reason: 'Playwright post EU reverse-charge evidence', invoiceId: specialId, reservationId: specialReservation.reservationId } });
    expect(specialPosted).toMatchObject({ status: 'ready' });
    const specialExport = await requestText(state, session, '/api/v1/pro/accounting/datev/export.csv', { from: '2026-03-09', to: '2026-03-09', consultantNumber: '1001', clientNumber: '7', fiscalYearStart: '2026-01-01', accountLength: 4, encoding: 'utf8-bom', reason: 'Playwright EU DATEV evidence' });
    expect(specialExport.body).toContain('ATU12345678');
    expect(specialExport.body).toContain('20,00');
    expect(specialExport.body).toContain(';13;');
  }


  const outgoingRefetched = await requestJson(
    state,
    session,
    `/api/v1/pro/invoices/${encodeURIComponent(outgoingInvoiceId)}`,
  );
  expect(outgoingRefetched).toMatchObject({ id: outgoingInvoiceId, number: numberReservation.number, status: 'open', amount: 119 });

  const backfillPreview = await requestJson(state, session, '/api/v1/pro/accounting/backfill/preview');
  expect(backfillPreview).toMatchObject({
    runId: expect.any(String),
    status: 'preview',
    confirmationHash: expect.any(String),
  });
  const backfillResult = await requestJson(
    state,
    session,
    '/api/v1/pro/accounting/backfill/confirm',
    undefined,
    {
      method: 'POST',
      body: {
        reason: 'Playwright confirm accounting backfill',
        runId: backfillPreview.runId,
        confirmationHash: backfillPreview.confirmationHash,
      },
    },
  );
  expect(backfillResult).toMatchObject({ runId: backfillPreview.runId, status: 'completed' });
  expect(Number.isInteger(backfillResult.postedCount)).toBe(true);
  expect(Number.isInteger(backfillResult.unresolvedCount)).toBe(true);
  const backfillRetry = await requestJson(
    state,
    session,
    '/api/v1/pro/accounting/backfill/confirm',
    undefined,
    {
      method: 'POST',
      body: {
        reason: 'Playwright retry accounting backfill',
        runId: backfillPreview.runId,
        confirmationHash: backfillPreview.confirmationHash,
      },
    },
  );
  expect(backfillRetry).toEqual(backfillResult);

  const outgoingJournalBeforeReverse = await requestJson(state, session, '/api/v1/pro/accounting/journal');
  const outgoingJournalEntry = outgoingJournalBeforeReverse.find(
    (entry) => entry.sourceKey === `outgoing-invoice:${outgoingInvoiceId}`,
  );
  expect(outgoingJournalEntry).toMatchObject({ status: 'posted', sourceType: 'outgoing_invoice' });
  const outgoingJournalId = outgoingJournalEntry?.id;
  if (!outgoingJournalId) {
    throw new Error('Posted outgoing invoice journal entry was not persisted.');
  }

  const reversal = await requestJson(
    state,
    session,
    '/api/v1/pro/accounting/documents/reverse',
    undefined,
    {
      method: 'POST',
      body: {
        reason: 'Playwright reverse outgoing invoice',
        documentType: 'outgoing_invoice',
        documentId: outgoingInvoiceId,
        postingDate: '2026-03-09',
      },
    },
  );
  expect(reversal).toMatchObject({ ok: true, reversalEntryId: expect.any(String) });

  const journalAfterReverse = await requestJson(state, session, '/api/v1/pro/accounting/journal');
  expect(journalAfterReverse).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: outgoingJournalId, status: 'reversed', reversedEntryId: reversal.reversalEntryId }),
      expect.objectContaining({ id: reversal.reversalEntryId, status: 'posted', sourceType: 'reversal' }),
    ]),
  );
  const outgoingAfterReverse = await requestJson(
    state,
    session,
    `/api/v1/pro/invoices/${encodeURIComponent(outgoingInvoiceId)}`,
  );
  expect(outgoingAfterReverse).toMatchObject({ id: outgoingInvoiceId, status: 'cancelled' });

  const openItems = await requestJson(state, session, '/api/v1/pro/accounting/open-items');
  const incomingOpenItem = openItems.find((item) => item.sourceType === 'incoming_invoice' && item.sourceId === incomingInvoiceId);
  expect(incomingOpenItem).toMatchObject({ partyType: 'creditor', originalAmount: 119, status: 'open' });
  const openItemId = incomingOpenItem?.id;
  if (!openItemId) {
    throw new Error('Posted incoming invoice did not persist an open item.');
  }

  const allocationEventId = `playwright-allocation-${suffix}`;
  const paymentBody = {
    reason: 'Playwright allocate OPOS payment',
    payment: {
      paymentId: `playwright-payment-${suffix}`,
      sourceType: 'manual',
      sourceId: `playwright-payment-source-${suffix}`,
      partyType: 'creditor',
      partyId: vendorId,
      paymentDate: '2026-03-07',
      amount: 119,
      bankAccountNumber: '1200',
      method: 'Bank',
      allocations: [{ openItemId, amount: 119 }],
      allocationEventId,
    },
  };
  const payment = await requestJson(
    state,
    session,
    '/api/v1/pro/accounting/open-items/payments',
    undefined,
    { method: 'POST', body: paymentBody },
  );
  expect(payment).toMatchObject({ amount: 119, allocatedAmount: 119, residualAmount: 0, status: 'allocated' });

  const paymentRetry = await requestJson(
    state,
    session,
    '/api/v1/pro/accounting/open-items/payments',
    undefined,
    { method: 'POST', body: paymentBody },
  );
  expect(paymentRetry).toMatchObject({ id: payment.id, amount: 119, allocatedAmount: 119, residualAmount: 0, status: 'allocated' });

  const outgoingOpenItemsAfterReverse = await requestJson(state, session, '/api/v1/pro/accounting/open-items');
  expect(outgoingOpenItemsAfterReverse).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ sourceType: 'outgoing_invoice', sourceId: outgoingInvoiceId, status: 'unresolved' }),
    ]),
  );

  const susaReport = await requestJson(state, session, '/api/v1/pro/accounting/reports/susa', {
    asOfDate: '2026-03-31',
  });
  expect(susaReport).toMatchObject({ asOfDate: '2026-03-31', rows: expect.any(Array) });
  expect(Number.isFinite(susaReport.totals.debit)).toBe(true);
  expect(Number.isFinite(susaReport.totals.credit)).toBe(true);
  expect(Number.isFinite(susaReport.totals.balance)).toBe(true);

  const bilanzReport = await requestJson(state, session, '/api/v1/pro/accounting/reports/bilanz', {
    asOfDate: '2026-03-31',
  });
  expect(bilanzReport).toMatchObject({ snapshot: { asOfDate: '2026-03-31' }, assets: expect.any(Array), liabilities: expect.any(Array) });
  expect(Number.isFinite(bilanzReport.totals.assets)).toBe(true);
  expect(Number.isFinite(bilanzReport.totals.liabilities)).toBe(true);
  expect(Number.isFinite(bilanzReport.totals.delta)).toBe(true);

  const reportAssertions = [
    { reportType: 'bwa01', path: '/api/v1/pro/accounting/reports/bwa01', query: { from: '2026-03-01', to: '2026-03-31' }, keys: ['revenue', 'material-expense', 'operating-result'] },
    { reportType: 'hgb-guv', path: '/api/v1/pro/accounting/reports/hgb-guv', query: { from: '2026-03-01', to: '2026-03-31' }, keys: ['revenue', 'material', 'annual-result'] },
    { reportType: 'hgb-bilanz', path: '/api/v1/pro/accounting/reports/hgb-bilanz', query: { asOfDate: '2026-03-31' }, keys: ['assets.current', 'equity', 'liabilities'] },
  ];
  for (const reportAssertion of reportAssertions) {
    const mappingHealth = await requestJson(state, session, '/api/v1/pro/accounting/mappings/health', {
      chart: 'SKR03',
      reportType: reportAssertion.reportType,
      asOfDate: '2026-03-31',
    });
    expect(mappingHealth).toMatchObject({ chart: 'SKR03', reportType: reportAssertion.reportType, unmapped: [] });
    const reportPositions = await requestJson(state, session, '/api/v1/pro/accounting/mappings/positions', { reportType: reportAssertion.reportType, asOfDate: '2026-03-31' });
    for (const key of reportAssertion.keys) expect(reportPositions).toEqual(expect.arrayContaining([expect.objectContaining({ key })]));

    const report = await requestJson(state, session, reportAssertion.path, reportAssertion.query);
    expect(report.mappingHealth).toMatchObject({ unmappedAccounts: [], blocking: false });
    for (const key of reportAssertion.keys) expect(report.rows ?? [...(report.assets ?? []), ...(report.liabilities ?? [])]).toEqual(expect.arrayContaining([expect.objectContaining({ position: key })]));
  }
};

export const runProRouteGuardScenario = async (page) => {
  const state = await readServerHarnessState();
  const proSession = await ensureHarnessSession(state, {
    product: 'pro',
    ...proOwner,
  });

  await seedHarnessProTenant(state, {
    tenantId: proSession.tenantId,
    namespace: 'route-guard-regression',
  });

  const liteSession = await ensureHarnessSession(state, {
    product: 'lite',
    ...liteOwner,
  });

  await openProShell(page, state, {
    route: 'documents',
    session: liteSession,
  });

  await expect(page.getByRole('button', { name: 'In Pro anmelden' })).toBeVisible();
  await expect
    .poll(async () => {
      return page.evaluate((storageKey) => window.localStorage.getItem(storageKey), PRO_SESSION_STORAGE_KEY);
    })
    .toBeNull();

  await page.getByLabel('E-Mail').fill(proOwner.email);
  await page.getByLabel('Passwort').fill(proOwner.password);
  await page.getByRole('button', { name: 'In Pro anmelden' }).click();

  await expect(page).toHaveURL(/#\/documents$/);
  await expect(page.getByRole('heading', { name: 'Vertrieb und Export' })).toBeVisible();
  await expect(page.getByText('Beta Digital AG').first()).toBeVisible();
};
