import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../..');
const composeFile = path.join(repoRoot, 'docker-compose.server-mode.yml');
const exampleEnvFile = path.join(repoRoot, '.env.server-mode.example');
const runtimeDir = path.join(repoRoot, 'test-results', 'server-mode');
const latestStateFile = path.join(runtimeDir, 'runtime-state.json');
const bootTimeoutMs = Number(process.env.E2E_SERVER_BOOT_TIMEOUT_MS ?? 10 * 60_000);
const pollIntervalMs = Number(process.env.E2E_SERVER_POLL_INTERVAL_MS ?? 1_000);
const isDebugEnabled = process.env.E2E_SERVER_DEBUG === '1';
const supportedContainerRuntimes = ['docker', 'podman'];
const supportedEnvKeys = [
  'COMPOSE_PROJECT_NAME',
  'BILLME_POSTGRES_DB',
  'BILLME_POSTGRES_USER',
  'BILLME_POSTGRES_PASSWORD',
  'BILLME_POSTGRES_PORT',
  'BILLME_API_PORT',
  'BILLME_PUBLIC_API_URL',
  'BILLME_SESSION_SECRET',
  'BILLME_WEB_PORT',
  'BILLME_WEB_PRO_PORT',
  'WORKER_LOG_LEVEL',
  'WORKER_RECURRING_INTERVAL_MS',
  'WORKER_DUNNING_INTERVAL_MS',
  'WORKER_EMAIL_QUEUE_INTERVAL_MS',
  'WORKER_PORTAL_SYNC_INTERVAL_MS',
  'WORKER_MAINTENANCE_INTERVAL_MS',
  'WORKER_RUN_ONCE',
  'SMTP_PASSWORD',
  'RESEND_API_KEY',
];
const requiredHealthServices = ['postgres', 'server-api', 'server-worker', 'web', 'web-pro'];
const getStateFilePath = () => process.env.E2E_SERVER_STATE_FILE?.trim() || latestStateFile;

const readRuntimeStateFile = async (stateFile) => ({
  ...JSON.parse(await fs.readFile(stateFile, 'utf8')),
  stateFile,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const debugLog = (...parts) => {
  if (!isDebugEnabled) return;
  console.error('[server-harness]', ...parts);
};

const parseEnv = (content) => {
  const values = {};
  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separatorIndex = rawLine.indexOf('=');
    if (separatorIndex <= 0) continue;
    const key = rawLine.slice(0, separatorIndex).trim();
    let value = rawLine.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
};

const serializeEnv = (values) =>
  `${Object.entries(values)
    .map(([key, value]) => `${key}=${String(value ?? '')}`)
    .join('\n')}\n`;

const resolveUserEnvFile = () => {
  const configuredPath = process.env.E2E_SERVER_ENV_FILE?.trim();
  if (!configuredPath) return null;
  return path.isAbsolute(configuredPath) ? configuredPath : path.join(repoRoot, configuredPath);
};

const readEnvFile = async (filePath) => {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return parseEnv(content);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return {};
    }
    throw error;
  }
};

const pickProcessEnv = () =>
  Object.fromEntries(
    supportedEnvKeys.flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]]))
  );

const randomValue = () => crypto.randomBytes(18).toString('hex');

const getPodmanSocketPath = () => {
  return path.join('/tmp', `billme-podman-${process.pid}.sock`);
};

const getPodmanHomePath = (projectName) => path.join(process.env.TMPDIR ?? os.tmpdir(), `${projectName}-podman-home`);

const getFreePort = async () =>
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to reserve a local port for the server-mode E2E harness.'));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });

const runCommand = async (command, args, options = {}) =>
  await new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd ?? repoRoot,
        env: options.env ?? process.env,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: options.timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error && !options.allowFailure) {
          error.stdout = stdout;
          error.stderr = stderr;
          reject(error);
          return;
        }

        resolve({
          code: error?.code ?? 0,
          error: error ?? null,
          stdout,
          stderr,
        });
      }
      );
  });

const getConfiguredContainerRuntime = () => process.env.E2E_CONTAINER_RUNTIME?.trim().toLowerCase() || null;

