import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline/promises';
import {
  deviceLoginStartResponseSchema,
  deviceLoginTokenResponseSchema,
  serverProductSchema,
  type AuthUser,
  type CliTokenScope,
  type ServerProduct,
} from '@billme/server-core';
import { findDesktopInstances } from './desktop.js';

/**
 * API URL of the hosted Billme offering. There is none yet; while this is
 * empty the login menu does not offer "Billme Cloud".
 */
export const BILLME_CLOUD_API_URL = '';

export type LoginTarget = 'desktop' | 'self-hosted' | 'cloud';

export type LoginOptions = {
  env: NodeJS.ProcessEnv;
  stdin: unknown;
  stderr: { write: (chunk: string) => unknown };
  interactive: boolean;
  target?: string;
  baseUrl?: string;
  product?: string;
  label?: string;
  readOnly: boolean;
  openBrowser: boolean;
};

export type LoginResult = {
  target: 'desktop' | 'server';
  baseUrl: string;
  product: ServerProduct;
  token: string;
  label: string;
  scope: CliTokenScope;
  user: AuthUser;
};

export class LoginError extends Error {
  constructor(readonly code: 'usage' | 'unreachable' | 'auth', message: string) {
    super(message);
  }
}

/** A bare host gets a scheme: http on this machine and in private networks, https everywhere else. */
const normalizeUrl = (value: string): string => {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const isLocal = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\])/i.test(trimmed);
  return `${isLocal ? 'http' : 'https'}://${trimmed}`;
};

const openInBrowser = (url: string) => {
  const [command, args] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '', url]] as const
    : process.platform === 'darwin'
      ? ['open', [url]] as const
      : ['xdg-open', [url]] as const;
  spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
};

const postJson = async (baseUrl: string, path: string, body: unknown): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new LoginError('unreachable', `Cannot reach ${baseUrl}.`);
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'message' in payload ? String(payload.message) : `HTTP ${response.status}`;
    throw new LoginError(response.status === 404 ? 'unreachable' : 'auth', `${baseUrl}${path}: ${message}`);
  }
  return payload;
};

const probe = async (baseUrl: string) => {
  const healthy = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) }).then((response) => response.ok, () => false);
  if (!healthy) {
    throw new LoginError('unreachable', `No Billme API answers at ${baseUrl}. Enter the API URL of the instance, not the web app.`);
  }
};

/** Where to log in: decided by flags, or by a short menu when a person is at the terminal. */
const chooseTarget = async (options: LoginOptions): Promise<{ target: 'desktop' | 'server'; baseUrl: string; product: ServerProduct }> => {
  const ask = async (question: string): Promise<string> => {
    const prompt = createInterface({ input: options.stdin as NodeJS.ReadableStream, output: options.stderr as NodeJS.WritableStream });
    try {
      return (await prompt.question(question)).trim();
    } finally {
      prompt.close();
    }
  };

  let target = options.target ?? (options.baseUrl ? 'self-hosted' : undefined);
  if (!target) {
    if (!options.interactive) {
      throw new LoginError('usage', 'Pass --target desktop, --target cloud or --base-url <api-url>.');
    }
    const choices: Array<[LoginTarget, string]> = [
      ['desktop', 'Billme desktop app on this computer'],
      ['self-hosted', 'Self-hosted instance (enter its URL)'],
      ...(BILLME_CLOUD_API_URL ? [['cloud', 'Billme Cloud'] as [LoginTarget, string]] : []),
    ];
    options.stderr.write(`Where do you want to log in?\n${choices.map(([, text], index) => `  ${index + 1}) ${text}`).join('\n')}\n`);
    target = choices[Number(await ask('> ')) - 1]?.[0];
  }

  const requestedProduct = options.product ? serverProductSchema.safeParse(options.product) : undefined;
  if (requestedProduct && !requestedProduct.success) {
    throw new LoginError('usage', '--product must be lite or pro.');
  }

  if (target === 'desktop') {
    const instances = (await findDesktopInstances(options.env))
      .filter((instance) => !requestedProduct || instance.product === requestedProduct.data);
    if (instances.length === 0) {
      throw new LoginError('unreachable', 'No running Billme desktop app found. Start the app and try again.');
    }
    if (instances.length > 1) {
      throw new LoginError('usage', 'Billme Lite and Pro are both running. Pass --product lite or --product pro.');
    }
    return { target: 'desktop', baseUrl: instances[0]!.baseUrl, product: instances[0]!.product };
  }

  if (target !== 'self-hosted' && target !== 'cloud') {
    throw new LoginError('usage', 'Unknown login target. Use desktop, self-hosted or cloud.');
  }
  if (target === 'cloud' && !BILLME_CLOUD_API_URL) {
    throw new LoginError('usage', 'Billme Cloud is not available yet. Use --target desktop or --base-url <api-url>.');
  }
  const rawUrl = target === 'cloud'
    ? BILLME_CLOUD_API_URL
    : options.baseUrl ?? (options.interactive ? await ask('API URL of your instance: ') : '');
  if (!rawUrl) {
    throw new LoginError('usage', 'Pass the API URL of your instance with --base-url.');
  }
  const baseUrl = normalizeUrl(rawUrl);
  await probe(baseUrl);

  let product = requestedProduct?.data;
  if (!product && options.interactive) {
    product = (await ask('Product: 1) Lite  2) Pro\n> ')) === '2' ? 'pro' : 'lite';
  }
  return { target: 'server', baseUrl, product: product ?? 'lite' };
};

/**
 * Device login: the CLI shows a code, a person confirms it in the app, and the
 * CLI receives a token of its own. The password never passes through the CLI.
 */
export const deviceLogin = async (options: LoginOptions): Promise<LoginResult> => {
  const { target, baseUrl, product } = await chooseTarget(options);
  const label = options.label?.trim() || hostname();
  const scope: CliTokenScope = options.readOnly ? 'read' : 'full';

  const started = deviceLoginStartResponseSchema.parse(
    await postJson(baseUrl, '/api/v1/auth/device/start', { product, label, scope }),
  );

  options.stderr.write(`\nCode: ${started.userCode}\n`);
  if (started.verificationUri) {
    options.stderr.write(`Confirm it here: ${started.verificationUri}\n`);
    if (options.openBrowser) openInBrowser(started.verificationUri);
  } else {
    options.stderr.write(`Open Billme${product === 'pro' ? ' Pro' : ''} → Einstellungen → System → CLI-Zugriff and enter the code.\n`);
  }
  options.stderr.write(`Waiting for confirmation as "${label}" (${scope === 'read' ? 'read-only' : 'full access'}) …\n`);

  const deadline = Date.now() + started.expiresIn * 1000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, started.interval * 1000));
    const answer = deviceLoginTokenResponseSchema.parse(
      await postJson(baseUrl, '/api/v1/auth/device/token', { deviceCode: started.deviceCode }),
    );
    if (answer.status === 'approved') {
      return { target, baseUrl, product, token: answer.token, label, scope, user: answer.user };
    }
    if (answer.status === 'denied') throw new LoginError('auth', 'The login was declined in the app.');
    if (answer.status === 'expired') break;
  }
  throw new LoginError('auth', 'The code expired before it was confirmed. Run "billme login" again.');
};
