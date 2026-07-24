import { createSqliteConnection } from '@billme/desktop-data/connection';
import { bootstrapSql } from './bootstrap';
import { runMigrations } from './migrate';

const connection = createSqliteConnection({ bootstrapSql, runMigrations });
export const DEFAULT_DB_FILE_NAME = connection.defaultFileName;
export const { getDb, initDb, getDbPath, closeDb } = connection;
