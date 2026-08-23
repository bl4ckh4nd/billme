import assert from 'node:assert/strict';
import test from 'node:test';
import { buildServerApi } from './app.js';

const previous = (name: string): string | undefined => process.env[name];

test('audit verification and CSV routes are registered for both products', async () => {
  const databaseUrl = previous('DATABASE_URL');
  const sessionSecret = previous('SESSION_SECRET');
  delete process.env.DATABASE_URL;
  process.env.SESSION_SECRET = 'server-runtime-audit-test-secret';

  const app = await buildServerApi();
  try {
    const sessions = {
      lite: app.tokenService.sign({
        user: { id: 'audit-lite-user', email: 'audit-lite@example.test', fullName: 'Audit Lite', role: 'owner' },
        scope: { tenantId: 'audit-lite-tenant', product: 'lite', deploymentMode: 'single-tenant' },
        role: 'owner',
      }),
      pro: app.tokenService.sign({
        user: { id: 'audit-pro-user', email: 'audit-pro@example.test', fullName: 'Audit Pro', role: 'owner' },
        scope: { tenantId: 'audit-pro-tenant', product: 'pro', deploymentMode: 'single-tenant' },
        role: 'owner',
      }),
    } as const;

    for (const product of ['lite', 'pro'] as const) {
      for (const suffix of ['verify', 'export.csv']) {
        const url = `/api/v1/${product}/audit/${suffix}`;
        assert.equal((await app.inject({ method: 'GET', url })).statusCode, 401, url);
        const response = await app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${sessions[product]}` },
        });
        assert.equal(response.statusCode, 503, `${url} must require a configured Postgres database`);
      }
    }
  } finally {
    await app.close();
    if (databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = databaseUrl;
    if (sessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = sessionSecret;
  }
});

test('audit routes reject a token issued for the other product', async () => {
  const databaseUrl = previous('DATABASE_URL');
  const sessionSecret = previous('SESSION_SECRET');
  delete process.env.DATABASE_URL;
  process.env.SESSION_SECRET = 'server-runtime-audit-scope-test-secret';
  const app = await buildServerApi();
  try {
    const liteToken = app.tokenService.sign({
      user: { id: 'audit-scope-user', email: 'audit-scope@example.test', fullName: 'Audit Scope', role: 'owner' },
      scope: { tenantId: 'audit-scope-tenant', product: 'lite', deploymentMode: 'single-tenant' },
      role: 'owner',
    });
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/pro/audit/verify',
      headers: { authorization: `Bearer ${liteToken}` },
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await app.close();
    if (databaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = databaseUrl;
    if (sessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = sessionSecret;
  }
});
