import assert from 'node:assert/strict';
import test from 'node:test';
import { buildServerApi } from './app.js';

test('source-run and tax preparation routes enforce auth and mutation role before Postgres', async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousSessionSecret = process.env.SESSION_SECRET;
  delete process.env.DATABASE_URL;
  process.env.SESSION_SECRET = 'accounting-source-runs-route-test-secret';
  const app = await buildServerApi();
  try {
    const unauthorized = await app.inject({ method: 'GET', url: '/api/v1/pro/accounting/source-runs' });
    assert.equal(unauthorized.statusCode, 401);
    const bootstrap = await app.inject({ method: 'POST', url: '/api/v1/pro/auth/bootstrap', payload: { email: 'source-runs-route@example.com', password: 'billme-server-123', fullName: 'Source Runs' } });
    assert.equal(bootstrap.statusCode, 200);
    const token = bootstrap.json().token as string;
    const viewerToken = app.tokenService.sign({ ...app.tokenService.verify(token)!, role: 'viewer' });
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/v1/pro/accounting/closing',
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { command: 'fiscal_close', sourceId: 'close-1', sourceRevision: 'v1', idempotencyKey: 'close-key', reason: 'viewer must not mutate' },
    });
    assert.equal(forbidden.statusCode, 403);
    const missingIdempotency = await app.inject({
      method: 'POST',
      url: '/api/v1/pro/accounting/closing',
      headers: { authorization: `Bearer ${token}` },
      payload: { command: 'fiscal_close', sourceId: 'close-1', sourceRevision: 'v1', reason: 'missing key' },
    });
    assert.equal(missingIdempotency.statusCode, 400);
  } finally {
    await app.close();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
  }
});
