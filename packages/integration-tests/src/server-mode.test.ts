import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { buildServerApi } from '../../server-runtime/src/app.js';
import * as serverData from '@billme/server-data';
import { createServerApiClient } from '@billme/server-core';
import { captureUncaught, PASSWORD, repoRoot, seedMember, SESSION_SECRET, startHostedServer, uniqueEmail, type HostedServer } from './server-fixtures.js';
import { concretePath, fastifyRoutes } from './routes.js';
import { startPgliteWire } from './pglite-wire.js';
import { draftInvoice, draftOffer, issueInvoice, newClient } from './fixtures.js';

/**
 * Hosted server mode (apps/server-api = `buildServerApi({ runtime: 'server' })`)
 * through real HTTP, the browser shells' clients and real logins. The database is
 * PGlite behind a Postgres wire front (`pglite-wire.ts`), so the production
 * `pg` pool, the Postgres auth store and the Drizzle migrations are all in play.
 *
 * How this can fail (each one has a test below):
 * - auth: a wrong password or unknown user told apart (user enumeration), login
 *   case-sensitive, password stored in clear, a second bootstrap taking over a
 *   configured instance, malformed credentials reaching the store; the
 *   product-neutral `/api/v1/auth/*` routes (CLI `whoami`) answering differently
 *   from the product routes (500 instead of 401/409, the wrong product's session)
 * - sessions: an expired, tampered, foreign-secret, product-swapped or
 *   cookie/local-token request accepted; a weak or default SESSION_SECRET
 *   accepted once a database is configured; a user demoted or removed while
 *   their token keeps working (no revocation)
 * - tenant isolation: tenant B listing, reading, overwriting, deleting, paying,
 *   exporting or auditing tenant A's clients, invoices and offers; B taking over
 *   A's number reservation; numbering counters shared between tenants; a Lite
 *   token on Pro routes and the reverse
 * - roles: viewer or sales mutating (clients, documents, settings, numbers,
 *   payments, recurring profiles) or being locked out of reading
 * - route sweep: any registered route other than the public ones answering a
 *   request without a session, any mutation route open to a viewer
 * - CLI device login: a browser (Origin header) starting or polling a login,
 *   unthrottled starts, polling flooding, a spent or denied device code reused,
 *   a read-only token writing, a CLI token managing CLI tokens, a revoked token
 *   still working, a token's role outliving the user's role, writes not
 *   attributed to the CLI in the audit log, tokens stored in clear
 * - PDF: the render session not bound to the caller, an unauthenticated render
 *   (Chromium itself is not part of this suite)
 * - Pro / tax / EÜR routes: accounting mutations without reason or role, a draft
 *   smuggling its workflow status, tax filings created by viewers, document analysis
 *   trusting the browser's copy of a transaction or reading another tenant's
 * - errors: SQL or bound values echoed to the client, malformed bodies as 500
 * - database: a restart of Postgres crashing the API, a serialization failure not
 *   retried or leaving rows of the failed attempt behind
 * - no database configured: local development mode answering 503 instead of failing
 *   open, the typed server client's bootstrap/login
 * - migrations: journal and .sql files disagreeing, a table or column the code
 *   uses missing after migrating from empty, a second run changing anything, an
 *   API starting on an unmigrated or outdated database
 */
