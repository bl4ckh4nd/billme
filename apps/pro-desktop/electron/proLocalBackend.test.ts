import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PRODUCT_PROFILE } from '../productProfile';
import {
  createProLocalBackend,
  PRO_PGLITE_MIGRATION_REQUIRED,
} from './proLocalBackend';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const createOptions = async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'billme-pro-local-backend-'));
  temporaryDirectories.push(userDataPath);
  return { userDataPath, profile: PRODUCT_PROFILE };
};

describe('createProLocalBackend', () => {
  it('starts the embedded Pro server and exposes only its tokenized connection', async () => {
    const options = await createOptions();
    const close = vi.fn(async () => undefined);
    const query = vi.fn(async () => ({ rows: [] }));
    const startEmbeddedServer = vi.fn(async (startOptions: any) => {
      await mkdir(join(startOptions.userDataPath, startOptions.dataDirName), { recursive: true });
      await startOptions.initializeDatabase(
        {
          query,
          transaction: async (_transactionOptions: unknown, work: (session: unknown) => Promise<void>) =>
            work({ query }),
        },
        {
          product: startOptions.product,
          identity: startOptions.identity,
          dataDir: join(startOptions.userDataPath, startOptions.dataDirName),
        },
      );
      return { baseUrl: 'http://127.0.0.1:43123', accessToken: 'pro-local-token', close };
    });

    const backend = await createProLocalBackend({ ...options, startEmbeddedServer });

    expect(startEmbeddedServer).toHaveBeenCalledWith(expect.objectContaining({
      product: 'pro',
      dataDirName: PRODUCT_PROFILE.dataDirName,
      identity: {
        tenantId: PRODUCT_PROFILE.localTenantId,
        userId: PRODUCT_PROFILE.localUserId,
        email: PRODUCT_PROFILE.localUserEmail,
        fullName: PRODUCT_PROFILE.localUserFullName,
        role: 'owner',
      },
    }));
    expect(query.mock.calls.some(([, values]) => (
      Array.isArray(values) &&
      values.includes(PRODUCT_PROFILE.localTenantId) &&
      values.includes('pro')
    ))).toBe(true);
    expect(query.mock.calls.some(([, values]) => (
      Array.isArray(values) &&
      values.includes(PRODUCT_PROFILE.localUserId) &&
      values.includes(PRODUCT_PROFILE.localUserEmail)
    ))).toBe(true);
    expect(backend.mode).toBe('pglite');
    expect(backend.embeddedConnection()).toEqual({
      baseUrl: 'http://127.0.0.1:43123',
      token: 'pro-local-token',
    });

    await backend.close();
    await backend.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('fails closed with a migration instruction when only the legacy SQLite file exists', async () => {
    const options = await createOptions();
    await writeFile(join(options.userDataPath, PRODUCT_PROFILE.dbFileName), 'legacy sqlite');
    const startEmbeddedServer = vi.fn();

    await expect(createProLocalBackend({ ...options, startEmbeddedServer }))
      .rejects.toMatchObject({ code: PRO_PGLITE_MIGRATION_REQUIRED });
    expect(startEmbeddedServer).not.toHaveBeenCalled();
  });

  it('quotes migration paths containing spaces and shell metacharacters', async () => {
    const root = await mkdtemp(join(tmpdir(), 'billme-pro-local-backend-'));
    temporaryDirectories.push(root);
    const userDataPath = join(root, "Billme Pro user's data; $HOME");
    await mkdir(userDataPath, { recursive: true });
    const sourcePath = join(userDataPath, PRODUCT_PROFILE.dbFileName);
    const targetDataDir = join(userDataPath, PRODUCT_PROFILE.dataDirName);
    await writeFile(sourcePath, 'legacy sqlite');

    await expect(createProLocalBackend({
      userDataPath,
      profile: PRODUCT_PROFILE,
      startEmbeddedServer: vi.fn(),
    })).rejects.toThrow(
      `billme-pglite-migrate --product pro --source '${sourcePath.replaceAll("'", "'\\''")}' --target '${targetDataDir.replaceAll("'", "'\\''")}'`,
    );
  });

  it('closes the active backend before a successful restore and leaves relaunch to the native boundary', async () => {
    const close = vi.fn(async () => undefined);
    const startEmbeddedServer = vi.fn(async () => ({
      baseUrl: 'http://127.0.0.1:43123',
      accessToken: 'pro-local-token',
      dumpDataDir: vi.fn(async () => new Uint8Array()),
      close,
    }));
    const restoreDataDir = vi.fn(async () => ({
      ok: true as const,
      verification: { ok: true, errors: [], count: 1, headHash: 'head' },
    }));
    const options = await createOptions();
    const backend = await createProLocalBackend({ ...options, startEmbeddedServer, restoreDataDir });

    await expect(backend.restoreDataDir('/tmp/pro-restore.pglite.tar'))
      .resolves.toEqual({ ok: true, verification: { ok: true, errors: [], count: 1, headHash: 'head' } });
    expect(close).toHaveBeenCalledTimes(1);
    expect(restoreDataDir).toHaveBeenCalledWith(expect.objectContaining({
      archivePath: '/tmp/pro-restore.pglite.tar',
      product: 'pro',
      tenantId: PRODUCT_PROFILE.localTenantId,
    }));
    await backend.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
