import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from './app';
import { createMemoryOfferStore, createMemoryPdfStore } from './storage/memory';

const setup = (config?: {
  publishApiKey?: string;
  publicBaseUrl?: string;
  requirePublishApiKey?: boolean;
}) => {
  const app = createApp({
    store: createMemoryOfferStore(),
    pdf: createMemoryPdfStore(),
    config: {
      publishApiKey: config?.publishApiKey,
      publicBaseUrl: config?.publicBaseUrl,
      requirePublishApiKey: config?.requirePublishApiKey ?? true,
    },
  });
  return app;
};

const API_KEY = 'portal-secret-key';

const authedJsonHeaders = (apiKey = API_KEY) => ({
  'content-type': 'application/json',
  'x-api-key': apiKey,
});

const createCustomerAccessLink = async (
  app: ReturnType<typeof setup>,
  customerRef: string,
  customerLabel = 'Test Kunde',
) => {
  const linkRes = await app.request('/customers/access-links', {
    method: 'POST',
    headers: authedJsonHeaders(),
    body: JSON.stringify({ customerRef, customerLabel, expiresInDays: 30 }),
  });
  assert.equal(linkRes.status, 200);
  return (await linkRes.json()) as { ok: true; token: string; publicUrl: string; expiresAt: string };
};

const publishInvoiceForCustomer = async (
  app: ReturnType<typeof setup>,
  token: string,
  customerRef: string,
) => {
  const res = await app.request('/invoices', {
    method: 'POST',
    headers: authedJsonHeaders(),
    body: JSON.stringify({
      token,
      customerRef,
      snapshot: {
        number: 'RE-2026-001',
        client: 'Test Kunde GmbH',
        amount: 499.5,
        date: '2026-02-20',
        dueDate: '2026-03-20',
        status: 'open',
      },
    }),
  });
  assert.equal(res.status, 200);
};

const publishOfferAndGetDocument = async (app: ReturnType<typeof setup>) => {
  const offerToken = 'offer-token-abcdefghijklmnop';
  const customerRef = 'client:test-customer';

  const linkBody = await createCustomerAccessLink(app, customerRef, 'Test Kunde');

  const publishRes = await app.request('/offers', {
    method: 'POST',
    headers: authedJsonHeaders(),
    body: JSON.stringify({
      token: offerToken,
      customerRef,
      snapshot: {
        number: 'ANG-2026-001',
        client: 'Test Kunde GmbH',
        amount: 1299.99,
        date: '2026-02-20',
        dueDate: '2026-03-20',
      },
    }),
  });
  assert.equal(publishRes.status, 200);

  const docsRes = await app.request(`/customers/${encodeURIComponent(linkBody.token)}/documents`);
  assert.equal(docsRes.status, 200);
  const docsBody = (await docsRes.json()) as {
    ok: true;
    items: Array<{ url: string }>;
  };
  assert.equal(docsBody.items.length, 1);
  const docUrl = docsBody.items[0]?.url ?? '';
  assert.ok(docUrl.startsWith('/d/'), `expected opaque document route, got ${docUrl}`);
  assert.ok(!docUrl.includes(offerToken), 'document url must not expose raw token');

  return { offerToken, documentUrl: docUrl, customerToken: linkBody.token, customerRef };
};

test('publish routes fail closed when strict auth is enabled and API key is missing', async () => {
  const app = setup({ requirePublishApiKey: true });
  const res = await app.request('/offers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: 'offer-token-abcdefghijklmnop',
      snapshot: { number: 'ANG-1' },
    }),
  });
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'publish_api_key_required');
});

test('publish routes return 401 + WWW-Authenticate when API key is wrong/missing', async () => {
  const app = setup({
    publishApiKey: 'expected-key',
    requirePublishApiKey: true,
  });
  const res = await app.request('/offers', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: 'offer-token-abcdefghijklmnop',
      snapshot: { number: 'ANG-1' },
    }),
  });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('www-authenticate'), 'ApiKey realm="publish"');
});

