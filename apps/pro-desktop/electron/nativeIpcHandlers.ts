import {
  registerNativeIpcCommonHandlers,
  type NativeIpcCommonDependencies,
  type NativeIpcHandler,
  type NativeIpcMain,
} from '@billme/desktop-core/electron/nativeIpc';
import { ipcRoutes } from '@billme/desktop-contracts-pro/contract';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getCurrentUpdateStatus, downloadUpdate, quitAndInstall } from './updater';
import { secrets } from './secrets';
import { exportEurPdf, exportPdf } from './pdfExport';

export type NativeHandlerDependencies = Omit<NativeIpcCommonDependencies, 'secrets' | 'updater'>;

type TaxAuditExportArtifact = {
  schemaVersion: number;
  createdAt: string;
  from: string | null;
  to: string | null;
  includeDocuments: boolean;
  files: Array<{
    name: string;
    content: string;
    sizeBytes: number;
    sha256: string;
    rowCount?: number;
  }>;
};

const saveTaxAuditExportPackage = (deps: NativeHandlerDependencies): NativeIpcHandler => (rawArtifact) => {
  const artifact = rawArtifact as TaxAuditExportArtifact;
  const exportRoot = resolve(join(deps.getUserDataPath(), 'exports', 'tax-audit-packages'));
  const stamp = artifact.createdAt.replace(/[^A-Za-z0-9_-]/g, '-');
  const bundleDir = resolve(join(exportRoot, `tax-audit-${stamp}-${randomUUID()}`));
  const stagingDir = `${bundleDir}.staging`;
  const seenNames = new Set<string>();
  const files = artifact.files.map((entry) => {
    if (
      entry.name !== entry.name.split(/[\\/]/).pop()
      || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name)
      || seenNames.has(entry.name)
    ) {
      throw new Error('Ungültiger Dateiname im Steuerprüfungsexport.');
    }
    seenNames.add(entry.name);
    const bytes = Buffer.from(entry.content, 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== entry.sizeBytes || sha256 !== entry.sha256) {
      throw new Error(`Integritätsprüfung für ${entry.name} fehlgeschlagen.`);
    }
    return {
      name: entry.name,
      path: join(bundleDir, entry.name),
      sha256,
      sizeBytes: bytes.byteLength,
      ...(entry.rowCount === undefined ? {} : { rowCount: entry.rowCount }),
      content: entry.content,
    };
  });

  try {
    mkdirSync(exportRoot, { recursive: true });
    mkdirSync(stagingDir, { recursive: false });
    for (const entry of files) writeFileSync(join(stagingDir, entry.name), entry.content, 'utf8');
    const resultFiles = files.map(({ content: _content, ...entry }) => entry);
    writeFileSync(
      join(stagingDir, 'manifest.json'),
      JSON.stringify({
        schemaVersion: artifact.schemaVersion,
        createdAt: artifact.createdAt,
        from: artifact.from,
        to: artifact.to,
        includeDocuments: artifact.includeDocuments,
        fileCount: resultFiles.length,
        files: resultFiles,
      }, null, 2),
      'utf8',
    );
    renameSync(stagingDir, bundleDir);
    return {
      bundleDir,
      manifestPath: join(bundleDir, 'manifest.json'),
      createdAt: artifact.createdAt,
      fileCount: resultFiles.length,
      files: resultFiles,
    };
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }
};

export const registerNativeIpcHandlers = (
  ipcMain: NativeIpcMain,
  deps: NativeHandlerDependencies,
): void => {
  registerNativeIpcCommonHandlers(
    ipcMain,
    ipcRoutes,
    {
      ...deps,
      secrets,
      updater: { getCurrentUpdateStatus, downloadUpdate, quitAndInstall },
    },
    { exportPdf, exportEurPdf },
    { 'tax:saveAuditExportPackage': saveTaxAuditExportPackage(deps) },
  );
};
