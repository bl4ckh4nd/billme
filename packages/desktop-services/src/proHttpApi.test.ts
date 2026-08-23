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
    invoke?.('pro:validateTaxCompliance', { draftId: 'draft-1' }),
    /Pro-HTTP-Laufzeit unterstützt die IPC-Route pro:validateTaxCompliance nicht/,
  );
});

test('Pro HTTP adapter routes the accounting catalog, ledger and report reads', async () => {
  const requests: string[] = [];
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requests.push(String(input));
      return response([]);
    },
  });

  await api.pro.listLedgerAccounts({ chart: 'SKR04', limit: 2 });
  await api.pro.listTaxCases({ activeOnly: true });
  await api.pro.listTaxCaseAccountMappings({ chart: 'SKR03' });
  await api.pro.listAccountSuggestionRules({ activeOnly: true });
  await api.pro.listWorkflowEntries();
  await api.pro.listJournalEntries({ from: '2025-01-01', limit: 1 });
  await api.pro.getLedgerBalances({ asOfDate: '2025-12-31' });
  await api.pro.listAccountingSourceRuns();
  await api.pro.listReportSnapshots({ reportType: 'guv' });
  await api.pro.listReportMappingPositions({ statement: 'bwa01', asOfDate: '2025-12-31' });
  await api.pro.listAssets();
  await api.pro.listDatevExports({ limit: 5 });
  await api.pro.listAccountingAccountMappings({ chart: 'SKR04' });

  assert.deepEqual(requests, [
    'http://127.0.0.1:43123/api/v1/pro/accounting/ledger/accounts?chart=SKR04&limit=2',
    'http://127.0.0.1:43123/api/v1/pro/accounting/tax-cases?activeOnly=true',
    'http://127.0.0.1:43123/api/v1/pro/accounting/tax-case-account-mappings?chart=SKR03',
    'http://127.0.0.1:43123/api/v1/pro/accounting/account-suggestion-rules?activeOnly=true',
    'http://127.0.0.1:43123/api/v1/pro/workflow',
    'http://127.0.0.1:43123/api/v1/pro/accounting/journal?from=2025-01-01&limit=1',
    'http://127.0.0.1:43123/api/v1/pro/accounting/balances?asOfDate=2025-12-31',
    'http://127.0.0.1:43123/api/v1/pro/accounting/source-runs',
    'http://127.0.0.1:43123/api/v1/pro/accounting/reports/snapshots?reportType=guv',
    'http://127.0.0.1:43123/api/v1/pro/accounting/mappings/positions?reportType=bwa01&asOfDate=2025-12-31',
    'http://127.0.0.1:43123/api/v1/pro/accounting/assets',
    'http://127.0.0.1:43123/api/v1/pro/accounting/datev/exports',
    'http://127.0.0.1:43123/api/v1/pro/accounting/mappings?chart=SKR04',
  ]);
});

test('Pro HTTP adapter keeps accounting mutation payloads contract-shaped', async () => {
  const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requests.push({ url: String(input), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return response({ ok: true });
    },
  });

  await api.pro.upsertWorkflowEntry({
    transactionId: 'tx-1', transactionJson: '{"id":"tx-1"}', draftJson: '{"id":"draft-1"}',
  });
  assert.deepEqual(requests, [{
    url: 'http://127.0.0.1:43123/api/v1/pro/workflow',
    method: 'POST',
    body: { transactionId: 'tx-1', transactionJson: '{"id":"tx-1"}', draftJson: '{"id":"draft-1"}' },
  }]);
});

