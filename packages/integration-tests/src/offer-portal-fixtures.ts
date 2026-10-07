import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp, type PortalConfig } from '../../../apps/offer-portal/src/app.js';
import { createMemoryOfferStore, createMemoryPdfStore } from '../../../apps/offer-portal/src/storage/memory.js';
import { createNodeFsPdfStore } from '../../../apps/offer-portal/src/storage/nodeFs.js';
import { createNodeSqliteOfferStore } from '../../../apps/offer-portal/src/storage/nodeSqlite.js';
import type { OfferStore, PdfStore } from '../../../apps/offer-portal/src/storage/types.js';
import { logRoute } from './route-log.js';

/**
 * The real offer portal (apps/offer-portal createApp with its production
 * storage backends) behind a real HTTP listener. Requests go through node:http
 * so a test can set any Host/Origin header, and every exchange lands in
 * `test-results/integration/<suite>.json` next to the desktop transcripts.
 */
const here = dirname(fileURLToPath(import.meta.url));
const resultsDir = resolve(here, '..', '..', '..', 'test-results', 'integration');

export type PortalExchange = { method: string; path: string; status: number; request?: unknown; response?: unknown };
const transcripts = new Map<string, PortalExchange[]>();

// The portal rate limits per client address (x-forwarded-for) in a module-wide
// table, so every request gets its own address unless a test pins one.
let visitor = 0;
export const nextVisitor = (): string => `10.${(visitor >> 16) & 255}.${(visitor >> 8) & 255}.${(visitor++ & 255) + 1}`;

export type PortalResponse = {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  text: string;
  /** Parsed JSON body, or null when the body is not JSON. */
  json: any;
  cookies: string[];
};

export type PortalRequestInit = {
  headers?: Record<string, string>;
  json?: unknown;
  form?: Record<string, string>;
  multipart?: FormData;
  /** Sent as is (malformed JSON, unknown content types). */
  raw?: { body: string; contentType: string };
};

export type PortalOptions = {
  suite: string;
  store?: 'sqlite' | 'memory';
  /** Defaults to a random key; `null` runs the portal without a publish key. */
  apiKey?: string | null;
  requirePublishApiKey?: boolean;
  /** Defaults to the portal's own base URL, so a same-origin Origin header is accepted. */
  publicBaseUrl?: string;
  /** Reopen an existing data directory (SQLite file and PDFs). */
  dir?: string;
};

export type PortalHandle = Awaited<ReturnType<typeof startPortal>>;

const bodyOf = (init: PortalRequestInit): { body?: Buffer; headers: Record<string, string> } => {
  if (init.json !== undefined) return { body: Buffer.from(JSON.stringify(init.json)), headers: { 'content-type': 'application/json' } };
  if (init.form) return { body: Buffer.from(new URLSearchParams(init.form).toString()), headers: { 'content-type': 'application/x-www-form-urlencoded' } };
  if (init.raw) return { body: Buffer.from(init.raw.body), headers: { 'content-type': init.raw.contentType } };
  return { headers: {} };
};

