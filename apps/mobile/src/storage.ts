import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';

const DATABASE_KEY = 'billme.mobile.database-key.v1';
let databasePromise: Promise<SQLite.SQLiteDatabase> | null = null;

const bytesToHex = (bytes: Uint8Array): string => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

const openDatabase = async (): Promise<SQLite.SQLiteDatabase> => {
  const existingKey = await SecureStore.getItemAsync(DATABASE_KEY);
  const key = existingKey ?? bytesToHex(Crypto.getRandomBytes(32));
  if (!existingKey) await SecureStore.setItemAsync(DATABASE_KEY, key);
  const db = await SQLite.openDatabaseAsync('billme-mobile.db');
  await db.execAsync(`PRAGMA key = '${key}'; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);
  await db.execAsync(`
    CREATE TABLE IF NOT EXISTS cache (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
};

export const database = (): Promise<SQLite.SQLiteDatabase> => databasePromise ??= openDatabase();

export const cacheSet = async (key: string, value: unknown): Promise<void> => {
  const db = await database();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO cache (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    key, JSON.stringify(value), now,
  );
};

export const cacheGet = async <T>(key: string): Promise<T | null> => {
  const db = await database();
  const row = await db.getFirstAsync<{ value_json: string; updated_at: string }>('SELECT value_json, updated_at FROM cache WHERE key = ?', key);
  if (!row || Date.now() - new Date(row.updated_at).getTime() > 30 * 24 * 60 * 60_000) return null;
  return JSON.parse(row.value_json) as T;
};

export const saveDraft = async (id: string, kind: string, value: unknown): Promise<void> => {
  const db = await database();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO drafts (id, kind, value_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    id, kind, JSON.stringify(value), now,
  );
};

export const loadDraft = async <T>(id: string): Promise<T | null> => {
  const row = await (await database()).getFirstAsync<{ value_json: string }>('SELECT value_json FROM drafts WHERE id = ?', id);
  return row ? JSON.parse(row.value_json) as T : null;
};

export const loadLatestDraft = async <T>(kind: string): Promise<{ id: string; value: T } | null> => {
  const row = await (await database()).getFirstAsync<{ id: string; value_json: string }>(
    'SELECT id, value_json FROM drafts WHERE kind = ? ORDER BY updated_at DESC LIMIT 1',
    kind,
  );
  return row ? { id: row.id, value: JSON.parse(row.value_json) as T } : null;
};

export const removeDraft = async (id: string): Promise<void> => {
  await (await database()).runAsync('DELETE FROM drafts WHERE id = ?', id);
};

export type OutboxItem = {
  id: string;
  kind: 'receipt';
  payload: unknown;
  attemptCount: number;
  lastError?: string;
};

export const queueOutbox = async (id: string, kind: OutboxItem['kind'], payload: unknown): Promise<void> => {
  const db = await database();
  const now = new Date().toISOString();
  await db.runAsync(
    `INSERT INTO outbox (id, kind, payload_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
    id, kind, JSON.stringify(payload), now, now,
  );
};

export const listOutbox = async (): Promise<OutboxItem[]> => {
  const rows = await (await database()).getAllAsync<{
    id: string;
    kind: OutboxItem['kind'];
    payload_json: string;
    attempt_count: number;
    last_error: string | null;
  }>('SELECT id, kind, payload_json, attempt_count, last_error FROM outbox ORDER BY created_at ASC');
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json),
    attemptCount: row.attempt_count,
    lastError: row.last_error ?? undefined,
  }));
};

export const markOutboxFailure = async (id: string, error: string): Promise<void> => {
  await (await database()).runAsync(
    'UPDATE outbox SET attempt_count = attempt_count + 1, last_error = ?, updated_at = ? WHERE id = ?',
    error.slice(0, 500), new Date().toISOString(), id,
  );
};

export const removeOutbox = async (id: string): Promise<void> => {
  await (await database()).runAsync('DELETE FROM outbox WHERE id = ?', id);
};

export const outboxCount = async (): Promise<number> => {
  const row = await (await database()).getFirstAsync<{ count: number }>('SELECT COUNT(*) AS count FROM outbox');
  return row?.count ?? 0;
};

export const clearLocalWorkspace = async (): Promise<void> => {
  await (await database()).execAsync('DELETE FROM cache; DELETE FROM drafts; DELETE FROM outbox;');
};
