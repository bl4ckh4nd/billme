import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readServerHarnessState } from '../harness.mjs';
import {
  apiJson,
  applyLiteSession,
  createLiteIdentity,
  getLiteRuntime,
  liteAppUrl,
  litePassword,
  liteSessionStorageKey,
  provisionLiteSession,
  readLiteStoredSession,
  writeLiteStoredSession,
} from './support.mjs';

export const runLiteSmokeScenario = async (page) => {
  const state = await readServerHarnessState();

  await page.goto(state.urls.web, { waitUntil: 'networkidle' });

  await expect(page.getByRole('heading', { name: /Billme einrichten|Willkommen zurück/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^(Konto anlegen und loslegen|Anmelden)$/ })).toBeVisible();
  await expect(page.getByText(/^Verbunden mit /)).toBeVisible();
};

export const runLiteAuthScenario = async (page, scenarioKey = 'auth-flow') => {
  const { state } = await getLiteRuntime();
  const identity = createLiteIdentity(scenarioKey);

  await page.goto(state.urls.web, { waitUntil: 'networkidle' });

  const bootstrapButton = page.getByRole('button', { name: 'Konto anlegen und loslegen' });
  const loginButton = page.getByRole('button', { name: 'Anmelden', exact: true });
  await expect(bootstrapButton.or(loginButton)).toBeVisible();

  if (await bootstrapButton.isVisible().catch(() => false)) {
    await expect(page.getByRole('heading', { name: 'Billme einrichten' })).toBeVisible();
    await page.getByLabel('Dein Name').fill(identity.fullName);
    await page.getByLabel('E-Mail-Adresse').fill(identity.email);
    await page.getByLabel('Passwort', { exact: true }).fill(litePassword);
    await bootstrapButton.click();
  } else {
    await expect(page.getByRole('heading', { name: 'Willkommen zurück' })).toBeVisible();
    await page.getByLabel('E-Mail-Adresse').fill(identity.email);
    await page.getByLabel('Passwort', { exact: true }).fill(litePassword);
    await loginButton.click();
  }

  await expect(page.getByRole('button', { name: 'Abmelden' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kunden' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Rechnungen & Angebote' })).toBeVisible();

  const storedSession = await readLiteStoredSession(page);
  expect(storedSession).toMatchObject({
    user: {
      email: identity.email,
      fullName: identity.fullName,
    },
  });

  await page.getByRole('button', { name: 'Abmelden' }).click();
  await expect(page.getByRole('heading', { name: 'Willkommen zurück' })).toBeVisible();
  await expect(page.getByText('Du wurdest abgemeldet.')).toBeVisible();

  await page.getByLabel('E-Mail-Adresse').fill(identity.email);
  await page.getByLabel('Passwort', { exact: true }).fill(litePassword);
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click();

  await expect(page.getByRole('button', { name: 'Abmelden' })).toBeVisible();
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByRole('button', { name: 'Abmelden' })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`^${state.urls.web}(?:/$|/#/?)$`));

  await writeLiteStoredSession(page, {
    token: 'stale-session-token',
    user: storedSession.user,
  });
  await page.goto(state.urls.web, { waitUntil: 'networkidle' });
  await page.goto(liteAppUrl(state, '/documents'), { waitUntil: 'networkidle' });

  await expect(page.getByRole('heading', { name: 'Willkommen zurück' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Anmelden', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Abmelden' })).toHaveCount(0);

  const clearedSession = await page.evaluate((key) => window.localStorage.getItem(key), liteSessionStorageKey);
  expect(clearedSession).toBeNull();
};

