import { spawn } from 'node:child_process';
import { startPgliteWire } from './pglite-wire.js';

/**
 * Runs a command with `BILLME_TEST_DATABASE_URL` pointing at a fresh PGlite
 * behind the Postgres wire front, so suites written against a real Postgres
 * (`packages/server-data`) run in CI instead of being skipped.
 * Usage: node --import tsx with-pglite-wire.ts <command> [args...]
 */
const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error('usage: with-pglite-wire <command> [args...]');
  process.exit(2);
}
const wire = await startPgliteWire({ migrate: false });
const child = spawn(command, args, { stdio: 'inherit', shell: false, env: { ...process.env, BILLME_TEST_DATABASE_URL: wire.url } });
const code = await new Promise<number>((resolve) => child.on('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0))));
await wire.close();
process.exit(code);
