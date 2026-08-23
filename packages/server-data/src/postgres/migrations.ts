import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { PGlite } from "@electric-sql/pglite";
import { desc } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDrizzle, createPgliteDrizzle, schema } from "./drizzle.js";

export interface AppliedMigrationsResult {
  applied: string[];
  skipped: string[];
}

const isCanonicalMigrationDirectory = (candidate: string): boolean =>
  existsSync(join(candidate, "0000_server_data.sql")) &&
  existsSync(join(candidate, "meta", "_journal.json"));

const resolveCanonicalMigrationDirectory = (): string => {
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const candidates = [
    fileURLToPath(new URL("../../drizzle", import.meta.url)),
    ...(resourcesPath ? [join(resourcesPath, "drizzle")] : []),
    resolve(process.cwd(), "packages/server-data/drizzle"),
  ];
  const directory = candidates.find(isCanonicalMigrationDirectory);
  if (!directory) {
    throw new Error("Canonical server-data Drizzle migrations are not packaged");
  }
  return directory;
};

const drizzleMigrationsDir = resolveCanonicalMigrationDirectory();
const drizzleJournalPath = join(drizzleMigrationsDir, "meta", "_journal.json");
const migrationLockId = 4_825_167_391;

const readCanonicalMigrationState = async (): Promise<number> => {
  const journal = JSON.parse(await readFile(drizzleJournalPath, "utf8")) as {
    entries?: Array<{ when?: number }>;
  };
  const latest = Math.max(...(journal.entries ?? []).map((entry) => Number(entry.when ?? 0)));
  if (!Number.isFinite(latest) || latest <= 0) {
    throw new Error("Canonical Drizzle migration journal is empty or invalid");
  }
  return latest;
};

type MigrationTarget = Pool | PGlite;

const isPglite = (target: MigrationTarget): target is PGlite =>
  target instanceof PGlite;

const runPgliteMigrations = async (client: PGlite): Promise<void> => {
  const migrations = readMigrationFiles({ migrationsFolder: drizzleMigrationsDir });

  // PGlite's prepared-query protocol intentionally rejects a string that
  // contains multiple SQL commands. Canonical Drizzle files contain those
  // commands by design, so use PGlite's simple-query `exec` for each migration
  // statement while retaining Drizzle's journal and SHA-256 bookkeeping.
  await client.exec(`
    CREATE SCHEMA IF NOT EXISTS drizzle;
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    );
  `);

  const applied = await client.query<{ created_at: number | string }>(
    'SELECT created_at FROM drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1',
  );
  const lastApplied = applied.rows[0];

  await client.transaction(async (transaction) => {
    for (const migration of migrations) {
      if (lastApplied && Number(lastApplied.created_at) >= migration.folderMillis) continue;

      for (const statement of migration.sql) {
        await transaction.exec(statement);
      }
      await transaction.query(
        'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
        [migration.hash, migration.folderMillis],
      );
    }
  });
};

/** Apply canonical Drizzle Kit migrations for a newly provisioned database. */
export const runDrizzleMigrations = async (target: MigrationTarget): Promise<void> => {
  if (isPglite(target)) {
    await target.waitReady;
    await runPgliteMigrations(target);
    return;
  }

  const pool = target;
  const client = await pool.connect();
  try {
    // Drizzle's migrator is transactional, but concurrent first boots can
    // race while creating the migration schema/table. Serialize that lifecycle
    // operation across API, worker, CLI, and test processes.
    await client.query("SELECT pg_advisory_lock($1)", [migrationLockId]);
    try {
      await migrate(createDrizzle(client), { migrationsFolder: drizzleMigrationsDir });
    } finally {
      // Always release the session-level lock before returning the client to
      // the pool. Otherwise a failed migration could strand the lock on a
      // pooled connection and block every subsequent migrator indefinitely.
      await client.query("SELECT pg_advisory_unlock($1)", [migrationLockId]);
    }
  } finally {
    client.release();
  }
};

/** Fail closed when an API/worker process starts before the one-shot migrator. */
export const assertDrizzleSchemaCurrent = async (target: MigrationTarget): Promise<void> => {
  try {
    const canonicalLatest = await readCanonicalMigrationState();
    const database = isPglite(target) ? createPgliteDrizzle(target) : createDrizzle(target);
    const result = await database.select({ createdAt: schema.drizzleMigrations.createdAt })
      .from(schema.drizzleMigrations).orderBy(desc(schema.drizzleMigrations.createdAt)).limit(1);
    const latest = Number(result[0]?.createdAt ?? 0);
    if (latest < canonicalLatest) {
      throw new Error(`Database schema is behind the current Drizzle journal (latest=${latest}, required=${canonicalLatest}). Run the server-data migrate command before starting API/worker.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Database schema is behind')) throw error;
    throw new Error('Database schema is not initialized by the Drizzle migrator. Run the server-data migrate command before starting API/worker.', { cause: error });
  }
};

export const runPostgresMigrations = async (
  pool: Pool,
): Promise<AppliedMigrationsResult> => {
  // Keep the historical export name for callers, but Drizzle is now the sole
  // migration authority. Its journal tracks applied hashes atomically.
  await runDrizzleMigrations(pool);
  return { applied: [], skipped: [] };
};
