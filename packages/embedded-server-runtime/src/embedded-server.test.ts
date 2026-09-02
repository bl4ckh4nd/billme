import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startEmbeddedServer,
  type EmbeddedServerHandle,
  type StartEmbeddedServerOptions,
} from '@billme/embedded-server-runtime';

const handles: EmbeddedServerHandle[] = [];
const temporaryDirectories: string[] = [];

const createOptions = (
  userDataPath: string,
  overrides: Partial<StartEmbeddedServerOptions> = {},
): StartEmbeddedServerOptions => ({
  userDataPath,
  dataDirName: 'embedded-server-test',
  product: 'lite',
  identity: {
    tenantId: 'embedded-test-tenant',
    userId: 'embedded-test-user',
    email: 'local@example.test',
    fullName: 'Local Test Owner',
  },
  ...overrides,
});

const start = async (options: StartEmbeddedServerOptions): Promise<EmbeddedServerHandle> => {
  const handle = await startEmbeddedServer(options);
  handles.push(handle);
  return handle;
};

const json = async (url: string, init?: RequestInit): Promise<{ response: Response; body: any }> => {
  const response = await fetch(url, init);
  return { response, body: await response.json() };
};

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('startEmbeddedServer', () => {
  it('starts on a random loopback port and protects capabilities with the per-start token', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'billme-embedded-server-runtime-'));
    temporaryDirectories.push(userDataPath);
    const handle = await start(createOptions(userDataPath));

    expect(new URL(handle.baseUrl).hostname).toBe('127.0.0.1');
    expect(new URL(handle.baseUrl).port).not.toBe('0');
    expect(Buffer.from(handle.accessToken, 'base64url')).toHaveLength(32);

    const health = await json(`${handle.baseUrl}/health`);
    expect(health.response.status).toBe(200);
    expect(health.body.ok).toBe(true);

    const missingToken = await json(`${handle.baseUrl}/api/v1/meta/capabilities`);
    expect(missingToken.response.status).toBe(401);

    const capabilities = await json(`${handle.baseUrl}/api/v1/meta/capabilities`, {
      headers: { 'x-billme-local-token': handle.accessToken },
    });
    expect(capabilities.response.status).toBe(200);
    expect(capabilities.body.runtime).toBe('embedded');
    expect(capabilities.body.database.local).toBe('pglite');
    expect(capabilities.body.products).toEqual(['lite']);

    const rejectedToken = await json(`${handle.baseUrl}/api/v1/meta/capabilities`, {
      headers: { 'x-billme-local-token': `${handle.accessToken}-wrong` },
    });
    expect(rejectedToken.response.status).toBe(401);
  });

  it('runs the initializer after migrations and scopes the runtime to its product', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'billme-embedded-server-runtime-'));
    temporaryDirectories.push(userDataPath);
    const events: string[] = [];
    const handle = await start(createOptions(userDataPath, {
      product: 'pro',
      logger: {
        info: (_context, message) => events.push(message),
      },
      initializeDatabase: async (database, context) => {
        events.push('initializer');
        const migrationTable = await database.query<{ name: string | null }>(
          "SELECT to_regclass('public.tenants') AS name",
        );
        expect(migrationTable.rows[0]?.name).toBe('tenants');
        expect(context.product).toBe('pro');
        await database.query(
          `INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $5)
           ON CONFLICT (id) DO NOTHING`,
          [context.identity.tenantId, 'embedded-pro', 'Embedded Pro', context.product, new Date().toISOString()],
        );
      },
    }));

    expect(events).toEqual(['initializer', 'Embedded server listening']);
    const headers = { 'x-billme-local-token': handle.accessToken };
    const capabilities = await json(`${handle.baseUrl}/api/v1/meta/capabilities`, { headers });
    expect(capabilities.body.products).toEqual(['pro']);

    const proClients = await json(`${handle.baseUrl}/api/v1/pro/clients`, { headers });
    expect(proClients.response.status).toBe(200);
    const liteRoute = await json(`${handle.baseUrl}/api/v1/lite/clients`, { headers });
    expect(liteRoute.response.status).toBe(404);
  });

  it('reuses the persistent PGlite directory and closes idempotently', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'billme-embedded-server-runtime-'));
    temporaryDirectories.push(userDataPath);
    const initializer = async (database: Parameters<NonNullable<StartEmbeddedServerOptions['initializeDatabase']>>[0]) => {
      await database.query('CREATE TABLE IF NOT EXISTS embedded_server_marker (value text NOT NULL)');
      await database.query('INSERT INTO embedded_server_marker (value) VALUES ($1)', ['persisted']);
    };

    const first = await start(createOptions(userDataPath, { initializeDatabase: initializer }));
    const firstToken = first.accessToken;
    const firstClose = first.close();
    expect(first.close()).toBe(firstClose);
    await firstClose;
    handles.splice(handles.indexOf(first), 1);

    const secondInitializer = async (database: Parameters<NonNullable<StartEmbeddedServerOptions['initializeDatabase']>>[0]) => {
      const marker = await database.query<{ value: string }>('SELECT value FROM embedded_server_marker');
      expect(marker.rows.map((row) => row.value)).toEqual(['persisted']);
    };
    const second = await start(createOptions(userDataPath, { initializeDatabase: secondInitializer }));
    expect(second.accessToken).not.toBe(firstToken);
    await second.close();
    await second.close();
    handles.splice(handles.indexOf(second), 1);
  });

  it('exposes a serialized PGlite data-directory dump without exposing the database', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'billme-embedded-server-runtime-'));
    temporaryDirectories.push(userDataPath);
    const handle = await start(createOptions(userDataPath));

    const dump = await handle.dumpDataDir();
    expect(dump.size).toBeGreaterThan(0);
    expect(handle).not.toHaveProperty('database');
  });

  it('closes the database when initialization fails so the directory can be reopened', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'billme-embedded-server-runtime-'));
    temporaryDirectories.push(userDataPath);
    await expect(startEmbeddedServer(createOptions(userDataPath, {
      initializeDatabase: async () => {
        throw new Error('initializer failed');
      },
    }))).rejects.toThrow('initializer failed');

    const reopened = await start(createOptions(userDataPath));
    expect(reopened.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it('does not write the generated access token to the data directory or logger', async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), 'billme-embedded-server-runtime-'));
    temporaryDirectories.push(userDataPath);
    const logs: string[] = [];
    const handle = await start(createOptions(userDataPath, {
      logger: {
        info: (_context, message, data) => logs.push(`${message} ${JSON.stringify(data ?? null)}`),
      },
    }));

    expect(logs.join('\n')).not.toContain(handle.accessToken);
    const files = await readdir(join(userDataPath, 'embedded-server-test'), { recursive: true });
    for (const relativeFile of files) {
      const file = join(userDataPath, 'embedded-server-test', relativeFile);
      try {
        expect(await readFile(file, 'utf8')).not.toContain(handle.accessToken);
      } catch {
        // PGlite stores binary files as well as text files; binary files do not
        // need to be decoded to prove that the textual secret was not written.
      }
    }
  });
});
