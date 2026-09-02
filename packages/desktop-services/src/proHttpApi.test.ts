import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import type { IpcInvoke } from '@billme/desktop-contracts-pro/api';
import type { IpcArgs, IpcResult, IpcRouteKey } from '@billme/desktop-contracts-pro/contract';
import { createProHttpBillmeApi, createProWebClient, ProEmbeddedConnectionUnavailableError } from './proHttpApi.js';

const response = (payload: unknown, status = 200): Response => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => payload,
} as Response);

const textResponse = (payload: string, status = 200): Response => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => payload,
  json: async () => JSON.parse(payload),
} as Response);

test('Pro HTTP Billme API routes ledger stats through the embedded server contract', async () => {
  let requestUrl = '';
  let requestHeaders: HeadersInit | undefined;
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({
      baseUrl: 'http://127.0.0.1:43123',
      token: 'local-token',
    }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestHeaders = init?.headers;
      return response({ total: 2, byChart: { SKR03: 2, SKR04: 0 } });
    },
  });

  assert.deepEqual(await api.pro.getLedgerStats(), {
    total: 2,
    byChart: { SKR03: 2, SKR04: 0 },
  });
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/ledger/stats');
  const headers = new Headers(requestHeaders);
  assert.equal(headers.get('x-billme-local-token'), 'local-token');
});

test('Pro HTTP Billme API routes tax filing status through the shared server contract', async () => {
  let requestUrl = '';
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response({ provider: { available: false, provider: null, errorCode: 'PROVIDER_UNAVAILABLE' }, certificates: [] });
    },
  });

  assert.deepEqual(await api.taxFiling.getStatus(), {
    provider: { available: false, provider: null, errorCode: 'PROVIDER_UNAVAILABLE' },
    certificates: [],
  });
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/tax-filing/status');
});

test('Pro HTTP Billme API routes the complete tax filing contract', async () => {
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
      const operation = url.split('/').pop() as 'validate' | 'export' | 'submit';
      return response({ operation, status: 'failed', sourceHash: record.sourceHash, issues: [{ code: 'PROVIDER_UNAVAILABLE', message: 'Provider unavailable' }] });
    },
  });

  await api.taxFiling.getStatus();
  assert.deepEqual(await api.taxFiling.listRecords(), [record]);
  await api.taxFiling.installCertificate({ id: 'cert-1', pem: '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----', expiresAt: '2030-01-01T00:00:00.000Z' });
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

test('Pro HTTP tax audit export keeps generation on the server and delegates only the native save', async () => {
  const calls: Array<{ key: IpcRouteKey; args: unknown }> = [];
  const content = 'sequence,action\n1,invoice.created\n';
  const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
  const artifact = {
    schemaVersion: 1 as const,
    createdAt: '2026-08-22T12:00:00.000Z',
    from: '2026-01-01',
    to: '2026-01-31',
    includeDocuments: true,
    files: [{ name: 'audit-log.csv', content, sha256, sizeBytes: content.length, rowCount: 1 }],
  };
  const saved = {
    bundleDir: '/app-data/exports/tax-audit-packages/tax-audit-1',
    manifestPath: '/app-data/exports/tax-audit-packages/tax-audit-1/manifest.json',
    createdAt: artifact.createdAt,
    fileCount: 1,
    files: [{ name: 'audit-log.csv', path: '/app-data/exports/tax-audit-packages/tax-audit-1/audit-log.csv', sha256, sizeBytes: content.length, rowCount: 1 }],
  };
  const fallback = async <K extends IpcRouteKey>(key: K, args: IpcArgs<K>): Promise<IpcResult<K>> => {
    calls.push({ key, args });
    assert.equal(key, 'tax:saveAuditExportPackage');
    return saved as IpcResult<K>;
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fallback,
    fetch: async (input, init) => {
      assert.equal(String(input), 'http://127.0.0.1:43123/api/v1/pro/tax/audit-export-package');
      assert.equal(init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(init?.body)), { from: artifact.from, to: artifact.to, includeDocuments: true });
      return response(artifact);
    },
  });

  assert.deepEqual(await api.tax.auditExportPackage({ from: artifact.from, to: artifact.to, includeDocuments: true }), saved);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.key, 'tax:saveAuditExportPackage');
  assert.deepEqual(calls[0]?.args, artifact);
});

test('Pro HTTP Billme API routes transaction filters through the embedded server contract', async () => {
  let requestUrl = '';
  const transaction = {
    id: 'pro-transaction-1',
    accountId: 'pro-account-1',
    date: '2026-08-01',
    amount: 119,
    type: 'income' as const,
    counterparty: 'Customer',
    purpose: 'Invoice RE-1',
    status: 'booked' as const,
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response([transaction]);
    },
  });

  assert.deepEqual(await api.transactions.list({ type: 'income', unlinkedOnly: true }), [transaction]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/transactions?type=income&unlinkedOnly=true');
});

test('Pro HTTP Billme API exposes OpenRouter VLM config and transaction document analysis', async () => {
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const extraction = {
    documentType: 'invoice', issuer: null, recipient: null, invoiceNumber: 'RE-1', invoiceDate: null, servicePeriod: null, dueDate: null, currency: 'EUR', netAmount: 100, taxAmount: 19, grossAmount: 119, vatBreakdown: [], iban: null, paymentReference: null, suggestedAccountNumber: null, suggestedTaxCase: null, matchAssessment: { amountMatches: true, dateMatches: null, partyMatches: null, referenceMatches: null, notes: [] }, warnings: [], evidence: [],
  };
  const analysis = {
    extraction,
    deterministicChecks: { amountMatches: true, currencyMatches: true, expectedAmount: 119, extractedAmount: 119, expectedCurrency: 'EUR', extractedCurrency: 'EUR' },
    metadata: { model: 'google/gemini-3.7-flash', provider: 'google', requestId: 'request-1', request: { method: 'POST' as const, endpoint: 'https://openrouter.ai/api/v1/chat/completions' }, timing: { startedAt: '2026-08-29T10:00:00.000Z', completedAt: '2026-08-29T10:00:00.100Z', durationMs: 100 }, documentSha256: 'a'.repeat(64) },
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/vlm/config')) return response({ configured: true, model: 'google/gemini-3.7-flash', models: ['google/gemini-3.7-flash'], maxDocumentBytes: 10_485_760, timeoutMs: 45_000 });
      return response(analysis);
    },
  });
  assert.equal((await api.pro.getOpenRouterVlmConfig()).configured, true);
  const result = await api.pro.analyzeTransactionDocument({ transaction: { id: 'tx-vlm', date: '2026-08-29', amount: 119, type: 'income', counterparty: 'Customer', purpose: 'RE-1', currency: 'EUR' }, document: { mimeType: 'image/png', data: 'aA==' } });
  assert.equal(result.extraction.invoiceNumber, 'RE-1');
  assert.deepEqual(requests.map(({ url, method }) => ({ url, method })), [
    { url: 'http://127.0.0.1:43123/api/v1/pro/accounting/vlm/config', method: 'GET' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/accounting/transactions/tx-vlm/analyze-document', method: 'POST' },
  ]);
  assert.equal(requests[1]?.body?.model, undefined);
});

test('Pro HTTP Billme API routes finance import lifecycle through the embedded server contract', async () => {
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const mapping = { dateColumn: 'Date', amountColumn: 'Amount' };
  const preview = {
    path: '/tmp/payments.csv',
    fileName: 'payments.csv',
    fileSha256: 'a'.repeat(64),
    delimiter: ',',
    headers: ['Date', 'Amount'],
    profile: 'generic' as const,
    suggestedMapping: mapping,
    rows: [],
    stats: { totalRows: 0, previewRows: 0, validRows: 0, errorRows: 0 },
  };
  const batch = {
    id: 'batch-1',
    accountId: 'account-1',
    profile: 'generic',
    fileName: 'payments.csv',
    fileSha256: 'a'.repeat(64),
    mappingJson: { mapping },
    importedCount: 1,
    skippedCount: 0,
    errorCount: 0,
    createdAt: '2026-08-04T00:00:00.000Z',
  };
  const detail = {
    batch,
    transactions: [{ id: 'transaction-1', date: '2026-08-04', amount: 42, type: 'income' as const, counterparty: 'Customer', purpose: 'Invoice RE-2', status: 'booked' as const }],
    canRollback: true,
    linkedInvoiceCount: 0,
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/finance/import/preview')) return response(preview);
      if (url.endsWith('/finance/import/commit')) return response({ batchId: 'batch-1', imported: 1, skipped: 0, errors: [], fileSha256: 'a'.repeat(64) });
      if (url.endsWith('/finance/import-batches/batch-1/rollback')) return response({ success: true, deletedCount: 1 });
      if (url.endsWith('/finance/import-batches/batch-1')) return response(detail);
      return response([batch]);
    },
  });

  assert.deepEqual(await api.finance.importPreview({ path: '/tmp/payments.csv', mapping }), preview);
  assert.deepEqual(await api.finance.importCommit({ path: '/tmp/payments.csv', accountId: 'account-1', mapping }), {
    batchId: 'batch-1', imported: 1, skipped: 0, errors: [], fileSha256: 'a'.repeat(64),
  });
  assert.deepEqual(await api.finance.listImportBatches({ accountId: 'account-1', limit: 10 }), [batch]);
  assert.deepEqual(await api.finance.getImportBatchDetails({ batchId: 'batch-1' }), detail);
  assert.deepEqual(await api.finance.rollbackImportBatch({ batchId: 'batch-1', reason: 'Test' }), { success: true, deletedCount: 1 });
  assert.equal(requests[0]?.url, 'http://127.0.0.1:43123/api/v1/pro/finance/import/preview');
  assert.equal(requests[0]?.method, 'POST');
  assert.equal(requests[1]?.url, 'http://127.0.0.1:43123/api/v1/pro/finance/import/commit');
  assert.equal(requests[2]?.url, 'http://127.0.0.1:43123/api/v1/pro/finance/import-batches?accountId=account-1&limit=10');
  assert.equal(requests[3]?.url, 'http://127.0.0.1:43123/api/v1/pro/finance/import-batches/batch-1');
  assert.equal(requests[4]?.url, 'http://127.0.0.1:43123/api/v1/pro/finance/import-batches/batch-1/rollback');
});

test('Pro HTTP Billme API routes project list/get through the tenant-scoped server contract', async () => {
  const requests: string[] = [];
  const project = {
    id: 'project-1',
    clientId: 'client-1',
    code: 'PRJ-2026-001',
    name: 'Projekt',
    status: 'active' as const,
    budget: 100,
    startDate: '2026-01-01',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      const url = String(input);
      requests.push(url);
      return response(url.endsWith('/project-1') ? project : [project]);
    },
  });

  assert.deepEqual(await api.projects.list({ clientId: 'client-1', includeArchived: true }), [project]);
  assert.deepEqual(await api.projects.get({ id: 'project-1' }), project);
  assert.deepEqual(requests, [
    'http://127.0.0.1:43123/api/v1/pro/projects?clientId=client-1&includeArchived=true',
    'http://127.0.0.1:43123/api/v1/pro/projects/project-1',
  ]);
});

test('Pro HTTP Billme API routes project upsert/archive with reasons', async () => {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const project = {
    id: 'project-1',
    clientId: 'client-1',
    code: 'PRJ-2026-001',
    name: 'Projekt',
    status: 'active' as const,
    budget: 100,
    startDate: '2026-01-01',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requests.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return response(project);
    },
  });

  assert.deepEqual(await api.projects.upsert({ project, reason: 'Projekt gespeichert' }), project);
  assert.deepEqual(await api.projects.archive({ id: project.id, reason: 'Projekt archiviert' }), project);
  assert.deepEqual(requests, [
    {
      url: 'http://127.0.0.1:43123/api/v1/pro/projects',
      method: 'POST',
      body: { reason: 'Projekt gespeichert', project },
    },
    {
      url: 'http://127.0.0.1:43123/api/v1/pro/projects/project-1/archive',
      method: 'POST',
      body: { reason: 'Projekt archiviert' },
    },
  ]);
});

test('Pro HTTP Billme API uses exact IPC fallback for projects when the embedded server is unavailable', async () => {
  const calls: Array<{ key: IpcRouteKey; args: unknown }> = [];
  const project = {
    id: 'project-1',
    clientId: 'client-1',
    name: 'Projekt',
    status: 'active' as const,
    budget: 100,
    startDate: '2026-01-01',
  };
  const fallback = async <K extends IpcRouteKey>(key: K, args: IpcArgs<K>): Promise<IpcResult<K>> => {
    calls.push({ key, args });
    if (key === 'projects:list') return [project] as IpcResult<K>;
    if (key === 'projects:get') return project as IpcResult<K>;
    if (key === 'projects:upsert') return project as IpcResult<K>;
    return project as IpcResult<K>;
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => null,
    fetch: async () => {
      throw new Error('fetch must not be called');
    },
    fallback,
  });

  assert.deepEqual(await api.projects.list({}), [project]);
  assert.deepEqual(await api.projects.get({ id: project.id }), project);
  assert.deepEqual(await api.projects.upsert({ reason: 'Speichern', project }), project);
  assert.deepEqual(await api.projects.archive({ id: project.id, reason: 'Archivieren' }), project);
  assert.deepEqual(calls, [
    { key: 'projects:list', args: {} },
    { key: 'projects:get', args: { id: project.id } },
    { key: 'projects:upsert', args: { reason: 'Speichern', project } },
    { key: 'projects:archive', args: { id: project.id, reason: 'Archivieren' } },
  ]);
});

test('Pro HTTP adapter never falls back to SQLite IPC for an unsupported server-owned route', async () => {
  const calls: string[] = [];
  const unsupportedRoute = 'server:unknown' as IpcRouteKey;
  let invoke: IpcInvoke | undefined;
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({
      baseUrl: 'http://127.0.0.1:43123',
      token: 'local-token',
    }),
    fallback: async <K extends IpcRouteKey>(key: K): Promise<IpcResult<K>> => {
      calls.push(key);
      return { path: 'legacy.sqlite.pdf' } as IpcResult<K>;
    },
    fetch: async () => {
      throw new Error('The unsupported route must not reach HTTP');
    },
    onInvoke: (candidate) => { invoke = candidate; },
  });

  void api;
  assert.ok(invoke);
  await assert.rejects(
    invoke(unsupportedRoute, undefined as never),
    /Pro-HTTP-Laufzeit unterstützt die IPC-Route server:unknown nicht/,
  );
  assert.deepEqual(calls, []);
});

