import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createPgliteServerDatabase, PgliteServerDatabase } from '@billme/server-data';
import { buildServerApi } from '../../server-runtime/src/app.js';
import { DEFAULT_SETTINGS } from '@billme/desktop-services/mockData';
import { startEmbeddedServer, type EmbeddedServerHandle, type StartEmbeddedServerOptions } from '../../embedded-server-runtime/src/embedded-server.js';
import { EmbeddedLifecycleError, startEmbeddedRuntimeCoordinator } from '../../embedded-server-runtime/src/lifecycleCoordinator.js';
import { restorePgliteDataDir } from '../../embedded-server-runtime/src/pgliteRestore.js';
import { CLI_DISCOVERY_FILE, readCliDiscovery } from '../../embedded-server-runtime/src/discovery.js';
import { captureUncaught, createRecorder } from './server-fixtures.js';
import { newClient } from './fixtures.js';
import { PRODUCTS, startLite, startPro, startProduct, type LiteHarness } from './harness.js';
import { concretePath, fastifyRoutes } from './routes.js';

/**
 * The embedded runtime Electron starts: loopback Fastify on PGlite, the per-start
 * access token, the CLI discovery file, backup/restore of the data directory, and
 * CLI device login against the desktop backend.
 *
 * How this can fail (each one has a test below):
 * - network: the server reachable from another machine or interface; any /api call
 *   answered without the per-start token, with a near-miss token, or with the old
 *   token of a previous start; any registered route of either product left open
 * - secrets: the access token or session secret written to the data directory, the
 *   discovery file or the log; a handle that hands out the database or the app
 * - discovery: the file naming a wrong port or instance, surviving a clean shutdown,
 *   or removed by an older instance that no longer owns it
 * - lifecycle: a data directory that cannot be reopened after a failed start or a
 *   close, data lost across a restart, close not idempotent, a dump racing a close,
 *   a restore activated without verification, a failed or corrupt restore leaving the
 *   user with no server or with the wrong data, leftover staging directories
 * - products: Lite routes served by a Pro runtime and the reverse
 * - CLI access: a browser starting a device login, a read-only token writing, a CLI
 *   token approving more tokens, a revoked token still working
 */

const identity = { tenantId: 'it-embedded-tenant', userId: 'it-embedded-user', email: 'local@it.example', fullName: 'Lokaler Test' };

const initializer: NonNullable<StartEmbeddedServerOptions['initializeDatabase']> = async (database, context) => {
  const now = new Date().toISOString();
  await database.query(
    `INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'single-tenant', 'active', $5, $5) ON CONFLICT (id) DO NOTHING`,
    [context.identity.tenantId, `it-${context.product}`, 'Integration', context.product, now]);
  await database.query(
    `INSERT INTO server_settings (tenant_id, settings_json, created_at, updated_at) VALUES ($1, $2, $3, $3) ON CONFLICT (tenant_id) DO NOTHING`,
    [context.identity.tenantId, JSON.stringify(DEFAULT_SETTINGS), now]);
};

