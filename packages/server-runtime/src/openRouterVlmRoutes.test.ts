import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { OpenRouterVlmService } from '@billme/server-core/services';
import { PgliteServerDatabase } from '@billme/server-data';
import { buildServerApi } from './app.js';

const extraction = {
  documentType: 'invoice' as const, issuer: null, recipient: null, invoiceNumber: 'RE-1', invoiceDate: null, servicePeriod: null, dueDate: null, currency: 'EUR', netAmount: 100, taxAmount: 19, grossAmount: 119, vatBreakdown: [], iban: null, paymentReference: null, suggestedAccountNumber: null, suggestedTaxCase: null, matchAssessment: { amountMatches: true, dateMatches: null, partyMatches: null, referenceMatches: null, notes: [] }, warnings: [], evidence: [],
};

test('Pro runtime exposes authenticated VLM config and analysis without posting', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'billme-vlm-route-'));
  const database = await PgliteServerDatabase.open(dataDir);
  let analyzedInput: unknown;
  const service: OpenRouterVlmService = {
    getConfig: () => ({ configured: true, model: 'model-a', models: ['model-a'], maxDocumentBytes: 10_485_760, timeoutMs: 45_000 }),
    analyze: async (input) => {
      analyzedInput = input;
      return {
        extraction,
        deterministicChecks: { amountMatches: true, currencyMatches: true, expectedAmount: 119, extractedAmount: 119, expectedCurrency: 'EUR', extractedCurrency: 'EUR' },
        metadata: {
          model: 'model-a', provider: 'provider-a', requestId: 'request-a',
          request: { method: 'POST' as const, endpoint: 'https://openrouter.ai/api/v1/chat/completions' },
          timing: { startedAt: '2026-08-29T10:00:00.000Z', completedAt: '2026-08-29T10:00:00.100Z', durationMs: 100 },
          documentSha256: 'a'.repeat(64),
        },
      };
    },
  };
  const app = await buildServerApi({ database, runtime: 'embedded', product: 'pro', logger: false, sessionSecret: 'vlm-route-test-session-secret-32-chars', localAuth: { accessToken: 'vlm-token', tenantId: 'vlm-tenant', userId: 'vlm-user', email: 'owner@example.test', fullName: 'Owner' }, openRouterVlmService: service });
  try {
    const now = new Date().toISOString();
    await database.query(`INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at) VALUES ($1, $1, 'VLM route test', 'pro', 'single-tenant', 'active', $2, $2)`, ['vlm-tenant', now]);
    await database.query(`INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at) VALUES ('other-tenant', 'other-tenant', 'Other tenant', 'pro', 'single-tenant', 'active', $1, $1)`, [now]);
    await database.query(`INSERT INTO accounts (id, tenant_id, name, iban, balance, default_skr_account_number, type, color) VALUES ('vlm-account', 'vlm-tenant', 'VLM bank', 'DE00000000000000000000', 0, '1200', 'bank', '#000000')`);
    await database.query(`INSERT INTO accounts (id, tenant_id, name, iban, balance, default_skr_account_number, type, color) VALUES ('other-account', 'other-tenant', 'Other bank', 'DE00000000000000000001', 0, '1200', 'bank', '#000000')`);
    await database.query(`INSERT INTO bank_transactions (id, tenant_id, account_id, date, amount, type, counterparty, purpose, linked_invoice_id, status, source_transaction_id, created_at, updated_at) VALUES ('tx-1', 'vlm-tenant', 'vlm-account', '2026-08-29', 119, 'income', 'Stored customer', 'Stored purpose', NULL, 'pending', NULL, $1, $1)`, [now]);
    await database.query(`INSERT INTO bank_transactions (id, tenant_id, account_id, date, amount, type, counterparty, purpose, linked_invoice_id, status, source_transaction_id, created_at, updated_at) VALUES ('foreign-tx', 'other-tenant', 'other-account', '2026-08-29', 119, 'income', 'Foreign customer', 'Foreign purpose', NULL, 'pending', NULL, $1, $1)`, [now]);
    await app.ready();
    const headers = { 'x-billme-local-token': 'vlm-token' };
    const config = await app.inject({ method: 'GET', url: '/api/v1/pro/accounting/vlm/config', headers });
    assert.equal(config.statusCode, 200, config.body);
    assert.deepEqual(config.json().models, ['model-a']);
    const analysis = await app.inject({ method: 'POST', url: '/api/v1/pro/accounting/transactions/tx-1/analyze-document', headers, payload: { transaction: { id: 'tx-1', date: '2099-01-01', amount: 1, type: 'expense', counterparty: 'Browser value', purpose: 'Browser value', currency: 'EUR' }, document: { mimeType: 'image/png', data: 'aA==' } } });
    assert.equal(analysis.statusCode, 200, analysis.body);
    assert.equal(analysis.json().extraction.invoiceNumber, 'RE-1');
    assert.deepEqual((analyzedInput as { transaction: unknown }).transaction, { id: 'tx-1', date: '2026-08-29', amount: 119, currency: 'EUR', type: 'income', counterparty: 'Stored customer', purpose: 'Stored purpose' });

    const mismatch = await app.inject({ method: 'POST', url: '/api/v1/pro/accounting/transactions/tx-1/analyze-document', headers, payload: { transaction: { id: 'tx-2', date: '2026-08-29', amount: 119, type: 'income', counterparty: 'Customer', purpose: 'RE-1', currency: 'EUR' }, document: { mimeType: 'image/png', data: 'aA==' } } });
    assert.equal(mismatch.statusCode, 400, mismatch.body);
    const missing = await app.inject({ method: 'POST', url: '/api/v1/pro/accounting/transactions/missing/analyze-document', headers, payload: { transaction: { id: 'missing', date: '2026-08-29', amount: 119, type: 'income', counterparty: 'Customer', purpose: 'RE-1', currency: 'EUR' }, document: { mimeType: 'image/png', data: 'aA==' } } });
    assert.equal(missing.statusCode, 404, missing.body);
    const foreign = await app.inject({ method: 'POST', url: '/api/v1/pro/accounting/transactions/foreign-tx/analyze-document', headers, payload: { transaction: { id: 'foreign-tx', date: '2026-08-29', amount: 119, type: 'income', counterparty: 'Customer', purpose: 'RE-1', currency: 'EUR' }, document: { mimeType: 'image/png', data: 'aA==' } } });
    assert.equal(foreign.statusCode, 404, foreign.body);
  } finally {
    await app.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