test('Pro web client validates tax and suggestion-rule accounting mutations', async () => {
  const requests: Array<{ url: string; body?: unknown }> = [];
  const mapping = {
    id: 'mapping-1', chart: 'SKR03' as const, taxCaseKey: 'DE_STD_19' as const,
    role: 'output_tax' as const, accountNumber: '1776', updatedAt: '2025-01-01T00:00:00.000Z',
  };
  const rule = {
    id: 'rule-1', tenantId: 'tenant-1', chart: 'SKR03' as const, priority: 10,
    field: 'purpose' as const, operator: 'contains' as const, value: 'hosting',
    targetAccountNumber: '4920', flowType: 'expense' as const, active: true,
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
  };
  let responseIndex = 0;
  const client = createProWebClient({
    baseUrl: 'https://hosted.example.test',
    getToken: () => 'hosted-token',
    fetch: async (input, init) => {
      requests.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return response(responseIndex++ === 0 ? mapping : rule);
    },
  });

  assert.deepEqual(await client.saveTaxCaseMapping({
    chart: 'SKR03', taxCaseKey: 'DE_STD_19', role: 'output_tax', accountNumber: '1776', reason: 'Mapping',
  }), mapping);
  assert.deepEqual(await client.saveAccountSuggestionRule({
    chart: 'SKR03', priority: 10, field: 'purpose', operator: 'contains', value: 'hosting',
    targetAccountNumber: '4920', flowType: 'expense', active: true, reason: 'Rule',
  }), rule);
  assert.deepEqual(requests, [
    {
      url: 'https://hosted.example.test/api/v1/pro/accounting/tax-case-account-mappings',
      body: { chart: 'SKR03', taxCaseKey: 'DE_STD_19', role: 'output_tax', accountNumber: '1776', reason: 'Mapping' },
    },
    {
      url: 'https://hosted.example.test/api/v1/pro/accounting/account-suggestion-rules',
      body: { chart: 'SKR03', priority: 10, field: 'purpose', operator: 'contains', value: 'hosting', targetAccountNumber: '4920', flowType: 'expense', active: true, reason: 'Rule' },
    },
  ]);
});

test('Pro HTTP adapter projects hosted report rows to the legacy Pro contract', async () => {
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async () => response({
      from: '2025-01-01', to: '2025-12-31', chart: 'SKR03', netResult: 100,
      rows: [{ position: '1', label: 'Umsatz', amount: 100, accountNumbers: ['8400'] }],
      mappingHealth: { unmappedAccounts: [], blocking: false },
    }),
  });

  assert.deepEqual(await api.pro.getGuvReport({ from: '2025-01-01', to: '2025-12-31' }), {
    from: '2025-01-01', to: '2025-12-31', chart: 'SKR03', netResult: 100,
    rows: [{ positionKey: '1', positionLabel: 'Umsatz', amount: 100, accountRefs: ['8400'] }],
    unmappedAccounts: [], blocking: false,
  });
});

test('Pro HTTP adapter projects balance report account rows', async () => {
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async () => response({
      asOfDate: '2025-12-31',
      assets: [{ accountNumbers: ['1200'], amount: 200 }],
      liabilities: [{ accountNumbers: ['1800'], amount: 200 }],
      totals: { assets: 200, liabilities: 200, delta: 0 },
      mappingHealth: { unmappedAccounts: [], blocking: false },
    }),
  });

  assert.deepEqual(await api.pro.getBilanzReport({ asOfDate: '2025-12-31' }), {
    asOfDate: '2025-12-31',
    assets: [{ accountNumber: '1200', amount: 200 }],
    liabilities: [{ accountNumber: '1800', amount: 200 }],
    totals: { assets: 200, liabilities: 200, delta: 0 },
    unmappedAccounts: [], blocking: false,
  });
});

