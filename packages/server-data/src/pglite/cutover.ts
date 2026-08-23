import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type { ServerProduct, Tenant } from '@billme/server-core';
import type { ServerDatabase } from '../database.js';
import {
  importDesktopSqliteToServerDatabase,
  type DesktopSqliteImportOptions,
  type DesktopSqliteImportResult,
} from '../postgres/importDesktop.js';

export const PGLITE_MIGRATION_MANIFEST_FILE = 'billme-pglite-migration.v1.json';
export const PGLITE_MIGRATION_MANIFEST_VERSION = 1 as const;

type Sha256 = string;

export interface PgliteMigrationManifest {
  readonly version: typeof PGLITE_MIGRATION_MANIFEST_VERSION;
  readonly origin: 'sqlite-migration';
  readonly product: ServerProduct;
  readonly tenant: Pick<Tenant, 'id' | 'slug' | 'displayName'>;
  readonly source: { readonly path: string; readonly sha256: Sha256 };
  readonly backup: { readonly path: string; readonly sha256: Sha256 };
  readonly importRunId: string;
  readonly counts: Record<string, number>;
  readonly completedAt: string;
}

export interface PgliteMigrationResult {
  readonly targetDataDir: string;
  readonly backupPath: string;
  readonly manifestPath: string;
  readonly manifest: PgliteMigrationManifest;
}

export interface PgliteMigrationOptions {
  readonly sourcePath: string;
  readonly targetDataDir: string;
  readonly product: ServerProduct;
  readonly tenant: Pick<Tenant, 'id' | 'slug' | 'displayName'>;
  /** Optional explicit backup destination. It must not already exist. */
  readonly backupPath?: string;
  readonly now?: () => string;
  readonly openSqlite?: (sqlitePath: string) => Database.Database | Promise<Database.Database>;
  readonly backupSqlite?: (database: Database.Database, destinationPath: string) => Promise<void>;
  readonly createDatabase?: (dataDir: string) => Promise<ServerDatabase>;
  readonly importSqlite?: (options: DesktopSqliteImportOptions) => Promise<DesktopSqliteImportResult>;
}

const defaultOpenSqlite = async (sqlitePath: string): Promise<Database.Database> => {
  const module = await import('better-sqlite3');
  const Sqlite = module.default as unknown as new (
    path: string,
    options?: { readonly?: boolean; fileMustExist?: boolean },
  ) => Database.Database;
  return new Sqlite(sqlitePath, { readonly: true, fileMustExist: true });
};

const defaultBackupSqlite = async (database: Database.Database, destinationPath: string): Promise<void> => {
  const backup = (database as Database.Database & { backup?: (path: string) => Promise<unknown> }).backup;
  if (typeof backup !== 'function') throw new Error('SQLite driver does not support consistent backups');
  await backup.call(database, destinationPath);
};

const defaultCreateDatabase = async (dataDir: string): Promise<ServerDatabase> => {
  const { createPgliteServerDatabase } = await import('./database.js');
  return createPgliteServerDatabase(dataDir);
};

const defaultNow = (): string => new Date().toISOString();

const sha256File = async (path: string): Promise<Sha256> =>
  createHash('sha256').update(await readFile(path)).digest('hex');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseCounts = (value: unknown): Record<string, number> | null => {
  if (!isRecord(value)) return null;
  const counts: Record<string, number> = {};
  for (const [key, count] of Object.entries(value)) {
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return null;
    counts[key] = count;
  }
  return counts;
};

const assertImportCompleted = async (
  database: ServerDatabase,
  result: DesktopSqliteImportResult,
): Promise<void> => {
  const run = await database.query<{ status: string; details_json: string | null }>(
    'SELECT status, details_json FROM sqlite_import_runs WHERE id = $1',
    [result.importRunId],
  );
  if (run.rows.length !== 1 || run.rows[0]?.status !== 'completed') {
    throw new Error(`SQLite import run ${result.importRunId} did not complete`);
  }
  const details = run.rows[0]?.details_json ? JSON.parse(run.rows[0].details_json) as unknown : null;
  if (!isRecord(details)) throw new Error(`SQLite import run ${result.importRunId} has no details`);
  const persistedCounts = parseCounts(details.counts);
  if (!persistedCounts) throw new Error(`SQLite import run ${result.importRunId} has invalid counts`);
  for (const [key, expected] of Object.entries(result.counts)) {
    if (persistedCounts[key] !== expected) {
      throw new Error(`SQLite import run ${result.importRunId} count mismatch for ${key}`);
    }
  }
}

