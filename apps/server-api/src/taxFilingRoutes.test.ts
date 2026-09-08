import assert from 'node:assert/strict';
import test from 'node:test';
import { taxFilingCreateRequestSchema, taxFilingMutationRequestSchema } from '@billme/server-core';
import { buildServerApi } from './app.js';

test('tax filing request schemas require reasons, idempotency, and a complete snapshot', () => {
  assert.throws(() => taxFilingCreateRequestSchema.parse({ kind: 'euer', payload: {}, idempotencyKey: 'x' }));
  assert.throws(() => taxFilingMutationRequestSchema.parse({ reason: 'retry' }));
  const request = taxFilingCreateRequestSchema.parse({
    kind: 'euer',
    periodStart: '2025-01-01',
    periodEnd: '2025-12-31',
    payload: { xml: '<official-document />' },
    idempotencyKey: 'create-1',
    reason: 'EÜR vorbereiten',
  });
  assert.equal(request.kind, 'euer');
});

test('tax filing routes enforce Pro bearer auth before Postgres access', async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousSessionSecret = process.env.SESSION_SECRET;
  delete process.env.DATABASE_URL;
  process.env.SESSION_SECRET = 'tax-filing-route-test-secret';
  const app = await buildServerApi();
  try {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/pro/tax-filings' });
    assert.equal(unauthorized.statusCode, 401);
  } finally {
    await app.close();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
  }
});
