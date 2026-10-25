import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import './route-log.js';
import { ISSUER } from './fixtures.js';
import { createLiteHttpBillmeApi } from '@billme/desktop-services/liteHttpApi';
import { createProHttpBillmeApi } from '@billme/desktop-services/proHttpApi';
import { PgliteServerDatabase } from '@billme/server-data';
import { createLocalBackend } from '../../../apps/desktop/electron/localBackend.js';
import { PRODUCT_PROFILE as LITE_PROFILE } from '../../../apps/desktop/productProfile.js';
import { createProLocalBackend } from '../../../apps/pro-desktop/electron/proLocalBackend.js';
import { PRODUCT_PROFILE as PRO_PROFILE } from '../../../apps/pro-desktop/productProfile.js';

/**
 * Boots the backend Electron starts (embedded Fastify on a fresh PGlite data
 * dir) and talks to it through the HTTP client the renderer uses. Every request
 * lands in `test-results/integration/<suite>.json`, the artifact of a run.
 */
const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = resolve(here, '..', '..', '..', 'test-results', 'integration');

export type Exchange = { method: string; path: string; status: number; request?: unknown; response?: unknown };

const recordingFetch = (log: Exchange[]): typeof fetch => async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const response = await fetch(input, init);
  const copy = response.clone();
  const text = await copy.text().catch(() => '');
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* keep text */ }
  let request: unknown = init?.body;
  if (typeof request === 'string') {
    try { request = JSON.parse(request); } catch { /* keep text */ }
  }
  log.push({ method: init?.method ?? 'GET', path: url.pathname + url.search, status: response.status, request, response: body });
  return response;
};

const writeTranscript = async (suite: string, log: Exchange[]) => {
  await mkdir(resultsDir, { recursive: true });
  await writeFile(join(resultsDir, `${suite}.json`), `${JSON.stringify(log, null, 2)}\n`);
};

type Raw = (method: string, path: string, body?: unknown) => Promise<{ status: number; body: any; text: string; headers: Headers }>;

const rawClient = (product: 'lite' | 'pro', connection: { baseUrl: string; token: string }, doFetch: typeof fetch): Raw =>
  async (method, path, body) => {
    const url = path.startsWith('/api/') ? path : `/api/v1/${product}${path}`;
    const response = await doFetch(`${connection.baseUrl}${url}`, {
      method,
      headers: { 'x-billme-local-token': connection.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: parsed, text, headers: response.headers };
  };

const temporaryDir = async (product: string) => mkdtemp(join(tmpdir(), `billme-it-${product}-`));

/**
 * A fresh Lite desktop backend. With a test context it is closed and deleted
 * when that test ends; otherwise call `close()` (e.g. from an `after` hook).
 * Pass `userDataPath` to reopen an existing data dir (restart scenarios).
 */
const onboard = async (api: Pick<ReturnType<typeof createLiteHttpBillmeApi>, 'settings'>) => {
  const settings = await api.settings.get();
  if (!settings || settings.company.name) return;
  await api.settings.set({ settings: { ...settings, company: { ...settings.company, ...ISSUER.company }, finance: { ...settings.finance, ...ISSUER.finance } } });
};

export const startLite = async (t: TestContext | null, suite: string, existingDataPath?: string) => {
  const userDataPath = existingDataPath ?? await temporaryDir('lite');
  const log: Exchange[] = [];
  const doFetch = recordingFetch(log);
  const backend = await createLocalBackend({ userDataPath, profile: LITE_PROFILE });
  const connection = backend.embeddedConnection()!;
  const api = createLiteHttpBillmeApi({ baseUrl: connection.baseUrl, auth: { mode: 'embedded', token: connection.token }, fetch: doFetch });
  const close = async ({ keepData = false } = {}) => {
    await backend.close().catch(() => undefined);
    await writeTranscript(suite, log);
    if (!keepData) await rm(userDataPath, { recursive: true, force: true });
  };
  t?.after(() => close());
  if (!existingDataPath) await onboard(api);
  return { api, raw: rawClient('lite', connection, doFetch), connection, backend, userDataPath, log, close };
};

/** Same as `startLite` for the Pro desktop backend. */
export const startPro = async (t: TestContext | null, suite: string, existingDataPath?: string) => {
  const userDataPath = existingDataPath ?? await temporaryDir('pro');
  const log: Exchange[] = [];
  const doFetch = recordingFetch(log);
  const backend = await createProLocalBackend({ userDataPath, profile: PRO_PROFILE });
  const connection = backend.embeddedConnection()!;
  const api = createProHttpBillmeApi({ baseUrl: connection.baseUrl, embeddedConnectionResolver: async () => connection, fetch: doFetch });
  const close = async ({ keepData = false } = {}) => {
    await backend.close().catch(() => undefined);
    await writeTranscript(suite, log);
    if (!keepData) await rm(userDataPath, { recursive: true, force: true });
  };
  t?.after(() => close());
  if (!existingDataPath) await onboard(api as never);
  return { api, raw: rawClient('pro', connection, doFetch), connection, backend, userDataPath, log, close };
};

export type LiteHarness = Awaited<ReturnType<typeof startLite>>;

/**
 * Rewrites the stored Lite settings below the API, the way an older app version
 * left them, and reopens the backend on the same data dir. For states the
 * settings route no longer accepts (a Lite profile on double entry).
 */
export const reopenLiteWithStoredSettings = async (h: LiteHarness, t: TestContext | null, suite: string, edit: (settings: any) => unknown): Promise<LiteHarness> => {
  await h.close({ keepData: true });
  const database = await PgliteServerDatabase.open(join(h.userDataPath, LITE_PROFILE.dataDirName));
  try {
    const stored = (await database.query<{ settings_json: string }>('SELECT settings_json FROM server_settings WHERE tenant_id=$1', [LITE_PROFILE.localTenantId])).rows[0]!;
    await database.query('UPDATE server_settings SET settings_json=$2 WHERE tenant_id=$1', [LITE_PROFILE.localTenantId, JSON.stringify(edit(JSON.parse(stored.settings_json)))]);
  } finally {
    await database.close();
  }
  return startLite(t, suite, h.userDataPath);
};

/** Pro extends the Lite contract, so the billing suites run once per product (`<suite>-on-pro` transcripts for Pro). */
export const PRODUCTS = ['lite', 'pro'] as const;
export type Product = (typeof PRODUCTS)[number];
export const startProduct = (product: Product, t: TestContext | null, suite: string, existingDataPath?: string): Promise<LiteHarness> =>
  product === 'lite'
    ? startLite(t, suite, existingDataPath)
    : startPro(t, `${suite}-on-pro`, existingDataPath) as unknown as Promise<LiteHarness>;
export type ProHarness = Awaited<ReturnType<typeof startPro>>;