describe('embedded runtime', () => {
  const roots: string[] = [];
  const handles: EmbeddedServerHandle[] = [];
  const recorder = createRecorder('embedded-runtime');
  after(async () => {
    await Promise.all(handles.splice(0).map((handle) => handle.close().catch(() => undefined)));
    await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
    await recorder.flush();
  });

  const newRoot = async () => { const dir = await mkdtemp(join(tmpdir(), 'billme-it-embedded-')); roots.push(dir); return dir; };
  const options = (userDataPath: string, overrides: Partial<StartEmbeddedServerOptions> = {}): StartEmbeddedServerOptions => ({
    userDataPath, dataDirName: 'it-pglite', product: 'lite', identity, initializeDatabase: initializer, ...overrides,
  });
  const start = async (opts: StartEmbeddedServerOptions) => { const handle = await startEmbeddedServer(opts); handles.push(handle); return handle; };
  const call = async (handle: EmbeddedServerHandle, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await recorder.fetch(`${handle.baseUrl}${path}`, {
      method,
      headers: { 'x-billme-local-token': handle.accessToken, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body: parsed, text };
  };
  const close = async (handle: EmbeddedServerHandle) => { await handle.close(); handles.splice(handles.indexOf(handle), 1); };

  describe('startEmbeddedServer', () => {
    test('listens on loopback only and answers /api only to the per-start token', async () => {
      const handle = await start(options(await newRoot()));
      const url = new URL(handle.baseUrl);
      assert.equal(url.hostname, '127.0.0.1');
      assert.ok(Number(url.port) > 0);
      assert.equal(Buffer.from(handle.accessToken, 'base64url').length, 32, '256 bit token');

      const external = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address);
      for (const address of external) {
        const reachable = await new Promise<boolean>((resolve) => {
          const socket = net.connect({ host: address, port: Number(url.port), timeout: 1500 });
          socket.on('connect', () => { socket.destroy(); resolve(true); });
          socket.on('error', () => resolve(false));
          socket.on('timeout', () => { socket.destroy(); resolve(false); });
        });
        assert.equal(reachable, false, `reachable on ${address}`);
      }

      assert.equal((await fetch(`${handle.baseUrl}/health`)).status, 200, '/health is public');
      const capabilities = '/api/v1/meta/capabilities';
      assert.equal((await fetch(`${handle.baseUrl}${capabilities}`)).status, 401);
      assert.equal((await call(handle, 'GET', capabilities)).status, 200);
      const nearMisses = [`${handle.accessToken}x`, handle.accessToken.slice(0, -1), handle.accessToken.toUpperCase(), '', 'null', 'undefined'];
      for (const token of nearMisses) {
        const response = await fetch(`${handle.baseUrl}${capabilities}`, { headers: { 'x-billme-local-token': token } });
        assert.equal(response.status, 401, `token "${token.slice(0, 8)}…"`);
      }
      const viaBearer = await fetch(`${handle.baseUrl}${capabilities}`, { headers: { authorization: `Bearer ${handle.accessToken}` } });
      assert.equal(viaBearer.status, 401, 'only the local-token header is the desktop credential');
      const meta = (await call(handle, 'GET', capabilities)).body;
      assert.deepEqual({ runtime: meta.runtime, local: meta.database.local, products: meta.products, multiUser: meta.auth.multiUser }, { runtime: 'embedded', local: 'pglite', products: ['lite'], multiUser: false });
    });

    test('a Lite runtime serves no Pro routes and a Pro runtime no Lite routes; tokens do not carry over', async () => {
      const lite = await start(options(await newRoot()));
      const pro = await start(options(await newRoot(), { product: 'pro', identity: { ...identity, tenantId: 'it-embedded-pro-tenant' } }));
      assert.equal((await call(lite, 'GET', '/api/v1/lite/clients')).status, 200);
      assert.equal((await call(lite, 'GET', '/api/v1/pro/clients')).status, 404);
      assert.equal((await call(pro, 'GET', '/api/v1/pro/clients')).status, 200);
      assert.equal((await call(pro, 'GET', '/api/v1/lite/clients')).status, 404);
      const crossToken = await fetch(`${pro.baseUrl}/api/v1/pro/clients`, { headers: { 'x-billme-local-token': lite.accessToken } });
      assert.equal(crossToken.status, 401, 'the Lite token must not open the Pro runtime');
      assert.equal((await call(pro, 'GET', '/api/v1/meta/capabilities')).body.products[0], 'pro');
    });

    test('data survives a restart in the same directory; every start has its own token and instance, the old token is dead', async () => {
      const root = await newRoot();
      const first = await start(options(root));
      const firstHealth = await (await fetch(`${first.baseUrl}/health`)).json();
      const clientId = randomUUID();
      const created = await call(first, 'POST', '/api/v1/lite/clients', { reason: 'anlegen', client: newClient({ id: clientId, company: 'Bleibt Bestehen' }) });
      assert.equal(created.status, 200, created.text);
      const firstClose = first.close();
      assert.equal(first.close(), firstClose, 'close is idempotent');
      await firstClose;
      handles.splice(handles.indexOf(first), 1);
      await assert.rejects(fetch(`${first.baseUrl}/health`), 'the port is released');

      const second = await start(options(root));
      assert.notEqual(second.accessToken, first.accessToken);
      assert.notEqual(second.baseUrl, first.baseUrl);
      assert.notEqual((await (await fetch(`${second.baseUrl}/health`)).json()).instanceId, firstHealth.instanceId);
      const clients = (await call(second, 'GET', '/api/v1/lite/clients')).body as Array<{ id: string; company: string }>;
      assert.deepEqual(clients.map((c) => c.company), ['Bleibt Bestehen']);
      const oldToken = await fetch(`${second.baseUrl}/api/v1/lite/clients`, { headers: { 'x-billme-local-token': first.accessToken } });
      assert.equal(oldToken.status, 401);
      const audit = await call(second, 'GET', '/api/v1/lite/audit/verify');
      assert.deepEqual([audit.status, audit.body.ok], [200, true]);
    });

    test('the discovery file names this instance and holds no secret; a newer instance keeps it when an older one closes', async () => {
      const root = await newRoot();
      const a = await start(options(root, { dataDirName: 'it-a' }));
      const discovery = await readCliDiscovery(root);
      assert.deepEqual(Object.keys(discovery!).sort(), ['baseUrl', 'instanceId', 'pid', 'product', 'startedAt']);
      assert.equal(discovery!.baseUrl, a.baseUrl);
      assert.equal(discovery!.pid, process.pid);
      assert.equal(discovery!.product, 'lite');
      assert.equal(discovery!.instanceId, (await (await fetch(`${a.baseUrl}/health`)).json()).instanceId, '/health echoes the discovered instance, so the CLI can verify the port');
      assert.ok(!Number.isNaN(Date.parse(discovery!.startedAt)));
      const raw = await readFile(join(root, CLI_DISCOVERY_FILE), 'utf8');
      assert.ok(!raw.includes(a.accessToken), 'the access token is in the discovery file');

      const b = await start(options(root, { dataDirName: 'it-b' }));
      assert.equal((await readCliDiscovery(root))!.instanceId, (await (await fetch(`${b.baseUrl}/health`)).json()).instanceId, 'the newest instance owns the file');
      await close(a);
      assert.equal((await readCliDiscovery(root))?.baseUrl, b.baseUrl, 'an older instance must not delete the file of a newer one');
      await close(b);
      assert.equal(existsSync(join(root, CLI_DISCOVERY_FILE)), false, 'a clean shutdown removes the file');
    });

    test('the handle exposes no database, app or session secret, and neither the data directory nor the log contains the token', async () => {
      const root = await newRoot();
      const logs: string[] = [];
      const handle = await start(options(root, { logger: { info: (_c, message, data) => logs.push(`${message} ${JSON.stringify(data ?? null)}`), warn: (_c, message, data) => logs.push(`${message} ${JSON.stringify(data ?? null)}`) } }));
      assert.deepEqual(Object.keys(handle).sort(), ['accessToken', 'baseUrl', 'close', 'dumpDataDir']);
      assert.ok(Object.isFrozen(handle));
      assert.ok(!logs.join('\n').includes(handle.accessToken));
      await call(handle, 'POST', '/api/v1/lite/clients', { reason: 'x', client: newClient() });
      const dump = await handle.dumpDataDir();
      assert.ok(dump.size > 0);
      const bytes = Buffer.from(await dump.arrayBuffer());
      assert.ok(!bytes.includes(Buffer.from(handle.accessToken)), 'the access token is inside a database dump');
      for (const file of await readdir(join(root, 'it-pglite'), { recursive: true })) {
        const path = join(root, 'it-pglite', file);
        if ((await stat(path)).isFile()) assert.ok(!(await readFile(path)).includes(Buffer.from(handle.accessToken)), `${file} contains the access token`);
      }
    });

    test('bad options are rejected before anything is created', async () => {
      const root = await newRoot();
      for (const bad of [{ dataDirName: '../escape' }, { dataDirName: 'a/b' }, { dataDirName: '..' }, { dataDirName: '.' }, { dataDirName: '  ' }, { identity: { ...identity, tenantId: '' } }, { identity: { ...identity, email: ' ' } }, { userDataPath: '' }]) {
        await assert.rejects(startEmbeddedServer(options(root, bad as never)), TypeError, JSON.stringify(bad));
      }
      assert.deepEqual(await readdir(root), [], 'a rejected start must not create directories');
      assert.equal(existsSync(join(root, '..', 'escape')), false);
    });

    test('a failing initializer closes the database, leaves no discovery file and lets the directory be opened again', async () => {
      const root = await newRoot();
      await assert.rejects(startEmbeddedServer(options(root, { initializeDatabase: async () => { throw new Error('initializer failed'); } })), /initializer failed/);
      assert.equal(existsSync(join(root, CLI_DISCOVERY_FILE)), false);
      const reopened = await start(options(root));
      assert.equal((await call(reopened, 'GET', '/api/v1/lite/clients')).status, 200);
    });
  });

  describe('backup and restore of the data directory', () => {
    const archiveOf = async (blob: Blob | File, dir: string, name = 'backup.pglite.tar') => {
      const path = join(dir, name);
      await writeFile(path, Buffer.from(await blob.arrayBuffer()));
      return path;
    };
    /** A coordinator around real servers, wired exactly like createLocalBackend wires it. */
    const coordinatorFor = async (root: string) => {
      const opts = options(root);
      const coordinator = await startEmbeddedRuntimeCoordinator({
        start: () => startEmbeddedServer(opts),
        restore: (archivePath) => restorePgliteDataDir({ archivePath, activeDataDir: join(root, opts.dataDirName), product: 'lite', tenantId: identity.tenantId }),
      });
      const get = async (path: string, method = 'GET', body?: unknown) => {
        const connection = coordinator.connection();
        assert.ok(connection, 'no connection');
        const response = await fetch(`${connection!.baseUrl}${path}`, { method, headers: { 'x-billme-local-token': connection!.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: response.status, body: await response.json().catch(() => null) as any };
      };
      return { coordinator, get };
    };
    const addClient = (get: Awaited<ReturnType<typeof coordinatorFor>>['get'], company: string) =>
      get('/api/v1/lite/clients', 'POST', { reason: 'anlegen', client: newClient({ company }) });
    const companies = async (get: Awaited<ReturnType<typeof coordinatorFor>>['get']) => ((await get('/api/v1/lite/clients')).body as Array<{ company: string }>).map((c) => c.company).sort();
    const leftovers = async (root: string) => (await readdir(root)).filter((entry) => /\.(restore|previous)-/.test(entry));

    test('a dump restores the state it was taken in; the server stays down for the relaunch; the restored data verifies', async () => {
      const root = await newRoot();
      const { coordinator, get } = await coordinatorFor(root);
      await addClient(get, 'Vor dem Backup');
      const archive = await archiveOf(await coordinator.dumpDataDir(), root);
      await addClient(get, 'Nach dem Backup');
      assert.deepEqual(await companies(get), ['Nach dem Backup', 'Vor dem Backup']);

      const result = await coordinator.restoreDataDir(archive);
      assert.equal(result.ok, true);
      assert.equal(result.verification.ok, true);
      assert.equal(coordinator.state(), 'closed', 'the app relaunches after a restore');
      assert.equal(coordinator.connection(), null);
      assert.deepEqual(await leftovers(root), [], 'staging or previous directory left behind');
      assert.ok(existsSync(archive), 'the archive stays as the recoverable copy');

      const relaunched = await coordinatorFor(root);
      try {
        assert.deepEqual(await companies(relaunched.get), ['Vor dem Backup']);
        assert.equal((await relaunched.get('/api/v1/lite/audit/verify')).body.ok, true);
        assert.equal((await addClient(relaunched.get, 'Danach weiter')).status, 200, 'the restored database accepts writes');
      } finally { await relaunched.coordinator.close(); }
    });

    test('a restore that fails verification keeps the current data and brings the server back with a new token', async () => {
      const root = await newRoot();
      const { coordinator, get } = await coordinatorFor(root);
      await addClient(get, 'Aktuell');
      const before = coordinator.connection()!;

      const foreign = await mkdtemp(join(tmpdir(), 'billme-it-archive-'));
      roots.push(foreign);
      const wrongTenant = await PgliteServerDatabase.open(join(foreign, 'wrong-tenant'));
      await wrongTenant.migrate();
      await wrongTenant.query(`INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at) VALUES ('someone-else', 'x', 'X', 'lite', 'single-tenant', 'active', 'x', 'x')`);
      const wrongTenantArchive = await archiveOf(await wrongTenant.dumpDataDir('none'), foreign, 'wrong-tenant.tar');
      await wrongTenant.close();

      const brokenChain = await PgliteServerDatabase.open(join(foreign, 'broken-chain'));
      await brokenChain.migrate();
      await brokenChain.query(`INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at) VALUES ($1, 'x', 'X', 'lite', 'single-tenant', 'active', 'x', 'x')`, [identity.tenantId]);
      await brokenChain.query(`INSERT INTO audit_log (tenant_id, sequence, ts, entity_type, entity_id, action, reason, prev_hash, hash, actor) VALUES ($1, 1, 'x', 'restore', 'invalid', 'restore', NULL, NULL, 'not-a-valid-hash', 'local')`, [identity.tenantId]);
      const brokenChainArchive = await archiveOf(await brokenChain.dumpDataDir('none'), foreign, 'broken-chain.tar');
      await brokenChain.close();

      for (const [archive, reason] of [[wrongTenantArchive, /keinen gültigen lite-Mandanten/], [brokenChainArchive, /ungültige Audit-Kette/], [join(foreign, 'missing.tar'), /ENOENT|no such file/i]] as const) {
        await assert.rejects(coordinator.restoreDataDir(archive), reason, archive);
        assert.equal(coordinator.state(), 'running', 'a failed restore must restart the server');
        const after = coordinator.connection();
        assert.ok(after, 'no connection after a failed restore');
        assert.notEqual(after!.token, before.token, 'the restarted server has a new token');
        assert.deepEqual(await companies(get), ['Aktuell'], 'the current data must be untouched');
        assert.deepEqual(await leftovers(root), [], 'a failed restore left a staging directory');
      }
      await coordinator.close();
    });

    test('a corrupt archive is reported as an error without an unhandled rejection, and the current data stays', async () => {
      const root = await newRoot();
      const { coordinator, get } = await coordinatorFor(root);
      await addClient(get, 'Bleibt');
      const garbage = join(root, 'garbage.tar');
      await writeFile(garbage, Buffer.alloc(8192, 42));
      const { result, errors } = await captureUncaught(() => coordinator.restoreDataDir(garbage).then(() => null, (error: Error) => error), 800);
      assert.ok(result instanceof Error, 'the restore must fail');
      assert.equal(coordinator.state(), 'running');
      assert.deepEqual(await companies(get), ['Bleibt']);
      assert.deepEqual(await leftovers(root), []);
      await coordinator.close();
      assert.deepEqual(errors.map((error) => `${error.name}: ${(error as { code?: string }).code ?? error.message}`), [], 'an unhandled error escaped the restore');
    });

    test('a restore requested while a dump runs waits for it, and the connection is withdrawn at once', async () => {
      const root = await newRoot();
      const { coordinator, get } = await coordinatorFor(root);
      await addClient(get, 'Im Dump');
      const archive = await archiveOf(await coordinator.dumpDataDir(), root);
      const dump = coordinator.dumpDataDir();
      await new Promise((resolve) => setImmediate(resolve)); // the dump has started
      const restore = coordinator.restoreDataDir(archive);
      assert.equal(coordinator.connection(), null, 'no request may reach a server that is about to be replaced');
      await assert.rejects(coordinator.dumpDataDir(), EmbeddedLifecycleError, 'a new dump while a restore is pending');
      assert.ok((await dump).size > 0, 'the running dump completes');
      assert.equal((await restore).ok, true);
      assert.equal(coordinator.state(), 'closed');
    });

    test('a dump that is already running finishes before close; nothing works after close', async () => {
      const root = await newRoot();
      const { coordinator, get } = await coordinatorFor(root);
      await addClient(get, 'Muss im Dump sein');
      const dump = coordinator.dumpDataDir();
      await new Promise((resolve) => setImmediate(resolve)); // the dump has started
      const closing = coordinator.close();
      assert.equal(coordinator.connection(), null, 'no new requests once shutdown started');
      const blob = await dump;
      assert.ok(blob.size > 0);
      await closing;
      assert.equal(coordinator.state(), 'closed');
      await assert.rejects(coordinator.dumpDataDir(), EmbeddedLifecycleError);
      await assert.rejects(coordinator.restoreDataDir(join(root, 'whatever.tar')), EmbeddedLifecycleError);
      assert.equal(existsSync(join(root, CLI_DISCOVERY_FILE)), false);
    });

    test('restorePgliteDataDir refuses a missing active directory and a product mismatch, and cleans up after itself', async () => {
      const root = await newRoot();
      const { coordinator, get } = await coordinatorFor(root);
      await addClient(get, 'x');
      const archive = await archiveOf(await coordinator.dumpDataDir(), root);
      await coordinator.close();
      await assert.rejects(restorePgliteDataDir({ archivePath: archive, activeDataDir: join(root, 'does-not-exist'), product: 'lite', tenantId: identity.tenantId }), /nicht gefunden/);
      await assert.rejects(restorePgliteDataDir({ archivePath: archive, activeDataDir: join(root, 'it-pglite'), product: 'pro', tenantId: identity.tenantId }), /keinen gültigen pro-Mandanten/);
      assert.deepEqual(await leftovers(root), []);
      assert.ok(existsSync(join(root, 'it-pglite')));
    });
  });
});

for (const product of PRODUCTS) describe(`CLI access through the desktop backend (${product})`, () => {
  let h: LiteHarness;
  let userCodeCounter = 0;
  before(async () => { h = await startProduct(product, null, 'embedded-cli'); });
  after(async () => { await h.close(); });

  const base = () => h.connection.baseUrl;
  const device = async (label: string, scope: 'full' | 'read' = 'full') => {
    const started = await fetch(`${base()}/api/v1/auth/device/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product, label, scope }) });
    assert.equal(started.status, 200);
    userCodeCounter += 1;
    return started.json() as Promise<{ deviceCode: string; userCode: string }>;
  };
  const approve = (code: string, approveIt = true) => h.api.cliAccess.decide({ code, approve: approveIt });
  const poll = async (deviceCode: string) => (await fetch(`${base()}/api/v1/auth/device/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceCode }) })).json() as Promise<any>;
  const login = async (label: string, scope: 'full' | 'read' = 'full') => {
    const started = await device(label, scope);
    assert.deepEqual(await approve(started.userCode), { ok: true });
    const result = await poll(started.deviceCode);
    assert.equal(result.status, 'approved');
    return result.token as string;
  };
  const withCli = (token: string, method: string, path: string, body?: unknown) =>
    fetch(`${base()}/api/v1/${product}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });

  test('a browser (Origin header) cannot start a device login, nothing without the person approving yields a token', async () => {
    const refused = await fetch(`${base()}/api/v1/auth/device/start`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: JSON.stringify({ product, label: 'xss', scope: 'full' }) });
    assert.equal(refused.status, 403);
    const started = await device('unapproved');
    assert.equal((await poll(started.deviceCode)).status, 'pending');
    const pending = await h.api.cliAccess.pending({ code: started.userCode });
    assert.equal(pending?.label, 'unapproved');
    assert.equal((await h.api.cliAccess.pending({ code: 'ZZZZ-9999' })), null);
    await approve(started.userCode, false);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal((await poll(started.deviceCode)).status, 'denied');
  });

  test('without the desktop token nobody can approve a request or list tokens', async () => {
    const started = await device('needs-person');
    const decide = await fetch(`${base()}/api/v1/${product}/cli-access/decide`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: started.userCode, approve: true }) });
    assert.equal(decide.status, 401);
    assert.equal((await fetch(`${base()}/api/v1/${product}/cli-access/tokens`)).status, 401);
  });

  test('an approved full token works as the desktop user and is attributed to the CLI; a read token only reads; a revoked token dies', async () => {
    const full = await login('ci-full');
    const created = await withCli(full, 'POST', '/clients', { reason: 'per CLI', client: newClient({ company: 'Per CLI angelegt' }) });
    assert.equal(created.status, 200, await created.text());
    const csv = await h.api.audit.exportCsv();
    assert.match(csv, /CLI: ci-full/);

    const read = await login('ci-read', 'read');
    assert.equal((await withCli(read, 'GET', '/clients')).status, 200);
    for (const [method, path, body] of [['POST', '/clients', { reason: 'x', client: newClient() }], ['POST', '/numbers/reserve', { kind: 'invoice' }], ['DELETE', `/invoices/${randomUUID()}`, { reason: 'x' }]] as const) {
      assert.equal((await withCli(read, method, path, body)).status, 403, `${method} ${path}`);
    }

    const tokens = await h.api.cliAccess.list();
    const readEntry = tokens.find((t) => t.label === 'ci-read')!;
    assert.deepEqual(Object.keys(readEntry).filter((k) => k !== 'lastUsedAt').sort(), ['createdAt', 'id', 'label', 'product', 'scope']);
    assert.deepEqual(await h.api.cliAccess.revoke({ id: readEntry.id }), { ok: true });
    assert.equal((await withCli(read, 'GET', '/clients')).status, 401);
    assert.equal((await withCli(full, 'GET', '/clients')).status, 200, 'revoking one token leaves the others alone');
  });

  test('a CLI token cannot approve or manage CLI tokens, and a made-up token or bearer is refused', async () => {
    const full = await login('ci-greedy');
    const started = await device('minted-by-cli');
    assert.equal((await withCli(full, 'POST', '/cli-access/decide', { code: started.userCode, approve: true })).status, 403);
    assert.equal((await withCli(full, 'GET', '/cli-access/tokens')).status, 403);
    assert.equal((await withCli('billme_cli_made-up-token-made-up-token-made-up', 'GET', '/clients')).status, 401);
    assert.equal((await withCli('not-a-cli-token', 'GET', '/clients')).status, 401);
    assert.equal((await withCli(h.connection.token, 'GET', '/clients')).status, 401, 'the local token is only valid in its own header');
  });

  test('a CLI token can revoke itself, a read token too; the desktop token cannot', async () => {
    const full = await login('ci-self');
    const read = await login('ci-self-read', 'read');
    assert.equal((await withCli(full, 'POST', '/cli-access/revoke-self')).status, 200);
    assert.equal((await withCli(full, 'GET', '/clients')).status, 401, 'the revoked token is dead');
    assert.equal((await withCli(read, 'POST', '/cli-access/revoke-self')).status, 200, 'logging out is allowed for a read token');
    assert.equal((await withCli(read, 'GET', '/clients')).status, 401);
    const desktop = await fetch(`${base()}/api/v1/${product}/cli-access/revoke-self`, { method: 'POST', headers: { 'x-billme-local-token': h.connection.token } });
    assert.equal(desktop.status, 400, 'only a CLI token can revoke itself');
    const listed = await h.raw('GET', '/cli-access/tokens');
    assert.ok(!listed.body.some((token: { label: string }) => token.label.startsWith('ci-self')));
  });

  test('a token is revoked by id from the app; an unknown id is a 404', async () => {
    const token = await login('ci-by-id');
    const entry = (await h.api.cliAccess.list()).find((candidate) => candidate.label === 'ci-by-id')!;
    assert.equal((await h.raw('DELETE', `/cli-access/tokens/${entry.id}`)).status, 200);
    assert.equal((await withCli(token, 'GET', '/clients')).status, 401);
    assert.equal((await h.raw('DELETE', '/cli-access/tokens/gibt-es-nicht')).status, 404);
  });

  test('the other product\'s routes do not exist on this desktop, also not for CLI tokens', async () => {
    const other = product === 'lite' ? 'pro' : 'lite';
    const full = await login('ci-own-product-only');
    assert.equal((await fetch(`${base()}/api/v1/${other}/clients`, { headers: { authorization: `Bearer ${full}` } })).status, 404);
    const started = await fetch(`${base()}/api/v1/auth/device/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ product: other, label: 'x', scope: 'full' }) });
    assert.equal(started.status, 400, `this desktop does not serve ${other}`);
  });
});