test('Pro HTTP Billme API routes article catalog reads through the embedded server', async () => {
  let requestUrl = '';
  const article = {
    id: 'article-1',
    title: 'Beratung',
    description: 'Beratungstermin',
    price: 120,
    unit: 'Stunde',
    category: 'Dienstleistung',
    taxRate: 19,
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response([article]);
    },
  });

  assert.deepEqual(await api.articles.list(), [article]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/articles');
});

test('Pro HTTP Billme API saves an article through the Pro catalog contract', async () => {
  let requestInit: RequestInit | undefined;
  const article = {
    id: 'article-1',
    title: 'Beratung',
    description: 'Beratungstermin',
    price: 120,
    unit: 'Stunde',
    category: 'Dienstleistung',
    taxRate: 19,
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (_input, init) => {
      requestInit = init;
      return response(article);
    },
  });

  assert.deepEqual(await api.articles.upsert({ article }), article);
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), { article });
});

test('Pro HTTP Billme API deletes an article by its tenant-scoped id', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response({ ok: true });
    },
  });

  assert.deepEqual(await api.articles.delete({ id: 'article-1' }), { ok: true });
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/articles/article-1');
  assert.equal(requestInit?.method, 'DELETE');
});

test('Pro HTTP Billme API routes bank account catalog reads through the embedded server', async () => {
  let requestUrl = '';
  const account = {
    id: 'bank-1',
    name: 'Geschäftskonto',
    iban: 'DE02120300000000202051',
    balance: 1000,
    defaultSkrAccountNumber: '1200',
    transactions: [],
    type: 'bank' as const,
    color: '#123456',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response([account]);
    },
  });

  assert.deepEqual(await api.accounts.list(), [account]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounts');
});

test('Pro HTTP Billme API saves a bank account through the Pro catalog contract', async () => {
  let requestInit: RequestInit | undefined;
  const account = {
    id: 'bank-1',
    name: 'Geschäftskonto',
    iban: 'DE02120300000000202051',
    balance: 1000,
    defaultSkrAccountNumber: '1200',
    transactions: [],
    type: 'bank' as const,
    color: '#123456',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (_input, init) => {
      requestInit = init;
      return response(account);
    },
  });

  assert.deepEqual(await api.accounts.upsert({ account }), account);
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), { account });
});

test('Pro HTTP Billme API deletes a bank account by its tenant-scoped id', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response({ ok: true });
    },
  });

  assert.deepEqual(await api.accounts.delete({ id: 'bank-1' }), { ok: true });
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounts/bank-1');
  assert.equal(requestInit?.method, 'DELETE');
});

test('Pro HTTP Billme API routes template catalog reads with the kind filter', async () => {
  let requestUrl = '';
  const template = {
    id: 'template-1',
    kind: 'invoice' as const,
    name: 'Standard',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    elements: [],
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response([template]);
    },
  });

  assert.deepEqual(await api.templates.list({ kind: 'invoice' }), [template]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/templates?kind=invoice');
});

test('Pro HTTP Billme API reads the active template through the Pro server', async () => {
  let requestUrl = '';
  const template = {
    id: 'template-1',
    kind: 'invoice' as const,
    name: 'Standard',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    elements: [],
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response(template);
    },
  });

  assert.deepEqual(await api.templates.active({ kind: 'invoice' }), template);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/templates/active/invoice');
});

test('Pro HTTP Billme API saves a template through the Pro catalog contract', async () => {
  let requestInit: RequestInit | undefined;
  const template = {
    id: 'template-1',
    kind: 'invoice' as const,
    name: 'Standard',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    elements: [],
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (_input, init) => {
      requestInit = init;
      return response(template);
    },
  });

  assert.deepEqual(await api.templates.upsert({ template }), template);
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), { template });
});

test('Pro HTTP Billme API deletes a template by its tenant-scoped id', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response({ ok: true });
    },
  });

  assert.deepEqual(await api.templates.delete({ id: 'template-1' }), { ok: true });
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/templates/template-1');
  assert.equal(requestInit?.method, 'DELETE');
});

test('Pro HTTP Billme API sets the active template with its kind and id', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response({ ok: true });
    },
  });

  assert.deepEqual(await api.templates.setActive({ kind: 'invoice', templateId: 'template-1' }), { ok: true });
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/templates/active');
  assert.equal(requestInit?.method, 'PUT');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), { kind: 'invoice', templateId: 'template-1' });
});

test('Pro HTTP Billme API routes common billing mutations through the Pro contract', async () => {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const invoice = {
    id: 'invoice-1',
    clientId: 'client-1',
    number: 'RE-1',
    client: 'Acme GmbH',
    clientEmail: 'billing@acme.test',
    date: '2026-01-01',
    dueDate: '2026-01-31',
    amount: 119,
    status: 'draft' as const,
    items: [],
    payments: [],
  };
  const client = {
    id: 'client-1',
    company: 'Acme GmbH',
    contactPerson: 'Ada',
    email: 'billing@acme.test',
    phone: '+49 30 123',
    address: 'Musterstr. 1, 10115 Berlin',
    status: 'active' as const,
    tags: [],
    notes: '',
    projects: [],
    activities: [],
    addresses: [],
    emails: [],
  };
  const recurring = {
    id: 'recurring-1',
    clientId: 'client-1',
    active: true,
    name: 'Wartung',
    interval: 'monthly' as const,
    nextRun: '2026-02-01',
    amount: 119,
    items: [],
  };
  const settings = {
    company: { name: 'Acme', owner: 'Ada', street: 'Musterstr. 1', zip: '10115', city: 'Berlin', email: 'billing@acme.test', phone: '+49 30 123', website: '' },
    catalog: { categories: [] },
    finance: { bankName: '', iban: '', bic: '', taxId: '', vatId: '', registerCourt: '' },
    numbers: { invoicePrefix: 'RE-', nextInvoiceNumber: 1, numberLength: 4, offerPrefix: 'AN-', nextOfferNumber: 1, customerPrefix: 'KD-', nextCustomerNumber: 1, customerNumberLength: 4 },
    dunning: { levels: [] },
    legal: { smallBusinessRule: false, defaultVatRate: 19, taxAccountingMethod: 'soll' as const, paymentTermsDays: 14, defaultIntroText: '', defaultFooterText: '' },
    portal: { baseUrl: '' },
    eInvoice: { enabled: false, standard: 'zugferd-en16931' as const, profile: 'EN16931' as const, version: '2.3' as const },
    email: { provider: 'none' as const, smtpHost: '', smtpPort: 587, smtpSecure: true, smtpUser: '', fromName: '', fromEmail: '' },
    automation: { dunningEnabled: false, dunningRunTime: '09:00', recurringEnabled: false, recurringRunTime: '03:00' },
    dashboard: { monthlyRevenueGoal: 30000, dueSoonDays: 7, topCategoriesLimit: 5, recentPaymentsLimit: 5, topClientsLimit: 5 },
  };
  const serverInvoice = { ...invoice, kind: 'invoice' as const, tenantId: 'tenant-1' };
  const serverOffer = { ...invoice, kind: 'offer' as const, tenantId: 'tenant-1', validUntil: invoice.dueDate, status: 'draft' as const };
  const serverClient = { ...client, tenantId: 'tenant-1' };
  const serverRecurring = { ...recurring, tenantId: 'tenant-1' };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      if (url.endsWith('/clients') && init?.method === 'GET') return response([serverClient]);
      if (url.endsWith('/clients') && init?.method === 'POST') return response(serverClient);
      if (url.endsWith('/invoices') && init?.method === 'GET') return response([serverInvoice]);
      if (url.endsWith('/invoices') && init?.method === 'POST') return response(serverInvoice);
      if (url.endsWith('/offers') && init?.method === 'GET') return response([serverOffer]);
      if (url.endsWith('/offers') && init?.method === 'POST') return response(serverOffer);
      if (url.endsWith('/recurring') && init?.method === 'GET') return response([serverRecurring]);
      if (url.endsWith('/recurring') && init?.method === 'POST') return response(serverRecurring);
      if (url.endsWith('/settings') && init?.method === 'GET') return response(null);
      if (url.endsWith('/settings') && init?.method === 'PUT') return response({ ok: true });
      if (url.includes('/numbers/reserve')) return response({ reservationId: 'reservation-1', number: 'RE-0001' });
      return response({ ok: true });
    },
  });

  const normalizedInvoice = {
    ...invoice,
    clientNumber: undefined,
    projectId: undefined,
    clientAddress: undefined,
    billingAddressJson: undefined,
    shippingAddressJson: undefined,
    taxMode: 'standard_vat' as const,
    taxMeta: undefined,
    taxSnapshot: undefined,
    servicePeriod: undefined,
    dunningLevel: undefined,
    history: [],
  };
  assert.deepEqual(await api.invoices.list(), [normalizedInvoice]);
  assert.deepEqual(await api.invoices.upsert({ reason: 'Rechnung gespeichert', invoice }), normalizedInvoice);
  assert.deepEqual(await api.invoices.delete({ id: 'invoice-1', reason: 'Rechnung gelöscht' }), { ok: true });
  const offers = await api.offers.list();
  assert.equal(offers[0]?.number, 'RE-1');
  assert.equal((await api.offers.upsert({ reason: 'Angebot gespeichert', offer: invoice })).number, 'RE-1');
  assert.deepEqual(await api.offers.delete({ id: 'invoice-1', reason: 'Angebot gelöscht' }), { ok: true });
  assert.deepEqual(await api.clients.list(), [client]);
  assert.deepEqual(await api.clients.upsert({ client }), client);
  assert.deepEqual(await api.clients.delete({ id: 'client-1' }), { ok: true });
  assert.deepEqual(await api.recurring.list(), [recurring]);
  assert.deepEqual(await api.recurring.upsert({ profile: recurring }), recurring);
  assert.deepEqual(await api.recurring.delete({ id: 'recurring-1' }), { ok: true });
  assert.equal(await api.settings.get(), null);
  assert.deepEqual(await api.settings.set({ settings }), { ok: true });
  assert.deepEqual(await api.numbers.reserve({ kind: 'invoice' }), { reservationId: 'reservation-1', number: 'RE-0001' });
  assert.deepEqual(await api.numbers.release({ reservationId: 'reservation-1' }), { ok: true });
  assert.deepEqual(await api.numbers.finalize({ reservationId: 'reservation-1', documentId: 'invoice-1' }), { ok: true });

  assert.deepEqual(
    requests.slice(0, 6).map(({ url, method }) => ({ url, method })),
    [
      { url: 'http://127.0.0.1:43123/api/v1/pro/invoices', method: 'GET' },
      { url: 'http://127.0.0.1:43123/api/v1/pro/invoices', method: 'POST' },
      { url: 'http://127.0.0.1:43123/api/v1/pro/invoices/invoice-1', method: 'DELETE' },
      { url: 'http://127.0.0.1:43123/api/v1/pro/offers', method: 'GET' },
      { url: 'http://127.0.0.1:43123/api/v1/pro/offers', method: 'POST' },
      { url: 'http://127.0.0.1:43123/api/v1/pro/offers/invoice-1', method: 'DELETE' },
    ],
  );
  assert.equal((requests[1]?.body as { reason?: string }).reason, 'Rechnung gespeichert');
  assert.equal((requests[1]?.body as { invoice?: { kind?: string } }).invoice?.kind, 'invoice');
  assert.equal((requests[2]?.body as { reason?: string }).reason, 'Rechnung gelöscht');
  assert.equal((requests[4]?.body as { reason?: string }).reason, 'Angebot gespeichert');
  assert.equal((requests[5]?.body as { reason?: string }).reason, 'Angebot gelöscht');
  assert.deepEqual(requests.slice(6, 9).map(({ url, method }) => ({ url, method })), [
    { url: 'http://127.0.0.1:43123/api/v1/pro/clients', method: 'GET' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/clients', method: 'POST' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/clients/client-1', method: 'DELETE' },
  ]);
  assert.equal((requests[7]?.body as { reason?: string }).reason, 'Kunde gespeichert');
  assert.equal((requests[8]?.body as { reason?: string }).reason, 'Kunde gelöscht');
});

test('Pro HTTP Billme API uses exact IPC fallback for common billing routes when embedded server is unavailable', async () => {
  const calls: Array<{ key: IpcRouteKey; args: unknown }> = [];
  const fallback = async <K extends IpcRouteKey>(key: K, args: IpcArgs<K>): Promise<IpcResult<K>> => {
    calls.push({ key, args });
    if (key.endsWith(':list')) return [] as IpcResult<K>;
    if (key === 'settings:get') return null as IpcResult<K>;
    if (key === 'numbers:reserve') return { reservationId: 'r-1', number: 'RE-1' } as IpcResult<K>;
    return { ok: true } as IpcResult<K>;
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => null,
    fallback,
    fetch: async () => { throw new Error('HTTP must not be used without embedded connection'); },
  });

  await api.invoices.list();
  await api.invoices.delete({ id: 'invoice-1', reason: 'x' });
  await api.offers.list();
  await api.clients.list();
  await api.recurring.list();
  await api.settings.get();
  await api.numbers.reserve({ kind: 'invoice' });
  await api.numbers.release({ reservationId: 'r-1' });
  await api.numbers.finalize({ reservationId: 'r-1', documentId: 'invoice-1' });

  assert.deepEqual(calls, [
    { key: 'invoices:list', args: undefined },
    { key: 'invoices:delete', args: { id: 'invoice-1', reason: 'x' } },
    { key: 'offers:list', args: undefined },
    { key: 'clients:list', args: undefined },
    { key: 'recurring:list', args: undefined },
    { key: 'settings:get', args: undefined },
    { key: 'numbers:reserve', args: { kind: 'invoice' } },
    { key: 'numbers:release', args: { reservationId: 'r-1' } },
    { key: 'numbers:finalize', args: { reservationId: 'r-1', documentId: 'invoice-1' } },
  ]);
});

