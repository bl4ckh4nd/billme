import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';

export const ensureDir = (dirPath: string) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

export const backupSqlite = async (db: Database.Database, destPath: string) => {
  ensureDir(path.dirname(destPath));
  // better-sqlite3 has a built-in backup API that creates a consistent snapshot.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyDb = db as any;
  if (typeof anyDb.backup !== 'function') {
    throw new Error('SQLite driver does not support backup()');
  }
  await anyDb.backup(destPath);
};