for (const product of PRODUCTS) test(`every /api route of the ${product} desktop backend refuses a request without or with a wrong local token`, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), `billme-it-sweep-${product}-`));
  const table = await buildServerApi({
    runtime: 'embedded', product, logger: false, sessionSecret: 'sweep-session-secret-0123456789abcdef',
    database: await createPgliteServerDatabase(dataDir),
    localAuth: { accessToken: 'sweep-token-0123456789abcdef0123456789', userId: 'u', email: 'sweep@example.com', fullName: 'Sweep', tenantId: 't' },
  });
  await table.ready();
  const routes = fastifyRoutes(table.printRoutes({ commonPrefix: false })).filter((route) => route.path.startsWith('/api/'));
  await table.close();
  await rm(dataDir, { recursive: true, force: true });

  const h = await startProduct(product, t, 'embedded-sweep');
  const device = new Set(['POST /api/v1/auth/device/start', 'POST /api/v1/auth/device/token']);
  const open: string[] = [];
  for (const route of routes) {
    if (device.has(`${route.method} ${route.path}`)) continue;
    for (const headers of [{}, { 'x-billme-local-token': `${h.connection.token}x` }, { authorization: `Bearer ${h.connection.token}` }] as Array<Record<string, string>>) {
      const bodies = route.method === 'GET' || route.method === 'DELETE' ? [undefined] : [undefined, '{}'];
      for (const body of bodies) {
        const response = await fetch(`${h.connection.baseUrl}${concretePath(route.path)}`, { method: route.method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) }, body });
        if (response.status !== 401) open.push(`${route.method} ${route.path} ${JSON.stringify(headers).slice(0, 30)} -> ${response.status}`);
      }
    }
  }
  assert.ok(routes.length > 80, `${routes.length} routes read from the table`);
  assert.deepEqual(open, []);
});