test('Pro HTTP Billme API composes document creation and offer conversion with reservation finalization', async () => {
  const requests: Array<{ url: string; method: string; body?: unknown }> = [];
  const serverClient = {
    id: 'client-1',
    tenantId: 'tenant-1',
    company: 'Acme GmbH',
    contactPerson: 'Ada',
    email: 'billing@acme.test',
    phone: '+49 30 123',
    address: 'Musterstr. 1, 10115 Berlin',
    status: 'active' as const,
    tags: [],
    notes: '',
    addresses: [],
    emails: [],
    projects: [],
    activities: [],
  };
  const serverOffer = {
    id: 'offer-1',
    tenantId: 'tenant-1',
    kind: 'offer' as const,
    clientId: 'client-1',
    number: 'AN-1',
    client: 'Acme GmbH',
    clientEmail: 'billing@acme.test',
    date: '2026-01-01',
    validUntil: '2026-02-01',
    amount: 119,
    status: 'draft' as const,
    items: [],
    history: [],
  };
  const serverInvoice = {
    id: 'invoice-1',
    tenantId: 'tenant-1',
    kind: 'invoice' as const,
    clientId: 'client-1',
    number: 'RE-1',
    client: 'Acme GmbH',
    clientEmail: 'billing@acme.test',
    date: '2026-01-01',
    dueDate: '2026-01-31',
    amount: 119,
    status: 'draft' as const,
    items: [],
    payments: [],
    history: [],
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      if (url.endsWith('/clients/client-1')) return response(serverClient);
      if (url.endsWith('/offers/offer-1')) return response(serverOffer);
      if (url.endsWith('/settings')) return response(null);
      if (url.includes('/numbers/reserve')) return response({ reservationId: 'reservation-1', number: 'RE-1' });
      if (url.endsWith('/invoices') && init?.method === 'POST') return response(serverInvoice);
      return response({ ok: true });
    },
  });

  const draft = await api.documents.createFromClient({ kind: 'invoice', clientId: 'client-1' });
  assert.equal(draft.clientId, 'client-1');
  assert.equal(draft.number, 'RE-1');
  assert.equal(draft.numberReservationId, 'reservation-1');

  const converted = await api.documents.convertOfferToInvoice({ offerId: 'offer-1' });
  assert.equal(converted.id, 'invoice-1');
  assert.equal(converted.number, 'RE-1');
  assert.equal(requests.filter((request) => request.url.includes('/numbers/reserve')).length, 2);
  assert.deepEqual(requests.slice(-3).map(({ url, method }) => ({ url, method })), [
    { url: 'http://127.0.0.1:43123/api/v1/pro/numbers/reserve', method: 'POST' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/invoices', method: 'POST' },
    { url: 'http://127.0.0.1:43123/api/v1/pro/numbers/finalize', method: 'POST' },
  ]);
  assert.deepEqual(requests.at(-3)?.body, { kind: 'invoice' });
  assert.equal((requests.at(-2)?.body as { reason?: string }).reason, 'Converted from offer AN-1');
  assert.equal((requests.at(-2)?.body as { invoice?: { number?: string } }).invoice?.number, 'RE-1');
  assert.deepEqual(requests.at(-1)?.body, { reservationId: 'reservation-1', documentId: 'invoice-1' });
});

test('Pro HTTP Billme API validates tax compliance through the mutation route with draft identity and audit reason', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({
      baseUrl: 'http://127.0.0.1:43123',
      token: 'local-token',
    }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response({ ok: true, issues: [] });
    },
  });

  assert.deepEqual(await api.pro.validateTaxCompliance({ draftId: 'draft-1' }), { ok: true, issues: [] });
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/validate');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    draftId: 'draft-1',
    reason: 'Steuerliche Compliance geprüft',
  });
});

test('Pro HTTP Billme API reports the migration-owned PGlite chart as an honest no-op', async () => {
  const requestUrls: string[] = [];
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({
      baseUrl: 'http://127.0.0.1:43123',
      token: 'local-token',
    }),
    fetch: async (input) => {
      requestUrls.push(String(input));
      return response({ total: 8, byChart: { SKR03: 5, SKR04: 3 } });
    },
  });

  assert.deepEqual(await api.pro.importSkr({ preferredSource: 'auto', strictOnly: true }), {
    source: 'none',
    sourceDetails: ['server://pglite-migrations'],
    inserted: 0,
    updated: 0,
    total: 8,
    skipped: 0,
    warnings: ['Der Kontenrahmen wird im Embedded-/PGlite-Modus durch Migrationen verwaltet; es wurde kein Import ausgeführt.'],
    stats: { total: 8, byChart: { SKR03: 5, SKR04: 3 } },
  });
  assert.deepEqual(requestUrls, ['http://127.0.0.1:43123/api/v1/pro/accounting/ledger/stats']);
});

test('Pro HTTP Billme API falls back exactly for tax validation and SKR import without fetching', async () => {
  const calls: Array<{ key: IpcRouteKey; args: unknown }> = [];
  let fetchCalls = 0;
  const fallback = async <K extends IpcRouteKey>(key: K, args: IpcArgs<K>): Promise<IpcResult<K>> => {
    calls.push({ key, args });
    if (key === 'pro:validateTaxCompliance') {
      return { ok: false, issues: [] } as IpcResult<K>;
    }
    return {
      source: 'csv',
      sourceDetails: ['legacy-skr.csv'],
      inserted: 1,
      updated: 0,
      total: 1,
      skipped: 0,
      warnings: [],
      stats: { total: 1, byChart: { SKR03: 1, SKR04: 0 } },
    } as IpcResult<K>;
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => null,
    fallback,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('HTTP must not be used while embedded server is unavailable');
    },
  });

  assert.deepEqual(await api.pro.validateTaxCompliance({ transactionId: 'tx-1' }), { ok: false, issues: [] });
  assert.deepEqual(await api.pro.importSkr({ preferredSource: 'csv' }), {
    source: 'csv',
    sourceDetails: ['legacy-skr.csv'],
    inserted: 1,
    updated: 0,
    total: 1,
    skipped: 0,
    warnings: [],
    stats: { total: 1, byChart: { SKR03: 1, SKR04: 0 } },
  });
  assert.equal(fetchCalls, 0);
  assert.deepEqual(calls, [
    { key: 'pro:validateTaxCompliance', args: { transactionId: 'tx-1' } },
    { key: 'pro:importSkr', args: { preferredSource: 'csv' } },
  ]);
});

test('Pro HTTP Billme API rejects ledger stats that violate the Pro contract', async () => {
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({
      baseUrl: 'http://127.0.0.1:43123',
      token: 'local-token',
    }),
    fetch: async () => response({ total: 2, byChart: { SKR03: 2 } }),
  });

  await assert.rejects(
    api.pro.getLedgerStats(),
    (error: unknown) => error instanceof z.ZodError,
  );
});

test('Pro HTTP Billme API delegates ledger stats to the exact IPC fallback when embedded server is unavailable', async () => {
  const calls: Array<{ key: IpcRouteKey; args: unknown }> = [];
  const fallback = async <K extends IpcRouteKey>(key: K, args: IpcArgs<K>): Promise<IpcResult<K>> => {
    calls.push({ key, args });
    return { total: 7, byChart: { SKR03: 4, SKR04: 3 } } as IpcResult<K>;
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => null,
    fallback,
    fetch: async () => {
      throw new Error('HTTP must not be used while embedded server is unavailable');
    },
  });

  assert.deepEqual(await api.pro.getLedgerStats(), {
    total: 7,
    byChart: { SKR03: 4, SKR04: 3 },
  });
  assert.deepEqual(calls, [{ key: 'pro:getLedgerStats', args: undefined }]);
});

test('Pro HTTP Billme API routes ledger accounts through HTTP with contract args and result parsing', async () => {
  let requestUrl = '';
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({
      baseUrl: 'http://127.0.0.1:43123',
      token: 'local-token',
    }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response([{
        id: 'ledger-1',
        chart: 'SKR03',
        accountNumber: '1200',
        name: 'Bank',
        source: 'skr03',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }]);
    },
  });

  assert.deepEqual(await api.pro.listLedgerAccounts({ chart: 'SKR03', search: 'Bank', limit: 10, offset: 2 }), [{
    id: 'ledger-1',
    chart: 'SKR03',
    accountNumber: '1200',
    name: 'Bank',
    source: 'skr03',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/ledger/accounts?chart=SKR03&search=Bank&limit=10&offset=2');
});

test('Pro HTTP Billme API falls back to IPC for ledger accounts without an embedded connection', async () => {
  const calls: Array<{ key: IpcRouteKey; args: unknown }> = [];
  const fallback = async <K extends IpcRouteKey>(key: K, args: IpcArgs<K>): Promise<IpcResult<K>> => {
    calls.push({ key, args });
    return [{
      id: 'ledger-1',
      chart: 'SKR03',
      accountNumber: '1200',
      name: 'Bank',
      source: 'skr03',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }] as IpcResult<K>;
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => null,
    fallback,
    fetch: async () => {
      throw new Error('HTTP must not be used while embedded server is unavailable');
    },
  });

  assert.deepEqual(await api.pro.listLedgerAccounts({ chart: 'SKR03' }), [{
    id: 'ledger-1',
    chart: 'SKR03',
    accountNumber: '1200',
    name: 'Bank',
    source: 'skr03',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }]);
  assert.deepEqual(calls, [{ key: 'pro:listLedgerAccounts', args: { chart: 'SKR03' } }]);
});

test('Pro HTTP Billme API routes tax cases through HTTP with contract query args', async () => {
  let requestUrl = '';
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response([{
        key: 'DE_STD_19',
        label: 'Regelsteuersatz 19 %',
        mechanism: 'standard_vat',
        defaultRate: 19,
        requiresCounterpartyVatId: false,
        requiresCountry: false,
        requiresEvidence: false,
        active: true,
      }]);
    },
  });

  assert.deepEqual(await api.pro.listTaxCases({ activeOnly: true }), [{
    key: 'DE_STD_19',
    label: 'Regelsteuersatz 19 %',
    mechanism: 'standard_vat',
    defaultRate: 19,
    requiresCounterpartyVatId: false,
    requiresCountry: false,
    requiresEvidence: false,
    active: true,
  }]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/tax-cases?activeOnly=true');
});

test('Pro HTTP Billme API routes tax-case account mappings through HTTP with contract query args', async () => {
  let requestUrl = '';
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response([{
        id: 'mapping-1',
        chart: 'SKR04',
        taxCaseKey: 'DE_STD_19',
        role: 'output_tax',
        accountNumber: '1776',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }]);
    },
  });

  assert.deepEqual(await api.pro.listTaxCaseAccountMappings({ chart: 'SKR04', taxCaseKey: 'DE_STD_19' }), [{
    id: 'mapping-1',
    chart: 'SKR04',
    taxCaseKey: 'DE_STD_19',
    role: 'output_tax',
    accountNumber: '1776',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/tax-case-account-mappings?chart=SKR04&taxCaseKey=DE_STD_19');
});

test('Pro HTTP Billme API routes account suggestion rules through HTTP with contract query args', async () => {
  let requestUrl = '';
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response([{
        id: 'rule-1',
        tenantId: 'tenant-1',
        chart: 'SKR03',
        priority: 1,
        field: 'counterparty',
        operator: 'contains',
        value: 'Büro',
        targetAccountNumber: '4930',
        flowType: 'expense',
        active: true,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }]);
    },
  });

  assert.deepEqual(await api.pro.listAccountSuggestionRules({ chart: 'SKR03', activeOnly: false }), [{
    id: 'rule-1',
    tenantId: 'tenant-1',
    chart: 'SKR03',
    priority: 1,
    field: 'counterparty',
    operator: 'contains',
    value: 'Büro',
    targetAccountNumber: '4930',
    flowType: 'expense',
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/account-suggestion-rules?chart=SKR03&activeOnly=false');
});

test('Pro HTTP Billme API routes workflow entries through HTTP', async () => {
  let requestUrl = '';
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response([{
        transactionId: 'transaction-1',
        transactionJson: '{}',
        draftJson: '{}',
        updatedAt: '2026-01-01T00:00:00.000Z',
      }]);
    },
  });

  assert.deepEqual(await api.pro.listWorkflowEntries(), [{
    transactionId: 'transaction-1',
    transactionJson: '{}',
    draftJson: '{}',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/workflow');
});

test('Pro HTTP Billme API routes the accounting policy through HTTP', async () => {
  let requestUrl = '';
  const policy = {
    tenantId: 'tenant-1',
    activeChart: 'SKR03',
    vatMethod: 'soll',
    periodPolicy: 'calendar_month',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response(policy);
    },
  });

  assert.deepEqual(await api.pro.getAccountingPolicy(), policy);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/policy');
});

test('Pro HTTP Billme API routes vendors through HTTP', async () => {
  let requestUrl = '';
  const vendor = {
    id: 'vendor-1',
    tenantId: 'tenant-1',
    name: 'Lieferant GmbH',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response([vendor]);
    },
  });

  assert.deepEqual(await api.pro.listVendors(), [vendor]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/vendors');
});

test('Pro HTTP Billme API routes incoming invoices through HTTP', async () => {
  let requestUrl = '';
  const invoice = {
    id: 'incoming-1',
    tenantId: 'tenant-1',
    vendorId: 'vendor-1',
    number: 'RE-2026-001',
    invoiceDate: '2026-01-01',
    dueDate: '2026-01-31',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    status: 'open',
    taxRate: 19,
    lines: [{
      id: 'line-1',
      incomingInvoiceId: 'incoming-1',
      position: 1,
      description: 'Büromaterial',
      quantity: 1,
      unitPrice: 100,
      netAmount: 100,
      taxRate: 19,
      taxAmount: 19,
      grossAmount: 119,
    }],
    accountingStatus: 'unposted',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response([invoice]);
    },
  });

  assert.deepEqual(await api.pro.listIncomingInvoices(), [invoice]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/incoming-invoices');
});

test('Pro HTTP Billme API routes open items through HTTP', async () => {
  let requestUrl = '';
  const item = {
    id: 'open-item-1',
    tenantId: 'tenant-1',
    partyType: 'creditor',
    partyId: 'vendor-1',
    sourceType: 'incoming_invoice',
    sourceId: 'incoming-1',
    documentNumber: 'RE-2026-001',
    documentDate: '2026-01-01',
    dueDate: '2026-01-31',
    originalAmount: 119,
    allocatedAmount: 0,
    residualAmount: 119,
    status: 'open',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response([item]);
    },
  });

  assert.deepEqual(await api.pro.listOpenItems(), [item]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/open-items');
});

test('Pro HTTP Billme API routes accounting health through HTTP and validates the result contract', async () => {
  let requestUrl = '';
  const health = {
    draftCount: 2,
    postedCount: 7,
    reversedCount: 1,
    unbalancedDraftCount: 0,
    unmappedAccountCount: 0,
    unmappedAccounts: [],
    blocking: false,
    lastDatevExportAt: '2026-01-01T00:00:00.000Z',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response(health);
    },
  });

  assert.deepEqual(await api.pro.getAccountingHealth(), health);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/health');
});

test('Pro HTTP Billme API routes the VAT summary through HTTP with contract query args', async () => {
  let requestUrl = '';
  const summary = {
    from: '2026-01-01',
    to: '2026-01-31',
    rows: [{
      taxCaseKey: 'DE_STD_19',
      netAmount: 100,
      taxAmount: 19,
      grossAmount: 119,
      lineCount: 1,
    }],
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response(summary);
    },
  });

  assert.deepEqual(await api.pro.getVatSummary({ from: '2026-01-01', to: '2026-01-31' }), summary);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/vat/summary?from=2026-01-01&to=2026-01-31');
});