const resolveContainerRuntime = async () => {
  const configuredRuntime = getConfiguredContainerRuntime();
  if (configuredRuntime && !supportedContainerRuntimes.includes(configuredRuntime)) {
    throw new Error(
      `Unsupported E2E container runtime "${configuredRuntime}". Use one of: ${supportedContainerRuntimes.join(', ')}.`
    );
  }

  const runtimeCandidates = configuredRuntime ? [configuredRuntime] : supportedContainerRuntimes;
  const failures = [];

  for (const runtime of runtimeCandidates) {
    const result = await runCommand(runtime, ['info'], {
      allowFailure: true,
      timeoutMs: 30_000,
    });

    if (result.code === 0) {
      return runtime;
    }

    failures.push(`${runtime}: ${result.stderr?.trim() || result.stdout?.trim() || 'info failed.'}`);
  }

  throw new Error(
    `Server-mode E2E requires Docker or Podman access. ${failures.join(' ')}`
  );
};

const waitForPodmanSocket = async (socketPath) => {
  const deadline = Date.now() + 15_000;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      await fs.access(socketPath);
      return;
    } catch (error) {
      lastError = error;
      await sleep(250);
    }
  }

  throw new Error(
    `Timed out waiting for Podman API socket at ${socketPath}.${lastError instanceof Error ? ` ${lastError.message}` : ''}`
  );
};

const startDetachedCommand = async (command, args, logFilePath, env = process.env) => {
  await fs.mkdir(path.dirname(logFilePath), { recursive: true });
  const child = spawn(command, args, {
    cwd: repoRoot,
    detached: true,
    env,
    stdio: 'ignore',
  });
  child.unref();
  await fs.writeFile(logFilePath, `${command} ${args.join(' ')}\n`);
  return child.pid ?? null;
};

const ensurePodmanService = async (state) => {
  if (state.containerRuntime !== 'podman') {
    return state;
  }

  const socketPath = getPodmanSocketPath();
  const podmanHome = state.podmanHome ?? getPodmanHomePath(state.projectName);
  const nextState = {
    ...state,
    podmanHome,
    podmanSocketPath: socketPath,
  };

  try {
    await fs.access(socketPath);
    return nextState;
  } catch {}

  await fs.mkdir(path.join(podmanHome, '.local', 'share'), { recursive: true });

  const servicePid = await startDetachedCommand(
    'podman',
    ['system', 'service', '--time', '1800', `unix://${socketPath}`],
    path.join(state.diagnosticsDir, 'podman-service.txt'),
    {
      ...process.env,
      HOME: podmanHome,
      STORAGE_DRIVER: 'vfs',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      XDG_DATA_HOME: path.join(podmanHome, '.local', 'share'),
    }
  );

  await waitForPodmanSocket(socketPath);

  return {
    ...nextState,
    podmanSocketActivated: false,
    podmanServicePid: servicePid,
  };
};

const getContainerEnv = (state, env = process.env) => {
  const nextEnv = {
    ...env,
    HOME: state.podmanHome ?? env.HOME,
    STORAGE_DRIVER: state.podmanHome ? 'vfs' : env.STORAGE_DRIVER,
    TMPDIR: env.TMPDIR ?? '/tmp',
    XDG_DATA_HOME: state.podmanHome ? path.join(state.podmanHome, '.local', 'share') : env.XDG_DATA_HOME,
  };

  if (state.containerRuntime !== 'podman' || !state.podmanSocketPath) {
    return nextEnv;
  }

  return {
    ...nextEnv,
    DOCKER_HOST: `unix://${state.podmanSocketPath ?? getPodmanSocketPath()}`,
  };
};

const composeArgs = (state, args) => [
  'compose',
  '-p',
  state.projectName,
  '--env-file',
  state.envFile,
  '-f',
  composeFile,
  ...args,
];

const runCompose = async (state, args, options = {}) =>
  await runCommand(state.containerRuntime, composeArgs(state, args), {
    ...options,
    env: getContainerEnv(state, options.env),
  });

const inspectComposeServiceHealth = async (state, service) => {
  const container = await runCompose(state, ['ps', '-q', service], { allowFailure: true });
  const containerId = container.stdout.trim();
  if (!containerId) return 'missing';

  const inspect = await runCommand(
    state.containerRuntime,
    ['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', containerId],
    { allowFailure: true, env: getContainerEnv(state) }
  );
  return inspect.stdout.trim() || 'missing';
};

