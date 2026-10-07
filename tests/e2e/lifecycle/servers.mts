import { startHostedServer } from '../../../packages/integration-tests/src/server-fixtures.ts';

/**
 * Two real hosted APIs (Fastify + PGlite behind the Postgres wire) for the
 * browser-shell lifecycle specs: server A on 4191, server B on 4192, each with a
 * bootstrapped Lite and Pro owner and saved settings. Started by Playwright's webServer.
 */
export const LIFECYCLE_PASSWORD = 'billme-server-123';
for (const [name, port] of [['a', 4191], ['b', 4192]] as const) {
  const server = await startHostedServer(`lifecycle-${name}`, { port });
  for (const product of ['lite', 'pro'] as const) {
    const owner = await server.bootstrap(product, `owner-${product}@example.com`, `Owner ${product}`);
    await server.putSettings(product, owner.token);
  }
}
console.log('lifecycle servers ready');
setInterval(() => undefined, 1 << 30);