test('Pro HTTP Billme API falls back to IPC without fetch for every classified read route', async () => {
  const calls: Array<{ key: IpcRouteKey; args: unknown }> = [];
  const fallback = async <K extends IpcRouteKey>(key: K, args: IpcArgs<K>): Promise<IpcResult<K>> => {
    calls.push({ key, args });
    return [] as IpcResult<K>;
  };
  let fetchCalls = 0;
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => null,
    fallback,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('HTTP must not be used while embedded server is unavailable');
    },
  });

  await api.pro.listLedgerAccounts({ chart: 'SKR03' });
  await api.pro.listTaxCases({ activeOnly: true });
  await api.pro.listTaxCaseAccountMappings({ chart: 'SKR03' });
  await api.pro.getLedgerStats();
  await api.pro.listAccountSuggestionRules({ activeOnly: true });
  await api.pro.listWorkflowEntries();
  await api.pro.getAccountingPolicy();
  await api.pro.listVendors();
  await api.pro.listIncomingInvoices();
  await api.pro.listOpenItems();
  await api.pro.getAccountingHealth();
  await api.pro.getVatSummary({ from: '2026-01-01' });

  assert.equal(fetchCalls, 0);
  assert.deepEqual(calls.map(({ key }) => key), [
    'pro:listLedgerAccounts',
    'pro:listTaxCases',
    'pro:listTaxCaseAccountMappings',
    'pro:getLedgerStats',
    'pro:listAccountSuggestionRules',
    'pro:listWorkflowEntries',
    'pro:getAccountingPolicy',
    'pro:listVendors',
    'pro:listIncomingInvoices',
    'pro:listOpenItems',
    'pro:getAccountingHealth',
    'pro:getVatSummary',
  ]);
  assert.deepEqual(calls.map(({ args }) => args), [
    { chart: 'SKR03' },
    { activeOnly: true },
    { chart: 'SKR03' },
    undefined,
    { activeOnly: true },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { from: '2026-01-01' },
  ]);
});

test('Pro HTTP Billme API falls back to IPC for asset reads without an embedded connection', async () => {
  const calls: Array<{ key: IpcRouteKey; args: unknown }> = [];
  const fallback = async <K extends IpcRouteKey>(key: K, args: IpcArgs<K>): Promise<IpcResult<K>> => {
    calls.push({ key, args });
    return [] as IpcResult<K>;
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => null,
    fallback,
    fetch: async () => {
      throw new Error('non-classified routes must not use HTTP');
    },
  });

  assert.deepEqual(await api.pro.listAssets(), []);
  assert.deepEqual(calls, [{ key: 'pro:listAssets', args: undefined }]);
});

test('Pro HTTP Billme API routes bank transactions through the accounting transaction endpoint', async () => {
  let requestUrl = '';
  const transaction = {
    id: 'transaction-1',
    date: '2026-01-15',
    amount: 119,
    type: 'income' as const,
    counterparty: 'Kunde GmbH',
    purpose: 'Rechnung 2026-1',
    status: 'booked' as const,
    accountId: 'bank-account-1',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response([transaction]);
    },
  });

  assert.deepEqual(await api.pro.listBankTransactions(), [transaction]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/transactions');
});

test('Pro HTTP Billme API routes a draft lookup by transaction id through the accounting drafts endpoint', async () => {
  let requestUrl = '';
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response(null);
    },
  });

  assert.equal(await api.pro.getDraftByTransactionId({ transactionId: 'transaction-1' }), null);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/drafts/transaction-1');
});

test('Pro HTTP Billme API saves a draft with the server audit reason', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const draft = {
    id: 'draft-1',
    tenantId: 'tenant-1',
    transactionId: 'transaction-1',
    workflowStatus: 'incomplete' as const,
    postingDate: '2026-01-15',
    documentDate: '2026-01-15',
    bookingText: 'Bankbuchung',
    period: '2026-01',
    fiscalYear: 2026,
    lines: [],
    validationIssues: [],
    updatedAt: '2026-01-15T00:00:00.000Z',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(draft);
    },
  });

  assert.deepEqual(await api.pro.saveDraft({ draft }), draft);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/drafts');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    reason: 'Buchungsentwurf gespeichert',
    draft,
  });
});

test('Pro HTTP Billme API dispatches a draft action with its rejection detail', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const draft = {
    id: 'draft-1',
    tenantId: 'tenant-1',
    transactionId: 'transaction-1',
    workflowStatus: 'incomplete' as const,
    bookingText: 'Bankbuchung',
    period: '2026-01',
    fiscalYear: 2026,
    lines: [],
    validationIssues: [],
    updatedAt: '2026-01-15T00:00:00.000Z',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(draft);
    },
  });

  assert.deepEqual(await api.pro.dispatchDraftAction({
    transactionId: 'transaction-1',
    action: 'reject',
    rejectReason: 'Beleg fehlt',
  }), draft);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/drafts/transaction-1/action');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    reason: 'Buchungsworkflow-Aktion ausgeführt',
    action: 'reject',
    rejectReason: 'Beleg fehlt',
  });
});

test('Pro HTTP Billme API posts a draft with retry and soft-lock options intact', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const result = {
    entry: {
      id: 'entry-1',
      tenantId: 'tenant-1',
      entryNumber: 1,
      postingDate: '2026-01-16',
      bookingText: 'Bankbuchung',
      period: '2026-01',
      fiscalYear: 2026,
      status: 'posted' as const,
      createdAt: '2026-01-16T00:00:00.000Z',
      lines: [],
    },
    issues: [],
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(result);
    },
  });

  assert.deepEqual(await api.pro.postDraft({
    draftId: 'draft-1',
    postingDate: '2026-01-16',
    idempotencyKey: 'draft-post-1',
    softLockOverride: true,
    overrideReason: 'Freigabe durch Buchhaltung',
  }), result);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/drafts/draft-1/post');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    reason: 'Buchungsentwurf gebucht',
    postingDate: '2026-01-16',
    idempotencyKey: 'draft-post-1',
    softLockOverride: true,
    overrideReason: 'Freigabe durch Buchhaltung',
  });
});

test('Pro HTTP Billme API reverses a journal entry with its exact reason and lock options', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const result = { ok: true as const, reversalEntryId: 'reversal-1' };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(result);
    },
  });

  assert.deepEqual(await api.pro.reverseJournalEntry({
    entryId: 'entry-1',
    reason: 'Fehlerhafte Buchung storniert',
    postingDate: '2026-01-17',
    softLockOverride: true,
    overrideReason: 'Freigabe durch Buchhaltung',
  }), result);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/journal/entry-1/reverse');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    reason: 'Fehlerhafte Buchung storniert',
    postingDate: '2026-01-17',
    softLockOverride: true,
    overrideReason: 'Freigabe durch Buchhaltung',
  });
});

test('Pro HTTP Billme API lists journal entries with all filters intact', async () => {
  let requestUrl = '';
  const entry = {
    id: 'entry-1',
    tenantId: 'tenant-1',
    entryNumber: 1,
    postingDate: '2026-01-16',
    bookingText: 'Bankbuchung',
    period: '2026-01',
    fiscalYear: 2026,
    status: 'posted' as const,
    createdAt: '2026-01-16T00:00:00.000Z',
    lines: [],
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response([entry]);
    },
  });

  assert.deepEqual(await api.pro.listJournalEntries({
    from: '2026-01-01',
    to: '2026-01-31',
    accountNumbers: ['1200', '1400'],
    limit: 10,
    offset: 20,
  }), [entry]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/journal?from=2026-01-01&to=2026-01-31&accountNumbers=1200&accountNumbers=1400&limit=10&offset=20');
});

test('Pro HTTP Billme API gets a journal entry by id', async () => {
  let requestUrl = '';
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response(null);
    },
  });

  assert.equal(await api.pro.getJournalEntryById({ entryId: 'entry/1' }), null);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/journal/entry%2F1');
});

test('Pro HTTP Billme API gets ledger balances with the complete date range', async () => {
  let requestUrl = '';
  const balances = [{
    accountNumber: '1200',
    openingBalance: 10,
    debitTurnover: 100,
    creditTurnover: 20,
    closingBalance: 90,
  }];
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response(balances);
    },
  });

  assert.deepEqual(await api.pro.getLedgerBalances({
    asOfDate: '2026-01-31',
    from: '2026-01-01',
    to: '2026-01-31',
  }), balances);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/balances?asOfDate=2026-01-31&from=2026-01-01&to=2026-01-31');
});

test('Pro HTTP Billme API lists accounting source runs without losing revision or idempotency data', async () => {
  let requestUrl = '';
  const run = {
    id: 'run-1',
    tenantId: 'tenant-1',
    sourceType: 'standalone_source' as const,
    sourceId: 'source-1',
    sourceRevision: 'revision-7',
    idempotencyKey: 'source:source-1',
    fact: {
      sourceType: 'standalone_source' as const,
      sourceId: 'source-1',
      sourceRevision: 'revision-7',
      effectiveDate: '2026-01-16',
      postingDate: '2026-01-16',
      period: '2026-01',
      fiscalYear: 2026,
      currency: 'EUR',
      bookingText: 'Manuelle Buchung',
      lines: [],
    },
    result: {},
    status: 'posted' as const,
    journalEntryId: 'entry-1',
    createdAt: '2026-01-16T00:00:00.000Z',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response([run]);
    },
  });

  assert.deepEqual(await api.pro.listAccountingSourceRuns(), [run]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/source-runs');
});

test('Pro HTTP Billme API gets one accounting source run by id', async () => {
  let requestUrl = '';
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response(null);
    },
  });

  assert.equal(await api.pro.getAccountingSourceRun({ id: 'run/1' }), null);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/source-runs/run%2F1');
});

test('Pro HTTP Billme API posts a standalone accounting source with identity and lock fields intact', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const source = {
    sourceType: 'standalone_source' as const,
    sourceId: 'source-1',
    sourceRevision: 'revision-7',
    effectiveDate: '2026-01-16',
    postingDate: '2026-01-16',
    period: '2026-01',
    fiscalYear: 2026,
    currency: 'EUR',
    bookingText: 'Manuelle Buchung',
    lines: [
      { accountNumber: '1200', debitAmount: 100, creditAmount: 0 },
      { accountNumber: '8400', debitAmount: 0, creditAmount: 100 },
    ],
  };
  const result = {
    status: 'posted' as const,
    sourceRun: {
      id: 'run-1',
      tenantId: 'tenant-1',
      sourceType: 'standalone_source' as const,
      sourceId: 'source-1',
      sourceRevision: 'revision-7',
      idempotencyKey: 'source:source-1',
      fact: source,
      result: {},
      status: 'posted' as const,
      createdAt: '2026-01-16T00:00:00.000Z',
    },
    errors: [],
    idempotencyKey: 'source:source-1',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(result);
    },
  });

  assert.deepEqual(await api.pro.postAccountingSource({
    source,
    chart: 'SKR04',
    softLockOverride: true,
    overrideReason: 'Freigabe durch Buchhaltung',
    reason: 'Manuelle Buchung erfasst',
    provenance: { origin: 'desktop-test' },
  }), result);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/closing');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    input: { ...source, reference: 'standalone' },
    sourceId: 'source-1',
    sourceRevision: 'revision-7',
    idempotencyKey: 'source:source-1',
    reason: 'Manuelle Buchung erfasst',
    chart: 'SKR04',
    softLockOverride: true,
    overrideReason: 'Freigabe durch Buchhaltung',
    provenance: { origin: 'desktop-test' },
  });
});

test('Pro HTTP Billme API posts a domain accounting command and maps the server run to the Pro result contract', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const source = {
    sourceType: 'fiscal_close' as const,
    sourceId: 'close-1',
    sourceRevision: 'revision-8',
    effectiveDate: '2026-12-31',
    postingDate: '2026-12-31',
    period: '2026-12',
    fiscalYear: 2026,
    currency: 'EUR',
    bookingText: 'Jahresabschluss',
    lines: [],
  };
  const serverRun = {
    id: 'run-2',
    tenantId: 'tenant-1',
    sourceType: 'fiscal_close',
    sourceId: 'close-1',
    sourceRevision: 'revision-8',
    idempotencyKey: 'source:close-1',
    source: { command: 'fiscal_close', input: source },
    result: { command: 'fiscal_close', journalEntryIds: ['entry-2'] },
    status: 'posted',
    journalEntryId: 'entry-2',
    createdAt: '2026-12-31T00:00:00.000Z',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response({
        run: serverRun,
        result: { command: 'fiscal_close', journalEntryIds: ['entry-2'] },
        replayed: false,
      });
    },
  });

  const result = await api.pro.postAccountingCommand({
    kind: 'fiscal_close',
    source,
    domainFacts: { closeDate: '2026-12-31', sourceId: 'close-1', period: '2026-12', fiscalYear: 2026 },
    chart: 'SKR03',
    reason: 'Jahresabschluss gebucht',
  });
  assert.equal(result.status, 'posted');
  assert.equal(result.idempotencyKey, 'source:close-1');
  assert.equal(result.sourceRun?.sourceRevision, 'revision-8');
  assert.equal(result.sourceRun?.journalEntryId, 'entry-2');
  assert.deepEqual(result.command, 'fiscal_close');
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/closing');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    command: 'fiscal_close',
    input: { closeDate: '2026-12-31', sourceId: 'close-1', period: '2026-12', fiscalYear: 2026, sourceRevision: 'revision-8' },
    sourceId: 'close-1',
    sourceRevision: 'revision-8',
    idempotencyKey: 'source:close-1',
    reason: 'Jahresabschluss gebucht',
    chart: 'SKR03',
  });
});

test('Pro HTTP adapter resolves embedded connections and sends the local token', async () => {
  let requestUrl = '';
  let requestHeaders: HeadersInit | undefined;

  const client = createProWebClient({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({
      baseUrl: 'http://127.0.0.1:43123',
      token: 'local-token',
    }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestHeaders = init?.headers;
      return response({ total: 2, byChart: { SKR03: 2, SKR04: 0 } });
    },
  });

  assert.deepEqual(await client.getLedgerStats(), {
    total: 2,
    byChart: { SKR03: 2, SKR04: 0 },
  });
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/ledger/stats');
  const headers = new Headers(requestHeaders);
  assert.equal(headers.get('x-billme-local-token'), 'local-token');
  assert.equal(headers.get('authorization'), null);
});

test('Pro HTTP adapter exposes an unavailable embedded connection for a later fallback', async () => {
  let fetchCalls = 0;
  const client = createProWebClient({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => null,
    fetch: async () => {
      fetchCalls += 1;
      return response({ total: 0, byChart: { SKR03: 0, SKR04: 0 } });
    },
  });

  await assert.rejects(
    client.getLedgerStats(),
    (error: unknown) => error instanceof ProEmbeddedConnectionUnavailableError
      && error.code === 'PRO_EMBEDDED_CONNECTION_UNAVAILABLE',
  );
  assert.equal(fetchCalls, 0);
});