const waitForServiceHealth = async (state, service) => {
  const deadline = Date.now() + bootTimeoutMs;
  let lastStatus = 'missing';

  while (Date.now() < deadline) {
    lastStatus = await inspectComposeServiceHealth(state, service);
    if (lastStatus === 'healthy') {
      return lastStatus;
    }
    if (['exited', 'dead', 'unhealthy'].includes(lastStatus)) {
      throw new Error(`Service ${service} became ${lastStatus} while starting the server-mode E2E stack.`);
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for ${service} to become healthy. Last status: ${lastStatus}.`);
};

const waitForTextResponse = async (url, predicate, description) => {
  const deadline = Date.now() + bootTimeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      const body = await response.text();
      if (predicate(response, body)) {
        return body;
      }
      lastError = new Error(`${description} returned ${response.status}: ${body}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for ${description}. ${lastError ? `Last error: ${lastError.message}` : ''}`.trim());
};

const waitForJsonResponse = async (url, predicate, description) => {
  const deadline = Date.now() + bootTimeoutMs;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.text();
      if (!response.ok) {
        lastError = new Error(`${description} returned ${response.status}: ${body}`);
        await sleep(pollIntervalMs);
        continue;
      }
      const data = JSON.parse(body);
      if (predicate(data, response)) {
        return data;
      }
      lastError = new Error(`${description} returned unexpected payload: ${body}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for ${description}. ${lastError ? `Last error: ${lastError.message}` : ''}`.trim());
};

const canConnectToPostgres = async (databaseUrl) => {
  const { Client } = await import('pg');
  const client = new Client({
    connectionString: databaseUrl,
    connectionTimeoutMillis: 3_000,
  });

  try {
    await client.connect();
    await client.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => {});
  }
};

const waitForPostgresReady = async (databaseUrl, description) => {
  const deadline = Date.now() + bootTimeoutMs;

  while (Date.now() < deadline) {
    if (await canConnectToPostgres(databaseUrl)) {
      return;
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for ${description} to accept connections.`);
};

const isBootstrapStatusReady = (payload) =>
  Boolean(payload) &&
  typeof payload.bootstrapped === 'boolean' &&
  typeof payload.userCount === 'number';

const isProcessAlive = (pid) => {
  if (!pid) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const startProcessService = async ({
  command,
  args,
  cwd = repoRoot,
  diagnosticsDirPath = runtimeDir,
  env = process.env,
  logFileName,
}) => {
  const logPath = path.join(diagnosticsDirPath, logFileName);
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const logHandle = await fs.open(logPath, 'a');
  await logHandle.writeFile(`${command} ${args.join(' ')}\n`);

  const child = spawn(command, args, {
    cwd,
    detached: true,
    env,
    stdio: ['ignore', logHandle.fd, logHandle.fd],
  });
  child.unref();
  await logHandle.close();
  return child.pid ?? null;
};

const inspectPodmanContainerHealth = async (containerName, state = null) => {
  const inspect = await runCommand(
    'podman',
    ['inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}', containerName],
    {
      allowFailure: true,
      env: state ? getContainerEnv(state) : process.env,
    }
  );
  return inspect.stdout.trim() || 'missing';
};

const waitForPodmanContainerHealth = async (containerName, description, state = null) => {
  const deadline = Date.now() + bootTimeoutMs;
  let lastStatus = 'missing';

  while (Date.now() < deadline) {
    lastStatus = await inspectPodmanContainerHealth(containerName, state);
    if (lastStatus === 'healthy') {
      return lastStatus;
    }
    if (['exited', 'dead', 'unhealthy'].includes(lastStatus)) {
      throw new Error(`${description} became ${lastStatus} while starting the server-mode E2E stack.`);
    }
    await sleep(pollIntervalMs);
  }

  throw new Error(`Timed out waiting for ${description} to become healthy. Last status: ${lastStatus}.`);
};

const writeRuntimeConfig = async (distDir, apiUrl) => {
  const content = `window.billmeRuntimeConfig = {\n  serverApiUrl: ${JSON.stringify(apiUrl)},\n};\n`;
  await fs.writeFile(path.join(repoRoot, distDir, 'dist', 'runtime-config.js'), content, 'utf8');
};

const buildProcessModeApps = async (state) => {
  await runCommand('pnpm', ['-C', 'apps/web', 'build'], {
    timeoutMs: bootTimeoutMs,
    env: {
      ...process.env,
      VITE_SERVER_API_URL: state.urls.api,
    },
  });
  await writeRuntimeConfig('apps/web', state.urls.api);

  await runCommand('pnpm', ['-C', 'apps/web-pro', 'build'], {
    timeoutMs: bootTimeoutMs,
    env: {
      ...process.env,
      VITE_SERVER_API_URL: state.urls.api,
    },
  });
  await writeRuntimeConfig('apps/web-pro', state.urls.api);
};

const createProcessDatabaseUrl = (state, env) =>
  `postgresql://${encodeURIComponent(env.BILLME_POSTGRES_USER ?? 'billme')}:${encodeURIComponent(env.BILLME_POSTGRES_PASSWORD ?? 'billme')}@127.0.0.1:${state.ports.postgres}/${encodeURIComponent(env.BILLME_POSTGRES_DB ?? 'billme')}`;

const preparePodmanPostgresVolume = async (state, volumeName) => {
  const volumeCreate = await runCommand('podman', ['volume', 'create', volumeName], {
    allowFailure: true,
    env: getContainerEnv(state),
  });

  if (volumeCreate.code !== 0 && !volumeCreate.stderr.includes('already exists')) {
    throw new Error(volumeCreate.stderr.trim() || `Failed to create Podman volume ${volumeName}.`);
  }

  const inspect = await runCommand('podman', ['volume', 'inspect', '--format', '{{ .Mountpoint }}', volumeName], {
    env: getContainerEnv(state),
  });
  const mountpoint = inspect.stdout.trim();

  if (!mountpoint) {
    throw new Error(`Could not resolve mountpoint for Podman volume ${volumeName}.`);
  }

  await runCommand('podman', ['unshare', 'chown', '-R', '70:70', mountpoint], {
    env: getContainerEnv(state),
  });
};

const startServerModeProcessStack = async (state, startupError) => {
  debugLog('process:start', state.projectName);
  const env = parseEnv(await fs.readFile(state.envFile, 'utf8'));
  const databaseUrl = createProcessDatabaseUrl(state, env);
  const postgresContainerName = `${state.projectName}-postgres`;
  const postgresVolumeName = `${state.projectName}-postgres-data`;

  debugLog('process:build-apps');
  await buildProcessModeApps(state);

  debugLog('process:start-postgres', postgresContainerName);
  await preparePodmanPostgresVolume(state, postgresVolumeName);
  await runCommand(
    'podman',
    [
      'run',
      '-d',
      '--name',
      postgresContainerName,
      '-v',
      `${postgresVolumeName}:/var/lib/postgresql/data`,
      '-p',
      `${state.ports.postgres}:5432`,
      '-e',
      `POSTGRES_DB=${env.BILLME_POSTGRES_DB ?? 'billme'}`,
      '-e',
      `POSTGRES_USER=${env.BILLME_POSTGRES_USER ?? 'billme'}`,
      '-e',
      `POSTGRES_PASSWORD=${env.BILLME_POSTGRES_PASSWORD ?? 'billme'}`,
      '--health-cmd',
      `pg_isready -U ${env.BILLME_POSTGRES_USER ?? 'billme'} -d ${env.BILLME_POSTGRES_DB ?? 'billme'}`,
      '--health-interval',
      '2s',
      '--health-timeout',
      '5s',
      '--health-retries',
      '30',
      'docker.io/library/postgres:16-alpine',
    ],
    {
      timeoutMs: bootTimeoutMs,
      env: getContainerEnv(state),
    }
  );

  debugLog('process:wait-postgres-health');
  await waitForPostgresReady(databaseUrl, 'Postgres database');

  const commonServerEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    HOST: '127.0.0.1',
    PORT: String(state.ports.api),
    SESSION_SECRET: env.BILLME_SESSION_SECRET ?? 'billme-e2e-session-secret',
  };
  const workerEnv = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    SMTP_PASSWORD: env.SMTP_PASSWORD ?? '',
    RESEND_API_KEY: env.RESEND_API_KEY ?? '',
    WORKER_LOG_LEVEL: env.WORKER_LOG_LEVEL ?? 'info',
    WORKER_RECURRING_INTERVAL_MS: env.WORKER_RECURRING_INTERVAL_MS ?? '900000',
    WORKER_DUNNING_INTERVAL_MS: env.WORKER_DUNNING_INTERVAL_MS ?? '900000',
    WORKER_EMAIL_QUEUE_INTERVAL_MS: env.WORKER_EMAIL_QUEUE_INTERVAL_MS ?? '60000',
    WORKER_PORTAL_SYNC_INTERVAL_MS: env.WORKER_PORTAL_SYNC_INTERVAL_MS ?? '60000',
    WORKER_MAINTENANCE_INTERVAL_MS: env.WORKER_MAINTENANCE_INTERVAL_MS ?? '86400000',
    WORKER_RUN_ONCE: '0',
  };

  const apiPid = await startProcessService({
    command: 'pnpm',
    args: ['-C', 'apps/server-api', 'exec', 'node', '--import', 'tsx', 'src/server.ts'],
    env: commonServerEnv,
    logFileName: 'server-api.log',
    diagnosticsDirPath: state.diagnosticsDir,
  });

  if (!apiPid) {
    throw new Error('Failed to start the server-mode API process.');
  }

  debugLog('process:wait-api-health', apiPid);
  await waitForTextResponse(state.urls.apiHealth, (response) => response.ok, 'API health endpoint');

  const [webPid, webProPid] = await Promise.all([
    startProcessService({
      command: 'pnpm',
      args: ['preview', '--host', '127.0.0.1', '--port', String(state.ports.web)],
      cwd: path.join(repoRoot, 'apps', 'web'),
      logFileName: 'web.log',
      diagnosticsDirPath: state.diagnosticsDir,
    }),
    startProcessService({
      command: 'pnpm',
      args: ['preview', '--host', '127.0.0.1', '--port', String(state.ports.webPro)],
      cwd: path.join(repoRoot, 'apps', 'web-pro'),
      logFileName: 'web-pro.log',
      diagnosticsDirPath: state.diagnosticsDir,
    }),
  ]);

  if (![webPid, webProPid].every(Boolean)) {
    throw new Error('Failed to start one or more server-mode web preview services.');
  }

  debugLog('process:wait-web-health', webPid, webProPid);
  await waitForTextResponse(
    state.urls.webHealth,
    (response, body) => response.ok && (body.trim() === 'ok' || body.includes('<div id="root"></div>')),
    'Lite web health endpoint'
  );
  await waitForTextResponse(
    state.urls.webProHealth,
    (response, body) => response.ok && (body.trim() === 'ok' || body.includes('<div id="root"></div>')),
    'Pro web health endpoint'
  );

  const [liteBootstrapStatus, proBootstrapStatus] = await Promise.all([
    waitForJsonResponse(
      state.urls.liteBootstrapStatus,
      isBootstrapStatusReady,
      'Lite bootstrap status'
    ),
    waitForJsonResponse(
      state.urls.proBootstrapStatus,
      isBootstrapStatusReady,
      'Pro bootstrap status'
    ),
  ]);

  const workerPid = await startProcessService({
    command: 'pnpm',
    args: ['-C', 'apps/server-worker', 'exec', 'node', '--import', 'tsx', 'src/worker.ts'],
    env: workerEnv,
    logFileName: 'server-worker.log',
    diagnosticsDirPath: state.diagnosticsDir,
  });

  if (!workerPid || !isProcessAlive(workerPid)) {
    throw new Error('Failed to start the server-mode worker process.');
  }
  debugLog('process:worker-started', workerPid);

  const startedState = {
    ...state,
    mode: 'process',
    bootstrapStatus: {
      lite: liteBootstrapStatus,
      pro: proBootstrapStatus,
    },
    fallbackReason: startupError instanceof Error ? startupError.message : String(startupError),
    postgresContainerName,
    postgresVolumeName,
    processPids: {
      api: apiPid,
      worker: workerPid,
      web: webPid,
      webPro: webProPid,
    },
    startedAt: new Date().toISOString(),
  };

  await writeRuntimeState(startedState);
  debugLog('process:done', startedState.stateFile);
  return startedState;
};

