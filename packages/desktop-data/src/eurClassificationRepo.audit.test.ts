import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyAuditChain } from './audit';
import { getEurClassification, upsertEurClassification } from './eurClassificationRepo';

const databases: Database.Database[] = [];

const createDb = (): Database.Database => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE eur_classifications (
      id TEXT PRIMARY KEY,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      tax_year INTEGER NOT NULL,
      eur_line_id TEXT,
      excluded INTEGER NOT NULL,
      vat_mode TEXT NOT NULL,
      vat_rate REAL,
      note TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_eur_classifications_source_year
      ON eur_classifications(source_type, source_id, tax_year);
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sequence INTEGER NOT NULL UNIQUE,
      ts TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      action TEXT NOT NULL,
      reason TEXT,
      before_json TEXT,
      after_json TEXT,
      prev_hash TEXT,
      hash TEXT NOT NULL,
      actor TEXT NOT NULL
    );
  `);
  databases.push(db);
  return db;
};

const input = (reason: string) => ({
  sourceType: 'transaction' as const,
  sourceId: 'tx-1',
  taxYear: 2025,
  eurLineId: 'E2025_KZ280',
  vatMode: 'none' as const,
  reason,
  actor: 'lite',
  product: 'lite' as const,
});

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe('EÜR classification audit boundary', () => {
  it('persists before/after audit entries in the same hash chain', () => {
    const db = createDb();

    upsertEurClassification(db, input('Beleg geprüft'));
    upsertEurClassification(db, { ...input('Kontierung korrigiert'), excluded: true, eurLineId: undefined });

    const rows = db.prepare(`
      SELECT reason, actor, before_json AS beforeJson, after_json AS afterJson
      FROM audit_log
      WHERE entity_type = 'eur_classification'
      ORDER BY sequence
    `).all() as Array<{ reason: string; actor: string; beforeJson: string | null; afterJson: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ reason: 'Beleg geprüft', actor: 'lite' });
    expect(JSON.parse(rows[0]!.beforeJson!)).toBeNull();
    expect(JSON.parse(rows[0]!.afterJson)).toMatchObject({ eurLineId: 'E2025_KZ280', product: 'lite' });
    expect(JSON.parse(rows[1]!.beforeJson!)).toMatchObject({ eurLineId: 'E2025_KZ280' });
    expect(JSON.parse(rows[1]!.afterJson)).toMatchObject({ excluded: true, product: 'lite' });
    expect(verifyAuditChain(db)).toMatchObject({ ok: true, count: 2 });
    expect(getEurClassification(db, 'transaction', 'tx-1', 2025)?.excluded).toBe(true);
  });

  it('fails closed for blank reasons and rolls back when the audit append fails', () => {
    const db = createDb();

    expect(() => upsertEurClassification(db, input('   '))).toThrow('EUR_CLASSIFICATION_REASON_REQUIRED');
    expect(() => db.prepare('SELECT COUNT(*) AS count FROM eur_classifications').get()).not.toThrow();

    db.exec(`CREATE TRIGGER fail_eur_audit BEFORE INSERT ON audit_log
      BEGIN SELECT RAISE(ABORT, 'audit blocked'); END;`);
    expect(() => upsertEurClassification(db, input('Should roll back'))).toThrow('audit blocked');
    expect(db.prepare('SELECT COUNT(*) AS count FROM eur_classifications').get()).toEqual({ count: 0 });
  });
});
