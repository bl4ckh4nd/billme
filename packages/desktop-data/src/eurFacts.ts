import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { getCatalogForYear, getCatalogManifestForYear } from '@billme/desktop-services/eurCatalog';
import { getEurAnnexCatalog, type EurAnnexId } from '@billme/desktop-services/eur/annexCatalog';
import type { EurExpenseSplit } from '@billme/accounting-shared';
import type { TenantScope } from '@billme/server-core';
import { appendAuditLog } from './audit';

export type EurCashFactKind = 'income' | 'expense' | 'private-withdrawal' | 'private-contribution' | 'pass-through';
export type EurFactSourceType = 'transaction' | 'invoice';
export type EurFactActor = string | { id: string; displayName?: string };

export interface EurCashFact {
  id: string;
  tenantId: string;
  sourceType: EurFactSourceType;
  sourceId: string;
  taxYear: number;
  kind: EurCashFactKind;
  amountNet: number;
  flowType?: 'income' | 'expense';
  eurLineId?: string;
  splits?: EurExpenseSplit[];
  reason: string;
  actorId: string;
  actorName?: string;
  idempotencyKey?: string;
  provenance: EurFactProvenance;
  createdAt: string;
  updatedAt: string;
}

export interface EurAnnexFact {
  id: string;
  tenantId: string;
  taxYear: number;
  annex: string;
  lineId: string;
  amount: number;
  sourceId?: string;
  date?: string;
  reason: string;
  actorId: string;
  actorName?: string;
  idempotencyKey?: string;
  provenance: EurFactProvenance;
  createdAt: string;
}

export interface EurFactProvenance {
  catalogId: string;
  catalogVersion: string;
  catalogSourceHash: string;
  sourceSnapshotHash?: string;
}

const cents = (value: number): number => Math.round((value + Number.EPSILON) * 100);
const amount = (value: number): number => cents(value) / 100;
const actorFields = (actor: EurFactActor): { id: string; name?: string } => {
  if (typeof actor === 'string') return { id: actor.trim() };
  return { id: actor.id.trim(), name: actor.displayName?.trim() || undefined };
};

