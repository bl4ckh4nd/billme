import { serve } from '@hono/node-server';
import { z } from 'zod';
import { createApp } from './app';
import fs from 'fs';
import path from 'path';
import { createNodeFsPdfStore } from './storage/nodeFs';
import { createMemoryOfferStore, createMemoryPdfStore } from './storage/memory';

const envSchema = z.object({
  PORT: z.coerce.number().default(3001),
  HOST: z.string().default('127.0.0.1'),
  PUBLISH_API_KEY: z.string().min(1).optional(),
  REQUIRE_PUBLISH_API_KEY: z.coerce.boolean().optional(),
  PUBLIC_BASE_URL: z.string().optional(),
  DATABASE_PATH: z.string().default('./data/offer-portal.sqlite'),
  STORAGE_DIR: z.string().default('./storage'),
  STORAGE_MODE: z.enum(['sqlite', 'memory']).default('memory'),
});

const env = envSchema.parse(process.env);

const createStore = async () => {
  if (env.STORAGE_MODE === 'memory') return createMemoryOfferStore();

  fs.mkdirSync(path.dirname(env.DATABASE_PATH), { recursive: true });
  try {
    const mod = await import('./storage/nodeSqlite');
    return mod.createNodeSqliteOfferStore(env.DATABASE_PATH);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    throw new Error(
      `Failed to load SQLite storage backend (better-sqlite3).\n` +
        `This can happen if native modules were rebuilt for Electron.\n` +
        `Try rebuilding for Node, or set STORAGE_MODE=memory.\n\n` +
        `Underlying error: ${msg}`,
    );
  }
};

const store = await createStore();
const pdf = env.STORAGE_MODE === 'memory' ? createMemoryPdfStore() : createNodeFsPdfStore(env.STORAGE_DIR);

const app = createApp({
  store,
  pdf,
  config: {
    publishApiKey: env.PUBLISH_API_KEY,
    publicBaseUrl: env.PUBLIC_BASE_URL,
    requirePublishApiKey: env.REQUIRE_PUBLISH_API_KEY ?? process.env.NODE_ENV === 'production',
  },
});

serve({ fetch: app.fetch, port: env.PORT, hostname: env.HOST });
console.log(`offer-portal listening on http://${env.HOST}:${env.PORT}`);
