import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';
import type { IpcInvoke } from '@billme/desktop-contracts/api';
import type { IpcArgs, IpcResult, IpcRouteKey } from '@billme/desktop-contracts/contract';
import { createLiteHttpBillmeApi, type LiteHttpAuth } from './liteHttpApi.js';

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

test('Lite HTTP adapter sends hosted Bearer and embedded local-token auth', async () => {
  const seen: Array<{ headers: HeadersInit | undefined; url: string }> = [];

  for (const auth of [
    { mode: 'bearer', token: 'hosted-token' },
    { mode: 'embedded', token: 'local-token' },
  ] satisfies LiteHttpAuth[]) {
    const api = createLiteHttpBillmeApi({
      baseUrl: 'https://example.test/',
      auth,
      fetch: async (input, init) => {
        seen.push({ url: String(input), headers: init?.headers });
        return response(null);
      },
    });

    assert.equal(await api.settings.get(), null);
  }

  assert.equal(seen[0]?.url, 'https://example.test/api/v1/lite/settings');
  assert.deepEqual(seen[0]?.headers, { authorization: 'Bearer hosted-token' });
  assert.deepEqual(seen[1]?.headers, { 'x-billme-local-token': 'local-token' });
});

test('Lite HTTP adapter validates response schemas at the contract seam', async () => {
  const api = createLiteHttpBillmeApi({
    baseUrl: 'https://example.test',
    auth: { mode: 'bearer', token: 'token' },
    fetch: async () => response({ not: 'settings' }),
  });

  await assert.rejects(
    api.settings.get(),
    (error: unknown) => error instanceof z.ZodError,
  );
});

test('Lite HTTP adapter propagates server errors and invokes auth-failure callback', async () => {
  let authFailureCount = 0;
  const api = createLiteHttpBillmeApi({
    baseUrl: 'https://example.test',
    auth: { mode: 'bearer', token: 'expired-token' },
    onAuthFailure: () => {
      authFailureCount += 1;
    },
    fetch: async () => response({ message: 'Session abgelaufen.' }, 401),
  });

  await assert.rejects(api.settings.get(), /Session abgelaufen\./);
  assert.equal(authFailureCount, 1);
});

