import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { ZodError } from 'zod';
import {
  bootstrapRequestSchema,
  CLI_TOKEN_PREFIX,
  loginRequestSchema,
  serverProductSchema,
  type ServerProduct,
} from '@billme/server-core';
import { createLiteHttpBillmeApi } from '@billme/desktop-services/liteHttpApi';
import { createProHttpBillmeApi } from '@billme/desktop-services/proHttpApi';
import {
  argShape,
  camelize,
  COMPOSITE_CREATE_KEYS,
  describeSchema,
  flagsToArgs,
  listCliActions,
  takesNoArgs,
  type CliAction,
} from './actions.js';
import { readBillmeCliConfig, updateBillmeCliProfile } from './config.js';
import { findDesktopInstances } from './desktop.js';
import { deviceLogin, LoginError } from './login.js';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3100';

/**
 * Options the CLI itself consumes. Where an action has an argument of the same name (`recurring upsert --profile`,
 * `portal health --base-url`), the flag belongs to the action and the CLI setting comes from the environment.
 */
export const GLOBAL_FLAGS = ['base-url', 'product', 'token', 'profile', 'input', 'out', 'help', 'reason', 'json'] as const;

export type CliIo = {
  env: NodeJS.ProcessEnv;
  stdin: AsyncIterable<unknown> & { isTTY?: boolean };
  stdout: { write: (chunk: string) => unknown };
  stderr: { write: (chunk: string) => unknown };
};

type ParsedArgs = {
  positionals: string[];
  flags: Record<string, string | boolean>;
};

type ErrorCode = 'usage' | 'auth' | 'unreachable' | 'runtime';

const EXIT_CODES: Record<ErrorCode, number> = { runtime: 1, usage: 2, auth: 3, unreachable: 4 };

class CliError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details: { status?: number; issues?: unknown } = {},
  ) {
    super(message);
  }
}

type Context = {
  baseUrl: string;
  product: ServerProduct;
  token: string | null;
  profileName: string;
};

/** One per run: the audit reason applied to writes and the status of the last failed response. */
type Transport = {
  reason?: string;
  failedStatus?: number;
  fetch: typeof globalThis.fetch;
};

type LooseApi = Record<string, Record<string, (args?: unknown) => Promise<any>>>;

const helpText = `billme <group> <command> [options]

  billme login [--target desktop|self-hosted|cloud] [--base-url <api-url>] [--read-only] [--label <name>] [--no-browser]
  billme logout
  billme status                     desktop apps running on this machine
  billme actions [--json]           every action of the current product
  billme <group> <command> --help   arguments and result of one action
  billme api <METHOD> <path>        any API endpoint that has no action
  billme auth login|bootstrap|me   bootstrap: --setup-token or BILLME_SETUP_TOKEN
  billme meta health|capabilities

Action arguments: --input <path|-> with a JSON object, and/or one flag per
top-level key (--id abc, --client-id abc). Non-scalar flags take JSON or @file.

Global options:
  --base-url <url>   API base URL
  --product <lite|pro>
  --token <token>
  --profile <name>
  --reason <text>    audit reason for writes (default: billme-cli (<profile>))
  --out <path>       write the result to a file
  --help
`;

const parseArgv = (argv: string[]): ParsedArgs => {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }

    if (value === '--') {
      positionals.push(...argv.slice(index + 1));
      break;
    }

    if (value === '--help') {
      flags.help = true;
      continue;
    }

    if (value.startsWith('--no-')) {
      flags[value.slice(5)] = false;
      continue;
    }

    const equalIndex = value.indexOf('=');
    if (equalIndex >= 0) {
      flags[value.slice(2, equalIndex)] = value.slice(equalIndex + 1);
      continue;
    }

    const key = value.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
      continue;
    }
    flags[key] = true;
  }

  return {
    positionals,
    flags,
  };
};

const getStringFlag = (args: ParsedArgs, name: string): string | undefined => {
  const value = args.flags[name];
  return typeof value === 'string' ? value : undefined;
};

const getBooleanFlag = (args: ParsedArgs, name: string, defaultValue = false): boolean => {
  const value = args.flags[name];
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value !== 'false';
  }
  return defaultValue;
};