test('Pro HTTP adapter preserves hosted bearer authentication', async () => {
  let requestUrl = '';
  let requestHeaders: HeadersInit | undefined;
  const client = createProWebClient({
    baseUrl: 'https://hosted.example.test/',
    getToken: () => 'hosted-token',
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestHeaders = init?.headers;
      return response({ total: 0, byChart: { SKR03: 0, SKR04: 0 } });
    },
  });

  await client.getLedgerStats();

  assert.equal(requestUrl, 'https://hosted.example.test/api/v1/pro/accounting/ledger/stats');
  const headers = new Headers(requestHeaders);
  assert.equal(headers.get('authorization'), 'Bearer hosted-token');
  assert.equal(headers.get('x-billme-local-token'), null);
});

test('Pro HTTP adapter upserts tax-case account mappings with the contract body', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const mapping = {
    id: 'mapping-1',
    chart: 'SKR04' as const,
    taxCaseKey: 'DE_STD_19' as const,
    role: 'output_tax' as const,
    accountNumber: '1776',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(mapping);
    },
  });

  assert.deepEqual(await api.pro.upsertTaxCaseAccountMapping({
    ...mapping,
    reason: 'USt-Zuordnung korrigiert',
  }), mapping);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/tax-case-account-mappings');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    id: mapping.id,
    chart: mapping.chart,
    taxCaseKey: mapping.taxCaseKey,
    role: mapping.role,
    accountNumber: mapping.accountNumber,
    reason: 'USt-Zuordnung korrigiert',
  });
});

test('Pro HTTP adapter upserts account-suggestion rules with the mutation reason', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const rule = {
    id: 'rule-1',
    tenantId: 'tenant-1',
    chart: 'SKR03' as const,
    priority: 1,
    field: 'purpose' as const,
    operator: 'contains' as const,
    value: 'Büro',
    targetAccountNumber: '4930',
    flowType: 'expense' as const,
    active: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(rule);
    },
  });

  assert.deepEqual(await api.pro.upsertAccountSuggestionRule({
    ...rule,
    reason: 'Regel für Büromaterial gespeichert',
  }), rule);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/account-suggestion-rules');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    id: rule.id,
    chart: rule.chart,
    priority: rule.priority,
    field: rule.field,
    operator: rule.operator,
    value: rule.value,
    targetAccountNumber: rule.targetAccountNumber,
    flowType: rule.flowType,
    active: rule.active,
    reason: 'Regel für Büromaterial gespeichert',
  });
});

test('Pro HTTP adapter deletes account-suggestion rules with the reason in the query', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response({ ok: true });
    },
  });

  assert.deepEqual(await api.pro.deleteAccountSuggestionRule({ id: 'rule-1', reason: 'Regel entfernt' }), { ok: true });
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/account-suggestion-rules/rule-1?reason=Regel+entfernt');
  assert.equal(requestInit?.method, 'DELETE');
  assert.equal(requestInit?.body, undefined);
});

test('Pro HTTP adapter upserts workflow entries and validates the acknowledgement', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response({ ok: true });
    },
  });

  assert.deepEqual(await api.pro.upsertWorkflowEntry({
    transactionId: 'transaction-1',
    transactionJson: '{}',
    draftJson: '{}',
  }), { ok: true });
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/workflow');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    transactionId: 'transaction-1',
    transactionJson: '{}',
    draftJson: '{}',
  });
});

test('Pro HTTP adapter sets the accounting policy with an auditable reason', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const policy = {
    tenantId: 'tenant-1',
    activeChart: 'SKR04' as const,
    vatMethod: 'ist' as const,
    periodPolicy: 'calendar_month' as const,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(policy);
    },
  });

  assert.deepEqual(await api.pro.setAccountingPolicy({ activeChart: 'SKR04', vatMethod: 'ist' }), policy);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/policy');
  assert.equal(requestInit?.method, 'PUT');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    activeChart: 'SKR04',
    vatMethod: 'ist',
    reason: 'Kontierungspolitik geändert',
  });
});

test('Pro HTTP adapter upserts vendors with the mutation reason', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const vendor = {
    id: 'vendor-1',
    tenantId: 'tenant-1',
    vendorNumber: 'V-001',
    name: 'Lieferant GmbH',
    email: 'rechnung@lieferant.example',
    address: 'Musterweg 1',
    vatId: 'DE123456789',
    iban: 'DE02120300000000202051',
    defaultExpenseAccount: '4930',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(vendor);
    },
  });

  assert.deepEqual(await api.pro.upsertVendor({ vendor, reason: 'Lieferant aktualisiert' }), vendor);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/vendors');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    vendor: {
      id: vendor.id,
      vendorNumber: vendor.vendorNumber,
      name: vendor.name,
      email: vendor.email,
      address: vendor.address,
      vatId: vendor.vatId,
      iban: vendor.iban,
      defaultExpenseAccount: vendor.defaultExpenseAccount,
    },
    reason: 'Lieferant aktualisiert',
  });
});

test('Pro HTTP adapter upserts incoming invoices with a server-safe payload and reason', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const invoice = {
    id: 'incoming-1',
    tenantId: 'tenant-1',
    vendorId: 'vendor-1',
    number: 'RE-2026-001',
    invoiceDate: '2026-01-01',
    dueDate: '2026-01-31',
    netAmount: 100,
    taxAmount: 19,
    grossAmount: 119,
    status: 'open' as const,
    taxRate: 19,
    lines: [{
      id: 'line-1',
      incomingInvoiceId: 'incoming-1',
      position: 1,
      description: 'Büromaterial',
      quantity: 1,
      unitPrice: 100,
      netAmount: 100,
      taxRate: 19,
      taxAmount: 19,
      grossAmount: 119,
    }],
    accountingStatus: 'unposted' as const,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(invoice);
    },
  });

  assert.deepEqual(await api.pro.upsertIncomingInvoice({ invoice, reason: 'Eingangsrechnung gespeichert' }), invoice);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/incoming-invoices');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    invoice: {
      id: invoice.id,
      vendorId: invoice.vendorId,
      number: invoice.number,
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      netAmount: invoice.netAmount,
      taxAmount: invoice.taxAmount,
      grossAmount: invoice.grossAmount,
      status: invoice.status,
      taxRate: invoice.taxRate,
      lines: invoice.lines,
    },
    reason: 'Eingangsrechnung gespeichert',
  });
});

test('Pro HTTP adapter previews outgoing invoice accounting with a reason', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const preview = {
    sourceType: 'outgoing_invoice' as const,
    sourceId: 'invoice-1',
    status: 'unresolved' as const,
    reason: 'Kontierung nicht vollständig',
    issues: [],
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(preview);
    },
  });

  assert.deepEqual(await api.pro.previewOutgoingInvoiceAccounting({ invoiceId: 'invoice-1' }), preview);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/outgoing-invoices/preview');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), { invoiceId: 'invoice-1', reason: 'Vorschau' });
});

test('Pro HTTP adapter posts outgoing invoice accounting with reservation and reason', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const posted = {
    sourceType: 'outgoing_invoice' as const,
    sourceId: 'invoice-1',
    status: 'ready' as const,
    issues: [],
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(posted);
    },
  });

  assert.deepEqual(await api.pro.postOutgoingInvoiceAccounting({ invoiceId: 'invoice-1', reservationId: 'reservation-1' }), posted);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/outgoing-invoices/post');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    invoiceId: 'invoice-1',
    reason: 'Ausgangsrechnung gebucht',
    reservationId: 'reservation-1',
  });
});

test('Pro HTTP adapter previews incoming invoice accounting with a reason', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const preview = {
    sourceType: 'incoming_invoice' as const,
    sourceId: 'incoming-1',
    status: 'unresolved' as const,
    reason: 'Kontierung nicht vollständig',
    issues: [],
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(preview);
    },
  });

  assert.deepEqual(await api.pro.previewIncomingInvoiceAccounting({ invoiceId: 'incoming-1' }), preview);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/incoming-invoices/preview');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), { invoiceId: 'incoming-1', reason: 'Vorschau' });
});

test('Pro HTTP adapter posts incoming invoice accounting with reason and lock options', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const posted = {
    sourceType: 'incoming_invoice' as const,
    sourceId: 'incoming-1',
    status: 'ready' as const,
    issues: [],
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(posted);
    },
  });

  assert.deepEqual(await api.pro.postIncomingInvoiceAccounting({
    invoiceId: 'incoming-1',
    reason: 'Eingangsrechnung gebucht',
    softLockOverride: true,
    overrideReason: 'Abschlussprüfung freigegeben',
  }), posted);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/incoming-invoices/post');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    invoiceId: 'incoming-1',
    reason: 'Eingangsrechnung gebucht',
    softLockOverride: true,
    overrideReason: 'Abschlussprüfung freigegeben',
  });
});

test('Pro HTTP adapter allocates an open-item payment with its stable retry ID', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const payment = {
    id: 'payment-1',
    tenantId: 'tenant-1',
    partyType: 'debtor' as const,
    partyId: 'client-1',
    paymentDate: '2026-01-15',
    amount: 119,
    bankAccountNumber: '1200',
    method: 'bank_transfer',
    sourceType: 'bank_transaction' as const,
    sourceId: 'bank-tx-1',
    allocatedAmount: 119,
    residualAmount: 0,
    status: 'allocated' as const,
    journalEntryId: 'journal-1',
    createdAt: '2026-01-15T00:00:00.000Z',
  };
  const input = {
    sourceType: 'bank_transaction' as const,
    sourceId: 'bank-tx-1',
    partyType: 'debtor' as const,
    partyId: 'client-1',
    paymentDate: '2026-01-15',
    amount: 119,
    bankAccountNumber: '1200',
    method: 'bank_transfer',
    allocations: [{ openItemId: 'open-item-1', amount: 119 }],
    reason: 'Zahlung zugeordnet',
    allocationEventId: 'allocation-event-1',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (inputUrl, init) => {
      requestUrl = String(inputUrl);
      requestInit = init;
      return response(payment);
    },
  });

  assert.deepEqual(await api.pro.allocateOpenItemPayment({ payment: input }), payment);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/open-items/payments');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    payment: {
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      partyType: input.partyType,
      partyId: input.partyId,
      paymentDate: input.paymentDate,
      amount: input.amount,
      bankAccountNumber: input.bankAccountNumber,
      method: input.method,
      allocations: input.allocations,
      allocationEventId: input.allocationEventId,
    },
    reason: input.reason,
  });
});

test('Pro HTTP adapter allocates the remaining payment with retry ID in the body and URL ID', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const payment = {
    id: 'payment-1',
    tenantId: 'tenant-1',
    partyType: 'debtor' as const,
    partyId: 'client-1',
    paymentDate: '2026-01-15',
    amount: 119,
    bankAccountNumber: '1200',
    sourceType: 'bank_transaction' as const,
    sourceId: 'bank-tx-1',
    allocatedAmount: 119,
    residualAmount: 0,
    status: 'allocated' as const,
    createdAt: '2026-01-15T00:00:00.000Z',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(payment);
    },
  });

  assert.deepEqual(await api.pro.allocateRemainingPayment({
    paymentId: 'payment-1',
    allocations: [{ openItemId: 'open-item-2', amount: 119 }],
    reason: 'Restzahlung zugeordnet',
    allocationEventId: 'allocation-event-2',
  }), payment);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/open-items/payments/payment-1/remaining');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    paymentId: 'payment-1',
    allocations: [{ openItemId: 'open-item-2', amount: 119 }],
    reason: 'Restzahlung zugeordnet',
    allocationEventId: 'allocation-event-2',
  });
});

test('Pro HTTP adapter reverses document accounting with the contract reason', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const reversal = { ok: true as const, reversalEntryId: 'reversal-1' };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(reversal);
    },
  });

  assert.deepEqual(await api.pro.reverseDocumentAccounting({
    documentType: 'outgoing_invoice',
    documentId: 'invoice-1',
    reason: 'Ausgangsrechnung storniert',
    postingDate: '2026-01-20',
  }), reversal);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/documents/reverse');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    documentType: 'outgoing_invoice',
    documentId: 'invoice-1',
    reason: 'Ausgangsrechnung storniert',
    postingDate: '2026-01-20',
  });
});

test('Pro HTTP adapter previews accounting backfill and validates candidates', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const preview = {
    runId: 'backfill-run-1',
    status: 'preview' as const,
    candidates: [{
      sourceType: 'legacy_transaction' as const,
      sourceId: 'transaction-1',
      status: 'unresolved' as const,
      reason: 'Manuelle Prüfung erforderlich',
      sourceVersion: 'hash-1',
    }],
    readyCount: 0,
    unresolvedCount: 1,
    confirmationHash: 'confirmation-hash-1',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(preview);
    },
  });

  assert.deepEqual(await api.pro.previewAccountingBackfill(), preview);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/backfill/preview');
  assert.equal(requestInit?.method, 'GET');
  assert.equal(requestInit?.body, undefined);
});

test('Pro HTTP adapter confirms accounting backfill with its confirmation hash and reason', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const result = {
    runId: 'backfill-run-1',
    postedCount: 3,
    unresolvedCount: 1,
    status: 'completed' as const,
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(result);
    },
  });

  assert.deepEqual(await api.pro.confirmAccountingBackfill({
    runId: 'backfill-run-1',
    confirmationHash: 'confirmation-hash-1',
    reason: 'Backfill bestätigt',
  }), result);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/backfill/confirm');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    runId: 'backfill-run-1',
    confirmationHash: 'confirmation-hash-1',
    reason: 'Backfill bestätigt',
  });
});