test('Lite HTTP adapter delegates native and unsupported routes without DOM access', async () => {
  const calls: Array<{ key: IpcRouteKey; args: unknown }> = [];
  const fallback = async <K extends IpcRouteKey>(key: K, args: IpcArgs<K>): Promise<IpcResult<K>> => {
    calls.push({ key, args });
    return { ok: true } as IpcResult<K>;
  };
  const api = createLiteHttpBillmeApi({
    baseUrl: 'https://example.test',
    auth: { mode: 'embedded', token: 'local-token' },
    fallback,
    fetch: async () => {
      throw new Error('HTTP should not be used for delegated routes');
    },
  });

  assert.deepEqual(await api.window.minimize(), { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.key, 'window:minimize');
});

test('Lite HTTP adapter delegates every route to IPC when embedded connection is unavailable', async () => {
  const calls: Array<{ key: IpcRouteKey; args: unknown }> = [];
  const fallback = async <K extends IpcRouteKey>(key: K, args: IpcArgs<K>): Promise<IpcResult<K>> => {
    calls.push({ key, args });
    return null as IpcResult<K>;
  };

  const api = createLiteHttpBillmeApi({
    embeddedConnectionResolver: async () => null,
    fallback,
    fetch: async () => {
      throw new Error('HTTP should not be used while the embedded server is unavailable');
    },
  });

  assert.equal(await api.settings.get(), null);
  assert.deepEqual(calls, [{ key: 'settings:get', args: undefined }]);
});

test('Lite HTTP adapter uses the resolved embedded token while native routes stay on IPC', async () => {
  const seenHeaders: HeadersInit[] = [];
  const calls: IpcRouteKey[] = [];
  const api = createLiteHttpBillmeApi({
    embeddedConnectionResolver: async () => ({ baseUrl: 'http://127.0.0.1:43123', token: 'local-token' }),
    fallback: async <K extends IpcRouteKey>(key: K): Promise<IpcResult<K>> => {
      calls.push(key);
      return { ok: true } as IpcResult<K>;
    },
    fetch: async (_input, init) => {
      seenHeaders.push(init?.headers ?? {});
      return response(null);
    },
  });

  assert.equal(await api.settings.get(), null);
  assert.deepEqual(await api.window.minimize(), { ok: true });
  assert.deepEqual(seenHeaders, [{ 'x-billme-local-token': 'local-token' }]);
  assert.deepEqual(calls, ['window:minimize']);
});

test('Lite HTTP adapter never falls back to SQLite IPC for an unsupported server-owned route', async () => {
  const calls: string[] = [];
  const unsupportedRoute = 'server:unknown' as IpcRouteKey;
  let invoke: IpcInvoke | undefined;
  const api = createLiteHttpBillmeApi({
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
    /Lite-HTTP-Laufzeit unterstützt die IPC-Route server:unknown nicht/,
  );
  assert.deepEqual(calls, []);
});

test('Lite HTTP adapter exposes projects through the shared server route', async () => {
  const project = {
    id: 'lite-project-1',
    clientId: 'lite-client-1',
    code: 'PRJ-2026-001',
    name: 'Lite Projekt',
    status: 'active' as const,
    budget: 900,
    startDate: '2026-01-01',
  };
  const requests: string[] = [];
  const api = createLiteHttpBillmeApi({
    baseUrl: 'https://example.test',
    auth: { mode: 'bearer', token: 'token' },
    fetch: async (input) => {
      requests.push(String(input));
      return response([project]);
    },
  });

  assert.deepEqual(await api.projects.list({}), [project]);
  assert.deepEqual(requests, ['https://example.test/api/v1/lite/projects']);
});

test('Lite HTTP adapter exposes tax filing status through the shared server route', async () => {
  let requestUrl = '';
  const api = createLiteHttpBillmeApi({
    baseUrl: 'https://example.test',
    auth: { mode: 'bearer', token: 'token' },
    fetch: async (input) => {
      requestUrl = String(input);
      return response({
        provider: { available: false, provider: null, errorCode: 'PROVIDER_UNAVAILABLE' },
        certificates: [],
      });
    },
  });

  assert.deepEqual(await api.taxFiling.getStatus(), {
    provider: { available: false, provider: null, errorCode: 'PROVIDER_UNAVAILABLE' },
    certificates: [],
  });
  assert.equal(requestUrl, 'https://example.test/api/v1/lite/tax-filing/status');
});

test('Lite HTTP adapter routes the complete tax filing contract', async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const record = {
    id: 'filing-1', kind: 'euer' as const, periodStart: '2025-01-01', periodEnd: '2025-12-31',
    sourceHash: 'a'.repeat(64), status: 'queued' as const,
  };
  const api = createLiteHttpBillmeApi({
    baseUrl: 'https://example.test',
    auth: { mode: 'bearer', token: 'token' },
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
    { url: 'https://example.test/api/v1/lite/tax-filing/status', method: 'GET' },
    { url: 'https://example.test/api/v1/lite/tax-filing/records', method: 'GET' },
    { url: 'https://example.test/api/v1/lite/tax-filing/certificates', method: 'POST' },
    { url: 'https://example.test/api/v1/lite/tax-filing/certificates/cert-1', method: 'DELETE' },
    { url: 'https://example.test/api/v1/lite/tax-filing/validate', method: 'POST' },
    { url: 'https://example.test/api/v1/lite/tax-filing/export', method: 'POST' },
    { url: 'https://example.test/api/v1/lite/tax-filing/submit', method: 'POST' },
  ]);
});

test('Lite HTTP adapter routes transaction filters through the embedded server', async () => {
  const requests: string[] = [];
  const transaction = {
    id: 'lite-transaction-1',
    accountId: 'lite-account-1',
    date: '2026-08-01',
    amount: 119,
    type: 'income' as const,
    counterparty: 'Customer',
    purpose: 'Invoice RE-1',
    status: 'booked' as const,
  };
  const api = createLiteHttpBillmeApi({
    baseUrl: 'https://example.test',
    auth: { mode: 'bearer', token: 'token' },
    fetch: async (input) => {
      requests.push(String(input));
      return response([transaction]);
    },
  });

  assert.deepEqual(await api.transactions.list({ type: 'income', unlinkedOnly: true }), [transaction]);
  assert.deepEqual(requests, ['https://example.test/api/v1/lite/transactions?type=income&unlinkedOnly=true']);
});

test('Lite HTTP adapter routes finance import lifecycle through the embedded server', async () => {
  const requests: Array<{ url: string; method: string }> = [];
  const mapping = { dateColumn: 'Date', amountColumn: 'Amount' };
  const preview = {
    path: '/tmp/payments.csv', fileName: 'payments.csv', fileSha256: 'a'.repeat(64), delimiter: ',',
    headers: ['Date', 'Amount'], profile: 'generic' as const, suggestedMapping: mapping, rows: [],
    stats: { totalRows: 0, previewRows: 0, validRows: 0, errorRows: 0 },
  };
  const batch = {
    id: 'batch-1', accountId: 'account-1', profile: 'generic', fileName: 'payments.csv', fileSha256: 'a'.repeat(64),
    mappingJson: { mapping }, importedCount: 1, skippedCount: 0, errorCount: 0, createdAt: '2026-08-04T00:00:00.000Z',
  };
  const detail = {
    batch,
    transactions: [{ id: 'transaction-1', date: '2026-08-04', amount: 42, type: 'income' as const, counterparty: 'Customer', purpose: 'Invoice RE-2', status: 'booked' as const }],
    canRollback: true,
    linkedInvoiceCount: 0,
  };
  const api = createLiteHttpBillmeApi({
    baseUrl: 'https://hosted.example.test',
    auth: { mode: 'bearer', token: 'token' },
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET' });
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
  assert.deepEqual(requests.map((request) => request.url), [
    'https://hosted.example.test/api/v1/lite/finance/import/preview',
    'https://hosted.example.test/api/v1/lite/finance/import/commit',
    'https://hosted.example.test/api/v1/lite/finance/import-batches?accountId=account-1&limit=10',
    'https://hosted.example.test/api/v1/lite/finance/import-batches/batch-1',
    'https://hosted.example.test/api/v1/lite/finance/import-batches/batch-1/rollback',
  ]);
});

test('Lite HTTP adapter routes audit and EÜR rule contracts through the tenant server', async () => {
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const rule = {
    id: 'rule-1', taxYear: 2025, priority: 1, field: 'purpose' as const, operator: 'contains' as const,
    value: 'Hosting', targetEurLineId: 'line-1', active: true,
    createdAt: '2026-08-22T00:00:00.000Z', updatedAt: '2026-08-22T00:00:00.000Z',
  };
  const api = createLiteHttpBillmeApi({
    baseUrl: 'https://example.test',
    auth: { mode: 'bearer', token: 'token' },
    fetch: async (input, init) => {
      const url = String(input);
      requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith('/audit/verify')) return response({ ok: true, errors: [], count: 1, headHash: 'hash-1' });
      if (url.endsWith('/audit/export.csv')) return textResponse('\uFEFFsequence,ts\n1,now');
      if (url.includes('/reports/eur/rules?')) return response([rule]);
      if (url.endsWith('/reports/eur/rules')) return response(rule);
      return response({ ok: true });
    },
  });

  assert.deepEqual(await api.audit.verify(), { ok: true, errors: [], count: 1, headHash: 'hash-1' });
  assert.equal(await api.audit.exportCsv(), '\uFEFFsequence,ts\n1,now');
  assert.deepEqual(await api.eur.listRules({ taxYear: 2025 }), [rule]);
  assert.deepEqual(await api.eur.upsertRule({ ...rule, id: undefined }), rule);
  assert.deepEqual(await api.eur.deleteRule({ id: 'rule-1' }), { ok: true });
  assert.deepEqual(requests.map((request) => request.url), [
    'https://example.test/api/v1/lite/audit/verify',
    'https://example.test/api/v1/lite/audit/export.csv',
    'https://example.test/api/v1/lite/reports/eur/rules?taxYear=2025',
    'https://example.test/api/v1/lite/reports/eur/rules',
    'https://example.test/api/v1/lite/reports/eur/rules/rule-1',
  ]);
  assert.equal(requests[3]?.body?.reason, 'EÜR-Klassifikationsregel gespeichert');
  assert.equal(requests[4]?.body?.reason, 'EÜR-Klassifikationsregel gelöscht');
});

test('Lite HTTP adapter routes portal, email, dunning, and recurring actions without secret forwarding', async () => {
  const requests: Array<{ url: string; method: string; body?: Record<string, unknown> }> = [];
  const dunningStatus = {
    currentLevel: 1, daysOverdue: 3, totalFeesApplied: 0, history: [],
  };
  const recurringResult = { success: true, result: { generated: 0, deactivated: 0, errors: [] } };
  const api = createLiteHttpBillmeApi({
    baseUrl: 'https://example.test',
    auth: { mode: 'bearer', token: 'token' },
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
  assert.deepEqual(await api.portal.publishOffer({ offerId: 'offer-1' }), { ok: true, token: 'publication-token-123456', publicUrl: 'https://portal.example/publication' });
  assert.deepEqual(await api.portal.publishInvoice({ invoiceId: 'invoice-1' }), { ok: true, token: 'publication-token-123456', publicUrl: 'https://portal.example/publication' });
  assert.deepEqual(await api.portal.syncOfferStatus({ offerId: 'offer-1' }), { ok: true, decision: null, updated: false });
  await api.portal.createCustomerAccessLink({ customerRef: 'customer-1' });
  await api.portal.rotateCustomerAccessLink({ customerRef: 'customer-1' });
  assert.deepEqual(await api.email.send({ documentType: 'invoice', documentId: 'invoice-1', recipientEmail: 'customer@example.test', recipientName: 'Customer', subject: 'Invoice', bodyText: 'Body' }), { success: true, messageId: 'outbox-1' });
  await api.email.testConfig({ provider: 'resend', resendApiKey: 'must-not-be-forwarded' });
  await api.dunning.manualRun();
  assert.deepEqual(await api.dunning.getInvoiceStatus({ invoiceId: 'invoice-1' }), dunningStatus);
  assert.deepEqual(await api.recurring.manualRun(), recurringResult);

  const testConfigRequest = requests.find((request) => request.url.endsWith('/email/test-config'));
  assert.equal(testConfigRequest?.body?.resendApiKey, undefined);
  assert.deepEqual(requests.map((request) => `${request.method} ${request.url}`), [
    'GET https://example.test/api/v1/lite/portal/health?baseUrl=https%3A%2F%2Fportal.example',
    'POST https://example.test/api/v1/lite/portal/publish-offer',
    'POST https://example.test/api/v1/lite/portal/publish-invoice',
    'POST https://example.test/api/v1/lite/portal/sync-offer-status',
    'POST https://example.test/api/v1/lite/portal/customer-access-link',
    'POST https://example.test/api/v1/lite/portal/customer-access-link/rotate',
    'POST https://example.test/api/v1/lite/email/send',
    'POST https://example.test/api/v1/lite/email/test-config',
    'POST https://example.test/api/v1/lite/dunning/manual-run',
    'GET https://example.test/api/v1/lite/dunning/invoices/invoice-1/status',
    'POST https://example.test/api/v1/lite/recurring/manual-run',
  ]);
});