describe('PGlite database seam', () => {
  const open = async () => {
    const dir = await mkdtemp(join(tmpdir(), 'billme-it-seam-'));
    return { database: await PgliteServerDatabase.open(dir), dir };
  };

  test('an unmigrated database says so, migrating is idempotent and keeps rows, a closed database refuses work', async () => {
    const { database, dir } = await open();
    try {
      await assert.rejects(database.assertCurrent(), /schema is not initialized/i);
      await database.migrate();
      await database.assertCurrent();
      await database.query(`INSERT INTO tenants (id, slug, display_name, product, created_at, updated_at) VALUES ('seam', 'seam', 'Seam', 'lite', 'x', 'x')`);
      await database.migrate();
      assert.equal((await database.query('SELECT 1 FROM tenants WHERE id = $1', ['seam'])).rows.length, 1);
      await database.close();
      await database.close();
      await assert.rejects(async () => database.query('SELECT 1'), /closed/);
      await assert.rejects(async () => database.transaction({}, async () => undefined), /closed/);
    } finally { await database.close().catch(() => undefined); await rm(dir, { recursive: true, force: true }); }
  });

  test('transactions commit, roll back as a whole, make outside readers wait, and nest without deadlocking', async () => {
    const { database, dir } = await open();
    try {
      await database.query('CREATE TABLE seam_values (id integer PRIMARY KEY, value text NOT NULL)');
      await database.transaction({}, async (session) => { await session.query('INSERT INTO seam_values VALUES (1, $1)', ['committed']); });
      await assert.rejects(database.transaction({}, async (session) => {
        await session.query('INSERT INTO seam_values VALUES (2, $1)', ['rolled back']);
        await session.query('INSERT INTO seam_values VALUES (1, $1)', ['duplicate key']);
      }));
      assert.deepEqual((await database.query<{ id: number }>('SELECT id FROM seam_values ORDER BY id')).rows.map((row) => row.id), [1], 'the first insert of the failed transaction must be gone too');

      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const inside = new Promise<void>((resolve) => { entered = resolve; });
      const writer = database.transaction({}, async (session) => {
        await session.query('INSERT INTO seam_values VALUES (3, $1)', ['pending']);
        entered();
        await gate;
        await session.query('UPDATE seam_values SET value = $1 WHERE id = 3', ['done']);
      });
      await inside;
      let readerDone = false;
      const reader = database.query<{ value: string }>('SELECT value FROM seam_values WHERE id = 3').then((result) => { readerDone = true; return result; });
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(readerDone, false, 'an outside reader must not see (or interleave with) an open transaction');
      release();
      await writer;
      assert.equal((await reader).rows[0]?.value, 'done');

      await database.transaction({}, async () => {
        await database.query('INSERT INTO seam_values VALUES (4, $1)', ['outer']);
        await database.transaction({}, async (nested) => { await nested.query('INSERT INTO seam_values VALUES (5, $1)', ['nested']); });
        await assert.rejects(async () => database.migrate(), /inside a transaction/);
        await assert.rejects(async () => database.dumpDataDir(), /inside a transaction/);
        await assert.rejects(database.close(), /transaction is active/);
      });
      assert.equal(Number((await database.query<{ n: string }>('SELECT count(*)::text AS n FROM seam_values')).rows[0]!.n), 4);
    } finally { await database.close().catch(() => undefined); await rm(dir, { recursive: true, force: true }); }
  });
});

