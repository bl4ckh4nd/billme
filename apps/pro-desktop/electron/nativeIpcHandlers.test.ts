import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { nativeElectronRouteKeys } from '../../../packages/desktop-services/src/serverRouteClassification';
import { ipcRoutes } from '@billme/desktop-contracts-pro/contract';
import { registerNativeIpcHandlers } from './nativeIpcHandlers';

vi.mock('electron', () => ({
  dialog: { showOpenDialog: vi.fn() },
  shell: { openPath: vi.fn(), openExternal: vi.fn() },
}));

vi.mock('./secrets', () => ({
  secrets: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('./updater', () => ({
  getCurrentUpdateStatus: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
}));

vi.mock('./pdfExport', () => ({
  exportPdf: vi.fn(),
  exportEurPdf: vi.fn(),
}));

describe('Pro native Electron IPC boundary', () => {
  it('does not import the legacy SQLite IPC module from the main entrypoint', () => {
    const mainSource = readFileSync(resolve(process.cwd(), 'electron/main.ts'), 'utf8');
    const nativeSource = readFileSync(resolve(process.cwd(), 'electron/nativeIpcHandlers.ts'), 'utf8');

    expect(mainSource).not.toContain("from './ipcHandlers'");
    expect(mainSource).not.toContain("from '../db/");
    expect(nativeSource).not.toMatch(/better-sqlite3|ipcHandlers|from ['"]\.\.\/db\//);
  });

  it('classifies the filesystem and print orchestration routes as native', () => {
    expect(nativeElectronRouteKeys()).toEqual(expect.arrayContaining([
      'pdf:export',
      'eur:exportPdf',
      'db:backup',
      'db:restore',
    ]));
  });

  it('registers exactly the classified native routes', () => {
    const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (_event: unknown, args: unknown) => unknown) => {
        handlers.set(channel, handler);
      }),
    };

    registerNativeIpcHandlers(ipcMain as never, {
      getUserDataPath: () => '/tmp/billme-native-test',
      getMainWindow: () => null,
      isTrustedSender: () => true,
    });

    expect([...handlers.keys()].sort()).toEqual(
      nativeElectronRouteKeys()
        .map((key) => (ipcRoutes as Record<string, { channel: string }>)[key].channel)
        .sort(),
    );
  });

  it('rejects an untrusted renderer before running a native handler', async () => {
    const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (_event: unknown, args: unknown) => unknown) => {
        handlers.set(channel, handler);
      }),
    };
    const getMainWindow = vi.fn(() => null);

    registerNativeIpcHandlers(ipcMain as never, {
      getUserDataPath: () => '/tmp/billme-native-test',
      getMainWindow,
      isTrustedSender: () => false,
    });

    await expect(
      handlers.get('window:minimize')?.({ sender: {} }, undefined),
    ).rejects.toThrow('Nicht vertrauenswürdiger WebContents-Sender.');
    expect(getMainWindow).not.toHaveBeenCalled();
  });

  it('keeps shell access inside app exports and allows only http(s) external URLs', async () => {
    const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (_event: unknown, args: unknown) => unknown) => {
        handlers.set(channel, handler);
      }),
    };

    registerNativeIpcHandlers(ipcMain as never, {
      getUserDataPath: () => '/tmp/billme-native-test',
      getMainWindow: () => null,
      isTrustedSender: () => true,
    });

    await expect(
      handlers.get('shell:openPath')?.({ sender: {} }, { path: '/tmp/outside.txt' }),
    ).rejects.toThrow('außerhalb der App-Datenordner');
    await expect(
      handlers.get('shell:openExternal')?.({ sender: {} }, { url: 'file:///tmp/outside.txt' }),
    ).rejects.toThrow('nur http(s)-Adressen erlaubt');
  });

  it('saves only an integrity-checked server artifact below the Pro export root', async () => {
    const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (_event: unknown, args: unknown) => unknown) => {
        handlers.set(channel, handler);
      }),
    };
    const tempDir = await mkdtemp(join('/tmp', 'billme-native-audit-export-'));
    const content = 'sequence,action\n1,invoice.created\n';
    const sha256 = createHash('sha256').update(content, 'utf8').digest('hex');
    try {
      registerNativeIpcHandlers(ipcMain as never, {
        getUserDataPath: () => tempDir,
        getMainWindow: () => null,
        isTrustedSender: () => true,
      });
      const result = await handlers.get('tax:saveAuditExportPackage')?.({ sender: {} }, {
        schemaVersion: 1,
        createdAt: '2026-08-22T12:00:00.000Z',
        from: null,
        to: null,
        includeDocuments: false,
        files: [{ name: 'audit-log.csv', content, sha256, sizeBytes: Buffer.byteLength(content), rowCount: 1 }],
      }) as { bundleDir: string; manifestPath: string; files: Array<{ path: string }> };
      expect(result.bundleDir).toContain(join(tempDir, 'exports', 'tax-audit-packages'));
      expect(await readFile(result.files[0]!.path, 'utf8')).toBe(content);
      expect(JSON.parse(await readFile(result.manifestPath, 'utf8')).fileCount).toBe(1);

      await expect(handlers.get('tax:saveAuditExportPackage')?.({ sender: {} }, {
        schemaVersion: 1,
        createdAt: '2026-08-22T12:00:00.000Z',
        from: null,
        to: null,
        includeDocuments: false,
        files: [{ name: '../outside.txt', content, sha256, sizeBytes: Buffer.byteLength(content) }],
      })).rejects.toThrow('Ungültiger Dateiname');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('exports through the print renderer and writes a PGlite dump without SQLite', async () => {
    const { exportPdf, exportEurPdf } = await import('./pdfExport');
    const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (_event: unknown, args: unknown) => unknown) => {
        handlers.set(channel, handler);
      }),
    };
    const tempDir = await mkdtemp(join('/tmp', 'billme-native-ipc-'));
    try {
      vi.mocked(exportPdf).mockResolvedValue({ path: join(tempDir, 'invoice.pdf'), bytes: new Uint8Array() });
      vi.mocked(exportEurPdf).mockResolvedValue({ path: join(tempDir, 'anlage-euer.pdf') });
      registerNativeIpcHandlers(ipcMain as never, {
        getUserDataPath: () => tempDir,
        getMainWindow: () => null,
        isTrustedSender: () => true,
        getBackupPrefix: () => 'billme-pro',
        dumpDataDir: async () => new Uint8Array([80, 71, 76, 73, 84, 69]),
      });

      await expect(handlers.get('pdf:export')?.({ sender: {} }, { kind: 'invoice', id: 'invoice-1' }))
        .resolves.toEqual({ path: join(tempDir, 'invoice.pdf') });
      await expect(handlers.get('eur:exportPdf')?.({ sender: {} }, { taxYear: 2025 }))
        .resolves.toEqual({ path: join(tempDir, 'anlage-euer.pdf') });
      const backup = await handlers.get('db:backup')?.({ sender: {} }, undefined) as { path: string };
      expect(backup.path).toMatch(/billme-pro-.*\.pglite\.tar$/);
      expect(await readFile(backup.path)).toEqual(Buffer.from('PGLITE'));
      expect(vi.mocked(exportPdf)).toHaveBeenCalledWith(expect.objectContaining({ kind: 'invoice', id: 'invoice-1' }));
      expect(vi.mocked(exportEurPdf)).toHaveBeenCalledWith(expect.objectContaining({ taxYear: 2025 }));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('validates restore paths, returns verification, and relaunches only after a successful restore', async () => {
    const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (_event: unknown, args: unknown) => unknown) => {
        handlers.set(channel, handler);
      }),
    };
    const tempDir = await mkdtemp(join('/tmp', 'billme-native-ipc-'));
    const backupsDir = join(tempDir, 'backups');
    await mkdir(backupsDir, { recursive: true });
    const archivePath = join(backupsDir, 'restore.pglite.tar');
    await writeFile(archivePath, 'not-used');
    const restoreDataDir = vi.fn(async (path: string) => ({
      ok: true as const,
      verification: { ok: true, errors: [], count: 2, headHash: 'head' },
      path,
    }));
    const relaunch = vi.fn();
    try {
      registerNativeIpcHandlers(ipcMain as never, {
        getUserDataPath: () => tempDir,
        getMainWindow: () => null,
        isTrustedSender: () => true,
        getBackupPrefix: () => 'billme-pro',
        dumpDataDir: async () => new Uint8Array(),
        restoreDataDir,
        relaunch,
      });
      await expect(handlers.get('db:restore')?.({ sender: {} }, { path: join(tempDir, 'outside.pglite.tar') }))
        .rejects.toThrow('außerhalb der App-Datenordner');
      expect(relaunch).not.toHaveBeenCalled();
      await expect(handlers.get('db:restore')?.({ sender: {} }, { path: archivePath }))
        .resolves.toEqual({ ok: true, verification: { ok: true, errors: [], count: 2, headHash: 'head' } });
      expect(restoreDataDir).toHaveBeenCalledWith(archivePath);
      expect(relaunch).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(relaunch).toHaveBeenCalledTimes(1);
      expect(await readFile(archivePath, 'utf8')).toBe('not-used');
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not leave a partial backup when PGlite dump fails', async () => {
    const handlers = new Map<string, (_event: unknown, args: unknown) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (_event: unknown, args: unknown) => unknown) => {
        handlers.set(channel, handler);
      }),
    };
    const tempDir = await mkdtemp(join('/tmp', 'billme-native-ipc-'));
    try {
      registerNativeIpcHandlers(ipcMain as never, {
        getUserDataPath: () => tempDir,
        getMainWindow: () => null,
        isTrustedSender: () => true,
        getBackupPrefix: () => 'billme-pro',
        dumpDataDir: async () => { throw new Error('dump failed'); },
      });
      await expect(handlers.get('db:backup')?.({ sender: {} }, undefined)).rejects.toThrow('dump failed');
      await expect(readdir(join(tempDir, 'backups'))).resolves.toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
