import { expect } from '@playwright/test';
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

  await expect(page.getByText('Billme Lite Web')).toBeVisible();
  await expect(page.getByText('billme-server-api (fastify)')).toBeVisible();
  await expect(page.getByRole('button', { name: /Create owner account|Open lite workspace/ })).toBeVisible();
  await expect(page.getByText(/Bootstrap lite owner|Login/)).toBeVisible();
};

export const runLiteAuthScenario = async (page, scenarioKey = 'auth-flow') => {
  const { state } = await getLiteRuntime();
  const identity = createLiteIdentity(scenarioKey);

  await page.goto(state.urls.web, { waitUntil: 'networkidle' });

  const bootstrapButton = page.getByRole('button', { name: 'Create owner account' });
  const loginButton = page.getByRole('button', { name: 'Open lite workspace' });

  if (await bootstrapButton.isVisible().catch(() => false)) {
    await expect(page.getByRole('heading', { name: 'Bootstrap lite owner' })).toBeVisible();
    await page.getByPlaceholder('Full name').fill(identity.fullName);
    await page.getByPlaceholder('Email').fill(identity.email);
    await page.getByPlaceholder('Password').fill(litePassword);
    await bootstrapButton.click();
  } else {
    await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible();
    await page.getByPlaceholder('Email').fill(identity.email);
    await page.getByPlaceholder('Password').fill(litePassword);
    await loginButton.click();
  }

  await expect(page.getByRole('button', { name: 'Abmelden' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Kunden' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dokumente' })).toBeVisible();

  const storedSession = await readLiteStoredSession(page);
  expect(storedSession).toMatchObject({
    user: {
      email: identity.email,
      fullName: identity.fullName,
    },
  });

  await page.getByRole('button', { name: 'Abmelden' }).click();
  await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible();
  await expect(page.getByText('You have been signed out.')).toBeVisible();

  await page.getByPlaceholder('Email').fill(identity.email);
  await page.getByPlaceholder('Password').fill(litePassword);
  await page.getByRole('button', { name: 'Open lite workspace' }).click();

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

  await expect(page.getByRole('heading', { name: 'Login' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open lite workspace' })).toBeVisible();
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

  await page.getByLabel('Globale Suche').fill(seed.clients[0].customerNumber);
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
  await page.getByTitle('Auswählen').first().click();
  await expect(page.getByText('Auswahl aktiv')).toBeVisible();
  await page.getByRole('button', { name: 'Export' }).click();

  await expect(page.getByText(/PDF Fehler:/)).toBeVisible();
  await expect(page.getByText(/Billme Lite web shell yet/)).toBeVisible();
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
  await expect(page.getByRole('heading', { name: seed.clients[0].company }).first()).toBeVisible();

  const createClientButton = page.locator('button').filter({ has: page.locator('svg.lucide-plus') }).last();
  await createClientButton.click();

  const clientEditor = page.locator('div').filter({ has: page.getByRole('heading', { name: 'Neuer Kunde' }) }).first();
  await expect(clientEditor).toBeVisible();
  await clientEditor.getByRole('button', { name: 'Speichern' }).click();
  await expect(page.getByText('Firma ist erforderlich.')).toBeVisible();

  const companyName = `Lite Browserkunde ${identity.namespace}`;
  await clientEditor.locator('label:has-text("Firma") + input').fill(companyName);
  await clientEditor.locator('label:has-text("Ansprechpartner") + input').fill('Regression Runner');
  await clientEditor.locator('label:has-text("Telefon") + input').fill('+49 30 55555555');
  await clientEditor.locator('label:has-text("E-Mail-Adresse") + input').fill(`billing+${identity.namespace}@billme-e2e.local`);
  await clientEditor.locator('label:has-text("Straße") + input').fill('Teststrasse 42');
  await clientEditor.locator('label:has-text("PLZ") + input').fill('10115');
  await clientEditor.locator('label:has-text("Stadt") + input').fill('Berlin');
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
  await expect(page.getByText(companyName)).toBeVisible();
  await page.getByRole('button', { name: 'Neue Rechnung' }).click();
  await expect(page.getByRole('heading', { name: 'Rechnung erstellen' })).toBeVisible();
  await expect(page.locator('label:has-text("Firmenname / Kunde") + input')).toHaveValue(companyName);
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
      items: [{ description, quantity: 1, price, total: price }],
    };
    delete persisted.numberReservationId;
    const saved = await api.invoices.upsert({ invoice: persisted, reason: 'create' });
    if (reservationId) {
      await api.numbers.finalize({ reservationId, documentId: saved.id });
    }
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
      items: [{ description, quantity: 1, price, total: price }],
    };
    delete persisted.numberReservationId;
    const saved = await api.offers.upsert({ offer: persisted, reason: 'create' });
    if (reservationId) {
      await api.numbers.finalize({ reservationId, documentId: saved.id });
    }
    return saved;
  }, {
    clientId: createdClient.id,
    description: 'Lite Regression Offer',
    price: 450,
  });
  expect(createdOffer.number.startsWith(seed.settings.numbers.offerPrefix)).toBe(true);

  await page.goto(liteAppUrl(runtime.state, '/documents'), { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Rechnungen' }).click();
  await page.getByRole('button', { name: 'Angebote' }).click();
  await expect(page.getByText(createdOffer.number)).toBeVisible();
  await page.getByText(createdOffer.number).first().click();
  await expect(page.getByRole('heading', { name: createdOffer.number })).toBeVisible();
  await expect(page.getByText(companyName)).toBeVisible();
};
