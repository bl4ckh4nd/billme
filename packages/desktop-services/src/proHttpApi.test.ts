import assert from 'node:assert/strict';
import test from 'node:test';
import { createProHttpBillmeApi, createProWebClient, ProEmbeddedConnectionUnavailableError } from './proHttpApi.js';
import type { IpcArgs, IpcResult, IpcRouteKey } from '@billme/desktop-contracts-pro/contract';

const response = (payload: unknown, status = 200): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
} as Response);

test('Pro web client uses the embedded local token and resolves the health contract', async () => {
  let requestUrl = '';
  let requestHeaders: HeadersInit | undefined;
  const client = createProWebClient({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestHeaders = init?.headers;
      return response({ ok: true, service: 'server-api', backend: 'fastify', mode: 'api', ts: 'now' });
    },
  });

  assert.deepEqual(await client.getHealth(), { ok: true, service: 'server-api', backend: 'fastify', mode: 'api', ts: 'now' });
  assert.equal(requestUrl, 'http://127.0.0.1:43123/health');
  const headers = new Headers(requestHeaders);
  assert.equal(headers.get('x-billme-local-token'), 'local-token');
  assert.equal(headers.get('authorization'), null);
});

test('Pro web client preserves hosted bearer authentication', async () => {
  let requestUrl = '';
  let requestHeaders: HeadersInit | undefined;
  const client = createProWebClient({
    baseUrl: 'https://hosted.example.test/',
    getToken: () => 'hosted-token',
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestHeaders = init?.headers;
      return response({ ok: true, service: 'server-api', backend: 'fastify', mode: 'api', ts: 'now' });
    },
  });

  await client.getHealth();
  assert.equal(requestUrl, 'https://hosted.example.test/health');
  assert.equal(new Headers(requestHeaders).get('authorization'), 'Bearer hosted-token');
});

test('Pro web client fails before fetch when the embedded server is unavailable', async () => {
  let fetchCalls = 0;
  const client = createProWebClient({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => null,
    fetch: async () => {
      fetchCalls += 1;
      return response({ service: 'server-api', status: 'ok' });
    },
  });

  await assert.rejects(
    client.getHealth(),
    (error: unknown) => error instanceof ProEmbeddedConnectionUnavailableError
      && error.code === 'PRO_EMBEDDED_CONNECTION_UNAVAILABLE',
  );
  assert.equal(fetchCalls, 0);
});

test('Pro HTTP adapter routes the shared tax-filing contract', async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const record = {
    id: 'filing-1', kind: 'euer' as const, periodStart: '2025-01-01', periodEnd: '2025-12-31',
    sourceHash: 'a'.repeat(64), status: 'queued' as const,
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET' });
      if (url.endsWith('/tax-filing/status')) return response({ provider: { available: false, provider: null, errorCode: 'PROVIDER_UNAVAILABLE' }, certificates: [] });
      if (url.endsWith('/tax-filing/records')) return response([record]);
      if (url.endsWith('/tax-filing/certificates')) return response({ id: 'cert-1', fingerprint: 'b'.repeat(64), expiresAt: '2030-01-01T00:00:00.000Z' });
      if (url.includes('/tax-filing/certificates/')) return response(true);
      return response({ operation: url.split('/').pop(), status: 'failed', sourceHash: record.sourceHash, issues: [{ code: 'PROVIDER_UNAVAILABLE', message: 'Provider unavailable' }] });
    },
  });

  assert.deepEqual(await api.taxFiling.getStatus(), {
    provider: { available: false, provider: null, errorCode: 'PROVIDER_UNAVAILABLE' },
    certificates: [],
  });
  assert.deepEqual(await api.taxFiling.listRecords(), [record]);
  await api.taxFiling.installCertificate({ id: 'cert-1', pem: 'pem', expiresAt: '2030-01-01T00:00:00.000Z' });
  assert.equal(await api.taxFiling.removeCertificate({ id: 'cert-1' }), true);
  await api.taxFiling.validate({ record });
  await api.taxFiling.export({ record });
  await api.taxFiling.submit({ record });
  assert.deepEqual(requests.map(({ url, method }) => ({ url, method })), [
    { url: 'http://127.0.0.1:43123/api/v1/pro/tax-filing/status', method: 'GET' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/tax-filing/records', method: 'GET' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/tax-filing/certificates', method: 'POST' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/tax-filing/certificates/cert-1', method: 'DELETE' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/tax-filing/validate', method: 'POST' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/tax-filing/export', method: 'POST' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/tax-filing/submit', method: 'POST' },
  ]);
});

