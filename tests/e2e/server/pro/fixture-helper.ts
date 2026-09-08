import fs from 'node:fs/promises';
import { randomUUID, scryptSync } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getCatalogForYear, getCatalogManifestForYear } from '@billme/desktop-services/eurCatalog';
import { createServerApiClient, type ServerProduct } from '@billme/server-core';
import { createPostgresPool, saveServerEurLine, seedServerModeProTenant } from '@billme/server-data';

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

export const createHarnessProTenant = async (options: {
  stateFile: string;
  email: string;
  password: string;
  fullName: string;
}) => {
  const state = await readHarnessState(options.stateFile);
  const env = await readHarnessEnv(state);
  const pool = createPostgresPool(buildDatabaseUrl(state, env));
  const tenantId = randomUUID();
  const userId = randomUUID();
  const membershipId = randomUUID();
  const salt = randomUUID().replaceAll('-', '');
  const now = new Date().toISOString();
  try {
    await pool.query('BEGIN');
    await pool.query(
      `INSERT INTO tenants (id,slug,display_name,product,deployment_mode,status,created_at,updated_at)
       VALUES ($1,$2,$3,'pro','single-tenant','active',$4,$4)`,
      [tenantId, `pro-e2e-${tenantId}`, 'Billme Pro isolated E2E tenant', now],
    );
    await pool.query(
      `INSERT INTO user_accounts (id,email,full_name,status,created_at,updated_at) VALUES ($1,$2,$3,'active',$4,$4)`,
      [userId, options.email, options.fullName, now],
    );
    await pool.query(
      `INSERT INTO tenant_memberships (id,tenant_id,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,'owner',$4,$4)`,
      [membershipId, tenantId, userId, now],
    );
    await pool.query(
      `INSERT INTO user_password_credentials (user_id,password_salt,password_hash,password_algorithm,created_at,updated_at) VALUES ($1,$2,$3,'scrypt-64',$4,$4)`,
      [userId, salt, scryptSync(options.password, salt, 64).toString('hex'), now],
    );
    await pool.query('COMMIT');
    return { tenantId, userId };
  } catch (error) {
    await pool.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }
};

export const applyHarnessProSeed = async (options: {
  stateFile: string;
  tenantId: string;
  namespace: string;
  includeEurCashFixtures?: boolean;
  includeEurCatalog2026?: boolean;
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
    if (options.includeEurCatalog2026) {
      const manifest = getCatalogManifestForYear(2026);
      const createdAt = new Date().toISOString();
      for (const [sortOrder, line] of getCatalogForYear(2026).entries()) {
        await saveServerEurLine(pool, {
          id: line.id,
          taxYear: 2026,
          kennziffer: line.kennziffer || undefined,
          providerPath: line.providerPath,
          label: line.label,
          kind: line.kind,
          exportable: line.exportable,
          sortOrder,
          computedFromJson: line.computedFromIds?.length ? JSON.stringify(line.computedFromIds) : undefined,
          computedTermsJson: line.computedTerms?.length ? JSON.stringify(line.computedTerms) : undefined,
          sourceVersion: manifest.version,
          createdAt,
          updatedAt: createdAt,
        });
      }
    }

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

export const setHarnessProPeriodStatus = async (options: {
  stateFile: string;
  tenantId: string;
  period: string;
  status: 'open' | 'soft_locked' | 'closed';
}) => {
  const state = await readHarnessState(options.stateFile);
  const env = await readHarnessEnv(state);
  const pool = createPostgresPool(buildDatabaseUrl(state, env));
  try {
    const timestamp = new Date().toISOString();
    const start = `${options.period}-01`;
    const end = new Date(Date.UTC(Number(options.period.slice(0, 4)), Number(options.period.slice(5, 7)), 0))
      .toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO accounting_periods (id,tenant_id,period,fiscal_year,status,starts_at,ends_at,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
       ON CONFLICT (tenant_id,period) DO UPDATE SET status=EXCLUDED.status,updated_at=EXCLUDED.updated_at`,
      [randomUUID(), options.tenantId, options.period, Number(options.period.slice(0, 4)), options.status, start, end, timestamp],
    );
    return { tenantId: options.tenantId, period: options.period, status: options.status };
  } finally {
    await pool.end();
  }
};

export const setHarnessProBankTransactionStatus = async (options: {
  stateFile: string;
  tenantId: string;
  transactionId: string;
  status: 'pending' | 'booked';
}) => {
  const state = await readHarnessState(options.stateFile);
  const env = await readHarnessEnv(state);
  const pool = createPostgresPool(buildDatabaseUrl(state, env));
  try {
    const result = await pool.query(
      `UPDATE bank_transactions
       SET status=$1,linked_invoice_id=NULL,updated_at=$2
       WHERE tenant_id=$3 AND id=$4
       RETURNING id,status,linked_invoice_id`,
      [options.status, new Date().toISOString(), options.tenantId, options.transactionId],
    );
    if (!result.rows[0]) throw new Error(`Bank transaction not found: ${options.transactionId}`);
    return result.rows[0];
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

  if (action === 'create-pro-tenant') {
    const created = await createHarnessProTenant({
      stateFile,
      email: requireFlag(flags, 'email'),
      password: requireFlag(flags, 'password'),
      fullName: requireFlag(flags, 'full-name'),
    });
    process.stdout.write(`${JSON.stringify(created)}\n`);
    return;
  }

  if (action === 'seed-pro') {
    const seed = await applyHarnessProSeed({
      stateFile,
      tenantId: requireFlag(flags, 'tenant-id'),
      namespace: requireFlag(flags, 'namespace'),
      includeEurCashFixtures: flags.get('include-eur-cash-fixtures') === 'true',
      includeEurCatalog2026: flags.get('include-eur-catalog-2026') === 'true',
    });
    process.stdout.write(`${JSON.stringify(seed)}\n`);
    return;
  }

  if (action === 'set-pro-period-status') {
    const result = await setHarnessProPeriodStatus({
      stateFile,
      tenantId: requireFlag(flags, 'tenant-id'),
      period: requireFlag(flags, 'period'),
      status: requireFlag(flags, 'status') as 'open' | 'soft_locked' | 'closed',
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (action === 'set-pro-bank-transaction-status') {
    const result = await setHarnessProBankTransactionStatus({
      stateFile,
      tenantId: requireFlag(flags, 'tenant-id'),
      transactionId: requireFlag(flags, 'transaction-id'),
      status: requireFlag(flags, 'status') as 'pending' | 'booked',
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
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
