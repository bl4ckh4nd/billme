import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { readCliDiscovery, type CliDiscovery } from '@billme/embedded-server-runtime/discovery';

/**
 * Electron's userData directories of the desktop apps: installed builds by app
 * name, `pnpm dev` builds in the temp dir (see `startDesktopMain`).
 */
const userDataCandidates = (env: NodeJS.ProcessEnv): string[] => {
  if (env.BILLME_E2E_USER_DATA_DIR?.trim()) return [env.BILLME_E2E_USER_DATA_DIR];
  const appData = process.platform === 'win32'
    ? env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
    : process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return [
    ...['Billme', 'billme', 'Billme Pro', 'billme-pro'].map((name) => join(appData, name)),
    join(tmpdir(), 'billme-dev'),
    join(tmpdir(), 'billme-pro-v2-dev'),
  ];
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** A discovery file is only trusted once the port answers with the instance id the file names. */
const isSameInstance = async (discovery: CliDiscovery): Promise<boolean> => {
  if (!isAlive(discovery.pid)) return false;
  try {
    const response = await fetch(`${discovery.baseUrl}/health`, { signal: AbortSignal.timeout(1000) });
    const health = await response.json() as { instanceId?: unknown };
    return response.ok && health.instanceId === discovery.instanceId;
  } catch {
    return false;
  }
};

/** Desktop apps that are running right now and reachable on loopback. */
export const findDesktopInstances = async (env: NodeJS.ProcessEnv): Promise<CliDiscovery[]> => {
  const found = await Promise.all(userDataCandidates(env).map(async (directory) => {
    const discovery = await readCliDiscovery(directory);
    return discovery && await isSameInstance(discovery) ? discovery : null;
  }));
  return found.filter((entry): entry is CliDiscovery => entry !== null);
};
