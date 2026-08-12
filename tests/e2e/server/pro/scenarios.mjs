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

const sectionByTitle = (page, title) =>
  page.locator('section.section-card').filter({
    has: page.getByRole('heading', { name: title }),
  });

const completeProOnboardingIfVisible = async (page, scenarioKey = 'server-pro') => {
  const heading = page.getByRole('heading', { name: 'Richte deinen Firmenkopf ein' });
  if (!(await heading.isVisible().catch(() => false))) {
    return;
  }

  const slug = scenarioKey.replace(/[^a-z0-9-]+/gi, '-').toLowerCase();

  await page.getByLabel('Firmenname').fill(`Billme Pro ${slug}`);
  await page.getByLabel('Inhaber oder Geschaeftsfuehrung').fill('Billme Pro Owner');
  await page.getByLabel('Strasse und Hausnummer').fill('Teststrasse 1');
  await page.getByLabel('PLZ').fill('10115');
  await page.getByLabel('Stadt').fill('Berlin');
  await page.getByLabel('E-Mail fuer Angebote und Rechnungen').fill(`pro+${slug}@billme-e2e.local`);
  await page.getByRole('button', { name: 'Weiter zu Abrechnung' }).click();

  await page.getByLabel('Steuernummer').fill('12/345/67890');
  await page.getByLabel('Zahlungsziel in Tagen').fill('14');
  await page.getByLabel('Rechnungs-Praefix').fill('RE-%Y-');
  await page.getByLabel('Angebots-Praefix').fill('ANG-%Y-');
  await page.getByRole('button', { name: 'Weiter zu Feinschliff' }).click();

  await page.getByLabel('Bankname').fill('Berliner Testbank');
  await page.getByLabel('IBAN').fill('DE12100500001234567890');
  await page.getByRole('button', { name: 'Workspace freischalten' }).click();
  await expect(heading).toHaveCount(0);
};

export const runProSmokeScenario = async (page) => {
  const state = await readServerHarnessState();

  await page.goto(state.urls.webPro, { waitUntil: 'networkidle' });

  await expect(page.getByText('Billme Pro · Browser Shell')).toBeVisible();
  await expect(page.getByRole('button', { name: /Pro-Owner anlegen|In Pro anmelden/ })).toBeVisible();
  await expect(page.getByText('billme-server-api')).toBeVisible();
  await expect(page.getByText(/Noch kein Owner vorhanden|Bereits \d+ Nutzer im Pro-Scope\./)).toBeVisible();
};

