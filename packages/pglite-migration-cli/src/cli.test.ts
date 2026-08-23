import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMigrationArgs, runMigrationCli } from './cli.js';

const io = () => {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write: (chunk: string) => { stdout += chunk; } },
      stderr: { write: (chunk: string) => { stderr += chunk; } },
    },
    output: () => ({ stdout, stderr }),
  };
};

test('migration CLI requires a product, source, and new target directory', () => {
  assert.deepEqual(parseMigrationArgs([
    '--product', 'pro', '--source', '/data/billme.sqlite', '--target', '/data/billme-pro-pglite',
  ]), {
    product: 'pro',
    sourcePath: '/data/billme.sqlite',
    targetDataDir: '/data/billme-pro-pglite',
    backupPath: undefined,
    tenantId: 'billme-pro-local-tenant',
    tenantSlug: 'billme-pro-local',
    tenantName: 'Billme Pro lokal',
  });
});

test('migration CLI passes Lite/Pro identity and emits the cutover receipt', async () => {
  const captured: { product?: string; tenant?: unknown } = {};
  const streams = io();
  const code = await runMigrationCli([
    '--product=lite', '--source', '/data/billme.sqlite', '--target', '/data/pglite', '--backup', '/safe/backup.sqlite',
  ], streams.io, async (options) => {
    captured.product = options.product;
    captured.tenant = options.tenant;
    return {
      targetDataDir: options.targetDataDir,
      backupPath: options.backupPath ?? '/safe/backup.sqlite',
      manifestPath: `${options.targetDataDir}/billme-pglite-migration.v1.json`,
      manifest: { product: options.product } as never,
    };
  });

  assert.equal(code, 0);
  assert.equal(captured.product, 'lite');
  assert.deepEqual(captured.tenant, {
    id: 'billme-local-tenant',
    slug: 'billme-local',
    displayName: 'Billme lokal',
  });
  assert.match(streams.output().stdout, /billme-pglite-migration\.v1\.json/);
  assert.equal(streams.output().stderr, '');
});

test('migration CLI returns useful nonzero errors without pretending activation succeeded', async () => {
  const streams = io();
  const code = await runMigrationCli(
    ['--product', 'lite', '--source', '/data/old.sqlite', '--target', '/data/existing-pglite'],
    streams.io,
    async () => { throw new Error('PGlite target already exists; refusing to overwrite: /data/existing-pglite'); },
  );

  assert.equal(code, 1);
  assert.match(streams.output().stderr, /already exists/);
  assert.equal(streams.output().stdout, '');
});

test('migration CLI prints help without requiring database paths', async () => {
  const streams = io();
  assert.equal(await runMigrationCli(['--help'], streams.io), 0);
  assert.match(streams.output().stdout, /--product <lite\|pro>/);
  assert.equal(streams.output().stderr, '');
});
