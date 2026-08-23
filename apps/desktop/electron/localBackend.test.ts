import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRODUCT_PROFILE } from '../productProfile';
import {
  createLocalBackend,
  LEGACY_SQLITE_MIGRATION_REQUIRED,
  type LocalBackendStartDependencies,
} from './localBackend';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const createOptions = async (overrides: Partial<LocalBackendStartDependencies> = {}) => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'billme-local-backend-'));
  temporaryDirectories.push(userDataPath);
  return {
    userDataPath,
    profile: PRODUCT_PROFILE,
    ...overrides,
  };
};

describe('createLocalBackend', () => {
  it('starts a fresh PGlite backend with stable local identity and idempotent cleanup', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const startEmbeddedServer = vi.fn(async (options: any) => {
      const database = {
        query,
        transaction: vi.fn(async (_options: unknown, work: (session: unknown) => Promise<void>) => work(database)),
      };
      await mkdir(join(options.userDataPath, options.dataDirName), { recursive: true });
      await options.initializeDatabase(database, {
        product: options.product,
        identity: options.identity,
        dataDir: join(options.userDataPath, options.dataDirName),
      });
      return {
        baseUrl: 'http://127.0.0.1:43123',
        accessToken: 'not-for-logs',
        close: vi.fn(async () => undefined),
      };
    });
    const options = await createOptions({ startEmbeddedServer });
    const backend = await createLocalBackend(options);

    expect(startEmbeddedServer).toHaveBeenCalledWith(expect.objectContaining({
      dataDirName: PRODUCT_PROFILE.dataDirName,
      product: 'lite',
      identity: expect.objectContaining({
        tenantId: PRODUCT_PROFILE.localTenantId,
        userId: PRODUCT_PROFILE.localUserId,
      }),
    }));
    expect(query.mock.calls.some(([, values]) => (
      Array.isArray(values) &&
      values.includes(PRODUCT_PROFILE.localTenantId) &&
      values.includes('lite')
    ))).toBe(true);
    expect(query.mock.calls.some(([, values]) => (
      Array.isArray(values) &&
      values.includes(PRODUCT_PROFILE.localUserId) &&
      values.includes(PRODUCT_PROFILE.localUserEmail)
    ))).toBe(true);
    await expect(stat(join(options.userDataPath, PRODUCT_PROFILE.dbFileName)))
      .rejects.toMatchObject({ code: 'ENOENT' });
    expect(backend.embeddedConnection()).toEqual({
      baseUrl: 'http://127.0.0.1:43123',
      token: 'not-for-logs',
    });

    await backend.close();
    await backend.close();
    const handle = startEmbeddedServer.mock.results[0]?.value;
    await expect(handle).resolves.toBeDefined();
    const resolvedHandle = await handle;
    expect(resolvedHandle.close).toHaveBeenCalledTimes(1);
    const secondBackend = await createLocalBackend(options);
    expect(startEmbeddedServer).toHaveBeenCalledTimes(2);
    await secondBackend.close();
  });

  it('starts an existing PGlite target without an app-local activation manifest', async () => {
    const options = await createOptions({
      startEmbeddedServer: vi.fn(async () => {
        return {
          baseUrl: 'http://127.0.0.1:43123',
          accessToken: 'token',
          close: vi.fn(async () => undefined),
        };
      }),
    });
    await mkdir(join(options.userDataPath, PRODUCT_PROFILE.dataDirName), { recursive: true });
    const backend = await createLocalBackend(options);

    expect(backend.mode).toBe('pglite');
    expect(options.startEmbeddedServer).toHaveBeenCalledTimes(1);
    await backend.close();
  });

  it('fails closed with the standalone migration command when legacy SQLite has no PGlite target', async () => {
    const options = await createOptions({
      startEmbeddedServer: vi.fn(),
    });
    await writeFile(join(options.userDataPath, PRODUCT_PROFILE.dbFileName), 'legacy');

    await expect(createLocalBackend(options)).rejects.toMatchObject({
      code: LEGACY_SQLITE_MIGRATION_REQUIRED,
      message: expect.stringContaining('billme-pglite-migrate --product lite'),
    });
    await expect(createLocalBackend(options)).rejects.toThrow(
      `--source '${join(options.userDataPath, PRODUCT_PROFILE.dbFileName)}' --target '${join(options.userDataPath, PRODUCT_PROFILE.dataDirName)}'`,
    );
    expect(options.startEmbeddedServer).not.toHaveBeenCalled();
  });

  it('quotes migration paths containing spaces and shell metacharacters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'billme-local-backend-'));
    temporaryDirectories.push(root);
    const userDataPath = join(root, "Billme user's data; $HOME");
    await mkdir(userDataPath, { recursive: true });
    const options: LocalBackendStartDependencies = {
      userDataPath,
      profile: PRODUCT_PROFILE,
      startEmbeddedServer: vi.fn(),
    };
    await writeFile(join(userDataPath, PRODUCT_PROFILE.dbFileName), 'legacy');

    const sourcePath = join(userDataPath, PRODUCT_PROFILE.dbFileName);
    const targetDataDir = join(userDataPath, PRODUCT_PROFILE.dataDirName);
    await expect(createLocalBackend(options)).rejects.toThrow(
      `--source '${sourcePath.replaceAll("'", "'\\''")}' --target '${targetDataDir.replaceAll("'", "'\\''")}'`,
    );
  });

  it('fails closed for legacy business IPC while PGlite owns the local data', async () => {
    const options = await createOptions({
      startEmbeddedServer: vi.fn(async () => ({
        baseUrl: 'http://127.0.0.1:43123',
        accessToken: 'token',
        close: vi.fn(async () => undefined),
      })),
    });
    const backend = await createLocalBackend(options);

    expect(() => backend.requireDb()).toThrow(/PGlite.*SQLite|SQLite.*PGlite/);
    await backend.close();
  });

  it('closes the active backend before a successful restore and keeps it closed for relaunch', async () => {
    const firstClose = vi.fn(async () => undefined);
    const startEmbeddedServer = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:43123',
      accessToken: 'token',
      dumpDataDir: vi.fn(async () => new Uint8Array()),
      close: firstClose,
    }));
    const restoreDataDir = vi.fn(async (restoreOptions: {
      archivePath: string;
      activeDataDir: string;
      product: 'lite';
      tenantId: string;
    }) => {
      expect(restoreOptions).toMatchObject({
        archivePath: '/tmp/restore.pglite.tar',
        product: 'lite',
        tenantId: PRODUCT_PROFILE.localTenantId,
      });
      expect(restoreOptions.activeDataDir).toMatch(new RegExp(`${PRODUCT_PROFILE.dataDirName}$`));
      return { ok: true as const, verification: { ok: true, errors: [], count: 0, headHash: null } };
    });
    const options = await createOptions({ startEmbeddedServer, restoreDataDir });
    const backend = await createLocalBackend(options);

    await expect(backend.restoreDataDir('/tmp/restore.pglite.tar'))
      .resolves.toMatchObject({ ok: true, verification: { ok: true } });
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(startEmbeddedServer).toHaveBeenCalledTimes(1);
    await backend.close();
    expect(firstClose).toHaveBeenCalledTimes(1);
  });

  it('restarts the embedded backend when restore verification fails before activation', async () => {
    const closes = [vi.fn(async () => undefined), vi.fn(async () => undefined)];
    let startCount = 0;
    const startEmbeddedServer = vi.fn(async () => ({
      baseUrl: `http://127.0.0.1:${43123 + startCount}`,
      accessToken: `token-${startCount}`,
      dumpDataDir: vi.fn(async () => new Uint8Array()),
      close: closes[startCount++]!,
    }));
    const restoreDataDir = vi.fn(async () => {
      throw new Error('Restore-Archiv enthält eine ungültige Audit-Kette.');
    });
    const options = await createOptions({ startEmbeddedServer, restoreDataDir });
    const backend = await createLocalBackend(options);

    await expect(backend.restoreDataDir('/tmp/invalid.pglite.tar')).rejects.toThrow('ungültige Audit-Kette');
    expect(startEmbeddedServer).toHaveBeenCalledTimes(2);
    await backend.close();
    expect(closes[1]).toHaveBeenCalledTimes(1);
  });
});