export const runProAuthRestoreScenario = async (page) => {
  const state = await readServerHarnessState();
  await openProShell(page, state, { route: 'accounting' });

  await expect(page.getByText('Billme Pro · Browser Shell')).toBeVisible();
  await page.getByLabel('Vollständiger Name').fill(proOwner.fullName);
  await page.getByLabel('E-Mail').fill(proOwner.email);
  await page.getByLabel('Passwort').fill(proOwner.password);

  const bootstrapButton = page.getByRole('button', { name: 'Pro-Owner anlegen' });
  const loginButton = page.getByRole('button', { name: 'In Pro anmelden' });

  if (await bootstrapButton.isVisible().catch(() => false)) {
    await bootstrapButton.click();
    await expect(page.getByText(`Owner ${proOwner.fullName} angelegt und angemeldet.`)).toBeVisible();
  } else {
    await loginButton.click();
    await expect(page.getByText(`Angemeldet als ${proOwner.fullName}.`)).toBeVisible();
  }

  await completeProOnboardingIfVisible(page, 'auth-restore');

  await expect(page).toHaveURL(/#\/accounting$/);
  await expect(page.getByRole('heading', { name: 'Ledger, Regeln und Workflow-Snapshots' })).toBeVisible();

  await page.reload({ waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/#\/accounting$/);
  await expect(page.getByText(`Sitzung: ${proOwner.fullName}`)).toBeVisible();

  await page.getByRole('button', { name: 'Logout' }).click();
  await expect(page.getByRole('button', { name: 'In Pro anmelden' })).toBeVisible();
  await expect(page.getByText(/Bereits \d+ Nutzer im Pro-Scope\./)).toBeVisible();

  await page.getByLabel('E-Mail').fill(proOwner.email);
  await page.getByLabel('Passwort').fill(proOwner.password);
  await page.getByRole('button', { name: 'In Pro anmelden' }).click();

  await expect(page).toHaveURL(/#\/accounting$/);
  await expect(page.getByText(`Angemeldet als ${proOwner.fullName}.`)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Ledger, Regeln und Workflow-Snapshots' })).toBeVisible();
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
    route: 'catalog',
    session,
  });

  const articleSection = sectionByTitle(page, 'Leistungs- und Produktkatalog');
  const accountSection = sectionByTitle(page, 'Bankkonten und Default-SKR-Zuordnung');
  const templateSection = sectionByTitle(page, 'Serverweite Templates und aktive Auswahl');

  await expect(page.getByRole('heading', { name: 'Leistungs- und Produktkatalog' })).toBeVisible();
  await expect(articleSection.getByText('Senior Consulting')).toBeVisible();
  await expect(accountSection.getByText('Hauptkonto')).toBeVisible();
  await expect(templateSection.locator('strong')).toContainText('Server-mode Rechnung');

  const articleTitle = `Playwright Katalog ${Date.now()}`;
  await articleSection.getByLabel('Titel').fill(articleTitle);
  await articleSection.getByLabel('Preis').fill('321.5');
  await articleSection.getByLabel('Einheit').fill('Paket');
  await articleSection.getByLabel('Kategorie').fill('Testing');
  await articleSection.getByLabel('Steuer %').fill('19');
  await articleSection.getByLabel('Beschreibung').fill('Browser-seitig angelegter Regressionseintrag');
  await articleSection.getByRole('button', { name: 'Artikel speichern' }).click();
  await expect(page.getByText('Artikel gespeichert.')).toBeVisible();
  await expect(articleSection.getByText(articleTitle)).toBeVisible();

  const accountName = `Playwright Konto ${Date.now()}`;
  await accountSection.getByLabel('Name').fill(accountName);
  await accountSection.getByLabel('IBAN').fill('DE44500105175407324931');
  await accountSection.getByLabel('Saldo').fill('4500');
  await accountSection.getByLabel('Default SKR-Konto').fill('1200');
  await accountSection.getByLabel('Kontoart').selectOption('paypal');
  await accountSection.getByLabel('Farbe').fill('#22577a');
  await accountSection.getByRole('button', { name: 'Bankkonto speichern' }).click();
  await expect(page.getByText('Bankkonto gespeichert.')).toBeVisible();
  await expect(accountSection.getByText(accountName)).toBeVisible();

  const templateName = `Playwright Vorlage ${Date.now()}`;
  await templateSection.getByLabel('Typ').selectOption('invoice');
  await templateSection.getByLabel('Name').fill(templateName);
  await templateSection.getByRole('button', { name: 'Leere Vorlage speichern' }).click();
  await expect(page.getByText('Vorlage gespeichert.')).toBeVisible();

  const templateRow = templateSection.locator('tr').filter({ hasText: templateName });
  await expect(templateRow).toBeVisible();
  await templateRow.getByRole('button', { name: 'Aktiv setzen' }).click();
  await expect(page.getByText('Aktive Rechnungsvorlage aktualisiert.')).toBeVisible();
  await expect(templateSection.locator('.static-field')).toContainText(templateName);

  await page.reload({ waitUntil: 'networkidle' });
  await expect(page).toHaveURL(/#\/catalog$/);
  await expect(articleSection.getByText(articleTitle)).toBeVisible();
  await expect(accountSection.getByText(accountName)).toBeVisible();
  await expect(templateSection.locator('.static-field')).toContainText(templateName);
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
  });

  await openProShell(page, state, {
    route: 'accounting',
    session,
  });

  const mappingSection = sectionByTitle(page, 'Tax Cases auf Konten abbilden');
  const rulesSection = sectionByTitle(page, 'Rule-based Assignment im Browser pflegen');
  const accountingSection = sectionByTitle(page, 'Ledger, Regeln und Workflow-Snapshots');

  await expect(accountingSection.getByText('Diese Webfläche ersetzt lokale Dateisystem-/IPC-Annahmen')).toBeVisible();
  await expect(mappingSection.getByRole('cell', { name: 'DE_STD_19' }).first()).toBeVisible();
  await expect(rulesSection.getByText('Hosting').first()).toBeVisible();

  await mappingSection.getByLabel('Steuerfall').selectOption('DE_KU19');
  await mappingSection.getByLabel('Rolle').selectOption('input_tax');
  await mappingSection.getByLabel('Account').fill('1576');
  await mappingSection.getByLabel('DATEV BU Key').fill('93');
  await mappingSection.getByRole('button', { name: 'Mapping speichern' }).click();
  await expect(page.getByText('Steuer-Mapping gespeichert.')).toBeVisible();

  const mappings = await requestJson(
    state,
    session,
    '/api/v1/pro/accounting/tax-case-account-mappings',
    { chart: 'SKR03' },
  );
  expect(
    mappings.some(
      (mapping) =>
        mapping.taxCaseKey === 'DE_KU19' &&
        mapping.role === 'input_tax' &&
        mapping.accountNumber === '1576',
    ),
  ).toBe(true);

  const ruleNeedle = `Playwright Rule ${Date.now()}`;
  await rulesSection.getByLabel('Priorität').fill('42');
  await rulesSection.getByLabel('Feld').selectOption('purpose');
  await rulesSection.getByLabel('Operator').selectOption('contains');
  await rulesSection.getByLabel('Suchwert').fill(ruleNeedle);
  await rulesSection.getByLabel('Zielkonto').fill('8400');
  await rulesSection.getByLabel('Flow').selectOption('income');
  await rulesSection.getByRole('button', { name: 'Regel speichern' }).click();
  await expect(page.getByText('Vorschlagsregel gespeichert.')).toBeVisible();

  const rulesAfterCreate = await requestJson(
    state,
    session,
    '/api/v1/pro/accounting/account-suggestion-rules',
    { chart: 'SKR03', activeOnly: 'false' },
  );
  const createdRule = rulesAfterCreate.find((rule) => rule.value === ruleNeedle);
  expect(createdRule?.targetAccountNumber).toBe('8400');

  const workflowBefore = await requestJson(state, session, '/api/v1/pro/workflow');
  await accountingSection.getByRole('button', { name: 'Beispiel-Workflow anlegen' }).click();
  await expect(page.getByText('Beispiel-Workflow angelegt.')).toBeVisible();
  await expect(page.locator('.workspace-frame')).toBeVisible();
  await expect
    .poll(async () => {
      const workflowEntries = await requestJson(state, session, '/api/v1/pro/workflow');
      return workflowEntries.length;
    })
    .toBe(workflowBefore.length + 1);

  const createdRuleRow = rulesSection.locator('tr').filter({ hasText: ruleNeedle });
  await createdRuleRow.getByRole('button', { name: 'Löschen' }).click();
  await expect(page.getByText('Vorschlagsregel gelöscht.')).toBeVisible();
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

  const guvReport = await requestJson(state, session, '/api/v1/pro/accounting/reports/guv', {
    from: '2026-03-05',
    to: '2026-03-05',
  });
  expect(Array.isArray(guvReport.rows)).toBe(true);
  expect(Number.isFinite(guvReport.netResult)).toBe(true);

  const datevExport = await requestText(state, session, '/api/v1/pro/accounting/datev/export.csv', {
    from: '2026-03-05',
    to: '2026-03-05',
    reason: 'Playwright immutable DATEV export',
  });
  expect(datevExport.body).toContain('date;belegfeld1;buchungstext;konto;gegenkonto');
  expect(datevExport.body).toContain('Playwright canonical persisted booking');
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

  const mappingRequests = [
    ['accounts_payable', '1200'],
    ['input_vat', '3125'],
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
