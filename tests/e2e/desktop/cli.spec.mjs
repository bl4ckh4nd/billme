import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { appUrl, launchDesktopApp, seedDesktopData } from '../support.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const billmeBin = path.join(repoRoot, 'packages', 'server-cli', 'bin', 'billme.mjs');
const artifactDir = path.join(repoRoot, 'test-results', 'cli');

let desktop;

test.beforeEach(async () => {
  desktop = await launchDesktopApp();
  await seedDesktopData(desktop.page, { settingsOverrides: { eInvoice: { enabled: true } } });
  await desktop.page.reload();
});

test.afterEach(async () => {
  if (desktop) {
    await desktop.close();
    desktop = undefined;
  }
});

test('the billme CLI logs in with a code confirmed in the app and works on the desktop data', async () => {
  const { page, baseUrl, userDataDir } = desktop;
  const transcript = [];
  const billme = (args, { onStderr } = {}) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [billmeBin, ...args], {
      // The spec launches the app with this userData override; the CLI looks for it in the same place.
      env: { ...process.env, BILLME_E2E_USER_DATA_DIR: userDataDir, BILLME_CLI_CONFIG: path.join(userDataDir, 'cli-config.json') },
      stdio: ['ignore', 'pipe', 'pipe'],
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
      transcript.push({ command: `billme ${args.join(' ')}`, exitCode: code, stdout, stderr });
      resolve({ code, stdout, stderr });
    });
  });

  try {
    let code;
    const login = billme(['login', '--target', 'desktop', '--label', 'Werkstatt-Laptop'], {
      onStderr: (text) => { code ??= /Code: ([A-Z0-9-]+)/.exec(text)?.[1]; },
    });
    await expect.poll(() => code, { timeout: 30_000 }).toBeTruthy();

    await page.goto(appUrl(baseUrl, '/settings'));
    await page.getByRole('navigation', { name: 'Einstellungsbereiche' }).getByRole('button', { name: /System/ }).click();
    await page.getByLabel('Code aus dem Terminal').fill(code);
    await page.getByRole('button', { name: 'Code prüfen' }).click();
    await expect(page.getByText('Werkstatt-Laptop')).toBeVisible();
    await page.getByRole('button', { name: 'Zugriff erlauben' }).click();
    expect((await login).code).toBe(0);

    // An invoice created in the terminal shows up in the app.
    const created = await billme([
      'invoices', 'create', '--client-id', 'c1',
      '--document', JSON.stringify({ items: [{ kind: 'item', description: 'CLI-Beratung', quantity: 1, price: 450, total: 450 }], amount: 450, status: 'open', clientAddress: 'Musterstrasse 123\n12345 Musterstadt' }),
    ]);
    expect(created.code, created.stderr).toBe(0);
    const invoice = JSON.parse(created.stdout);
    await page.goto(appUrl(baseUrl, '/documents'));
    await page.reload();
    await expect(page.getByText(invoice.number).first()).toBeVisible();

    // The app prints the PDF for the CLI, e-invoice attachment included.
    await fs.mkdir(artifactDir, { recursive: true });
    const pdfFile = path.join(artifactDir, 'desktop-invoice.pdf');
    const exported = await billme(['pdf', 'export', '--kind', 'invoice', '--id', invoice.id, '--out', pdfFile]);
    expect(exported.code, exported.stderr).toBe(0);
    const pdf = await fs.readFile(pdfFile);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.includes('factur-x.xml')).toBe(true);
    const eurFile = path.join(artifactDir, 'desktop-anlage-euer.pdf');
    expect((await billme(['eur', 'exportPdf', '--tax-year', '2026', '--out', eurFile])).code).toBe(0);
    expect((await fs.readFile(eurFile)).subarray(0, 5).toString()).toBe('%PDF-');

    // The terminal is listed in the app and loses access the moment it is revoked there.
    await page.goto(appUrl(baseUrl, '/settings'));
    await page.getByRole('navigation', { name: 'Einstellungsbereiche' }).getByRole('button', { name: /System/ }).click();
    await expect(page.getByText('Werkstatt-Laptop')).toBeVisible();
    await page.screenshot({ path: path.join(artifactDir, 'desktop-cli-access.png'), fullPage: true });
    await page.locator('#root').getByRole('button', { name: 'Widerrufen' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Widerrufen' }).click();
    await expect(page.getByText('Noch kein Terminal angemeldet.')).toBeVisible();
    expect((await billme(['clients', 'list'])).code).toBe(3);
  } finally {
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(
      path.join(artifactDir, 'desktop-app-transcript.json'),
      `${JSON.stringify(transcript, null, 2).replace(/billme_cli_[\w-]+/g, 'billme_cli_<redacted>')}\n`,
    );
  }
});