describe('tax filing operations through the desktop backend', () => {
  const unavailable = { provider: { available: false, provider: null, errorCode: 'PROVIDER_UNAVAILABLE' }, certificates: [] };
  const pem = '-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----';
  const withCredentialKey = async <T>(work: () => Promise<T>): Promise<T> => {
    const saved = [process.env.TAX_FILING_CREDENTIAL_KEY_ID, process.env.TAX_FILING_CREDENTIAL_KEY];
    process.env.TAX_FILING_CREDENTIAL_KEY_ID = 'it-key';
    process.env.TAX_FILING_CREDENTIAL_KEY = 'a'.repeat(64);
    try { return await work(); } finally {
      if (saved[0] === undefined) delete process.env.TAX_FILING_CREDENTIAL_KEY_ID; else process.env.TAX_FILING_CREDENTIAL_KEY_ID = saved[0];
      if (saved[1] === undefined) delete process.env.TAX_FILING_CREDENTIAL_KEY; else process.env.TAX_FILING_CREDENTIAL_KEY = saved[1];
    }
  };

  test('Lite and Pro report the provider as unavailable and have no filings', async () => {
    const lite = await startLite(null, 'embedded-taxfiling-lite');
    const pro = await startPro(null, 'embedded-taxfiling-pro');
    try {
      for (const h of [lite, pro]) {
        const status = await h.raw('GET', '/tax-filing/status');
        assert.deepEqual([status.status, status.body], [200, unavailable]);
        assert.deepEqual((await h.raw('GET', '/tax-filing/records')).body, []);
      }
    } finally { await lite.close(); await pro.close(); }
  });

  test('certificates are stored encrypted behind a configured key, listed as metadata only, and removed with a reason', async () => {
    const h = await startLite(null, 'embedded-taxfiling-certificates');
    try {
      const install = (body: Record<string, unknown>) => h.raw('POST', '/tax-filing/certificates', body);
      const valid = { id: 'cert-1', pem, expiresAt: '2030-01-01T00:00:00.000Z', subject: 'Test Zertifikat', reason: 'Zertifikat installieren' };

      const withoutKey = await install(valid);
      assert.equal(withoutKey.status, 503, 'no encryption key configured: refuse instead of storing in clear');
      assert.match(withoutKey.text, /encryption is not configured/i);

      await withCredentialKey(async () => {
        assert.equal((await install({ ...valid, pem: 'not-pem' })).status, 400);
        assert.equal((await install({ ...valid, id: '../etc/passwd' })).status, 400, 'the id is part of a storage key');
        const installed = await install({ ...valid, password: 'geheim-passwort' });
        assert.equal(installed.status, 200, installed.text);
        assert.deepEqual(installed.body, { id: 'cert-1', fingerprint: createHash('sha256').update(pem).digest('hex'), expiresAt: valid.expiresAt, subject: valid.subject });
        const status = await h.raw('GET', '/tax-filing/status');
        assert.equal(status.body.certificates.length, 1);
        assert.ok(!status.text.includes('BEGIN CERTIFICATE') && !status.text.includes('geheim-passwort') && !installed.text.includes('geheim-passwort'), 'the certificate or its password came back over the API');
        const removed = await h.raw('DELETE', '/tax-filing/certificates/cert-1?reason=Zertifikat%20entfernen');
        assert.deepEqual([removed.status, removed.body], [200, true]);
        assert.deepEqual((await h.raw('DELETE', '/tax-filing/certificates/cert-1?reason=nochmal')).body, false, 'removing twice reports that nothing was removed');
        assert.deepEqual((await h.raw('GET', '/tax-filing/status')).body.certificates, []);
        // Without a reason the change is still recorded, under a default reason.
        assert.equal((await install({ ...valid, id: 'cert-2', reason: undefined })).status, 200);
        assert.deepEqual((await h.raw('DELETE', '/tax-filing/certificates/cert-2')).body, true);
      });
      const csv = await h.api.audit.exportCsv();
      assert.ok(!csv.includes('geheim-passwort') && !csv.includes('ZmFrZQ=='), 'the secret ended up in the audit log');
      assert.ok(csv.includes('tax_filing.certificate_install') && csv.includes('tax_filing.certificate_remove') && csv.includes('Zertifikat entfernen') && csv.includes('Tax filing certificate removed'), 'certificate changes are audited with their reason');
    } finally { await h.close(); }
  });
});
