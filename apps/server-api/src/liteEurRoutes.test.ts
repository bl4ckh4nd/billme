import assert from 'node:assert/strict';
import test from 'node:test';
import { buildServerApi } from './app.js';
import { liteEurClassificationBodySchema, liteEurReportQuerySchema } from './liteEurRoutes.js';

test('Lite EÜR route schemas are calendar-year and reason guarded', () => {
  assert.deepEqual(liteEurReportQuerySchema.parse({}), { from: '2025-01-01', to: '2025-12-31' });
  assert.throws(() => liteEurReportQuerySchema.parse({ from: '2026-01-01' }));
  assert.throws(() => liteEurClassificationBodySchema.parse({ sourceType: 'invoice', sourceId: 'invoice-1', taxYear: 2025 }));
  assert.equal(liteEurClassificationBodySchema.parse({ sourceType: 'invoice', sourceId: 'invoice-1', taxYear: 2025, reason: 'Beleg geprüft' }).reason, 'Beleg geprüft');
});

test('Lite EÜR routes enforce product isolation and mutation roles before the database', async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousSessionSecret = process.env.SESSION_SECRET;
  delete process.env.DATABASE_URL;
  process.env.SESSION_SECRET = 'billme-lite-eur-test-secret';
  const app = await buildServerApi();
  try {
    const liteResponse = await app.inject({ method: 'POST', url: '/api/v1/lite/auth/bootstrap', payload: { email: 'lite-eur@example.com', password: 'billme-server-123', fullName: 'Lite EÜR' } });
    assert.equal(liteResponse.statusCode, 200);
    const liteToken = liteResponse.json().token as string;
    const invalidRange = await app.inject({ method: 'GET', url: '/api/v1/lite/reports/eur?from=2026-01-01', headers: { authorization: `Bearer ${liteToken}` } });
    assert.equal(invalidRange.statusCode, 400);

    const proToken = app.tokenService.sign({ ...app.tokenService.verify(liteToken)!, scope: { ...app.tokenService.verify(liteToken)!.scope, product: 'pro' } });
    const crossProduct = await app.inject({ method: 'GET', url: '/api/v1/lite/reports/eur', headers: { authorization: `Bearer ${proToken}` } });
    assert.equal(crossProduct.statusCode, 403);

    const viewerToken = app.tokenService.sign({ ...app.tokenService.verify(liteToken)!, role: 'viewer' });
    const forbidden = await app.inject({ method: 'PUT', url: '/api/v1/lite/reports/eur/classifications', headers: { authorization: `Bearer ${viewerToken}` }, payload: { sourceType: 'invoice', sourceId: 'invoice-1', taxYear: 2025, reason: 'Nicht erlaubt' } });
    assert.equal(forbidden.statusCode, 403);
  } finally {
    await app.close();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
  }
});