describe('server mode', () => {
  let h: HostedServer;
  // Tenant A is the lite bootstrap, tenant P the pro bootstrap, tenant B a second lite tenant.
  let a: { token: string; tenantId: string; email: string; user: { id: string; fullName: string } };
  let p: { token: string; tenantId: string; email: string };
  let b: { token: string; tenantId: string; email: string };
  let viewer: { token: string; email: string };
  let sales: { token: string };
  let accountant: { token: string };
  let admin: { token: string };

  before(async () => {
    h = await startHostedServer('server-mode');
    const aEmail = uniqueEmail('owner-a');
    const boot = await h.bootstrap('lite', aEmail, 'Alice Owner');
    a = { token: boot.token, tenantId: boot.tenantId, email: aEmail, user: boot.user };
    const pEmail = uniqueEmail('owner-p');
    const pro = await h.bootstrap('pro', pEmail, 'Paula Pro');
    p = { token: pro.token, tenantId: pro.tenantId, email: pEmail };

    const bEmail = uniqueEmail('owner-b');
    await seedMember(h.wire, { product: 'lite', email: bEmail, fullName: 'Bob Owner', role: 'owner' });
    b = { ...(await h.login('lite', bEmail)), email: bEmail } as unknown as typeof b;
    b.tenantId = (await h.http('GET', '/api/v1/lite/auth/me', { token: b.token })).body.tenantId;

    const member = async (role: 'viewer' | 'sales' | 'accountant' | 'admin') => {
      const email = uniqueEmail(role);
      await seedMember(h.wire, { product: 'lite', email, fullName: `${role} user`, role, tenantId: a.tenantId });
      return { ...(await h.login('lite', email)), email };
    };
    viewer = await member('viewer');
    sales = await member('sales');
    accountant = await member('accountant');
    admin = await member('admin');
    await h.putSettings('lite', a.token);
    await h.putSettings('lite', b.token, { company: { name: 'Bob Handel', owner: '', street: '', zip: '', city: '', email: 'bob@example.com', phone: '', website: '' } });
    await h.putSettings('pro', p.token);
  });
  after(async () => { await h.close(); });

  describe('bootstrap and login', () => {
    test('bootstrap status flips once and a second bootstrap cannot take over a configured product', async () => {
      const status = await h.http('GET', '/api/v1/lite/auth/bootstrap/status');
      assert.equal(status.status, 200);
      assert.equal(status.body.bootstrapped, true);
      assert.ok(status.body.userCount >= 1);
      const takeover = await h.http('POST', '/api/v1/lite/auth/bootstrap', { body: { email: uniqueEmail('evil'), password: PASSWORD, fullName: 'Mallory' } });
      assert.equal(takeover.status, 409, takeover.text);
      assert.match(takeover.body.message, /Bootstrap already completed/);
    });

    test('an email that exists in another product cannot be bootstrapped again', async () => {
      const conflict = await h.http('POST', '/api/v1/pro/auth/bootstrap', { body: { email: p.email, password: PASSWORD, fullName: 'Dup' } });
      assert.equal(conflict.status, 409, conflict.text);
    });

    test('malformed credentials are rejected before they reach the store', async () => {
      for (const body of [
        { email: 'not-an-email', password: PASSWORD },
        { email: a.email, password: '' },
        { email: a.email },
        {},
      ]) {
        const response = await h.http('POST', '/api/v1/lite/auth/login', { body });
        assert.equal(response.status, 400, `${JSON.stringify(body)} -> ${response.status} ${response.text}`);
      }
      const short = await h.http('POST', '/api/v1/lite/auth/bootstrap', { body: { email: uniqueEmail('short'), password: 'short', fullName: 'S' } });
      assert.equal(short.status, 400);
    });

    test('a wrong password and an unknown user get the same answer, email case is ignored', async () => {
      const wrong = await h.http('POST', '/api/v1/lite/auth/login', { body: { email: a.email, password: 'definitely-wrong' } });
      const unknown = await h.http('POST', '/api/v1/lite/auth/login', { body: { email: uniqueEmail('ghost'), password: PASSWORD } });
      assert.equal(wrong.status, 401);
      assert.equal(unknown.status, 401);
      assert.equal(wrong.body.message, unknown.body.message, 'login must not reveal which emails exist');
      assert.equal(wrong.body.token, undefined);
      const upper = await h.http('POST', '/api/v1/lite/auth/login', { body: { email: a.email.toUpperCase(), password: PASSWORD } });
      assert.equal(upper.status, 200, upper.text);
      assert.equal(upper.body.user.email, a.email);
    });

    test('the product-neutral auth routes answer like the product routes', async () => {
      const status = await h.http('GET', '/api/v1/auth/bootstrap/status?product=pro');
      assert.equal(status.status, 200, status.text);
      assert.equal(status.body.bootstrapped, true);
      const takeover = await h.http('POST', '/api/v1/auth/bootstrap?product=lite', { body: { email: uniqueEmail('evil'), password: PASSWORD, fullName: 'Mallory' } });
      assert.equal(takeover.status, 409, takeover.text);
      const wrong = await h.http('POST', '/api/v1/auth/login?product=lite', { body: { email: a.email, password: 'definitely-wrong' } });
      assert.equal(wrong.status, 401, wrong.text);
      const login = await h.http('POST', '/api/v1/auth/login?product=lite', { body: { email: a.email, password: PASSWORD } });
      assert.equal(login.status, 200, login.text);
      const me = await h.http('GET', '/api/v1/auth/me?product=lite', { token: login.body.token });
      assert.equal(me.status, 200, me.text);
      assert.deepEqual({ email: me.body.user.email, tenantId: me.body.tenantId, product: me.body.product }, { email: a.email, tenantId: a.tenantId, product: 'lite' });
      assert.equal((await h.http('GET', '/api/v1/auth/me?product=pro', { token: login.body.token })).status, 403, 'a Lite token is no Pro session');
      assert.equal((await h.http('GET', '/api/v1/auth/me?product=lite')).status, 401);
      assert.equal((await h.http('GET', '/api/v1/auth/me?product=enterprise', { token: login.body.token })).status, 400);
    });

    test('a Lite login does not open Pro and the reverse', async () => {
      const lite = await h.http('POST', '/api/v1/pro/auth/login', { body: { email: a.email, password: PASSWORD } });
      assert.equal(lite.status, 401, 'the lite owner has no pro account');
      const pro = await h.http('POST', '/api/v1/lite/auth/login', { body: { email: p.email, password: PASSWORD } });
      assert.equal(pro.status, 401, 'the pro owner has no lite account');
      const generic = await h.http('POST', '/api/v1/auth/login?product=pro', { body: { email: p.email, password: PASSWORD } });
      assert.equal(generic.status, 200, generic.text);
    });

    test('passwords are stored as scrypt hashes, never in clear', async () => {
      const rows = (await h.wire.sql<{ password_hash: string; password_salt: string; password_algorithm: string }>(
        `SELECT c.password_hash, c.password_salt, c.password_algorithm FROM user_password_credentials c
         JOIN user_accounts u ON u.id = c.user_id WHERE u.email = $1`, [a.email])).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.password_algorithm, 'scrypt-64');
      assert.notEqual(rows[0]!.password_hash, PASSWORD);
      assert.ok(!rows[0]!.password_hash.includes(PASSWORD));
      assert.match(rows[0]!.password_hash, /^[0-9a-f]{128}$/);
    });

    test('login throttles repeated failures', async () => {
      const victim = uniqueEmail('brute');
      await seedMember(h.wire, { product: 'lite', email: victim, fullName: 'Victim', role: 'owner' });
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 15; attempt += 1) {
        statuses.push((await h.http('POST', '/api/v1/lite/auth/login', { body: { email: victim, password: `guess-${attempt}` } })).status);
      }
      assert.ok(statuses.includes(429), `15 wrong passwords in a row all answered ${[...new Set(statuses)]}`);
    });
  });

  describe('sessions', () => {
    const sign = (override: Record<string, unknown> = {}, ttl?: number) =>
      h.app.tokenService.sign({ ...(h.app.tokenService.verify(a.token)!), ...override } as never, ttl);

    test('/auth/me tells role, product and tenant of the token', async () => {
      const me = await h.http('GET', '/api/v1/lite/auth/me', { token: a.token });
      assert.equal(me.status, 200);
      assert.equal(me.body.role, 'owner');
      assert.equal(me.body.product, 'lite');
      assert.equal(me.body.tenantId, a.tenantId);
      assert.equal(me.body.user.email, a.email);
    });

    test('requests without a usable bearer token are 401', async () => {
      assert.equal((await h.http('GET', '/api/v1/lite/clients')).status, 401);
      assert.equal((await h.http('GET', '/api/v1/lite/clients', { token: 'garbage' })).status, 401);
      assert.equal((await h.http('GET', '/api/v1/lite/clients', { token: `${a.token.split('.')[0]}.` })).status, 401);
      assert.equal((await h.http('GET', '/api/v1/lite/clients', { headers: { authorization: a.token } })).status, 401, 'no Bearer scheme');
      assert.equal((await h.http('GET', '/api/v1/lite/clients', { headers: { authorization: `Basic ${Buffer.from('a:b').toString('base64')}` } })).status, 401);
    });

    test('an expired token is refused', async () => {
      const expired = sign({}, -5);
      const response = await h.http('GET', '/api/v1/lite/clients', { token: expired });
      assert.equal(response.status, 401);
      assert.match(response.body.message, /expired|Invalid/i);
    });

    test('a tampered payload or a token signed with another secret is refused', async () => {
      const [payload, signature] = a.token.split('.') as [string, string];
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      claims.role = 'owner';
      claims.scope.tenantId = b.tenantId;
      const forged = `${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;
      assert.equal((await h.http('GET', '/api/v1/lite/clients', { token: forged })).status, 401, 'payload edited, signature kept');
      const { SessionTokenService } = await import('../../server-runtime/src/auth.js');
      const foreign = new SessionTokenService('some-other-secret-that-is-long-enough-123456').sign(h.app.tokenService.verify(a.token)!);
      assert.equal((await h.http('GET', '/api/v1/lite/clients', { token: foreign })).status, 401);
    });

    test('a Lite token is not valid for Pro and a Pro token not for Lite', async () => {
      const lite = await h.http('GET', '/api/v1/pro/clients', { token: a.token });
      assert.equal(lite.status, 403);
      assert.match(lite.body.message, /not authorized for pro/i);
      const pro = await h.http('GET', '/api/v1/lite/clients', { token: p.token });
      assert.equal(pro.status, 403);
      assert.match(pro.body.message, /not authorized for lite/i);
      assert.equal((await h.http('GET', '/api/v1/pro/accounting/transactions', { token: a.token })).status, 403);
      assert.equal((await h.http('GET', '/api/v1/lite/auth/me', { token: p.token })).status, 403);
    });

    test('only the Authorization header counts: cookies and the embedded local token are ignored', async () => {
      const viaCookie = await h.http('GET', '/api/v1/lite/clients', { headers: { cookie: `token=${a.token}; billme_session=${a.token}` } });
      assert.equal(viaCookie.status, 401);
      const viaLocal = await h.http('GET', '/api/v1/lite/clients', { headers: { 'x-billme-local-token': a.token } });
      assert.equal(viaLocal.status, 401);
    });

    test('the browser shell client works with a real login and throws on a refused token', async () => {
      const lite = h.liteApi(a.token);
      assert.ok(Array.isArray(await lite.clients.list()));
      const pro = h.proApi(p.token);
      assert.ok(Array.isArray(await pro.clients.list()));
      await assert.rejects(h.liteApi('not-a-token').clients.list());
      await assert.rejects(h.liteApi(p.token).clients.list(), /not authorized for lite/i);
    });

    test('capabilities and OpenAPI are public and describe the hosted runtime', async () => {
      const capabilities = await h.http('GET', '/api/v1/meta/capabilities');
      assert.equal(capabilities.status, 200);
      assert.equal(capabilities.body.runtime, 'server');
      assert.equal(capabilities.body.auth.multiUser, true);
      assert.deepEqual(capabilities.body.products, ['lite', 'pro']);
      const first = await h.http('GET', '/api/v1/openapi.json');
      const second = await h.http('GET', '/api/v1/openapi.json');
      assert.equal(first.text, second.text);
      assert.ok(first.body.paths['/api/v1/lite/auth/login'] && first.body.paths['/api/v1/pro/auth/login']);
      assert.equal((await h.http('GET', '/health')).body.service, 'billme-server-api');
    });

    test('a removed membership or a demoted role takes effect without waiting for the token to expire', async () => {
      const email = uniqueEmail('demote');
      await seedMember(h.wire, { product: 'lite', email, fullName: 'Demoted', role: 'owner', tenantId: a.tenantId });
      const session = await h.login('lite', email);
      const before = await h.http('POST', '/api/v1/lite/clients', { token: session.token, body: { reason: 'before', client: { id: randomUUID(), company: 'Before demotion', contactPerson: 'x', email: 'x@example.com', phone: '', address: '', status: 'active', tags: [], notes: '', addresses: [], emails: [], projects: [], activities: [] } } });
      assert.equal(before.status, 200, before.text);
      await h.wire.sql(`UPDATE tenant_memberships SET role = 'viewer' WHERE user_id = (SELECT id FROM user_accounts WHERE email = $1)`, [email]);
      const after = await h.http('POST', '/api/v1/lite/clients', { token: session.token, body: { reason: 'after', client: { id: randomUUID(), company: 'After demotion', contactPerson: 'x', email: 'x@example.com', phone: '', address: '', status: 'active', tags: [], notes: '', addresses: [], emails: [], projects: [], activities: [] } } });
      assert.equal(after.status, 403, 'the demoted user can still write');
    });
  });

  describe('route sweep over the registered routes', () => {
    const PUBLIC = new Set([
      'GET /health', 'GET /api/v1/meta/capabilities', 'GET /api/v1/openapi.json',
      'POST /api/v1/auth/bootstrap', 'GET /api/v1/auth/bootstrap/status', 'POST /api/v1/auth/login',
      'POST /api/v1/auth/device/start', 'POST /api/v1/auth/device/token',
      ...['lite', 'pro'].flatMap((product) => [`POST /api/v1/${product}/auth/bootstrap`, `GET /api/v1/${product}/auth/bootstrap/status`, `POST /api/v1/${product}/auth/login`]),
    ]);
    const routes = () => fastifyRoutes(h.app.printRoutes({ commonPrefix: false }));
    /**
     * Bodies are validated before the handler checks the session, so an empty body may
     * end in a 400. Each route is asked without a body and with `{}`; it is open as soon
     * as one answer is not a refusal.
     */
    const answers = async (method: string, path: string, token?: string) => {
      const bodies = method === 'GET' || method === 'DELETE' ? [undefined] : [undefined, {}];
      const statuses: number[] = [];
      for (const body of bodies) statuses.push((await h.http(method, concretePath(path), { token, body })).status);
      return statuses;
    };

    test('every route except the public ones refuses a request without a session', async () => {
      const open: string[] = [];
      for (const route of routes()) {
        const key = `${route.method} ${route.path}`;
        if (PUBLIC.has(key)) continue;
        const statuses = await answers(route.method, route.path);
        if (statuses.some((status) => status !== 400 && status !== 401)) open.push(`${key} -> ${statuses.join(',')}`);
      }
      assert.deepEqual(open, []);
    });

    test('a viewer cannot reach any mutation of the Lite API', async () => {
      // Read-only POSTs and the viewer's own session housekeeping are not mutations of tenant data.
      const own = new Set(['POST /api/v1/lite/tax/validate-vat-id', 'POST /api/v1/lite/cli-access/revoke-self', 'POST /api/v1/lite/cli-access/decide', 'DELETE /api/v1/lite/cli-access/tokens/:id']);
      const open: string[] = [];
      for (const route of routes()) {
        const key = `${route.method} ${route.path}`;
        if (route.method === 'GET' || !route.path.startsWith('/api/v1/lite/') || route.path.startsWith('/api/v1/lite/auth/') || own.has(key)) continue;
        const statuses = await answers(route.method, route.path, viewer.token);
        if (statuses.some((status) => status !== 400 && status !== 403)) open.push(`${key} -> ${statuses.join(',')}`);
      }
      assert.deepEqual(open, []);
    });
  });

  describe('session secret', () => {
    let wire: Awaited<ReturnType<typeof startPgliteWire>>;
    before(async () => { wire = await startPgliteWire({ migrate: true }); });
    after(async () => { await wire.close(); });

    const attempt = async (sessionSecret: string | undefined, env: Record<string, string | undefined> = {}) => {
      const saved = { ...process.env };
      process.env.DATABASE_URL = wire.url;
      for (const [key, value] of Object.entries(env)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      try {
        const app = await buildServerApi({ runtime: 'server', logger: false, sessionSecret });
        await app.close();
        return null;
      } catch (error) {
        return error as Error;
      } finally {
        for (const key of ['DATABASE_URL', 'SESSION_SECRET', 'NODE_ENV']) {
          if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
        }
      }
    };

    test('a database without a real SESSION_SECRET refuses to start', async () => {
      const unset = await attempt(undefined, { SESSION_SECRET: undefined });
      assert.match(unset?.message ?? '', /SESSION_SECRET is not set.*Refusing to start/s);
      const dev = await attempt('billme-dev-session-secret');
      assert.match(dev?.message ?? '', /built-in development value/);
      const short = await attempt('too-short-secret');
      assert.match(short?.message ?? '', /shorter than 32 characters/);
      const padded = await attempt(`   ${'x'.repeat(30)}   `);
      assert.match(padded?.message ?? '', /shorter than 32 characters/, 'whitespace does not count towards the length');
      assert.equal(await attempt(SESSION_SECRET), null, 'a long random secret starts');
    });

    test('NODE_ENV=production refuses a missing or weak secret even before a database is configured', async () => {
      const unset = await attempt(undefined, { DATABASE_URL: undefined, NODE_ENV: 'production', SESSION_SECRET: undefined });
      assert.match(unset?.message ?? '', /Refusing to start/);
      const weak = await attempt('short', { DATABASE_URL: undefined, NODE_ENV: 'production' });
      assert.match(weak?.message ?? '', /shorter than 32/);
    });
  });

  describe('Pro and tax routes', () => {
    let proViewer: { token: string };
    before(async () => {
      const email = uniqueEmail('pro-viewer');
      await seedMember(h.wire, { product: 'pro', email, fullName: 'Pro Viewer', role: 'viewer', tenantId: p.tenantId });
      proViewer = await h.login('pro', email);
    });
    const asset = { assetNumber: 'A-1', name: 'Test', assetClass: 'IT-Hardware', status: 'entwurf', activationDate: '2026-08-12', acquisitionCost: 100, depreciationMethod: 'linear', costCenter: 'FIN', location: 'Berlin', receiptLinked: false, assetAccountNumber: '0480' };
    const mapping = { chart: 'SKR03', taxCaseKey: 'DE_STD_19', role: 'output_tax', accountNumber: '1776' };
    const rule = { chart: 'SKR03', priority: 1, field: 'purpose', operator: 'contains', value: 'test', targetAccountNumber: '4900' };

    test('accounting reads need a login and a Pro token', async () => {
      assert.equal((await h.http('GET', '/api/v1/pro/accounting/assets')).status, 401);
      assert.equal((await h.http('GET', '/api/v1/pro/accounting/source-runs')).status, 401);
      assert.equal((await h.http('GET', '/api/v1/pro/accounting/transactions', { token: a.token })).status, 403, 'a Lite token');
      assert.equal((await h.http('GET', '/api/v1/pro/accounting/assets', { token: p.token })).status, 200);
    });

    test('accounting mutations need a reason and an accounting role', async () => {
      const cases: Array<[string, string, Record<string, unknown>]> = [
        ['PUT', '/api/v1/pro/accounting/policy', { activeChart: 'SKR03', vatMethod: 'soll' }],
        ['POST', '/api/v1/pro/accounting/assets', { asset }],
        ['POST', '/api/v1/pro/accounting/tax-case-account-mappings', mapping],
        ['POST', '/api/v1/pro/accounting/account-suggestion-rules', rule],
      ];
      for (const [method, path, body] of cases) {
        const viewer = await h.http(method, path, { token: proViewer.token, body: { ...body, reason: 'viewer must not mutate' } });
        assert.equal(viewer.status, 403, `${method} ${path} as viewer`);
        const noReason = await h.http(method, path, { token: p.token, body });
        assert.equal(noReason.status, 400, `${method} ${path} without reason: ${noReason.text.slice(0, 100)}`);
      }
      assert.equal((await h.http('DELETE', '/api/v1/pro/accounting/account-suggestion-rules/rule-1', { token: p.token })).status, 400, 'delete needs a reason');
      assert.equal((await h.http('DELETE', '/api/v1/pro/accounting/account-suggestion-rules/rule-1?reason=weg', { token: proViewer.token })).status, 403);
      const closing = { command: 'fiscal_close', sourceId: 'close-1', sourceRevision: 'v1', reason: 'Abschluss' };
      assert.equal((await h.http('POST', '/api/v1/pro/accounting/closing', { token: proViewer.token, body: { ...closing, idempotencyKey: 'close-key' } })).status, 403);
      assert.equal((await h.http('POST', '/api/v1/pro/accounting/closing', { token: p.token, body: closing })).status, 400, 'a closing without idempotency key');
    });

    test('a booking draft cannot smuggle an approval or posting status', async () => {
      const response = await h.http('POST', '/api/v1/pro/accounting/drafts', { token: p.token, body: {
        reason: 'status guard',
        draft: { id: 'draft-status-guard', tenantId: 'attacker-tenant', transactionId: 'transaction-status-guard', workflowStatus: 'posted', postingDate: '2026-08-12', documentDate: '2026-08-12', bookingText: 'status guard', period: '2026-08', fiscalYear: 2026, lines: [], validationIssues: [], updatedAt: '2026-08-12T00:00:00.000Z' },
      } });
      assert.equal(response.status, 400);
      assert.match(response.text, /workflowStatus is server controlled/i);
    });

    test('Lite EÜR routes validate the calendar year, isolate products and refuse viewers', async () => {
      assert.equal((await h.http('GET', '/api/v1/lite/reports/eur?from=2026-01-01', { token: a.token })).status, 400);
      assert.equal((await h.http('GET', '/api/v1/lite/reports/eur', { token: p.token })).status, 403, 'a Pro token on the Lite report');
      assert.equal((await h.http('GET', '/api/v1/lite/reports/eur')).status, 401);
      const body = { sourceType: 'invoice', sourceId: 'invoice-1', taxYear: 2025, reason: 'Nicht erlaubt' };
      assert.equal((await h.http('PUT', '/api/v1/lite/reports/eur/classifications', { token: viewer.token, body })).status, 403);
      assert.equal((await h.http('PUT', '/api/v1/lite/reports/eur/classifications', { token: a.token, body: { sourceType: 'invoice', sourceId: 'invoice-1', taxYear: 2025 } })).status, 400, 'no reason');
    });

    test('tax filing routes need a Pro login and an accounting role', async () => {
      assert.equal((await h.http('GET', '/api/v1/pro/tax-filings')).status, 401);
      assert.equal((await h.http('GET', '/api/v1/pro/tax-filings', { token: a.token })).status, 403);
      const create = { kind: 'euer', periodStart: '2025-01-01', periodEnd: '2025-12-31', payload: {}, idempotencyKey: 'k1', reason: 'EÜR' };
      assert.equal((await h.http('POST', '/api/v1/pro/tax-filings', { token: proViewer.token, body: create })).status, 403);
      assert.equal((await h.http('POST', '/api/v1/pro/tax-filings', { token: p.token, body: { ...create, periodStart: 'heute' } })).status, 400);
      assert.equal((await h.http('POST', '/api/v1/pro/tax-filings', { token: p.token, body: { ...create, provider: 'unternehmensregister' } })).status, 422, 'a provider that cannot transmit EÜR');
    });

    test('document analysis uses the stored transaction, never the browser\'s copy, and only within the tenant', async () => {
      const analyzed: Array<{ transaction: Record<string, unknown> }> = [];
      const extraction = { documentType: 'invoice', issuer: null, recipient: null, invoiceNumber: 'RE-1', invoiceDate: null, servicePeriod: null, dueDate: null, currency: 'EUR', netAmount: 100, taxAmount: 19, grossAmount: 119, vatBreakdown: [], iban: null, paymentReference: null, suggestedAccountNumber: null, suggestedTaxCase: null, matchAssessment: { amountMatches: true, dateMatches: null, partyMatches: null, referenceMatches: null, notes: [] }, warnings: [], evidence: [] };
      const service = {
        getConfig: () => ({ configured: true, model: 'model-a', models: ['model-a'], maxDocumentBytes: 10_485_760, timeoutMs: 45_000 }),
        analyze: async (input: { transaction: Record<string, unknown> }) => {
          analyzed.push(input);
          return { extraction, deterministicChecks: { amountMatches: true, currencyMatches: true, expectedAmount: 119, extractedAmount: 119, expectedCurrency: 'EUR', extractedCurrency: 'EUR' }, metadata: { model: 'model-a', provider: 'provider-a', requestId: 'request-a', request: { method: 'POST' as const, endpoint: 'https://openrouter.ai/api/v1/chat/completions' }, timing: { startedAt: '2026-08-29T10:00:00.000Z', completedAt: '2026-08-29T10:00:00.100Z', durationMs: 100 }, documentSha256: 'a'.repeat(64) } };
        },
      };
      const vlm = await startHostedServer('server-mode-vlm', { wire: h.wire, recorder: h.recorder, openRouterVlmService: service as never });
      try {
        const other = await seedMember(h.wire, { product: 'pro', email: uniqueEmail('vlm-other'), fullName: 'Other Pro', role: 'owner' });
        const now = new Date().toISOString();
        for (const [tenantId, account, tx, counterparty] of [[p.tenantId, 'vlm-account-p', 'vlm-tx-p', 'Gespeicherter Kunde'], [other.tenantId, 'vlm-account-o', 'vlm-tx-o', 'Fremder Kunde']] as const) {
          await h.wire.sql(`INSERT INTO accounts (id, tenant_id, name, iban, balance, default_skr_account_number, type, color) VALUES ($1, $2, 'Bank', 'DE00000000000000000000', 0, '1200', 'bank', '#000000')`, [account, tenantId]);
          await h.wire.sql(`INSERT INTO bank_transactions (id, tenant_id, account_id, date, amount, type, counterparty, purpose, linked_invoice_id, status, source_transaction_id, created_at, updated_at) VALUES ($1, $2, $3, '2026-08-29', 119, 'income', $4, 'Gespeicherter Zweck', NULL, 'pending', NULL, $5, $5)`, [tx, tenantId, account, counterparty, now]);
        }
        const document = { mimeType: 'image/png', data: 'aA==' };
        const request = (id: string, tx: Record<string, unknown>, token = p.token) => vlm.http('POST', `/api/v1/pro/accounting/transactions/${id}/analyze-document`, { token, body: { transaction: { id, date: '2099-01-01', amount: 1, type: 'expense', counterparty: 'Browser value', purpose: 'Browser value', currency: 'EUR', ...tx }, document } });

        assert.equal((await vlm.http('GET', '/api/v1/pro/accounting/vlm/config')).status, 401);
        assert.deepEqual((await vlm.http('GET', '/api/v1/pro/accounting/vlm/config', { token: p.token })).body.models, ['model-a']);
        const ok = await request('vlm-tx-p', {});
        assert.equal(ok.status, 200, ok.text);
        assert.equal(ok.body.extraction.invoiceNumber, 'RE-1');
        assert.deepEqual({ ...analyzed[0]!.transaction, suggestedAccountNumber: undefined, suggestionReason: undefined }, { id: 'vlm-tx-p', date: '2026-08-29', amount: 119, currency: 'EUR', type: 'income', counterparty: 'Gespeicherter Kunde', purpose: 'Gespeicherter Zweck', suggestedAccountNumber: undefined, suggestionReason: undefined });
        const before = analyzed.length;
        assert.equal((await request('vlm-tx-p', { id: 'another-id' })).status, 400, 'body and path must name the same transaction');
        assert.equal((await request('missing', { id: 'missing' })).status, 404);
        assert.equal((await request('vlm-tx-o', { id: 'vlm-tx-o' })).status, 404, 'another tenant\'s transaction');
        assert.equal((await request('vlm-tx-p', {}, proViewer.token)).status, 200, 'analysis is read-only and does not post anything');
        assert.equal(analyzed.length, before + 1, 'refused requests never reach the model');
        assert.equal((await h.wire.sql(`SELECT 1 FROM journal_entries WHERE tenant_id = $1`, [p.tenantId])).rows.length, 0, 'analysis must not post');
      } finally { await vlm.close(); }
    });

    test('an installed tax certificate is stored encrypted, only an accounting role may install it, and the API never returns it', async () => {
      const saved = [process.env.TAX_FILING_CREDENTIAL_KEY_ID, process.env.TAX_FILING_CREDENTIAL_KEY];
      const pem = '-----BEGIN CERTIFICATE-----\nZmFrZS1jZXJ0aWZpY2F0ZQ==\n-----END CERTIFICATE-----';
      const body = { id: 'cert-it', pem, password: 'zertifikat-passwort', expiresAt: '2030-01-01T00:00:00.000Z', subject: 'IT', reason: 'installieren' };
      try {
        delete process.env.TAX_FILING_CREDENTIAL_KEY;
        assert.equal((await h.http('POST', '/api/v1/pro/tax-filing/certificates', { token: p.token, body })).status, 503, 'no key, no certificate');
        process.env.TAX_FILING_CREDENTIAL_KEY_ID = 'it-key';
        process.env.TAX_FILING_CREDENTIAL_KEY = 'b'.repeat(64);
        assert.equal((await h.http('POST', '/api/v1/pro/tax-filing/certificates', { token: proViewer.token, body })).status, 403);
        const installed = await h.http('POST', '/api/v1/pro/tax-filing/certificates', { token: p.token, body });
        assert.equal(installed.status, 200, installed.text);
        const stored = (await h.wire.sql<{ blob: string; algorithm: string; meta: string }>(`SELECT encode(encrypted_blob, 'escape') AS blob, encryption_algorithm AS algorithm, metadata_json AS meta FROM tax_credentials WHERE tenant_id = $1`, [p.tenantId])).rows;
        assert.equal(stored.length, 1);
        assert.ok(!stored[0]!.blob.includes('BEGIN CERTIFICATE') && !stored[0]!.blob.includes('ZmFrZS1jZXJ0aWZpY2F0ZQ') && !stored[0]!.blob.includes('zertifikat-passwort'), 'the certificate or its password is in the database in clear');
        assert.ok(!stored[0]!.meta.includes('zertifikat-passwort') && !stored[0]!.meta.includes('BEGIN CERTIFICATE'), 'the metadata row carries the secret');
        assert.match(stored[0]!.algorithm, /aes-256-gcm/i);
        const listing = await h.http('GET', '/api/v1/pro/tax-filing/status', { token: p.token });
        assert.ok(!listing.text.includes('zertifikat-passwort') && !listing.text.includes('BEGIN CERTIFICATE'));
        assert.deepEqual((await h.http('GET', '/api/v1/pro/tax-filing/status', { token: a.token })).status, 403, 'a Lite token on the Pro status');
        assert.equal((await h.http('DELETE', '/api/v1/pro/tax-filing/certificates/cert-it?reason=weg', { token: proViewer.token })).status, 403);
        assert.deepEqual((await h.http('DELETE', '/api/v1/pro/tax-filing/certificates/cert-it?reason=weg', { token: p.token })).body, true);
      } finally {
        if (saved[0] === undefined) delete process.env.TAX_FILING_CREDENTIAL_KEY_ID; else process.env.TAX_FILING_CREDENTIAL_KEY_ID = saved[0];
        if (saved[1] === undefined) delete process.env.TAX_FILING_CREDENTIAL_KEY; else process.env.TAX_FILING_CREDENTIAL_KEY = saved[1];
      }
    });

    test('VAT id validation needs a login and keeps non-EU ids out of VIES', async () => {
      const body = { countryCode: 'CH', vatNumber: 'CHE 123 456 789 MWST' };
      assert.equal((await h.http('POST', '/api/v1/lite/tax/validate-vat-id', { body })).status, 401);
      const response = await h.http('POST', '/api/v1/lite/tax/validate-vat-id', { token: a.token, body });
      assert.equal(response.status, 200);
      assert.deepEqual({ status: response.body.status, id: response.body.normalizedVatId }, { status: 'unavailable', id: 'CHE123456789MWST' });
      assert.equal((await h.http('POST', '/api/v1/lite/tax/validate-vat-id', { token: a.token, body: { countryCode: 'CHE', vatNumber: 'x' } })).status, 400);
    });
  });

  describe('server without a database', () => {
    const withoutDatabase = async <T>(secret: string, run: (baseUrl: string, app: Awaited<ReturnType<typeof buildServerApi>>) => Promise<T>) => {
      const saved = { ...process.env };
      delete process.env.DATABASE_URL;
      delete process.env.NODE_ENV;
      try {
        const app = await buildServerApi({ runtime: 'server', logger: false, sessionSecret: secret });
        const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
        try { return await run(baseUrl, app); } finally { await app.close(); }
      } finally {
        for (const key of ['DATABASE_URL', 'NODE_ENV']) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
      }
    };

    test('the API starts for local development with a weak secret, authenticates, and says 503 for everything that needs Postgres', async () => {
      await withoutDatabase('short', async (baseUrl, app) => {
        const post = (path: string, body: unknown, token?: string) => fetch(`${baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
        const lite = await post('/api/v1/lite/auth/bootstrap', { email: 'dev@example.com', password: PASSWORD, fullName: 'Dev' });
        assert.equal(lite.status, 200);
        const { token } = await lite.json() as { token: string };
        assert.equal((await fetch(`${baseUrl}/api/v1/lite/auth/me`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
        const clients = await fetch(`${baseUrl}/api/v1/lite/clients`, { headers: { authorization: `Bearer ${token}` } });
        assert.equal(clients.status, 503);
        assert.match(await clients.text(), /DATABASE_URL is required/);
        assert.equal((await fetch(`${baseUrl}/api/v1/lite/clients`)).status, 401, 'auth comes before the database check');
        assert.equal((await post('/api/v1/lite/auth/bootstrap', { email: 'again@example.com', password: PASSWORD, fullName: 'Again' })).status, 409);
        assert.equal(app.tokenService.verify(token)?.scope.product, 'lite');
      });
    });

    test('the typed server client bootstraps the first owner, then logs in, and reports a wrong password', async () => {
      await withoutDatabase('a-long-enough-development-secret-0123456789', async (baseUrl) => {
        const client = createServerApiClient(baseUrl);
        const input = { product: 'pro' as const, email: 'client@example.com', password: PASSWORD, fullName: 'Client Owner' };
        const first = await client.ensureSession(input);
        assert.deepEqual([first.via, first.product, first.role], ['bootstrap', 'pro', 'owner']);
        const second = await client.ensureSession({ ...input, fullName: 'Ignored' });
        assert.deepEqual([second.via, second.user.id, second.tenantId], ['login', first.user.id, first.tenantId]);
        await assert.rejects(client.ensureSession({ ...input, password: 'wrong-password-1' }), /Invalid email or password/);
        const vat = await client.validateVatId({ token: first.token, product: 'pro', countryCode: 'CH', vatNumber: 'CHE 123.456.789 MWST' });
        assert.equal(vat.status, 'unavailable');
      });
    });
  });

  describe('tenant isolation', () => {
    const clientBody = (id: string, company: string) => newClient({ id, company });
    let aInvoice: Awaited<ReturnType<typeof issueInvoice>>;
    let aDraft: Awaited<ReturnType<typeof draftInvoice>>;
    let aClientId: string;
    let aOfferId: string;

    before(async () => {
      const api = h.liteApi(a.token);
      aClientId = randomUUID();
      await api.clients.upsert({ client: clientBody(aClientId, 'Geheim AG') as never });
      aInvoice = await issueInvoice(api, { client: 'Geheim AG', clientId: aClientId });
      aDraft = await draftInvoice(api, { client: 'Geheim Entwurf' });
      aOfferId = (await draftOffer(api, { client: 'Geheim AG', clientId: aClientId })).id;
    });

    test('tenant B sees none of tenant A\'s data in any list', async () => {
      assert.deepEqual((await h.http('GET', '/api/v1/lite/clients', { token: b.token })).body, []);
      assert.deepEqual((await h.http('GET', '/api/v1/lite/invoices', { token: b.token })).body, []);
      assert.deepEqual((await h.http('GET', '/api/v1/lite/offers', { token: b.token })).body, []);
      const csv = await h.http('GET', '/api/v1/lite/documents/export.csv?kind=invoice', { token: b.token });
      assert.equal(csv.status, 200);
      assert.ok(!csv.text.includes(aInvoice.number) && !csv.text.includes('Geheim'));
      const audit = await h.http('GET', '/api/v1/lite/audit/export.csv', { token: b.token });
      assert.ok(!audit.text.includes(aInvoice.id), 'the audit export of B names A\'s invoice');
      const own = await h.http('GET', '/api/v1/lite/invoices', { token: a.token });
      assert.ok(own.body.some((i: { id: string }) => i.id === aInvoice.id));
    });

    test('reading A\'s documents by id gives B nothing: null for lookups, 404 for exports', async () => {
      for (const path of [`/invoices/${aInvoice.id}`, `/offers/${aOfferId}`, `/clients/${aClientId}`, `/documents/invoice/${aInvoice.id}`, `/documents/offer/${aOfferId}`]) {
        const response = await h.http('GET', `/api/v1/lite${path}`, { token: b.token });
        assert.equal(response.status, 200, `${path}: ${response.text}`);
        assert.equal(response.body, null, `${path} leaked ${response.text.slice(0, 80)}`);
      }
      const exported = await h.http('GET', `/api/v1/lite/documents/invoice/${aInvoice.id}/export.json`, { token: b.token });
      assert.equal(exported.status, 404);
      const chain = await h.http('GET', `/api/v1/lite/document-chain/${aInvoice.id}`, { token: b.token });
      assert.deepEqual(chain.body, []);
      const revisions = await h.http('GET', `/api/v1/lite/document-chain/${aInvoice.id}/revisions`, { token: b.token });
      assert.deepEqual(revisions.body, []);
    });

    test('B cannot delete A\'s client, invoice or offer: 404 and A still has them', async () => {
      for (const path of [`/invoices/${aInvoice.id}`, `/invoices/${aDraft.id}`, `/offers/${aOfferId}`, `/clients/${aClientId}`]) {
        const response = await h.http('DELETE', `/api/v1/lite${path}`, { token: b.token, body: { reason: 'attack' } });
        assert.equal(response.status, 404, `${path}: ${response.text}`);
      }
      const invoices = (await h.http('GET', '/api/v1/lite/invoices', { token: a.token })).body as Array<{ id: string }>;
      assert.ok(invoices.some((i) => i.id === aInvoice.id) && invoices.some((i) => i.id === aDraft.id));
      assert.ok((await h.http('GET', `/api/v1/lite/offers/${aOfferId}`, { token: a.token })).body);
      assert.ok((await h.http('GET', `/api/v1/lite/clients/${aClientId}`, { token: a.token })).body);
    });

    // A tenant picks the ids of its rows itself. Reusing an id that belongs to another tenant must neither
    // change nor move that tenant's row. Invoices are guarded (`setWhere` on tenant_id); the rest are not.
    const takeover: Array<{
      name: string;
      table: string;
      column: string;
      original: string;
      bug?: string;
      create: (token: string, id: string, label: string) => Promise<{ status: number }>;
    }> = [
      {
        name: 'invoice', table: 'invoices', column: 'client', original: 'Geheim Entwurf',
        create: (token, id, label) => h.http('POST', '/api/v1/lite/invoices', { token, body: { reason: 'takeover', invoice: {
          kind: 'invoice', id, number: `ENTWURF-${id.slice(0, 8)}`, client: label, clientEmail: 'h@example.com', date: '2026-10-01', dueDate: '2026-10-15', amount: 1, status: 'draft',
          items: [{ kind: 'item', description: 'x', quantity: 1, price: 1, total: 1 }], payments: [], history: [], taxMode: 'standard_vat',
        } } }),
      },
      {
        name: 'offer', table: 'offers', column: 'client', original: 'Geheim AG',
        bug: 'packages/server-data/src/postgres/billing.ts:1187 offerRepo.save: onConflictDoUpdate(target offers.id) has no tenant guard, so POST /offers with a foreign id moves the row to the caller (status 200)',
        create: (token, id, label) => h.http('POST', '/api/v1/lite/offers', { token, body: { reason: 'takeover', offer: {
          kind: 'offer', id, number: `ANG-${label}`, client: label, clientEmail: 'h@example.com', date: '2026-10-01', validUntil: '2026-11-01', amount: 1, status: 'open', taxMode: 'standard_vat', items: [], history: [],
        } } }),
      },
      {
        name: 'client', table: 'clients', column: 'company', original: 'Geheim AG',
        bug: 'packages/server-data/src/postgres/billing.ts:903 clientRepo.save: onConflictDoUpdate(target clients.id) has no tenant guard, so POST /clients with a foreign id moves the row to the caller (status 200)',
        create: (token, id, label) => h.http('POST', '/api/v1/lite/clients', { token, body: { reason: 'takeover', client: newClient({ id, company: label }) } }),
      },
      {
        name: 'recurring profile', table: 'recurring_profiles', column: 'name', original: 'Abo A',
        bug: 'packages/server-data/src/postgres/billing.ts:1308 recurringProfileRepo.save: onConflictDoUpdate(target recurring_profiles.id) has no tenant guard (status 200)',
        create: async (token, id, label) => {
          const client = newClient({ id: randomUUID(), company: label });
          const saved = await h.http('POST', '/api/v1/lite/clients', { token, body: { reason: 'takeover setup', client } });
          assert.equal(saved.status, 200);
          return h.http('POST', '/api/v1/lite/recurring', { token, body: { reason: 'takeover', profile: {
            id, clientId: client.id, active: true, name: label, interval: 'monthly', nextRun: '2026-12-01', amount: 100, items: [{ kind: 'item', description: 'x', quantity: 1, price: 100, total: 100 }], taxMode: 'standard_vat',
          } } });
        },
      },
      {
        name: 'article', table: 'articles', column: 'title', original: 'Artikel A',
        bug: 'packages/server-data/src/postgres/proAccounting.ts:377 saveServerArticle via the upsert helper at :35: upsert on articles.id without tenant guard (status 200)',
        create: (token, id, label) => h.http('POST', '/api/v1/lite/articles', { token, body: { reason: 'takeover', article: { id, sku: 'S1', title: label, description: '', price: 10, unit: 'Stk', category: 'x', taxRate: 19 } } }),
      },
      {
        name: 'bank account', table: 'accounts', column: 'name', original: 'Konto A',
        bug: 'packages/server-data/src/postgres/proAccounting.ts:419 saveServerBankAccount via the upsert helper at :35: upsert on accounts.id without tenant guard (status 200)',
        create: (token, id, label) => h.http('POST', '/api/v1/lite/accounts', { token, body: { reason: 'takeover', account: { id, name: label, iban: 'DE02120300000000202051', balance: 0, type: 'checking', color: '#111111', transactions: [] } } }),
      },
    ];
    for (const entity of takeover) {
      test(`B reusing the id of A's ${entity.name} neither changes nor moves it`, async () => {
        const id = randomUUID();
        const created = await entity.create(a.token, id, entity.original);
        assert.equal(created.status, 200, `setup: A could not create the ${entity.name}`);
        const attack = await entity.create(b.token, id, `HACKED ${entity.name}`);
        const row = (await h.wire.sql<{ tenant_id: string; value: string }>(`SELECT tenant_id, ${entity.column} AS value FROM ${entity.table} WHERE id = $1`, [id])).rows[0];
        assert.deepEqual({ tenant: row?.tenant_id, value: row?.value }, { tenant: a.tenantId, value: entity.original }, `B's write (status ${attack.status}) took over A's ${entity.name}`);
      });
    }

    test('B cannot delete A\'s article or bank account', async () => {
      const articleId = randomUUID();
      const accountId = randomUUID();
      await h.http('POST', '/api/v1/lite/articles', { token: a.token, body: { reason: 'x', article: { id: articleId, sku: 'S', title: 'Keep me', description: '', price: 1, unit: 'Stk', category: 'x', taxRate: 19 } } });
      await h.http('POST', '/api/v1/lite/accounts', { token: a.token, body: { reason: 'x', account: { id: accountId, name: 'Keep me', iban: 'DE02120300000000202051', balance: 0, type: 'checking', color: '#111111', transactions: [] } } });
      await h.http('DELETE', `/api/v1/lite/articles/${articleId}`, { token: b.token });
      await h.http('DELETE', `/api/v1/lite/accounts/${accountId}`, { token: b.token });
      assert.equal((await h.wire.sql('SELECT 1 FROM articles WHERE id = $1', [articleId])).rows.length, 1);
      assert.equal((await h.wire.sql('SELECT 1 FROM accounts WHERE id = $1', [accountId])).rows.length, 1);
    });

    test('B\'s refused id reuse does not say the id belongs to another tenant', async () => {
      const response = await h.http('POST', '/api/v1/lite/invoices', { token: b.token, body: { reason: 'probe', invoice: {
        kind: 'invoice', id: aDraft.id, number: 'ENTWURF-probe', client: 'Probe', clientEmail: 'p@example.com', date: '2026-10-01', dueDate: '2026-10-15', amount: 1, status: 'draft',
        items: [{ kind: 'item', description: 'Probe', quantity: 1, price: 1, total: 1 }], payments: [], history: [], taxMode: 'standard_vat',
      } } });
      assert.ok(response.status >= 400 && response.status < 500, `status ${response.status}`);
      assert.ok(!/another tenant/i.test(response.text), response.text);
    });

    test('B cannot pay, reverse or dun A\'s invoice', async () => {
      const pay = await h.http('POST', `/api/v1/lite/invoices/${aInvoice.id}/payments`, { token: b.token, body: { reason: 'attack', payment: { id: randomUUID(), date: '2026-10-02', amount: aInvoice.amount, method: 'Bank' } } });
      assert.ok(pay.status >= 400 && pay.status < 500, `${pay.status} ${pay.text}`);
      const stored = (await h.http('GET', `/api/v1/lite/invoices/${aInvoice.id}`, { token: a.token })).body;
      assert.equal(stored.status, 'open');
      assert.deepEqual(stored.payments, []);
    });

    test('B cannot release or finalize A\'s number reservation', async () => {
      const aApi = h.liteApi(a.token);
      const reservation = await aApi.numbers.reserve({ kind: 'invoice' });
      const release = await h.http('POST', '/api/v1/lite/numbers/release', { token: b.token, body: { reservationId: reservation.reservationId } });
      const finalize = await h.http('POST', '/api/v1/lite/numbers/finalize', { token: b.token, body: { reservationId: reservation.reservationId, documentId: randomUUID() } });
      const row = (await h.wire.sql<{ status: string; document_id: string | null }>('SELECT status, document_id FROM number_reservations WHERE id = $1', [reservation.reservationId])).rows[0];
      assert.equal(row?.status, 'reserved', `A's reservation was changed by B (release ${release.status}, finalize ${finalize.status})`);
      assert.equal(row?.document_id, null);
      await aApi.numbers.release({ reservationId: reservation.reservationId });
    });

    test('numbering counters and settings are per tenant', async () => {
      const aApi = h.liteApi(a.token);
      const bApi = h.liteApi(b.token);
      const seq = (n: string) => Number(n.split('-').at(-1));
      const a1 = await aApi.numbers.reserve({ kind: 'invoice' });
      const b1 = await bApi.numbers.reserve({ kind: 'invoice' });
      const a2 = await aApi.numbers.reserve({ kind: 'invoice' });
      const b2 = await bApi.numbers.reserve({ kind: 'invoice' });
      assert.equal(seq(a2.number), seq(a1.number) + 1, 'B\'s reservation between A\'s two must not consume A\'s counter');
      assert.equal(seq(b2.number), seq(b1.number) + 1);
      assert.equal((await bApi.settings.get())!.company.name, 'Bob Handel');
      assert.equal((await aApi.settings.get())!.company.name, 'Muster GmbH');
      for (const [api, r] of [[aApi, a1], [aApi, a2], [bApi, b1], [bApi, b2]] as const) await api.numbers.release({ reservationId: r.reservationId });
    });

    test('projects belong to their tenant: B cannot see, archive or attach to A\'s client projects', async () => {
      const project = { id: randomUUID(), clientId: aClientId, code: 'PRJ-1', name: 'Geheimes Projekt', status: 'active', budget: 1000, startDate: '2026-01-01' };
      const created = await h.http('POST', '/api/v1/lite/projects', { token: a.token, body: { reason: 'anlegen', project } });
      assert.equal(created.status, 200, created.text);
      assert.deepEqual((await h.http('GET', '/api/v1/lite/projects', { token: a.token })).body.map((x: { id: string }) => x.id), [project.id]);
      assert.deepEqual((await h.http('GET', '/api/v1/lite/projects', { token: b.token })).body, []);
      assert.equal((await h.http('GET', `/api/v1/lite/projects/${project.id}`, { token: b.token })).body, null);
      const archive = await h.http('POST', `/api/v1/lite/projects/${project.id}/archive`, { token: b.token, body: { reason: 'attack' } });
      const attach = await h.http('POST', '/api/v1/lite/projects', { token: b.token, body: { reason: 'attack', project: { ...project, id: randomUUID(), name: 'Untergeschoben' } } });
      assert.ok(archive.status >= 400 && attach.status >= 400, `B changed A's projects (archive ${archive.status}, attach ${attach.status})`);
      const stored = (await h.http('GET', `/api/v1/lite/projects/${project.id}`, { token: a.token })).body;
      assert.deepEqual({ name: stored.name, status: stored.status }, { name: 'Geheimes Projekt', status: 'active' });
      assert.equal((await h.http('GET', '/api/v1/lite/projects', { token: a.token })).body.length, 1, 'a foreign project appeared under A\'s client');
    });

    test('archiving or attaching to a foreign project is a 404, not a server error', async () => {
      const mine = { id: randomUUID(), clientId: aClientId, code: 'PRJ-2', name: 'Eigenes Projekt', status: 'active', budget: 1, startDate: '2026-01-01' };
      assert.equal((await h.http('POST', '/api/v1/lite/projects', { token: a.token, body: { reason: 'anlegen', project: mine } })).status, 200);
      assert.equal((await h.http('POST', `/api/v1/lite/projects/${mine.id}/archive`, { token: b.token, body: { reason: 'attack' } })).status, 404);
      assert.equal((await h.http('POST', `/api/v1/lite/projects/${randomUUID()}/archive`, { token: b.token, body: { reason: 'unknown' } })).status, 404);
      assert.equal((await h.http('POST', '/api/v1/lite/projects', { token: b.token, body: { reason: 'attack', project: { ...mine, id: randomUUID() } } })).status, 404);
    });

    test('the audit log of one tenant only holds its own entries', async () => {
      const entries = (await h.wire.sql<{ tenant_id: string; entity_id: string }>(
        `SELECT tenant_id, entity_id FROM audit_log WHERE entity_id = ANY($1)`, [[aInvoice.id, aDraft.id]])).rows;
      assert.ok(entries.length >= 2);
      assert.ok(entries.every((row) => row.tenant_id === a.tenantId), 'an audit row for A\'s invoice carries another tenant id');
    });

    test('the Pro tenant is a separate world from the Lite tenants', async () => {
      const pro = h.proApi(p.token);
      assert.deepEqual(await pro.clients.list(), []);
      assert.deepEqual((await h.http('GET', '/api/v1/pro/invoices', { token: p.token })).body, []);
      const viaPro = await h.http('GET', `/api/v1/pro/invoices/${aInvoice.id}`, { token: p.token });
      assert.equal(viaPro.body, null);
    });
  });

  describe('roles', () => {
    // requireMutationCapability: owner, admin and accountant mutate; sales and viewer only read.
    const writers = () => [['owner', a.token], ['admin', admin.token], ['accountant', accountant.token]] as const;
    const readers = () => [['viewer', viewer.token], ['sales', sales.token]] as const;
    const lite = '/api/v1/lite';
    const draft = (id: string, label = 'Rollen GmbH') => ({
      kind: 'invoice', id, number: `ENTWURF-${id.slice(0, 8)}`, client: label, clientEmail: 'r@example.com', date: '2026-10-01', dueDate: '2026-10-15', amount: 1, status: 'draft',
      items: [{ kind: 'item', description: 'x', quantity: 1, price: 1, total: 1 }], payments: [], history: [], taxMode: 'standard_vat',
    });
    const offer = (id: string) => ({ kind: 'offer', id, number: `ANG-R-${id.slice(0, 6)}`, client: 'Rollen GmbH', clientEmail: 'r@example.com', date: '2026-10-01', validUntil: '2026-11-01', amount: 1, status: 'open', taxMode: 'standard_vat', items: [], history: [] });

    // Each case acts on a row the owner owns, so a refused call is refused for its role, not for a missing row.
    const cases: Array<{ name: string; bug?: string; act: (token: string, owner: Record<'clientId' | 'invoiceId' | 'offerId' | 'recurringId' | 'articleId' | 'accountId', string>) => Promise<{ status: number }> }> = [
      { name: 'POST /clients', bug: 'POST /clients uses requireSession instead of requireMutationSessionFor (packages/server-runtime/src/app.ts:348)', act: (t) => h.http('POST', `${lite}/clients`, { token: t, body: { reason: 'role', client: newClient() } }) },
      { name: 'DELETE /clients/:id', bug: 'DELETE /clients/:id uses requireSession (packages/server-runtime/src/app.ts:397)', act: (t, o) => h.http('DELETE', `${lite}/clients/${o.clientId}`, { token: t, body: { reason: 'role' } }) },
      { name: 'POST /invoices', act: (t) => h.http('POST', `${lite}/invoices`, { token: t, body: { reason: 'role', invoice: draft(randomUUID()) } }) },
      { name: 'DELETE /invoices/:id', bug: 'DELETE /invoices/:id uses requireSession (packages/server-runtime/src/app.ts:662)', act: (t, o) => h.http('DELETE', `${lite}/invoices/${o.invoiceId}`, { token: t, body: { reason: 'role' } }) },
      { name: 'POST /invoices/:id/payments', act: (t, o) => h.http('POST', `${lite}/invoices/${o.invoiceId}/payments`, { token: t, body: { reason: 'role', payment: { id: randomUUID(), date: '2026-10-02', amount: 1, method: 'Bank' } } }) },
      { name: 'POST /offers', act: (t) => h.http('POST', `${lite}/offers`, { token: t, body: { reason: 'role', offer: offer(randomUUID()) } }) },
      { name: 'DELETE /offers/:id', bug: 'DELETE /offers/:id uses requireSession (packages/server-runtime/src/app.ts:757)', act: (t, o) => h.http('DELETE', `${lite}/offers/${o.offerId}`, { token: t, body: { reason: 'role' } }) },
      { name: 'POST /recurring', bug: 'POST /recurring uses requireSession (packages/server-runtime/src/app.ts:807)', act: (t, o) => h.http('POST', `${lite}/recurring`, { token: t, body: { reason: 'role', profile: { id: o.recurringId, clientId: o.clientId, active: true, name: 'Abo', interval: 'monthly', nextRun: '2026-12-01', amount: 1, items: [{ kind: 'item', description: 'x', quantity: 1, price: 1, total: 1 }], taxMode: 'standard_vat' } } }) },
      { name: 'DELETE /recurring/:id', bug: 'DELETE /recurring/:id uses requireSession (packages/server-runtime/src/app.ts:844)', act: (t, o) => h.http('DELETE', `${lite}/recurring/${o.recurringId}`, { token: t, body: { reason: 'role' } }) },
      { name: 'PUT /settings', bug: 'PUT /settings uses requireSession, a viewer can rewrite company, bank and numbering settings (packages/server-runtime/src/app.ts:887)', act: async (t) => {
        const current = (await h.http('GET', `${lite}/settings`, { token: a.token })).body;
        return h.http('PUT', `${lite}/settings`, { token: t, body: { reason: 'role', settings: current } });
      } },
      { name: 'POST /articles', bug: 'POST /articles uses requireSession (packages/server-runtime/src/app.ts:1073)', act: (t) => h.http('POST', `${lite}/articles`, { token: t, body: { reason: 'role', article: { id: randomUUID(), sku: 'S', title: 'Rolle', description: '', price: 1, unit: 'Stk', category: 'x', taxRate: 19 } } }) },
      { name: 'DELETE /articles/:id', bug: 'DELETE /articles/:id uses requireSession (packages/server-runtime/src/app.ts:1095)', act: (t, o) => h.http('DELETE', `${lite}/articles/${o.articleId}`, { token: t }) },
      { name: 'POST /accounts', bug: 'POST /accounts uses requireSession (packages/server-runtime/src/app.ts:1117)', act: (t) => h.http('POST', `${lite}/accounts`, { token: t, body: { reason: 'role', account: { id: randomUUID(), name: 'Rolle', iban: 'DE02120300000000202051', balance: 0, type: 'checking', color: '#111111', transactions: [] } } }) },
      { name: 'DELETE /accounts/:id', bug: 'DELETE /accounts/:id uses requireSession (packages/server-runtime/src/app.ts:1138)', act: (t, o) => h.http('DELETE', `${lite}/accounts/${o.accountId}`, { token: t }) },
      { name: 'POST /numbers/reserve', act: (t) => h.http('POST', `${lite}/numbers/reserve`, { token: t, body: { kind: 'invoice' } }) },
    ];

    const prepare = async () => {
      const owner: Record<'clientId' | 'invoiceId' | 'offerId' | 'recurringId' | 'articleId' | 'accountId', string> = { clientId: randomUUID(), invoiceId: randomUUID(), offerId: randomUUID(), recurringId: randomUUID(), articleId: randomUUID(), accountId: randomUUID() };
      await h.http('POST', `${lite}/clients`, { token: a.token, body: { reason: 'prep', client: newClient({ id: owner.clientId, company: 'Rollen Kunde' }) } });
      await h.http('POST', `${lite}/invoices`, { token: a.token, body: { reason: 'prep', invoice: { ...draft(owner.invoiceId), status: 'draft' } } });
      await h.http('POST', `${lite}/offers`, { token: a.token, body: { reason: 'prep', offer: offer(owner.offerId) } });
      await h.http('POST', `${lite}/recurring`, { token: a.token, body: { reason: 'prep', profile: { id: owner.recurringId, clientId: owner.clientId, active: true, name: 'Abo', interval: 'monthly', nextRun: '2026-12-01', amount: 1, items: [{ kind: 'item', description: 'x', quantity: 1, price: 1, total: 1 }], taxMode: 'standard_vat' } } });
      await h.http('POST', `${lite}/articles`, { token: a.token, body: { reason: 'prep', article: { id: owner.articleId, sku: 'S', title: 'Artikel', description: '', price: 1, unit: 'Stk', category: 'x', taxRate: 19 } } });
      await h.http('POST', `${lite}/accounts`, { token: a.token, body: { reason: 'prep', account: { id: owner.accountId, name: 'Konto', iban: 'DE02120300000000202051', balance: 0, type: 'checking', color: '#111111', transactions: [] } } });
      return owner;
    };

    // A draft invoice cannot take payments (409), so the payment case needs an issued one.
    for (const entry of cases) {
      test(`${entry.name} is refused to viewer and sales`, {}, async () => {
        const owner = await prepare();
        if (entry.name.includes('payments')) {
          const invoice = await issueInvoice(h.liteApi(a.token), { client: 'Rollen Zahlung' });
          owner.invoiceId = invoice.id;
        }
        for (const [role, token] of readers()) {
          const response = await entry.act(token, owner);
          assert.equal(response.status, 403, `${role} got ${response.status} on ${entry.name}`);
        }
      });
    }

    test('owner, admin and accountant can do what viewer and sales cannot', async () => {
      for (const [role, token] of writers()) {
        const client = await h.http('POST', `${lite}/clients`, { token, body: { reason: 'role', client: newClient({ company: `Von ${role}` }) } });
        assert.equal(client.status, 200, `${role}: ${client.text}`);
        const invoice = await h.http('POST', `${lite}/invoices`, { token, body: { reason: 'role', invoice: draft(randomUUID(), `Von ${role}`) } });
        assert.equal(invoice.status, 200, `${role}: ${invoice.text}`);
        const reserve = await h.http('POST', `${lite}/numbers/reserve`, { token, body: { kind: 'offer' } });
        assert.equal(reserve.status, 200, `${role}: ${reserve.text}`);
        await h.http('POST', `${lite}/numbers/release`, { token, body: { reservationId: reserve.body.reservationId } });
      }
    });

    test('everyone in the tenant can read, including viewer and sales', async () => {
      for (const [role, token] of [...writers(), ...readers()]) {
        for (const path of ['/clients', '/invoices', '/offers', '/recurring', '/articles', '/accounts']) {
          const response = await h.http('GET', `${lite}${path}`, { token });
          assert.equal(response.status, 200, `${role} GET ${path}: ${response.text.slice(0, 100)}`);
        }
      }
    });

    test('viewer and sales can read the settings', async () => {
      for (const [role, token] of readers()) {
        const response = await h.http('GET', `${lite}/settings`, { token });
        assert.equal(response.status, 200, `${role} GET /settings -> ${response.status}`);
      }
    });

    test('a mutation by an accountant is attributed to that accountant in the audit log', async () => {
      const id = randomUUID();
      await h.http('POST', `${lite}/invoices`, { token: accountant.token, body: { reason: 'Buchhaltung', invoice: draft(id, 'Audit Akteur') } });
      const row = (await h.wire.sql<{ actor: string; reason: string }>(`SELECT actor::text AS actor, reason FROM audit_log WHERE entity_id = $1 AND action = 'invoice.create'`, [id])).rows[0];
      assert.ok(row, 'no audit row');
      assert.match(row.actor, /accountant user/);
      assert.equal(row.reason, 'Buchhaltung');
    });

    test('mutations without a reason are refused', async () => {
      for (const body of [{ client: newClient() }, { reason: '   ', client: newClient() }]) {
        assert.equal((await h.http('POST', `${lite}/clients`, { token: a.token, body })).status, 400);
      }
      assert.equal((await h.http('POST', `${lite}/invoices`, { token: a.token, body: { reason: '', invoice: draft(randomUUID()) } })).status, 400);
    });
  });

  describe('error feedback', () => {
    test('a number that is already used is a 409 and never echoes SQL or parameters', async () => {
      const api = h.liteApi(a.token);
      const first = await issueInvoice(api, { client: 'Doppelte Nummer' });
      const second = await h.http('POST', '/api/v1/lite/invoices', { token: a.token, body: { reason: 'duplicate', invoice: {
        kind: 'invoice', id: randomUUID(), number: first.number, client: 'Duplikat', clientEmail: 'd@example.com', date: '2026-10-01', dueDate: '2026-10-15', amount: 1, status: 'draft',
        items: [{ kind: 'item', description: 'x', quantity: 1, price: 1, total: 1 }], payments: [], history: [], taxMode: 'standard_vat',
      } } });
      assert.equal(second.status, 409, second.text.slice(0, 160));
      assert.ok(!/insert into|params:|Failed query/i.test(second.text), 'the response contains the failed SQL');
    });

    test('a malformed JSON body is a 400', async () => {
      const bad = await fetch(`${h.baseUrl}/api/v1/lite/clients`, { method: 'POST', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' }, body: '{"reason": ' });
      assert.equal(bad.status, 400);
    });

    test('unknown routes are 404 and schema violations are 400 with the first issue as message', async () => {
      assert.equal((await h.http('GET', '/api/v1/lite/does-not-exist', { token: a.token })).status, 404);
      const invalid = await h.http('POST', '/api/v1/lite/clients', { token: a.token, body: { reason: 'x', client: { id: randomUUID() } } });
      assert.equal(invalid.status, 400);
      assert.ok(typeof invalid.body.message === 'string' && Array.isArray(invalid.body.issues));
    });
  });

  describe('CLI device login', () => {
    let c: HostedServer;
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const lite = '/api/v1/lite';
    // Pending logins and the start throttle live in the API process, so every test gets a fresh instance on the same data.
    beforeEach(async () => { c = await startHostedServer('server-mode-cli', { wire: h.wire, recorder: h.recorder }); });
    afterEach(async () => { await c.close(); });

    const start = async (label: string, scope: 'full' | 'read' = 'full', product: 'lite' | 'pro' = 'lite') => {
      const response = await c.http('POST', '/api/v1/auth/device/start', { body: { product, label, scope } });
      assert.equal(response.status, 200, response.text);
      return response.body as { deviceCode: string; userCode: string; expiresIn: number; interval: number };
    };
    const decide = (approver: string, code: string, approve: boolean, product: 'lite' | 'pro' = 'lite') =>
      c.http('POST', `/api/v1/${product}/cli-access/decide`, { token: approver, body: { code, approve } });
    const poll = (deviceCode: string) => c.http('POST', '/api/v1/auth/device/token', { body: { deviceCode } });
    /** The whole dance: start, a person approves in the app, the CLI polls once. */
    const login = async (label: string, scope: 'full' | 'read' = 'full', approver = a.token) => {
      const device = await start(label, scope);
      assert.equal((await decide(approver, device.userCode, true)).status, 200);
      const approved = await poll(device.deviceCode);
      assert.equal(approved.body.status, 'approved', approved.text);
      return { token: approved.body.token as string, user: approved.body.user as { id: string }, device };
    };

    test('start needs no login and hands out a spaced, unambiguous code', async () => {
      const device = await start('first');
      assert.match(device.userCode, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/, 'no 0/O/1/I in a code that is typed off a screen');
      assert.equal(device.expiresIn, 600);
      assert.ok(device.deviceCode.length >= 40);
      assert.notEqual((await start('second')).deviceCode, device.deviceCode);
    });

    test('a browser (Origin header) can neither start nor poll a login', async () => {
      const origin = { origin: 'https://evil.example' };
      const started = await c.http('POST', '/api/v1/auth/device/start', { body: { product: 'lite', label: 'xss', scope: 'full' }, headers: origin });
      assert.equal(started.status, 403);
      const device = await start('victim');
      const polled = await c.http('POST', '/api/v1/auth/device/token', { body: { deviceCode: device.deviceCode }, headers: origin });
      assert.equal(polled.status, 403);
    });

    test('bad start requests are 400', async () => {
      for (const body of [{ product: 'lite', label: '', scope: 'full' }, { product: 'lite', label: 'x', scope: 'root' }, { product: 'enterprise', label: 'x' }, { label: 'x' }]) {
        const response = await c.http('POST', '/api/v1/auth/device/start', { body });
        assert.equal(response.status, 400, JSON.stringify(body));
      }
    });

    test('pending until a person decides, polling too fast is 429, an unknown device code is expired', async () => {
      const device = await start('pending-check');
      const first = await poll(device.deviceCode);
      assert.equal(first.body.status, 'pending');
      assert.equal((await poll(device.deviceCode)).status, 429, 'second poll inside the minimum gap');
      assert.equal((await poll('does-not-exist')).body.status, 'expired');
      assert.equal((await c.http('POST', '/api/v1/auth/device/token', { body: {} })).status, 400);
    });

    test('only a signed-in person can look at or decide a request; the code is matched per product', async () => {
      const device = await start('who-decides');
      const bare = await c.http('POST', `${lite}/cli-access/decide`, { body: { code: device.userCode, approve: true } });
      assert.equal(bare.status, 401);
      const pending = await c.http('GET', `${lite}/cli-access/pending?code=${device.userCode.toLowerCase().replace('-', ' ')}`, { token: a.token });
      assert.equal(pending.status, 200);
      assert.equal(pending.body.label, 'who-decides');
      assert.equal(pending.body.scope, 'full');
      const otherProduct = await c.http('GET', '/api/v1/pro/cli-access/pending?code=' + device.userCode, { token: p.token });
      assert.equal(otherProduct.body, null, 'a Pro session must not see a Lite request');
      assert.equal((await decide(p.token, device.userCode, true, 'pro')).status, 404);
      assert.equal((await decide(a.token, 'ZZZZ-9999', true)).status, 404);
      assert.equal((await poll(device.deviceCode)).body.status, 'pending', 'the failed decisions changed nothing');
    });

    test('an approved login yields one token, once; denied and spent device codes are dead', async () => {
      const denied = await start('denied');
      assert.equal((await decide(a.token, denied.userCode, false)).status, 200);
      assert.equal((await poll(denied.deviceCode)).body.status, 'denied');
      await sleep(1100);
      assert.equal((await poll(denied.deviceCode)).body.status, 'expired');

      const { token, device } = await login('approved');
      assert.match(token, /^billme_cli_/);
      await sleep(1100);
      assert.equal((await poll(device.deviceCode)).body.status, 'expired', 'a device code is spent after its answer');
      assert.equal((await decide(a.token, device.userCode, true)).status, 404, 'and cannot be approved again');
    });

    test('the token works as that user, is stored only as a hash and shows up in the token list without its secret', async () => {
      const { token } = await login('ci-laptop');
      assert.equal((await c.http('GET', `${lite}/clients`, { token })).status, 200);
      const me = await c.http('GET', `${lite}/auth/me`, { token });
      assert.equal(me.status, 200);
      assert.equal(me.body.user.email, a.email);
      assert.equal(me.body.tenantId, a.tenantId);

      const rows = (await h.wire.sql<{ id: string; token_hash: string; label: string }>('SELECT id, token_hash, label FROM cli_tokens WHERE label = $1', ['ci-laptop'])).rows;
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.token_hash, createHash('sha256').update(token).digest('hex'));
      const everything = JSON.stringify((await h.wire.sql('SELECT * FROM cli_tokens')).rows);
      assert.ok(!everything.includes(token), 'the plain token is in the table');

      const list = await c.http('GET', `${lite}/cli-access/tokens`, { token: a.token });
      assert.equal(list.status, 200);
      const entry = list.body.find((t: { id: string }) => t.id === rows[0]!.id);
      assert.deepEqual(Object.keys(entry).sort().filter((k) => k !== 'lastUsedAt'), ['createdAt', 'id', 'label', 'product', 'scope']);
    });

    test('a read-only token reads but cannot write; it may revoke itself', async () => {
      const { token } = await login('read-only', 'read');
      assert.equal((await c.http('GET', `${lite}/invoices`, { token })).status, 200);
      for (const [method, path, body] of [
        ['POST', `${lite}/clients`, { reason: 'x', client: newClient() }],
        ['POST', `${lite}/numbers/reserve`, { kind: 'invoice' }],
        ['PUT', `${lite}/settings`, { reason: 'x', settings: {} }],
        ['DELETE', `${lite}/invoices/${randomUUID()}`, { reason: 'x' }],
      ] as const) {
        const response = await c.http(method, path, { token, body });
        assert.equal(response.status, 403, `${method} ${path}`);
        assert.match(response.body.message, /read-only/);
      }
      assert.equal((await c.http('POST', `${lite}/cli-access/revoke-self`, { token })).status, 200);
      assert.equal((await c.http('GET', `${lite}/invoices`, { token })).status, 401);
    });

    test('a CLI token cannot approve requests or manage tokens, not even a full one', async () => {
      const { token } = await login('greedy', 'full');
      const device = await start('minted-by-cli');
      assert.equal((await c.http('POST', `${lite}/cli-access/decide`, { token, body: { code: device.userCode, approve: true } })).status, 403);
      const list = await c.http('GET', `${lite}/cli-access/tokens`, { token });
      assert.equal(list.status, 403);
      assert.match(list.body.message, /managed in the app/);
      assert.equal((await c.http('DELETE', `${lite}/cli-access/tokens/${randomUUID()}`, { token })).status, 403);
      assert.equal((await c.http('GET', `${lite}/cli-access/pending?code=${device.userCode}`, { token })).status, 403);
    });

    test('a revoked token dies at once and revoking twice is a 404', async () => {
      const { token } = await login('to-revoke');
      const id = (await h.wire.sql<{ id: string }>('SELECT id FROM cli_tokens WHERE label = $1', ['to-revoke'])).rows[0]!.id;
      assert.equal((await c.http('GET', `${lite}/clients`, { token })).status, 200);
      assert.equal((await c.http('DELETE', `${lite}/cli-access/tokens/${id}`, { token: a.token })).status, 200);
      const after = await c.http('GET', `${lite}/clients`, { token });
      assert.equal(after.status, 401);
      assert.match(after.body.message, /Invalid or revoked/);
      assert.equal((await c.http('DELETE', `${lite}/cli-access/tokens/${id}`, { token: a.token })).status, 404);
      assert.equal((await c.http('GET', `${lite}/clients`, { token: 'billme_cli_madeupmadeupmadeupmadeupmadeupmadeup' })).status, 401);
    });

    test('tokens are bound to their tenant and product', async () => {
      const { token } = await login('tenant-bound');
      const id = (await h.wire.sql<{ id: string }>('SELECT id FROM cli_tokens WHERE label = $1', ['tenant-bound'])).rows[0]!.id;
      assert.equal((await c.http('GET', '/api/v1/pro/clients', { token })).status, 403, 'a Lite token on a Pro route');
      assert.deepEqual((await c.http('GET', `${lite}/cli-access/tokens`, { token: b.token })).body.map((t: { id: string }) => t.id).filter((x: string) => x === id), []);
      assert.equal((await c.http('DELETE', `${lite}/cli-access/tokens/${id}`, { token: b.token })).status, 404, 'tenant B must not revoke A\'s token');
      assert.deepEqual((await c.http('GET', `${lite}/invoices`, { token })).body.filter((i: { client: string }) => i.client === 'Bob Handel'), []);
    });

    test('the role at use time counts: a demoted or disabled user\'s token follows at once', async () => {
      const email = uniqueEmail('cli-user');
      await seedMember(h.wire, { product: 'lite', email, fullName: 'CLI User', role: 'accountant', tenantId: a.tenantId });
      const session = await h.login('lite', email);
      const { token } = await login('role-follows', 'full', session.token);
      const reserve = await c.http('POST', `${lite}/numbers/reserve`, { token, body: { kind: 'offer' } });
      assert.equal(reserve.status, 200, reserve.text);
      await c.http('POST', `${lite}/numbers/release`, { token, body: { reservationId: reserve.body.reservationId } });

      await h.wire.sql(`UPDATE tenant_memberships SET role = 'viewer' WHERE user_id = $1`, [session.user.id]);
      assert.equal((await c.http('POST', `${lite}/numbers/reserve`, { token, body: { kind: 'offer' } })).status, 403, 'demoted to viewer');
      assert.equal((await c.http('GET', `${lite}/invoices`, { token })).status, 200, 'still reads');

      await h.wire.sql(`UPDATE user_accounts SET status = 'disabled' WHERE id = $1`, [session.user.id]);
      assert.equal((await c.http('GET', `${lite}/invoices`, { token })).status, 401, 'a disabled user\'s token is dead');
    });

    test('writes through a CLI token are attributed to the CLI in the audit log', async () => {
      const { token } = await login('audit-bot');
      const id = randomUUID();
      const created = await c.http('POST', `${lite}/clients`, { token, body: { reason: 'per CLI', client: newClient({ id, company: 'Per CLI' }) } });
      assert.equal(created.status, 200, created.text);
      const row = (await h.wire.sql<{ actor: string }>(`SELECT actor::text AS actor FROM audit_log WHERE entity_id = $1 AND action = 'client.create'`, [id])).rows[0];
      assert.match(row!.actor, /\(CLI: audit-bot\)/);
      const verify = await c.http('GET', `${lite}/audit/verify`, { token: a.token });
      assert.equal(verify.status, 200);
      assert.equal(verify.body.ok, true, 'the hash chain still verifies');
    });

    test('starts are throttled per address', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 14; i += 1) {
        statuses.push((await c.http('POST', '/api/v1/auth/device/start', { body: { product: 'lite', label: `flood-${i}`, scope: 'read' } })).status);
      }
      assert.ok(statuses.includes(429), `14 starts in a row: ${statuses}`);
      assert.equal(statuses[statuses.indexOf(429) - 1], 200);
    });
  });

  describe('PDF route', () => {
    let calls: Array<Parameters<NonNullable<Parameters<typeof startHostedServer>[1]>['renderDocumentPdf'] & {}>[0]>;
    let r: HostedServer;
    before(async () => {
      calls = [];
      r = await startHostedServer('server-mode-pdf', {
        wire: h.wire,
        recorder: h.recorder,
        renderDocumentPdf: async (args) => { calls.push(args); return { bytes: new TextEncoder().encode('%PDF-1.7 stub'), fileName: 'Rechnung RE-1.pdf' }; },
      });
    });
    after(async () => { await r.close(); });

    test('without a renderer the route says so (501) after checking the login', async () => {
      assert.equal((await h.http('GET', '/api/v1/lite/documents/invoice/x/pdf')).status, 401);
      const response = await h.http('GET', '/api/v1/lite/documents/invoice/x/pdf', { token: a.token });
      assert.equal(response.status, 501);
      assert.match(response.body.message, /not configured/);
    });

    test('the renderer gets a short-lived session of the caller, not the caller\'s own token', async () => {
      calls.length = 0;
      const response = await r.http('GET', '/api/v1/lite/documents/invoice/inv-1/pdf?level=2', { token: a.token });
      assert.equal(response.status, 200, response.text);
      assert.equal(response.headers.get('content-type'), 'application/pdf');
      assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename\*=UTF-8''Rechnung%20RE-1\.pdf/);
      assert.ok(response.text.startsWith('%PDF'));
      assert.equal(calls.length, 1);
      const call = calls[0]!;
      assert.equal(call.product, 'lite');
      assert.deepEqual(call.print, { kind: 'invoice', id: 'inv-1', level: 2 });
      assert.equal(call.user.email, a.email);
      assert.notEqual(call.token, a.token);
      const session = r.app.tokenService.verify(call.token)!;
      assert.equal(session.scope.tenantId, a.tenantId);
      assert.equal(session.scope.product, 'lite');
      const claims = JSON.parse(Buffer.from(call.token.split('.')[0]!, 'base64url').toString('utf8'));
      assert.ok(claims.exp - claims.iat <= 60, 'the render session lives at most a minute');
    });

    test('the render session cannot read another tenant', async () => {
      calls.length = 0;
      const aInvoice = await issueInvoice(h.liteApi(a.token), { client: 'PDF Geheim' });
      await r.http('GET', `/api/v1/lite/documents/invoice/${aInvoice.id}/pdf`, { token: b.token });
      const renderToken = calls[0]!.token;
      assert.equal(r.app.tokenService.verify(renderToken)!.scope.tenantId, b.tenantId);
      const peek = await r.http('GET', `/api/v1/lite/invoices/${aInvoice.id}`, { token: renderToken });
      assert.equal(peek.body, null, 'the PDF render session of B read A\'s invoice');
    });

    test('unauthenticated, wrong-product and malformed requests never reach the renderer', async () => {
      calls.length = 0;
      assert.equal((await r.http('GET', '/api/v1/lite/documents/invoice/x/pdf')).status, 401);
      assert.equal((await r.http('GET', '/api/v1/pro/documents/invoice/x/pdf', { token: a.token })).status, 403);
      assert.equal((await r.http('GET', '/api/v1/lite/documents/receipt/x/pdf', { token: a.token })).status, 400);
      assert.equal((await r.http('GET', '/api/v1/lite/documents/invoice/x/pdf?level=0', { token: a.token })).status, 400);
      assert.equal((await r.http('GET', '/api/v1/lite/reports/eur/pdf?taxYear=2019', { token: a.token })).status, 400);
      assert.equal(calls.length, 0);
    });
  });
});