const writeRuntimeState = async (state) => {
  await fs.mkdir(runtimeDir, { recursive: true });
  const serialized = JSON.stringify(state, null, 2);
  await Promise.all([
    fs.writeFile(state.stateFile, serialized),
    fs.writeFile(latestStateFile, serialized),
  ]);
};

const createRuntimeState = async () => {
  debugLog('create-runtime:start');
  await fs.mkdir(runtimeDir, { recursive: true });

  const fileEnv = await readEnvFile(exampleEnvFile);
  const userEnvFile = resolveUserEnvFile();
  const userEnv = userEnvFile ? await readEnvFile(userEnvFile) : {};
  const processEnv = pickProcessEnv();
  const sourceEnv = { ...fileEnv, ...userEnv, ...processEnv };

  const projectName =
    processEnv.COMPOSE_PROJECT_NAME ??
    userEnv.COMPOSE_PROJECT_NAME ??
    `billme-e2e-${Date.now().toString(36)}-${process.pid.toString(36)}`;
  const runDir = path.join(runtimeDir, projectName);
  const runDiagnosticsDir = path.join(runDir, 'diagnostics');
  const runStateFile = path.join(runDir, 'runtime-state.json');
  const runComposeEnvFile = path.join(runDir, 'compose.env');
  await fs.rm(runDir, { recursive: true, force: true });
  await fs.mkdir(runDiagnosticsDir, { recursive: true });
  const postgresPort = processEnv.BILLME_POSTGRES_PORT ?? userEnv.BILLME_POSTGRES_PORT ?? String(await getFreePort());
  const apiPort = processEnv.BILLME_API_PORT ?? userEnv.BILLME_API_PORT ?? String(await getFreePort());
  const publicApiUrl =
    processEnv.BILLME_PUBLIC_API_URL ?? userEnv.BILLME_PUBLIC_API_URL ?? `http://127.0.0.1:${apiPort}`;
  const webPort = processEnv.BILLME_WEB_PORT ?? userEnv.BILLME_WEB_PORT ?? String(await getFreePort());
  const webProPort = processEnv.BILLME_WEB_PRO_PORT ?? userEnv.BILLME_WEB_PRO_PORT ?? String(await getFreePort());

  const env = {
    ...fileEnv,
    ...userEnv,
    ...processEnv,
    COMPOSE_PROJECT_NAME: projectName,
    BILLME_POSTGRES_DB: sourceEnv.BILLME_POSTGRES_DB ?? 'billme',
    BILLME_POSTGRES_USER: sourceEnv.BILLME_POSTGRES_USER ?? 'billme',
    BILLME_POSTGRES_PASSWORD: processEnv.BILLME_POSTGRES_PASSWORD ?? userEnv.BILLME_POSTGRES_PASSWORD ?? randomValue(),
    BILLME_POSTGRES_PORT: postgresPort,
    BILLME_API_PORT: apiPort,
    BILLME_PUBLIC_API_URL: publicApiUrl,
    BILLME_SESSION_SECRET: processEnv.BILLME_SESSION_SECRET ?? userEnv.BILLME_SESSION_SECRET ?? randomValue(),
    BILLME_WEB_PORT: webPort,
    BILLME_WEB_PRO_PORT: webProPort,
    WORKER_LOG_LEVEL: sourceEnv.WORKER_LOG_LEVEL ?? 'info',
    WORKER_RECURRING_INTERVAL_MS: sourceEnv.WORKER_RECURRING_INTERVAL_MS ?? '900000',
    WORKER_DUNNING_INTERVAL_MS: sourceEnv.WORKER_DUNNING_INTERVAL_MS ?? '900000',
    WORKER_EMAIL_QUEUE_INTERVAL_MS: sourceEnv.WORKER_EMAIL_QUEUE_INTERVAL_MS ?? '60000',
    WORKER_PORTAL_SYNC_INTERVAL_MS: sourceEnv.WORKER_PORTAL_SYNC_INTERVAL_MS ?? '60000',
    WORKER_MAINTENANCE_INTERVAL_MS: sourceEnv.WORKER_MAINTENANCE_INTERVAL_MS ?? '86400000',
    WORKER_RUN_ONCE: sourceEnv.WORKER_RUN_ONCE ?? '0',
    SMTP_PASSWORD: sourceEnv.SMTP_PASSWORD ?? '',
    RESEND_API_KEY: sourceEnv.RESEND_API_KEY ?? '',
  };

  await fs.writeFile(runComposeEnvFile, serializeEnv(env));
  debugLog('create-runtime:done', projectName, runStateFile);

  return {
    createdAt: new Date().toISOString(),
    diagnosticsDir: runDiagnosticsDir,
    env,
    envFile: runComposeEnvFile,
    containerRuntime: null,
    mode: 'compose',
    podmanHome: null,
    podmanServicePid: null,
    podmanSocketActivated: false,
    podmanSocketPath: null,
    postgresContainerName: null,
    postgresVolumeName: null,
    processPids: null,
    ports: {
      postgres: Number(postgresPort),
      api: Number(apiPort),
      web: Number(webPort),
      webPro: Number(webProPort),
    },
    projectName,
    stateFile: runStateFile,
    urls: {
      api: publicApiUrl,
      apiHealth: `${publicApiUrl}/health`,
      liteBootstrapStatus: `${publicApiUrl}/api/v1/auth/bootstrap/status?product=lite`,
      proBootstrapStatus: `${publicApiUrl}/api/v1/auth/bootstrap/status?product=pro`,
      web: `http://127.0.0.1:${webPort}`,
      webHealth: `http://127.0.0.1:${webPort}/health`,
      webPro: `http://127.0.0.1:${webProPort}`,
      webProHealth: `http://127.0.0.1:${webProPort}/health`,
    },
  };
};

