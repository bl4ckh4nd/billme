/**
 * Read-only bridge for the immutable, externally supplied SKR SQLite file.
 * The source schema is not Billme-owned, so its dynamic table metadata cannot
 * be represented by the application schema. No destination writes cross this seam.
 */
import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sql } from 'drizzle-orm';

export const createLegacySqliteReadBridge = (db: Database.Database) => {
  const source = drizzle(db);
  return {
    all<T = unknown>(statement: string): T[] {
      return source.all(sql.raw(statement)) as T[];
    },
  };
};
