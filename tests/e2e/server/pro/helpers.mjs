import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRO_SESSION_STORAGE_KEY = 'billme.web-pro.session.v1';
export const PRO_API_URL_STORAGE_KEY = 'billme.web-pro.api-url.v1';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const fixtureHelperPath = path.join(repoRoot, 'tests/e2e/server/pro/fixture-helper.ts');

const runFixtureHelper = async (args) =>
  await new Promise((resolve, reject) => {
    execFile(
      'node',
      ['--import', 'tsx', fixtureHelperPath, ...args],
      {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          error.stdout = stdout;
          reject(error);
          return;
        }

        const payload = stdout.trim();
        if (!payload) {
          reject(new Error(`Fixture helper returned no JSON output.${stderr ? ` ${stderr.trim()}` : ''}`.trim()));
          return;
        }

        try {
          resolve(JSON.parse(payload));
        } catch (parseError) {
          reject(
            new Error(
              `Fixture helper returned invalid JSON: ${payload}${stderr ? `\n${stderr.trim()}` : ''}\n${
                parseError instanceof Error ? parseError.message : String(parseError)
              }`,
            ),
          );
        }
      },
    );
  });

export const createOwnerCredentials = (product) => ({
  email: `${product}-owner@billme-e2e.local`,
  fullName: product === 'pro' ? 'Billme Pro Owner' : 'Billme Lite Owner',
  password: 'billme-server-123',
  });

export const getProAppUrl = (state, route = 'overview') => {
  if (route.startsWith('#')) {
    return `${state.urls.webPro}${route}`;
  }
  const normalized = route === '/' || route === 'overview' ? '/' : `/${String(route).replace(/^\/+/, '')}`;
  return `${state.urls.webPro}#${normalized}`;
};

export const ensureHarnessSession = async (state, { product, email, password, fullName }) => {
  return runFixtureHelper([
    'ensure-session',
    '--state-file',
    state.stateFile,
    '--product',
    product,
    '--email',
    email,
    '--password',
    password,
    '--full-name',
    fullName,
  ]);
};

export const createHarnessProTenant = async (state, { email, password, fullName }) => runFixtureHelper([
  'create-pro-tenant',
  '--state-file', state.stateFile,
  '--email', email,
  '--password', password,
  '--full-name', fullName,
]);

export const seedHarnessProTenant = async (state, { tenantId, namespace, includeEurCashFixtures = false, includeEurCatalog2026 = false }) => {
  const args = [
    'seed-pro',
    '--state-file',
    state.stateFile,
    '--tenant-id',
    tenantId,
    '--namespace',
    namespace,
  ];
  if (includeEurCashFixtures) args.push('--include-eur-cash-fixtures', 'true');
  if (includeEurCatalog2026) args.push('--include-eur-catalog-2026', 'true');
  return runFixtureHelper(args);
};

export const setHarnessProPeriodStatus = async (state, { tenantId, period, status }) =>
  runFixtureHelper([
    'set-pro-period-status',
    '--state-file', state.stateFile,
    '--tenant-id', tenantId,
    '--period', period,
    '--status', status,
  ]);

export const setHarnessProBankTransactionStatus = async (state, { tenantId, transactionId, status }) =>
  runFixtureHelper([
    'set-pro-bank-transaction-status',
    '--state-file', state.stateFile,
    '--tenant-id', tenantId,
    '--transaction-id', transactionId,
    '--status', status,
  ]);

export const installProSession = async (page, state, session) => {
  await page.addInitScript(
    ({ apiKey, apiUrl, sessionKey, storedSession }) => {
      window.localStorage.setItem(apiKey, apiUrl);
      window.localStorage.setItem(sessionKey, JSON.stringify(storedSession));
    },
    {
      apiKey: PRO_API_URL_STORAGE_KEY,
      apiUrl: state.urls.api,
      sessionKey: PRO_SESSION_STORAGE_KEY,
      storedSession: {
        token: session.token,
        user: session.user,
        apiUrl: state.urls.api,
      },
    },
  );
};

export const openProShell = async (page, state, { route = 'overview', session = null } = {}) => {
  if (session) {
    await installProSession(page, state, session);
  }
  await page.goto(getProAppUrl(state, route), { waitUntil: 'networkidle' });
};

const request = async (state, session, requestPath, query, options = {}) => {
  const url = new URL(requestPath, `${state.urls.api}/`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') {
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  const headers = {
    accept: options.accept ?? 'application/json',
    authorization: `Bearer ${session.token}`,
  };
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const response = await fetch(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  if (response.ok) {
    return response;
  }

  const payload = await response.json().catch(() => null);
  throw new Error(
    payload && typeof payload === 'object' && 'message' in payload && typeof payload.message === 'string'
      ? payload.message
      : `Request failed with status ${response.status}`,
  );
};

export const requestJson = async (state, session, requestPath, query = undefined, options = {}) => {
  const response = await request(state, session, requestPath, query, options);
  return response.json();
};

export const requestText = async (state, session, requestPath, query = undefined, options = {}) => {
  const response = await request(state, session, requestPath, query, {
    ...options,
    accept: options.accept ?? 'text/csv',
  });
  return {
    body: await response.text(),
    headers: response.headers,
  };
};
