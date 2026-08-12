import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { bootstrapSql } from './bootstrap';
import { runMigrations } from './migrate';
import {
  disposeAsset,
  getDepreciationSchedule,
  listAssets,
  runDepreciation,
  upsertAsset,
} from './assetsRepo';
import { createProTenantScope } from '../tenantScope';

const canRunNativeSqlite = (() => {
  try {
    const probe = new Database(':memory:');
    probe.close();
    return true;
  } catch {
    return false;
  }
})();

const tableNames = (db: Database.Database): string[] =>
  (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'asset%' ORDER BY name",
  ).all() as Array<{ name: string }>).map((row) => row.name);

describe.skipIf(!canRunNativeSqlite)('asset migrations and repository', () => {
  it('creates asset tables for fresh and pre-existing databases', () => {
    const fresh = new Database(':memory:');
    fresh.exec(bootstrapSql);
    runMigrations(fresh);
    expect(tableNames(fresh)).toEqual(['asset_depreciation_schedule', 'asset_movements', 'assets']);

    const existing = new Database(':memory:');
    existing.exec(bootstrapSql);
    existing.exec(
      `
        DROP TABLE asset_depreciation_schedule;
        DROP TABLE asset_movements;
        DROP TABLE assets;
        CREATE TABLE assets (
          id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default',
          asset_number TEXT NOT NULL, name TEXT NOT NULL, asset_class TEXT NOT NULL,
          status TEXT NOT NULL, activation_date TEXT NOT NULL, acquisition_cost REAL NOT NULL,
          useful_life_years INTEGER, depreciation_method TEXT NOT NULL,
          cost_center TEXT NOT NULL, location TEXT NOT NULL,
          receipt_linked INTEGER NOT NULL DEFAULT 0, supplier TEXT, invoice_ref TEXT,
          asset_account_number TEXT NOT NULL, disposal_date TEXT, disposal_proceeds REAL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE asset_depreciation_schedule (
          id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default',
          asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
          year INTEGER NOT NULL, amount REAL NOT NULL, months INTEGER NOT NULL,
          status TEXT NOT NULL, journal_entry_id TEXT, posted_at TEXT
        );
        CREATE TABLE asset_movements (
          id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL DEFAULT 'default',
          asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
          type TEXT NOT NULL, movement_date TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0,
          proceeds REAL, gain_loss REAL, reason TEXT NOT NULL, created_at TEXT NOT NULL
        );
        INSERT INTO assets (
          id, tenant_id, asset_number, name, asset_class, status, activation_date,
          acquisition_cost, useful_life_years, depreciation_method, cost_center, location,
          asset_account_number, created_at, updated_at
        ) VALUES ('legacy-asset', 'default', 'LEGACY-1', 'Legacy asset', 'IT-Hardware',
          'aktiv', '2025-01-01', 100, 3, 'linear', 'IT', 'Berlin', '0440',
          datetime('now'), datetime('now'));
        INSERT INTO asset_movements (
          id, tenant_id, asset_id, type, movement_date, amount, reason, created_at
        ) VALUES ('legacy-movement', 'default', 'legacy-asset', 'activation',
          '2025-01-01', 100, 'legacy import', datetime('now'));
      `,
    );
    runMigrations(existing);
    expect(
      existing.prepare('SELECT source_type, source_key, journal_entry_id FROM asset_movements WHERE id = ?').get('legacy-movement'),
    ).toEqual({ source_type: null, source_key: null, journal_entry_id: null });
    runMigrations(existing);
    expect(tableNames(existing)).toEqual(['asset_depreciation_schedule', 'asset_movements', 'assets']);
  });

  it('persists an asset and posts depreciation through the journal service', () => {
    const db = new Database(':memory:');
    db.exec(bootstrapSql);
    runMigrations(db);
    db.exec(`
      INSERT INTO ledger_accounts (id, chart, account_number, name, source, created_at, updated_at)
      VALUES
        ('asset-test-4830', 'SKR03', '4830', 'Abschreibungen', 'test', datetime('now'), datetime('now')),
        ('asset-test-0440', 'SKR03', '0440', 'Betriebsausstattung', 'test', datetime('now'), datetime('now')),
        ('asset-test-1600', 'SKR03', '1600', 'Kreditoren', 'test', datetime('now'), datetime('now'));
    `);
    const scope = createProTenantScope('default');
    const asset = upsertAsset(db, {
      assetNumber: 'ANL-2026-001',
      name: 'Notebook',
      assetClass: 'IT-Hardware',
      status: 'aktiv',
      activationDate: '2026-05-01',
      acquisitionCost: 1200,
      depreciationMethod: 'linear',
      costCenter: 'IT',
      location: 'Berlin',
      receiptLinked: true,
      assetAccountNumber: '0440',
    }, 'Test asset', scope);

    expect(getDepreciationSchedule(db, asset.id, scope)).toHaveLength(4);
    const result = runDepreciation(db, {
      assetId: asset.id,
      year: 2026,
      postingDate: '2026-12-31',
      reason: 'Annual AfA',
    }, scope);

    expect(result.journalEntryId).toBeTruthy();
    expect(result.scheduleEntry.status).toBe('posted');
    expect(listAssets(db, scope)[0].residualValue).toBe(933.33);
  });

  const setupDisposalDb = (): Database.Database => {
    const db = new Database(':memory:');
    db.exec(bootstrapSql);
    runMigrations(db);
    db.exec(`
      INSERT INTO ledger_accounts (id, chart, account_number, name, source, created_at, updated_at)
      VALUES
        ('dispose-0440', 'SKR03', '0440', 'Betriebsausstattung', 'test', datetime('now'), datetime('now')),
        ('dispose-1600', 'SKR03', '1600', 'Kreditoren', 'test', datetime('now'), datetime('now')),
        ('dispose-1200', 'SKR03', '1200', 'Bank', 'test', datetime('now'), datetime('now')),
        ('dispose-2310', 'SKR03', '2310', 'Anlagenabgang Verlust', 'test', datetime('now'), datetime('now')),
        ('dispose-8829', 'SKR03', '8829', 'Anlagenabgang Gewinn', 'test', datetime('now'), datetime('now')),
        ('dispose-4830', 'SKR03', '4830', 'Abschreibungen', 'test', datetime('now'), datetime('now'));
    `);
    return db;
  };

  const makeAsset = (db: Database.Database, id: string, usefulLifeYears?: number) =>
    upsertAsset(db, {
      id,
      assetNumber: id,
      name: 'Disposal test',
      assetClass: 'IT-Hardware',
      status: 'aktiv',
      activationDate: '2026-01-01',
      acquisitionCost: 1000,
      usefulLifeYears,
      depreciationMethod: 'linear',
      costCenter: 'IT',
      location: 'Berlin',
      receiptLinked: true,
      assetAccountNumber: '0440',
    }, 'Disposal test', createProTenantScope('default'));

  it('disposes against posted carrying amount without AfA or after full AfA', () => {
    const scope = createProTenantScope('default');
    const noAfaDb = setupDisposalDb();
    const noAfa = makeAsset(noAfaDb, 'dispose-no-afa', 1);
    const noAfaResult = disposeAsset(noAfaDb, {
      assetId: noAfa.id,
      disposalDate: '2026-06-30',
      proceeds: 100,
      taxRate: 0,
      proceedsAccountNumber: '1200',
      reason: 'No AfA disposal',
    }, scope);
    expect(noAfaResult.residualBookValue).toBe(1000);
    expect(noAfaResult.gainLoss).toBe(-900);
    const noAfaRetry = disposeAsset(noAfaDb, {
      assetId: noAfa.id,
      disposalDate: 'not-a-date',
      proceeds: 999,
      reason: 'Retry after lock',
    }, scope);
    expect(noAfaRetry).toMatchObject({ residualBookValue: 1000, gainLoss: -900, journalEntryId: noAfaResult.journalEntryId });
    const noAfaLines = noAfaDb.prepare(
      `SELECT account_number, debit_amount, credit_amount FROM journal_lines
       WHERE entry_id = (SELECT id FROM journal_entries WHERE source_type = 'asset_disposal' AND source_key = ?)`,
    ).all(`asset_disposal:${noAfa.id}`) as Array<{ account_number: string; debit_amount: number; credit_amount: number }>;
    expect(noAfaLines.find((line) => line.account_number === '0440')?.credit_amount).toBe(1000);
    expect(noAfaDb.prepare("SELECT COUNT(*) AS n FROM asset_depreciation_schedule WHERE asset_id = ? AND status = 'cancelled'").get(noAfa.id)).toEqual({ n: 1 });

    const fullAfaDb = setupDisposalDb();
    const fullAfa = makeAsset(fullAfaDb, 'dispose-full-afa', 1);
    runDepreciation(fullAfaDb, {
      assetId: fullAfa.id,
      year: 2026,
      postingDate: '2026-12-31',
      reason: 'Full AfA',
    }, scope);
    const fullResult = disposeAsset(fullAfaDb, {
      assetId: fullAfa.id,
      disposalDate: '2027-01-15',
      proceeds: 100,
      taxRate: 0,
      proceedsAccountNumber: '1200',
      reason: 'Full AfA disposal',
    }, scope);
    expect(fullResult.residualBookValue).toBe(0);
    expect(fullResult.gainLoss).toBe(100);
    const fullAfaLines = fullAfaDb.prepare(
      `SELECT account_number, debit_amount, credit_amount FROM journal_lines
       WHERE entry_id = (SELECT id FROM journal_entries WHERE source_type = 'asset_disposal' AND source_key = ?)`,
    ).all(`asset_disposal:${fullAfa.id}`) as Array<{ account_number: string; debit_amount: number; credit_amount: number }>;
    expect(fullAfaLines.filter((line) => line.account_number === '0440').reduce((sum, line) => sum + line.credit_amount, 0)).toBe(0);
    expect(fullAfaLines.find((line) => line.account_number === '8829')?.credit_amount).toBe(100);
  });

  it('rejects draft disposal and protects lifecycle fields while allowing notes', () => {
    const db = setupDisposalDb();
    const scope = createProTenantScope('default');
    const draft = upsertAsset(db, {
      id: 'draft-disposal',
      assetNumber: 'draft-disposal',
      name: 'Draft',
      assetClass: 'IT-Hardware',
      status: 'entwurf',
      activationDate: '2026-01-01',
      acquisitionCost: 1000,
      usefulLifeYears: 1,
      depreciationMethod: 'linear',
      costCenter: 'IT',
      location: 'Berlin',
      receiptLinked: false,
      assetAccountNumber: '0440',
    }, 'Draft', scope);
    expect(() => disposeAsset(db, {
      assetId: draft.id,
      disposalDate: '2026-06-30',
      proceeds: 0,
      reason: 'Draft disposal',
    }, scope)).toThrow('ASSET_NOT_ACTIVE');

    const asset = makeAsset(db, 'lifecycle-asset', 1);
    expect(() => db.prepare("UPDATE assets SET status = 'stillgelegt' WHERE id = ?").run(asset.id)).toThrow('accounting-affecting asset fields are immutable');
    db.prepare("UPDATE assets SET name = 'Renamed' WHERE id = ?").run(asset.id);
    disposeAsset(db, {
      assetId: asset.id,
      disposalDate: '2026-06-30',
      proceeds: 0,
      reason: 'Retirement',
    }, scope);
    expect(() => db.prepare("UPDATE assets SET disposal_proceeds = 1 WHERE id = ?").run(asset.id)).toThrow('accounting-affecting asset fields are immutable');
  });
});
