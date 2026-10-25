import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createLocalBackend } from '../../../apps/desktop/electron/localBackend.js';
import { PRODUCT_PROFILE } from '../../../apps/desktop/productProfile.js';
import { createProLocalBackend } from '../../../apps/pro-desktop/electron/proLocalBackend.js';
import { PRODUCT_PROFILE as PRO_PROFILE } from '../../../apps/pro-desktop/productProfile.js';

/**
 * The real `billme` binary against the Lite desktop backend (the composition
 * root Electron uses, on PGlite). The app side of the device login is played
 * with the local token, exactly what the renderer sends. Every command lands
 * in `test-results/cli/desktop-transcript.json`.
 */
const here = dirname(fileURLToPath(import.meta.url));
// `BILLME_BIN=dist/billme.mjs` runs the same flow against the bundled release file.
const billmeBin = resolve(process.env.BILLME_BIN ?? resolve(here, '..', 'bin', 'billme.mjs'));
const transcriptFile = resolve(here, '..', '..', '..', 'test-results', 'cli', 'desktop-transcript.json');

test('billme finds the desktop app, logs in by device code and works with its own token', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'billme-cli-desktop-'));
  const configPath = join(userDataPath, 'cli-config.json');
  const transcript: Array<{ command: string; exitCode: number | null; stdout: string; stderr: string }> = [];
  const backend = await createLocalBackend({ userDataPath, profile: PRODUCT_PROFILE });
  const app = backend.embeddedConnection()!;

  const redact = (text: string) => text.replace(/billme_cli_[\w-]+/g, 'billme_cli_<redacted>');
  const billme = (args: string[], options: { stdin?: string; onStderr?: (text: string) => void } = {}) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
      const child = spawn(process.execPath, [billmeBin, ...args], {
        env: { ...process.env, BILLME_CLI_CONFIG: configPath, BILLME_E2E_USER_DATA_DIR: userDataPath },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
        options.onStderr?.(stderr);
      });
      child.on('error', fail);
      child.on('close', (code) => {
        transcript.push({ command: redact(`billme ${args.join(' ')}`), exitCode: code, stdout: redact(stdout), stderr: redact(stderr) });
        done({ code, stdout, stderr });
      });
      child.stdin.end(options.stdin ?? '');
    });
  const ok = async (args: string[], options?: Parameters<typeof billme>[1]) => {
    const result = await billme(args, options);
    assert.equal(result.code, 0, `billme ${args.join(' ')} failed: ${result.stderr}`);
    return JSON.parse(result.stdout);
  };

  /** What the app's settings page does: look the code up, then approve or decline it. */
  const appRequest = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${app.baseUrl}/api/v1/lite${path}`, {
      method,
      headers: { 'x-billme-local-token': app.token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  const login = async (args: string[], approve: boolean) => {
    let decided = false;
    return billme(['login', '--target', 'desktop', '--no-browser', ...args], {
      onStderr: (text) => {
        const code = /Code: ([A-Z0-9-]+)/.exec(text)?.[1];
        if (!code || decided) return;
        decided = true;
        void (async () => {
          const pending = await appRequest('GET', `/cli-access/pending?code=${code}`);
          assert.equal(pending.body.userCode, code.replace('-', ''));
          await appRequest('POST', '/cli-access/decide', { code, approve });
        })();
      },
    });
  };

  try {
    // Discovery: the running app is found without any configuration, and no secret is on disk.
    const status = await ok(['status']);
    assert.deepEqual(status.desktop.map((entry: { product: string; baseUrl: string }) => [entry.product, entry.baseUrl]), [['lite', app.baseUrl]]);
    assert.ok(!(await readFile(join(userDataPath, 'cli-discovery.json'), 'utf8')).includes(app.token));

    // Without a token the API stays closed, and a web page cannot start a login.
    assert.equal((await fetch(`${app.baseUrl}/api/v1/lite/clients`)).status, 401);
    const fromBrowser = await fetch(`${app.baseUrl}/api/v1/auth/device/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
      body: JSON.stringify({ product: 'lite', label: 'evil' }),
    });
    assert.equal(fromBrowser.status, 403);

    const declined = await login(['--label', 'declined'], false);
    assert.equal(declined.code, 3, 'a declined login is an auth error');

    const approved = await login(['--label', 'e2e'], true);
    assert.equal(approved.code, 0, approved.stderr);
    assert.equal(JSON.parse(approved.stdout).target, 'desktop');
    assert.equal((await stat(configPath)).mode & 0o777, 0o600, 'the token file is private');
    const profile = JSON.parse(await readFile(configPath, 'utf8')).profiles.default;
    assert.equal(profile.baseUrl, undefined, 'desktop profiles resolve the port on every run');

    // The point of it all: create a customer and an invoice in the desktop data from the terminal.
    const clientId = randomUUID();
    const client = {
      id: clientId, company: 'CLI Desktop GmbH', contactPerson: 'Erika Beispiel', email: 'erika@example.com',
      phone: '', address: 'Hauptstraße 1\n10115 Berlin', status: 'active', tags: [], notes: '', projects: [], activities: [],
    };
    await ok(['clients', 'upsert', '--input', '-'], { stdin: JSON.stringify({ client }) });
    const document = { items: [{ kind: 'item', description: 'Beratung', quantity: 2, price: 100, total: 200 }], amount: 200, status: 'open' };
    // §14 UStG: before onboarding stored the company's address and tax number, issuing is refused with what is missing.
    const refused = await billme(['invoices', 'create', '--client-id', clientId, '--document', JSON.stringify(document)]);
    assert.notEqual(refused.code, 0);
    assert.match(refused.stderr, /Anschrift deines Unternehmens/);
    const settings = (await appRequest('GET', '/settings')).body;
    const onboarded = await appRequest('PUT', '/settings', { reason: 'Einrichtung', settings: {
      ...settings,
      company: { ...settings.company, name: 'CLI Desktop Werkstatt', street: 'Werkstraße 2', zip: '10115', city: 'Berlin' },
      finance: { ...settings.finance, taxId: '12/345/67890' },
    } });
    assert.equal(onboarded.status, 200, JSON.stringify(onboarded.body));
    const invoice = await ok(['invoices', 'create', '--client-id', clientId, '--document', JSON.stringify(document)]);
    assert.ok(invoice.number);
    const seenByApp = await appRequest('GET', '/invoices');
    assert.ok(seenByApp.body.some((entry: { id: string }) => entry.id === invoice.id), 'the app sees the invoice');

    // The audit log names the token, taken from the server's record of it.
    const auditFile = join(userDataPath, 'audit.csv');
    await ok(['audit', 'exportCsv', '--out', auditFile]);
    assert.ok((await readFile(auditFile, 'utf8')).includes('(CLI: e2e)'));

    // A CLI token manages no CLI access: it can neither approve logins nor list tokens.
    const selfApprove = await billme(['api', 'POST', '/api/v1/lite/cli-access/decide', '--input', '-'], { stdin: JSON.stringify({ code: 'AAAA-AAAA', approve: true }) });
    assert.equal(selfApprove.code, 3);
    assert.ok(!(await ok(['actions', '--json'])).some((action: { command: string }) => action.command.startsWith('cliAccess')));

    // Read-only tokens read and nothing else.
    const readOnly = await login(['--label', 'reader', '--read-only', '--profile', 'ro'], true);
    assert.equal(readOnly.code, 0, readOnly.stderr);
    assert.equal((await ok(['clients', 'list', '--profile', 'ro'])).length, 1);
    const write = await billme(['clients', 'delete', '--id', clientId, '--profile', 'ro']);
    assert.equal(write.code, 3);
    assert.match(write.stderr, /read-only/);

    // Revoking in the app ends the token at once; logout revokes the CLI's own.
    const tokens = await appRequest('GET', '/cli-access/tokens');
    assert.deepEqual(tokens.body.map((token: { label: string }) => token.label).sort(), ['e2e', 'reader']);
    const reader = tokens.body.find((token: { label: string }) => token.label === 'reader');
    assert.equal((await appRequest('DELETE', `/cli-access/tokens/${reader.id}`)).status, 200);
    assert.equal((await billme(['clients', 'list', '--profile', 'ro'])).code, 3);

    await ok(['logout']);
    assert.equal((await billme(['clients', 'list', '--token', profile.token])).code, 3, 'the old token is dead');
    assert.deepEqual((await appRequest('GET', '/cli-access/tokens')).body, []);

    // A closed app is not reported, even if its discovery file is still lying around.
    const discoveryFile = join(userDataPath, 'cli-discovery.json');
    const staleCopy = join(userDataPath, 'stale.json');
    await copyFile(discoveryFile, staleCopy);
    await backend.close();
    await copyFile(staleCopy, discoveryFile);
    assert.deepEqual((await ok(['status'])).desktop, []);
    const offline = await billme(['clients', 'list', '--token', 'billme_cli_x', '--profile', 'ro']);
    assert.equal(offline.code, 4, 'a desktop profile without a running app is "unreachable"');
  } finally {
    await backend.close().catch(() => undefined);
    await mkdir(dirname(transcriptFile), { recursive: true });
    await writeFile(transcriptFile, `${JSON.stringify(transcript, null, 2)}\n`);
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test('the Pro action list leaves out the Lite-only cash book and VAT report, which a Pro server does not serve', async () => {
  const actions = (product: 'lite' | 'pro') => new Promise<string[]>((done, fail) => {
    const child = spawn(process.execPath, [billmeBin, 'actions', '--product', product, '--base-url', 'http://127.0.0.1:9'], {
      env: { ...process.env, BILLME_CLI_CONFIG: join(tmpdir(), `billme-cli-actions-${process.pid}.json`) },
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', fail);
    child.on('close', () => done(stdout.trim().split('\n')));
  });
  const lite = await actions('lite');
  const pro = await actions('pro');
  assert.ok(lite.includes('cash listEntries') && lite.includes('vat getReport'), 'Lite keeps its cash book and VAT report');
  assert.deepEqual(pro.filter((line) => /^(cash|vat) /.test(line)), []);
  assert.ok(pro.includes('invoices list') && pro.includes('eur getReport'), 'Pro keeps the shared billing and its EÜR');
});

// The Prüferpaket is several files plus a manifest: with --out they land in that folder, one file each, not all on one path.
test('billme tax auditExportPackage --out writes the Prüferpaket into a folder against the Pro desktop backend', async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), 'billme-cli-pro-'));
  const configPath = join(userDataPath, 'cli-config.json');
  const backend = await createProLocalBackend({ userDataPath, profile: PRO_PROFILE });
  const app = backend.embeddedConnection()!;
  const billme = (args: string[], onStderr?: (text: string) => void) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
      const child = spawn(process.execPath, [billmeBin, ...args], {
        env: { ...process.env, BILLME_CLI_CONFIG: configPath, BILLME_E2E_USER_DATA_DIR: userDataPath },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; onStderr?.(stderr); });
      child.on('error', fail);
      child.on('close', (code) => done({ code, stdout, stderr }));
      child.stdin.end('');
    });
  const appRequest = (method: string, path: string, body?: unknown) => fetch(`${app.baseUrl}/api/v1/pro${path}`, {
    method,
    headers: { 'x-billme-local-token': app.token, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  try {
    let decided = false;
    const login = await billme(['login', '--target', 'desktop', '--product', 'pro', '--no-browser', '--label', 'z3'], (text) => {
      const code = /Code: ([A-Z0-9-]+)/.exec(text)?.[1];
      if (!code || decided) return;
      decided = true;
      void appRequest('POST', '/cli-access/decide', { code, approve: true });
    });
    assert.equal(login.code, 0, login.stderr);

    const out = join(userDataPath, 'pruefer');
    const exported = await billme(['tax', 'auditExportPackage', '--from', '2026-01-01', '--to', '2026-12-31', '--out', out]);
    assert.equal(exported.code, 0, exported.stderr);
    const result = JSON.parse(exported.stdout);
    assert.equal(result.path, out);
    const manifest = JSON.parse(await readFile(join(out, result.files.find((name: string) => name.endsWith('manifest.json'))), 'utf8'));
    assert.ok(manifest.files.length > 5, 'the package has its files');
    for (const file of manifest.files) {
      const bytes = await readFile(join(out, file.path));
      assert.equal(bytes.byteLength, file.sizeBytes, `${file.name} is written whole, not overwritten by the next file`);
    }
  } finally {
    await backend.close().catch(() => undefined);
    await rm(userDataPath, { recursive: true, force: true });
  }
});