test('customer history returns opaque /d/:documentId URL and legacy token route redirects to it', async () => {
  const app = setup({
    publishApiKey: 'portal-secret-key',
    publicBaseUrl: 'https://offers.example.test',
    requirePublishApiKey: true,
  });
  const { offerToken, documentUrl } = await publishOfferAndGetDocument(app);

  const legacyRes = await app.request(
    new Request(`https://offers.example.test/offers/${encodeURIComponent(offerToken)}`, {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'text/html' },
    }),
  );
  assert.equal(legacyRes.status, 302);
  assert.equal(legacyRes.headers.get('location'), documentUrl);
});

test('decision endpoint rejects invalid origin and missing CSRF token', async () => {
  const app = setup({
    publishApiKey: 'portal-secret-key',
    publicBaseUrl: 'https://offers.example.test',
    requirePublishApiKey: true,
  });
  const { documentUrl } = await publishOfferAndGetDocument(app);

  const docId = documentUrl.slice('/d/'.length);

  const badOriginRes = await app.request(`/d/${encodeURIComponent(docId)}/decision`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://evil.example',
    },
    body: new URLSearchParams({
      decision: 'accepted',
      acceptedName: 'Eve',
      acceptedEmail: 'eve@example.com',
      decisionTextVersion: 'v1',
    }).toString(),
  });
  assert.equal(badOriginRes.status, 403);
  const badOriginBody = (await badOriginRes.json()) as { error: string };
  assert.equal(badOriginBody.error, 'origin_invalid');

  const missingCsrfRes = await app.request(`/d/${encodeURIComponent(docId)}/decision`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://offers.example.test',
    },
    body: new URLSearchParams({
      decision: 'accepted',
      acceptedName: 'Alice',
      acceptedEmail: 'alice@example.com',
      decisionTextVersion: 'v1',
    }).toString(),
  });
  assert.equal(missingCsrfRes.status, 403);
  const missingCsrfBody = (await missingCsrfRes.json()) as { error: string };
  assert.equal(missingCsrfBody.error, 'csrf_invalid');
});

test('decision endpoint accepts valid origin+csrf and syncs to legacy status route', async () => {
  const app = setup({
    publishApiKey: 'portal-secret-key',
    publicBaseUrl: 'https://offers.example.test',
    requirePublishApiKey: true,
  });
  const { offerToken, documentUrl } = await publishOfferAndGetDocument(app);
  const docId = documentUrl.slice('/d/'.length);

  const pageRes = await app.request(`/d/${encodeURIComponent(docId)}`, {
    method: 'GET',
    headers: { accept: 'text/html' },
  });
  assert.equal(pageRes.status, 200);
  const setCookie = pageRes.headers.get('set-cookie');
  assert.ok(setCookie, 'expected csrf cookie on offer HTML page');
  const csrfCookieMatch = /csrfToken=([^;]+)/.exec(setCookie ?? '');
  assert.ok(csrfCookieMatch, 'expected csrfToken cookie');
  const csrfToken = decodeURIComponent(csrfCookieMatch?.[1] ?? '');

  const decisionRes = await app.request(`/d/${encodeURIComponent(docId)}/decision`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      origin: 'https://offers.example.test',
      cookie: `csrfToken=${encodeURIComponent(csrfToken)}`,
      accept: 'application/json',
    },
    body: new URLSearchParams({
      decision: 'accepted',
      acceptedName: 'Alice Approver',
      acceptedEmail: 'alice@example.com',
      decisionTextVersion: 'v1',
      csrfToken,
    }).toString(),
  });
  assert.equal(decisionRes.status, 200);
  const decisionBody = (await decisionRes.json()) as {
    ok: true;
    decision: { decision: string; acceptedEmail: string };
  };
  assert.equal(decisionBody.ok, true);
  assert.equal(decisionBody.decision.decision, 'accepted');
  assert.equal(decisionBody.decision.acceptedEmail, 'alice@example.com');

  const statusRes = await app.request(`/offers/${encodeURIComponent(offerToken)}/status`);
  assert.equal(statusRes.status, 200);
  const statusBody = (await statusRes.json()) as {
    decision: { decision: string; acceptedName: string } | null;
  };
  assert.ok(statusBody.decision);
  assert.equal(statusBody.decision?.decision, 'accepted');
  assert.equal(statusBody.decision?.acceptedName, 'Alice Approver');
});

