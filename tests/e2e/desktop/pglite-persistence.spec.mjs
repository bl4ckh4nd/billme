import { expect, test } from '@playwright/test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { invokeDesktopIpc, launchDesktopApp } from '../support.mjs';

const clientFor = (namespace) => ({
  id: `${namespace}-client`,
  customerNumber: `KD-${namespace.slice(-6)}`,
  company: `${namespace} GmbH`,
  contactPerson: 'PGlite E2E',
  email: `${namespace}@example.test`,
  phone: '+49 30 5550100',
  address: 'Teststrasse 1, 10115 Berlin',
  status: 'active',
  tags: ['pglite-e2e'],
  notes: 'Persisted through the public desktop API',
  projects: [],
  activities: [],
});

const invoiceFor = (namespace, suffix = 'primary') => ({
  id: `${namespace}-invoice-${suffix}`,
  clientId: `${namespace}-client`,
  clientNumber: `KD-${namespace.slice(-6)}`,
  number: `RE-${namespace.slice(-6)}-${suffix === 'primary' ? '001' : '002'}`,
  client: `${namespace} GmbH`,
  clientEmail: `${namespace}@example.test`,
  clientAddress: 'Teststrasse 1, 10115 Berlin',
  date: '2026-08-01',
  dueDate: '2026-08-15',
  servicePeriod: '2026-08',
  amount: suffix === 'primary' ? 420 : 84,
  status: 'open',
  dunningLevel: 0,
  items: [{
    kind: 'item',
    description: suffix === 'primary' ? 'PGlite persistence fixture' : 'Restore-only fixture',
    quantity: 1,
    price: suffix === 'primary' ? 420 : 84,
    total: suffix === 'primary' ? 420 : 84,
  }],
  payments: [],
  history: [{ date: '2026-08-01', action: 'Electron PGlite E2E' }],
});

const waitForAppExit = async (desktop) => {
  const exited = await Promise.race([
    desktop.app.waitForEvent('close').then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  expect(exited).toBe(true);
};

const listPersistedInvoices = async (page) => {
  const invoices = await invokeDesktopIpc(page, 'invoices:list', {});
  return invoices.map((invoice) => invoice.id).sort();
};

const exerciseFreshProfile = async (app) => {
  const namespace = `electron-${app}-${process.pid}-${Date.now()}`;
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), `billme-${app}-pglite-e2e-`));
  let desktop;
  let backupPath;
  try {
    desktop = await launchDesktopApp({ app, userDataDir, cleanupUserData: false });
    const { page } = desktop;
    const client = clientFor(namespace);
    const invoice = invoiceFor(namespace);

    await expect.poll(() => page.evaluate(() => Boolean(window.billmeApi))).toBe(true);
    await invokeDesktopIpc(page, 'clients:upsert', { client });
    const saved = await invokeDesktopIpc(page, 'invoices:upsert', {
      reason: 'Electron PGlite persistence write',
      invoice,
    });
    expect(saved.id).toBe(invoice.id);
    expect(await listPersistedInvoices(page)).toContain(invoice.id);

    const backup = await invokeDesktopIpc(page, 'db:backup');
    backupPath = backup.path;
    expect(backupPath).toMatch(/\.pglite\.tar$/);
    expect(path.dirname(backupPath)).toBe(path.join(userDataDir, 'backups'));
    await expect(fs.stat(backupPath)).resolves.toMatchObject({ isFile: expect.any(Function) });
    expect((await fs.stat(backupPath)).size).toBeGreaterThan(0);

    await desktop.close();
    desktop = await launchDesktopApp({ app, userDataDir, cleanupUserData: false });
    expect(await listPersistedInvoices(desktop.page)).toContain(invoice.id);

    const restoreOnlyInvoice = invoiceFor(namespace, 'restore');
    await invokeDesktopIpc(desktop.page, 'invoices:upsert', {
      reason: 'Electron PGlite restore mutation',
      invoice: restoreOnlyInvoice,
    });
    expect(await listPersistedInvoices(desktop.page)).toEqual(expect.arrayContaining([invoice.id, restoreOnlyInvoice.id]));

    const exit = waitForAppExit(desktop);
    const restored = await invokeDesktopIpc(desktop.page, 'db:restore', { path: backupPath });
    expect(restored.ok).toBe(true);
    await exit;
    await desktop.close();
    desktop = await launchDesktopApp({ app, userDataDir, cleanupUserData: false });
    const afterRestore = await listPersistedInvoices(desktop.page);
    expect(afterRestore).toContain(invoice.id);
    expect(afterRestore).not.toContain(restoreOnlyInvoice.id);
  } finally {
    if (desktop) await desktop.close().catch(() => undefined);
    await fs.rm(userDataDir, { recursive: true, force: true });
  }
};

test.describe('embedded PGlite desktop persistence', () => {
  test('Lite writes, restarts, backs up, restores, and refetches through public IPC', async () => {
    await exerciseFreshProfile('desktop');
  });

  test('Pro writes, restarts, backs up, restores, and refetches through public IPC', async () => {
    await exerciseFreshProfile('pro');
  });
});
