import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { bootstrapSql } from './bootstrap';
import { runMigrations } from './migrate';
import {
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
      'DROP TABLE asset_depreciation_schedule; DROP TABLE asset_movements; DROP TABLE assets;',
    );
    runMigrations(existing);
    expect(tableNames(existing)).toEqual(['asset_depreciation_schedule', 'asset_movements', 'assets']);
  });

  it('persists an asset and posts depreciation through the journal service', () => {
    const db = new Database(':memory:');
    db.exec(bootstrapSql);
    runMigrations(db);
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
});
