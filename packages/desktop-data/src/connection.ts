import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

export const createSqliteConnection = (options: {
  bootstrapSql: string;
  runMigrations: (db: Database.Database) => void;
  defaultFileName?: string;
}) => {
  let db: Database.Database | null = null;
  let dbPath: string | null = null;
  const defaultFileName = options.defaultFileName ?? 'billme.sqlite';

  return {
    defaultFileName,
    getDb: (): Database.Database => {
      if (!db) throw new Error('DB not initialized. Call initDb() first.');
      return db;
    },
    initDb: (userDataPath: string, initOptions: { dbFileName?: string } = {}): Database.Database => {
      if (db) return db;
      fs.mkdirSync(userDataPath, { recursive: true });
      dbPath = path.join(userDataPath, initOptions.dbFileName ?? defaultFileName);
      db = new Database(dbPath);
      db.exec(options.bootstrapSql);
      options.runMigrations(db);
      return db;
    },
    getDbPath: (): string => {
      if (!dbPath) throw new Error('DB not initialized. Call initDb() first.');
      return dbPath;
    },
    closeDb: (): void => {
      db?.close();
      db = null;
    },
  };
};
