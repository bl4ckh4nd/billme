import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { serverProductSchema } from '@billme/server-core';

const cliProfileSchema = z.object({
  baseUrl: z.string().url().optional(),
  endpoint: z.string().min(1).optional(),
  product: serverProductSchema.optional(),
  token: z.string().min(1).optional(),
});

const cliConfigSchema = z.object({
  profiles: z.record(z.string().min(1), cliProfileSchema).default({}),
});

export type BillmeCliProfile = z.infer<typeof cliProfileSchema>;
export type BillmeCliConfig = z.infer<typeof cliConfigSchema>;

const defaultConfigPath = (env: NodeJS.ProcessEnv) => {
  if (env.BILLME_CLI_CONFIG?.trim()) {
    return env.BILLME_CLI_CONFIG;
  }
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config');
  return join(configHome, 'billme', 'server-cli.json');
};

export const readBillmeCliConfig = async (env: NodeJS.ProcessEnv): Promise<BillmeCliConfig> => {
  const path = defaultConfigPath(env);
  try {
    const raw = await readFile(path, 'utf8');
    return cliConfigSchema.parse(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return cliConfigSchema.parse({});
    }
    throw error;
  }
};

export const writeBillmeCliConfig = async (env: NodeJS.ProcessEnv, config: BillmeCliConfig) => {
  const path = defaultConfigPath(env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(cliConfigSchema.parse(config), null, 2)}\n`, 'utf8');
  return path;
};

export const updateBillmeCliProfile = async (
  env: NodeJS.ProcessEnv,
  profileName: string,
  updater: (profile: BillmeCliProfile | undefined) => BillmeCliProfile,
) => {
  const config = await readBillmeCliConfig(env);
  const nextProfile = cliProfileSchema.parse(updater(config.profiles[profileName]));
  const nextConfig = cliConfigSchema.parse({
    profiles: {
      ...config.profiles,
      [profileName]: nextProfile,
    },
  });
  const path = await writeBillmeCliConfig(env, nextConfig);
  return {
    config: nextConfig,
    path,
    profile: nextProfile,
  };
};
