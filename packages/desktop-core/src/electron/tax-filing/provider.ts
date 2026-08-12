import { access, constants, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import type { TaxFilingProviderStatus } from './types';

export type EricProvider = TaxFilingProviderStatus & { available: true; provider: 'eric'; binaryPath: string };

const executable = async (candidate: string): Promise<boolean> => {
  try {
    await access(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const versionFromPath = (value: string): string | undefined => {
  const match = value.match(/(?:^|[\\/])v?(\d+(?:\.\d+){1,3})(?:[\\/]|$)/i);
  return match?.[1];
};

/** Discover only an explicitly supplied or versioned official ERiC resource. */
export const discoverEricProvider = async (options: {
  binaryPath?: string;
  resourcesPath?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<TaxFilingProviderStatus> => {
  const env = options.env ?? process.env;
  const explicit = options.binaryPath ?? env.BILLME_ERIC_BINARY;
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  const root = options.resourcesPath ?? env.BILLME_ERIC_RESOURCES;
  if (root) {
    try {
      for (const version of (await readdir(root, { withFileTypes: true })).filter((entry) => entry.isDirectory() && /^(?:v)?\d/.test(entry.name))) {
        candidates.push(path.join(root, version.name, process.platform === 'win32' ? 'eric.exe' : 'eric'));
        candidates.push(path.join(root, version.name, 'bin', process.platform === 'win32' ? 'eric.exe' : 'eric'));
      }
    } catch {
      return { available: false, provider: null, errorCode: 'PROVIDER_UNAVAILABLE' };
    }
  }
  for (const candidate of candidates) {
    if (await executable(candidate)) return { available: true, provider: 'eric', binaryPath: candidate, version: versionFromPath(candidate) };
  }
  return { available: false, provider: null, errorCode: 'PROVIDER_UNAVAILABLE' };
};

/** Run the native provider in a separate process; no provider emulation is allowed. */
export const runEricProvider = async (provider: EricProvider, request: unknown, timeoutMs = 30_000): Promise<Record<string, unknown>> => {
  const child = spawn(provider.binaryPath, ['--billme-json'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try {
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.stdin.end(JSON.stringify(request));
    const code = await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode) => resolve(exitCode ?? 1));
    });
    if (code !== 0) throw new Error(`ERiC provider failed (${code}): ${Buffer.concat(stderr).toString('utf8').slice(0, 512)}`);
    const value: unknown = JSON.parse(Buffer.concat(stdout).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ERiC provider returned invalid JSON');
    return value as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
};