export const startPortal = async (options: PortalOptions) => {
  const dir = options.dir ?? await mkdtemp(join(tmpdir(), 'billme-it-portal-'));
  await mkdir(dir, { recursive: true });
  const mode = options.store ?? 'sqlite';
  const store: OfferStore = mode === 'sqlite' ? createNodeSqliteOfferStore(join(dir, 'portal.sqlite')) : createMemoryOfferStore();
  const pdf: PdfStore = mode === 'sqlite' ? createNodeFsPdfStore(join(dir, 'pdfs')) : createMemoryPdfStore();
  const apiKey = options.apiKey === undefined ? `key-${Math.random().toString(36).slice(2)}-${Date.now()}` : options.apiKey;
  const log = transcripts.get(options.suite) ?? [];
  transcripts.set(options.suite, log);

  // The port is only known once the socket is bound, and the app needs the
  // public base URL, so the app is created lazily on the first request.
  let app: ReturnType<typeof createApp> | undefined;
  let baseUrl = '';
  const server = serve({ fetch: (request) => app!.fetch(request), port: 0, hostname: '127.0.0.1' }, (info) => {
    baseUrl = `http://127.0.0.1:${(info as AddressInfo).port}`;
  });
  await new Promise<void>((done) => { if (server.listening) done(); else server.once('listening', () => done()); });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
  const config: PortalConfig = {
    publishApiKey: apiKey ?? undefined,
    publicBaseUrl: options.publicBaseUrl ?? baseUrl,
    requirePublishApiKey: options.requirePublishApiKey ?? true,
  };
  app = createApp({ store, pdf, config });

  const request = async (method: string, path: string, init: PortalRequestInit = {}): Promise<PortalResponse> => {
    const encoded = init.multipart
      ? await (async () => {
        const response = new Response(init.multipart);
        return { body: Buffer.from(await response.arrayBuffer()), headers: { 'content-type': response.headers.get('content-type')! } };
      })()
      : bodyOf(init);
    const headers = { 'x-forwarded-for': nextVisitor(), ...encoded.headers, ...(init.headers ?? {}) };
    const url = new URL(path, baseUrl);
    const result = await new Promise<PortalResponse>((done, fail) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: address.port, method, path: url.pathname + url.search, headers: { ...headers, ...(encoded.body ? { 'content-length': String(encoded.body.length) } : {}) }, agent: false },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const body = Buffer.concat(chunks);
            const text = body.toString('utf8');
            let json: unknown = null;
            try { json = JSON.parse(text); } catch { /* not JSON */ }
            done({ status: res.statusCode ?? 0, headers: res.headers, body, text, json, cookies: res.headers['set-cookie'] ?? [] });
          });
        },
      );
      req.on('error', fail);
      if (encoded.body) req.write(encoded.body);
      req.end();
    });
    logRoute(method, url.pathname, result.status, 'portal');
    const loggedRequest = init.json ?? init.form ?? (init.multipart ? '[multipart]' : init.raw?.body);
    log.push({ method, path: url.pathname + url.search, status: result.status, request: loggedRequest, response: result.json ?? (result.headers['content-type']?.toString().startsWith('text/html') ? '[html]' : result.text.slice(0, 200)) });
    return result;
  };

  const publishHeaders = (key: string | null = apiKey): Record<string, string> => (key === null ? {} : { 'x-api-key': key });
  /** Publishes through the same wire format the desktop uses (JSON, token in the body). */
  const publish = (kind: 'offers' | 'invoices', body: { token: string; snapshot: unknown; customerRef?: string; customerLabel?: string; expiresAt?: string }, key: string | null = apiKey) =>
    request('POST', `/${kind}`, { json: body, headers: publishHeaders(key) });
  const accessLink = (customerRef: string, extra: { customerLabel?: string; expiresInDays?: number } = {}, rotate = false) =>
    request('POST', `/customers/access-links${rotate ? '/rotate' : ''}`, { json: { customerRef, ...extra }, headers: publishHeaders() });

  const close = async ({ keepData = false } = {}) => {
    (server as Server).closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await mkdir(resultsDir, { recursive: true });
    await writeFile(join(resultsDir, `${options.suite}.json`), `${JSON.stringify(log, null, 2)}\n`);
    if (!keepData) await rm(dir, { recursive: true, force: true });
  };

  return { baseUrl, apiKey, dir, mode, store, pdf, request, publish, accessLink, close, publishHeaders };
};

/** A document id as the customer-facing /d/:id URL carries it. */
export const documentIdFromUrl = (url: string): string => decodeURIComponent(url.replace(/^\/d\//, ''));

/** A 16+ character token like the desktop mints (24 random bytes, base64url). */
export const newToken = (label = 'tok'): string => `${label}-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}abcdefghij`;
