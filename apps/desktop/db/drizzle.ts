import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

export const createDrizzle = (db: Database.Database) => {
  return drizzle(db);
};

