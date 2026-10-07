import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect } from '@playwright/test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const billmeBin = path.join(repoRoot, 'packages', 'server-cli', 'bin', 'billme.mjs');
const transcriptFile = path.join(repoRoot, 'test-results', 'server-mode', 'cli', 'lite-transcript.json');

const owner = { email: 'lite-owner@billme-e2e.local', password: 'billme-server-123', fullName: 'Billme Lite Owner' };

/**
 * Drives the real `billme` binary against a running server-mode API and leaves
 * every command with its exit code and output in `test-results/server-mode/cli/`.
 */
export const runLiteCliScenario = async (apiUrl, page) => {
  const configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billme-cli-e2e-'));
  const transcript = [];

  const billme = (args, { stdin, env = {}, onStderr } = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [billmeBin, ...args], {
      env: {
        ...process.env,
        BILLME_CLI_CONFIG: path.join(configDir, 'config.json'),
        BILLME_BASE_URL: apiUrl,
        BILLME_PRODUCT: 'lite',
        ...env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      onStderr?.(stderr);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      // The transcript is uploaded as a CI artifact; keep session tokens out of it.
      const redacted = stdout.replace(/("token":\s*")[^"]+/g, '$1<redacted>').replace(/billme_cli_[\w-]+/g, 'billme_cli_<redacted>');
      transcript.push({ command: `billme ${args.join(' ')}`, exitCode: code, stdout: redacted, stderr });
      resolve({ code, stdout, stderr, json: () => JSON.parse(stdout) });
    });
    child.stdin.end(stdin ?? '');
  });

  const ok = async (args, options) => {
    const result = await billme(args, options);
    assert.equal(result.code, 0, `billme ${args.join(' ')} failed: ${result.stderr}`);
    return result;
  };

  try {
    const status = await (await fetch(`${apiUrl}/api/v1/auth/bootstrap/status?product=lite`)).json();
    const session = await ok([
      'auth', status.bootstrapped ? 'login' : 'bootstrap',
      '--email', owner.email, '--password', owner.password, '--full-name', owner.fullName,
    ]);
    assert.equal(session.json().user.email, owner.email);

    // The catalog comes from the contract: shell-only routes are absent, composites are present.
    const actions = (await ok(['actions', '--json'])).json();
    const commands = actions.map((action) => action.command);
    for (const expected of ['invoices create', 'invoices upsert', 'dunning manualRun', 'email send', 'portal publishInvoice', 'pdf export']) {
      assert.ok(commands.includes(expected), `missing action ${expected}`);
    }
    for (const excluded of ['window close', 'secrets get', 'db restore', 'cliAccess decide']) {
      assert.ok(!commands.includes(excluded), `native action ${excluded} must not be offered`);
    }
    // `finance importPreview` has its own `profile` argument; the flag must reach the action, not the CLI.
    const shadowed = await billme(['finance', 'importPreview', '--profile', 'not-a-bank']);
    assert.equal(shadowed.code, 2);
    assert.deepEqual(JSON.parse(shadowed.stderr).error.issues.filter((issue) => issue.path[0] === 'profile').length, 1);

    // A fresh tenant has no settings and cannot number anything; onboarding normally writes them.
    const settings = (await ok(['settings', 'get'])).json() ?? JSON.parse(execFileSync(
      process.execPath,
      ['--import', 'tsx', '-e', "import('@billme/desktop-services/mockData').then((m) => console.log(JSON.stringify(m.DEFAULT_SETTINGS)))"],
      { cwd: path.dirname(path.dirname(billmeBin)), encoding: 'utf8' },
    ));
    await ok(['settings', 'set', '--settings', JSON.stringify({
      ...settings,
      onboardingCompleted: true,
      eInvoice: { ...settings.eInvoice, enabled: true },
      company: { ...settings.company, name: 'Muster GmbH', owner: 'Max Muster', street: 'Musterweg 1', zip: '10115', city: 'Berlin', email: 'info@muster.example' },
      finance: { ...settings.finance, bankName: 'Musterbank', iban: 'DE02120300000000202051', bic: 'BYLADEM1001', taxId: '12/345/67890', vatId: 'DE123456789' },
    })]);

    const clientId = crypto.randomUUID();
    const client = {
      id: clientId,
      company: `CLI Testkunde ${clientId.slice(0, 8)}`,
      contactPerson: 'Erika Beispiel',
      email: 'erika@example.com',
      phone: '',
      address: 'Hauptstraße 1\n10115 Berlin',
      status: 'active',
      tags: [],
      notes: '',
      projects: [],
      activities: [],
    };
    const savedClient = (await ok(['clients', 'upsert', '--input', '-'], { stdin: JSON.stringify({ client }) })).json();
    assert.equal(savedClient.company, client.company);

    const document = {
      items: [{ kind: 'item', description: 'Beratung', quantity: 2, price: 100, total: 200, taxRate: 19 }],
      amount: 200,
      status: 'open',
    };
    const invoice = (await ok(['invoices', 'create', '--client-id', clientId, '--document', JSON.stringify(document)])).json();
    assert.equal(invoice.client, client.company);
    assert.equal(invoice.amount, 238);
    assert.equal(invoice.taxSnapshot.netAmount, 200);
    assert.equal(invoice.taxSnapshot.vatAmount, 38);
    assert.ok(invoice.number, 'created invoice has a number');

    const listed = (await ok(['invoices', 'list'])).json();
    assert.ok(listed.some((entry) => entry.id === invoice.id && entry.number === invoice.number));

    // Endpoints without a contract key stay reachable.
    const fetched = (await ok(['api', 'GET', `/api/v1/lite/invoices/${invoice.id}`])).json();
    assert.equal(fetched.id, invoice.id);

    // The server prints the invoice itself and attaches the e-invoice, as the desktop app does.
    const pdfFile = path.join(path.dirname(transcriptFile), 'lite-invoice.pdf');
    await fs.mkdir(path.dirname(pdfFile), { recursive: true });
    await ok(['pdf', 'export', '--kind', 'invoice', '--id', invoice.id, '--out', pdfFile]);
    const pdf = await fs.readFile(pdfFile);
    assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
    assert.ok(pdf.includes('factur-x.xml'), 'the invoice PDF carries the ZUGFeRD attachment');
    const eurFile = path.join(path.dirname(transcriptFile), 'lite-anlage-euer.pdf');
    await ok(['eur', 'exportPdf', '--tax-year', '2026', '--out', eurFile]);
    assert.equal((await fs.readFile(eurFile)).subarray(0, 5).toString(), '%PDF-');

    // Audit: default reason for every write, including routes whose adapter hard-codes one.
    await ok(['clients', 'upsert', '--input', '-', '--reason', 'Adresse korrigiert'], {
      stdin: JSON.stringify({ client: { ...savedClient, phone: '030 123456' } }),
    });
    const auditFile = path.join(configDir, 'audit.csv');
    await ok(['audit', 'exportCsv', '--out', auditFile]);
    const audit = await fs.readFile(auditFile, 'utf8');
    assert.ok(audit.includes('billme-cli (default)'), 'default CLI reason is in the audit log');
    assert.ok(audit.includes('Adresse korrigiert'), '--reason overrides the default');
    assert.ok(!audit.split('\n').filter((row) => row.includes(clientId)).some((row) => row.includes('Updated in Billme Lite web shell')), 'CLI mutation reasons replace adapter wording');

    // Device login: the CLI prints a link, a person signs in to the web app and confirms the code there.
    if (page) {
      let link;
      const login = billme(['login', '--base-url', apiUrl, '--no-browser', '--label', 'e2e-web', '--profile', 'device'], {
        onStderr: (text) => { link ??= /Confirm it here: (\S+)/.exec(text)?.[1]; },
      });
      await expect.poll(() => link, { message: 'the API needs BILLME_PUBLIC_WEB_URL to build the link' }).toBeTruthy();
      await page.goto(link, { waitUntil: 'networkidle' });
      await page.getByLabel('E-Mail-Adresse').fill(owner.email);
      await page.getByLabel('Passwort', { exact: true }).fill(owner.password);
      await page.getByRole('button', { name: 'Anmelden', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'CLI-Zugriff' })).toBeVisible();
      await expect(page.getByText('e2e-web').first()).toBeVisible();
      await page.getByRole('button', { name: 'Zugriff erlauben' }).click();
      assert.equal((await login).code, 0, 'the CLI is logged in once the code is confirmed');
      assert.ok((await ok(['clients', 'list', '--profile', 'device'])).json().length >= 1);
      await expect(page.getByText('Angemeldet am').first()).toBeVisible({ timeout: 15_000 });
      await ok(['logout', '--profile', 'device']);
      assert.equal((await billme(['clients', 'list', '--profile', 'device'])).code, 3);
    }

    const usage = await billme(['invoices', 'delete']);
    assert.equal(usage.code, 2, 'missing arguments are a usage error');
    assert.equal(JSON.parse(usage.stderr).error.code, 'usage');

    const unauthorized = await billme(['clients', 'list', '--token', 'not-a-token']);
    assert.equal(unauthorized.code, 3, 'a rejected token is an auth error');

    const unreachable = await billme(['clients', 'list', '--base-url', 'http://127.0.0.1:9']);
    assert.equal(unreachable.code, 4, 'an unreachable API has its own exit code');
  } finally {
    await fs.mkdir(path.dirname(transcriptFile), { recursive: true });
    await fs.writeFile(transcriptFile, `${JSON.stringify(transcript, null, 2)}\n`);
    await fs.rm(configDir, { recursive: true, force: true });
  }
};

// `BILLME_BASE_URL=http://127.0.0.1:3100 node tests/e2e/server/lite/cli.mjs` runs it against any server-mode API.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await runLiteCliScenario((process.env.BILLME_BASE_URL ?? 'http://127.0.0.1:3100').replace(/\/+$/, ''));
  console.log(`✓ lite-cli (transcript: ${path.relative(repoRoot, transcriptFile)})`);
}
