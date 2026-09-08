import type Database from "better-sqlite3";
import {
  drizzle,
  type BetterSQLite3Database,
} from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";

export type DesktopDrizzleDb = BetterSQLite3Database<typeof schema>;

export const createDrizzle = (db: Database.Database): DesktopDrizzleDb =>
  drizzle(db, { schema });
export { schema };
export * from "./schema";
