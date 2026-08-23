import {
  migrateSqliteToPglite,
  type PgliteMigrationManifest,
  type PgliteMigrationResult,
} from '@billme/server-data/pglite';
import type { ServerProduct } from '@billme/server-core';

export type MigrationCliIo = {
  readonly stdout: { write: (chunk: string) => unknown };
  readonly stderr: { write: (chunk: string) => unknown };
};

export type MigrationCliOptions = {
  readonly product: ServerProduct;
  readonly sourcePath: string;
  readonly targetDataDir: string;
  readonly backupPath?: string;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly tenantName: string;
};

export type MigrationRunner = (options: {
  sourcePath: string;
  targetDataDir: string;
  product: ServerProduct;
  tenant: { id: string; slug: string; displayName: string };
  backupPath?: string;
}) => Promise<PgliteMigrationResult>;

export const HELP_TEXT = `billme-pglite-migrate --product <lite|pro> --source <sqlite-file> --target <pglite-dir> [options]

Migrates one existing Billme SQLite database into a new embedded PGlite directory.
The SQLite source is never removed. A consistent backup is retained next to the target.

Options:
  --product <lite|pro>       Source/product schema (required)
  --source <path>            Existing SQLite database (required)
  --target <directory>       New PGlite directory (required; must not exist)
  --backup <path>            Explicit backup destination (must not exist)
  --tenant-id <id>           Imported local tenant id
  --tenant-slug <slug>       Imported local tenant slug
  --tenant-name <name>       Imported local tenant display name
  --help                     Show this help
`;

class UsageError extends Error {}

const valueFor = (argv: string[], index: number, key: string): string => {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new UsageError(`Missing value for ${key}.`);
  return value;
};

export const parseMigrationArgs = (argv: readonly string[]): MigrationCliOptions | { help: true } => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (!argument?.startsWith('--')) throw new UsageError(`Unexpected argument: ${argument ?? ''}`);
    const equals = argument.indexOf('=');
    if (equals >= 0) {
      const key = argument.slice(2, equals);
      const value = argument.slice(equals + 1);
      if (!value) throw new UsageError(`Missing value for --${key}.`);
      values.set(key, value);
      continue;
    }
    const key = argument.slice(2);
    values.set(key, valueFor(argv as string[], index, `--${key}`));
    index += 1;
  }
  const product = values.get('product');
  if (product !== 'lite' && product !== 'pro') throw new UsageError('--product must be lite or pro.');
  const sourcePath = values.get('source');
  const targetDataDir = values.get('target');
  if (!sourcePath) throw new UsageError('--source is required.');
  if (!targetDataDir) throw new UsageError('--target is required.');
  const defaults = product === 'pro'
    ? { tenantId: 'billme-pro-local-tenant', tenantSlug: 'billme-pro-local', tenantName: 'Billme Pro lokal' }
    : { tenantId: 'billme-local-tenant', tenantSlug: 'billme-local', tenantName: 'Billme lokal' };
  return {
    product,
    sourcePath,
    targetDataDir,
    backupPath: values.get('backup'),
    tenantId: values.get('tenant-id') ?? defaults.tenantId,
    tenantSlug: values.get('tenant-slug') ?? defaults.tenantSlug,
    tenantName: values.get('tenant-name') ?? defaults.tenantName,
  };
};

const realMigrationRunner: MigrationRunner = async (options) => migrateSqliteToPglite(options);

export const runMigrationCli = async (
  argv: readonly string[],
  io: MigrationCliIo = { stdout: process.stdout, stderr: process.stderr },
  runMigration: MigrationRunner = realMigrationRunner,
): Promise<number> => {
  try {
    const parsed = parseMigrationArgs(argv);
    if ('help' in parsed) {
      io.stdout.write(HELP_TEXT);
      return 0;
    }
    const result = await runMigration({
      sourcePath: parsed.sourcePath,
      targetDataDir: parsed.targetDataDir,
      backupPath: parsed.backupPath,
      product: parsed.product,
      tenant: { id: parsed.tenantId, slug: parsed.tenantSlug, displayName: parsed.tenantName },
    });
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof UsageError ? 2 : 1;
    io.stderr.write(`billme-pglite-migrate: ${message}\n`);
    if (code === 2) io.stderr.write(`\n${HELP_TEXT}`);
    return code;
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runMigrationCli(process.argv.slice(2));
}

export type { PgliteMigrationManifest };