test('Pro HTTP adapter routes EÜR reports, facts, rules and project persistence', async () => {
  const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
  const rule = {
    id: 'eur-rule-1', taxYear: 2025, priority: 1, field: 'purpose' as const,
    operator: 'contains' as const, value: 'hosting', targetEurLineId: 'line-1', active: true,
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
  };
  const classification = {
    id: 'classification-1', sourceType: 'transaction' as const, sourceId: 'tx-1', taxYear: 2025,
    excluded: false, vatMode: 'none' as const, updatedAt: '2025-01-01T00:00:00.000Z',
  };
  const cashFact = {
    id: 'cash-fact-1', tenantId: 'tenant-1', sourceType: 'transaction' as const, sourceId: 'tx-1',
    taxYear: 2025, kind: 'income' as const, amountNet: 100, reason: 'Cash-Fakt', actorId: 'user-1',
    provenance: { catalogId: 'catalog', catalogVersion: '1', catalogSourceHash: 'a'.repeat(64) },
    createdAt: '2025-01-01T00:00:00.000Z', updatedAt: '2025-01-01T00:00:00.000Z',
  };
  const annexFact = {
    id: 'annex-fact-1', tenantId: 'tenant-1', taxYear: 2025, annex: 'ust', lineId: 'line-1', amount: 10,
    reason: 'Anlage-Fakt', actorId: 'user-1',
    provenance: { catalogId: 'catalog', catalogVersion: '1', catalogSourceHash: 'a'.repeat(64) },
    createdAt: '2025-01-01T00:00:00.000Z',
  };
  const project = {
    id: 'project-1', clientId: 'client-1', name: 'Website', status: 'active' as const,
    budget: 1000, startDate: '2025-01-01', description: 'Launch',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes('/reports/eur?')) return response({
        taxYear: 2025, from: '2025-01-01', to: '2025-12-31',
        rows: [{ id: 'line-1', label: 'Umsatz', kind: 'income', exportable: true, total: 100, sortOrder: 1 }],
        summary: { incomeTotal: 100, expenseTotal: 0, surplus: 100 }, unclassifiedCount: 0, warnings: [],
        catalog: { id: 'catalog', version: '1', sourceHash: 'a'.repeat(64), delivery: 'elster-ready', elsterReady: true },
      });
      if (url.includes('/reports/eur/export.csv')) return { ok: true, status: 200, text: async () => 'Kennziffer;Betrag\n' } as Response;
      if (url.includes('/reports/eur/rules')) return response(init?.method === 'POST' ? rule : init?.method === 'DELETE' ? { ok: true } : [rule]);
      if (url.includes('/classifications')) return response(classification);
      if (url.includes('/facts/cash')) return response(init?.method === 'POST' ? cashFact : []);
      if (url.includes('/facts/annex')) return response(init?.method === 'POST' ? annexFact : []);
      if (url.includes('/projects/') && url.endsWith('/archive')) return response(project);
      if (url.endsWith('/projects') || url.includes('/projects?')) return response(init?.method === 'POST' ? project : [project]);
      if (url.includes('/projects/')) return response(project);
      return response([]);
    },
  });

  const report = await api.eur.getReport({ taxYear: 2025 });
  assert.equal(report.rows[0]?.lineId, 'line-1');
  assert.deepEqual(await api.eur.listItems({ taxYear: 2025 }), []);
  assert.deepEqual(await api.eur.listCashFacts({ taxYear: 2025 }), []);
  assert.deepEqual(await api.eur.listAnnexFacts({ taxYear: 2025, annex: 'ust' }), []);
  assert.deepEqual(await api.eur.listRules({ taxYear: 2025 }), [rule]);
  assert.deepEqual(await api.eur.upsertRule({
    taxYear: 2025, priority: 1, field: 'purpose', operator: 'contains', value: 'hosting', targetEurLineId: 'line-1', active: true,
  }), rule);
  assert.deepEqual(await api.eur.deleteRule({ id: 'eur-rule-1' }), { ok: true });
  assert.deepEqual(await api.eur.upsertClassification({
    sourceType: 'transaction', sourceId: 'tx-1', taxYear: 2025, reason: 'Klassifiziert',
  }), classification);
  assert.deepEqual(await api.eur.saveCashFact({
    sourceType: 'transaction', sourceId: 'tx-1', taxYear: 2025, kind: 'income', amountNet: 100, reason: 'Cash-Fakt',
  }), cashFact);
  assert.deepEqual(await api.eur.saveAnnexFact({
    taxYear: 2025, annex: 'ust', lineId: 'line-1', amount: 10, reason: 'Anlage-Fakt',
  }), annexFact);
  assert.equal(await api.eur.exportCsv({ taxYear: 2025 }), 'Kennziffer;Betrag\n');
  assert.deepEqual(await api.projects.list({ clientId: 'client-1' }), [project]);
  assert.deepEqual(await api.projects.get({ id: 'project-1' }), project);
  assert.deepEqual(await api.projects.upsert({ project, reason: 'Projekt gespeichert' }), project);
  assert.deepEqual(await api.projects.archive({ id: 'project-1', reason: 'Projekt archiviert' }), project);

  assert.deepEqual(requests.map(({ url, method }) => ({ url, method })), [
    { url: 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur?taxYear=2025', method: 'GET' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur/items?taxYear=2025', method: 'GET' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur/facts/cash?taxYear=2025', method: 'GET' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur/facts/annex?taxYear=2025&annex=ust', method: 'GET' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur/rules?taxYear=2025', method: 'GET' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur/rules', method: 'POST' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur/rules/eur-rule-1', method: 'DELETE' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur/classifications', method: 'PUT' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur/facts/cash', method: 'POST' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur/facts/annex', method: 'POST' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur/export.csv?taxYear=2025', method: 'GET' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/projects?clientId=client-1', method: 'GET' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/projects/project-1', method: 'GET' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/projects', method: 'POST' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/projects/project-1/archive', method: 'POST' },
  ]);
  assert.deepEqual(requests[5]?.body, {
    taxYear: 2025, priority: 1, field: 'purpose', operator: 'contains', value: 'hosting', targetEurLineId: 'line-1', active: true,
    reason: 'EÜR-Regel gespeichert',
  });
  assert.deepEqual(requests[6]?.body, { reason: 'EÜR-Regel gelöscht' });
  assert.deepEqual(requests[7]?.body, {
    sourceType: 'transaction', sourceId: 'tx-1', taxYear: 2025, reason: 'Klassifiziert',
  });
  assert.deepEqual(requests[8]?.body, {
    sourceType: 'transaction', sourceId: 'tx-1', taxYear: 2025, kind: 'income', amountNet: 100, reason: 'Cash-Fakt',
  });
  assert.deepEqual(requests[9]?.body, { taxYear: 2025, annex: 'ust', lineId: 'line-1', amount: 10, reason: 'Anlage-Fakt' });
  assert.deepEqual(requests[13]?.body, { reason: 'Projekt gespeichert', project });
  assert.deepEqual(requests[14]?.body, { reason: 'Projekt archiviert' });
});

