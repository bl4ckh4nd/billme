import { readFile } from 'node:fs/promises';
import { z, ZodFirstPartyTypeKind as Kind, type ZodTypeAny } from 'zod';
import type { ContractRouteMap } from '@billme/desktop-contracts/api-factory';
import { ipcRoutes as liteRoutes } from '@billme/desktop-contracts/contract';
import { ipcRoutes as proRoutes } from '@billme/desktop-contracts-pro/contract';
import { isNativeElectronRoute } from '@billme/desktop-services/serverRouteClassification';
import type { ServerProduct } from '@billme/server-core';

export type CliAction = {
  key: string;
  group: string;
  method: string;
  args: ZodTypeAny;
  result: ZodTypeAny;
};

type ObjectSchema = z.ZodObject<z.ZodRawShape>;

/** Documents are created in three calls (reserve, save, finalize); the CLI offers them as one command. */
export const COMPOSITE_CREATE_KEYS = ['invoices:create', 'offers:create'] as const;

const createArgs = (routes: ContractRouteMap, upsertKey: string, documentKey: string): ZodTypeAny => {
  const upsert = routes[upsertKey]!.args as ObjectSchema;
  return z.object({
    clientId: z.string().min(1),
    reason: z.string().min(1),
    document: (upsert.shape[documentKey] as ObjectSchema).partial().optional(),
  });
};

/** Shell routes the CLI serves itself, over HTTP: the API renders the PDF and the CLI saves it. */
export const CLI_NATIVE_KEYS: readonly string[] = ['pdf:export', 'eur:exportPdf'];

/** Lite-only areas Pro inherits through its contract: Pro has no cash book and reports VAT from its journal, so the server has no such routes. */
const LITE_ONLY_GROUPS: readonly string[] = ['cash', 'vat'];

/** Every contract route a separate process can reach; routes that need the Electron shell are left out. */
export const listCliActions = (product: ServerProduct): CliAction[] => {
  const routes: ContractRouteMap = product === 'pro' ? proRoutes : liteRoutes;
  const all: ContractRouteMap = {
    ...routes,
    'invoices:create': { args: createArgs(routes, 'invoices:upsert', 'invoice'), result: routes['invoices:upsert']!.result },
    'offers:create': { args: createArgs(routes, 'offers:upsert', 'offer'), result: routes['offers:upsert']!.result },
  };
  return Object.keys(all)
    // `cliAccess:*` approves and revokes CLI tokens; the server refuses those to a CLI token.
    .filter((key) => (!isNativeElectronRoute(key) || CLI_NATIVE_KEYS.includes(key)) && !key.startsWith('cliAccess:'))
    .filter((key) => product !== 'pro' || !LITE_ONLY_GROUPS.includes(key.split(':')[0]!))
    .sort()
    .map((key) => {
      const [group, method] = key.split(':') as [string, string];
      return { key, group, method, args: all[key]!.args, result: all[key]!.result };
    });
};

const unwrap = (schema: ZodTypeAny): ZodTypeAny => {
  let current = schema;
  for (;;) {
    const def = current._def;
    if (def.typeName === Kind.ZodOptional || def.typeName === Kind.ZodNullable || def.typeName === Kind.ZodDefault) {
      current = def.innerType;
    } else if (def.typeName === Kind.ZodEffects) {
      current = def.schema;
    } else {
      return current;
    }
  }
};

export const takesNoArgs = (schema: ZodTypeAny): boolean => schema._def.typeName === Kind.ZodUndefined;

/** The top-level keys of an action's arguments, or null when the arguments are not a plain object. */
export const argShape = (schema: ZodTypeAny): z.ZodRawShape | null => {
  const inner = unwrap(schema);
  return inner._def.typeName === Kind.ZodObject ? (inner as ObjectSchema).shape : null;
};

/** JSON-Schema-like description of a contract schema, for `--help` and `billme actions --json`. */
export const describeSchema = (schema: ZodTypeAny, depth = 0): Record<string, unknown> => {
  if (depth > 24) return {};
  const def = schema._def;
  const next = (inner: ZodTypeAny) => describeSchema(inner, depth + 1);
  switch (def.typeName) {
    case Kind.ZodString: return { type: 'string' };
    case Kind.ZodNumber: return { type: 'number' };
    case Kind.ZodBoolean: return { type: 'boolean' };
    case Kind.ZodUndefined:
    case Kind.ZodVoid:
    case Kind.ZodNull: return { type: 'null' };
    case Kind.ZodLiteral: return { const: def.value };
    case Kind.ZodEnum: return { enum: def.values };
    case Kind.ZodNativeEnum: return { enum: Object.values(def.values) };
    case Kind.ZodArray: return { type: 'array', items: next(def.type) };
    case Kind.ZodTuple: return { type: 'array', prefixItems: def.items.map(next) };
    case Kind.ZodRecord: return { type: 'object', additionalProperties: next(def.valueType) };
    case Kind.ZodObject: {
      const shape = (schema as ObjectSchema).shape;
      const keys = Object.keys(shape);
      return {
        type: 'object',
        properties: Object.fromEntries(keys.map((key) => [key, next(shape[key]!)])),
        required: keys.filter((key) => !shape[key]!.isOptional()),
      };
    }
    case Kind.ZodOptional: return next(def.innerType);
    case Kind.ZodNullable: return { anyOf: [next(def.innerType), { type: 'null' }] };
    case Kind.ZodDefault: return { ...next(def.innerType), default: def.defaultValue() };
    case Kind.ZodEffects: return next(def.schema);
    case Kind.ZodLazy: return next(def.getter());
    case Kind.ZodUnion:
    case Kind.ZodDiscriminatedUnion: return { anyOf: [...def.options].map(next) };
    case Kind.ZodIntersection: return { allOf: [next(def.left), next(def.right)] };
    default: return {};
  }
};

export const camelize = (flag: string): string => flag.replace(/-([a-z0-9])/g, (_, char: string) => char.toUpperCase());

const parseJsonValue = async (raw: string): Promise<unknown> =>
  JSON.parse(raw.startsWith('@') ? await readFile(raw.slice(1), 'utf8') : raw);

const coerceFlag = async (name: string, raw: string | boolean, schema: ZodTypeAny | undefined): Promise<unknown> => {
  if (typeof raw === 'boolean') return raw;
  const kind = schema ? unwrap(schema)._def.typeName : undefined;
  if (kind === Kind.ZodString || kind === Kind.ZodEnum) return raw;
  if (kind === Kind.ZodNumber) return Number(raw);
  if (kind === Kind.ZodBoolean) return raw !== 'false';
  try {
    return await parseJsonValue(raw);
  } catch (error) {
    // Literals and unions of strings are given bare; everything else must be valid JSON.
    if (kind === Kind.ZodLiteral || kind === Kind.ZodUnion || kind === undefined) return raw;
    throw new Error(`--${name} expects JSON or @file: ${(error as Error).message}`);
  }
};

/** Turns `--some-key value` flags into action arguments, typed by the action's own schema. */
export const flagsToArgs = async (
  action: CliAction,
  flags: Record<string, string | boolean>,
): Promise<Record<string, unknown>> => {
  const shape = argShape(action.args);
  const args: Record<string, unknown> = {};
  for (const [flag, raw] of Object.entries(flags)) {
    const key = camelize(flag);
    if (shape && !(key in shape)) {
      throw new Error(`Unknown option --${flag} for ${action.group} ${action.method}. Known: ${Object.keys(shape).map((name) => `--${name}`).join(', ') || 'none'}.`);
    }
    args[key] = await coerceFlag(flag, raw, shape?.[key]);
  }
  return args;
};