test('Pro HTTP adapter falls back to IPC without fetch for every migrated Pro mutation', async () => {
  const calls: Array<{ key: IpcRouteKey; args: unknown }> = [];
  const fallback = async <K extends IpcRouteKey>(key: K, args: IpcArgs<K>): Promise<IpcResult<K>> => {
    calls.push({ key, args });
    return undefined as IpcResult<K>;
  };
  let fetchCalls = 0;
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => null,
    fallback,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('HTTP must not be used while embedded server is unavailable');
    },
  });

  await api.pro.upsertTaxCaseAccountMapping({ chart: 'SKR03', taxCaseKey: 'DE_STD_19', role: 'output_tax', accountNumber: '1776', reason: 'x' });
  await api.pro.upsertAccountSuggestionRule({ chart: 'SKR03', priority: 1, field: 'purpose', operator: 'contains', value: 'Büro', targetAccountNumber: '4930', flowType: 'expense', active: true, reason: 'x' });
  await api.pro.deleteAccountSuggestionRule({ id: 'rule-1', reason: 'x' });
  await api.pro.upsertWorkflowEntry({ transactionId: 'transaction-1', transactionJson: '{}', draftJson: '{}' });
  await api.pro.setAccountingPolicy({ activeChart: 'SKR03', vatMethod: 'soll' });
  await api.pro.upsertVendor({
    vendor: {
      id: 'vendor-1', tenantId: 'tenant-1', name: 'Lieferant GmbH',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    },
    reason: 'x',
  });
  await api.pro.upsertIncomingInvoice({
    invoice: {
      id: 'incoming-1', tenantId: 'tenant-1', vendorId: 'vendor-1', number: 'RE-1',
      invoiceDate: '2026-01-01', dueDate: '2026-01-31', netAmount: 100, taxAmount: 19,
      grossAmount: 119, status: 'open', taxRate: 19, accountingStatus: 'unposted',
      lines: [{ id: 'line-1', incomingInvoiceId: 'incoming-1', position: 1, description: 'Büro', quantity: 1, unitPrice: 100, netAmount: 100, taxRate: 19, taxAmount: 19, grossAmount: 119 }],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    },
    reason: 'x',
  });
  await api.pro.previewOutgoingInvoiceAccounting({ invoiceId: 'invoice-1' });
  await api.pro.postOutgoingInvoiceAccounting({ invoiceId: 'invoice-1', reservationId: 'reservation-1' });
  await api.pro.previewIncomingInvoiceAccounting({ invoiceId: 'incoming-1' });
  await api.pro.postIncomingInvoiceAccounting({ invoiceId: 'incoming-1', reason: 'x' });
  await api.pro.allocateOpenItemPayment({
    payment: {
      sourceType: 'bank_transaction', sourceId: 'bank-tx-1', partyType: 'debtor', partyId: 'client-1',
      paymentDate: '2026-01-15', amount: 119, bankAccountNumber: '1200', allocations: [], reason: 'x', allocationEventId: 'event-1',
    },
  });
  await api.pro.allocateRemainingPayment({ paymentId: 'payment-1', allocations: [], reason: 'x', allocationEventId: 'event-2' });
  await api.pro.reverseDocumentAccounting({ documentType: 'outgoing_invoice', documentId: 'invoice-1', reason: 'x' });
  await api.pro.previewAccountingBackfill();
  await api.pro.confirmAccountingBackfill({ runId: 'run-1', confirmationHash: 'hash-1', reason: 'x' });

  assert.equal(fetchCalls, 0);
  assert.deepEqual(calls.map(({ key }) => key), [
    'pro:upsertTaxCaseAccountMapping',
    'pro:upsertAccountSuggestionRule',
    'pro:deleteAccountSuggestionRule',
    'pro:upsertWorkflowEntry',
    'pro:setAccountingPolicy',
    'pro:upsertVendor',
    'pro:upsertIncomingInvoice',
    'pro:previewOutgoingInvoiceAccounting',
    'pro:postOutgoingInvoiceAccounting',
    'pro:previewIncomingInvoiceAccounting',
    'pro:postIncomingInvoiceAccounting',
    'pro:allocateOpenItemPayment',
    'pro:allocateRemainingPayment',
    'pro:reverseDocumentAccounting',
    'pro:previewAccountingBackfill',
    'pro:confirmAccountingBackfill',
  ]);
});

test('Pro HTTP adapter falls back to IPC without fetch for every migrated workflow and source route', async () => {
  const calls: Array<{ key: IpcRouteKey; args: unknown }> = [];
  const fallback = async <K extends IpcRouteKey>(key: K, args: IpcArgs<K>): Promise<IpcResult<K>> => {
    calls.push({ key, args });
    return undefined as IpcResult<K>;
  };
  let fetchCalls = 0;
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => null,
    fallback,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('HTTP must not be used while embedded server is unavailable');
    },
  });
  const draft = {
    id: 'draft-1', tenantId: 'tenant-1', transactionId: 'transaction-1', workflowStatus: 'incomplete' as const,
    bookingText: 'Bankbuchung', period: '2026-01', fiscalYear: 2026, lines: [], validationIssues: [],
    updatedAt: '2026-01-15T00:00:00.000Z',
  };
  const source = {
    sourceType: 'standalone_source' as const, sourceId: 'source-1', sourceRevision: 'revision-1',
    effectiveDate: '2026-01-16', postingDate: '2026-01-16', period: '2026-01', fiscalYear: 2026,
    currency: 'EUR', bookingText: 'Manuelle Buchung', lines: [
      { accountNumber: '1200', debitAmount: 100, creditAmount: 0 },
      { accountNumber: '8400', debitAmount: 0, creditAmount: 100 },
    ],
  };

  await api.pro.listBankTransactions();
  await api.pro.getDraftByTransactionId({ transactionId: 'transaction-1' });
  await api.pro.saveDraft({ draft });
  await api.pro.dispatchDraftAction({ transactionId: 'transaction-1', action: 'reject', rejectReason: 'Beleg fehlt' });
  await api.pro.postDraft({ draftId: 'draft-1', idempotencyKey: 'post-1' });
  await api.pro.reverseJournalEntry({ entryId: 'entry-1', reason: 'Storno' });
  await api.pro.listJournalEntries({ accountNumbers: ['1200'] });
  await api.pro.getJournalEntryById({ entryId: 'entry-1' });
  await api.pro.getLedgerBalances({ asOfDate: '2026-01-31' });
  await api.pro.listAccountingSourceRuns();
  await api.pro.getAccountingSourceRun({ id: 'run-1' });
  await api.pro.postAccountingSource({ source, reason: 'Buchen' });
  await api.pro.postAccountingCommand({ kind: 'fiscal_close', source: { ...source, lines: [] }, domainFacts: { closeDate: '2026-01-16' }, reason: 'Abschluss' });

  assert.equal(fetchCalls, 0);
  assert.deepEqual(calls.map(({ key }) => key), [
    'pro:listBankTransactions',
    'pro:getDraftByTransactionId',
    'pro:saveDraft',
    'pro:dispatchDraftAction',
    'pro:postDraft',
    'pro:reverseJournalEntry',
    'pro:listJournalEntries',
    'pro:getJournalEntryById',
    'pro:getLedgerBalances',
    'pro:listAccountingSourceRuns',
    'pro:getAccountingSourceRun',
    'pro:postAccountingSource',
    'pro:postAccountingCommand',
  ]);
});

test('Pro HTTP Billme API routes the Susa report with its complete range', async () => {
  let requestUrl = '';
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response({
        from: '2026-01-01',
        to: '2026-03-31',
        asOfDate: '2026-03-31',
        chart: 'SKR03',
        rows: [{ accountNumber: '1200', openingBalance: 0, debitTurnover: 100, creditTurnover: 0, closingBalance: 100 }],
        totals: { debit: 100, credit: 0, balance: 100 },
      });
    },
  });

  const result = await api.pro.getSusaReport({ from: '2026-01-01', to: '2026-03-31', asOfDate: '2026-03-31' });
  assert.equal(result.asOfDate, '2026-03-31');
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/susa?asOfDate=2026-03-31&from=2026-01-01&to=2026-03-31');
});

test('Pro HTTP Billme API routes the legacy GuV report without losing drilldown refs', async () => {
  let requestUrl = '';
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response({
        from: '2026-01-01',
        to: '2026-03-31',
        chart: 'SKR04',
        rows: [{ positionKey: 'revenue', positionLabel: 'Umsatz', amount: 250, accountRefs: ['8400'] }],
        netResult: 250,
        unmappedAccounts: [],
        blocking: false,
      });
    },
  });

  const result = await api.pro.getGuvReport({ from: '2026-01-01', to: '2026-03-31' });
  assert.deepEqual(result.rows[0], { positionKey: 'revenue', positionLabel: 'Umsatz', amount: 250, accountRefs: ['8400'] });
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/guv?from=2026-01-01&to=2026-03-31');
});

test('Pro HTTP Billme API projects the canonical balance sheet into the IPC contract', async () => {
  let requestUrl = '';
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response({
        kind: 'hgb-bilanz',
        assets: [{ position: 'A.1', label: 'Bank', amount: 100, accountNumbers: ['1200'], kind: 'line' }],
        liabilities: [{ position: 'P.1', label: 'Kapital', amount: 100, accountNumbers: ['9000'], kind: 'line' }],
        totals: { assets: 100, liabilities: 100, delta: 0 },
        snapshot: { asOfDate: '2026-03-31', fiscalYear: 2026, fiscalYearStart: '2026-01-01', businessSize: 'small', ledgerEntryCount: 1, ledgerAccountCount: 2, cashEntryCount: 0 },
        mappingHealth: { mappedAccounts: 2, inferredAccounts: 0, unmappedAccounts: [], warnings: [], blocking: false },
      });
    },
  });

  const result = await api.pro.getBilanzReport({ asOfDate: '2026-03-31' });
  assert.deepEqual(result.assets, [{ accountNumber: '1200', amount: 100 }]);
  assert.deepEqual(result.liabilities, [{ accountNumber: '9000', amount: 100 }]);
  assert.equal(result.asOfDate, '2026-03-31');
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/bilanz?asOfDate=2026-03-31');
});

test('Pro HTTP Billme API dispatches reporting kinds to their canonical server routes', async () => {
  const requestUrls: string[] = [];
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrls.push(String(input));
      const kind = String(input).match(/reports\/([^?]+)/)?.[1] ?? '';
      return response({
        kind,
        snapshot: { fiscalYear: 2026, fiscalYearStart: '2026-01-01', ledgerEntryCount: 1, ledgerAccountCount: 1, cashEntryCount: 0 },
        mappingHealth: { mappedAccounts: 1, inferredAccounts: 0, unmappedAccounts: [], warnings: [], blocking: false },
      });
    },
  });

  for (const kind of ['bwa01', 'management-guv', 'hgb-guv', 'hgb-bilanz'] as const) {
    const result = await api.pro.getReportingReport({ kind, from: '2026-01-01', to: '2026-03-31', asOfDate: '2026-03-31' });
    assert.equal(result.kind, kind);
  }
  assert.deepEqual(requestUrls, [
    'http://127.0.0.1:43123/api/v1/pro/accounting/reports/bwa01?from=2026-01-01&to=2026-03-31&asOfDate=2026-03-31',
    'http://127.0.0.1:43123/api/v1/pro/accounting/reports/management-guv?from=2026-01-01&to=2026-03-31&asOfDate=2026-03-31',
    'http://127.0.0.1:43123/api/v1/pro/accounting/reports/hgb-guv?from=2026-01-01&to=2026-03-31&asOfDate=2026-03-31',
    'http://127.0.0.1:43123/api/v1/pro/accounting/reports/hgb-bilanz?from=2026-01-01&to=2026-03-31&asOfDate=2026-03-31',
  ]);
});

test('Pro HTTP Billme API normalizes persisted report snapshots to the IPC record shape', async () => {
  let requestUrl = '';
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response([{
        id: 'snapshot-1',
        tenantId: 'tenant-1',
        reportType: 'guv',
        argsJson: '{"from":"2026-01-01"}',
        payloadJson: '{"netResult":100}',
        sourceHash: 'a'.repeat(64),
        createdAt: '2026-03-31T23:00:00.000Z',
      }]);
    },
  });

  const result = await api.pro.listReportSnapshots({ reportType: 'guv' });
  assert.deepEqual(result, [{
    id: 'snapshot-1',
    reportType: 'guv',
    args: { from: '2026-01-01' },
    payload: { netResult: 100 },
    createdAt: '2026-03-31T23:00:00.000Z',
    sourceHash: 'a'.repeat(64),
  }]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/snapshots?reportType=guv');
});

test('Pro HTTP Billme API saves report snapshots with report metadata, range, chart and reason', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response({
        id: 'snapshot-2',
        tenantId: 'tenant-1',
        reportType: 'management-guv',
        argsJson: '{"from":"2026-01-01","to":"2026-03-31","asOfDate":"2026-03-31","chart":"SKR04","profile":"small"}',
        payloadJson: '{"rows":[]}',
        sourceHash: 'b'.repeat(64),
        createdAt: '2026-03-31T23:00:00.000Z',
      });
    },
  });

  const result = await api.pro.saveReportSnapshot({
    reportType: 'management-guv',
    args: { from: '2026-01-01', to: '2026-03-31', asOfDate: '2026-03-31', chart: 'SKR04', profile: 'small' },
    payload: { rows: [] },
    reason: 'GuV-Snapshot eingefroren',
  });
  assert.equal(result.id, 'snapshot-2');
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/snapshots');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    reportType: 'management-guv',
    from: '2026-01-01',
    to: '2026-03-31',
    asOfDate: '2026-03-31',
    chart: 'SKR04',
    profile: 'small',
    reason: 'GuV-Snapshot eingefroren',
  });
});

test('Pro HTTP Billme API maps report-mapping health to the IPC statement field', async () => {
  let requestUrl = '';
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response({ chart: 'SKR03', reportType: 'management-guv', unmapped: [{ accountNumber: '1200', statementType: 'management-guv' }] });
    },
  });

  const result = await api.pro.getReportMappingHealth({ chart: 'SKR03', statement: 'management-guv', asOfDate: '2026-03-31' });
  assert.deepEqual(result, { chart: 'SKR03', unmapped: [{ accountNumber: '1200', statement: 'management-guv' }] });
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/mappings/health?chart=SKR03&reportType=management-guv&asOfDate=2026-03-31');
});

test('Pro HTTP Billme API lists report-mapping positions with statement and date bounds', async () => {
  let requestUrl = '';
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response([{ key: 'revenue', label: 'Umsatz', kind: 'line' }]);
    },
  });

  const result = await api.pro.listReportMappingPositions({ statement: 'bwa01', asOfDate: '2026-03-31' });
  assert.deepEqual(result, [{ key: 'revenue', label: 'Umsatz', kind: 'line' }]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/mappings/positions?reportType=bwa01&asOfDate=2026-03-31');
});

test('Pro HTTP Billme API upserts report-mapping overrides with server field names and reason', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response({ ok: true });
    },
  });

  assert.deepEqual(await api.pro.upsertReportMappingOverride({
    chart: 'SKR04',
    asOfDate: '2026-03-31',
    accountNumber: '1200',
    statement: 'hgb-bilanz',
    position: 'A.1',
    label: 'Bank',
    side: 'asset',
    reason: 'Bilanzmapping korrigiert',
  }), { ok: true });
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/mappings/overrides');
  assert.equal(requestInit?.method, 'PUT');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    chart: 'SKR04',
    asOfDate: '2026-03-31',
    accountNumber: '1200',
    statementType: 'hgb-bilanz',
    positionKey: 'A.1',
    positionLabel: 'Bank',
    balanceSide: 'asset',
    reason: 'Bilanzmapping korrigiert',
  });
});