test('Pro HTTP adapter routes finance import lifecycle and transaction linking', async () => {
  const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
  const batch = {
    id: 'batch-1', accountId: 'account-1', profile: 'generic', fileName: 'bank.csv',
    fileSha256: 'b'.repeat(64), mappingJson: {}, importedCount: 1, skippedCount: 0,
    errorCount: 0, createdAt: '2025-01-01T00:00:00.000Z',
  };
  const details = {
    batch, transactions: [{ id: 'tx-1', date: '2025-01-01', amount: 100, type: 'income' as const,
      counterparty: 'Acme', purpose: 'Invoice', status: 'booked' as const }],
    canRollback: true, linkedInvoiceCount: 0,
  };
  const preview = {
    path: '/tmp/bank.csv', fileName: 'bank.csv', fileSha256: 'c'.repeat(64), delimiter: ';',
    headers: ['date', 'amount'], profile: 'generic' as const,
    suggestedMapping: { dateColumn: 'date', amountColumn: 'amount' }, rows: [],
    stats: { totalRows: 0, previewRows: 0, validRows: 0, errorRows: 0 },
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/finance/import/preview')) return response(preview);
      if (url.endsWith('/finance/import/commit')) return response({ batchId: 'batch-1', imported: 1, skipped: 0, errors: [], fileSha256: 'c'.repeat(64) });
      if (url.endsWith('/finance/import-batches/batch-1')) return response(details);
      if (url.includes('/finance/import-batches?')) return response([batch]);
      if (url.endsWith('/rollback')) return response({ success: true, deletedCount: 1 });
      if (url.includes('/transactions?')) return response([]);
      if (url.endsWith('/link')) return response({ success: true });
      return response({ success: true });
    },
  });

  assert.deepEqual(await api.finance.importPreview({ path: '/tmp/bank.csv' }), preview);
  assert.deepEqual(await api.finance.importCommit({
    path: '/tmp/bank.csv', accountId: 'account-1', mapping: { dateColumn: 'date', amountColumn: 'amount' },
  }), { batchId: 'batch-1', imported: 1, skipped: 0, errors: [], fileSha256: 'c'.repeat(64) });
  assert.deepEqual(await api.finance.listImportBatches({ accountId: 'account-1', limit: 10 }), [batch]);
  assert.deepEqual(await api.finance.getImportBatchDetails({ batchId: 'batch-1' }), details);
  assert.deepEqual(await api.finance.rollbackImportBatch({ batchId: 'batch-1', reason: 'Import zurücksetzen' }), { success: true, deletedCount: 1 });
  assert.deepEqual(await api.transactions.list({ type: 'income', unlinkedOnly: true }), []);
  assert.deepEqual(await api.transactions.link({ transactionId: 'tx-1', invoiceId: 'invoice-1' }), { success: true });
  assert.deepEqual(await api.transactions.unlink({ transactionId: 'tx-1' }), { success: true });

  assert.deepEqual(requests.map(({ url, method }) => ({ url, method })), [
    { url: 'http://127.0.0.1:43123/api/v1/pro/finance/import/preview', method: 'POST' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/finance/import/commit', method: 'POST' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/finance/import-batches?accountId=account-1&limit=10', method: 'GET' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/finance/import-batches/batch-1', method: 'GET' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/finance/import-batches/batch-1/rollback', method: 'POST' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/transactions?type=income&unlinkedOnly=true', method: 'GET' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/transactions/tx-1/link', method: 'POST' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/transactions/tx-1/unlink', method: 'POST' },
  ]);
  assert.deepEqual(requests[0]?.body, { path: '/tmp/bank.csv' });
  assert.deepEqual(requests[1]?.body, {
    path: '/tmp/bank.csv', accountId: 'account-1', mapping: { dateColumn: 'date', amountColumn: 'amount' },
  });
  assert.deepEqual(requests[4]?.body, { reason: 'Import zurücksetzen' });
  assert.deepEqual(requests[6]?.body, { invoiceId: 'invoice-1', reason: 'Zahlung automatisch mit Rechnung verknüpft' });
  assert.deepEqual(requests[7]?.body, { reason: 'Zahlungsverknüpfung aufgehoben' });
});

