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

type InvoiceColumn = { name: string; notnull: number; dflt_value: string | null };

const invoiceColumns = (db: Database.Database): Map<string, InvoiceColumn> =>
  new Map(
    (db.prepare('PRAGMA table_info(invoices)').all() as InvoiceColumn[]).map((column) => [column.name, column]),
  );

describe.skipIf(!canRunNativeSqlite)('Lite invoice accounting schema', () => {
  it('includes accounting persistence columns in a fresh bootstrap', () => {
    const db = new Database(':memory:');
    db.exec(bootstrapSql);

    const columns = invoiceColumns(db);
    expect(columns.get('accounting_status')).toMatchObject({ notnull: 1, dflt_value: "'unposted'" });
    expect(columns.has('accounting_snapshot_json')).toBe(true);
    expect(columns.has('accounting_journal_entry_id')).toBe(true);
    expect(columns.has('accounting_posted_at')).toBe(true);
    db.close();
  });

  it('adds accounting persistence columns to an existing Lite database', () => {
    const db = new Database(':memory:');
    db.exec(bootstrapSql);
    db.prepare(`
      INSERT INTO invoices (
        id, number, client, client_email, date, due_date, amount, status, created_at, updated_at
      ) VALUES ('legacy-invoice', 'RE-2026-001', 'Legacy GmbH', '', '2026-08-01', '2026-08-15', 0, 'draft', '2026-08-01', '2026-08-01')
    `).run();
    db.exec(`
      ALTER TABLE invoices DROP COLUMN accounting_status;
      ALTER TABLE invoices DROP COLUMN accounting_snapshot_json;
      ALTER TABLE invoices DROP COLUMN accounting_journal_entry_id;
      ALTER TABLE invoices DROP COLUMN accounting_posted_at;
    `);

    expect(invoiceColumns(db).has('accounting_status')).toBe(false);
    runMigrations(db);

    const columns = invoiceColumns(db);
    expect(columns.get('accounting_status')).toMatchObject({ notnull: 1, dflt_value: "'unposted'" });
    expect(columns.has('accounting_snapshot_json')).toBe(true);
    expect(columns.has('accounting_journal_entry_id')).toBe(true);
    expect(columns.has('accounting_posted_at')).toBe(true);
    expect(db.prepare("SELECT accounting_status FROM invoices WHERE id = 'legacy-invoice'").get()).toEqual({
      accounting_status: 'unposted',
    });
    db.close();
  });
});
