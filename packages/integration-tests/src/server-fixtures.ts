import { randomUUID, scryptSync } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import './route-log.js';
import { createLiteHttpBillmeApi } from '@billme/desktop-services/liteHttpApi';
import { createProHttpBillmeApi } from '@billme/desktop-services/proHttpApi';
import { DEFAULT_SETTINGS } from '@billme/desktop-services/mockData';
import { buildServerApi, type BuildServerApiOptions } from '../../server-runtime/src/app.js';
import { startPgliteWire, type PgliteWire } from './pglite-wire.js';

/**
 * Hosted server mode (`runtime: 'server'`, `DATABASE_URL`, session tokens, the
 * Postgres auth store) on an in-process PGlite behind a Postgres wire front.
 * Every request lands in `test-results/integration/<suite>.json`.
 */
const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..', '..', '..');
const resultsDir = join(repoRoot, 'test-results', 'integration');

export type Exchange = { method: string; path: string; status: number; request?: unknown; response?: unknown };

export const createRecorder = (suite: string) => {
  const log: Exchange[] = [];
  const recordingFetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const response = await fetch(input, init);
    const text = await response.clone().text().catch(() => '');
    let body: unknown = text;
    try { body = JSON.parse(text); } catch { /* keep text */ }
    let request: unknown = init?.body;
    if (typeof request === 'string') {
      try { request = JSON.parse(request); } catch { /* keep text */ }
    }
    log.push({ method: init?.method ?? 'GET', path: url.pathname + url.search, status: response.status, request, response: body });
    return response;
  };
  const flush = async () => {
    await mkdir(resultsDir, { recursive: true });
    await writeFile(join(resultsDir, `${suite}.json`), `${JSON.stringify(log, null, 2)}\n`);
  };
  return { fetch: recordingFetch, log, flush };
};

export const SESSION_SECRET = 'integration-session-secret-0123456789abcdef';
export const PASSWORD = 'billme-server-123';

export type Http = (method: string, path: string, options?: {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
}) => Promise<{ status: number; body: any; text: string; headers: Headers }>;

export type HostedServer = Awaited<ReturnType<typeof startHostedServer>>;

/** Runs `buildServerApi` against a fresh PGlite-backed "Postgres" and listens on a random loopback port. */
export const startHostedServer = async (suite: string, options: {
  /** Share an existing database (a second API instance on the same data); it is not closed with this server. */
  wire?: PgliteWire;
  /** Share a transcript; the owner flushes it. */
  recorder?: ReturnType<typeof createRecorder>;
  migrate?: boolean;
  sessionSecret?: string;
  /** BILLME_SETUP_TOKEN of this instance; the first owner needs it. */
  setupToken?: string;
  platformMailer?: BuildServerApiOptions['platformMailer'];
  renderDocumentPdf?: BuildServerApiOptions['renderDocumentPdf'];
  openRouterVlmService?: BuildServerApiOptions['openRouterVlmService'];
  /** A fixed port for callers outside this process (browser E2E); random by default. */
  port?: number;
} = {}) => {
  const ownsWire = !options.wire;
  const wire = options.wire ?? await startPgliteWire({ migrate: options.migrate });
  const recorder = options.recorder ?? createRecorder(suite);
  const previousUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = wire.url;
  let app: Awaited<ReturnType<typeof buildServerApi>>;
  try {
    app = await buildServerApi({
      runtime: 'server',
      logger: false,
      sessionSecret: options.sessionSecret ?? SESSION_SECRET,
      setupToken: options.setupToken,
      platformMailer: options.platformMailer,
      renderDocumentPdf: options.renderDocumentPdf,
      openRouterVlmService: options.openRouterVlmService,
    });
  } catch (error) {
    if (ownsWire) await wire.close();
    throw error;
  } finally {
    if (previousUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousUrl;
  }
  await app.listen({ port: options.port ?? 0, host: '127.0.0.1' });
  const baseUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

  const http: Http = async (method, path, request = {}) => {
    const response = await recorder.fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(request.token ? { authorization: `Bearer ${request.token}` } : {}),
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...request.headers,
      },
      body: request.body === undefined ? undefined : JSON.stringify(request.body),
    });
    const text = await response.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body, text, headers: response.headers };
  };

  const login = async (product: 'lite' | 'pro', email: string, password = PASSWORD) => {
    const response = await http('POST', `/api/v1/${product}/auth/login`, { body: { email, password } });
    if (response.status !== 200) throw new Error(`login ${email} failed: ${response.status} ${response.text}`);
    return { token: response.body.token as string, user: response.body.user as { id: string; email: string; fullName: string; role: string } };
  };

  /** First owner of a product, through the real bootstrap route. */
  const bootstrap = async (product: 'lite' | 'pro', email: string, fullName = 'Owner') => {
    const response = await http('POST', `/api/v1/${product}/auth/bootstrap`, { body: { email, password: PASSWORD, fullName } });
    if (response.status !== 200) throw new Error(`bootstrap ${email} failed: ${response.status} ${response.text}`);
    const session = await http('GET', `/api/v1/${product}/auth/me`, { token: response.body.token });
    return { token: response.body.token as string, user: response.body.user as { id: string; email: string; fullName: string; role: string }, tenantId: session.body.tenantId as string };
  };

  const liteApi = (token: string) => createLiteHttpBillmeApi({ baseUrl, auth: { mode: 'bearer', token }, fetch: recorder.fetch });
  const proApi = (token: string) => createProHttpBillmeApi({ baseUrl, getToken: () => token, fetch: recorder.fetch });

  /** The app's own Einstellungen save, so numbering and tax see a configured company. */
  const putSettings = async (product: 'lite' | 'pro', token: string, patch: Record<string, unknown> = {}) => {
    const settings = { ...DEFAULT_SETTINGS, company: { ...DEFAULT_SETTINGS.company, name: 'Muster GmbH', email: 'info@muster.example' }, ...patch };
    const response = await http('PUT', `/api/v1/${product}/settings`, { token, body: { reason: 'integration setup', settings } });
    if (response.status !== 200) throw new Error(`settings failed: ${response.status} ${response.text}`);
    return settings;
  };

  const close = async () => {
    await app.close().catch(() => undefined);
    if (ownsWire) await wire.close();
    if (!options.recorder) await recorder.flush();
  };

  return { app, wire, baseUrl, http, login, bootstrap, liteApi, proApi, putSettings, recorder, close };
};