export const isServerModeE2E = () => process.env.E2E_TARGET === 'server' || process.env.E2E_SERVER_MODE === '1';

export const readServerHarnessState = async () => {
  const stateFile = getStateFilePath();
  try {
    return await readRuntimeStateFile(stateFile);
  } catch (error) {
    if (stateFile !== latestStateFile && error?.code === 'ENOENT') {
      return await readRuntimeStateFile(latestStateFile);
    }
    throw error;
  }
};

export const getComposeServiceHealth = async (service, state = null) => {
  const resolvedState = state ?? (await readServerHarnessState());
  if (resolvedState.mode === 'process') {
    if (service === 'postgres') {
      const databaseUrl = createProcessDatabaseUrl(resolvedState, resolvedState.env);
      return (await canConnectToPostgres(databaseUrl))
        ? 'healthy'
        : await inspectPodmanContainerHealth(resolvedState.postgresContainerName, resolvedState);
    }
    const pid = resolvedState.processPids?.[service === 'server-api' ? 'api' : service === 'server-worker' ? 'worker' : service === 'web' ? 'web' : 'webPro'];
    return isProcessAlive(pid) ? 'healthy' : 'missing';
  }
  return inspectComposeServiceHealth(resolvedState, service);
};

export async function collectComposeDiagnostics(state) {
  if (!state) return;
  if (state.mode === 'process') return;
  await fs.mkdir(state.diagnosticsDir, { recursive: true });

  const [ps, logs] = await Promise.all([
    runCompose(state, ['ps', '--all'], { allowFailure: true }),
    runCompose(state, ['logs', '--no-color', '--timestamps'], { allowFailure: true, timeoutMs: 120_000 }),
  ]);

  await Promise.all([
    fs.writeFile(path.join(state.diagnosticsDir, 'compose-ps.txt'), [ps.stdout, ps.stderr].filter(Boolean).join('\n')),
    fs.writeFile(
      path.join(state.diagnosticsDir, 'compose-logs.txt'),
      [logs.stdout, logs.stderr].filter(Boolean).join('\n')
    ),
  ]);
}

