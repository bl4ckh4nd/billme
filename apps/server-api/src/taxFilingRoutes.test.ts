import assert from 'node:assert/strict';
import test from 'node:test';
import { buildServerApi } from './app.js';

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