test('rotating customer access link revokes old token and keeps new token valid', async () => {
  const app = setup({
    publishApiKey: API_KEY,
    publicBaseUrl: 'https://offers.example.test',
    requirePublishApiKey: true,
  });
  const { customerToken, customerRef } = await publishOfferAndGetDocument(app);

  const rotateRes = await app.request('/customers/access-links/rotate', {
    method: 'POST',
    headers: authedJsonHeaders(),
    body: JSON.stringify({ customerRef, customerLabel: 'Test Kunde', expiresInDays: 30 }),
  });
  assert.equal(rotateRes.status, 200);
  const rotateBody = (await rotateRes.json()) as { ok: true; token: string };
  assert.notEqual(rotateBody.token, customerToken);

  const oldRes = await app.request(`/customers/${encodeURIComponent(customerToken)}/documents`);
  assert.equal(oldRes.status, 403);
  const oldBody = (await oldRes.json()) as { error: string };
  assert.equal(oldBody.error, 'revoked');

  const newRes = await app.request(`/customers/${encodeURIComponent(rotateBody.token)}/documents`);
  assert.equal(newRes.status, 200);
});

test('invoice flows expose opaque /d routes and block decision endpoint', async () => {
  const app = setup({
    publishApiKey: API_KEY,
    publicBaseUrl: 'https://offers.example.test',
    requirePublishApiKey: true,
  });
  const customerRef = 'client:invoice-customer';
  const link = await createCustomerAccessLink(app, customerRef, 'Invoice Kunde');
  const invoiceToken = 'invoice-token-abcdefghijklmnop';
  await publishInvoiceForCustomer(app, invoiceToken, customerRef);

  const docsRes = await app.request(`/customers/${encodeURIComponent(link.token)}/documents`);
  assert.equal(docsRes.status, 200);
  const docsBody = (await docsRes.json()) as {
    ok: true;
    items: Array<{ url: string; kind: string }>;
  };
  assert.equal(docsBody.items.length, 1);
  assert.equal(docsBody.items[0]?.kind, 'invoice');
  const docUrl = docsBody.items[0]?.url ?? '';
  assert.ok(docUrl.startsWith('/d/'));
  const docId = docUrl.slice('/d/'.length);

  const docRes = await app.request(`/d/${encodeURIComponent(docId)}`, {
    headers: { accept: 'application/json' },
  });
  assert.equal(docRes.status, 200);
  const docBody = (await docRes.json()) as { kind: string; decision?: unknown };
  assert.equal(docBody.kind, 'invoice');
  assert.equal(docBody.decision, undefined);

  const decisionRes = await app.request(`/d/${encodeURIComponent(docId)}/decision`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://offers.example.test',
    },
    body: JSON.stringify({
      decision: 'accepted',
      acceptedName: 'Nope',
      acceptedEmail: 'nope@example.com',
      decisionTextVersion: 'v1',
    }),
  });
  assert.equal(decisionRes.status, 404);
});

test('multipart offer publish stores PDF and serves it via /d/:id/pdf and legacy token pdf route', async () => {
  const app = setup({
    publishApiKey: API_KEY,
    publicBaseUrl: 'https://offers.example.test',
    requirePublishApiKey: true,
  });
  const customerRef = 'client:pdf-customer';
  const customer = await createCustomerAccessLink(app, customerRef);
  const offerToken = 'offer-token-pdf-abcdefghijklmnop';

  const form = new FormData();
  form.set('token', offerToken);
  form.set('customerRef', customerRef);
  form.set('snapshot', JSON.stringify({ number: 'ANG-PDF-1', client: 'PDF Kunde', amount: 77.7 }));
  form.set('pdf', new Blob([new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55])], { type: 'application/pdf' }), 'offer.pdf');
  const publishRes = await app.request('/offers', {
    method: 'POST',
    headers: { 'x-api-key': API_KEY },
    body: form,
  });
  assert.equal(publishRes.status, 200);

  const docsRes = await app.request(`/customers/${encodeURIComponent(customer.token)}/documents`);
  assert.equal(docsRes.status, 200);
  const docsBody = (await docsRes.json()) as { items: Array<{ url: string; hasPdf: boolean }> };
  assert.equal(docsBody.items[0]?.hasPdf, true);
  const docId = (docsBody.items[0]?.url ?? '').slice('/d/'.length);

  const newPdfRes = await app.request(`/d/${encodeURIComponent(docId)}/pdf`);
  assert.equal(newPdfRes.status, 200);
  assert.equal(newPdfRes.headers.get('content-type'), 'application/pdf');
  assert.equal(newPdfRes.headers.get('x-frame-options'), 'SAMEORIGIN');
  const newPdfBytes = new Uint8Array(await newPdfRes.arrayBuffer());
  assert.deepEqual(Array.from(newPdfBytes), [37, 80, 68, 70, 45, 49, 46, 55]);

  const legacyPdfRes = await app.request(`/offers/${encodeURIComponent(offerToken)}/pdf`);
  assert.equal(legacyPdfRes.status, 200);
  assert.equal(legacyPdfRes.headers.get('content-type'), 'application/pdf');
  assert.equal(legacyPdfRes.headers.get('x-frame-options'), 'SAMEORIGIN');
});

