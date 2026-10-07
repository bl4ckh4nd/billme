import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Appends method, path and status of every request a suite sends to a local
 * server, whichever client sent it, to `test-results/integration/routes-<pid>.jsonl`.
 * `pnpm -C packages/integration-tests coverage` matches these against the
 * registered server routes. The fixtures import it for its side effect.
 */
const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test-results', 'integration');
const file = join(dir, `routes-${process.pid}.jsonl`);
const original = globalThis.fetch;
mkdirSync(dir, { recursive: true });

/** For clients that do not go through `fetch` (the portal fixture uses node:http). */
export const logRoute = (method: string, path: string, status: number, app: 'api' | 'portal' = 'api'): void => {
  appendFileSync(file, `${JSON.stringify({ app, method: method.toUpperCase(), path: path.split('?')[0], status })}\n`);
};

globalThis.fetch = async (input, init) => {
  const response = await original(input, init);
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
    logRoute(init?.method ?? (input instanceof Request ? input.method : 'GET'), url.pathname, response.status);
  }
  return response;
};