test('Pro HTTP adapter validates EÜR, project and import boundaries before fetch', async () => {
  let fetchCalls = 0;
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async () => {
      fetchCalls += 1;
      return response([]);
    },
  });

  await assert.rejects(api.eur.getReport({ taxYear: 2024 }), /2024|too_small|>= 2025/);
  await assert.rejects(api.eur.listItems({ taxYear: 2025, limit: 0 }), /positive|greater than 0/);
  await assert.rejects(api.projects.get({ id: '' }), /at least 1 character/);
  await assert.rejects(api.finance.importCommit({ path: '/tmp/bank.csv', accountId: 'account-1', mapping: {} as never }), /dateColumn|amountColumn/);
  assert.equal(fetchCalls, 0);
});

test('Pro HTTP adapter keeps tenant mutation reasons and import filters in the request', async () => {
  const requests: Array<{ url: string; method?: string; body?: unknown }> = [];
  const classification = {
    id: 'classification-2', sourceType: 'invoice' as const, sourceId: 'invoice-1', taxYear: 2025,
    excluded: true, vatMode: 'default' as const, note: 'Privat', updatedAt: '2025-01-01T00:00:00.000Z',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.includes('/classifications')) return response(classification);
      if (url.includes('/rollback')) return response({ success: true, deletedCount: 0 });
      return response([]);
    },
  });

  await api.eur.listItems({
    taxYear: 2025, onlyUnclassified: true, sourceType: 'invoice', flowType: 'expense',
    status: 'unclassified', search: 'Acme', accountId: 'account-1', limit: 25, offset: 5,
  });
  await api.eur.upsertClassification({
    sourceType: 'invoice', sourceId: 'invoice-1', taxYear: 2025, excluded: true,
    vatMode: 'default', note: 'Privat', reason: 'Quelle ausgeschlossen',
  });
  await api.finance.rollbackImportBatch({ batchId: 'batch-2', reason: 'Doppelter Import' });

  assert.deepEqual(requests, [
    {
      url: 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur/items?taxYear=2025&onlyUnclassified=true&sourceType=invoice&flowType=expense&status=unclassified&search=Acme&accountId=account-1&limit=25&offset=5',
      method: 'GET', body: undefined,
    },
    {
      url: 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur/classifications',
      method: 'PUT',
      body: { sourceType: 'invoice', sourceId: 'invoice-1', taxYear: 2025, excluded: true, vatMode: 'default', note: 'Privat', reason: 'Quelle ausgeschlossen' },
    },
    {
      url: 'http://127.0.0.1:43123/api/v1/pro/finance/import-batches/batch-2/rollback',
      method: 'POST', body: { reason: 'Doppelter Import' },
    },
  ]);
});

