import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPgliteServerDatabase } from '@billme/server-data';
import { buildServerApi } from '../../server-runtime/src/app.js';
import { createApp } from '../../../apps/offer-portal/src/app.js';
import { createMemoryOfferStore, createMemoryPdfStore } from '../../../apps/offer-portal/src/storage/memory.js';
import { startPgliteWire } from './pglite-wire.js';
import { fastifyRoutes, routeMatcher, type Route } from './routes.js';

/**
 * Which registered routes did no suite reach? Run after `pnpm test`: boots the
 * hosted API, the embedded Lite and Pro APIs and the offer portal, reads their
 * route tables and matches them against `routes-<pid>.jsonl` (see route-log.ts).
 * Writes `test-results/integration/route-coverage.json`; exits 1 while a route
 * has no request at all.
 */
const resultsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'test-results', 'integration');
const SECRET = 'integration-session-secret-0123456789abcdef';

const apiRoutes = async (): Promise<Route[]> => {
  const trees: string[] = [];
  const wire = await startPgliteWire({ migrate: true });
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = wire.url;
  try {
    const hosted = await buildServerApi({ runtime: 'server', logger: false, sessionSecret: SECRET });
    await hosted.ready();
    trees.push(hosted.printRoutes({ commonPrefix: false }));
    await hosted.close();
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
    await wire.close();
  }
  for (const product of ['lite', 'pro'] as const) {
    const dataDir = await mkdtemp(join(tmpdir(), `billme-routes-${product}-`));
    const embedded = await buildServerApi({
      runtime: 'embedded', product, logger: false, sessionSecret: SECRET,
      database: await createPgliteServerDatabase(dataDir),
      localAuth: { accessToken: 'route-coverage-token-0123456789abcdef', userId: 'u', email: 'routes@example.com', fullName: 'Routes', tenantId: 't' },
    });
    await embedded.ready();
    trees.push(embedded.printRoutes({ commonPrefix: false }));
    await embedded.close();
    await rm(dataDir, { recursive: true, force: true });
  }
  const unique = new Map<string, Route>();
  for (const route of trees.flatMap(fastifyRoutes)) unique.set(`${route.method} ${route.path}`, route);
  return [...unique.values()];
};

const portalRoutes = (): Route[] => {
  const app = createApp({ store: createMemoryOfferStore(), pdf: createMemoryPdfStore(), config: { publishApiKey: 'x'.repeat(32) } as never });
  const unique = new Map<string, Route>();
  for (const route of app.routes) {
    if (route.method === 'ALL') continue;
    unique.set(`${route.method} ${route.path}`, { app: 'portal', method: route.method, path: route.path });
  }
  return [...unique.values()];
};

const main = async () => {
  const routes = [...await apiRoutes(), ...portalRoutes()].map((route) => ({ ...route, re: routeMatcher(route.path), statuses: new Set<number>() }));
  for (const name of (await readdir(resultsDir)).filter((file) => /^routes-\d+\.jsonl$/.test(file))) {
    for (const line of (await readFile(join(resultsDir, name), 'utf8')).split('\n')) {
      if (!line) continue;
      const hit = JSON.parse(line) as { app: Route['app']; method: string; path: string; status: number };
      // Static routes first: `/journal/:id` must not swallow a request for `/journal/stats`.
      const candidates = routes.filter((route) => route.app === hit.app && route.method === hit.method && route.re.test(hit.path));
      const route = candidates.find((candidate) => !candidate.path.includes(':')) ?? candidates[0];
      route?.statuses.add(hit.status);
    }
  }
  const report = routes.map(({ app, method, path, statuses }) => ({ app, method, path, statuses: [...statuses].sort() }));
  const uncovered = report.filter((route) => route.statuses.length === 0);
  const withoutRefusal = report.filter((route) => route.statuses.length > 0 && !route.statuses.some((status) => status >= 400 && status < 500));
  await writeFile(join(resultsDir, 'route-coverage.json'), `${JSON.stringify({ routes: report.length, uncovered, withoutRefusal, report }, null, 2)}\n`);
  console.log(`${report.length} routes, ${uncovered.length} never requested, ${withoutRefusal.length} without a 4xx case`);
  for (const route of uncovered) console.log(`  never requested: ${route.app} ${route.method} ${route.path}`);
  process.exit(uncovered.length ? 1 : 0);
};

await main();
