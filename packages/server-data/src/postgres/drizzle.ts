import type { Pool, PoolClient } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

export type ServerDrizzleDb = NodePgDatabase<typeof schema>;
export type ServerDrizzleTransaction = Parameters<
  Parameters<ServerDrizzleDb["transaction"]>[0]
>[0];

export const createDrizzle = (client: Pool | PoolClient): ServerDrizzleDb =>
  drizzle(client, { schema });
export { schema };

export const tryCreateDrizzle = (client: {
  query: (...args: any[]) => any;
}): ServerDrizzleDb | null => {
  const candidate = client as unknown as {
    connect?: unknown;
    release?: unknown;
  };
  return typeof candidate.connect === "function" ||
    typeof candidate.release === "function"
    ? createDrizzle(client as PoolClient)
    : null;
};
