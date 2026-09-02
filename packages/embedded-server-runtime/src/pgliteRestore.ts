import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { verifyPostgresAuditChain, type AuditChainVerificationResult } from '@billme/server-data/postgres';
import { createPgliteServerDatabase, type PgliteServerDatabase } from '@billme/server-data/pglite';

export interface RestorePgliteDataDirOptions {
  readonly archivePath: string;
  readonly activeDataDir: string;
  readonly product: 'lite' | 'pro';
  readonly tenantId: string;
}

export interface RestorePgliteDataDirResult {
  readonly ok: true;
  readonly verification: AuditChainVerificationResult;
}

/**
 * Verifies a PGlite archive in a sibling directory and atomically activates it.
 * The active database must already be closed by the caller. No directory is
 * replaced until the staged database has a current schema and valid tenant
 * audit chain.
 */
export const restorePgliteDataDir = async (
  options: RestorePgliteDataDirOptions,
): Promise<RestorePgliteDataDirResult> => {
  const activeDataDir = resolve(options.activeDataDir);
  const archivePath = resolve(options.archivePath);
  if (!existsSync(activeDataDir)) {
    throw new Error(`Aktives PGlite-Datenverzeichnis wurde nicht gefunden: ${activeDataDir}`);
  }

  const stagingDataDir = `${activeDataDir}.restore-${randomUUID()}`;
  const previousDataDir = `${activeDataDir}.previous-${randomUUID()}`;
  let stagedDatabase: PgliteServerDatabase | undefined;

  try {
    await mkdir(dirname(activeDataDir), { recursive: true });
    await mkdir(stagingDataDir, { recursive: false });
    const archive = await readFile(archivePath);
    stagedDatabase = await createPgliteServerDatabase(stagingDataDir, {
      loadDataDir: new Blob([new Uint8Array(archive)]),
    });
    await stagedDatabase.assertCurrent();

    const tenant = await stagedDatabase.query<{ id: string; product: string }>(
      'SELECT id, product FROM tenants WHERE id = $1',
      [options.tenantId],
    );
    if (tenant.rows.length !== 1 || tenant.rows[0]?.product !== options.product) {
      throw new Error(`Restore-Archiv enthält keinen gültigen ${options.product}-Mandanten.`);
    }

    const verification = await verifyPostgresAuditChain(stagedDatabase, options.tenantId);
    if (!verification.ok) {
      throw new Error('Restore-Archiv enthält eine ungültige Audit-Kette.');
    }

    await stagedDatabase.close();
    stagedDatabase = undefined;

    await rename(activeDataDir, previousDataDir);
    try {
      await rename(stagingDataDir, activeDataDir);
    } catch (error) {
      await rename(previousDataDir, activeDataDir).catch(() => undefined);
      throw error;
    }

    // The supplied archive remains the recoverable copy after activation. A
    // stale previous directory is safe to retain if cleanup is interrupted;
    // never turn a successful swap into a reported restore failure.
    await rm(previousDataDir, { recursive: true, force: true }).catch(() => undefined);
    return { ok: true, verification };
  } catch (error) {
    if (stagedDatabase) {
      await stagedDatabase.close().catch(() => undefined);
    }
    await rm(stagingDataDir, { recursive: true, force: true });
    throw error;
  }
};
