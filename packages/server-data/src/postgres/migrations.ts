import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { desc } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDrizzle, schema } from "./drizzle.js";

export interface AppliedMigrationsResult {
  applied: string[];
  skipped: string[];
}

const drizzleMigrationsDir = new URL("../../drizzle", import.meta.url).pathname;
const drizzleJournalPath = fileURLToPath(
  new URL("../../drizzle/meta/_journal.json", import.meta.url),
);
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

/** Apply canonical Drizzle Kit migrations for a newly provisioned database. */
export const runDrizzleMigrations = async (pool: Pool): Promise<void> => {
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
export const assertDrizzleSchemaCurrent = async (pool: Pool): Promise<void> => {
  try {
    const canonicalLatest = await readCanonicalMigrationState();
    const result = await createDrizzle(pool).select({ createdAt: schema.drizzleMigrations.createdAt })
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
