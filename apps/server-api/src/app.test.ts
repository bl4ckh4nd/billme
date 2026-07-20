import assert from 'node:assert/strict';
import test from 'node:test';
import { buildServerApi } from './app.js';

const withServerApi = async (
  run: (app: Awaited<ReturnType<typeof buildServerApi>>) => Promise<void>,
): Promise<void> => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  const previousSessionSecret = process.env.SESSION_SECRET;
  delete process.env.DATABASE_URL;
  process.env.SESSION_SECRET = 'billme-server-api-test-secret';

  const app = await buildServerApi();
  try {
    await run(app);
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

const bootstrap = async (app: Awaited<ReturnType<typeof buildServerApi>>, product: 'lite' | 'pro') => {
  const response = await app.inject({
    method: 'POST',
    url: `/api/v1/${product}/auth/bootstrap`,
    payload: {
      email: `${product}.owner@example.com`,
      password: 'billme-server-123',
      fullName: `${product} owner`,
    },
  });

  assert.equal(response.statusCode, 200);
  return response.json() as { token: string; user: { email: string; fullName: string } };
};

test('lite auth bootstrap/login/me flow works without DATABASE_URL', async () => {
  await withServerApi(async (app) => {
    const bootstrapResponse = await bootstrap(app, 'lite');
    assert.equal(bootstrapResponse.user.email, 'lite.owner@example.com');

    const meResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/lite/auth/me',
      headers: {
        authorization: `Bearer ${bootstrapResponse.token}`,
      },
    });
    assert.equal(meResponse.statusCode, 200);
    const meBody = meResponse.json() as {
      product: string;
      role: string;
      user: { email: string; fullName: string };
    };
    assert.equal(meBody.product, 'lite');
    assert.equal(meBody.role, 'owner');
    assert.equal(meBody.user.email, 'lite.owner@example.com');
    assert.equal(meBody.user.fullName, 'lite owner');
  });
});

test('generic auth routes support the pro product end-to-end', async () => {
  await withServerApi(async (app) => {
    const bootstrapResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/bootstrap?product=pro',
      payload: {
        email: 'pro.owner@example.com',
        password: 'billme-server-123',
        fullName: 'pro owner',
      },
    });
    assert.equal(bootstrapResponse.statusCode, 200);
    const bootstrapBody = bootstrapResponse.json() as {
      token: string;
      user: { email: string; fullName: string; role: string };
    };
    assert.equal(bootstrapBody.user.email, 'pro.owner@example.com');
    assert.equal(bootstrapBody.user.role, 'owner');

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login?product=pro',
      payload: {
        email: 'pro.owner@example.com',
        password: 'billme-server-123',
      },
    });
    assert.equal(loginResponse.statusCode, 200);
    const loginBody = loginResponse.json() as {
      token: string;
      user: { email: string };
    };
    assert.equal(loginBody.user.email, 'pro.owner@example.com');

    const meResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/auth/me?product=pro',
      headers: {
        authorization: `Bearer ${loginBody.token}`,
      },
    });
    assert.equal(meResponse.statusCode, 200);
    const meBody = meResponse.json() as {
      product: string;
      user: { email: string };
      role: string;
    };
    assert.equal(meBody.product, 'pro');
    assert.equal(meBody.user.email, 'pro.owner@example.com');
    assert.equal(meBody.role, 'owner');
  });
});

test('product tokens cannot cross product boundaries', async () => {
  await withServerApi(async (app) => {
    const liteBootstrap = await bootstrap(app, 'lite');
    const forbiddenResponse = await app.inject({
      method: 'GET',
      url: '/api/v1/pro/auth/me',
      headers: {
        authorization: `Bearer ${liteBootstrap.token}`,
      },
    });
    assert.equal(forbiddenResponse.statusCode, 403);
    assert.match(forbiddenResponse.body, /not authorized for pro/i);
  });
});

test('protected lite and pro billing routes require DATABASE_URL after auth succeeds', async () => {
  await withServerApi(async (app) => {
    const liteBootstrap = await bootstrap(app, 'lite');
    const proBootstrap = await bootstrap(app, 'pro');

    const liteClients = await app.inject({
      method: 'GET',
      url: '/api/v1/lite/clients',
      headers: {
        authorization: `Bearer ${liteBootstrap.token}`,
      },
    });
    assert.equal(liteClients.statusCode, 503);
    assert.match(liteClients.body, /DATABASE_URL is required/i);

    const proWorkflow = await app.inject({
      method: 'GET',
      url: '/api/v1/pro/workflow',
      headers: {
        authorization: `Bearer ${proBootstrap.token}`,
      },
    });
    assert.equal(proWorkflow.statusCode, 503);
    assert.match(proWorkflow.body, /DATABASE_URL is required/i);
  });
});

test('typed validation rejects invalid bootstrap payloads', async () => {
  await withServerApi(async (app) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/lite/auth/bootstrap',
      payload: {
        email: 'not-an-email',
        password: 'short',
        fullName: '',
      },
    });
    assert.equal(response.statusCode, 400);
    assert.match(response.body, /Invalid email|String must contain at least/i);
  });
});

test('login attempts are throttled', async () => {
  await withServerApi(async (app) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/lite/auth/login',
        payload: { email: 'missing@example.com', password: 'incorrect-password' },
      });
      assert.equal(response.statusCode, 401);
    }

    const limited = await app.inject({
      method: 'POST',
      url: '/api/v1/lite/auth/login',
      payload: { email: 'missing@example.com', password: 'incorrect-password' },
    });
    assert.equal(limited.statusCode, 429);
  });
});

test('write routes reject viewer tokens before touching the database', async () => {
  await withServerApi(async (app) => {
    const viewerToken = app.tokenService.sign({
      user: { id: 'viewer-1', email: 'viewer@example.com', fullName: 'Viewer', role: 'viewer' },
      scope: { tenantId: 'tenant-1', product: 'lite', deploymentMode: 'multi-tenant' },
      role: 'viewer',
    });

    const denied = await app.inject({
      method: 'POST',
      url: '/api/v1/lite/numbers/reserve',
      headers: { authorization: `Bearer ${viewerToken}` },
      payload: { kind: 'invoice' },
    });
    assert.equal(denied.statusCode, 403);

    const ownerToken = app.tokenService.sign({
      user: { id: 'owner-1', email: 'owner@example.com', fullName: 'Owner', role: 'owner' },
      scope: { tenantId: 'tenant-1', product: 'lite', deploymentMode: 'multi-tenant' },
      role: 'owner',
    });
    const allowed = await app.inject({
      method: 'POST',
      url: '/api/v1/lite/numbers/reserve',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { kind: 'invoice' },
    });
    assert.equal(allowed.statusCode, 503);
  });
});