describe('database outage', () => {
  test('a restart of the database neither crashes the API nor leaves it broken', async () => {
    const server = await startHostedServer('server-mode-outage');
    try {
      const owner = await server.bootstrap('lite', uniqueEmail('outage'));
      assert.equal((await server.http('GET', '/api/v1/lite/clients', { token: owner.token })).status, 200);
      const { errors } = await captureUncaught(async () => { server.wire.dropConnections(); });
      assert.deepEqual(errors.map((error) => error.message), [], 'the process would have died');
      const after = await server.http('GET', '/api/v1/lite/clients', { token: owner.token });
      assert.equal(after.status, 200, 'the pool must reconnect');
    } finally { await server.close(); }
  });
});

describe('serializable transactions', () => {
  test('a serialization failure is retried with a clean slate, a business error is not, and the attempts are bounded', async () => {
    const wire = await startPgliteWire({ migrate: true });
    const pool = serverData.createPostgresPool(wire.url);
    try {
      await wire.sql('CREATE TABLE tx_probe (id TEXT PRIMARY KEY, attempt INTEGER NOT NULL)');
      const failWith = (client: { query: (sql: string) => Promise<unknown> }, code: string) =>
        client.query(`DO $$ BEGIN RAISE EXCEPTION 'probe failure' USING ERRCODE = '${code}'; END $$`);

      let attempts = 0;
      const result = await serverData.withSerializablePostgresTransaction(pool, async (client) => {
        attempts += 1;
        await client.query('INSERT INTO tx_probe (id, attempt) VALUES ($1, $2)', ['row', attempts]);
        if (attempts < 3) await failWith(client, '40001');
        return `committed after ${attempts}`;
      });
      assert.equal(result, 'committed after 3');
      assert.deepEqual((await wire.sql('SELECT id, attempt FROM tx_probe')).rows, [{ id: 'row', attempt: 3 }], 'the failed attempts must leave nothing behind');

      attempts = 0;
      await assert.rejects(serverData.withSerializablePostgresTransaction(pool, async (client) => {
        attempts += 1;
        await client.query('INSERT INTO tx_probe (id, attempt) VALUES ($1, $2)', [`dup-${attempts}`, attempts]);
        await failWith(client, '23505');
      }), /probe failure/);
      assert.equal(attempts, 1, 'a unique violation is a business error, not contention');
      assert.equal((await wire.sql('SELECT 1 FROM tx_probe WHERE id LIKE $1', ['dup-%'])).rows.length, 0);

      attempts = 0;
      await assert.rejects(serverData.withSerializablePostgresTransaction(pool, async (client) => { attempts += 1; await failWith(client, '40P01'); }), /probe failure/);
      assert.equal(attempts, 5, 'deadlocks are retried, but not forever');
    } finally { await pool.end(); await wire.close(); }
  });
});

