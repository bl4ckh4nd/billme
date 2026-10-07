import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { EmbeddedConnectionResult } from '@billme/desktop-contracts/embeddedConnection';
import type {
  EmbeddedDatabaseInitializerContext,
  EmbeddedServerHandle,
  RestorePgliteDataDirResult,
  StartEmbeddedServerOptions,
} from '@billme/embedded-server-runtime';
import { startEmbeddedRuntimeCoordinator } from '@billme/embedded-server-runtime/lifecycleCoordinator';
import { DEFAULT_SETTINGS } from './mockData';

export const LEGACY_SQLITE_MIGRATION_REQUIRED = 'LOCAL_BACKEND_MIGRATION_REQUIRED';

type LocalProduct = 'lite' | 'pro';

/** The product profile fields that decide where local data lives and who owns it. */
export interface LocalBackendProfile {
  readonly dbFileName: string;
  readonly dataDirName: string;
  readonly localTenantId: string;
  readonly localUserId: string;
  readonly localUserEmail: string;
  readonly localUserFullName: string;
}

export class LocalBackendError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'LocalBackendError';
  }
}

export interface LocalBackendStartDependencies {
  readonly product: LocalProduct;
  readonly userDataPath: string;
  readonly profile: LocalBackendProfile;
  readonly startEmbeddedServer?: (
    options: StartEmbeddedServerOptions,
  ) => Promise<EmbeddedServerHandle>;
  readonly desktopIntegration?: StartEmbeddedServerOptions['desktopIntegration'];
  readonly restoreDataDir?: (
    options: { archivePath: string; activeDataDir: string; product: LocalProduct; tenantId: string },
  ) => Promise<RestorePgliteDataDirResult>;
}

export interface LocalBackendHandle {
  readonly mode: 'pglite';
  readonly embeddedConnection: () => EmbeddedConnectionResult;
  readonly dumpDataDir: () => Promise<Blob | File>;
  readonly restoreDataDir: (archivePath: string) => Promise<RestorePgliteDataDirResult>;
  readonly close: () => Promise<void>;
}

// Persisted on first start; each product keeps the tenant slug it always had.
const LOCAL_TENANT = {
  lite: { slug: 'billme-local', displayName: 'Billme lokal' },
  pro: { slug: 'billme-pro-local', displayName: 'Billme Pro lokal' },
} as const;

type EmbeddedDatabase = Parameters<NonNullable<StartEmbeddedServerOptions['initializeDatabase']>>[0];

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
  product: LocalProduct,
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

const initializeLocalIdentity = async (
  product: LocalProduct,
  database: EmbeddedDatabase,
  context: EmbeddedDatabaseInitializerContext,
): Promise<void> => {
  const tenant = LOCAL_TENANT[product];
  await database.transaction({}, async (session) => {
    const timestamp = new Date().toISOString();
    await session.query(
      `INSERT INTO tenants (id, slug, display_name, product, deployment_mode, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'single-tenant', 'active', $5, $5)
       ON CONFLICT (id) DO NOTHING`,
      [context.identity.tenantId, tenant.slug, tenant.displayName, context.product, timestamp],
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
    await session.query(
      `INSERT INTO server_settings (tenant_id, settings_json, created_at, updated_at)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [context.identity.tenantId, JSON.stringify(DEFAULT_SETTINGS), timestamp],
    );
  });
};

/** Starts the only supported desktop persistence runtime: the embedded server on PGlite. */
export const createLocalBackend = async (
  dependencies: LocalBackendStartDependencies,
): Promise<LocalBackendHandle> => {
  const { product, profile } = dependencies;
  const legacySqlitePath = join(dependencies.userDataPath, profile.dbFileName);
  const activePglitePath = join(dependencies.userDataPath, profile.dataDirName);

  // v0.4.0 and earlier stored data in SQLite; never start empty on top of it.
  if (!existsSync(activePglitePath) && existsSync(legacySqlitePath)) {
    throw new LocalBackendError(
      LEGACY_SQLITE_MIGRATION_REQUIRED,
      [
        'Eine bestehende SQLite-Datenbank wurde gefunden, aber noch nicht nach PGlite migriert.',
        'Die App bleibt geschlossen, damit keine Daten überschrieben werden.',
        `Führen Sie einmal aus: ${formatMigrationCommand(product, legacySqlitePath, activePglitePath)}`,
      ].join(' '),
    );
  }

  const start = dependencies.startEmbeddedServer ??
    (await import('@billme/embedded-server-runtime')).startEmbeddedServer;
  const startEmbedded = () => start({
    userDataPath: dependencies.userDataPath,
    dataDirName: profile.dataDirName,
    product,
    desktopIntegration: dependencies.desktopIntegration,
    identity: {
      tenantId: profile.localTenantId,
      userId: profile.localUserId,
      email: profile.localUserEmail,
      fullName: profile.localUserFullName,
      role: 'owner',
    },
    initializeDatabase: (database, context) => initializeLocalIdentity(product, database, context),
  });
  const lifecycle = await startEmbeddedRuntimeCoordinator<RestorePgliteDataDirResult>({
    start: startEmbedded,
    restore: async (archivePath) => {
      const restore = dependencies.restoreDataDir ??
        (await import('@billme/embedded-server-runtime')).restorePgliteDataDir;
      return restore({
        archivePath,
        activeDataDir: activePglitePath,
        product,
        tenantId: profile.localTenantId,
      });
    },
  });

  return {
    mode: 'pglite',
    embeddedConnection: lifecycle.connection,
    dumpDataDir: lifecycle.dumpDataDir,
    restoreDataDir: lifecycle.restoreDataDir,
    close: lifecycle.close,
  };
};
