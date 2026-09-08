import assert from 'node:assert/strict';
import test from 'node:test';
import { createOpenRouterVlmService, OpenRouterVlmError, parseOpenRouterVlmConfig } from './openRouterVlm.js';

const extraction = {
  documentType: 'invoice', issuer: 'Acme GmbH', recipient: 'Billme', invoiceNumber: 'RE-42', invoiceDate: '2026-08-20', servicePeriod: null, dueDate: '2026-09-03', currency: 'EUR', netAmount: 100, taxAmount: 19, grossAmount: 119, vatBreakdown: [{ rate: 19, netAmount: 100, taxAmount: 19 }], iban: null, paymentReference: 'RE-42', suggestedAccountNumber: '8400', suggestedTaxCase: 'DE_STD_19', matchAssessment: { amountMatches: true, dateMatches: true, partyMatches: true, referenceMatches: true, notes: [] }, warnings: [], evidence: [{ field: 'invoiceNumber', value: 'RE-42', page: 1, confidence: 0.99 }],
};

test('OpenRouter VLM parses configured model output and sends privacy/provider controls', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const service = createOpenRouterVlmService({
    env: { OPENROUTER_API_KEY: 'secret', OPENROUTER_VLM_MODEL: 'google/gemini-3.7-flash', OPENROUTER_VLM_MODELS: 'google/gemini-3.7-flash,openai/gpt-5.1' },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ id: 'req-42', provider: 'google-vertex', choices: [{ message: { content: JSON.stringify(extraction) } }] }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'header-42' } });
    },
    now: (() => { const values = [new Date('2026-08-29T10:00:00.000Z'), new Date('2026-08-29T10:00:00.250Z')]; return () => values.shift() ?? new Date('2026-08-29T10:00:00.250Z'); })(),
    requestId: () => 'fallback-request',
  });

  const result = await service.analyze({ transaction: { id: 'tx-1', date: '2026-08-29', amount: 119, type: 'income', counterparty: 'Acme GmbH', purpose: 'RE-42', currency: 'EUR' }, document: { mimeType: 'application/pdf', data: Buffer.from('invoice').toString('base64'), fileName: 'invoice.pdf' }, model: 'openai/gpt-5.1' });
  assert.equal(result.extraction.invoiceNumber, 'RE-42');
  assert.equal(result.metadata.provider, 'google-vertex');
  assert.equal(result.metadata.requestId, 'header-42');
  assert.equal(result.metadata.timing.durationMs, 250);
  assert.equal(calls.length, 1);
  assert.equal((calls[0]?.init?.headers as Record<string, string>)?.['X-OpenRouter-Title'], 'Billme Pro');
  const body = JSON.parse(String(calls[0]?.init?.body));
  assert.deepEqual(body.provider, { zdr: true, data_collection: 'deny', require_parameters: true });
  assert.equal(body.model, 'openai/gpt-5.1');
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.match(String(body.messages[1].content[2].file.file_data), /^data:application\/pdf;base64,/);
  assert.equal(service.getConfig().configured, true);
  assert.deepEqual(service.getConfig().models, ['google/gemini-3.7-flash', 'openai/gpt-5.1']);
  assert.equal(result.deterministicChecks.amountMatches, true);
  assert.equal(result.deterministicChecks.currencyMatches, true);
  assert.equal(result.extraction.matchAssessment.amountMatches, true);

  const mismatched = await service.analyze({
    transaction: { id: 'tx-2', date: '2026-08-29', amount: 118.99, type: 'income', counterparty: 'Acme GmbH', purpose: 'RE-42', currency: 'EUR' },
    document: { mimeType: 'application/pdf', data: Buffer.from('invoice').toString('base64'), fileName: 'invoice.pdf' },
  });
  assert.equal(mismatched.extraction.matchAssessment.amountMatches, true);
  assert.equal(mismatched.deterministicChecks.amountMatches, false);
});

test('OpenRouter VLM rejects unconfigured, unallowlisted, malformed, and oversized documents before fetch', async () => {
  let calls = 0;
  const service = createOpenRouterVlmService({ env: {}, fetch: async () => { calls += 1; return new Response('{}'); } });
  await assert.rejects(() => service.analyze({ transaction: { id: 'tx', date: '2026-01-01', amount: 1, type: 'expense', counterparty: '', purpose: '' }, document: { mimeType: 'image/png', data: 'aA==' } }), (error: unknown) => error instanceof OpenRouterVlmError && error.code === 'OPENROUTER_NOT_CONFIGURED');

  const configured = createOpenRouterVlmService({ env: { OPENROUTER_API_KEY: 'key', OPENROUTER_VLM_MODELS: 'model-a' }, fetch: async () => { calls += 1; return new Response('{}'); } });
  await assert.rejects(() => configured.analyze({ model: 'model-b', transaction: { id: 'tx', date: '2026-01-01', amount: 1, type: 'expense', counterparty: '', purpose: '' }, document: { mimeType: 'image/png', data: 'aA==' } }), (error: unknown) => error instanceof OpenRouterVlmError && error.code === 'OPENROUTER_MODEL_NOT_ALLOWED');
  await assert.rejects(() => configured.analyze({ transaction: { id: 'tx', date: '2026-01-01', amount: 1, type: 'expense', counterparty: '', purpose: '' }, document: { mimeType: 'image/png', data: 'not-base64!' } }), (error: unknown) => error instanceof OpenRouterVlmError && error.code === 'OPENROUTER_DOCUMENT_INVALID');
  await assert.rejects(() => configured.analyze({ transaction: { id: 'tx', date: '2026-01-01', amount: 1, type: 'expense', counterparty: '', purpose: '' }, document: { mimeType: 'image/png', data: 'A'.repeat(14_000_000) } }), (error: unknown) => error instanceof OpenRouterVlmError && error.code === 'OPENROUTER_DOCUMENT_INVALID');
  assert.equal(calls, 0);
});

test('OpenRouter VLM config always includes the selected model in the allowlist', () => {
  const config = parseOpenRouterVlmConfig({ OPENROUTER_VLM_MODEL: 'model-a', OPENROUTER_VLM_MODELS: 'model-b' });
  assert.deepEqual(config.models, ['model-a', 'model-b']);
  assert.equal(config.configured, false);
  assert.equal('apiKey' in config, true);
});