export async function stopServerModeStack(currentState = null) {
  const state = currentState ?? (await readServerHarnessState().catch(() => null));
  if (!state) return;

  await collectComposeDiagnostics(state).catch(() => {});

  if (process.env.E2E_SERVER_KEEP_STACK === '1') {
    await writeRuntimeState({
      ...state,
      stoppedAt: new Date().toISOString(),
      teardownMode: 'preserved',
    });
    return;
  }

  if (state.mode === 'process') {
    for (const pid of Object.values(state.processPids ?? {})) {
      if (pid) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {}
      }
    }
    if (state.postgresContainerName) {
      await runCommand('podman', ['rm', '-f', state.postgresContainerName], {
        allowFailure: true,
        env: getContainerEnv(state),
        timeoutMs: 30_000,
      });
    }
    if (state.postgresVolumeName) {
      await runCommand('podman', ['volume', 'rm', '-f', state.postgresVolumeName], {
        allowFailure: true,
        env: getContainerEnv(state),
        timeoutMs: 30_000,
      });
    }
  } else {
    await runCompose(state, ['down', '-v', '--remove-orphans'], {
      allowFailure: true,
      timeoutMs: 120_000,
    });
  }

  if (state.podmanServicePid) {
    try {
      process.kill(state.podmanServicePid, 'SIGTERM');
    } catch {}
  }

  if (state.podmanHome) {
    await fs.rm(state.podmanHome, { recursive: true, force: true }).catch(() => {});
  }

  await writeRuntimeState({
    ...state,
    stoppedAt: new Date().toISOString(),
    teardownMode: 'destroyed',
  });
}

