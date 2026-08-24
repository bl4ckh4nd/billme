import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { getCatalogForYear } from '@billme/desktop-services/eurCatalog';
import { getEurAnnexCatalog } from '@billme/desktop-services/eur/annexCatalog';
import { ensureEurFactsSchema, listEurAnnexFacts, listEurCashFacts, saveEurAnnexFact, saveEurCashFact } from './eurFacts';

const dbForFacts = (): Database.Database => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sequence INTEGER NOT NULL UNIQUE, ts TEXT NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    action TEXT NOT NULL, reason TEXT, before_json TEXT, after_json TEXT, prev_hash TEXT, hash TEXT NOT NULL, actor TEXT NOT NULL
  );
  CREATE TABLE report_snapshots (
    id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL DEFAULT 'default',
    report_type TEXT NOT NULL,
    args_json TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    source_hash TEXT,
    created_at TEXT NOT NULL
  )`);
  ensureEurFactsSchema(db);
  return db;
};

describe('EÜR runtime facts', () => {
  it('persists tenant/year-scoped 2026 private and split facts idempotently', () => {
    const db = dbForFacts();
    const expense = getCatalogForYear(2026).find((line) => line.kind === 'expense')!;
    const input = {
      tenantId: 'tenant-a', sourceType: 'transaction' as const, sourceId: 'tx-1', taxYear: 2026, kind: 'expense' as const, flowType: 'expense' as const,
      amountNet: 100, splits: [{ amountNet: 60, deductibility: 'deductible' as const, lineId: expense.id, reason: 'Betrieblich' }, { amountNet: 40, deductibility: 'non-deductible' as const, reason: 'Privatanteil' }], reason: 'Beleg geprüft', actor: { id: 'user-a' }, idempotencyKey: 'fact-1',
    };
    const saved = saveEurCashFact(db, input);
    expect(listEurCashFacts(db, 2026, 'tenant-a')).toHaveLength(1);
    expect(saved.provenance.catalogId).toBe('anlage-euer-2026');
    expect(saveEurCashFact(db, input).id).toBe(saved.id);
    expect(listEurCashFacts(db, 2026, 'tenant-b')).toEqual([]);
    expect(() => saveEurCashFact(db, {
      ...input,
      idempotencyKey: 'fact-1',
      amountNet: 101,
      splits: [
        { amountNet: 61, deductibility: 'deductible' as const, lineId: expense.id, reason: 'Betrieblich' },
        { amountNet: 40, deductibility: 'non-deductible' as const, reason: 'Privatanteil' },
      ],
    })).toThrow('EUR_FACT_IDEMPOTENCY_CONFLICT');
    expect(() => saveEurCashFact(db, { ...input, idempotencyKey: 'fact-2', splits: [{ amountNet: 99, lineId: expense.id, reason: 'Zu kurz' }] })).toThrow('EUR_SPLIT_ALLOCATION_MISMATCH');
  });

  it('stores annex facts and rejects computed rows', () => {
    const db = dbForFacts();
    const catalog = getEurAnnexCatalog(2026, 'AVEÜR');
    const inputLine = catalog.lines.find((line) => line.kind === 'input')!;
    const computed = catalog.lines.find((line) => line.kind === 'computed' && (line.computedFromIds?.length || line.computedTerms?.length))!;
    const saved = saveEurAnnexFact(db, { tenantId: 'tenant-a', taxYear: 2026, annex: 'AVEÜR', lineId: inputLine.id, amount: 100, date: '2026-12-31', reason: 'Anlage geprüft', actor: 'user-a', idempotencyKey: 'annex-1' });
    expect(saved.provenance.catalogVersion).toContain('2026');
    expect(listEurAnnexFacts(db, 2026, 'AVEÜR', 'tenant-a')).toHaveLength(1);
    expect(() => saveEurAnnexFact(db, { tenantId: 'tenant-a', taxYear: 2026, annex: 'AVEÜR', lineId: computed.id, amount: 1, reason: 'Falsch', actor: 'user-a' })).toThrow('EUR_COMPUTED_LINE_NOT_CLASSIFIABLE');
  });
});
