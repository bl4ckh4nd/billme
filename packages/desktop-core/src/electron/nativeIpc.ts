import { dialog, shell, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export type NativeIpcMain = Pick<IpcMain, 'handle'>;

export interface NativeIpcRoute {
  readonly channel: string;
  readonly args: { parse(value: unknown): unknown };
  readonly result: { parse(value: unknown): unknown };
}

export type NativeIpcContract = Readonly<Record<string, NativeIpcRoute>>;

export interface NativeIpcCommonDependencies {
  readonly getUserDataPath: () => string;
  readonly getBackupPrefix: () => string;
  readonly dumpDataDir: () => Promise<Uint8Array | Blob | File>;
  readonly restoreDataDir: (archivePath: string) => Promise<unknown>;
  readonly relaunch: () => void;
  readonly getMainWindow: () => BrowserWindow | null;
  readonly isTrustedSender: (sender: IpcMainInvokeEvent['sender']) => boolean;
  readonly secrets: {
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string) => Promise<void>;
    delete: (key: string) => Promise<boolean>;
  };
  readonly updater: {
    getCurrentUpdateStatus: () => unknown;
    downloadUpdate: () => Promise<void>;
    quitAndInstall: () => void;
  };
}

export type NativeIpcHandler = (args: any) => Promise<unknown> | unknown;

export interface NativeIpcDocumentExports {
  readonly exportPdf: (options: {
    kind: 'invoice' | 'offer';
    id: string;
    suggestedName: string;
    userDataPath: string;
  }) => Promise<{ path: string }>;
  readonly exportEurPdf: (options: {
    taxYear: number;
    from?: string;
    to?: string;
    userDataPath: string;
  }) => Promise<{ path: string }>;
}

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

export const validateNativeRestoreArchive = (targetPath: string, userDataPath: string): string => {
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

const registerNativeIpcRoute = (
  ipcMain: NativeIpcMain,
  contract: NativeIpcContract,
  key: string,
  isTrustedSender: NativeIpcCommonDependencies['isTrustedSender'],
  handler: NativeIpcHandler,
): void => {
  const route = contract[key];
  if (!route) return;
  ipcMain.handle(route.channel, async (event, rawArgs) => {
    if (!isTrustedSender(event.sender)) {
      throw new Error('Nicht vertrauenswürdiger WebContents-Sender.');
    }
    const args = route.args.parse(rawArgs);
    const result = await handler(args);
    return route.result.parse(result);
  });
};

/**
 * Registers the shared trusted native boundary for both desktop products.
 * Product adapters provide only their contract and print implementations;
 * security, path validation, backup/restore, secrets, and updater routing
 * remain one implementation.
 */
export const registerNativeIpcCommonHandlers = (
  ipcMain: NativeIpcMain,
  contract: NativeIpcContract,
  deps: NativeIpcCommonDependencies,
  documentExports: NativeIpcDocumentExports,
  extensions: Readonly<Record<string, NativeIpcHandler>> = {},
): void => {
  const register = (key: string, handler: NativeIpcHandler): void => {
    registerNativeIpcRoute(ipcMain, contract, key, deps.isTrustedSender, handler);
  };

  register('window:minimize', () => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
    return { ok: true };
  });
  register('window:toggleMaximize', () => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    }
    return { ok: true };
  });
  register('window:close', () => {
    const mainWindow = deps.getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
    return { ok: true };
  });
  register('window:isMaximized', () => {
    const mainWindow = deps.getMainWindow();
    return { isMaximized: Boolean(mainWindow && !mainWindow.isDestroyed() && mainWindow.isMaximized()) };
  });

  register('shell:openPath', async ({ path: targetPath }) => {
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
  register('shell:openExportsDir', async () => {
    const exportsDir = resolve(join(deps.getUserDataPath(), 'exports'));
    mkdirSync(exportsDir, { recursive: true });
    const result = await shell.openPath(exportsDir);
    if (result) throw new Error(result);
    return { ok: true };
  });
  register('shell:openExternal', async ({ url }) => {
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
  register('dialog:pickCsv', async ({ title }) => {
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

  register('pdf:export', async ({ kind, id }) => documentExports.exportPdf({
    kind,
    id,
    suggestedName: `${kind}-${id}`,
    userDataPath: deps.getUserDataPath(),
  }));
  register('eur:exportPdf', async ({ taxYear, from, to }) => documentExports.exportEurPdf({
    taxYear,
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    userDataPath: deps.getUserDataPath(),
  }));

  register('db:backup', async () => {
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
  register('db:restore', async ({ path: archivePath }) => {
    const validatedArchivePath = validateNativeRestoreArchive(archivePath, deps.getUserDataPath());
    const result = await deps.restoreDataDir(validatedArchivePath);
    if ((result as { ok?: boolean }).ok) setTimeout(() => deps.relaunch(), 0);
    return result;
  });

  register('secrets:get', ({ key }) => deps.secrets.get(key));
  register('secrets:set', async ({ key, value }) => {
    await deps.secrets.set(key, value);
  });
  register('secrets:delete', ({ key }) => deps.secrets.delete(key));
  register('secrets:has', async ({ key }) => Boolean((await deps.secrets.get(key))?.length));

  register('updater:getStatus', () => deps.updater.getCurrentUpdateStatus());
  register('updater:downloadUpdate', async () => {
    await deps.updater.downloadUpdate();
    return { ok: true };
  });
  register('updater:quitAndInstall', () => {
    deps.updater.quitAndInstall();
    return { ok: true };
  });

  for (const [key, handler] of Object.entries(extensions)) register(key, handler);
};

export { isPathWithin, registerNativeIpcRoute };