/** Runtime-safe additive schema for old SQLite databases. */
export const ensureEurFactsSchema = (db: Database.Database): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS eur_cash_facts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      tax_year INTEGER NOT NULL,
      kind TEXT NOT NULL,
      amount_net REAL NOT NULL,
      flow_type TEXT,
      eur_line_id TEXT,
      splits_json TEXT,
      reason TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_name TEXT,
      idempotency_key TEXT,
      provenance_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (tenant_id, source_type, source_id, tax_year)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_eur_cash_facts_idempotency
      ON eur_cash_facts (tenant_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS eur_annex_facts (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      tax_year INTEGER NOT NULL,
      annex TEXT NOT NULL,
      line_id TEXT NOT NULL,
      amount REAL NOT NULL,
      source_id TEXT,
      fact_date TEXT,
      reason TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_name TEXT,
      idempotency_key TEXT,
      provenance_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_eur_annex_facts_idempotency
      ON eur_annex_facts (tenant_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_eur_annex_facts_year
      ON eur_annex_facts (tenant_id, tax_year, annex);
    CREATE TABLE IF NOT EXISTS report_snapshots (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      report_type TEXT NOT NULL,
      args_json TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      source_hash TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_report_snapshots_tenant_type
      ON report_snapshots (tenant_id, report_type, created_at);
    CREATE TRIGGER IF NOT EXISTS eur_report_snapshots_eur_no_update
      BEFORE UPDATE ON report_snapshots
      WHEN OLD.report_type = 'eur'
      BEGIN
        SELECT RAISE(ABORT, 'EÜR report snapshots are immutable');
      END;
    CREATE TRIGGER IF NOT EXISTS eur_report_snapshots_eur_no_delete
      BEFORE DELETE ON report_snapshots
      WHEN OLD.report_type = 'eur'
      BEGIN
        SELECT RAISE(ABORT, 'EÜR report snapshots are immutable');
      END;
  `);
};

const provenanceFor = (year: number, sourceSnapshotHash?: string): EurFactProvenance => {
  const catalog = getCatalogManifestForYear(year);
  return { catalogId: catalog.id, catalogVersion: catalog.version, catalogSourceHash: catalog.sha256, sourceSnapshotHash };
};

const parseJson = <T>(value: string | null | undefined, fallback: T): T => {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
};

const readCashFact = (row: Record<string, unknown>): EurCashFact => ({
  id: String(row.id), tenantId: String(row.tenant_id), sourceType: row.source_type as EurFactSourceType, sourceId: String(row.source_id), taxYear: Number(row.tax_year),
  kind: row.kind as EurCashFactKind, amountNet: Number(row.amount_net), flowType: row.flow_type ? row.flow_type as 'income' | 'expense' : undefined,
  eurLineId: row.eur_line_id ? String(row.eur_line_id) : undefined, splits: row.splits_json ? parseJson<EurExpenseSplit[]>(String(row.splits_json), []) : undefined,
  reason: String(row.reason), actorId: String(row.actor_id), actorName: row.actor_name ? String(row.actor_name) : undefined,
  idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined, provenance: parseJson(String(row.provenance_json), {} as EurFactProvenance),
  createdAt: String(row.created_at), updatedAt: String(row.updated_at),
});

const readAnnexFact = (row: Record<string, unknown>): EurAnnexFact => ({
  id: String(row.id), tenantId: String(row.tenant_id), taxYear: Number(row.tax_year), annex: String(row.annex), lineId: String(row.line_id), amount: Number(row.amount),
  sourceId: row.source_id ? String(row.source_id) : undefined, date: row.fact_date ? String(row.fact_date) : undefined, reason: String(row.reason), actorId: String(row.actor_id), actorName: row.actor_name ? String(row.actor_name) : undefined,
  idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined, provenance: parseJson(String(row.provenance_json), {} as EurFactProvenance), createdAt: String(row.created_at),
});

const assertReasonActor = (reason: string, actor: EurFactActor): { reason: string; actor: { id: string; name?: string } } => {
  const normalizedReason = reason.trim();
  if (!normalizedReason) throw new Error('EUR_FACT_REASON_REQUIRED');
  const normalizedActor = actorFields(actor);
  if (!normalizedActor.id) throw new Error('EUR_FACT_ACTOR_REQUIRED');
  return { reason: normalizedReason, actor: normalizedActor };
};

const assertCashFact = (db: Database.Database, input: SaveEurCashFactInput): void => {
  getCatalogForYear(input.taxYear);
  if (!input.sourceId.trim()) throw new Error('EUR_FACT_SOURCE_REQUIRED');
  if (!Number.isFinite(input.amountNet) || input.amountNet < 0) throw new Error('EUR_FACT_AMOUNT_INVALID');
  if (input.kind === 'private-withdrawal' || input.kind === 'private-contribution' || input.kind === 'pass-through') {
    if (input.eurLineId || input.splits?.length) throw new Error('EUR_NEUTRAL_FACT_MUST_NOT_HAVE_LINE');
    return;
  }
  if (input.kind === 'income' && input.flowType !== 'income') throw new Error('EUR_FACT_FLOW_MISMATCH');
  if (input.kind === 'expense' && input.flowType !== 'expense') throw new Error('EUR_FACT_FLOW_MISMATCH');
  const lines = new Map(getCatalogForYear(input.taxYear).map((line) => [line.id, line]));
  if (input.eurLineId) {
    const line = lines.get(input.eurLineId);
    if (!line) throw new Error('EUR_LINE_NOT_FOUND');
    if (line.kind === 'computed') throw new Error('EUR_COMPUTED_LINE_NOT_CLASSIFIABLE');
    if (line.kind !== input.flowType) throw new Error('EUR_LINE_FLOW_MISMATCH');
  }
  if (!input.splits?.length) return;
  if (input.kind !== 'expense') throw new Error('EUR_SPLITS_EXPENSE_ONLY');
  const splitTotal = input.splits.reduce((sum, split) => {
    if (!Number.isFinite(split.amountNet) || split.amountNet < 0) throw new Error('EUR_SPLIT_AMOUNT_INVALID');
    if (!split.reason?.trim()) throw new Error('EUR_SPLIT_REASON_REQUIRED');
    const deductible = split.deductibility ?? split.classification ?? (split.deductible === false ? 'non-deductible' : 'deductible');
    if (deductible === 'deductible') {
      const line = split.lineId ? lines.get(split.lineId) : undefined;
      if (!line) throw new Error('EUR_SPLIT_LINE_NOT_FOUND');
      if (line.kind !== 'expense') throw new Error('EUR_SPLIT_LINE_FLOW_MISMATCH');
    }
    return sum + cents(split.amountNet);
  }, 0);
  if (splitTotal !== cents(input.amountNet)) throw new Error('EUR_SPLIT_ALLOCATION_MISMATCH');
  // Keep the argument explicit so callers cannot accidentally pass a second DB
  // implementation with a different ownership model.
  void db;
};

export interface SaveEurCashFactInput {
  tenantId?: string;
  sourceType: EurFactSourceType;
  sourceId: string;
  taxYear: number;
  kind: EurCashFactKind;
  amountNet: number;
  flowType?: 'income' | 'expense';
  eurLineId?: string;
  splits?: EurExpenseSplit[];
  reason: string;
  actor: EurFactActor;
  idempotencyKey?: string;
  sourceSnapshotHash?: string;
}

export const saveEurCashFact = (db: Database.Database, input: SaveEurCashFactInput): EurCashFact => {
  ensureEurFactsSchema(db);
  const { reason, actor } = assertReasonActor(input.reason, input.actor);
  assertCashFact(db, input);
  const tenantId = input.tenantId?.trim() || 'default';
  const idempotent = input.idempotencyKey
    ? db.prepare('SELECT * FROM eur_cash_facts WHERE tenant_id=? AND idempotency_key=?').get(tenantId, input.idempotencyKey) as Record<string, unknown> | undefined
    : undefined;
  if (idempotent) {
    const saved = readCashFact(idempotent);
    if (saved.sourceType === input.sourceType && saved.sourceId === input.sourceId && saved.taxYear === input.taxYear && saved.amountNet === amount(input.amountNet) && saved.kind === input.kind && JSON.stringify(saved.splits ?? []) === JSON.stringify(input.splits ?? [])) return saved;
    throw new Error('EUR_FACT_IDEMPOTENCY_CONFLICT');
  }
  const existing = db.prepare('SELECT * FROM eur_cash_facts WHERE tenant_id=? AND source_type=? AND source_id=? AND tax_year=?').get(tenantId, input.sourceType, input.sourceId, input.taxYear) as Record<string, unknown> | undefined;
  if (existing && input.idempotencyKey && existing.idempotency_key === input.idempotencyKey) {
    const saved = readCashFact(existing);
    if (saved.amountNet === amount(input.amountNet) && saved.kind === input.kind && JSON.stringify(saved.splits ?? []) === JSON.stringify(input.splits ?? [])) return saved;
    throw new Error('EUR_FACT_IDEMPOTENCY_CONFLICT');
  }
  const now = new Date().toISOString();
  const id = existing ? String(existing.id) : randomUUID();
  const provenance = provenanceFor(input.taxYear, input.sourceSnapshotHash);
  const run = db.transaction(() => {
    db.prepare(`INSERT INTO eur_cash_facts
      (id,tenant_id,source_type,source_id,tax_year,kind,amount_net,flow_type,eur_line_id,splits_json,reason,actor_id,actor_name,idempotency_key,provenance_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(tenant_id,source_type,source_id,tax_year) DO UPDATE SET
        kind=excluded.kind,amount_net=excluded.amount_net,flow_type=excluded.flow_type,eur_line_id=excluded.eur_line_id,splits_json=excluded.splits_json,
        reason=excluded.reason,actor_id=excluded.actor_id,actor_name=excluded.actor_name,idempotency_key=excluded.idempotency_key,provenance_json=excluded.provenance_json,updated_at=excluded.updated_at`).run(
      id, tenantId, input.sourceType, input.sourceId, input.taxYear, input.kind, amount(input.amountNet), input.flowType ?? null, input.eurLineId ?? null, input.splits?.length ? JSON.stringify(input.splits) : null,
      reason, actor.id, actor.name ?? null, input.idempotencyKey ?? null, JSON.stringify(provenance), existing ? String(existing.created_at) : now, now,
    );
    const row = db.prepare('SELECT * FROM eur_cash_facts WHERE id=?').get(id) as Record<string, unknown>;
    const saved = readCashFact(row);
    appendAuditLog(db, { entityType: 'eur_cash_fact', entityId: `${tenantId}:${input.sourceType}:${input.sourceId}:${input.taxYear}`, action: existing ? 'update' : 'create', reason, before: existing ? readCashFact(existing) : null, after: saved, actor: actor.id, ts: now });
    return saved;
  });
  return run();
};

export const listEurCashFacts = (db: Database.Database, taxYear: number, tenantId = 'default'): EurCashFact[] => {
  ensureEurFactsSchema(db);
  return (db.prepare('SELECT * FROM eur_cash_facts WHERE tenant_id=? AND tax_year=? ORDER BY source_type,source_id').all(tenantId, taxYear) as Array<Record<string, unknown>>).map(readCashFact);
};

export interface SaveEurAnnexFactInput {
  tenantId?: string;
  taxYear: number;
  annex: string;
  lineId: string;
  amount: number;
  sourceId?: string;
  date?: string;
  reason: string;
  actor: EurFactActor;
  idempotencyKey?: string;
  sourceSnapshotHash?: string;
}

export const saveEurAnnexFact = (db: Database.Database, input: SaveEurAnnexFactInput): EurAnnexFact => {
  ensureEurFactsSchema(db);
  const { reason, actor } = assertReasonActor(input.reason, input.actor);
  getCatalogForYear(input.taxYear);
  const annex = input.annex.trim();
  if (!annex || !input.lineId.trim()) throw new Error('EUR_ANNEX_FACT_LINE_REQUIRED');
  if (annex === 'AVEÜR' || annex === 'SZ') {
    const catalog = getEurAnnexCatalog(input.taxYear, annex as EurAnnexId);
    const line = catalog.lines.find((candidate) => candidate.id === input.lineId);
    if (!line) throw new Error('EUR_ANNEX_LINE_NOT_FOUND');
    if (line.kind === 'computed' && (line.computedFromIds?.length || line.computedTerms?.length)) throw new Error('EUR_COMPUTED_LINE_NOT_CLASSIFIABLE');
  }
  if (!Number.isFinite(input.amount)) throw new Error('EUR_ANNEX_AMOUNT_INVALID');
  if (input.date && (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !input.date.startsWith(`${input.taxYear}-`))) throw new Error('EUR_ANNEX_DATE_INVALID');
  const tenantId = input.tenantId?.trim() || 'default';
  if (input.idempotencyKey) {
    const existing = db.prepare('SELECT * FROM eur_annex_facts WHERE tenant_id=? AND idempotency_key=?').get(tenantId, input.idempotencyKey) as Record<string, unknown> | undefined;
    if (existing) {
      const saved = readAnnexFact(existing);
      if (saved.lineId === input.lineId && saved.amount === amount(input.amount) && saved.annex === annex) return saved;
      throw new Error('EUR_FACT_IDEMPOTENCY_CONFLICT');
    }
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  const provenance = provenanceFor(input.taxYear, input.sourceSnapshotHash);
  const row = db.transaction(() => {
    db.prepare(`INSERT INTO eur_annex_facts
      (id,tenant_id,tax_year,annex,line_id,amount,source_id,fact_date,reason,actor_id,actor_name,idempotency_key,provenance_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, tenantId, input.taxYear, annex, input.lineId, amount(input.amount), input.sourceId ?? null, input.date ?? null, reason, actor.id, actor.name ?? null, input.idempotencyKey ?? null, JSON.stringify(provenance), now);
    const saved = readAnnexFact(db.prepare('SELECT * FROM eur_annex_facts WHERE id=?').get(id) as Record<string, unknown>);
    appendAuditLog(db, { entityType: 'eur_annex_fact', entityId: id, action: 'create', reason, before: null, after: saved, actor: actor.id, ts: now });
    return saved;
  });
  return row();
};

export const listEurAnnexFacts = (db: Database.Database, taxYear: number, annex?: string, tenantId = 'default'): EurAnnexFact[] => {
  ensureEurFactsSchema(db);
  const rows = annex
    ? db.prepare('SELECT * FROM eur_annex_facts WHERE tenant_id=? AND tax_year=? AND annex=? ORDER BY created_at,id').all(tenantId, taxYear, annex)
    : db.prepare('SELECT * FROM eur_annex_facts WHERE tenant_id=? AND tax_year=? ORDER BY created_at,id').all(tenantId, taxYear);
  return (rows as Array<Record<string, unknown>>).map(readAnnexFact);
};

export const freezeEurReportSnapshot = (
  db: Database.Database,
  scope: TenantScope,
  report: { taxYear: number; from: string; to: string; rows: Array<{ lineId: string; kennziffer?: string; providerPath?: string; exportable: boolean }>; warnings: string[]; unclassifiedCount: number; catalog: { id: string; version: string; sourceHash: string; delivery: 'print-form-only' | 'elster-ready'; elsterReady: boolean } },
  reason: string,
  actor: EurFactActor,
) => {
  const { reason: normalizedReason, actor: normalizedActor } = assertReasonActor(reason, actor);
  if (report.from !== `${report.taxYear}-01-01` || report.to !== `${report.taxYear}-12-31`) throw new Error('EUR_SNAPSHOT_FULL_YEAR_REQUIRED');
  if (report.warnings.length || report.unclassifiedCount) throw new Error('EUR_SNAPSHOT_INCOMPLETE');
  const payload = {
    ...report,
    filing: {
      kind: 'euer', taxYear: report.taxYear, catalog: report.catalog,
      lineProvenance: report.rows.map((row) => ({ lineId: row.lineId, kennziffer: row.kennziffer ?? '', providerPath: row.providerPath ?? 'main', exportable: row.exportable })),
    },
  };
  const args = { taxYear: report.taxYear, from: report.from, to: report.to };
  const sourceHash = hashValue({ reportType: 'eur', args, payload });
  const existing = db.prepare('SELECT id,report_type,args_json,payload_json,source_hash,created_at FROM report_snapshots WHERE tenant_id=? AND report_type=? AND source_hash=? LIMIT 1').get(scope.tenantId, 'eur', sourceHash) as Record<string, unknown> | undefined;
  if (existing) {
    return {
      id: String(existing.id),
      reportType: 'eur',
      args: parseJsonValue(existing.args_json),
      payload: parseJsonValue(existing.payload_json),
      sourceHash: String(existing.source_hash),
      createdAt: String(existing.created_at),
    };
  }
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  db.prepare(`INSERT INTO report_snapshots (id,tenant_id,report_type,args_json,payload_json,source_hash,created_at) VALUES (?,?,?,?,?,?,?)`).run(id, scope.tenantId, 'eur', JSON.stringify(args), JSON.stringify(payload), sourceHash, createdAt);
  appendAuditLog(db, { entityType: 'report_snapshot', entityId: id, action: 'freeze', reason: normalizedReason, before: null, after: { id, reportType: 'eur', args, payload, sourceHash }, actor: normalizedActor.id, ts: createdAt });
  return { id, reportType: 'eur', args, payload, sourceHash, createdAt };
};

const hashValue = (value: unknown): string => {
  const text = JSON.stringify(value, Object.keys(value as object).sort());
  // Provenance hashes only need deterministic content addressing here; the
  // server uses the same SHA-256 contract for persisted snapshots.
  return createHash('sha256').update(text).digest('hex');
};

const parseJsonValue = <T = Record<string, unknown>>(value: unknown): T => {
  if (typeof value !== 'string') return value as T;
  try { return JSON.parse(value) as T; } catch { return {} as T; }
};
