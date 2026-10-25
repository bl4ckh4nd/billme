import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readServerHarnessState } from '../harness.mjs';
import { completeBusinessOnboardingIfVisible, fillSetupCodeIfAsked } from '../onboarding.mjs';
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
    await fillSetupCodeIfAsked(page, state);
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

  // A fresh tenant opens the business wizard; the USt-IdNr. alone satisfies §14 UStG.
  const onboarded = await completeBusinessOnboardingIfVisible(page, {
    scenarioKey,
    readyHeading: 'Übersicht',
    company: 'Billme Lite',
    taxNumber: { label: 'USt-IdNr.', value: 'DE123456789' },
  });
  if (onboarded) {
    await page.reload({ waitUntil: 'networkidle' });
    await expect(page.getByRole('heading', { name: 'Übersicht', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Richte deinen Firmenkopf ein' })).toHaveCount(0);
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

const shot = async (page, name) => {
  if (process.env.E2E_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR}/${name}.png`, fullPage: false });
};

/**
 * Hosted server as a multi-workspace service, through the UI only: a person
 * signs up with the setup code, finishes onboarding, invites an accountant who
 * joins in a second browser, changes that role, then creates a second workspace
 * from the switcher and switches back.
 */
export const runLiteWorkspacesScenario = async (page, scenarioKey = 'workspaces') => {
  const { state } = await getLiteRuntime();
  const ns = `${scenarioKey}-${Date.now().toString(36)}`;
  const owner = { email: `owner+${ns}@billme-e2e.local`, name: 'Wanda Workspace' };

  await page.goto(state.urls.web, { waitUntil: 'networkidle' });
  const signupLink = page.getByRole('button', { name: 'Neuen Workspace anlegen' });
  if (await signupLink.isVisible().catch(() => false)) await signupLink.click();
  await expect(page.getByRole('heading', { name: /^(Neuen Workspace anlegen|Billme einrichten)$/ })).toBeVisible();
  await fillSetupCodeIfAsked(page, state);
  await page.getByLabel('Name des Workspace').fill(`Erste ${ns}`);
  await page.getByLabel('Dein Name').fill(owner.name);
  await page.getByLabel('E-Mail-Adresse').fill(owner.email);
  await page.getByLabel('Passwort', { exact: true }).fill(litePassword);
  await page.getByRole('button', { name: /^(Workspace anlegen|Konto anlegen und loslegen)$/ }).click();
  expect(await completeBusinessOnboardingIfVisible(page, { scenarioKey: `${ns}-a`, readyHeading: 'Übersicht', company: 'Erste' })).toBe(true);
  await shot(page, '01-first-workspace');

  // Invite an accountant. The harness has no mail service, so the UI shows the link to pass on.
  await page.getByRole('button', { name: 'Einstellungen' }).click();
  await page.getByRole('button', { name: /^Team/ }).first().click();
  const team = page.getByRole('main');
  const memberEmail = `nina+${ns}@billme-e2e.local`;
  await team.getByLabel('E-Mail-Adresse').fill(memberEmail);
  await team.getByLabel('Rolle', { exact: true }).selectOption('accountant');
  await team.getByRole('button', { name: 'Einladen' }).click();
  await expect(team.getByText(`Gib ${memberEmail} diesen Link`)).toBeVisible();
  const inviteUrl = (await team.locator('code').first().innerText()).trim();
  expect(inviteUrl.startsWith(`${state.urls.web.replace(/\/+$/, '')}/?invite=`)).toBe(true);
  await expect(team.getByRole('region', { name: 'Offene Einladungen' }).getByText(memberEmail)).toBeVisible();
  await shot(page, '02-invited');

  const memberContext = await page.context().browser().newContext();
  try {
    const member = await memberContext.newPage();
    await member.goto(inviteUrl, { waitUntil: 'networkidle' });
    await expect(member.getByRole('heading', { name: `Einladung zu Erste ${ns}` })).toBeVisible();
    await expect(member.getByText('Buchhaltung', { exact: true })).toBeVisible();
    await member.getByLabel('Dein Name').fill('Nina Neu');
    await member.getByLabel('Passwort', { exact: true }).fill(litePassword);
    await member.getByRole('button', { name: 'Konto anlegen und beitreten' }).click();
    await expect(member.getByRole('heading', { name: 'Übersicht', level: 1 })).toBeVisible();
    await expect(member.getByRole('heading', { name: 'Richte deinen Firmenkopf ein' })).toHaveCount(0);
    expect(new URL(member.url()).searchParams.get('invite')).toBeNull();
    await member.getByRole('button', { name: 'Einstellungen' }).click();
    await expect(member.getByRole('button', { name: /^Team/ })).toHaveCount(0);
    await shot(member, '03-member-joined');

    // The used link is dead.
    await member.goto(inviteUrl, { waitUntil: 'networkidle' });
    await expect(member.getByRole('heading', { name: 'Dieser Link gilt nicht mehr' })).toBeVisible();
  } finally {
    await memberContext.close();
  }

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /^Team/ }).first().click();
  const members = page.getByRole('region', { name: 'Mitglieder' });
  await expect(members.getByText('Nina Neu')).toBeVisible();
  await members.getByLabel('Rolle von Nina Neu').selectOption('viewer');
  await expect(members.getByLabel('Rolle von Nina Neu')).toHaveValue('viewer');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /^Team/ }).first().click();
  await expect(page.getByRole('region', { name: 'Mitglieder' }).getByLabel('Rolle von Nina Neu')).toHaveValue('viewer');
  await shot(page, '04-team');

  // A second workspace from the switcher starts with its own onboarding.
  await page.getByRole('button', { name: new RegExp(`^Erste ${ns}`) }).click();
  await page.getByRole('menuitem', { name: 'Neuen Workspace anlegen' }).click();
  const dialog = page.getByRole('dialog', { name: 'Neuen Workspace anlegen' });
  await expect(dialog.getByLabel('Name des Workspace')).toBeVisible();
  const code = dialog.getByLabel('Einrichtungscode');
  if (await code.isVisible().catch(() => false)) await code.fill(state.env.BILLME_SETUP_TOKEN);
  await dialog.getByLabel('Name des Workspace').fill(`Zweite ${ns}`);
  await dialog.getByRole('button', { name: 'Anlegen' }).click();
  await expect(page.getByRole('heading', { name: 'Richte deinen Firmenkopf ein' }), 'the new workspace opens its own onboarding').toBeVisible();
  expect(await completeBusinessOnboardingIfVisible(page, { scenarioKey: `${ns}-b`, readyHeading: /^(Übersicht|Einstellungen)$/, company: 'Zweite' })).toBe(true);
  await expect(page.getByRole('button', { name: new RegExp(`^Zweite ${ns}`) })).toBeVisible();
  await shot(page, '05-second-workspace');

  await page.getByRole('button', { name: new RegExp(`^Zweite ${ns}`) }).click();
  await page.getByRole('menuitemradio', { name: new RegExp(`Erste ${ns}`) }).or(page.getByRole('menuitem', { name: new RegExp(`Erste ${ns}`) })).click();
  await expect(page.getByRole('button', { name: new RegExp(`^Erste ${ns}`) })).toBeVisible();
  await shot(page, '06-switched-back');
};

/**
 * Lite web navigation and the document chain through the UI: projects and
 * services are reachable; from the list's "Folgebeleg" menu an order
 * confirmation (AB- range) comes from an accepted offer, a delivery note (LS-
 * range) from the order, then an advance invoice and the final invoice that
 * deducts it, and a credit note. Order and delivery note are "Ausgestellt",
 * take no payment and are no receivable: the dashboard's open receivables grow
 * by the billed amounts only and shrink by the credit note.
 */
export const runLiteDocumentKindsScenario = async (page, scenarioKey = 'document-kinds') => {
  const runtime = await getLiteRuntime();
  const identity = createLiteIdentity(scenarioKey);
  const { session, seed } = await provisionLiteSession({ apiBaseUrl: runtime.state.urls.api, databaseUrl: runtime.databaseUrl, ...identity });
  expect(seed).not.toBeNull();
  await applyLiteSession(page, runtime.state, session, '/');

  for (const [name, heading] of [['Projekte', 'Projekte'], ['Leistungen', 'Leistungen']]) {
    await page.getByRole('navigation', { name: 'Hauptnavigation' }).getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('heading', { name: heading, level: 1 })).toBeVisible();
  }
  await shot(page, '01-services');

  const euros = (text) => Number(text.match(/-?[\d.]+,\d{2}/)[0].replace(/\./g, '').replace(',', '.'));
  const receivables = async () => {
    await page.goto(liteAppUrl(runtime.state, '/'), { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    const tile = page.locator('.rounded-tile').filter({ hasText: 'Offene Forderungen' }).first();
    await expect(tile).toBeVisible();
    return euros(await tile.innerText());
  };
  const baseline = await receivables();

  const offer = await page.evaluate(async ({ clientId }) => {
    const api = globalThis.billmeApi;
    const draft = await api.documents.createFromClient({ kind: 'offer', clientId });
    const saved = await api.offers.upsert({ offer: { ...draft, amount: 357, items: [{ kind: 'item', description: 'Montage', quantity: 1, price: 300, total: 300, taxRate: 19 }] }, reason: 'create' });
    return api.offers.upsert({ offer: { ...saved, status: 'open', shareDecision: 'accepted', acceptedAt: new Date().toISOString() }, reason: 'Angebot angenommen' });
  }, { clientId: seed.clients[0].id });

  await page.goto(liteAppUrl(runtime.state, '/documents'), { waitUntil: 'networkidle' });
  // A hash route does not reload the app; reload so the list sees the offer created through the API.
  await page.reload({ waitUntil: 'networkidle' });
  const headingNumber = async () => (await page.getByRole('heading', { level: 1 }).innerText()).trim();
  const startFollowUp = async (label, sourceNumber) => {
    await page.getByRole('button', { name: 'Folgebeleg' }).click();
    await page.getByRole('menuitem', { name: `${label} …` }).click();
    const dialog = page.getByRole('dialog', { name: `${label} erstellen` });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: new RegExp(sourceNumber) }).click();
  };
  const confirmAmount = async (label, prefilled, amount) => {
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: `${label} erstellen` }) });
    const input = dialog.getByLabel('Betrag (EUR)');
    await expect(input).toHaveValue(prefilled, { timeout: 5000 });
    if (amount !== undefined) await input.fill(amount);
    await dialog.getByRole('button', { name: `${label} erstellen` }).click();
    await expect(page.getByText(new RegExp(`^${label} .* erstellt\\.$`))).toBeVisible();
  };
  const backToList = () => page.getByRole('button', { name: 'Zurück zur Liste' }).click();

  await startFollowUp('Auftragsbestätigung', offer.number);
  await expect(page.getByText(/^Auftragsbestätigung .* erstellt\.$/)).toBeVisible();
  const orderNumber = await headingNumber();
  expect(orderNumber).toMatch(/^AB-\d{4}-\d{3}$/);
  await expect(page.getByText('Ausgestellt', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Zahlungen' })).toHaveCount(0);
  await backToList();

  await startFollowUp('Lieferschein', orderNumber);
  await expect(page.getByText(/^Lieferschein .* erstellt\.$/)).toBeVisible();
  const deliveryNumber = await headingNumber();
  expect(deliveryNumber).toMatch(/^LS-\d{4}-\d{3}$/);
  await expect(page.getByRole('heading', { name: 'Zahlungen' })).toHaveCount(0);
  await shot(page, '02-delivery-note');
  await backToList();

  await startFollowUp('Abschlagsrechnung', orderNumber);
  await confirmAmount('Abschlagsrechnung', '357.00', '100');
  const advanceNumber = await headingNumber();
  expect(advanceNumber).toMatch(/^RE-/);
  await expect(page.getByText(/^Abschlagsrechnung zur Auftragsbestätigung /).first()).toBeVisible();
  await backToList();

  await startFollowUp('Schlussrechnung', orderNumber);
  await confirmAmount('Schlussrechnung', '257.00');
  await expect(page.getByText(new RegExp(`^Abzüglich Abschlagsrechnung ${advanceNumber} `)).first()).toBeVisible();
  await shot(page, '03-final-invoice');
  const finalNumber = await headingNumber();
  const finalId = await page.evaluate(async (number) => (await globalThis.billmeApi.invoices.list()).find((doc) => doc.number === number)?.id, finalNumber);
  const pdf = await page.request.get(`${runtime.state.urls.api}/api/v1/lite/documents/invoice/${finalId}/pdf`, { headers: { authorization: `Bearer ${session.token}` } });
  expect(pdf.status()).toBe(200);
  const bytes = await pdf.body();
  expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
  if (process.env.E2E_SCREENSHOT_DIR) await (await import('node:fs/promises')).writeFile(`${process.env.E2E_SCREENSHOT_DIR}/03-final-invoice.pdf`, bytes);
  await backToList();

  // The order is fully billed: it is no longer offered for a settlement.
  await page.getByRole('button', { name: 'Folgebeleg' }).click();
  await page.getByRole('menuitem', { name: 'Teilrechnung …' }).click();
  await expect(page.getByRole('dialog', { name: 'Teilrechnung erstellen' }).getByRole('button', { name: new RegExp(orderNumber) })).toHaveCount(0);
  await page.getByRole('dialog', { name: 'Teilrechnung erstellen' }).getByRole('button', { name: 'Abbrechen' }).click();

  // The advance is settled in the final invoice: it is corrected through the final invoice, not on its own.
  await page.getByRole('button', { name: 'Folgebeleg' }).click();
  await page.getByRole('menuitem', { name: 'Gutschrift …' }).click();
  await expect(page.getByRole('dialog', { name: 'Gutschrift erstellen' }).getByRole('button', { name: new RegExp(advanceNumber) })).toHaveCount(0);
  await page.getByRole('dialog', { name: 'Gutschrift erstellen' }).getByRole('button', { name: 'Abbrechen' }).click();
  await startFollowUp('Gutschrift', finalNumber);
  await confirmAmount('Gutschrift', '257.00', '10');
  const creditNumber = await headingNumber();
  await backToList();

  await page.getByLabel('Belegart').selectOption('delivery_note');
  const rows = page.getByRole('table').getByRole('row');
  await expect(rows.filter({ hasText: deliveryNumber })).toHaveCount(1);
  await expect(rows.filter({ hasText: orderNumber })).toHaveCount(0);
  await page.getByLabel('Belegart').selectOption('correction');
  await expect(rows.filter({ hasText: creditNumber })).toHaveCount(1);
  await shot(page, '04-kind-filter');

  // A credit note is never offered as the source of another correction.
  await page.getByRole('button', { name: 'Folgebeleg' }).click();
  await page.getByRole('menuitem', { name: 'Gutschrift …' }).click();
  const creditSources = page.getByRole('dialog', { name: 'Gutschrift erstellen' });
  await expect(creditSources.getByRole('button', { name: new RegExp(creditNumber) })).toHaveCount(0);
  await expect(creditSources.getByRole('button', { name: new RegExp(orderNumber) })).toHaveCount(0);
  await creditSources.getByRole('button', { name: 'Abbrechen' }).click();

  // Receivables: +100 advance, +257 final, −10 credit; order and delivery note add nothing.
  expect(await receivables()).toBeCloseTo(baseline + 347, 2);
  await shot(page, '05-dashboard');
};

/**
 * German invoicing rules as a user meets them in the browser, with the printed PDF as evidence:
 * - §14 Abs. 4 UStG: "Als gestellt markieren" on a draft without the customer's address is refused
 *   with the missing Pflichtangabe in the notification, and works once the address is there.
 * - §19 UStG: a Kleinunternehmer's invoice issued with the editor's default tax mode prints no VAT
 *   line, gross = net, and the §19 notice.
 * - Dunning: the letter for a partly paid and partly credited invoice demands only the open
 *   balance plus the fee, and the invoice amount itself is never raised by the fee; a business
 *   customer's letter claims Verzugszinsen and the §288 Abs. 5 Pauschale.
 * - Skonto prints with its deadline; a service period stays a period in the editor.
 */
export const runLiteLegalScenario = async (page, scenarioKey = 'legal') => {
  const { execFileSync } = await import('node:child_process');
  const { writeFile } = await import('node:fs/promises');
  const runtime = await getLiteRuntime();
  const identity = createLiteIdentity(scenarioKey);
  const { session, seed } = await provisionLiteSession({ apiBaseUrl: runtime.state.urls.api, databaseUrl: runtime.databaseUrl, ...identity });
  expect(seed).not.toBeNull();
  await applyLiteSession(page, runtime.state, session, '/documents');
  const clientId = seed.clients[0].id;
  const out = process.env.E2E_SCREENSHOT_DIR;

  const pdfTextOf = async (path, name) => {
    const response = await page.request.get(`${runtime.state.urls.api}/api/v1/lite${path}`, { headers: { authorization: `Bearer ${session.token}` } });
    expect(response.status(), path).toBe(200);
    const bytes = await response.body();
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    const file = `${out ?? (await import('node:os')).tmpdir()}/${name}.pdf`;
    await writeFile(file, bytes);
    const text = execFileSync('pdftotext', ['-layout', file, '-'], { encoding: 'utf8' });
    if (out) await writeFile(`${out}/${name}.txt`, text);
    return text.replace(/\s+/g, ' ');
  };
  const draftFor = (patch) => page.evaluate(async ({ clientId, patch }) => {
    const api = globalThis.billmeApi;
    const draft = await api.documents.createFromClient({ kind: 'invoice', clientId });
    return api.invoices.upsert({ invoice: { ...draft, items: [{ kind: 'item', description: 'Beratung', quantity: 1, price: 300, total: 300, taxRate: 19 }], ...patch }, reason: 'create' });
  }, { clientId, patch });
  const openFromList = async (number) => {
    await page.goto(liteAppUrl(runtime.state, '/documents'), { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText(number).first().click();
    await expect(page.getByRole('heading', { name: number })).toBeVisible();
  };
  const markIssued = async () => {
    await page.getByRole('button', { name: 'Stellen', exact: true }).click();
    await page.getByRole('dialog', { name: 'Rechnung stellen' }).getByRole('button', { name: 'Stellen', exact: true }).click();
  };

  // §14: the customer address is a Pflichtangabe.
  const missing = await draftFor({ clientAddress: '', billingAddressJson: undefined });
  await openFromList(missing.number);
  await markIssued();
  await expect(page.getByText(/Finalisieren fehlgeschlagen: .*Anschrift des Kunden fehlt/)).toBeVisible();
  await shot(page, 'legal-01-missing-address');
  await page.evaluate(async (invoice) => globalThis.billmeApi.invoices.upsert({ invoice: { ...invoice, clientAddress: 'Hauptstraße 1\n10115 Berlin' }, reason: 'Anschrift ergänzt' }), missing);
  await openFromList(missing.number);
  await markIssued();
  await expect(page.getByText('Rechnung als gestellt markiert')).toBeVisible();

  // §19: the tenant is a Kleinunternehmer; the editor still sends its default tax mode.
  const settings = await page.evaluate(() => globalThis.billmeApi.settings.get());
  await page.evaluate((s) => globalThis.billmeApi.settings.set({ settings: { ...s, legal: { ...s.legal, smallBusinessRule: true } } }), settings);
  try {
    const ku = await draftFor({ taxMode: 'standard_vat' });
    await openFromList(ku.number);
    await markIssued();
    await expect(page.getByText('Rechnung als gestellt markiert')).toBeVisible();
    await shot(page, 'legal-02-small-business');
    const text = await pdfTextOf(`/documents/invoice/${ku.id}/pdf`, 'legal-02-small-business');
    expect(text).toContain('Kleinunternehmerregelung nach §19 UStG');
    expect(text).not.toMatch(/USt\. \d+ %/);
    expect(text).not.toContain('Nettobetrag');
    expect(text).toMatch(/Gesamtbetrag 300,00 €/);
  } finally {
    await page.evaluate((s) => globalThis.billmeApi.settings.set({ settings: s }), settings);
  }

  // Dunning: 357,00 € invoice, 50,00 € paid, 23,80 € credited → 283,20 € open.
  const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const late = await draftFor({ date: day(-40), dueDate: day(-20), servicePeriod: day(-40) });
  const overdue = await page.evaluate(async ({ invoice }) => {
    const api = globalThis.billmeApi;
    const open = await api.invoices.upsert({ invoice: { ...invoice, status: 'open' }, reason: 'Rechnung gestellt' });
    await api.invoices.savePayment({ invoiceId: open.id, payment: { id: crypto.randomUUID(), date: new Date().toISOString().slice(0, 10), amount: 50, method: 'bank' }, reason: 'Teilzahlung' });
    await api.documents.chainIssue({ operation: 'correction', id: crypto.randomUUID(), invoiceId: open.id, kind: 'credit_note', amount: 23.8, date: new Date().toISOString().slice(0, 10), reason: 'Teilgutschrift' });
    return open;
  }, { invoice: late });
  expect(overdue.amount).toBe(357);
  const letter = await pdfTextOf(`/documents/dunning/${overdue.id}/pdf?level=1`, 'legal-03-dunning-letter');
  expect(letter).toMatch(/Rechnungsbetrag 357,00 €/);
  expect(letter).toMatch(/Bereits gezahlt [−-]50,00 €/);
  expect(letter).toMatch(/Gutgeschrieben [−-]23,80 €/);
  expect(letter).toMatch(/Offener Betrag 283,20 €/);
  const stored = await page.evaluate(async (id) => (await globalThis.billmeApi.invoices.list()).find((doc) => doc.id === id), overdue.id);
  expect(stored.amount).toBe(357);

  // §288 BGB: a business customer's letter claims Verzugszinsen and the 40 € Pauschale instead of the fee.
  const current = await page.evaluate(() => globalThis.billmeApi.settings.get());
  const levels = current.dunning.levels.length ? current.dunning.levels : [{ id: 1, name: 'Zahlungserinnerung', enabled: true, daysAfterDueDate: 7, fee: 5, subject: 'Erinnerung %N', text: '' }];
  await page.evaluate((s) => globalThis.billmeApi.settings.set({ settings: s }), { ...current, dunning: { ...current.dunning, baseInterestRatePercent: 1.27, levels: levels.map((level) => (level.id === levels[0].id ? { ...level, chargeInterest: true, chargeFlatFee: true } : level)) } });
  try {
    const business = await draftFor({ date: day(-40), dueDate: day(-20), servicePeriod: day(-40), taxMeta: { buyerType: 'business' } });
    await page.evaluate(async (invoice) => globalThis.billmeApi.invoices.upsert({ invoice: { ...invoice, status: 'open' }, reason: 'Rechnung gestellt' }), business);
    const claim = await pdfTextOf(`/documents/dunning/${business.id}/pdf?level=${levels[0].id}`, 'legal-04-dunning-interest');
    expect(claim).toMatch(/Pauschale nach § 288 Abs\. 5 BGB 40,00 €/);
    // pdftotext may put the label's last word after the amount when the label wraps.
    expect(claim).toMatch(/Verzugszinsen 10,27 % p\. a\. für 20 (Tage )?2,01 €/);
    expect(claim).toMatch(/Offener Betrag 399,01 €/);
  } finally {
    await page.evaluate((s) => globalThis.billmeApi.settings.set({ settings: s }), current);
  }

  // Skonto is printed with its deadline and the amount to pay.
  const skontoDraft = await draftFor({ date: day(0), dueDate: day(30), servicePeriod: day(0) });
  const withSkonto = await page.evaluate(async (invoice) => globalThis.billmeApi.invoices.upsert({ invoice: { ...invoice, skonto: { percent: 2, days: 10 }, status: 'open' }, reason: 'Rechnung gestellt' }), skontoDraft);
  const skontoText = await pdfTextOf(`/documents/invoice/${withSkonto.id}/pdf`, 'legal-05-skonto');
  expect(skontoText).toMatch(/Bei Zahlung bis \d{2}\.\d{2}\.\d{4} abzüglich (2 % Skonto )?349,86 €/);
  expect(skontoText).not.toContain('ohne Abzug');

  // A subscription period stays a period in the editor: both dates are shown.
  const periodic = await draftFor({ servicePeriod: '2026-10-01 bis 2026-10-31' });
  await openFromList(periodic.number);
  await page.getByRole('button', { name: 'Bearbeiten' }).first().click();
  await expect(page.getByLabel('Leistungsdatum', { exact: true })).toHaveValue('2026-10-01');
  await expect(page.getByLabel('Leistungszeitraum bis', { exact: true })).toHaveValue('2026-10-31');
  await shot(page, 'legal-06-editor-period');
};
