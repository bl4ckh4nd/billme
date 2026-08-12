import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { bootstrapSql } from './bootstrap';
import { runMigrations } from './migrate';
import {
  getAccountingHealth,
  getBilanzReport,
  getGuvReport,
  getLedgerBalances,
  getSusaReport,
} from './proAccountingRepo';
import { createProTenantScope } from '../tenantScope';

type Line = { account: string; debit?: number; credit?: number };

const canRunNativeSqlite = (() => {
  try {
    const probe = new Database(':memory:');
    probe.close();
    return true;
  } catch {
    return false;
  }
})();

const createDb = (): Database.Database => {
  const db = new Database(':memory:');
  db.exec(bootstrapSql);
  runMigrations(db);
  return db;
};

const insertEntry = (
  db: Database.Database,
  id: string,
  date: string,
  lines: Line[],
  tenantId = 'default',
  sourceType = 'manual',
): void => {
  db.prepare(`INSERT INTO journal_entries
    (id, tenant_id, entry_number, posting_date, document_date, booking_text, reference, period, fiscal_year, status, source_draft_id, source_type, source_key, reversed_entry_id, created_at)
    VALUES (?, ?, (SELECT COALESCE(MAX(entry_number), 0) + 1 FROM journal_entries WHERE tenant_id = ?), ?, ?, ?, NULL, ?, ?, 'posted', NULL, ?, ?, NULL, ?)`)
    .run(id, tenantId, tenantId, date, date, id, date.slice(0, 7), Number(date.slice(0, 4)), sourceType, id, `${date}T00:00:00.000Z`);
  const insertLine = db.prepare(`INSERT INTO journal_lines
    (id, tenant_id, entry_id, line_no, account_number, debit_amount, credit_amount)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  lines.forEach((line, index) => insertLine.run(`${id}-${index}`, tenantId, id, index + 1, line.account, line.debit ?? 0, line.credit ?? 0));
};

const seedGoldenJournal = (db: Database.Database): void => {
  insertEntry(db, 'opening', '2026-01-15', [
    { account: '1200', debit: 100 },
    { account: '9000', credit: 100 },
  ]);
  insertEntry(db, 'invoice', '2026-03-01', [
    { account: '1400', debit: 119 },
    { account: '8400', credit: 100 },
    { account: '1776', credit: 19 },
  ]);
  insertEntry(db, 'payment', '2026-03-10', [
    { account: '1200', debit: 119 },
    { account: '1400', credit: 119 },
  ], 'default', 'payment');
  insertEntry(db, 'expense', '2026-03-15', [
    { account: '4900', debit: 50 },
    { account: '1576', debit: 9.5 },
    { account: '1600', credit: 59.5 },
  ], 'default', 'incoming_invoice');
  insertEntry(db, 'reversal', '2026-03-20', [
    { account: '1400', credit: 119 },
    { account: '8400', debit: 100 },
    { account: '1776', debit: 19 },
  ], 'default', 'reversal');
  db.prepare("UPDATE journal_entries SET reversed_entry_id = 'invoice' WHERE id = 'reversal'").run();
  db.prepare("UPDATE journal_entries SET status = 'reversed', reversed_entry_id = 'reversal' WHERE id = 'invoice'").run();
};

describe.skipIf(!canRunNativeSqlite)('auditable Pro reports', () => {
  it('calculates cent-exact opening, period turnover, GuV and Bilanz from the golden journal', () => {
    const db = createDb();
    seedGoldenJournal(db);
    const scope = createProTenantScope('default');

    const balances = getLedgerBalances(db, { from: '2026-03-01', to: '2026-03-31' }, scope);
    expect(balances.find((row) => row.accountNumber === '1200')).toEqual({
      accountNumber: '1200', openingBalance: 100, debitTurnover: 119, creditTurnover: 0, closingBalance: 219,
    });
    expect(balances.find((row) => row.accountNumber === '8400')).toEqual({
      accountNumber: '8400', openingBalance: 0, debitTurnover: 100, creditTurnover: 100, closingBalance: 0,
    });
    expect(balances.find((row) => row.accountNumber === '1576')).toEqual({
      accountNumber: '1576', openingBalance: 0, debitTurnover: 9.5, creditTurnover: 0, closingBalance: 9.5,
    });

    const susa = getSusaReport(db, { from: '2026-03-01', to: '2026-03-31' }, scope);
    expect(susa.totals).toEqual({ debit: 416.5, credit: 416.5, balance: 0 });
    expect(susa.unmappedAccounts).toEqual([]);
    expect(susa.blocking).toBe(false);

    const guv = getGuvReport(db, { from: '2026-03-01', to: '2026-03-31' }, scope);
    expect(guv.rows).toEqual([{ positionKey: 'expense', positionLabel: 'Aufwendungen', amount: -50 }, { positionKey: 'revenue', positionLabel: 'Umsatzerlöse', amount: 0 }]);
    expect(guv.netResult).toBe(-50);
    expect(guv.unmappedAccounts).toEqual([]);

    const bilanz = getBilanzReport(db, { asOfDate: '2026-03-31' }, scope);
    expect(bilanz.assets).toEqual([
      { accountNumber: '1200', amount: 219 },
      { accountNumber: '1400', amount: -119 },
      { accountNumber: '1576', amount: 9.5 },
    ]);
    expect(bilanz.liabilities).toEqual([
      { accountNumber: '1600', amount: 59.5 },
      { accountNumber: '1776', amount: 0 },
      { accountNumber: '9000', amount: 100 },
    ]);
    expect(bilanz.totals).toEqual({ assets: 109.5, liabilities: 159.5, delta: -50 });
    expect(bilanz.unmappedAccounts).toEqual([]);

    const health = getAccountingHealth(db, scope);
    expect(health).toMatchObject({ unmappedAccountCount: 0, unmappedAccounts: [], blocking: false });
  });

  it('exposes unknown accounts and never matches a mapping from another chart or tenant', () => {
    const db = createDb();
    insertEntry(db, 'unknown', '2026-03-21', [
      { account: '9999', debit: 10 },
      { account: '1200', credit: 10 },
    ]);
    db.prepare(`INSERT INTO account_mappings_hgb
      (id, tenant_id, chart, account_number, statement_type, position_key, position_label, balance_side, updated_at)
      VALUES ('other-chart', 'default', 'SKR04', '9999', 'guv', 'revenue', 'Umsatz', NULL, '2026-03-21T00:00:00.000Z')`).run();
    const scope = createProTenantScope('default');

    const susa = getSusaReport(db, { asOfDate: '2026-03-31' }, scope);
    expect(susa.unmappedAccounts).toEqual([{ accountNumber: '9999', amount: 10 }]);
    expect(susa.blocking).toBe(true);
    expect(getGuvReport(db, { from: '2026-03-01', to: '2026-03-31' }, scope).unmappedAccounts)
      .toEqual([{ accountNumber: '9999', amount: -10 }]);
    expect(getBilanzReport(db, { asOfDate: '2026-03-31' }, scope).unmappedAccounts)
      .toEqual([{ accountNumber: '9999', amount: 10 }]);
    expect(getAccountingHealth(db, scope)).toMatchObject({
      unmappedAccountCount: 1,
      unmappedAccounts: ['9999'],
      blocking: true,
    });

    const otherTenant = createProTenantScope('tenant-b');
    insertEntry(db, 'tenant-b-entry', '2026-03-21', [{ account: '9998', debit: 2 }, { account: '1200', credit: 2 }], 'tenant-b');
    db.prepare(`INSERT INTO account_mappings_hgb
      (id, tenant_id, chart, account_number, statement_type, position_key, position_label, balance_side, updated_at)
      VALUES ('tenant-b-map', 'tenant-b', 'SKR03', '9998', 'guv', 'revenue', 'Umsatz', NULL, '2026-03-21T00:00:00.000Z')`).run();
    expect(getGuvReport(db, { from: '2026-03-01', to: '2026-03-31' }, otherTenant).unmappedAccounts).toEqual([]);
    expect(getGuvReport(db, { from: '2026-03-01', to: '2026-03-31' }, scope).unmappedAccounts).toEqual([{ accountNumber: '9999', amount: -10 }]);
  });
});