test('Pro migration routes use the embedded local token without a hosted bearer', async () => {
  const authHeaders: Array<{ local: string | null; bearer: string | null }> = [];
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    getToken: () => 'must-not-be-used',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'migration-token' }),
    fetch: async (_input, init) => {
      const headers = new Headers(init?.headers);
      authHeaders.push({ local: headers.get('x-billme-local-token'), bearer: headers.get('authorization') });
      return response([]);
    },
  });

  await api.eur.listItems({ taxYear: 2025 });
  await api.projects.list({ includeArchived: true });
  await api.finance.listImportBatches({ accountId: 'account-1' });
  await api.transactions.list({ linkedOnly: true });

  assert.deepEqual(authHeaders, [
    { local: 'migration-token', bearer: null },
    { local: 'migration-token', bearer: null },
    { local: 'migration-token', bearer: null },
    { local: 'migration-token', bearer: null },
  ]);
});

test('Pro migration routes fail closed to the injected fallback when embedded is unavailable', async () => {
  const calls: string[] = [];
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => null,
    fallback: async (key) => {
      calls.push(key);
      return [] as never;
    },
    fetch: async () => { throw new Error('HTTP must not be used'); },
  });

  await api.eur.listItems({ taxYear: 2025 });
  await api.projects.list({});
  await api.finance.listImportBatches({});
  await api.transactions.list({});
  assert.deepEqual(calls, ['eur:listItems', 'projects:list', 'finance:listImportBatches', 'transactions:list']);
});

test('Pro finance rollback propagates the server conflict without falling back', async () => {
  let fetchCalls = 0;
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fallback: async () => { throw new Error('fallback must not run'); },
    fetch: async () => {
      fetchCalls += 1;
      return response({ message: 'IMPORT_BATCH_LINKED' }, 409);
    },
  });

  await assert.rejects(
    api.finance.rollbackImportBatch({ batchId: 'batch-1', reason: 'Rollback' }),
    /IMPORT_BATCH_LINKED/,
  );
  assert.equal(fetchCalls, 1);
});

test('Pro project and transaction identifiers stay URL encoded', async () => {
  const urls: string[] = [];
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => { const url = String(input); urls.push(url); return response(url.includes('/unlink') ? { success: true } : null); },
  });

  await api.projects.get({ id: 'project/one' });
  await api.transactions.unlink({ transactionId: 'transaction/one' });
  assert.deepEqual(urls, [
    'http://127.0.0.1:43123/api/v1/pro/projects/project%2Fone',
    'http://127.0.0.1:43123/api/v1/pro/transactions/transaction%2Fone/unlink',
  ]);
});