const requireStringFlag = (args: ParsedArgs, name: string): string => {
  const value = getStringFlag(args, name);
  if (!value) {
    throw new CliError('usage', `Missing required --${name} option.`);
  }
  return value;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readStdin = async (io: CliIo): Promise<string> => {
  const chunks: string[] = [];
  for await (const chunk of io.stdin) {
    if (typeof chunk === 'string') {
      chunks.push(chunk);
      continue;
    }
    if (chunk instanceof Uint8Array) {
      chunks.push(Buffer.from(chunk).toString('utf8'));
      continue;
    }
    chunks.push(String(chunk ?? ''));
  }
  return chunks.join('');
};

/** Stdin is only read on an explicit `--input -`, so a flags-only call never waits on an open pipe. */
const readJsonInput = async (args: ParsedArgs, io: CliIo): Promise<unknown> => {
  const inputPath = getStringFlag(args, 'input');
  if (!inputPath) return undefined;
  const raw = inputPath === '-' ? await readStdin(io) : await readFile(inputPath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new CliError('usage', `--input is not valid JSON: ${(error as Error).message}`);
  }
};

const writeJson = (io: CliIo, payload: unknown) => {
  io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
};

const buildContext = async (
  args: ParsedArgs,
  io: CliIo,
  transport: Transport,
  options?: { requireToken?: boolean },
): Promise<Context> => {
  const config = await readBillmeCliConfig(io.env);
  const profileName = getStringFlag(args, 'profile') ?? io.env.BILLME_PROFILE ?? 'default';
  const profile = config.profiles[profileName];
  const product = serverProductSchema.safeParse(getStringFlag(args, 'product') ?? io.env.BILLME_PRODUCT ?? profile?.product ?? 'lite');
  if (!product.success) {
    throw new CliError('usage', '--product must be lite or pro.');
  }
  let baseUrl = getStringFlag(args, 'base-url') ?? io.env.BILLME_BASE_URL ?? profile?.baseUrl;
  if (!baseUrl && profile?.target === 'desktop') {
    baseUrl = (await findDesktopInstances(io.env)).find((instance) => instance.product === product.data)?.baseUrl;
    if (!baseUrl) {
      throw new CliError('unreachable', `The Billme desktop app (${product.data}) is not running. Start it and try again.`);
    }
  }
  baseUrl ??= DEFAULT_BASE_URL;
  const token = getStringFlag(args, 'token') ?? io.env.BILLME_TOKEN ?? profile?.token ?? null;

  if (options?.requireToken !== false && !token) {
    throw new CliError('auth', 'Missing bearer token. Use --token or authenticate into a saved profile first.');
  }

  transport.reason ??= `billme-cli (${profile?.label ?? profileName})`;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    product: product.data,
    token,
    profileName,
  };
};

const createTransport = (reason: string | undefined): Transport => {
  const transport: Transport = {
    reason,
    fetch: async (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      let nextInit = init;
      if (typeof init?.body === 'string' && method !== 'GET' && method !== 'HEAD') {
        // ponytail: the HTTP adapters hard-code some audit reasons ("Kunde gespeichert"), so the CLI reason is
        // set on the outgoing body. Replace once every contract route takes `reason` as an argument.
        let body: unknown;
        try {
          body = JSON.parse(init.body);
        } catch {
          body = undefined;
        }
        if (isRecord(body) && 'reason' in body) {
          nextInit = { ...init, body: JSON.stringify({ ...body, reason: transport.reason }) };
        }
      }
      let response: Response;
      try {
        response = await globalThis.fetch(input, nextInit);
      } catch (error) {
        const cause = (error as { cause?: { code?: string } }).cause?.code;
        throw new CliError('unreachable', `Cannot reach ${String(input)}${cause ? ` (${cause})` : ''}.`);
      }
      if (!response.ok) transport.failedStatus = response.status;
      return response;
    },
  };
  return transport;
};

