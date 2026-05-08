import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Pool } from 'pg';

export interface AppliedMigrationsResult {
  applied: string[];
  skipped: string[];
}

interface DrizzleJournalEntry {
  idx: number;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface DrizzleJournal {
  entries: DrizzleJournalEntry[];
}

interface DrizzleMigrationMeta {
  hash: string;
  sqlFile: string;
  tag: string;
  folderMillis: number;
}

const sourceDir = dirname(fileURLToPath(import.meta.url));
const drizzleMigrationsDir = join(sourceDir, '../../drizzle');
const drizzleJournalPath = join(drizzleMigrationsDir, 'meta', '_journal.json');
const drizzleMigrationsSchema = 'drizzle';
const drizzleMigrationsTable = '__drizzle_migrations';

const checksum = (value: string): string => createHash('sha256').update(value).digest('hex');

const ensureDrizzleMigrationsTable = async (pool: Pool): Promise<void> => {
  await pool.query(`CREATE SCHEMA IF NOT EXISTS ${drizzleMigrationsSchema}`);
  await pool.query(
    `
      CREATE TABLE IF NOT EXISTS ${drizzleMigrationsSchema}.${drizzleMigrationsTable} (
        id SERIAL PRIMARY KEY,
        hash TEXT NOT NULL,
        created_at BIGINT
      )
    `,
  );
};

const readDrizzleMigrationMeta = async (): Promise<DrizzleMigrationMeta[]> => {
  const journal = JSON.parse(await readFile(drizzleJournalPath, 'utf8')) as DrizzleJournal;
  return Promise.all(
    journal.entries
      .slice()
      .sort((left, right) => left.idx - right.idx)
      .map(async (entry) => {
        const sqlFile = `${entry.tag}.sql`;
        const sql = await readFile(join(drizzleMigrationsDir, sqlFile), 'utf8');
        return {
          hash: checksum(sql),
          sqlFile,
          tag: entry.tag,
          folderMillis: entry.when,
        } satisfies DrizzleMigrationMeta;
      }),
  );
};

const loadAppliedDrizzleMigrations = async (pool: Pool): Promise<Set<number>> => {
  await ensureDrizzleMigrationsTable(pool);
  const applied = await pool.query<{ created_at: string | number | null }>(
    `SELECT created_at FROM ${drizzleMigrationsSchema}.${drizzleMigrationsTable}`,
  );
  return new Set(
    applied.rows
      .map((row) => (row.created_at == null ? null : Number(row.created_at)))
      .filter((value): value is number => Number.isFinite(value)),
  );
};

const loadLegacyAppliedMigrationNames = async (pool: Pool): Promise<Set<string>> => {
  const tableLookup = await pool.query<{ table_name: string | null }>(
    `SELECT to_regclass('public.server_schema_migrations') AS table_name`,
  );
  if (!tableLookup.rows[0]?.table_name) {
    return new Set();
  }

  const legacyRows = await pool.query<{ name: string }>(
    'SELECT name FROM server_schema_migrations ORDER BY applied_at ASC, name ASC',
  );
  return new Set(legacyRows.rows.map((row) => row.name));
};

const hasExistingServerSchema = async (pool: Pool): Promise<boolean> => {
  const result = await pool.query<{ exists: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'tenants'
      ) AS exists
    `,
  );
  return result.rows[0]?.exists === true;
};

const adoptLegacyDrizzleMigrations = async (
  pool: Pool,
  migrations: DrizzleMigrationMeta[],
): Promise<Set<number>> => {
  const alreadyApplied = await loadAppliedDrizzleMigrations(pool);
  if (alreadyApplied.size > 0) {
    return new Set();
  }

  const legacyNames = await loadLegacyAppliedMigrationNames(pool);
  if (legacyNames.size === 0) {
    if (await hasExistingServerSchema(pool)) {
      throw new Error(
        'Existing server schema detected without migration history. Manual recovery is required before Drizzle migrations can continue.',
      );
    }
    return new Set();
  }

  const bySqlFile = new Map(migrations.map((migration) => [migration.sqlFile, migration] as const));
  const unknownLegacyNames = [...legacyNames].filter((name) => !bySqlFile.has(name));
  if (unknownLegacyNames.length > 0) {
    throw new Error(`Unsupported legacy migration history: ${unknownLegacyNames.join(', ')}`);
  }

  const adopted = new Set<number>();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const migration of migrations) {
      if (!legacyNames.has(migration.sqlFile)) {
        continue;
      }
      await client.query(
        `INSERT INTO ${drizzleMigrationsSchema}.${drizzleMigrationsTable} (hash, created_at) VALUES ($1, $2)`,
        [migration.hash, migration.folderMillis],
      );
      adopted.add(migration.folderMillis);
    }
    await client.query('COMMIT');
    return adopted;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors and rethrow original problem
    }
    throw error;
  } finally {
    client.release();
  }
};

export const runPostgresMigrations = async (pool: Pool): Promise<AppliedMigrationsResult> => {
  const migrations = await readDrizzleMigrationMeta();
  const previouslyApplied = await loadAppliedDrizzleMigrations(pool);
  const adopted = await adoptLegacyDrizzleMigrations(pool, migrations);

  const db = drizzle(pool);
  await migrate(db, {
    migrationsFolder: drizzleMigrationsDir,
  });

  const appliedAfterRun = await loadAppliedDrizzleMigrations(pool);
  const applied: string[] = [];
  const skipped: string[] = [];
  for (const migration of migrations) {
    if (!appliedAfterRun.has(migration.folderMillis)) {
      continue;
    }
    if (!previouslyApplied.has(migration.folderMillis) && !adopted.has(migration.folderMillis)) {
      applied.push(migration.sqlFile);
      continue;
    }
    skipped.push(migration.sqlFile);
  }

  return { applied, skipped };
};
