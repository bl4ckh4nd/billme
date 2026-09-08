import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EmbeddedConnectionResult,
} from '@billme/desktop-contracts/embeddedConnection';
import type {
  EmbeddedDatabaseInitializerContext,
  EmbeddedServerHandle,
  StartEmbeddedServerOptions,
} from '@billme/embedded-server-runtime';
import { startEmbeddedRuntimeCoordinator } from '@billme/embedded-server-runtime/lifecycleCoordinator';
import type { RestorePgliteDataDirResult } from '@billme/embedded-server-runtime';
import { DEFAULT_SETTINGS } from '@billme/desktop-services/mockData';
import type { ProductProfile } from '../productProfile';

interface ServerQueryTarget {
  query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: Row[] }>;
}

interface ServerDatabase extends ServerQueryTarget {
  transaction<T>(
    options: { isolation?: 'read-committed' | 'serializable' },
    work: (session: ServerQueryTarget) => Promise<T>,
  ): Promise<T>;
}

type ServerDatabaseSession = ServerQueryTarget;

export const LEGACY_SQLITE_MIGRATION_REQUIRED = 'LOCAL_BACKEND_MIGRATION_REQUIRED';
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

export class LocalBackendError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LocalBackendError';
  }
}

export type LocalBackendMode = 'pglite';

export interface LocalBackendStartDependencies {
  readonly userDataPath: string;
  readonly profile: ProductProfile;
  readonly startEmbeddedServer?: (
    options: StartEmbeddedServerOptions,
  ) => Promise<EmbeddedServerHandle>;
  readonly restoreDataDir?: (
    options: { archivePath: string; activeDataDir: string; product: 'lite'; tenantId: string },
  ) => Promise<RestorePgliteDataDirResult>;
}

export interface LocalBackendHandle {
  readonly mode: LocalBackendMode;
  readonly embeddedConnection: () => EmbeddedConnectionResult;
  readonly dumpDataDir: () => Promise<Blob | File>;
  readonly restoreDataDir: (archivePath: string) => Promise<RestorePgliteDataDirResult>;
  /**
   * Kept as a typed provider for the legacy IPC registration until those
   * routes are moved to the server API. It must never open SQLite.
   */
  readonly requireDb: () => never;
  readonly close: () => Promise<void>;
}

const now = (): string => new Date().toISOString();

const initializeLocalIdentity = async (
  database: ServerDatabase,
  context: EmbeddedDatabaseInitializerContext,
  profile: ProductProfile,
): Promise<void> => {
  await database.transaction({}, async (session) => {
    await insertIdentity(session, context, profile);
    await session.query(
      `INSERT INTO server_settings (tenant_id, settings_json, created_at, updated_at)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [context.identity.tenantId, JSON.stringify(DEFAULT_SETTINGS), now()],
    );
  });
};

const insertIdentity = async (
  session: ServerDatabaseSession,
  context: EmbeddedDatabaseInitializerContext,
  profile: ProductProfile,
): Promise<void> => {
  const timestamp = now();
  await session.query(
    `INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'single-tenant', 'active', $5, $5)
     ON CONFLICT (id) DO NOTHING`,
    [profile.localTenantId, 'billme-local', 'Billme lokal', context.product, timestamp],
  );
  await session.query(
    `INSERT INTO user_accounts (id, email, full_name, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'active', $4, $4)
     ON CONFLICT (id) DO NOTHING`,
    [profile.localUserId, profile.localUserEmail, profile.localUserFullName, timestamp],
  );
  await session.query(
    `INSERT INTO tenant_memberships (id, tenant_id, user_id, role, created_at, updated_at)
     VALUES ($1, $2, $3, 'owner', $4, $4)
     ON CONFLICT (tenant_id, user_id) DO NOTHING`,
    [`${profile.localTenantId}:owner`, profile.localTenantId, profile.localUserId, timestamp],
  );
};

const requirePgliteDoesNotUseSqlite = (): never => {
  throw new LocalBackendError(
    PGLITE_SQLITE_IPC_UNAVAILABLE,
    'PGlite ist aktiv. Die lokale SQLite-IPC-Datenbank ist nicht verfügbar; bitte die Server-API verwenden.',
  );
};

export const createLocalBackend = async (
  dependencies: LocalBackendStartDependencies,
): Promise<LocalBackendHandle> => {
  const legacySqlitePath = join(dependencies.userDataPath, dependencies.profile.dbFileName);
  const activePglitePath = join(dependencies.userDataPath, dependencies.profile.dataDirName);
  const initializeDatabase = (database: Parameters<NonNullable<StartEmbeddedServerOptions['initializeDatabase']>>[0], context: EmbeddedDatabaseInitializerContext) =>
    initializeLocalIdentity(
      database,
      context,
      dependencies.profile,
    );

  if (!existsSync(activePglitePath) && existsSync(legacySqlitePath)) {
    throw new LocalBackendError(
      LEGACY_SQLITE_MIGRATION_REQUIRED,
      [
        'Eine bestehende SQLite-Datenbank wurde gefunden, aber noch nicht nach PGlite migriert.',
        'Die App bleibt geschlossen, damit keine Daten überschrieben werden.',
        `Führen Sie einmal aus: ${formatMigrationCommand('lite', legacySqlitePath, activePglitePath)}`,
      ].join(' '),
    );
  }

  const start = dependencies.startEmbeddedServer ??
    (await import('@billme/embedded-server-runtime')).startEmbeddedServer;
  const startEmbedded = () => start({
    userDataPath: dependencies.userDataPath,
    dataDirName: dependencies.profile.dataDirName,
    product: 'lite',
    identity: {
      tenantId: dependencies.profile.localTenantId,
      userId: dependencies.profile.localUserId,
      email: dependencies.profile.localUserEmail,
      fullName: dependencies.profile.localUserFullName,
      role: 'owner',
    },
    initializeDatabase,
  });
  const lifecycle = await startEmbeddedRuntimeCoordinator<RestorePgliteDataDirResult>({
    start: startEmbedded,
    restore: async (archivePath) => {
      const restore = dependencies.restoreDataDir ??
        (await import('@billme/embedded-server-runtime')).restorePgliteDataDir;
      return restore({
        archivePath,
        activeDataDir: activePglitePath,
        product: 'lite',
        tenantId: dependencies.profile.localTenantId,
      });
    },
  });

  return {
    mode: 'pglite',
    embeddedConnection: lifecycle.connection,
    dumpDataDir: lifecycle.dumpDataDir,
    restoreDataDir: lifecycle.restoreDataDir,
    requireDb: requirePgliteDoesNotUseSqlite,
    close: lifecycle.close,
  };
};