/**
 * The Drizzle migration tree is the only way an existing deployed database
 * advances (AGENTS.md). These checks fail when the journal and the .sql files
 * drift apart, when a table or column the code declares is not created by the
 * migrations, when the embedded and the hosted migrator build different schemas,
 * or when a database that is a few migrations behind cannot be brought current.
 */
describe('server-data migrations', () => {
  const drizzleDir = join(repoRoot, 'packages', 'server-data', 'drizzle');
  const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
  const sqlTags = readdirSync(drizzleDir).filter((file) => file.endsWith('.sql')).map((file) => file.replace(/\.sql$/, '')).sort();
  const serverDataRequire = createRequire(join(repoRoot, 'packages', 'server-data', 'package.json'));
  const schemaSnapshot = async (wire: Awaited<ReturnType<typeof startPgliteWire>>) => ({
    columns: (await wire.sql(`SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, column_name`)).rows,
    indexes: (await wire.sql(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname`)).rows,
    constraints: (await wire.sql(`SELECT conrelid::regclass::text AS tbl, conname, contype FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2`)).rows,
  });
  const migrationCount = async (wire: Awaited<ReturnType<typeof startPgliteWire>>) =>
    Number((await wire.sql<{ n: string }>('SELECT count(*) AS n FROM drizzle.__drizzle_migrations')).rows[0]!.n);

  test('the journal and the SQL files list exactly the same migrations, in order', () => {
    const tags = journal.entries.map((entry) => entry.tag);
    assert.deepEqual([...tags].sort(), sqlTags, 'a migration without a journal entry is never applied; an entry without a file breaks the migrator');
    assert.deepEqual(tags, [...tags].sort(), 'journal order is the numeric order of the files');
    assert.deepEqual(journal.entries.map((entry) => entry.idx), journal.entries.map((entry) => Number(entry.tag.slice(0, 4))), 'idx is the number in the file name (a retired number such as 0020 may stay a hole)');
    const whens = journal.entries.map((entry) => entry.when);
    assert.deepEqual(whens, [...whens].sort((x, y) => x - y), 'drizzle applies by "when": a later file with an earlier timestamp is skipped on upgraded databases');
    assert.equal(new Set(whens).size, whens.length, 'two migrations share one timestamp');
    const prefixes = tags.map((tag) => tag.slice(0, 4));
    assert.equal(new Set(prefixes).size, prefixes.length, 'two migrations share a number');
    for (const tag of tags) assert.ok(readFileSync(join(drizzleDir, `${tag}.sql`), 'utf8').trim().length > 0, `${tag}.sql is empty`);
  });

  test('migrating an empty database creates every table the SQL files create and records every journal entry', async () => {
    const wire = await startPgliteWire({ migrate: false });
    try {
      await wire.database.migrate();
      await wire.database.assertCurrent();
      assert.equal(await migrationCount(wire), journal.entries.length);
      const latest = Number((await wire.sql<{ m: string }>('SELECT max(created_at) AS m FROM drizzle.__drizzle_migrations')).rows[0]!.m);
      assert.equal(latest, Math.max(...journal.entries.map((entry) => entry.when)));

      const created = new Set<string>();
      for (const tag of sqlTags) {
        const sql = readFileSync(join(drizzleDir, `${tag}.sql`), 'utf8');
        for (const match of sql.matchAll(/CREATE TABLE(?: IF NOT EXISTS)?\s+"?([a-z_0-9]+)"?/gi)) created.add(match[1]!.toLowerCase());
        for (const match of sql.matchAll(/DROP TABLE(?: IF EXISTS)?\s+"?([a-z_0-9]+)"?/gi)) created.delete(match[1]!.toLowerCase());
      }
      const present = new Set((await wire.sql<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).rows.map((row) => row.table_name));
      const missing = [...created].filter((table) => !present.has(table));
      assert.deepEqual(missing, [], 'tables created by the SQL files but absent after migrating');
      assert.ok(present.has('tenants') && present.has('invoices') && present.has('cli_tokens') && present.has('audit_log'));
    } finally { await wire.close(); }
  });

  test('every table and column the Drizzle schema declares exists after migrating from empty', async () => {
    const wire = await startPgliteWire({ migrate: true });
    try {
      const { getTableConfig, PgTable } = serverDataRequire('drizzle-orm/pg-core') as { getTableConfig: (table: unknown) => { name: string; schema?: string; columns: Array<{ name: string }> }; PgTable: unknown };
      const { is } = serverDataRequire('drizzle-orm') as { is: (value: unknown, type: unknown) => boolean };
      const live = (await wire.sql<{ table_schema: string; table_name: string; column_name: string }>(
        `SELECT table_schema, table_name, column_name FROM information_schema.columns WHERE table_schema IN ('public', 'drizzle')`)).rows;
      const have = new Set(live.map((row) => `${row.table_schema}.${row.table_name}.${row.column_name}`));
      const missing: string[] = [];
      let tables = 0;
      for (const value of Object.values(serverData)) {
        if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) === null || !is(value, PgTable)) continue;
        const config = getTableConfig(value);
        tables += 1;
        for (const column of config.columns) {
          const key = `${config.schema ?? 'public'}.${config.name}.${column.name}`;
          if (!have.has(key)) missing.push(key);
        }
      }
      assert.ok(tables > 40, `only ${tables} Drizzle tables found; the schema export moved`);
      assert.deepEqual(missing, [], 'columns that repositories read or write but no migration creates; existing databases would break');
    } finally { await wire.close(); }
  });

  test('the hosted (node-postgres) migrator and the embedded (PGlite) migrator build the same schema', async () => {
    const embedded = await startPgliteWire({ migrate: false });
    const hosted = await startPgliteWire({ migrate: false });
    try {
      await embedded.database.migrate();
      const pool = serverData.createPostgresPool(hosted.url);
      try { await serverData.runDrizzleMigrations(pool); } finally { await pool.end(); }
      assert.equal(await migrationCount(hosted), journal.entries.length);
      assert.deepEqual(await schemaSnapshot(hosted), await schemaSnapshot(embedded));
    } finally { await embedded.close(); await hosted.close(); }
  });

  test('running the migrator again changes nothing and keeps the data', async () => {
    const wire = await startPgliteWire({ migrate: true });
    try {
      await wire.sql(`INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at) VALUES ('keep-me', 'keep-me', 'Keep', 'lite', 'x', 'x')`);
      const before = await schemaSnapshot(wire);
      const rows = await migrationCount(wire);
      await wire.database.migrate();
      const pool = serverData.createPostgresPool(wire.url);
      try { await serverData.runDrizzleMigrations(pool); } finally { await pool.end(); }
      assert.equal(await migrationCount(wire), rows);
      assert.deepEqual(await schemaSnapshot(wire), before);
      assert.equal((await wire.sql('SELECT 1 FROM tenants WHERE id = $1', ['keep-me'])).rows.length, 1);
    } finally { await wire.close(); }
  });

  test('a database a few migrations behind is brought current with its data intact', async () => {
    const { readMigrationFiles } = serverDataRequire('drizzle-orm/migrator') as { readMigrationFiles: (config: { migrationsFolder: string }) => Array<{ sql: string[]; folderMillis: number; hash: string }> };
    const migrations = readMigrationFiles({ migrationsFolder: drizzleDir });
    const behind = 4;
    const wire = await startPgliteWire({ migrate: false });
    try {
      // What an image from a few releases ago left behind: the first N migrations applied, rows in them.
      await wire.database.client.exec(`CREATE SCHEMA IF NOT EXISTS drizzle; CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint);`);
      for (const migration of migrations.slice(0, -behind)) {
        for (const statement of migration.sql) await wire.database.client.exec(statement);
        await wire.database.client.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [migration.hash, migration.folderMillis]);
      }
      await wire.sql(`INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at) VALUES ('old-tenant', 'old', 'Old', 'lite', 'x', 'x')`);
      await wire.sql(`INSERT INTO server_settings (tenant_id, settings_json, created_at, updated_at) VALUES ('old-tenant', '{"company":{"name":"Alt"}}', 'x', 'x')`);
      await assert.rejects(wire.database.assertCurrent(), /behind the current Drizzle journal/);

      await wire.database.migrate();
      await wire.database.assertCurrent();
      assert.equal(await migrationCount(wire), migrations.length);
      assert.equal((await wire.sql<{ settings_json: string }>('SELECT settings_json FROM server_settings WHERE tenant_id = $1', ['old-tenant'])).rows[0]?.settings_json, '{"company":{"name":"Alt"}}');
    } finally { await wire.close(); }
  });

  test('the API refuses to start on an unmigrated database and on one that is behind the journal', async () => {
    // A failed start leaves its pool open (the process is about to exit); the wire dropping that connection is noise here.
    const { result } = await captureUncaught(async () => {
      const empty = await startHostedServer('server-mode-migrations', { migrate: false }).then(() => null, (error: Error) => error);
      const wire = await startPgliteWire({ migrate: true });
      try {
        await wire.sql('DELETE FROM drizzle.__drizzle_migrations WHERE created_at = (SELECT max(created_at) FROM drizzle.__drizzle_migrations)');
        const behind = await startHostedServer('server-mode-migrations', { wire }).then(() => null, (error: Error) => error);
        return { empty, behind };
      } finally { await wire.close(); }
    });
    assert.match(result.empty?.message ?? 'started', /not initialized by the Drizzle migrator/);
    assert.match(result.behind?.message ?? 'started', /behind the current Drizzle journal/);
  });
});