export const runLiteRegressionScenario = async (page, scenarioKey = 'regressions') => {
  const runtime = await getLiteRuntime();
  const identity = createLiteIdentity(scenarioKey);
  const { session, seed } = await provisionLiteSession({
    apiBaseUrl: runtime.state.urls.api,
    databaseUrl: runtime.databaseUrl,
    ...identity,
  });

  await applyLiteSession(page, runtime.state, session, '/');

  await page.getByRole('button', { name: /Suchen/ }).first().click();
  await page.getByRole('combobox', { name: 'Suche und Befehle' }).fill(seed.clients[0].customerNumber);
  const clientSearchResult = page
    .locator('button')
    .filter({ hasText: seed.clients[0].company })
    .filter({ hasText: seed.clients[0].customerNumber })
    .first();
  await expect(clientSearchResult).toBeVisible();
  await clientSearchResult.click();

  await expect(page).toHaveURL(new RegExp(`/#/clients\\?id=${seed.clients[0].id}$`));
  await expect(page.getByText(seed.clients[0].company)).toBeVisible();

  await page.goto(liteAppUrl(runtime.state, '/documents'), { waitUntil: 'networkidle' });
  await expect(page.getByText(seed.invoices[0].number)).toBeVisible();
  await page.getByRole('checkbox', { name: `${seed.invoices[0].number} auswählen`, exact: true }).check();
  await expect(page.getByRole('checkbox', { name: `${seed.invoices[0].number}: Auswahl entfernen`, exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  expect(await download.failure()).toBeNull();
  const artifact = new URL('../../../../test-results/server-lite-bulk-invoice.pdf', import.meta.url);
  await download.saveAs(artifact.pathname);
  await expect(page.getByText(seed.invoices[0].number)).toBeVisible();
};

export const runLiteVatPersistenceScenario = async (scenarioKey = 'vat-persistence') => {
  const runtime = await getLiteRuntime();
  const identity = createLiteIdentity(scenarioKey);
  const { session, seed } = await provisionLiteSession({
    apiBaseUrl: runtime.state.urls.api,
    databaseUrl: runtime.databaseUrl,
    ...identity,
  });
  const source = await apiJson(runtime.state, session, `/api/v1/lite/invoices/${seed.invoices[0].id}`);
  const invoice = {
    ...source,
    id: randomUUID(), number: `VAT-${randomUUID()}`, status: 'draft', payments: [], layout: undefined,
    taxMode: 'intra_eu_service_reverse_charge',
    taxMeta: {
      sellerCountryCode: 'DE',
      buyerCountryCode: 'AT',
      buyerVatId: 'ATU12345678',
      taxRuleConfirmed: true,
    },
    taxSnapshot: {
      netAmount: source.amount,
      vatAmount: 0,
      grossAmount: source.amount,
      vatRateApplied: 0,
      einvoiceCategoryCode: 'AE',
      label: 'EU-Leistung Reverse Charge',
      taxNotice: 'Steuerschuldnerschaft des Leistungsempfängers (Reverse Charge)',
      taxRuleConfirmed: true,
      vatBreakdown: [{ rate: 0, netAmount: source.amount, vatAmount: 0 }],
    },
    items: source.items.map((item, index) => ({
      ...item,
      taxRate: index === 0 ? 7 : item.taxRate,
    })),
  };

  const saved = await apiJson(runtime.state, session, '/api/v1/lite/invoices', {
    method: 'POST',
    body: { invoice, reason: 'Verify line VAT persistence' },
  });
  expect(saved.items[0]?.taxRate).toBe(7);

  const refetched = await apiJson(runtime.state, session, `/api/v1/lite/invoices/${invoice.id}`);
  expect(refetched.items[0]?.taxRate).toBe(7);
  expect(refetched.taxMode).toBe(invoice.taxMode);
  expect(refetched.taxMeta).toEqual(invoice.taxMeta);
  expect(refetched.taxSnapshot).toEqual(invoice.taxSnapshot);

  const sourceOffer = await apiJson(runtime.state, session, `/api/v1/lite/offers/${seed.offers[0].id}`);
  const offer = {
    ...sourceOffer,
    id: randomUUID(), number: `VAT-OFFER-${randomUUID()}`, status: 'draft', share: undefined, layout: undefined,
    taxMode: 'export_third_country',
    taxMeta: { sellerCountryCode: 'DE', buyerCountryCode: 'CH', taxRuleConfirmed: true },
    taxSnapshot: {
      netAmount: sourceOffer.amount,
      vatAmount: 0,
      grossAmount: sourceOffer.amount,
      vatRateApplied: 0,
      einvoiceCategoryCode: 'G',
      label: 'Drittlandsausfuhr',
      taxNotice: 'Steuerfreie Ausfuhrlieferung',
      taxRuleConfirmed: true,
      vatBreakdown: [{ rate: 0, netAmount: sourceOffer.amount, vatAmount: 0 }],
    },
  };
  await apiJson(runtime.state, session, '/api/v1/lite/offers', {
    method: 'POST',
    body: { offer, reason: 'Verify offer tax persistence' },
  });
  const refetchedOffer = await apiJson(runtime.state, session, `/api/v1/lite/offers/${offer.id}`);
  expect(refetchedOffer.taxMode).toBe(offer.taxMode);
  expect(refetchedOffer.taxMeta).toEqual(offer.taxMeta);
  expect(refetchedOffer.taxSnapshot).toEqual(offer.taxSnapshot);
};

export const runLiteWorkflowScenario = async (page, scenarioKey = 'workflow') => {
  const runtime = await getLiteRuntime();
  const identity = createLiteIdentity(scenarioKey);
  const { session, seed } = await provisionLiteSession({
    apiBaseUrl: runtime.state.urls.api,
    databaseUrl: runtime.databaseUrl,
    ...identity,
  });

  expect(seed).not.toBeNull();
  await applyLiteSession(page, runtime.state, session, '/clients');

  await expect(page.getByRole('heading', { name: 'Kunden' })).toBeVisible();
  await expect(page.getByRole('row', { name: `${seed.clients[0].company} öffnen`, exact: true }).first()).toBeVisible();

  const createClientButton = page.getByRole('button', { name: 'Neuer Kunde', exact: true });
  await createClientButton.click();

  const clientEditor = page.locator('div').filter({ has: page.getByRole('heading', { name: 'Neuer Kunde' }) }).first();
  await expect(clientEditor).toBeVisible();
  await clientEditor.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByRole('button', { name: 'Firma ist erforderlich.', exact: true })).toBeVisible();

  const companyName = `Lite Browserkunde ${identity.namespace}`;
  await clientEditor.getByLabel('Firma', { exact: true }).fill(companyName);
  await clientEditor.getByLabel('Ansprechpartner', { exact: true }).first().fill('Regression Runner');
  await clientEditor.getByLabel('Telefon', { exact: true }).fill('+49 30 55555555');
  await clientEditor.getByLabel('E-Mail-Adresse', { exact: true }).fill(`billing+${identity.namespace}@billme-e2e.local`);
  await clientEditor.getByLabel('Straße', { exact: true }).fill('Teststrasse 42');
  await clientEditor.getByLabel('PLZ', { exact: true }).fill('10115');
  await clientEditor.getByLabel('Stadt', { exact: true }).fill('Berlin');
  await clientEditor.getByRole('button', { name: 'Speichern' }).click();

  let createdClient = null;
  await expect
    .poll(async () => {
      const clients = await apiJson(runtime.state, session, '/api/v1/lite/clients');
      createdClient = clients.find((client) => client.company === companyName) ?? null;
      return Boolean(createdClient);
    })
    .toBe(true);
  expect(createdClient).toBeTruthy();
  if (createdClient.customerNumber) {
    expect(createdClient.customerNumber.startsWith(seed.settings.numbers.customerPrefix)).toBe(true);
  }

  await page.goto(liteAppUrl(runtime.state, `/clients?id=${encodeURIComponent(createdClient.id)}`), {
    waitUntil: 'networkidle',
  });
  await expect(page.getByRole('heading', { name: companyName, level: 1, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Neue Rechnung' }).click();
  await expect(page.getByRole('combobox', { name: 'Kunde auswählen' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Kunde auswählen' })).toHaveValue(companyName);
  const createdInvoice = await page.evaluate(async ({ clientId, description, price }) => {
    const api = globalThis.billmeApi;
    if (!api) {
      throw new Error('Billme API is not available in the Lite web shell.');
    }
    const draft = await api.documents.createFromClient({ kind: 'invoice', clientId });
    const reservationId = draft.numberReservationId;
    const persisted = {
      ...draft,
      amount: price,
      items: [{ kind: 'item', description, quantity: 1, price, total: price }],
    };

    const saved = await api.invoices.upsert({ invoice: persisted, reason: 'create' });

    return saved;
  }, {
    clientId: createdClient.id,
    description: 'Lite Regression Invoice',
    price: 250,
  });
  expect(createdInvoice.number.startsWith(seed.settings.numbers.invoicePrefix)).toBe(true);

  const createdOffer = await page.evaluate(async ({ clientId, description, price }) => {
    const api = globalThis.billmeApi;
    if (!api) {
      throw new Error('Billme API is not available in the Lite web shell.');
    }
    const draft = await api.documents.createFromClient({ kind: 'offer', clientId });
    const reservationId = draft.numberReservationId;
    const persisted = {
      ...draft,
      amount: price,
      items: [{ kind: 'item', description, quantity: 1, price, total: price }],
    };

    const saved = await api.offers.upsert({ offer: persisted, reason: 'create' });

    return saved;
  }, {
    clientId: createdClient.id,
    description: 'Lite Regression Offer',
    price: 450,
  });
  expect(createdOffer.number.startsWith(seed.settings.numbers.offerPrefix)).toBe(true);

  await page.goto(liteAppUrl(runtime.state, '/documents'), { waitUntil: 'networkidle' });
  await page.getByRole('radio', { name: 'Angebote' }).click();
  await expect(page.getByText(createdOffer.number)).toBeVisible();
  await page.getByText(createdOffer.number).first().click();
  await expect(page.getByRole('heading', { name: createdOffer.number })).toBeVisible();
  await expect(page.getByRole('main').getByText(companyName, { exact: true })).toBeVisible();
};
