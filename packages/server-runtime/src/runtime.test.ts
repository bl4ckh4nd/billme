import assert from 'node:assert/strict';
import test from 'node:test';
import { buildServerApi } from './app.js';

test('server-runtime exposes the shared Fastify interface independently of server-api', async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousSessionSecret = process.env.SESSION_SECRET;
  delete process.env.DATABASE_URL;
  process.env.SESSION_SECRET = 'server-runtime-package-test-secret';

  const app = await buildServerApi();
  try {
    const response = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().service, 'billme-server-api');
  } finally {
    await app.close();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
  }
});

test('server-runtime registers the hosted Pro catalog routes before authentication', async () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousSessionSecret = process.env.SESSION_SECRET;
  delete process.env.DATABASE_URL;
  process.env.SESSION_SECRET = 'server-runtime-pro-catalog-test-secret';

  const app = await buildServerApi();
  try {
    for (const url of [
      '/api/v1/pro/articles',
      '/api/v1/pro/accounts',
      '/api/v1/pro/templates',
      '/api/v1/pro/templates/active/invoice',
      '/api/v1/pro/templates/active/offer',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      assert.equal(response.statusCode, 401, `${url} must be registered and reach product auth`);
    }
  } finally {
    await app.close();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
  }
});
