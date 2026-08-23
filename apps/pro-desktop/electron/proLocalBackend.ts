import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EmbeddedConnectionResult } from '@billme/desktop-contracts/embeddedConnection';
import type {
  EmbeddedDatabaseInitializerContext,
  EmbeddedServerHandle,
  StartEmbeddedServerOptions,
} from '@billme/embedded-server-runtime';
import type { RestorePgliteDataDirResult } from '@billme/embedded-server-runtime';
import type { ProductProfile } from '../productProfile';

export const PRO_PGLITE_MIGRATION_REQUIRED = 'PRO_PGLITE_MIGRATION_REQUIRED';
export const PGLITE_SQLITE_IPC_UNAVAILABLE = 'PGLITE_SQLITE_IPC_UNAVAILABLE';

const quoteMigrationPath = (pathValue: string, platform: NodeJS.Platform = process.platform): string => {
  if (platform === 'win32') {
    const escaped = pathValue
      .replace(/(\\*)"/g, '$1$1\\"')
      .replace(/(\\+)$/g, '$1$1');
    return `"${escaped}"`;
  }
  return `'${pathValue.replaceAll("'", "'\\''")}'`;
};

const formatMigrationCommand = (
  product: 'lite' | 'pro',
  sourcePath: string,
  targetDataDir: string,
  platform: NodeJS.Platform = process.platform,
): string => [
  'billme-pglite-migrate',
  '--product',
  product,
  '--source',
  quoteMigrationPath(sourcePath, platform),
  '--target',
  quoteMigrationPath(targetDataDir, platform),
].join(' ');

export class ProLocalBackendError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProLocalBackendError';
  }
}

export interface ProLocalBackendStartDependencies {
  readonly userDataPath: string;
  readonly profile: ProductProfile;
  readonly startEmbeddedServer?: (
    options: StartEmbeddedServerOptions,
  ) => Promise<EmbeddedServerHandle>;
  readonly restoreDataDir?: (
    options: { archivePath: string; activeDataDir: string; product: 'pro'; tenantId: string },
  ) => Promise<RestorePgliteDataDirResult>;
}

export interface ProLocalBackendHandle {
  readonly mode: 'pglite';
  readonly embeddedConnection: () => EmbeddedConnectionResult;
  readonly dumpDataDir: () => Promise<Blob | File>;
  readonly restoreDataDir: (archivePath: string) => Promise<RestorePgliteDataDirResult>;
  /** Compatibility provider for legacy native IPC routes; never opens SQLite. */
  readonly requireDb: () => never;
  readonly close: () => Promise<void>;
}

const now = (): string => new Date().toISOString();

type EmbeddedDatabase = Parameters<NonNullable<StartEmbeddedServerOptions['initializeDatabase']>>[0];

const initializeProIdentity = async (
  database: EmbeddedDatabase,
  context: EmbeddedDatabaseInitializerContext,
): Promise<void> => {
  await database.transaction({}, async (session) => {
    const timestamp = now();
    await session.query(
      `INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'single-tenant', 'active', $5, $5)
       ON CONFLICT (id) DO NOTHING`,
      [context.identity.tenantId, 'billme-pro-local', 'Billme Pro lokal', context.product, timestamp],
    );
    await session.query(
      `INSERT INTO user_accounts (id, email, full_name, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'active', $4, $4)
       ON CONFLICT (id) DO NOTHING`,
      [context.identity.userId, context.identity.email, context.identity.fullName, timestamp],
    );
    await session.query(
      `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, created_at, updated_at)
       VALUES ($1, $2, $3, 'owner', $4, $4)
       ON CONFLICT (tenant_id, user_id) DO NOTHING`,
      [`${context.identity.tenantId}:owner`, context.identity.tenantId, context.identity.userId, timestamp],
    );
  });
};

const requireSqliteIpcUnavailable = (): never => {
  throw new ProLocalBackendError(
    PGLITE_SQLITE_IPC_UNAVAILABLE,
    'PGlite ist aktiv. Die lokale SQLite-IPC-Datenbank wird in Billme Pro nicht mehr verwendet.',
  );
};

/** Starts the only supported Pro desktop persistence runtime: embedded PGlite. */
export const createProLocalBackend = async (
  dependencies: ProLocalBackendStartDependencies,
): Promise<ProLocalBackendHandle> => {
  const legacySqlitePath = join(dependencies.userDataPath, dependencies.profile.dbFileName);
  const activePglitePath = join(dependencies.userDataPath, dependencies.profile.dataDirName);

  if (existsSync(legacySqlitePath) && !existsSync(activePglitePath)) {
    throw new ProLocalBackendError(
      PRO_PGLITE_MIGRATION_REQUIRED,
      `Eine SQLite-Datenbank wurde unter ${legacySqlitePath} gefunden. Bitte führen Sie zuerst das separate SQLite-zu-PGlite-Migrationsprogramm aus: ${formatMigrationCommand('pro', legacySqlitePath, activePglitePath)}`,
    );
  }

  const start = dependencies.startEmbeddedServer ??
    (await import('@billme/embedded-server-runtime')).startEmbeddedServer;
  const startEmbedded = () => start({
    userDataPath: dependencies.userDataPath,
    dataDirName: dependencies.profile.dataDirName,
    product: 'pro',
    identity: {
      tenantId: dependencies.profile.localTenantId,
      userId: dependencies.profile.localUserId,
      email: dependencies.profile.localUserEmail,
      fullName: dependencies.profile.localUserFullName,
      role: 'owner',
    },
    initializeDatabase: initializeProIdentity,
  });
  let embedded = await startEmbedded();
  let embeddedClosePromise: Promise<void> | undefined;
  const closeEmbedded = (): Promise<void> => {
    embeddedClosePromise ??= embedded.close();
    return embeddedClosePromise;
  };

  let closePromise: Promise<void> | undefined;
  return {
    mode: 'pglite',
    embeddedConnection: () => ({ baseUrl: embedded.baseUrl, token: embedded.accessToken }),
    dumpDataDir: embedded.dumpDataDir,
    restoreDataDir: async (archivePath) => {
      await closeEmbedded();
      try {
        const restore = dependencies.restoreDataDir ??
          (await import('@billme/embedded-server-runtime')).restorePgliteDataDir;
        return await restore({
          archivePath,
          activeDataDir: activePglitePath,
          product: 'pro',
          tenantId: dependencies.profile.localTenantId,
        });
      } catch (error) {
        embedded = await startEmbedded();
        embeddedClosePromise = undefined;
        throw error;
      }
    },
    requireDb: requireSqliteIpcUnavailable,
    close: () => {
      closePromise ??= closeEmbedded();
      return closePromise;
    },
  };
};
