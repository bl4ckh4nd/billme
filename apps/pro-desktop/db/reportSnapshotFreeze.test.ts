import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { bootstrapSql } from './bootstrap';
import {
  getReportSnapshot,
  saveReportSnapshot,
} from './proAccountingRepo';
import { createProTenantScope } from '../tenantScope';

const createDb = (): Database.Database => {
  const db = new Database(':memory:');
  db.exec(bootstrapSql);
  return db;
};

const validEur = {
  lines: [],
  totals: { revenue: 10, expenses: 2, result: 8 },
  quality: { unmappedAccounts: [], warnings: 0, generatedAt: '2025-12-31T23:00:00.000Z', source: 'live' as const },
  filing: {
    kind: 'euer' as const,
    taxYear: 2025,
    catalog: { id: 'anlage-euer-2025', version: 'BMF-2025-2025-08-29', sourceHash: 'b'.repeat(64), delivery: 'print-form-only' as const, elsterReady: false },
    lineProvenance: [{ lineId: 'E2025_KZ111', kennziffer: '111', providerPath: 'income', exportable: true }],
  },
};

describe('Pro report snapshot filing boundary', () => {
  it('stores a stable source hash and rejects direct mutation or deletion', () => {
    const db = createDb();
    const scope = createProTenantScope('default');
    const saved = saveReportSnapshot(db, {
      reportType: 'eur',
      args: { periodFrom: '2025-01', periodTo: '2025-12' },
      payload: validEur,
      reason: 'EÜR Abschlussprüfung',
      id: 'snapshot-eur-2025',
    }, scope);

    expect(saved.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(getReportSnapshot(db, saved.id, scope)?.sourceHash).toBe(saved.sourceHash);
    expect(db.prepare('SELECT source_hash FROM report_snapshots WHERE id = ?').get(saved.id)).toEqual({ source_hash: saved.sourceHash });
    expect(() => db.prepare('UPDATE report_snapshots SET payload_json = ? WHERE id = ?').run('{}', saved.id)).toThrow(/immutable/);
    expect(() => db.prepare('DELETE FROM report_snapshots WHERE id = ?').run(saved.id)).toThrow(/immutable/);
  });

  it.each([
    ['blocked mapping', { ...validEur, quality: { ...validEur.quality, mappingStatus: 'blocked' } }],
    ['unclassified entries', { ...validEur, quality: { ...validEur.quality, warnings: 1 } }],
  ])('fails closed for %s', (_label, payload) => {
    const db = createDb();
    expect(() => saveReportSnapshot(db, {
      reportType: 'eur',
      args: { periodFrom: '2025-01', periodTo: '2025-12' },
      payload,
      reason: 'EÜR Abschlussprüfung',
    }, createProTenantScope('default'))).toThrow('REPORT_SNAPSHOT_BLOCKED_INCOMPLETE_MAPPING');
  });
});
