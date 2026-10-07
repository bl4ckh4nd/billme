import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readServerHarnessState } from '../harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const fixtureCliPath = path.join(repoRoot, 'tests', 'e2e', 'server', 'lite', 'fixture-cli.ts');
const SESSION_STORAGE_KEY = 'billme.web.lite.session.v1';
const DEFAULT_PASSWORD = 'billme-server-123';

const parseEnv = (content) => {
  const values = {};
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separatorIndex = rawLine.indexOf('=');
    if (separatorIndex <= 0) continue;
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

const slugify = (value) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'lite-e2e';

const cliArg = (key, value) => [`--${key}`, value];

const runFixtureCli = async (args) => {
  return await new Promise((resolve, reject) => {
    execFile(
      'pnpm',
      ['--silent', 'exec', 'tsx', fixtureCliPath, ...args],
      {
        cwd: repoRoot,
        env: process.env,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          parseError.stdout = stdout;
          parseError.stderr = stderr;
          reject(parseError);
        }
      }
    );
  });
};

export const liteSessionStorageKey = SESSION_STORAGE_KEY;
export const litePassword = DEFAULT_PASSWORD;

export const liteAppUrl = (state, route = '/') => {
  const normalized = route.startsWith('/') ? route : `/${route}`;
  return `${state.urls.web}/#${normalized}`;
};

export const createLiteIdentity = (seed) => {
  const slug = slugify(seed);
  const suffix = crypto.randomUUID().slice(0, 8);
  const handle = `${slug}-${suffix}`;
  return {
    email: 'lite-owner@billme-e2e.local',
    fullName: 'Billme Lite Owner',
    namespace: handle,
    password: DEFAULT_PASSWORD,
  };
};

export const getLiteRuntime = async () => {
  const state = await readServerHarnessState();
  const env = state.env ?? parseEnv(await fs.readFile(state.envFile, 'utf8'));
  const databaseUrl = `postgresql://${encodeURIComponent(env.BILLME_POSTGRES_USER ?? 'billme')}:${encodeURIComponent(env.BILLME_POSTGRES_PASSWORD ?? 'billme')}@127.0.0.1:${state.ports.postgres}/${encodeURIComponent(env.BILLME_POSTGRES_DB ?? 'billme')}`;
  return { state, env, databaseUrl };
};

export const provisionLiteSession = async ({
  apiBaseUrl,
  databaseUrl,
  email,
  password = DEFAULT_PASSWORD,
  fullName,
  namespace,
}) => {
  const args = [
    'ensure-lite-session',
    ...cliArg('api-base-url', apiBaseUrl),
    ...cliArg('email', email),
    ...cliArg('password', password),
    ...cliArg('full-name', fullName),
  ];

  if (databaseUrl) {
    args.push(...cliArg('database-url', databaseUrl));
  }
  if (namespace) {
    args.push(...cliArg('seed-namespace', namespace));
  }
  const { env } = await getLiteRuntime();
  if (env.BILLME_SETUP_TOKEN) {
    args.push(...cliArg('setup-token', env.BILLME_SETUP_TOKEN));
  }

  return runFixtureCli(args);
};

export const applyLiteSession = async (page, state, session, route = '/') => {
  await page.addInitScript(
    ({ key, value }) => {
      window.localStorage.setItem(key, JSON.stringify(value));
    },
    {
      key: SESSION_STORAGE_KEY,
      value: {
        token: session.token,
        user: session.user,
      },
    },
  );
  await page.goto(liteAppUrl(state, route), { waitUntil: 'networkidle' });
};

export const readLiteStoredSession = async (page) => {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, SESSION_STORAGE_KEY);
};

export const writeLiteStoredSession = async (page, value) => {
  await page.evaluate(
    ({ key, session }) => {
      if (session === null) {
        window.localStorage.removeItem(key);
        return;
      }
      window.localStorage.setItem(key, JSON.stringify(session));
    },
    {
      key: SESSION_STORAGE_KEY,
      session: value,
    }
  );
};

export const apiJson = async (state, session, pathname, init = {}) => {
  const response = await fetch(`${state.urls.api}${pathname}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${session.token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(init.headers ?? {}),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`API ${pathname} failed (${response.status}): ${JSON.stringify(payload)}`);
  }
  return payload;
};
