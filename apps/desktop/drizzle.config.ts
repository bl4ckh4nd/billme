import type { Config } from 'drizzle-kit';

export default {
  schema: './db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  // Migration generation is used for CI and reproducible DB setup.
  // Runtime in Electron will apply migrations or (currently) use bootstrap SQL.
  dbCredentials: {
    url: './dist/dev.sqlite',
  },
} satisfies Config;