export async function startServerModeStack() {
  debugLog('stack:start');
  const initialState = await createRuntimeState();
  debugLog('stack:runtime-created', initialState.projectName);
  const runtimeState = {
    ...initialState,
    containerRuntime: await resolveContainerRuntime(),
  };
  debugLog('stack:runtime-resolved', runtimeState.containerRuntime);
  const state = await ensurePodmanService(runtimeState);
  debugLog('stack:podman-ready', state.podmanSocketPath ?? 'none');
  process.env.E2E_SERVER_STATE_FILE = state.stateFile;
  await writeRuntimeState(state);
  debugLog('stack:state-written', state.stateFile);

  if (state.containerRuntime === 'podman' && process.env.E2E_SERVER_FORCE_COMPOSE !== '1') {
    debugLog('stack:using-process-mode');
    if (state.podmanServicePid) {
      try {
        process.kill(state.podmanServicePid, 'SIGTERM');
      } catch {}
    }
    return await startServerModeProcessStack({
      ...state,
      mode: 'process',
      podmanServicePid: null,
      podmanSocketPath: null,
    }, new Error('Skipped compose startup for local Podman runtime.'));
  }

  try {
    debugLog('stack:using-compose-mode');
    await runCompose(state, ['up', '-d', '--build', '--remove-orphans'], {
      timeoutMs: bootTimeoutMs,
    });

    for (const service of requiredHealthServices) {
      await waitForServiceHealth(state, service);
    }

    await waitForTextResponse(state.urls.apiHealth, (response) => response.ok, 'API health endpoint');
    await waitForTextResponse(
      state.urls.webHealth,
      (response, body) => response.ok && body.trim() === 'ok',
      'Lite web health endpoint'
    );
    await waitForTextResponse(
      state.urls.webProHealth,
      (response, body) => response.ok && body.trim() === 'ok',
      'Pro web health endpoint'
    );

    const [liteBootstrapStatus, proBootstrapStatus] = await Promise.all([
      waitForJsonResponse(
        state.urls.liteBootstrapStatus,
        isBootstrapStatusReady,
        'Lite bootstrap status'
      ),
      waitForJsonResponse(
        state.urls.proBootstrapStatus,
        isBootstrapStatusReady,
        'Pro bootstrap status'
      ),
    ]);

    const startedState = {
      ...state,
      bootstrapStatus: {
        lite: liteBootstrapStatus,
        pro: proBootstrapStatus,
      },
      startedAt: new Date().toISOString(),
    };

    await writeRuntimeState(startedState);
    return startedState;
  } catch (error) {
    await collectComposeDiagnostics(state).catch(() => {});
    await stopServerModeStack(state).catch(() => {});
    if (process.env.E2E_SERVER_ALLOW_PROCESS_FALLBACK === '0') {
      throw error;
    }
    return await startServerModeProcessStack({
      ...state,
      mode: 'process',
      podmanHome: null,
      podmanServicePid: null,
      podmanSocketPath: null,
    }, error);
  }
}