test('Pro HTTP Billme API lists assets through the embedded accounting server', async () => {
  let requestUrl = '';
  const asset = {
    id: 'asset-1',
    assetNumber: 'AN-001',
    name: 'Laptop',
    assetClass: 'Betriebsausstattung',
    status: 'aktiv',
    activationDate: '2026-01-10',
    acquisitionCost: 1200,
    residualValue: 0,
    annualDepreciation: 400,
    usefulLifeYears: 3,
    depreciationMethod: 'linear',
    costCenter: 'Büro',
    location: 'Berlin',
    nextDepreciation: '2026-12-31',
    receiptLinked: true,
    assetAccountNumber: '0480',
  } as const;
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response([asset]);
    },
  });

  assert.deepEqual(await api.pro.listAssets(), [asset]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/assets');
});

test('Pro HTTP Billme API upserts an asset with its audit reason', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const asset = {
    id: 'asset-1',
    assetNumber: 'AN-001',
    name: 'Laptop',
    assetClass: 'Betriebsausstattung',
    status: 'aktiv' as const,
    activationDate: '2026-01-10',
    acquisitionCost: 1200,
    residualValue: 0,
    annualDepreciation: 400,
    usefulLifeYears: 3,
    depreciationMethod: 'linear' as const,
    costCenter: 'Büro',
    location: 'Berlin',
    nextDepreciation: '2026-12-31',
    receiptLinked: true,
    assetAccountNumber: '0480',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(asset);
    },
  });

  assert.deepEqual(await api.pro.upsertAsset({ asset, reason: 'Anlage gespeichert' }), asset);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/assets');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    asset: {
      id: 'asset-1',
      assetNumber: 'AN-001',
      name: 'Laptop',
      assetClass: 'Betriebsausstattung',
      status: 'aktiv',
      activationDate: '2026-01-10',
      acquisitionCost: 1200,
      usefulLifeYears: 3,
      depreciationMethod: 'linear',
      costCenter: 'Büro',
      location: 'Berlin',
      receiptLinked: true,
      assetAccountNumber: '0480',
    },
    reason: 'Anlage gespeichert',
  });
});

test('Pro HTTP Billme API gets an asset depreciation schedule by id', async () => {
  let requestUrl = '';
  const schedule = [{ id: 'schedule-1', assetId: 'asset-1', year: 2026, amount: 400, months: 12, status: 'planned' }];
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response(schedule);
    },
  });

  assert.deepEqual(await api.pro.getDepreciationSchedule({ assetId: 'asset/1' }), schedule);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/assets/asset%2F1/schedule');
});

test('Pro HTTP Billme API runs depreciation with date, year and soft-lock metadata intact', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const result = {
    asset: {
      id: 'asset-1', assetNumber: 'AN-001', name: 'Laptop', assetClass: 'Betriebsausstattung', status: 'voll_abgeschrieben',
      activationDate: '2026-01-10', acquisitionCost: 1200, residualValue: 0, annualDepreciation: 400, usefulLifeYears: 3,
      depreciationMethod: 'linear', costCenter: 'Büro', location: 'Berlin', nextDepreciation: '2027-12-31', receiptLinked: true, assetAccountNumber: '0480',
    },
    scheduleEntry: { id: 'schedule-1', assetId: 'asset-1', year: 2026, amount: 400, months: 12, status: 'posted', journalEntryId: 'journal-1' },
    journalEntryId: 'journal-1',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(result);
    },
  });

  assert.deepEqual(await api.pro.runDepreciation({
    assetId: 'asset-1', year: 2026, postingDate: '2026-12-31', reason: 'AfA gebucht', softLockOverride: true, overrideReason: 'Freigabe Buchhaltung',
  }), result);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/assets/asset-1/depreciation');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    assetId: 'asset-1',
    year: 2026,
    postingDate: '2026-12-31',
    reason: 'AfA gebucht',
    softLockOverride: true,
    overrideReason: 'Freigabe Buchhaltung',
  });
});

test('Pro HTTP Billme API disposes an asset with proceeds, tax and lock metadata intact', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const result = {
    asset: {
      id: 'asset-1', assetNumber: 'AN-001', name: 'Laptop', assetClass: 'Betriebsausstattung', status: 'verkauft',
      activationDate: '2026-01-10', acquisitionCost: 1200, residualValue: 0, annualDepreciation: 400, usefulLifeYears: 3,
      depreciationMethod: 'linear', costCenter: 'Büro', location: 'Berlin', nextDepreciation: '2026-12-31', receiptLinked: true,
      assetAccountNumber: '0480', disposalDate: '2026-06-30', disposalProceeds: 595,
    },
    residualBookValue: 500,
    gainLoss: 95,
    journalEntryId: 'journal-disposal-1',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(result);
    },
  });

  assert.deepEqual(await api.pro.disposeAsset({
    assetId: 'asset-1', disposalDate: '2026-06-30', proceeds: 595, taxRate: 19, proceedsAccountNumber: '8400',
    reason: 'Anlage verkauft', softLockOverride: true, overrideReason: 'Freigabe Buchhaltung',
  }), result);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/assets/asset-1/dispose');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    assetId: 'asset-1',
    disposalDate: '2026-06-30',
    proceeds: 595,
    taxRate: 19,
    proceedsAccountNumber: '8400',
    reason: 'Anlage verkauft',
    softLockOverride: true,
    overrideReason: 'Freigabe Buchhaltung',
  });
});

test('Pro HTTP Billme API exports DATEV with required metadata and returns the persisted receipt', async () => {
  const requestUrls: string[] = [];
  const receipt = {
    id: 'datev-export-1',
    filePath: 'datev-export/hash',
    recordCount: 2,
    fromDate: '2026-01-01',
    toDate: '2026-03-31',
    createdAt: '2026-03-31T23:00:00.000Z',
    sha256: 'c'.repeat(64),
    byteSize: 123,
    encoding: 'utf8-bom' as const,
    headerVersion: 700,
    formatVersion: 13,
    chart: 'SKR04' as const,
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      const url = String(input);
      requestUrls.push(url);
      if (url.includes('/datev/export.csv')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({
            'x-billme-datev-export-id': receipt.id,
            'x-billme-datev-content-sha256': receipt.sha256,
            'x-billme-datev-record-count': String(receipt.recordCount),
          }),
          blob: async () => new Blob(['EXTF;1'], { type: 'text/csv' }),
        } as Response;
      }
      return response([receipt]);
    },
  });

  assert.deepEqual(await api.pro.exportDatevBuchungsstapel({
    from: '2026-01-01',
    to: '2026-03-31',
    consultantNumber: 1234,
    clientNumber: 42,
    fiscalYearStart: '2026-01-01',
    accountLength: 4,
    encoding: 'utf8-bom',
  }), receipt);
  assert.equal(requestUrls[0], 'http://127.0.0.1:43123/api/v1/pro/accounting/datev/export.csv?from=2026-01-01&to=2026-03-31&consultantNumber=1234&clientNumber=42&fiscalYearStart=2026-01-01&accountLength=4&encoding=utf8-bom&reason=DATEV-Buchungsstapel+exportiert');
  assert.equal(requestUrls[1], 'http://127.0.0.1:43123/api/v1/pro/accounting/datev/exports');
});

test('Pro HTTP Billme API lists DATEV export receipts and applies the contract limit', async () => {
  let requestUrl = '';
  const rows = [
    { id: 'datev-1', filePath: 'datev-export/1', recordCount: 2, createdAt: '2026-03-31T23:00:00.000Z', encoding: 'cp1252' as const, chart: 'SKR03' as const },
    { id: 'datev-2', filePath: 'datev-export/2', recordCount: 3, createdAt: '2026-03-30T23:00:00.000Z', encoding: 'utf8-bom' as const, chart: 'SKR04' as const },
  ];
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response(rows);
    },
  });

  assert.deepEqual(await api.pro.listDatevExports({ limit: 1 }), [rows[0]]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/datev/exports');
});

test('Pro HTTP Billme API lists accounting account mappings with the selected chart', async () => {
  let requestUrl = '';
  const mapping = { id: 'mapping-1', tenantId: 'tenant-1', chart: 'SKR04', role: 'output_vat', accountNumber: '1776', updatedAt: '2026-03-31T23:00:00.000Z' } as const;
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response([mapping]);
    },
  });

  assert.deepEqual(await api.pro.listAccountingAccountMappings({ chart: 'SKR04' }), [mapping]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/mappings?chart=SKR04');
});

test('Pro HTTP Billme API upserts accounting account mappings with an auditable default reason', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const mapping = { id: 'mapping-1', tenantId: 'tenant-1', chart: 'SKR03', role: 'output_vat_deferred', accountNumber: '1780', updatedAt: '2026-03-31T23:00:00.000Z' } as const;
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(mapping);
    },
  });

  assert.deepEqual(await api.pro.upsertAccountingAccountMapping({ chart: 'SKR03', role: 'output_vat_deferred', accountNumber: '1780' }), mapping);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/mappings');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), {
    chart: 'SKR03',
    role: 'output_vat_deferred',
    accountNumber: '1780',
    reason: 'Kontenzuordnung gespeichert',
  });
});

test('Pro HTTP Billme API falls back without fetch for every migrated report, asset and DATEV route', async () => {
  const calls: Array<{ key: IpcRouteKey; args: unknown }> = [];
  let fetchCalls = 0;
  const fallback = async <K extends IpcRouteKey>(key: K, args: IpcArgs<K>): Promise<IpcResult<K>> => {
    calls.push({ key, args });
    return [] as IpcResult<K>;
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => null,
    fallback,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('HTTP must not be used while embedded server is unavailable');
    },
  });

  await api.pro.getSusaReport({ asOfDate: '2026-03-31' });
  await api.pro.getGuvReport({ from: '2026-01-01', to: '2026-03-31' });
  await api.pro.getBilanzReport({ asOfDate: '2026-03-31' });
  await api.pro.getReportingReport({ kind: 'hgb-guv', from: '2026-01-01', to: '2026-03-31' });
  await api.pro.listReportSnapshots({ reportType: 'guv' });
  await api.pro.saveReportSnapshot({ reportType: 'guv', args: {}, payload: {}, reason: 'Snapshot' });
  await api.pro.getReportMappingHealth({ statement: 'management-guv', asOfDate: '2026-03-31' });
  await api.pro.listReportMappingPositions({ statement: 'bwa01', asOfDate: '2026-03-31' });
  await api.pro.upsertReportMappingOverride({ chart: 'SKR03', asOfDate: '2026-03-31', accountNumber: '1200', statement: 'bwa01', position: 'revenue', label: 'Umsatz', reason: 'Mapping' });
  await api.pro.listAssets();
  await api.pro.upsertAsset({ asset: { id: 'asset-1', assetNumber: 'AN-001', name: 'Laptop', assetClass: 'Betriebsausstattung', status: 'aktiv', activationDate: '2026-01-01', acquisitionCost: 100, usefulLifeYears: 1, depreciationMethod: 'linear', costCenter: 'Büro', location: 'Berlin', receiptLinked: false, assetAccountNumber: '0480' }, reason: 'Anlage' });
  await api.pro.getDepreciationSchedule({ assetId: 'asset-1' });
  await api.pro.runDepreciation({ assetId: 'asset-1', year: 2026, postingDate: '2026-12-31', reason: 'AfA' });
  await api.pro.disposeAsset({ assetId: 'asset-1', disposalDate: '2026-12-31', proceeds: 0, reason: 'Abgang' });
  await api.pro.exportDatevBuchungsstapel({ from: '2026-01-01', to: '2026-03-31', consultantNumber: '1234', clientNumber: '42', fiscalYearStart: '2026-01-01', accountLength: 4 });
  await api.pro.listDatevExports({ limit: 10 });
  await api.pro.listAccountingAccountMappings({ chart: 'SKR03' });
  await api.pro.upsertAccountingAccountMapping({ chart: 'SKR03', role: 'bank', accountNumber: '1200' });

  assert.equal(fetchCalls, 0);
  assert.deepEqual(calls.map(({ key }) => key), [
    'pro:getSusaReport', 'pro:getGuvReport', 'pro:getBilanzReport', 'pro:getReportingReport',
    'pro:listReportSnapshots', 'pro:saveReportSnapshot', 'pro:getReportMappingHealth', 'pro:listReportMappingPositions',
    'pro:upsertReportMappingOverride', 'pro:listAssets', 'pro:upsertAsset', 'pro:getDepreciationSchedule',
    'pro:runDepreciation', 'pro:disposeAsset', 'pro:exportDatevBuchungsstapel', 'pro:listDatevExports',
    'pro:listAccountingAccountMappings', 'pro:upsertAccountingAccountMapping',
  ]);
});

test('Pro HTTP Billme API maps the EÜR report to the public contract and preserves its range', async () => {
  let requestUrl = '';
  const serverReport = {
    taxYear: 2026,
    from: '2026-01-01',
    to: '2026-12-31',
    rows: [{ id: 'line-1', label: 'Umsatz', kind: 'income' as const, exportable: true, sortOrder: 1, total: 120 }],
    summary: { incomeTotal: 120, expenseTotal: 0, surplus: 120 },
    unclassifiedCount: 0,
    warnings: [],
    catalog: { id: 'euer-2026', version: '1', sourceHash: 'a'.repeat(64), delivery: 'elster-ready' as const, elsterReady: true },
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response(serverReport);
    },
  });

  assert.deepEqual(await api.eur.getReport({ taxYear: 2026, from: '2026-01-01', to: '2026-12-31' }), {
    ...serverReport,
    rows: [{ lineId: 'line-1', label: 'Umsatz', kind: 'income', exportable: true, sortOrder: 1, total: 120 }],
  });
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur?taxYear=2026&from=2026-01-01&to=2026-12-31');
});