test('Pro HTTP adapter routes billing, settings, recurring and catalog reads', async () => {
  const requests: string[] = [];
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/settings')) return response(null);
      if (url.includes('/active/')) return response(null);
      return response([]);
    },
  });

  assert.deepEqual(await api.invoices.list(), []);
  assert.deepEqual(await api.offers.list(), []);
  assert.deepEqual(await api.clients.list(), []);
  assert.deepEqual(await api.recurring.list(), []);
  assert.equal(await api.settings.get(), null);
  assert.deepEqual(await api.articles.list(), []);
  assert.deepEqual(await api.accounts.list(), []);
  assert.deepEqual(await api.templates.list({ kind: 'invoice' }), []);
  assert.equal(await api.templates.active({ kind: 'invoice' }), null);
  assert.deepEqual(requests, [
    'http://127.0.0.1:43123/api/v1/pro/invoices',
    'http://127.0.0.1:43123/api/v1/pro/offers',
    'http://127.0.0.1:43123/api/v1/pro/clients',
    'http://127.0.0.1:43123/api/v1/pro/recurring',
    'http://127.0.0.1:43123/api/v1/pro/settings',
    'http://127.0.0.1:43123/api/v1/pro/articles',
    'http://127.0.0.1:43123/api/v1/pro/accounts',
    'http://127.0.0.1:43123/api/v1/pro/templates?kind=invoice',
    'http://127.0.0.1:43123/api/v1/pro/templates/active/invoice',
  ]);
});

test('Pro HTTP adapter validates catalog writes at the Pro contract boundary', async () => {
  const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
  const article = { id: 'article-1', title: 'Beratung', description: 'Termin', price: 120, unit: 'Stunde', category: 'Dienstleistung', taxRate: 19 };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requests.push({ url: String(input), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return response(article);
    },
  });

  assert.deepEqual(await api.articles.upsert({ article }), article);
  assert.equal(requests[0]?.url, 'http://127.0.0.1:43123/api/v1/pro/articles');
  assert.equal(requests[0]?.method, 'POST');
  assert.deepEqual(requests[0]?.body, { article });
});

test('Pro HTTP adapter falls back only for native routes while embedded is unavailable', async () => {
  const calls: Array<{ key: IpcRouteKey; args: unknown }> = [];
  const fallback = async <K extends IpcRouteKey>(key: K, args: IpcArgs<K>): Promise<IpcResult<K>> => {
    calls.push({ key, args });
    return { ok: true } as IpcResult<K>;
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => null,
    fallback,
    fetch: async () => { throw new Error('HTTP must not be used'); },
  });

  assert.deepEqual(await api.window.minimize(), { ok: true });
  assert.deepEqual(await api.settings.get(), { ok: true });
  assert.deepEqual(calls.map(({ key }) => key), ['window:minimize', 'settings:get']);
});

test('Pro HTTP adapter rejects unsupported server-owned routes when HTTP is available', async () => {
  let invoke: ((key: IpcRouteKey, args: unknown) => Promise<unknown>) | undefined;
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fallback: async () => ({ path: 'legacy.sqlite' }),
    fetch: async () => response(null),
    onInvoke: (candidate) => { invoke = candidate as typeof invoke; },
  });
  void api;
  assert.ok(invoke);
  await assert.rejects(
    invoke?.('pro:getLedgerStats', undefined),
    /Pro-HTTP-Laufzeit unterstützt die IPC-Route pro:getLedgerStats nicht/,
  );
});
