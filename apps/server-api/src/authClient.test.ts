import assert from 'node:assert/strict';
import test from 'node:test';
import { createServerApiClient } from '@billme/server-core';
import { buildServerApi } from './app.js';

const withHttpServer = async (
  run: (baseUrl: string) => Promise<void>,
): Promise<void> => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousSessionSecret = process.env.SESSION_SECRET;
  delete process.env.DATABASE_URL;
  process.env.SESSION_SECRET = 'billme-server-api-client-test-secret';

  const app = await buildServerApi();
  const baseUrl = await app.listen({
    host: '127.0.0.1',
    port: 0,
  });

  try {
    await run(baseUrl.replace(/\/+$/, ''));
  } finally {
    await app.close();
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    if (previousSessionSecret === undefined) {
      delete process.env.SESSION_SECRET;
    } else {
      process.env.SESSION_SECRET = previousSessionSecret;
    }
  }
};

test('createServerApiClient.ensureSession bootstraps a lite owner and exposes tenant context', async () => {
  await withHttpServer(async (baseUrl) => {
    const client = createServerApiClient(baseUrl);
    const session = await client.ensureSession({
      product: 'lite',
      email: 'lite.owner@example.com',
      password: 'billme-server-123',
      fullName: 'Lite Owner',
    });

    assert.equal(session.via, 'bootstrap');
    assert.equal(session.product, 'lite');
    assert.equal(session.role, 'owner');
    assert.equal(session.user.email, 'lite.owner@example.com');
    assert.match(session.tenantId, /^[0-9a-f-]{36}$/i);
  });
});

test('createServerApiClient.ensureSession logs into an already bootstrapped pro tenant', async () => {
  await withHttpServer(async (baseUrl) => {
    const client = createServerApiClient(baseUrl);
    const first = await client.ensureSession({
      product: 'pro',
      email: 'pro.owner@example.com',
      password: 'billme-server-123',
      fullName: 'Pro Owner',
    });
    const second = await client.ensureSession({
      product: 'pro',
      email: 'pro.owner@example.com',
      password: 'billme-server-123',
      fullName: 'Ignored On Login',
    });

    assert.equal(first.via, 'bootstrap');
    assert.equal(second.via, 'login');
    assert.equal(second.product, 'pro');
    assert.equal(second.user.id, first.user.id);
    assert.equal(second.tenantId, first.tenantId);
  });
});

test('createServerApiClient.validateVatId keeps non-EU IDs out of VIES', async () => {
  await withHttpServer(async (baseUrl) => {
    const client = createServerApiClient(baseUrl);
    const session = await client.ensureSession({
      product: 'lite',
      email: 'vat.owner@example.com',
      password: 'billme-server-123',
      fullName: 'VAT Owner',
    });
    const result = await client.validateVatId({
      token: session.token,
      product: 'lite',
      countryCode: 'CH',
      vatNumber: 'CHE 123.456.789 MWST',
    });
    assert.equal(result.status, 'unavailable');
    assert.equal(result.normalizedVatId, 'CHE123.456.789MWST');
  });
});