test('first offer decision wins (second decision attempt does not overwrite)', async () => {
  const app = setup({
    publishApiKey: API_KEY,
    publicBaseUrl: 'https://offers.example.test',
    requirePublishApiKey: true,
  });
  const { offerToken, documentUrl } = await publishOfferAndGetDocument(app);
  const docId = documentUrl.slice('/d/'.length);

  const first = await app.request(`/d/${encodeURIComponent(docId)}/decision`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://offers.example.test',
      accept: 'application/json',
    },
    body: JSON.stringify({
      decision: 'accepted',
      acceptedName: 'Alice',
      acceptedEmail: 'alice@example.com',
      decisionTextVersion: 'v1',
    }),
  });
  assert.equal(first.status, 200);

  const second = await app.request(`/d/${encodeURIComponent(docId)}/decision`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://offers.example.test',
      accept: 'application/json',
    },
    body: JSON.stringify({
      decision: 'declined',
      acceptedName: 'Mallory',
      acceptedEmail: 'mallory@example.com',
      decisionTextVersion: 'v2',
    }),
  });
  assert.equal(second.status, 200);
  const secondBody = (await second.json()) as { decision: { decision: string; acceptedName: string } };
  assert.equal(secondBody.decision.decision, 'accepted');
  assert.equal(secondBody.decision.acceptedName, 'Alice');

  const statusRes = await app.request(`/offers/${encodeURIComponent(offerToken)}/status`);
  const statusBody = (await statusRes.json()) as { decision: { decision: string; acceptedName: string } };
  assert.equal(statusBody.decision.decision, 'accepted');
  assert.equal(statusBody.decision.acceptedName, 'Alice');
});

test('expired offers reject decisions', async () => {
  const app = setup({
    publishApiKey: API_KEY,
    publicBaseUrl: 'https://offers.example.test',
    requirePublishApiKey: true,
  });
  const customerRef = 'client:expired-offer';
  const link = await createCustomerAccessLink(app, customerRef);
  const offerToken = 'offer-token-expired-abcdefghijklmnop';

  const publishRes = await app.request('/offers', {
    method: 'POST',
    headers: authedJsonHeaders(),
    body: JSON.stringify({
      token: offerToken,
      customerRef,
      expiresAt: '2000-01-01T00:00:00.000Z',
      snapshot: {
        number: 'ANG-EXPIRED-1',
        client: 'Expired Kunde',
        amount: 10,
      },
    }),
  });
  assert.equal(publishRes.status, 200);

  const docsRes = await app.request(`/customers/${encodeURIComponent(link.token)}/documents`);
  const docsBody = (await docsRes.json()) as { items: Array<{ url: string }> };
  const docId = (docsBody.items[0]?.url ?? '').slice('/d/'.length);

  const decisionRes = await app.request(`/d/${encodeURIComponent(docId)}/decision`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'https://offers.example.test',
    },
    body: JSON.stringify({
      decision: 'accepted',
      acceptedName: 'Late User',
      acceptedEmail: 'late@example.com',
      decisionTextVersion: 'v1',
    }),
  });
  assert.equal(decisionRes.status, 410);
  const decisionBody = (await decisionRes.json()) as { error: string };
  assert.equal(decisionBody.error, 'expired');
});
