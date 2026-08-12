import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServerApiClient, type ServerProduct } from '@billme/server-core';
import { createPostgresPool, seedServerModeProTenant } from '@billme/server-data';

type HarnessState = {
  env?: Record<string, string>;
  envFile: string;
  ports: {
    postgres: number;
  };
  urls: {
    api: string;
  };
};

type ParsedArgs = {
  action: string;
  flags: Map<string, string>;
};

const parseArgs = (argv: string[]): ParsedArgs => {
  const [action = '', ...rest] = argv;
  const flags = new Map<string, string>();

  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith('--') || value === undefined) {
      throw new Error(`Invalid argument sequence: ${rest.join(' ')}`);
    }
    flags.set(key.slice(2), value);
  }

  return {
    action,
    flags,
  };
};

const requireFlag = (flags: Map<string, string>, name: string): string => {
  const value = flags.get(name)?.trim();
  if (!value) {
    throw new Error(`Missing required flag --${name}`);
  }
  return value;
};

const parseEnv = (content: string): Record<string, string> => {
  const values: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const separatorIndex = rawLine.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    const key = rawLine.slice(0, separatorIndex).trim();
    let value = rawLine.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
};

const readHarnessState = async (stateFile: string): Promise<HarnessState> => {
  const raw = await fs.readFile(stateFile, 'utf8');
  return JSON.parse(raw) as HarnessState;
};

const readHarnessEnv = async (state: HarnessState): Promise<Record<string, string>> => {
  if (state.env) {
    return state.env;
  }
  const raw = await fs.readFile(state.envFile, 'utf8');
  return parseEnv(raw);
};

const buildDatabaseUrl = (state: HarnessState, env: Record<string, string>): string => {
  const url = new URL('postgresql://127.0.0.1');
  url.port = String(state.ports.postgres);
  url.pathname = `/${env.BILLME_POSTGRES_DB ?? 'billme'}`;
  url.username = env.BILLME_POSTGRES_USER ?? 'billme';
  url.password = env.BILLME_POSTGRES_PASSWORD ?? 'billme';
  return url.toString();
};

export const ensureHarnessSession = async (options: {
  stateFile: string;
  product: ServerProduct;
  email: string;
  password: string;
  fullName: string;
}) => {
  const state = await readHarnessState(options.stateFile);
  const client = createServerApiClient(state.urls.api);
  return client.ensureSession({
    product: options.product,
    email: options.email,
    password: options.password,
    fullName: options.fullName,
  });
};

export const applyHarnessProSeed = async (options: {
  stateFile: string;
  tenantId: string;
  namespace: string;
  includeEurCashFixtures?: boolean;
}) => {
  const state = await readHarnessState(options.stateFile);
  const env = await readHarnessEnv(state);
  const pool = createPostgresPool(buildDatabaseUrl(state, env));

  try {
    const seed = await seedServerModeProTenant(pool, {
      tenantId: options.tenantId,
      namespace: options.namespace,
      includeEurCashFixtures: options.includeEurCashFixtures,
    });

    return {
      namespace: seed.namespace,
      tenantId: seed.tenantId,
      counts: {
        clients: seed.clients.length,
        invoices: seed.invoices.length,
        offers: seed.offers.length,
        recurringProfiles: seed.recurringProfiles.length,
        articles: seed.articles.length,
        accounts: seed.bankAccounts.length,
        templates: seed.templates.length,
        workflowEntries: seed.workflowEntries.length,
        taxCases: seed.taxCases.length,
        taxMappings: seed.taxCaseAccountMappings.length,
        suggestionRules: seed.accountSuggestionRules.length,
      },
    };
  } finally {
    await pool.end();
  }
};

const runCli = async () => {
  const { action, flags } = parseArgs(process.argv.slice(2));
  const stateFile = requireFlag(flags, 'state-file');

  if (action === 'ensure-session') {
    const product = requireFlag(flags, 'product') as ServerProduct;
    const session = await ensureHarnessSession({
      stateFile,
      product,
      email: requireFlag(flags, 'email'),
      password: requireFlag(flags, 'password'),
      fullName: requireFlag(flags, 'full-name'),
    });
    process.stdout.write(`${JSON.stringify(session)}\n`);
    return;
  }

  if (action === 'seed-pro') {
    const seed = await applyHarnessProSeed({
      stateFile,
      tenantId: requireFlag(flags, 'tenant-id'),
      namespace: requireFlag(flags, 'namespace'),
      includeEurCashFixtures: flags.get('include-eur-cash-fixtures') === 'true',
    });
    process.stdout.write(`${JSON.stringify(seed)}\n`);
    return;
  }

  throw new Error(`Unsupported action: ${action || '<empty>'}`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void runCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
