import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  buildServerApi,
  type BuildServerApiOptions,
  type EmbeddedLocalAuthOptions,
} from '@billme/server-runtime';
import {
  createPgliteServerDatabase,
  type ServerDatabase,
} from '@billme/server-data';
type DumpTarCompression = 'none' | 'gzip' | 'auto';

export interface EmbeddedLocalIdentity {
  readonly tenantId: string;
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
  readonly role?: EmbeddedLocalAuthOptions['role'];
}

export interface EmbeddedServerLogger {
  readonly debug?: (context: string, message: string, data?: unknown) => void;
  readonly info?: (context: string, message: string, data?: unknown) => void;
  readonly warn?: (context: string, message: string, data?: unknown) => void;
  readonly error?: (context: string, message: string, error?: Error, data?: unknown) => void;
}

export interface EmbeddedDatabaseInitializerContext {
  readonly product: 'lite' | 'pro';
  readonly identity: EmbeddedLocalIdentity;
  readonly dataDir: string;
}

export type EmbeddedDatabaseInitializer = (
  database: ServerDatabase,
  context: EmbeddedDatabaseInitializerContext,
) => void | Promise<void>;

export interface StartEmbeddedServerOptions {
  /** Electron's app.getPath('userData') result. */
  readonly userDataPath: string;
  /** A single directory name below userDataPath, not an arbitrary path. */
  readonly dataDirName: string;
  readonly product: 'lite' | 'pro';
  readonly identity: EmbeddedLocalIdentity;
  readonly initializeDatabase?: EmbeddedDatabaseInitializer;
  readonly logger?: EmbeddedServerLogger;
}

export interface EmbeddedServerHandle {
  readonly baseUrl: string;
  readonly accessToken: string;
  readonly dumpDataDir: () => Promise<Blob | File>;
  readonly close: () => Promise<void>;
}

const ensureNonEmpty = (name: string, value: string): void => {
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must not be empty`);
  }
};

const validateOptions = (options: StartEmbeddedServerOptions): void => {
  ensureNonEmpty('userDataPath', options.userDataPath);
  ensureNonEmpty('dataDirName', options.dataDirName);
  if (
    options.dataDirName === '.' ||
    options.dataDirName === '..' ||
    basename(options.dataDirName) !== options.dataDirName
  ) {
    throw new TypeError('dataDirName must be a single directory name');
  }
  ensureNonEmpty('identity.tenantId', options.identity.tenantId);
  ensureNonEmpty('identity.userId', options.identity.userId);
  ensureNonEmpty('identity.email', options.identity.email);
  ensureNonEmpty('identity.fullName', options.identity.fullName);
};

const createAccessToken = (): string => randomBytes(32).toString('base64url');

const createSessionSecret = (): string => randomBytes(48).toString('base64url');

type EmbeddedDatabase = ServerDatabase & {
  readonly dumpDataDir: (compression?: DumpTarCompression) => Promise<Blob | File>;
};

const createIdempotentDatabase = (database: EmbeddedDatabase): EmbeddedDatabase => {
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closePromise ??= Promise.resolve().then(() => database.close());
    return closePromise;
  };

  return {
    engine: database.engine,
    drizzle: database.drizzle.bind(database),
    query: database.query.bind(database),
    transaction: database.transaction.bind(database),
    migrate: database.migrate.bind(database),
    assertCurrent: database.assertCurrent.bind(database),
    dumpDataDir: database.dumpDataDir.bind(database),
    close,
  };
};

const toLocalAuth = (
  identity: EmbeddedLocalIdentity,
  accessToken: string,
): EmbeddedLocalAuthOptions => ({
  accessToken,
  tenantId: identity.tenantId,
  userId: identity.userId,
  email: identity.email,
  fullName: identity.fullName,
  ...(identity.role ? { role: identity.role } : {}),
});

const report = (
  logger: EmbeddedServerLogger | undefined,
  level: 'debug' | 'info' | 'warn',
  message: string,
  data?: unknown,
): void => {
  logger?.[level]?.('EmbeddedServer', message, data);
};

/**
 * Starts the local server runtime used by Electron.
 *
 * The returned interface intentionally exposes no database, Fastify instance,
 * or session secret. Both secrets are generated per start and remain in this
 * process only; callers receive the access token solely to construct the
 * private renderer client.
 */
export const startEmbeddedServer = async (
  options: StartEmbeddedServerOptions,
): Promise<EmbeddedServerHandle> => {
  validateOptions(options);

  const dataDir = join(options.userDataPath, options.dataDirName);
  await mkdir(dataDir, { recursive: true });

  const accessToken = createAccessToken();
  const sessionSecret = createSessionSecret();
  const database = await createPgliteServerDatabase(dataDir);
  const lifecycleDatabase = createIdempotentDatabase(database);
  type EmbeddedApp = Awaited<ReturnType<typeof buildServerApi>>;
  let app: EmbeddedApp | undefined;

  const closeResources = async (): Promise<void> => {
    let firstError: unknown;
    if (app) {
      try {
        await app.close();
      } catch (error) {
        firstError = error;
      }
    }
    try {
      await lifecycleDatabase.close();
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) throw firstError;
  };

  try {
    app = await buildServerApi({
      database: lifecycleDatabase,
      runtime: 'embedded',
      product: options.product,
      logger: false,
      sessionSecret,
      localAuth: toLocalAuth(options.identity, accessToken),
    } satisfies BuildServerApiOptions);

    await options.initializeDatabase?.(lifecycleDatabase, {
      product: options.product,
      identity: options.identity,
      dataDir,
    });

    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const parsedAddress = app.server.address();
    if (!parsedAddress || typeof parsedAddress === 'string' || parsedAddress.port <= 0) {
      throw new Error(`Embedded server did not expose a loopback port (address=${address})`);
    }

    let closePromise: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closePromise ??= closeResources();
      return closePromise;
    };

    report(options.logger, 'info', 'Embedded server listening', {
      product: options.product,
      port: parsedAddress.port,
    });

    return Object.freeze({
      baseUrl: `http://127.0.0.1:${parsedAddress.port}`,
      accessToken,
      dumpDataDir: () => lifecycleDatabase.dumpDataDir('none'),
      close,
    });
  } catch (error) {
    try {
      await closeResources();
    } catch (cleanupError) {
      options.logger?.error?.('EmbeddedServer', 'Failed to clean up after startup failure', cleanupError as Error);
    }
    throw error;
  }
};
