import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type Database from 'better-sqlite3';
import type { ServerDatabase } from '../database.js';
import type { DesktopSqliteImportCounts } from '../postgres/importDesktop.js';
import { migrateSqliteToPglite, PGLITE_MIGRATION_MANIFEST_FILE } from './cutover.js';

const temporaryDirectories: string[] = [];

const fakeSourceDatabase = (): Database.Database => ({
  close: () => undefined,
} as unknown as Database.Database);

const fakeTargetDatabase = (details: unknown = { counts: { clients: 1 } }): ServerDatabase => ({
  engine: 'pglite',
  drizzle: () => undefined,
  query: async <Row = Record<string, unknown>>() => ({ rows: [{ status: 'completed', details_json: JSON.stringify(details) }] as Row[] }),
  transaction: async () => undefined as never,
  migrate: async () => undefined,
  assertCurrent: async () => undefined,
  close: async () => undefined,
});

test.afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test('PGlite cutover preserves source and backup, validates the import receipt, then atomically activates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'billme-pglite-cutover-'));
  temporaryDirectories.push(root);
  const sourcePath = join(root, 'billme.sqlite');
  const targetDataDir = join(root, 'billme-pglite');
  await writeFile(sourcePath, 'legacy source');
  const sourceHash = createHash('sha256').update(await readFile(sourcePath)).digest('hex');
  const database = fakeTargetDatabase();

  const result = await migrateSqliteToPglite({
    sourcePath,
    targetDataDir,
    product: 'lite',
    tenant: { id: 'tenant-1', slug: 'billme-local', displayName: 'Billme lokal' },
    openSqlite: () => fakeSourceDatabase(),
    backupSqlite: async (_database, destinationPath) => copyFile(sourcePath, destinationPath),
    createDatabase: async () => database,
    importSqlite: async () => ({ importRunId: 'import-1', counts: { clients: 1 } as DesktopSqliteImportCounts, unsupportedTables: [] }),
    now: () => '2026-08-22T00:00:00.000Z',
  });

  assert.equal(result.manifest.product, 'lite');
  assert.equal(result.manifest.source.sha256, sourceHash);
  assert.equal(result.manifest.importRunId, 'import-1');
  assert.equal(result.manifest.counts.clients, 1);
  assert.equal(result.manifest.completedAt, '2026-08-22T00:00:00.000Z');
  assert.equal(await readFile(sourcePath, 'utf8'), 'legacy source');
  assert.equal(await readFile(result.backupPath, 'utf8'), 'legacy source');
  assert.equal(await readFile(join(targetDataDir, PGLITE_MIGRATION_MANIFEST_FILE), 'utf8').then((value) => value.includes('import-1')), true);
  assert.equal((await readdir(root)).some((entry) => entry.includes('.staging-')), false);
});

test('PGlite cutover refuses an existing target before opening or backing up SQLite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'billme-pglite-cutover-existing-'));
  temporaryDirectories.push(root);
  const sourcePath = join(root, 'billme.sqlite');
  const targetDataDir = join(root, 'billme-pglite');
  await writeFile(sourcePath, 'legacy source');
  await writeFile(join(root, 'existing-marker'), 'keep');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(targetDataDir));
  let opened = false;
  let backedUp = false;

  await assert.rejects(
    migrateSqliteToPglite({
      sourcePath,
      targetDataDir,
      product: 'pro',
      tenant: { id: 'tenant-1', slug: 'billme-pro-local', displayName: 'Billme Pro lokal' },
      openSqlite: () => { opened = true; return fakeSourceDatabase(); },
      backupSqlite: async () => { backedUp = true; },
    }),
    /already exists; refusing to overwrite/,
  );
  assert.equal(opened, false);
  assert.equal(backedUp, false);
});

test('PGlite cutover quarantines failed staging and rejects incomplete import status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'billme-pglite-cutover-status-'));
  temporaryDirectories.push(root);
  const sourcePath = join(root, 'billme.sqlite');
  const targetDataDir = join(root, 'billme-pglite');
  await writeFile(sourcePath, 'legacy source');

  await assert.rejects(
    migrateSqliteToPglite({
      sourcePath,
      targetDataDir,
      product: 'pro',
      tenant: { id: 'tenant-1', slug: 'billme-pro-local', displayName: 'Billme Pro lokal' },
      openSqlite: () => fakeSourceDatabase(),
      backupSqlite: async (_database, destinationPath) => copyFile(sourcePath, destinationPath),
      createDatabase: async () => ({
        ...fakeTargetDatabase({ counts: { clients: 1 } }),
        query: async <Row = Record<string, unknown>>() => ({ rows: [{ status: 'started', details_json: JSON.stringify({ counts: { clients: 1 } }) }] as Row[] }),
      }),
      importSqlite: async () => ({ importRunId: 'import-2', counts: { clients: 1 } as DesktopSqliteImportCounts, unsupportedTables: [] }),
    }),
    /did not complete/,
  );
  assert.equal((await readdir(root)).some((entry) => entry.includes('.staging-') && entry.includes('.failed-')), true);
  assert.equal(await readFile(sourcePath, 'utf8'), 'legacy source');
  assert.equal((await readdir(root)).some((entry) => entry === 'billme-pglite'), false);
});
