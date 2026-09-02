import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPgliteServerDatabase } from '@billme/server-data/pglite';
import { restorePgliteDataDir } from './pgliteRestore';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const createTenant = async (dataDir: string, tenantId: string, marker: string, invalidAudit = false) => {
  const database = await createPgliteServerDatabase(dataDir);
  await database.migrate();
  await database.query(
    `INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'lite', 'single-tenant', 'active', $4, $4)`,
    [tenantId, tenantId, `Tenant ${tenantId}`, '2026-08-22T00:00:00.000Z'],
  );
  await database.query('CREATE TABLE restore_marker (value TEXT NOT NULL)');
  await database.query('INSERT INTO restore_marker (value) VALUES ($1)', [marker]);
  if (invalidAudit) {
    await database.query(
      `INSERT INTO audit_log
       (tenant_id, sequence, ts, entity_type, entity_id, action, reason, prev_hash, hash, actor)
       VALUES ($1, 1, $2, 'restore', 'invalid', 'restore', NULL, NULL, 'not-a-valid-hash', 'local')`,
      [tenantId, '2026-08-22T00:00:00.000Z'],
    );
  }
  const dump = await database.dumpDataDir('none');
  await database.close();
  return new Uint8Array(await dump.arrayBuffer());
};

const createFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'billme-pglite-restore-'));
  temporaryDirectories.push(root);
  const activeDataDir = join(root, 'billme-pglite');
  const archiveSourceDir = join(root, 'archive-source');
  await createTenant(activeDataDir, 'active-tenant', 'before');
  const validArchive = await createTenant(archiveSourceDir, 'active-tenant', 'after');
  const archivePath = join(root, 'backups', 'valid.pglite.tar');
  await mkdir(join(root, 'backups'), { recursive: true });
  await writeFile(archivePath, validArchive);
  return { root, activeDataDir, archivePath };
};

describe('restorePgliteDataDir', () => {
  it('loads a valid archive into staging and atomically activates it', async () => {
    const fixture = await createFixture();

    await expect(restorePgliteDataDir({
      archivePath: fixture.archivePath,
      activeDataDir: fixture.activeDataDir,
      product: 'lite',
      tenantId: 'active-tenant',
    })).resolves.toMatchObject({ ok: true, verification: { ok: true, count: 0 } });

    const restored = await createPgliteServerDatabase(fixture.activeDataDir);
    await expect(restored.query<{ value: string }>('SELECT value FROM restore_marker'))
      .resolves.toMatchObject({ rows: [{ value: 'after' }] });
    await restored.close();

    const entries = await readdir(fixture.root);
    expect(entries.some((entry) => entry.includes('.restore-'))).toBe(false);
    expect(entries.some((entry) => entry.includes('.previous-'))).toBe(false);
  }, 30_000);

  it('keeps the active directory unchanged when the staged audit chain is invalid', async () => {
    const fixture = await createFixture();
    const invalidSourceDir = join(fixture.root, 'invalid-source');
    const invalidArchive = await createTenant(invalidSourceDir, 'active-tenant', 'corrupt', true);
    const invalidArchivePath = join(fixture.root, 'backups', 'invalid.pglite.tar');
    await writeFile(invalidArchivePath, invalidArchive);

    await expect(restorePgliteDataDir({
      archivePath: invalidArchivePath,
      activeDataDir: fixture.activeDataDir,
      product: 'lite',
      tenantId: 'active-tenant',
    })).rejects.toThrow('ungültige Audit-Kette');

    const active = await createPgliteServerDatabase(fixture.activeDataDir);
    await expect(active.query<{ value: string }>('SELECT value FROM restore_marker'))
      .resolves.toMatchObject({ rows: [{ value: 'before' }] });
    await active.close();

    expect(existsSync(`${fixture.activeDataDir}.previous`)).toBe(false);
    const entries = await readdir(fixture.root);
    expect(entries.some((entry) => entry.includes('.restore-'))).toBe(false);
    expect(entries.some((entry) => entry.includes('.previous-'))).toBe(false);
    await expect(readFile(fixture.archivePath)).resolves.toBeTruthy();
  }, 30_000);
});