const request = (context: Context, transport: Transport, method: string, path: string, body?: unknown) =>
  transport.fetch(`${context.baseUrl}${path}`, {
    method,
    headers: {
      ...(context.token ? { authorization: `Bearer ${context.token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const failureMessage = (status: number, payload: unknown): string =>
  isRecord(payload) && typeof payload.message === 'string' ? payload.message : `Request failed (HTTP ${status}).`;

const requestJson = async (context: Context, transport: Transport, method: string, path: string, body?: unknown) => {
  const response = await request(context, transport, method, path, body);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(failureMessage(response.status, payload));
  return payload;
};

const runAuth = async (command: string | undefined, args: ParsedArgs, io: CliIo, transport: Transport) => {
  if (command === 'me') {
    const context = await buildContext(args, io, transport);
    writeJson(io, await requestJson(context, transport, 'GET', `/api/v1/auth/me?product=${context.product}`));
    return;
  }
  if (command !== 'login' && command !== 'bootstrap') {
    throw new CliError('usage', 'Unknown auth command. Use login, bootstrap or me.');
  }

  const context = await buildContext(args, io, transport, { requireToken: false });
  const credentials = { email: requireStringFlag(args, 'email'), password: requireStringFlag(args, 'password') };
  const body = command === 'login'
    ? loginRequestSchema.parse(credentials)
    : bootstrapRequestSchema.parse({
      ...credentials,
      fullName: requireStringFlag(args, 'full-name'),
      setupToken: getStringFlag(args, 'setup-token') ?? io.env.BILLME_SETUP_TOKEN,
    });
  const auth = await requestJson(context, transport, 'POST', `/api/v1/auth/${command}?product=${context.product}`, body) as { token: string };

  if (!getBooleanFlag(args, 'save', true)) {
    writeJson(io, auth);
    return;
  }
  const saved = await updateBillmeCliProfile(io.env, context.profileName, (profile) => ({
    ...profile,
    baseUrl: context.baseUrl,
    product: context.product,
    token: auth.token,
  }));
  writeJson(io, { ...auth, savedProfile: context.profileName, configPath: saved.path });
};

const runLogin = async (args: ParsedArgs, io: CliIo) => {
  const profileName = getStringFlag(args, 'profile') ?? io.env.BILLME_PROFILE ?? 'default';
  let login: Awaited<ReturnType<typeof deviceLogin>>;
  try {
    login = await deviceLogin({
      env: io.env,
      stdin: io.stdin,
      stderr: io.stderr,
      interactive: Boolean(io.stdin.isTTY),
      target: getStringFlag(args, 'target'),
      baseUrl: getStringFlag(args, 'base-url') ?? io.env.BILLME_BASE_URL,
      product: getStringFlag(args, 'product') ?? io.env.BILLME_PRODUCT,
      label: getStringFlag(args, 'label'),
      readOnly: getBooleanFlag(args, 'read-only'),
      openBrowser: getBooleanFlag(args, 'browser', true),
    });
  } catch (error) {
    if (error instanceof LoginError) throw new CliError(error.code, error.message);
    throw error;
  }
  const saved = await updateBillmeCliProfile(io.env, profileName, () => ({
    target: login.target,
    ...(login.target === 'server' ? { baseUrl: login.baseUrl } : {}),
    product: login.product,
    token: login.token,
    label: login.label,
  }));
  writeJson(io, {
    ok: true,
    profile: profileName,
    target: login.target,
    product: login.product,
    label: login.label,
    scope: login.scope,
    user: login.user,
    configPath: saved.path,
  });
};

const runLogout = async (args: ParsedArgs, io: CliIo, transport: Transport) => {
  const context = await buildContext(args, io, transport);
  // Revoke on the server first, so a token that is dropped here can never be used from a copy.
  if (context.token?.startsWith(CLI_TOKEN_PREFIX)) {
    await requestJson(context, transport, 'POST', `/api/v1/${context.product}/cli-access/revoke-self`);
  }
  await updateBillmeCliProfile(io.env, context.profileName, ({ token: _token, ...profile } = {}) => profile);
  writeJson(io, { ok: true, profile: context.profileName });
};

const runApi = async (args: ParsedArgs, io: CliIo, transport: Transport) => {
  const [, method, path] = args.positionals;
  if (!method || !path?.startsWith('/')) {
    throw new CliError('usage', 'Usage: billme api <METHOD> </api/v1/...> [--input <path|->] [--out <path>]');
  }
  const context = await buildContext(args, io, transport);
  const response = await request(context, transport, method.toUpperCase(), path, await readJsonInput(args, io));
  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  if (!response.ok) {
    throw new Error(failureMessage(response.status, isJson ? await response.json().catch(() => null) : null));
  }

  const outPath = getStringFlag(args, 'out');
  if (outPath) {
    await writeFile(outPath, Buffer.from(await response.arrayBuffer()));
    writeJson(io, { ok: true, path: outPath });
  } else if (isJson) {
    writeJson(io, await response.json());
  } else {
    io.stdout.write(await response.text());
  }
};

const createDocument = async (api: LooseApi, action: CliAction, input: { clientId: string; reason: string; document?: object }) => {
  const kind = action.group === 'invoices' ? 'invoice' : 'offer';
  const draft = await api.documents!.createFromClient!({ kind, clientId: input.clientId });
  const { numberReservationId, ...document } = { ...draft, ...input.document };
  let saved: { id: string };
  try {
    saved = await api[action.group]!.upsert!({ reason: input.reason, [kind]: document });
  } catch (error) {
    if (numberReservationId) {
      await api.numbers!.release!({ reservationId: numberReservationId }).catch(() => undefined);
    }
    throw error;
  }
  if (numberReservationId) {
    await api.numbers!.finalize!({ reservationId: numberReservationId, documentId: saved.id });
  }
  return saved;
};

const runAction = async (action: CliAction, args: ParsedArgs, io: CliIo, transport: Transport) => {
  if (args.flags.help) {
    writeJson(io, {
      command: `${action.group} ${action.method}`,
      args: describeSchema(action.args),
      result: describeSchema(action.result),
    });
    return;
  }

  const shape = argShape(action.args);
  const isActionFlag = (name: string) =>
    !(GLOBAL_FLAGS as readonly string[]).includes(name) || (name !== 'reason' && camelize(name) in (shape ?? {}));
  const flags = Object.entries(args.flags);
  const context = await buildContext(
    { ...args, flags: Object.fromEntries(flags.filter(([name]) => !isActionFlag(name))) },
    io,
    transport,
  );
  let input: unknown;
  if (!takesNoArgs(action.args)) {
    const fromJson = await readJsonInput(args, io);
    const actionFlags = Object.fromEntries(flags.filter(([name]) => isActionFlag(name)));
    let fromFlags: Record<string, unknown>;
    try {
      fromFlags = await flagsToArgs(action, actionFlags);
    } catch (error) {
      throw new CliError('usage', (error as Error).message);
    }
    const merged: Record<string, unknown> = { ...(isRecord(fromJson) ? fromJson : {}), ...fromFlags };
    if (typeof merged.reason === 'string' && !getStringFlag(args, 'reason')) {
      transport.reason = merged.reason;
    }
    if (shape?.reason) {
      merged.reason = transport.reason;
    }
    const parsed = action.args.safeParse(merged);
    if (!parsed.success) {
      throw new CliError('usage', `Invalid arguments for ${action.group} ${action.method}.`, { issues: parsed.error.issues });
    }
    input = parsed.data;
  }

  const outPath = getStringFlag(args, 'out');
  const downloads: Promise<void>[] = [];
  // In the app `pdf:export` is done by the Electron shell; here the API renders the file and the CLI saves it.
  const fallback = async (key: string, routeArgs: unknown): Promise<any> => {
    let pdfPath: string;
    if (key === 'pdf:export') {
      const { kind, id, level } = routeArgs as { kind: string; id: string; level?: number };
      pdfPath = `/documents/${kind}/${encodeURIComponent(id)}/pdf${level ? `?level=${level}` : ''}`;
    } else if (key === 'eur:exportPdf') {
      const query = Object.entries(routeArgs as Record<string, string | number | undefined>).filter(([, value]) => value !== undefined);
      pdfPath = `/reports/eur/pdf?${new URLSearchParams(query.map(([name, value]) => [name, String(value)]))}`;
    } else {
      throw new CliError('usage', `${key} is only available inside the app.`);
    }
    const response = await request(context, transport, 'GET', `/api/v1/${context.product}${pdfPath}`);
    if (!response.ok) throw new Error(failureMessage(response.status, await response.json().catch(() => null)));
    const named = /filename\*=UTF-8''([^;]+)/.exec(response.headers.get('content-disposition') ?? '')?.[1];
    const path = outPath ?? basename(decodeURIComponent(named ?? 'export.pdf'));
    const saved = writeFile(path, Buffer.from(await response.arrayBuffer()));
    downloads.push(saved);
    await saved;
    return { path };
  };
  const api = (context.product === 'pro'
    ? createProHttpBillmeApi({
      baseUrl: context.baseUrl,
      getToken: () => context.token,
      fetch: transport.fetch,
      fallback,
      downloadBlob: (blob, fileName) => {
        downloads.push(blob.arrayBuffer().then((bytes) => writeFile(outPath ?? fileName, Buffer.from(bytes))));
      },
    })
    : createLiteHttpBillmeApi({
      baseUrl: context.baseUrl,
      auth: { mode: 'bearer', token: context.token! },
      fetch: transport.fetch,
      fallback,
    })) as unknown as LooseApi;

  const result = (COMPOSITE_CREATE_KEYS as readonly string[]).includes(action.key)
    ? await createDocument(api, action, input as Parameters<typeof createDocument>[2])
    : await api[action.group]![action.method]!(input);
  await Promise.all(downloads);

  if (outPath && downloads.length === 0) {
    await writeFile(outPath, typeof result === 'string' ? result : `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    writeJson(io, { ok: true, path: outPath });
    return;
  }
  writeJson(io, result ?? null);
};

const run = async (args: ParsedArgs, io: CliIo, transport: Transport) => {
  const [group, command] = args.positionals;
  if (!group) {
    io.stdout.write(helpText);
    return;
  }

  if (group === 'status') {
    writeJson(io, { desktop: await findDesktopInstances(io.env) });
    return;
  }
  if (group === 'login') return runLogin(args, io);
  if (group === 'logout') return runLogout(args, io, transport);
  if (group === 'auth') return runAuth(command, args, io, transport);
  if (group === 'api') return runApi(args, io, transport);
  if (group === 'meta' && (command === 'health' || command === 'capabilities')) {
    const context = await buildContext(args, io, transport, { requireToken: false });
    writeJson(io, await requestJson(context, transport, 'GET', command === 'health' ? '/health' : '/api/v1/meta/capabilities'));
    return;
  }

  const context = await buildContext(args, io, transport, { requireToken: false });
  const actions = listCliActions(context.product);
  if (group === 'actions') {
    if (args.flags.json) {
      writeJson(io, actions.map((action) => ({
        command: `${action.group} ${action.method}`,
        args: describeSchema(action.args),
      })));
    } else {
      io.stdout.write(`${actions.map((action) => `${action.group} ${action.method}`).join('\n')}\n`);
    }
    return;
  }

  const action = actions.find((candidate) => candidate.group === group && candidate.method === command);
  if (!action) {
    if (args.flags.help && !command) {
      const methods = actions.filter((candidate) => candidate.group === group).map((candidate) => candidate.method);
      if (methods.length > 0) {
        io.stdout.write(`billme ${group} <${methods.join('|')}>\n`);
        return;
      }
    }
    throw new CliError('usage', `Unknown command "${[group, command].filter(Boolean).join(' ')}" for ${context.product}. Run "billme actions" to list them.`);
  }
  return runAction(action, args, io, transport);
};

export const runCli = async (argv: string[], io: CliIo): Promise<number> => {
  const args = parseArgv(argv);
  const transport = createTransport(getStringFlag(args, 'reason'));
  try {
    await run(args, io, transport);
    return 0;
  } catch (error) {
    const status = transport.failedStatus;
    const failure = error instanceof CliError
      ? error
      : error instanceof ZodError
        ? new CliError('runtime', 'Data did not match the expected shape; see issues.', { status, issues: error.issues })
        : new CliError(status === 401 || status === 403 ? 'auth' : 'runtime', (error as Error).message, { status });
    io.stderr.write(`${JSON.stringify({ error: { code: failure.code, message: failure.message, ...failure.details } }, null, 2)}\n`);
    return EXIT_CODES[failure.code];
  }
};
