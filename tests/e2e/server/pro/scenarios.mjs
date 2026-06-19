import { expect } from '@playwright/test';
import { readServerHarnessState } from '../harness.mjs';
import {
  PRO_SESSION_STORAGE_KEY,
  createOwnerCredentials,
  ensureHarnessSession,
  openProShell,
  requestJson,
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

  await expect(page.getByText('Billme Pro Web').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /Pro-Mandant initialisieren|Mit Billme Pro verbinden/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Initialisieren & anmelden|Anmelden/ })).toBeVisible();
  await expect(page.getByText('billme-server-api')).toBeVisible();
};

export const runProOfferPersistenceScenario = async () => {
  const state = await readServerHarnessState();
  const session = await ensureHarnessSession(state, {
    product: 'pro',
    ...proOwner,
  });
  const namespace = `offer-persistence-${Date.now()}`;
  await seedHarnessProTenant(state, {
    tenantId: session.tenantId,
    namespace,
  });

  const clients = await requestJson(state, session, '/api/v1/pro/clients');
  const client = clients[0];
  expect(client).toBeTruthy();

  const offerId = `e2e-offer-items-${Date.now()}`;
  const offer = {
    kind: 'offer',
    id: offerId,
    tenantId: session.tenantId,
    clientId: client.id,
    ...(client.customerNumber != null ? { clientNumber: client.customerNumber } : {}),
    number: `E2E-ANG-${Date.now()}`,
    client: client.company,
    clientEmail: client.email,
    clientAddress: client.address,
    date: '2026-06-19',
    validUntil: '2026-07-19',
    amount: 579,
    status: 'open',
    items: [
      { description: 'Server E2E offer line alpha', quantity: 2, price: 123, total: 246 },
      { description: 'Server E2E offer line beta', quantity: 3, price: 111, total: 333 },
    ],
    history: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  const saved = await requestJson(state, session, '/api/v1/pro/offers', {
    method: 'POST',
    body: {
      offer,
      reason: 'server e2e offer item persistence',
    },
  });
  expect(saved.items).toHaveLength(2);
  expect(saved.items.map((item) => item.description)).toEqual([
    'Server E2E offer line alpha',
    'Server E2E offer line beta',
  ]);

  const refetched = await requestJson(state, session, `/api/v1/pro/offers/${encodeURIComponent(offerId)}`);
  expect(refetched?.items).toHaveLength(2);
  expect(refetched.items.map((item) => item.description)).toEqual([
    'Server E2E offer line alpha',
    'Server E2E offer line beta',
  ]);
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
