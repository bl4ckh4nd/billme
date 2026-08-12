import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { bootstrapSql } from './bootstrap';
import { runMigrations } from './migrate';

const canRunNativeSqlite = (() => {
  try {
    const db = new Database(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
})();

const removeLineMetaFromLegacyTables = (db: Database.Database) => db.exec(`
  DROP TABLE invoice_items;
  DROP TABLE offer_items;
  CREATE TABLE invoice_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, description TEXT NOT NULL, article_id TEXT, category TEXT, unit TEXT,
    discount_percent REAL, tax_rate REAL, quantity REAL NOT NULL, price REAL NOT NULL, total REAL NOT NULL
  );
  CREATE TABLE offer_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, offer_id TEXT NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
    position INTEGER NOT NULL, description TEXT NOT NULL, article_id TEXT, category TEXT, unit TEXT,
    discount_percent REAL, tax_rate REAL, quantity REAL NOT NULL, price REAL NOT NULL, total REAL NOT NULL
  );
`);

describe.skipIf(!canRunNativeSqlite)('Pro SQLite line metadata migration', () => {
  it('adds line_meta_json to existing invoice and offer item tables', () => {
    const db = new Database(':memory:');
    db.exec(bootstrapSql);
    removeLineMetaFromLegacyTables(db);
    expect((db.prepare('PRAGMA table_info(invoice_items)').all() as Array<{ name: string }>).some(({ name }) => name === 'line_meta_json')).toBe(false);
    runMigrations(db);
    expect((db.prepare('PRAGMA table_info(invoice_items)').all() as Array<{ name: string }>).some(({ name }) => name === 'line_meta_json')).toBe(true);
    expect((db.prepare('PRAGMA table_info(offer_items)').all() as Array<{ name: string }>).some(({ name }) => name === 'line_meta_json')).toBe(true);
    db.close();
  });
});
