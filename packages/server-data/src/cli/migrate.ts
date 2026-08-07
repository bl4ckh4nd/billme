import { createPostgresPool, readDatabaseUrl, runDrizzleMigrations } from '../postgres';

const databaseUrl = readDatabaseUrl(process.env);
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}

const pool = createPostgresPool(databaseUrl);
try {
  await runDrizzleMigrations(pool);
  console.log(JSON.stringify({ status: 'migrated' }, null, 2));
} finally {
  await pool.end();
}
