import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { z } from 'zod';
import {
  agentScopeSchema,
  bootstrapRequestSchema,
  loginRequestSchema,
  serverProductSchema,
  type ServerProduct,
} from '@billme/server-core';
import {
  appSettingsSchema,
  clientSchema as desktopClientSchema,
  invoiceSchema as desktopInvoiceSchema,
  recurringProfileSchema as desktopRecurringSchema,
} from '@billme/desktop-contracts/schemas';
import {
  accountSchema,
  articleSchema,
  templateKindSchema,
  templateSchema,
} from '@billme/desktop-contracts-pro/schemas';
import {
  createBillmeServerClient,
  clientWriteSchema,
  invoiceCreateInputSchema,
  invoiceWriteSchema,
  offerCreateInputSchema,
  offerWriteSchema,
  recurringWriteSchema,
  type BillmeServerClientError,
} from './client.js';
import { createAgentClient } from './agent.js';
import { readBillmeCliConfig, updateBillmeCliProfile } from './config.js';
import { agentTargetSchema } from '@billme/agent-control';

const DEFAULT_BASE_URL = 'http://127.0.0.1:3100';

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

class UsageError extends Error {}

const helpText = `billme <group> <command> [options]

Groups:
  auth        login, bootstrap, me
              agent-token create, list, revoke
  meta        health, capabilities
  clients     list, get, upsert, delete
  invoices    list, get, create, upsert, delete
  offers      list, get, create, upsert, delete
  recurring   list, get, upsert, delete
  settings    get, set
  numbers     reserve, release, finalize
  documents   export-json, export-csv
  pro         articles, accounts, templates
  actions     list available business actions
  action      run <route-key>

Global options:
  --base-url <url>   API base URL
  --product <lite|pro>
  --token <token>
  --profile <name>
  --target <server|desktop>
  --endpoint <path>   local desktop endpoint file
  --reason <text>     mutation audit reason
  --confirm           confirm destructive actions
  --input <path|->
  --out <path>
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
    throw new UsageError(`Missing required --${name} option.`);
  }
  return value;
};

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

const readJsonInput = async <T>(
  args: ParsedArgs,
  io: CliIo,
  schema: z.ZodType<T>,
): Promise<T> => {
  const inputPath = getStringFlag(args, 'input');
  let raw: string;

  if (inputPath === '-') {
    raw = await readStdin(io);
  } else if (inputPath) {
    raw = await readFile(inputPath, 'utf8');
  } else if (!io.stdin.isTTY) {
    raw = await readStdin(io);
  } else {
    throw new UsageError('Provide JSON input via --input <path|- > or stdin.');
  }

  return schema.parse(JSON.parse(raw));
};

const writeJson = (io: CliIo, payload: unknown) => {
  io.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
};

const writeText = async (path: string, content: string) => {
  await writeFile(path, content, 'utf8');
};

const buildSharedContext = async (
  args: ParsedArgs,
  io: CliIo,
  options?: {
    forceProduct?: ServerProduct;
    requireToken?: boolean;
  },
) => {
  const config = await readBillmeCliConfig(io.env);
  const profileName = getStringFlag(args, 'profile') ?? io.env.BILLME_PROFILE ?? 'default';
  const profile = config.profiles[profileName];
  const baseUrl = getStringFlag(args, 'base-url') ?? io.env.BILLME_BASE_URL ?? profile?.baseUrl ?? DEFAULT_BASE_URL;
  const product = options?.forceProduct
    ?? serverProductSchema.parse(getStringFlag(args, 'product') ?? io.env.BILLME_PRODUCT ?? profile?.product ?? 'lite');
  const token = getStringFlag(args, 'token') ?? io.env.BILLME_TOKEN ?? profile?.token ?? null;
  const endpoint = getStringFlag(args, 'endpoint') ?? io.env.BILLME_DESKTOP_ENDPOINT ?? profile?.endpoint;

  if (options?.requireToken !== false && !token) {
    throw new UsageError('Missing bearer token. Use --token or authenticate into a saved profile first.');
  }

  return {
    baseUrl,
    product,
    token,
    endpoint,
    profileName,
  };
};

const withGeneratedId = <T extends { id?: string }>(value: T): T & { id: string } => ({
  ...value,
  id: value.id?.trim() ? value.id : randomUUID(),
});

const withDefaults = async (args: ParsedArgs, io: CliIo) => {
  const [group, command] = args.positionals;
  if (!group || args.flags.help) {
    io.stdout.write(helpText);
    return 0;
  }

  if (group === 'auth' && command === 'login') {
    const context = await buildSharedContext(args, io, { requireToken: false });
    const client = createBillmeServerClient({
      baseUrl: context.baseUrl,
      product: context.product,
    });
    const auth = await client.login(
      loginRequestSchema.parse({
        email: requireStringFlag(args, 'email'),
        password: requireStringFlag(args, 'password'),
      }),
      context.product,
    );
    if (getBooleanFlag(args, 'save', true)) {
      const saved = await updateBillmeCliProfile(io.env, context.profileName, (profile) => ({
        ...profile,
        baseUrl: context.baseUrl,
        product: context.product,
        token: auth.token,
      }));
      writeJson(io, {
        ...auth,
        savedProfile: context.profileName,
        configPath: saved.path,
      });
      return 0;
    }
    writeJson(io, auth);
    return 0;
  }

  if (group === 'auth' && command === 'bootstrap') {
    const context = await buildSharedContext(args, io, { requireToken: false });
    const client = createBillmeServerClient({
      baseUrl: context.baseUrl,
      product: context.product,
    });
    const auth = await client.bootstrap(
      bootstrapRequestSchema.parse({
        email: requireStringFlag(args, 'email'),
        password: requireStringFlag(args, 'password'),
        fullName: requireStringFlag(args, 'full-name'),
      }),
      context.product,
    );
    if (getBooleanFlag(args, 'save', true)) {
      const saved = await updateBillmeCliProfile(io.env, context.profileName, (profile) => ({
        ...profile,
        baseUrl: context.baseUrl,
        product: context.product,
        token: auth.token,
      }));
      writeJson(io, {
        ...auth,
        savedProfile: context.profileName,
        configPath: saved.path,
      });
      return 0;
    }
    writeJson(io, auth);
    return 0;
  }

  if (group === 'auth' && command === 'me') {
    const context = await buildSharedContext(args, io);
    const client = createBillmeServerClient(context);
    writeJson(io, await client.getSessionInfo());
    return 0;
  }

  if (group === 'auth' && command === 'agent-token') {
    const action = args.positionals[2];
    const context = await buildSharedContext(args, io);
    const client = createBillmeServerClient(context);
    if (action === 'list') {
      writeJson(io, await client.listAgentTokens());
      return 0;
    }
    if (action === 'create') {
      const scopes = requireStringFlag(args, 'scopes')
        .split(',')
        .map((scope) => agentScopeSchema.parse(scope.trim()));
      writeJson(io, await client.createAgentToken({
        label: requireStringFlag(args, 'label'),
        scopes,
      }));
      return 0;
    }
    if (action === 'revoke') {
      if (!getBooleanFlag(args, 'confirm')) {
        throw new UsageError('Revoking an agent token requires --confirm.');
      }
      writeJson(io, await client.revokeAgentToken({ id: requireStringFlag(args, 'id') }));
      return 0;
    }
    throw new UsageError('Use auth agent-token create, list, or revoke.');
  }

  if (group === 'meta' && command === 'health') {
    const context = await buildSharedContext(args, io, { requireToken: false });
    const client = createBillmeServerClient(context);
    writeJson(io, await client.getHealth());
    return 0;
  }

  if (group === 'meta' && command === 'capabilities') {
    const context = await buildSharedContext(args, io, { requireToken: false });
    const client = createBillmeServerClient(context);
    writeJson(io, await client.getCapabilities());
    return 0;
  }

  if (group === 'actions' && command === 'list') {
    const target = agentTargetSchema.parse(getStringFlag(args, 'target') ?? 'server');
    const context = await buildSharedContext(args, io, { requireToken: false });
    const client = createAgentClient({
      product: context.product,
      target,
      server: target === 'server' ? { baseUrl: context.baseUrl, token: context.token } : undefined,
    });
    writeJson(io, client.listActions());
    return 0;
  }

  if (group === 'action' && command === 'run') {
    const action = args.positionals[2];
    if (!action) {
      throw new UsageError('Missing action route key. Use: billme action run <route-key>.');
    }
    const target = agentTargetSchema.parse(getStringFlag(args, 'target') ?? 'server');
    const context = await buildSharedContext(args, io, { requireToken: target === 'server' });
    const inputPath = getStringFlag(args, 'input');
    const actionArgs = inputPath || !io.stdin.isTTY
      ? await readJsonInput(args, io, z.unknown())
      : undefined;
    const client = createAgentClient({
      product: context.product,
      target,
      server: target === 'server' ? { baseUrl: context.baseUrl, token: context.token } : undefined,
    });
    writeJson(io, await client.invoke({
      action,
      args: actionArgs,
      target,
      endpointPath: context.endpoint,
      reason: getStringFlag(args, 'reason'),
      confirm: getBooleanFlag(args, 'confirm'),
    }));
    return 0;
  }

  if (group === 'clients') {
    const context = await buildSharedContext(args, io);
    const client = createBillmeServerClient(context);
    if (command === 'list') {
      writeJson(io, await client.listClients());
      return 0;
    }
    if (command === 'get') {
      writeJson(io, await client.getClient(requireStringFlag(args, 'id')));
      return 0;
    }
    if (command === 'upsert') {
      const payload = withGeneratedId(await readJsonInput(args, io, clientWriteSchema.partial()));
      writeJson(
        io,
        await client.upsertClient({
          reason: requireStringFlag(args, 'reason'),
          client: clientWriteSchema.parse(payload),
        }),
      );
      return 0;
    }
    if (command === 'delete') {
      writeJson(
        io,
        await client.deleteClient({
          id: requireStringFlag(args, 'id'),
          reason: requireStringFlag(args, 'reason'),
        }),
      );
      return 0;
    }
  }

  if (group === 'invoices') {
    const context = await buildSharedContext(args, io);
    const client = createBillmeServerClient(context);
    if (command === 'list') {
      writeJson(io, await client.listInvoices());
      return 0;
    }
    if (command === 'get') {
      writeJson(io, await client.getInvoice(requireStringFlag(args, 'id')));
      return 0;
    }
    if (command === 'create') {
      const payload = await readJsonInput(args, io, invoiceCreateInputSchema.partial({ id: true, number: true }));
      writeJson(
        io,
        await client.createInvoice({
          reason: requireStringFlag(args, 'reason'),
          invoice: payload,
        }),
      );
      return 0;
    }
    if (command === 'upsert') {
      const payload = withGeneratedId(await readJsonInput(args, io, invoiceWriteSchema.partial()));
      writeJson(
        io,
        await client.upsertInvoice({
          reason: requireStringFlag(args, 'reason'),
          invoice: invoiceWriteSchema.parse(payload),
        }),
      );
      return 0;
    }
    if (command === 'delete') {
      writeJson(
        io,
        await client.deleteInvoice({
          id: requireStringFlag(args, 'id'),
          reason: requireStringFlag(args, 'reason'),
        }),
      );
      return 0;
    }
  }

  if (group === 'offers') {
    const context = await buildSharedContext(args, io);
    const client = createBillmeServerClient(context);
    if (command === 'list') {
      writeJson(io, await client.listOffers());
      return 0;
    }
    if (command === 'get') {
      writeJson(io, await client.getOffer(requireStringFlag(args, 'id')));
      return 0;
    }
    if (command === 'create') {
      const payload = await readJsonInput(args, io, offerCreateInputSchema.partial({ id: true, number: true }));
      writeJson(
        io,
        await client.createOffer({
          reason: requireStringFlag(args, 'reason'),
          offer: payload,
        }),
      );
      return 0;
    }
    if (command === 'upsert') {
      const payload = withGeneratedId(await readJsonInput(args, io, offerWriteSchema.partial()));
      writeJson(
        io,
        await client.upsertOffer({
          reason: requireStringFlag(args, 'reason'),
          offer: offerWriteSchema.parse(payload),
        }),
      );
      return 0;
    }
    if (command === 'delete') {
      writeJson(
        io,
        await client.deleteOffer({
          id: requireStringFlag(args, 'id'),
          reason: requireStringFlag(args, 'reason'),
        }),
      );
      return 0;
    }
  }

  if (group === 'recurring') {
    const context = await buildSharedContext(args, io);
    const client = createBillmeServerClient(context);
    if (command === 'list') {
      writeJson(io, await client.listRecurringProfiles());
      return 0;
    }
    if (command === 'get') {
      writeJson(io, await client.getRecurringProfile(requireStringFlag(args, 'id')));
      return 0;
    }
    if (command === 'upsert') {
      const payload = withGeneratedId(await readJsonInput(args, io, recurringWriteSchema.partial()));
      writeJson(
        io,
        await client.upsertRecurringProfile({
          reason: requireStringFlag(args, 'reason'),
          profile: recurringWriteSchema.parse(payload),
        }),
      );
      return 0;
    }
    if (command === 'delete') {
      writeJson(
        io,
        await client.deleteRecurringProfile({
          id: requireStringFlag(args, 'id'),
          reason: requireStringFlag(args, 'reason'),
        }),
      );
      return 0;
    }
  }

  if (group === 'settings') {
    const context = await buildSharedContext(args, io);
    const client = createBillmeServerClient(context);
    if (command === 'get') {
      writeJson(io, await client.getSettings());
      return 0;
    }
    if (command === 'set') {
      const payload = await readJsonInput(args, io, appSettingsSchema);
      writeJson(io, await client.setSettings({ settings: payload }));
      return 0;
    }
  }

  if (group === 'numbers') {
    const context = await buildSharedContext(args, io);
    const client = createBillmeServerClient(context);
    if (command === 'reserve') {
      writeJson(io, await client.reserveNumber({ kind: z.enum(['invoice', 'offer', 'customer']).parse(requireStringFlag(args, 'kind')) }));
      return 0;
    }
    if (command === 'release') {
      writeJson(io, await client.releaseNumber({ reservationId: requireStringFlag(args, 'reservation-id') }));
      return 0;
    }
    if (command === 'finalize') {
      writeJson(
        io,
        await client.finalizeNumber({
          reservationId: requireStringFlag(args, 'reservation-id'),
          documentId: requireStringFlag(args, 'document-id'),
        }),
      );
      return 0;
    }
  }

  if (group === 'documents') {
    const context = await buildSharedContext(args, io);
    const client = createBillmeServerClient(context);
    if (command === 'export-json') {
      writeJson(
        io,
        await client.exportDocumentJson({
          kind: z.enum(['invoice', 'offer']).parse(requireStringFlag(args, 'kind')),
          id: requireStringFlag(args, 'id'),
        }),
      );
      return 0;
    }
    if (command === 'export-csv') {
      const csv = await client.exportDocumentsCsv({
        kind: z.enum(['invoice', 'offer']).parse(requireStringFlag(args, 'kind')),
      });
      const outPath = getStringFlag(args, 'out');
      if (outPath) {
        await writeText(outPath, csv);
        writeJson(io, { ok: true, path: outPath });
        return 0;
      }
      writeJson(io, { csv });
      return 0;
    }
  }

  if (group === 'pro') {
    const proArgs: ParsedArgs = {
      ...args,
      flags: {
        ...args.flags,
        product: 'pro',
      },
    };
    const context = await buildSharedContext(proArgs, io, { forceProduct: 'pro' });
    const client = createBillmeServerClient(context);
    const [_, scope, action] = proArgs.positionals;

    if (scope === 'articles' && action === 'list') {
      writeJson(io, await client.listArticles());
      return 0;
    }
    if (scope === 'articles' && action === 'upsert') {
      const payload = withGeneratedId(await readJsonInput(proArgs, io, articleSchema.partial()));
      writeJson(io, await client.upsertArticle({ article: articleSchema.parse(payload) }));
      return 0;
    }
    if (scope === 'accounts' && action === 'list') {
      writeJson(io, await client.listAccounts());
      return 0;
    }
    if (scope === 'accounts' && action === 'upsert') {
      const payload = withGeneratedId(await readJsonInput(proArgs, io, accountSchema.partial()));
      writeJson(
        io,
        await client.upsertAccount({
          account: accountSchema.parse({
            ...payload,
            transactions: payload.transactions ?? [],
          }),
        }),
      );
      return 0;
    }
    if (scope === 'templates' && action === 'list') {
      const kind = getStringFlag(proArgs, 'kind');
      writeJson(
        io,
        await client.listTemplates({
          kind: kind ? templateKindSchema.parse(kind) : undefined,
        }),
      );
      return 0;
    }
    if (scope === 'templates' && action === 'upsert') {
      const payload = withGeneratedId(await readJsonInput(proArgs, io, templateSchema.partial()));
      writeJson(
        io,
        await client.upsertTemplate({
          template: templateSchema.parse(payload),
        }),
      );
      return 0;
    }
    if (scope === 'templates' && action === 'get-active') {
      writeJson(
        io,
        await client.getActiveTemplate({
          kind: templateKindSchema.parse(requireStringFlag(proArgs, 'kind')),
        }),
      );
      return 0;
    }
    if (scope === 'templates' && action === 'set-active') {
      writeJson(
        io,
        await client.setActiveTemplate({
          kind: templateKindSchema.parse(requireStringFlag(proArgs, 'kind')),
          templateId: getStringFlag(proArgs, 'template-id') ?? null,
        }),
      );
      return 0;
    }
  }

  throw new UsageError('Unknown command. Run with --help to see the available command groups.');
};

export const runCli = async (argv: string[], io: CliIo): Promise<number> => {
  const args = parseArgv(argv);
  try {
    return await withDefaults(args, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(
        `${JSON.stringify(
          {
            ok: false,
            error: {
              type: 'usage',
              message: error.message,
            },
          },
          null,
          2,
        )}\n`,
      );
      return 2;
    }

    const runtimeError = error as BillmeServerClientError | Error;
    io.stderr.write(
      `${JSON.stringify(
        {
          ok: false,
          error: {
            type: 'runtime',
            message: runtimeError.message,
            ...(typeof (runtimeError as BillmeServerClientError).statusCode === 'number'
              ? { statusCode: (runtimeError as BillmeServerClientError).statusCode }
              : {}),
          },
        },
        null,
        2,
      )}\n`,
    );
    return 1;
  }
};