const writeManifestAtomically = async (
  directory: string,
  manifest: PgliteMigrationManifest,
): Promise<string> => {
  const manifestPath = resolve(directory, PGLITE_MIGRATION_MANIFEST_FILE);
  const temporaryPath = resolve(directory, `.${PGLITE_MIGRATION_MANIFEST_FILE}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temporaryPath, manifestPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return manifestPath;
};

const quarantine = async (directory: string): Promise<void> => {
  if (!existsSync(directory)) return;
  await rename(directory, `${directory}.failed-${randomUUID()}`).catch(() => undefined);
};

const defaultBackupPath = (sourcePath: string, targetDataDir: string, migrationId: string): string =>
  resolve(dirname(targetDataDir), 'backups', `${basename(sourcePath)}.pglite-${migrationId}.sqlite`);

/**
 * One-shot SQLite -> PGlite cutover shared by the desktop migration and the
 * standalone migration CLI. The target is staged, verified, and activated by
 * one final directory rename. The source and its consistent backup survive.
 */
export const migrateSqliteToPglite = async (
  options: PgliteMigrationOptions,
): Promise<PgliteMigrationResult> => {
  const sourcePath = resolve(options.sourcePath);
  const targetDataDir = resolve(options.targetDataDir);
  if (!existsSync(sourcePath)) throw new Error(`SQLite source does not exist: ${sourcePath}`);
  if (existsSync(targetDataDir)) {
    throw new Error(`PGlite target already exists; refusing to overwrite: ${targetDataDir}`);
  }
  const migrationId = randomUUID();
  const backupPath = resolve(options.backupPath ?? defaultBackupPath(sourcePath, targetDataDir, migrationId));
  if (existsSync(backupPath)) throw new Error(`Backup target already exists; refusing to overwrite: ${backupPath}`);
  const stagingDirectory = `${targetDataDir}.staging-${migrationId}`;
  const backup = options.backupSqlite ?? defaultBackupSqlite;
  const openSqlite = options.openSqlite ?? defaultOpenSqlite;
  const createDatabase = options.createDatabase ?? defaultCreateDatabase;
  const importSqlite = options.importSqlite ?? importDesktopSqliteToServerDatabase;
  let sourceDatabase: Database.Database | undefined;
  let database: ServerDatabase | undefined;
  let activated = false;

  try {
    await mkdir(dirname(targetDataDir), { recursive: true });
    await mkdir(dirname(backupPath), { recursive: true });
    sourceDatabase = await openSqlite(sourcePath);
    const sourceSha256 = await sha256File(sourcePath);
    await backup(sourceDatabase, backupPath);
    const backupSha256 = await sha256File(backupPath);
    sourceDatabase.close();
    sourceDatabase = undefined;
    if (sourceSha256 !== await sha256File(sourcePath)) {
      throw new Error('SQLite source changed while the backup was being created; activation aborted');
    }

    await mkdir(stagingDirectory, { recursive: false });
    database = await createDatabase(stagingDirectory);
    const result = await importSqlite({
      database,
      sqlitePath: backupPath,
      product: options.product,
      tenant: options.tenant,
    });
    await assertImportCompleted(database, result);
    const manifest: PgliteMigrationManifest = {
      version: PGLITE_MIGRATION_MANIFEST_VERSION,
      origin: 'sqlite-migration',
      product: options.product,
      tenant: options.tenant,
      source: { path: sourcePath, sha256: sourceSha256 },
      backup: { path: backupPath, sha256: backupSha256 },
      importRunId: result.importRunId,
      counts: { ...result.counts },
      completedAt: (options.now ?? defaultNow)(),
    };
    await writeManifestAtomically(stagingDirectory, manifest);
    await database.close();
    database = undefined;
    if (existsSync(targetDataDir)) {
      throw new Error(`PGlite target appeared during migration; refusing to replace: ${targetDataDir}`);
    }
    await rename(stagingDirectory, targetDataDir);
    activated = true;
    return {
      targetDataDir,
      backupPath,
      manifestPath: resolve(targetDataDir, PGLITE_MIGRATION_MANIFEST_FILE),
      manifest,
    };
  } catch (error) {
    if (sourceDatabase) {
      try { sourceDatabase.close(); } catch { /* keep the original error */ }
    }
    if (database) {
      try { await database.close(); } catch { /* keep the original error */ }
    }
    if (!activated) await quarantine(stagingDirectory);
    throw error;
  }
};
