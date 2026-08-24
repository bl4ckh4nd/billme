import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';

const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const migrationsDir = join(repoRoot, 'packages', 'server-data', 'drizzle');
const apps = [
  { name: 'desktop', directory: join(repoRoot, 'apps', 'desktop'), executable: join(repoRoot, 'apps', 'desktop', 'release', 'linux-unpacked', 'billme') },
  { name: 'pro', directory: join(repoRoot, 'apps', 'pro-desktop'), executable: join(repoRoot, 'apps', 'pro-desktop', 'release', 'linux-unpacked', 'billme-pro') },
];

const run = (command, args, cwd) => {
  execFileSync(command, args, { cwd, stdio: 'inherit', env: process.env });
};

const invoke = async (page, group, method, payload) => page.evaluate(
  async ({ group: apiGroup, method: apiMethod, payload: apiPayload }) => {
    const fn = globalThis.billmeApi?.[apiGroup]?.[apiMethod];
    if (typeof fn !== 'function') throw new Error(`Missing public API ${apiGroup}:${apiMethod}`);
    return apiPayload === undefined ? fn() : fn(apiPayload);
  },
  { group, method, payload },
);

const waitForBackend = async (page) => {
  let lastError;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await invoke(page, 'clients', 'list');
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    }
  }
  throw lastError ?? new Error('Packaged embedded backend did not become ready.');
};

const profileProcessIds = (executable, userDataDir) => {
  const output = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' });
  return output.split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match || !match[2].includes(executable) || !match[2].includes(`--user-data-dir=${userDataDir}`)) return [];
    const pid = Number(match[1]);
    return pid && pid !== process.pid ? [pid] : [];
  });
};

const killProfileProcesses = (executable, userDataDir) => {
  for (const pid of profileProcessIds(executable, userDataDir)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
};

const waitForClose = async (app) => {
  const closed = await Promise.race([
    app.waitForEvent('close').then(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 5000)),
  ]);
  assert.equal(closed, true, 'packaged restore triggered a controlled Electron exit');
};

const closePackagedApp = async (app, executable, userDataDir) => {
  let child;
  try {
    child = app.process();
  } catch {
    child = undefined;
  }
  await Promise.race([
    app.close().catch(() => undefined),
    new Promise((resolveWait) => setTimeout(resolveWait, 1500)),
  ]);
  if (child?.pid) {
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch (error) {
      if (error?.code !== 'ESRCH') throw error;
    }
  }
  killProfileProcesses(executable, userDataDir);
};

const buildAndVerify = ({ directory, name }) => {
  run('pnpm', ['build'], directory);
  run('pnpm', ['exec', 'electron-builder', '--dir', '--config', 'electron-builder.yml', '--publish', 'never'], directory);
  run('node', [`apps/${name === 'pro' ? 'pro-desktop' : 'desktop'}/scripts/verify-native-packaging.mjs`], repoRoot);
};

const launchWithProfile = async ({ directory, executable, userDataDir }) => electron.launch({
  executablePath: executable,
  cwd: directory,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu-sandbox', `--user-data-dir=${userDataDir}`],
  env: {
    ...process.env,
    BILLME_E2E: '1',
    BILLME_E2E_USER_DATA_DIR: userDataDir,
    BILLME_E2E_CACHE_DIR: join(userDataDir, 'cache'),
    BILLME_SERVER_DATA_MIGRATIONS_DIR: migrationsDir,
  },
});

const launchPackaged = async ({ name, directory, executable }) => {
  await stat(executable);
  const userDataDir = await mkdtemp(join('/tmp', `billme-${name}-packaged-e2e-`));
  let app;
  try {
    app = await launchWithProfile({ directory, executable, userDataDir });
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => Boolean(globalThis.billmeApi));
    await waitForBackend(page);
    const client = {
      id: `packaged-${name}-client`,
      company: `Packaged ${name}`,
      contactPerson: 'Packaged E2E',
      email: `packaged-${name}@example.test`,
      phone: '+49 30 5550101',
      address: 'Teststrasse 2, 10115 Berlin',
      status: 'active',
      tags: ['packaged-e2e'],
      notes: 'Written through public IPC',
      projects: [],
      activities: [],
    };
    const saved = await invoke(page, 'clients', 'upsert', { client });
    assert.equal(saved.id, client.id);
    const listed = await invoke(page, 'clients', 'list');
    assert.ok(listed.some((entry) => entry.id === client.id), `${name} packaged write persisted`);

    const backup = await invoke(page, 'db', 'backup');
    assert.match(backup.path, /\.pglite\.tar$/);
    assert.equal((await stat(backup.path)).isFile(), true);
    assert.ok((await stat(backup.path)).size > 0, `${name} packaged backup is non-empty`);

    await closePackagedApp(app, executable, userDataDir);
    app = await launchWithProfile({ directory, executable, userDataDir });
    let restartedPage = await app.firstWindow();
    await restartedPage.waitForLoadState('domcontentloaded');
    await waitForBackend(restartedPage);
    const afterRestart = await invoke(restartedPage, 'clients', 'list');
    assert.ok(afterRestart.some((entry) => entry.id === client.id), `${name} packaged restart persisted write`);

    const restoreOnly = { ...client, id: `${client.id}-restore-only`, company: `${client.company} Restore` };
    await invoke(restartedPage, 'clients', 'upsert', { client: restoreOnly });
    const restoreStarted = waitForClose(app);
    const restored = await invoke(restartedPage, 'db', 'restore', { path: backup.path });
    assert.equal(restored.ok, true);
    await restoreStarted;
    await closePackagedApp(app, executable, userDataDir);
    app = await launchWithProfile({ directory, executable, userDataDir });
    restartedPage = await app.firstWindow();
    await restartedPage.waitForLoadState('domcontentloaded');
    await waitForBackend(restartedPage);
    const afterRestore = await invoke(restartedPage, 'clients', 'list');
    assert.ok(afterRestore.some((entry) => entry.id === client.id), `${name} packaged restore kept original write`);
    assert.ok(!afterRestore.some((entry) => entry.id === restoreOnly.id), `${name} packaged restore removed later write`);
  } finally {
    if (app) await closePackagedApp(app, executable, userDataDir);
    await rm(userDataDir, { recursive: true, force: true });
  }
};

for (const app of apps) {
  buildAndVerify(app);
  await launchPackaged(app);
  console.log(`[packaged-smoke] ${app.name}: build, native asset verification, launch, readiness, and public write passed`);
}
