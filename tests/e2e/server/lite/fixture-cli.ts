import process from 'node:process';
import { createServerApiClient } from '@billme/server-core';
import { createPostgresPool, seedServerModeLiteTenant } from '@billme/server-data/postgres';

const USAGE = `Usage:
  pnpm exec tsx tests/e2e/server/lite/fixture-cli.ts ensure-lite-session \
    --api-base-url <url> \
    --email <email> \
    --password <password> \
    --full-name <name> \
    [--database-url <url>] \
    [--seed-namespace <namespace>]`;

const parseArgs = (argv: string[]) => {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg?.startsWith('--')) continue;
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`);
    }
    values.set(key, value);
    index += 1;
  }
  return values;
};

const requireArg = (args: Map<string, string>, key: string): string => {
  const value = args.get(key)?.trim();
  if (!value) {
    throw new Error(`Missing required argument --${key}`);
  }
  return value;
};

const summarizeLiteSeed = (seed: Awaited<ReturnType<typeof seedServerModeLiteTenant>>) => ({
  namespace: seed.namespace,
  tenantId: seed.tenantId,
  product: seed.product,
  settings: {
    numbers: seed.settings.numbers,
  },
  clients: seed.clients.map((client) => ({
    id: client.id,
    customerNumber: client.customerNumber,
    company: client.company,
  })),
  invoices: seed.invoices.map((invoice) => ({
    id: invoice.id,
    number: invoice.number,
    clientId: invoice.clientId,
    client: invoice.client,
    status: invoice.status,
  })),
  offers: seed.offers.map((offer) => ({
    id: offer.id,
    number: offer.number,
    clientId: offer.clientId,
    client: offer.client,
    status: offer.status,
  })),
  recurringProfiles: seed.recurringProfiles.map((profile) => ({
    id: profile.id,
    name: profile.name,
    clientId: profile.clientId,
  })),
});

const ensureLiteSession = async (args: Map<string, string>) => {
  const client = createServerApiClient(requireArg(args, 'api-base-url'));
  const session = await client.ensureSession({
    product: 'lite',
    email: requireArg(args, 'email'),
    password: requireArg(args, 'password'),
    fullName: requireArg(args, 'full-name'),
    setupToken: args.get('setup-token')?.trim() || undefined,
  });

  const databaseUrl = args.get('database-url')?.trim();
  const seedNamespace = args.get('seed-namespace')?.trim();
  let seed: ReturnType<typeof summarizeLiteSeed> | null = null;

  if (databaseUrl && seedNamespace) {
    const pool = createPostgresPool(databaseUrl);
    try {
      const seeded = await seedServerModeLiteTenant(pool, {
        tenantId: session.tenantId,
        namespace: seedNamespace,
      });
      seed = summarizeLiteSeed(seeded);
    } finally {
      await pool.end();
    }
  }

  return { session, seed };
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const args = parseArgs(rest);

  switch (command) {
    case 'ensure-lite-session': {
      process.stdout.write(`${JSON.stringify(await ensureLiteSession(args))}\n`);
      return;
    }
    default:
      throw new Error(`Unknown command: ${command}`);
  }
};

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
