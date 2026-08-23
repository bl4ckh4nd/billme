import { dialog, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { IpcMain } from 'electron';
import {
  ipcRoutes,
  type IpcArgs,
  type IpcResult,
  type IpcRouteKey,
} from '@billme/desktop-contracts-pro/contract';
import { getCurrentUpdateStatus, downloadUpdate, quitAndInstall } from './updater';
import { secrets } from './secrets';
import { exportEurPdf, exportPdf } from './pdfExport';

type NativeRouteKey =
  | 'window:minimize'
  | 'window:toggleMaximize'
  | 'window:close'
  | 'window:isMaximized'
  | 'shell:openPath'
  | 'shell:openExportsDir'
  | 'shell:openExternal'
  | 'dialog:pickCsv'
  | 'pdf:export'
  | 'eur:exportPdf'
  | 'db:backup'
  | 'db:restore'
  | 'tax:saveAuditExportPackage'
  | 'secrets:get'
  | 'secrets:set'
  | 'secrets:delete'
  | 'secrets:has'
  | 'updater:getStatus'
  | 'updater:downloadUpdate'
  | 'updater:quitAndInstall';

type NativeIpcMain = Pick<IpcMain, 'handle'>;

type NativeHandlerDependencies = {
  getUserDataPath: () => string;
  getBackupPrefix: () => string;
  dumpDataDir: () => Promise<Uint8Array | Blob | File>;
  restoreDataDir: (archivePath: string) => Promise<IpcResult<'db:restore'>>;
  relaunch: () => void;
  getMainWindow: () => BrowserWindow | null;
  isTrustedSender: (sender: IpcMainInvokeEvent['sender']) => boolean;
};

type RouteHandler<K extends NativeRouteKey> = (
  args: IpcArgs<K>,
) => Promise<IpcResult<K>> | IpcResult<K>;

const register = <K extends NativeRouteKey>(
  ipcMain: NativeIpcMain,
  key: K,
  isTrustedSender: NativeHandlerDependencies['isTrustedSender'],
  fn: RouteHandler<K>,
) => {
  const route = ipcRoutes[key as IpcRouteKey];
  ipcMain.handle(route.channel, async (event, rawArgs) => {
    if (!isTrustedSender(event.sender)) {
      throw new Error('Nicht vertrauenswürdiger WebContents-Sender.');
    }
    const args = route.args.parse(rawArgs) as IpcArgs<K>;
    const result = await fn(args);
    return route.result.parse(result) as IpcResult<K>;
  });
};

const isPathWithin = (targetPath: string, rootPath: string): boolean =>
  targetPath === rootPath || targetPath.startsWith(`${rootPath}${sep}`);

const dumpBytes = async (dump: Uint8Array | Blob | File): Promise<Uint8Array> => {
  if (dump instanceof Uint8Array) return dump;
  return new Uint8Array(await dump.arrayBuffer());
};

const backupPath = (userDataPath: string, prefix: string): string => {
  const timestamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
  const nonce = randomUUID().replaceAll('-', '');
  return join(resolve(userDataPath), 'backups', `${prefix}-${timestamp}-${nonce}.pglite.tar`);
};

const isPgliteArchive = (targetPath: string): boolean =>
  /\.pglite\.(?:tar|tgz)$/i.test(targetPath);

const validateRestoreArchive = (targetPath: string, userDataPath: string): string => {
  const backupsRoot = resolve(join(userDataPath, 'backups'));
  const resolved = resolve(targetPath);
  if (!isPathWithin(resolved, backupsRoot) || resolved === backupsRoot) {
    throw new Error('Dieser Pfad liegt außerhalb der App-Datenordner.');
  }
  if (!isPgliteArchive(resolved)) {
    throw new Error('Ungültiges PGlite-Backup-Archiv.');
  }

  let file;
  try {
    file = lstatSync(resolved);
  } catch {
    throw new Error('PGlite-Backup-Archiv wurde nicht gefunden.');
  }
  if (!file.isFile() || file.isSymbolicLink()) {
    throw new Error('PGlite-Backup-Archiv muss eine reguläre Datei sein.');
  }
  if (file.size <= 0) {
    throw new Error('PGlite-Backup-Archiv ist leer.');
  }
  return resolved;
};

export const registerNativeIpcHandlers = (
  ipcMain: NativeIpcMain,
  deps: NativeHandlerDependencies,
) => {
  register(ipcMain, 'window:minimize', deps.isTrustedSender, () => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
    return { ok: true };
  });

  register(ipcMain, 'window:toggleMaximize', deps.isTrustedSender, () => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
    return { ok: true };
  });

  register(ipcMain, 'window:close', deps.isTrustedSender, () => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    return { ok: true };
  });

  register(ipcMain, 'window:isMaximized', deps.isTrustedSender, () => {
    const mainWindow = deps.getMainWindow();
    return { isMaximized: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized()) };
  });

  register(ipcMain, 'shell:openPath', deps.isTrustedSender, async ({ path: targetPath }) => {
    const userDataPath = resolve(deps.getUserDataPath());
    const resolved = resolve(targetPath);
    const allowedRoots = [
      resolve(join(userDataPath, 'exports')),
      resolve(join(userDataPath, 'backups')),
    ];

    if (!allowedRoots.some((root) => isPathWithin(resolved, root))) {
      throw new Error('Dieser Pfad liegt außerhalb der App-Datenordner.');
    }

    const result = await shell.openPath(resolved);
    if (result) throw new Error(result);
    return { ok: true };
  });

  register(ipcMain, 'shell:openExportsDir', deps.isTrustedSender, async () => {
    const exportsDir = resolve(join(deps.getUserDataPath(), 'exports'));
    mkdirSync(exportsDir, { recursive: true });
    const result = await shell.openPath(exportsDir);
    if (result) throw new Error(result);
    return { ok: true };
  });

  register(ipcMain, 'shell:openExternal', deps.isTrustedSender, async ({ url }) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error('Ungültige URL.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('Es sind nur http(s)-Adressen erlaubt.');
    }
    await shell.openExternal(parsed.toString(), { activate: true });
    return { ok: true };
  });

  register(ipcMain, 'dialog:pickCsv', deps.isTrustedSender, async ({ title }) => {
    const result = await dialog.showOpenDialog({
      title: title ?? 'CSV auswählen',
      properties: ['openFile'],
      filters: [
        { name: 'CSV', extensions: ['csv', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return { path: null };
    return { path: result.filePaths[0] ?? null };
  });

  register(ipcMain, 'pdf:export', deps.isTrustedSender, async ({ kind, id }) => {
    const result = await exportPdf({
      kind,
      id,
      suggestedName: `${kind}-${id}`,
      userDataPath: deps.getUserDataPath(),
    });
    return { path: result.path };
  });

  register(ipcMain, 'eur:exportPdf', deps.isTrustedSender, async ({ taxYear, from, to }) => {
    const result = await exportEurPdf({
      taxYear,
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      userDataPath: deps.getUserDataPath(),
    });
    return { path: result.path };
  });

  register(ipcMain, 'db:backup', deps.isTrustedSender, async () => {
    const destination = backupPath(deps.getUserDataPath(), deps.getBackupPrefix());
    const backupsDir = resolve(join(deps.getUserDataPath(), 'backups'));
    const temporary = `${destination}.tmp-${randomUUID().replaceAll('-', '')}`;
    mkdirSync(backupsDir, { recursive: true });
    try {
      const bytes = await dumpBytes(await deps.dumpDataDir());
      writeFileSync(temporary, bytes, { flag: 'wx' });
      renameSync(temporary, destination);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // The atomic rename may have moved the file before a subsequent error.
      }
      throw error;
    }
    return { path: destination };
  });

  register(ipcMain, 'db:restore', deps.isTrustedSender, async ({ path: archivePath }) => {
    const validatedArchivePath = validateRestoreArchive(archivePath, deps.getUserDataPath());
    const result = await deps.restoreDataDir(validatedArchivePath);
    // Let Electron deliver the successful invoke result before restarting the
    // process. A failed restore never reaches this scheduling point.
    if (result.ok) setTimeout(() => deps.relaunch(), 0);
    return result;
  });

  register(ipcMain, 'tax:saveAuditExportPackage', deps.isTrustedSender, (artifact) => {
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
      for (const entry of files) {
        writeFileSync(join(stagingDir, entry.name), entry.content, 'utf8');
      }
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
  });

  register(ipcMain, 'secrets:get', deps.isTrustedSender, ({ key }) => secrets.get(key));

  register(ipcMain, 'secrets:set', deps.isTrustedSender, async ({ key, value }) => {
    await secrets.set(key, value);
  });

  register(ipcMain, 'secrets:delete', deps.isTrustedSender, ({ key }) => secrets.delete(key));

  register(ipcMain, 'secrets:has', deps.isTrustedSender, async ({ key }) => {
    const value = await secrets.get(key);
    return Boolean(value && value.length > 0);
  });

  register(ipcMain, 'updater:getStatus', deps.isTrustedSender, () => getCurrentUpdateStatus());

  register(ipcMain, 'updater:downloadUpdate', deps.isTrustedSender, async () => {
    await downloadUpdate();
    return { ok: true };
  });

  register(ipcMain, 'updater:quitAndInstall', deps.isTrustedSender, () => {
    quitAndInstall();
    return { ok: true };
  });
};

export type { NativeHandlerDependencies, NativeRouteKey };