test('Pro HTTP Billme API routes audit and EÜR CSV/rule contracts through the server', async () => {
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const rule = {
    id: 'rule-1', taxYear: 2025, priority: 1, field: 'purpose' as const, operator: 'contains' as const,
    value: 'Hosting', targetEurLineId: 'line-1', active: true,
    createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/audit/verify')) return response({ ok: true, errors: [], count: 1, headHash: 'hash-1' });
      if (url.endsWith('/audit/export.csv')) return textResponse('\uFEFFsequence,ts\n1,now');
      if (url.includes('/reports/eur/export.csv?')) return textResponse('\uFEFFKennziffer;Bezeichnung;Betrag\n101;Hosting;10,00');
      if (url.includes('/reports/eur/rules?')) return response([rule]);
      if (url.endsWith('/reports/eur/rules')) return response(rule);
      return response({ ok: true });
    },
  });

  assert.deepEqual(await api.audit.verify(), { ok: true, errors: [], count: 1, headHash: 'hash-1' });
  assert.equal(await api.audit.exportCsv(), '\uFEFFsequence,ts\n1,now');
  assert.equal(await api.eur.exportCsv({ taxYear: 2025 }), '\uFEFFKennziffer;Bezeichnung;Betrag\n101;Hosting;10,00');
  assert.deepEqual(await api.eur.listRules({ taxYear: 2025 }), [rule]);
  assert.deepEqual(await api.eur.upsertRule({ ...rule, id: undefined }), rule);
  assert.deepEqual(await api.eur.deleteRule({ id: 'rule-1' }), { ok: true });
  assert.deepEqual(requests.map((request) => request.url), [
    'http://127.0.0.1:43123/api/v1/pro/audit/verify',
    'http://127.0.0.1:43123/api/v1/pro/audit/export.csv',
    'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur/export.csv?taxYear=2025',
    'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur/rules?taxYear=2025',
    'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur/rules',
    'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur/rules/rule-1',
  ]);
  assert.equal(requests[4]?.body?.reason, 'EÜR-Klassifikationsregel gespeichert');
  assert.equal(requests[5]?.body?.reason, 'EÜR-Klassifikationsregel gelöscht');
});

test('Pro HTTP Billme API lists EÜR items with the complete filter contract', async () => {
  let requestUrl = '';
  const item = {
    sourceType: 'transaction' as const,
    sourceId: 'transaction-1',
    date: '2026-04-01',
    amountGross: 119,
    amountNet: 100,
    flowType: 'expense' as const,
    accountId: '1200',
    linkedViaInvoice: true,
    counterparty: 'Lieferant',
    purpose: 'Büromaterial',
    kind: 'expense' as const,
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response([item]);
    },
  });

  assert.deepEqual(await api.eur.listItems({
    taxYear: 2026,
    from: '2026-01-01',
    to: '2026-12-31',
    onlyUnclassified: true,
    sourceType: 'transaction',
    flowType: 'expense',
    status: 'unclassified',
    search: 'Büro',
    accountId: '1200',
    limit: 25,
    offset: 5,
  }), [item]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur/items?taxYear=2026&from=2026-01-01&to=2026-12-31&onlyUnclassified=true&sourceType=transaction&flowType=expense&status=unclassified&search=B%C3%BCro&accountId=1200&limit=25&offset=5');
});

test('Pro HTTP Billme API upserts an EÜR classification with its audit reason', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const classification = {
    id: 'classification-1',
    sourceType: 'transaction' as const,
    sourceId: 'transaction-1',
    taxYear: 2026,
    eurLineId: 'line-1',
    excluded: false,
    vatMode: 'default' as const,
    vatRate: 19,
    note: 'Büromaterial',
    updatedAt: '2026-04-01T12:00:00.000Z',
  };
  const args = {
    sourceType: 'transaction' as const,
    sourceId: 'transaction-1',
    taxYear: 2026,
    eurLineId: 'line-1',
    excluded: false,
    vatMode: 'default' as const,
    vatRate: 19,
    note: 'Büromaterial',
    reason: 'EÜR-Klassifikation geprüft',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(classification);
    },
  });

  assert.deepEqual(await api.eur.upsertClassification(args), classification);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur/classifications');
  assert.equal(requestInit?.method, 'PUT');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), args);
});

test('Pro HTTP Billme API saves an EÜR cash fact with splits, retry key and reason intact', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const fact = {
    id: 'cash-fact-1',
    tenantId: 'tenant-1',
    sourceType: 'transaction' as const,
    sourceId: 'transaction-1',
    taxYear: 2026,
    kind: 'expense' as const,
    amountNet: 100,
    flowType: 'expense' as const,
    eurLineId: 'line-1',
    splits: [{ amountNet: 100, deductibility: 'deductible' as const, lineId: 'line-1', reason: 'Büromaterial' }],
    reason: 'EÜR-Cash-Fakt erfasst',
    actorId: 'user-1',
    actorName: 'Buchhaltung',
    idempotencyKey: 'cash-fact-retry-1',
    provenance: { catalogId: 'euer-2026', catalogVersion: '1', catalogSourceHash: 'b'.repeat(64) },
    createdAt: '2026-04-01T12:00:00.000Z',
    updatedAt: '2026-04-01T12:00:00.000Z',
  };
  const args = {
    sourceType: 'transaction' as const,
    sourceId: 'transaction-1',
    taxYear: 2026,
    kind: 'expense' as const,
    amountNet: 100,
    flowType: 'expense' as const,
    eurLineId: 'line-1',
    splits: [{ amountNet: 100, deductibility: 'deductible' as const, lineId: 'line-1', reason: 'Büromaterial' }],
    idempotencyKey: 'cash-fact-retry-1',
    reason: 'EÜR-Cash-Fakt erfasst',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(fact);
    },
  });

  assert.deepEqual(await api.eur.saveCashFact(args), fact);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur/facts/cash');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), args);
});

test('Pro HTTP Billme API lists EÜR cash facts for the requested tax year', async () => {
  let requestUrl = '';
  const fact = {
    id: 'cash-fact-1',
    tenantId: 'tenant-1',
    sourceType: 'transaction' as const,
    sourceId: 'transaction-1',
    taxYear: 2026,
    kind: 'income' as const,
    amountNet: 250,
    flowType: 'income' as const,
    reason: 'EÜR-Cash-Fakt erfasst',
    actorId: 'user-1',
    provenance: { catalogId: 'euer-2026', catalogVersion: '1', catalogSourceHash: 'c'.repeat(64) },
    createdAt: '2026-04-02T12:00:00.000Z',
    updatedAt: '2026-04-02T12:00:00.000Z',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response([fact]);
    },
  });

  assert.deepEqual(await api.eur.listCashFacts({ taxYear: 2026 }), [fact]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur/facts/cash?taxYear=2026');
});

test('Pro HTTP Billme API saves an EÜR annex fact with its retry key and audit reason', async () => {
  let requestUrl = '';
  let requestInit: RequestInit | undefined;
  const fact = {
    id: 'annex-fact-1',
    tenantId: 'tenant-1',
    taxYear: 2026,
    annex: 'AVEÜR',
    lineId: 'annex-line-1',
    amount: 75,
    sourceId: 'transaction-1',
    date: '2026-04-03',
    reason: 'Anlageverzeichnis ergänzt',
    actorId: 'user-1',
    idempotencyKey: 'annex-fact-retry-1',
    provenance: { catalogId: 'aveur-2026', catalogVersion: '1', catalogSourceHash: 'd'.repeat(64) },
    createdAt: '2026-04-03T12:00:00.000Z',
  };
  const args = {
    taxYear: 2026,
    annex: 'AVEÜR',
    lineId: 'annex-line-1',
    amount: 75,
    sourceId: 'transaction-1',
    date: '2026-04-03',
    idempotencyKey: 'annex-fact-retry-1',
    reason: 'Anlageverzeichnis ergänzt',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      requestUrl = String(input);
      requestInit = init;
      return response(fact);
    },
  });

  assert.deepEqual(await api.eur.saveAnnexFact(args), fact);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur/facts/annex');
  assert.equal(requestInit?.method, 'POST');
  assert.deepEqual(JSON.parse(String(requestInit?.body)), args);
});

test('Pro HTTP Billme API lists EÜR annex facts with the annex filter', async () => {
  let requestUrl = '';
  const fact = {
    id: 'annex-fact-1',
    tenantId: 'tenant-1',
    taxYear: 2026,
    annex: 'AVEÜR',
    lineId: 'annex-line-1',
    amount: 75,
    sourceId: 'transaction-1',
    date: '2026-04-03',
    reason: 'Anlageverzeichnis ergänzt',
    actorId: 'user-1',
    provenance: { catalogId: 'aveur-2026', catalogVersion: '1', catalogSourceHash: 'e'.repeat(64) },
    createdAt: '2026-04-03T12:00:00.000Z',
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input) => {
      requestUrl = String(input);
      return response([fact]);
    },
  });

  assert.deepEqual(await api.eur.listAnnexFacts({ taxYear: 2026, annex: 'AVEÜR' }), [fact]);
  assert.equal(requestUrl, 'http://127.0.0.1:43123/api/v1/pro/accounting/reports/eur/facts/annex?taxYear=2026&annex=AVE%C3%9CR');
});

test('Pro HTTP Billme API falls back exactly for every migrated EÜR route without fetching', async () => {
  const calls: Array<{ key: IpcRouteKey; args: unknown }> = [];
  let fetchCalls = 0;
  const fallback = async <K extends IpcRouteKey>(key: K, args: IpcArgs<K>): Promise<IpcResult<K>> => {
    calls.push({ key, args });
    return undefined as IpcResult<K>;
  };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => null,
    fallback,
    fetch: async () => {
      fetchCalls += 1;
      throw new Error('HTTP must not be used while the embedded server is unavailable');
    },
  });

  await api.eur.getReport({ taxYear: 2026, from: '2026-01-01', to: '2026-12-31' });
  await api.eur.listItems({ taxYear: 2026, from: '2026-01-01', to: '2026-12-31' });
  await api.eur.upsertClassification({ sourceType: 'transaction', sourceId: 'transaction-1', taxYear: 2026, reason: 'Klassifikation' });
  await api.eur.saveCashFact({ sourceType: 'transaction', sourceId: 'transaction-1', taxYear: 2026, kind: 'expense', amountNet: 10, reason: 'Cash-Fakt' });
  await api.eur.listCashFacts({ taxYear: 2026 });
  await api.eur.saveAnnexFact({ taxYear: 2026, annex: 'AVEÜR', lineId: 'line-1', amount: 10, reason: 'Anlage' });
  await api.eur.listAnnexFacts({ taxYear: 2026, annex: 'AVEÜR' });

  assert.equal(fetchCalls, 0);
  assert.deepEqual(calls, [
    { key: 'eur:getReport', args: { taxYear: 2026, from: '2026-01-01', to: '2026-12-31' } },
    { key: 'eur:listItems', args: { taxYear: 2026, from: '2026-01-01', to: '2026-12-31' } },
    { key: 'eur:upsertClassification', args: { sourceType: 'transaction', sourceId: 'transaction-1', taxYear: 2026, reason: 'Klassifikation' } },
    { key: 'eur:saveCashFact', args: { sourceType: 'transaction', sourceId: 'transaction-1', taxYear: 2026, kind: 'expense', amountNet: 10, reason: 'Cash-Fakt' } },
    { key: 'eur:listCashFacts', args: { taxYear: 2026 } },
    { key: 'eur:saveAnnexFact', args: { taxYear: 2026, annex: 'AVEÜR', lineId: 'line-1', amount: 10, reason: 'Anlage' } },
    { key: 'eur:listAnnexFacts', args: { taxYear: 2026, annex: 'AVEÜR' } },
  ]);
});

test('Pro HTTP Billme API routes portal, email, dunning, and recurring actions through the server', async () => {
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const dunningStatus = { currentLevel: 1, daysOverdue: 3, totalFeesApplied: 0, history: [] };
  const recurringResult = { success: true, result: { generated: 0, deactivated: 0, errors: [] } };
  const api = createProHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/portal/health?baseUrl=https%3A%2F%2Fportal.example')) return response({ ok: true, ts: '2026-08-22T00:00:00.000Z' });
      if (url.endsWith('/portal/sync-offer-status')) return response({ ok: true, decision: null, updated: false });
      if (url.endsWith('/portal/customer-access-link') || url.endsWith('/portal/customer-access-link/rotate')) {
        return response({ ok: true, token: 'customer-token-123456', publicUrl: 'https://portal.example/customer', expiresAt: '2026-09-01T00:00:00.000Z' });
      }
      if (url.endsWith('/dunning/invoices/invoice-1/status')) return response(dunningStatus);
      if (url.endsWith('/dunning/manual-run')) return response({ success: false, error: 'not configured' });
      if (url.endsWith('/recurring/manual-run')) return response(recurringResult);
      if (url.endsWith('/email/test-config')) return response({ success: false, error: 'server secret missing' });
      if (url.endsWith('/email/send')) return response({ success: true, messageId: 'outbox-1' });
      return response({ ok: true, token: 'publication-token-123456', publicUrl: 'https://portal.example/publication' });
    },
  });

  assert.deepEqual(await api.portal.health({ baseUrl: 'https://portal.example' }), { ok: true, ts: '2026-08-22T00:00:00.000Z' });
  await api.portal.publishOffer({ offerId: 'offer-1' });
  await api.portal.publishInvoice({ invoiceId: 'invoice-1' });
  await api.portal.syncOfferStatus({ offerId: 'offer-1' });
  await api.portal.createCustomerAccessLink({ customerRef: 'customer-1' });
  await api.portal.rotateCustomerAccessLink({ customerRef: 'customer-1' });
  await api.email.send({ documentType: 'invoice', documentId: 'invoice-1', recipientEmail: 'customer@example.test', recipientName: 'Customer', subject: 'Invoice', bodyText: 'Body' });
  await api.email.testConfig({ provider: 'resend', resendApiKey: 'must-not-be-forwarded' });
  await api.dunning.manualRun();
  assert.deepEqual(await api.dunning.getInvoiceStatus({ invoiceId: 'invoice-1' }), dunningStatus);
  assert.deepEqual(await api.recurring.manualRun(), recurringResult);

  const testConfigRequest = requests.find((request) => request.url.endsWith('/email/test-config'));
  assert.equal(testConfigRequest?.body?.resendApiKey, undefined);
  assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
    'GET http://127.0.0.1:43123/api/v1/pro/portal/health?baseUrl=https%3A%2F%2Fportal.example',
    'POST http://127.0.0.1:43123/api/v1/pro/portal/publish-offer',
    'POST http://127.0.0.1:43123/api/v1/pro/portal/publish-invoice',
    'POST http://127.0.0.1:43123/api/v1/pro/portal/sync-offer-status',
    'POST http://127.0.0.1:43123/api/v1/pro/portal/customer-access-link',
    'POST http://127.0.0.1:43123/api/v1/pro/portal/customer-access-link/rotate',
    'POST http://127.0.0.1:43123/api/v1/pro/email/send',
    'POST http://127.0.0.1:43123/api/v1/pro/email/test-config',
    'POST http://127.0.0.1:43123/api/v1/pro/dunning/manual-run',
    'GET http://127.0.0.1:43123/api/v1/pro/dunning/invoices/invoice-1/status',
    'POST http://127.0.0.1:43123/api/v1/pro/recurring/manual-run',
  ]);
});
