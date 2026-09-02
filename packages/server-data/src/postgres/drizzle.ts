import type { Pool, PoolClient } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle as pgliteDrizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "./schema";

export type ServerDrizzleDb = NodePgDatabase<typeof schema>;
export type ServerDrizzleTransaction = Parameters<
  Parameters<ServerDrizzleDb["transaction"]>[0]
>[0];
export type ServerPgliteDrizzleDb = PgliteDatabase<typeof schema>;

type PgliteDrizzleTarget = PGlite | {
  query: (...args: any[]) => any;
  exec: (...args: any[]) => any;
};

type AdapterDrizzleTarget = {
  query: (...args: any[]) => any;
  drizzle?: () => unknown;
};

const isPgliteDrizzleTarget = (
  client: Pool | PoolClient | PgliteDrizzleTarget | AdapterDrizzleTarget,
): client is PgliteDrizzleTarget =>
  typeof (client as { exec?: unknown }).exec === 'function' &&
  typeof (client as { release?: unknown }).release !== 'function';

export const createPgliteDrizzle = (client: PGlite): ServerPgliteDrizzleDb =>
  pgliteDrizzle(client, { schema });

/** Create the matching Drizzle dialect for PostgreSQL or a PGlite session. */
export const createDrizzle = (
  client: Pool | PoolClient | PgliteDrizzleTarget | AdapterDrizzleTarget,
): ServerDrizzleDb => {
  const adapterDrizzle = (client as AdapterDrizzleTarget).drizzle;
  if (typeof adapterDrizzle === 'function') {
    return adapterDrizzle.call(client) as ServerDrizzleDb;
  }
  return isPgliteDrizzleTarget(client)
    ? createPgliteDrizzle(client as PGlite) as unknown as ServerDrizzleDb
    : drizzle(client as Pool | PoolClient, { schema });
};

export { schema };

export const tryCreateDrizzle = (client: {
  query: (...args: any[]) => any;
}): ServerDrizzleDb | null => {
  const candidate = client as unknown as {
    connect?: unknown;
    release?: unknown;
    engine?: unknown;
    client?: PGlite;
    drizzle?: () => unknown;
  };
  if (typeof candidate.drizzle === 'function') {
    return candidate.drizzle() as ServerDrizzleDb;
  }
  if (candidate.engine === 'pglite' && candidate.client) {
    return createPgliteDrizzle(candidate.client) as unknown as ServerDrizzleDb;
  }
  if (typeof (candidate as { exec?: unknown }).exec === 'function' && typeof candidate.release !== 'function') {
    return createPgliteDrizzle(client as unknown as PGlite) as unknown as ServerDrizzleDb;
  }
  return typeof candidate.connect === "function" ||
    typeof candidate.release === "function"
    ? createDrizzle(client as PoolClient)
    : null;
};