/**
 * A user in a tenant that already exists (or a brand new tenant), written with the
 * same scrypt recipe as the Postgres auth store, so the person can then log in
 * through the real route. Hosted bootstrap only creates the first tenant of a
 * product; this is how a second tenant or a viewer exists in a test.
 */
export const seedMember = async (wire: PgliteWire, input: {
  product: 'lite' | 'pro';
  email: string;
  fullName: string;
  role: 'owner' | 'admin' | 'accountant' | 'sales' | 'viewer';
  tenantId?: string;
  password?: string;
}) => {
  const now = new Date().toISOString();
  const tenantId = input.tenantId ?? randomUUID();
  const userId = randomUUID();
  const salt = randomUUID().replaceAll('-', '');
  await wire.sql(
    `INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at)
     VALUES ($1, $1, $2, $3, 'single-tenant', 'active', $4, $4) ON CONFLICT (id) DO NOTHING`,
    [tenantId, `Tenant ${input.fullName}`, input.product, now],
  );
  await wire.sql(
    `INSERT INTO user_accounts (id, email, full_name, status, created_at, updated_at) VALUES ($1, $2, $3, 'active', $4, $4)`,
    [userId, input.email, input.fullName, now],
  );
  await wire.sql(
    `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)`,
    [randomUUID(), tenantId, userId, input.role, now],
  );
  await wire.sql(
    `INSERT INTO user_password_credentials (user_id, password_salt, password_hash, password_algorithm, created_at, updated_at)
     VALUES ($1, $2, $3, 'scrypt-64', $4, $4)`,
    [userId, salt, scryptSync(input.password ?? PASSWORD, salt, 64).toString('hex'), now],
  );
  return { tenantId, userId };
};

export const uniqueEmail = (label: string) => `${label}-${randomUUID().slice(0, 8)}@example.com`;

/**
 * Runs `work` and hands back the uncaught exceptions it caused. node:test fails a
 * run for those; here they are the very thing under test (or known leftovers of a
 * failed start) and must not be attributed to an unrelated test.
 */
export const captureUncaught = async <T>(work: () => Promise<T>, settleMs = 400): Promise<{ result: T; errors: Error[] }> => {
  const events: Array<'uncaughtException' | 'unhandledRejection'> = ['uncaughtException', 'unhandledRejection'];
  const runnerListeners = events.map((event) => [event, [...(process as NodeJS.EventEmitter).listeners(event)] as Array<(...args: unknown[]) => void>] as const);
  for (const event of events) process.removeAllListeners(event);
  const errors: Error[] = [];
  const capture = (error: unknown) => { errors.push(error instanceof Error ? error : new Error(String(error))); };
  for (const event of events) process.on(event, capture as never);
  try {
    const result = await work();
    await new Promise((resolve) => setTimeout(resolve, settleMs));
    return { result, errors };
  } finally {
    for (const event of events) process.off(event, capture as never);
    for (const [event, listeners] of runnerListeners) for (const listener of listeners) process.on(event, listener as never);
  }
};
