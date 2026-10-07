import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Where a running desktop app tells the `billme` CLI how to reach it. The file
 * carries no secret: the CLI still has to be approved in the app to get a token.
 */
export const CLI_DISCOVERY_FILE = 'cli-discovery.json';

export interface CliDiscovery {
  readonly product: 'lite' | 'pro';
  readonly baseUrl: string;
  readonly pid: number;
  /** Echoed by `/health`, so a client can tell this app from whatever reuses its port later. */
  readonly instanceId: string;
  readonly startedAt: string;
}

export const writeCliDiscovery = async (userDataPath: string, discovery: CliDiscovery): Promise<void> => {
  const target = join(userDataPath, CLI_DISCOVERY_FILE);
  const temporary = `${target}.${discovery.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(discovery, null, 2)}\n`, 'utf8');
  await rename(temporary, target);
};

export const readCliDiscovery = async (userDataPath: string): Promise<CliDiscovery | null> => {
  try {
    const parsed = JSON.parse(await readFile(join(userDataPath, CLI_DISCOVERY_FILE), 'utf8')) as Partial<CliDiscovery>;
    if (
      (parsed.product === 'lite' || parsed.product === 'pro')
      && typeof parsed.baseUrl === 'string'
      && typeof parsed.pid === 'number'
      && typeof parsed.instanceId === 'string'
      && typeof parsed.startedAt === 'string'
    ) {
      return parsed as CliDiscovery;
    }
    return null;
  } catch {
    return null;
  }
};

/** Removes the file only while it still describes this instance; a newer start owns it otherwise. */
export const removeCliDiscovery = async (userDataPath: string, instanceId: string): Promise<void> => {
  if ((await readCliDiscovery(userDataPath))?.instanceId === instanceId) {
    await rm(join(userDataPath, CLI_DISCOVERY_FILE), { force: true });
  }
};
