import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { bootstrapSql } from './bootstrap';
import { runMigrations } from './migrate';

let db: Database.Database | null = null;
let dbPath: string | null = null;

export const getDb = (): Database.Database => {
  if (!db) {
    throw new Error('DB not initialized. Call initDb() first.');
  }
  return db;
};

export const initDb = (userDataPath: string): Database.Database => {
  if (db) return db;

  fs.mkdirSync(userDataPath, { recursive: true });
  dbPath = path.join(userDataPath, 'billme.sqlite');
  db = new Database(dbPath);
  db.exec(bootstrapSql);
  runMigrations(db);
  return db;
};

export const getDbPath = (): string => {
  if (!dbPath) {
    throw new Error('DB not initialized. Call initDb() first.');
  }
  return dbPath;
};

export const closeDb = (): void => {
  if (db) {
    db.close();
    db = null;
  }
};
