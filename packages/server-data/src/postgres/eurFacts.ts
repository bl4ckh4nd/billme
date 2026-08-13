import { createHash, randomUUID } from 'node:crypto';
import { getCatalogForYear, getCatalogManifestForYear } from '@billme/desktop-services/eurCatalog';
import { getEurAnnexCatalog } from '@billme/desktop-services/eur/annexCatalog';
import type { EurExpenseSplit } from '@billme/accounting-shared';
import type { AccountingMutationContext, TenantScope } from '@billme/server-core';
import { createPostgresAuditLogPort } from './audit.js';
import type { PostgresQueryable } from './connection.js';
import { assertServerEurCashSource, type ServerEurReportResult } from './eurReport.js';

type EurCashFactKind = 'income' | 'expense' | 'private-withdrawal' | 'private-contribution' | 'pass-through';
type EurSourceType = 'transaction' | 'invoice';
type EurActor = { id: string; displayName?: string };
type EurProvenance = { catalogId: string; catalogVersion: string; catalogSourceHash: string; sourceSnapshotHash?: string };

export interface ServerEurCashFact {
  id: string;
  tenantId: string;
  sourceType: EurSourceType;
  sourceId: string;
  taxYear: number;
  kind: EurCashFactKind;
  amountNet: number;
  flowType?: 'income' | 'expense';
  eurLineId?: string;
  splits?: EurExpenseSplit[];
  reason: string;
  actor: EurActor;
  idempotencyKey?: string;
  provenance: EurProvenance;
  createdAt: string;
  updatedAt: string;
}

export interface ServerEurAnnexFact {
  id: string;
  tenantId: string;
  taxYear: number;
  annex: string;
  lineId: string;
  amount: number;
  sourceId?: string;
  date?: string;
  reason: string;
  actor: EurActor;
  idempotencyKey?: string;
  provenance: EurProvenance;
  createdAt: string;
}

const q = async <T = Record<string, unknown>>(db: PostgresQueryable, text: string, values: unknown[] = []): Promise<T[]> => (await db.query(text, values)).rows as T[];
const cents = (value: number): number => Math.round((value + Number.EPSILON) * 100);
const amount = (value: number): number => cents(value) / 100;
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const actorOf = (actor: EurActor): EurActor => ({ id: actor.id.trim(), displayName: actor.displayName?.trim() || undefined });
const manifestProvenance = (taxYear: number, sourceSnapshotHash?: string): EurProvenance => {
  const catalog = getCatalogManifestForYear(taxYear);
  return { catalogId: catalog.id, catalogVersion: catalog.version, catalogSourceHash: catalog.sha256, sourceSnapshotHash };
};
const parse = <T>(value: unknown, fallback: T): T => {
  if (!value) return fallback;
  try { return (typeof value === 'string' ? JSON.parse(value) : value) as T; } catch { return fallback; }
};
const rowCash = (row: Record<string, unknown>): ServerEurCashFact => ({
  id: String(row.id), tenantId: String(row.tenant_id), sourceType: row.source_type as EurSourceType, sourceId: String(row.source_id), taxYear: Number(row.tax_year), kind: row.kind as EurCashFactKind,
  amountNet: Number(row.amount_net), flowType: row.flow_type ? row.flow_type as 'income' | 'expense' : undefined, eurLineId: row.eur_line_id ? String(row.eur_line_id) : undefined,
  splits: row.splits_json ? parse<EurExpenseSplit[]>(row.splits_json, []) : undefined, reason: String(row.reason), actor: { id: String(row.actor_id), displayName: row.actor_name ? String(row.actor_name) : undefined }, idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined,
  provenance: parse<EurProvenance>(row.provenance_json, {} as EurProvenance), createdAt: String(row.created_at), updatedAt: String(row.updated_at),
});
const rowAnnex = (row: Record<string, unknown>): ServerEurAnnexFact => ({
  id: String(row.id), tenantId: String(row.tenant_id), taxYear: Number(row.tax_year), annex: String(row.annex), lineId: String(row.line_id), amount: Number(row.amount), sourceId: row.source_id ? String(row.source_id) : undefined, date: row.fact_date ? String(row.fact_date) : undefined,
  reason: String(row.reason), actor: { id: String(row.actor_id), displayName: row.actor_name ? String(row.actor_name) : undefined }, idempotencyKey: row.idempotency_key ? String(row.idempotency_key) : undefined, provenance: parse<EurProvenance>(row.provenance_json, {} as EurProvenance), createdAt: String(row.created_at),
});

const assertMutation = (mutation: AccountingMutationContext | undefined): { reason: string; actor: EurActor } => {
  const reason = mutation?.reason?.trim();
  if (!reason) throw new Error('EUR_FACT_REASON_REQUIRED');
  const actor = actorOf({ id: mutation?.actor?.id ?? '', displayName: mutation?.actor?.displayName });
  if (!actor.id) throw new Error('EUR_FACT_ACTOR_REQUIRED');
  return { reason, actor };
};

const assertCashFact = async (db: PostgresQueryable, scope: TenantScope, input: SaveServerEurCashFactInput): Promise<{ sourceSnapshotHash: string }> => {
  getCatalogForYear(input.taxYear);
  const source = await assertServerEurCashSource(db, scope, input.sourceType, input.sourceId, input.product ?? 'pro', input.taxYear);
  if (!Number.isFinite(input.amountNet) || input.amountNet < 0) throw new Error('EUR_FACT_AMOUNT_INVALID');
  if (input.kind === 'private-withdrawal' || input.kind === 'private-contribution' || input.kind === 'pass-through') {
    if (input.eurLineId || input.splits?.length) throw new Error('EUR_NEUTRAL_FACT_MUST_NOT_HAVE_LINE');
    return { sourceSnapshotHash: hash(source) };
  }
  if ((input.kind === 'income' && input.flowType !== 'income') || (input.kind === 'expense' && input.flowType !== 'expense')) throw new Error('EUR_FACT_FLOW_MISMATCH');
  const lines = new Map(getCatalogForYear(input.taxYear).map((line) => [line.id, line]));
  if (input.eurLineId) {
    const line = lines.get(input.eurLineId);
    if (!line) throw new Error('EUR_LINE_NOT_FOUND');
    if (line.kind === 'computed') throw new Error('EUR_COMPUTED_LINE_NOT_CLASSIFIABLE');
    if (line.kind !== input.flowType) throw new Error('EUR_LINE_FLOW_MISMATCH');
  }
  if (input.splits?.length) {
    if (input.kind !== 'expense') throw new Error('EUR_SPLITS_EXPENSE_ONLY');
    const total = input.splits.reduce((sum, split) => {
      if (!Number.isFinite(split.amountNet) || split.amountNet < 0) throw new Error('EUR_SPLIT_AMOUNT_INVALID');
      if (!split.reason?.trim()) throw new Error('EUR_SPLIT_REASON_REQUIRED');
      const deductibility = split.deductibility ?? split.classification ?? (split.deductible === false ? 'non-deductible' : 'deductible');
      if (deductibility === 'deductible') {
        const line = split.lineId ? lines.get(split.lineId) : undefined;
        if (!line) throw new Error('EUR_SPLIT_LINE_NOT_FOUND');
        if (line.kind !== 'expense') throw new Error('EUR_SPLIT_LINE_FLOW_MISMATCH');
      }
      return sum + cents(split.amountNet);
    }, 0);
    if (total !== cents(input.amountNet)) throw new Error('EUR_SPLIT_ALLOCATION_MISMATCH');
  }
  return { sourceSnapshotHash: hash(source) };
};

export interface SaveServerEurCashFactInput {
  sourceType: EurSourceType;
  sourceId: string;
  taxYear: number;
  kind: EurCashFactKind;
  amountNet: number;
  flowType?: 'income' | 'expense';
  eurLineId?: string;
  splits?: EurExpenseSplit[];
  idempotencyKey?: string;
  product?: 'lite' | 'pro';
  mutation?: AccountingMutationContext;
}

export interface SaveServerEurClassificationInput {
  sourceType: EurSourceType;
  sourceId: string;
  taxYear: number;
  eurLineId?: string;
  excluded?: boolean;
  vatMode?: 'none' | 'default';
  vatRate?: number;
  note?: string;
  product?: 'lite' | 'pro';
  mutation?: AccountingMutationContext;
}

/** EÜR-only classification adapter; the generic accounting repository remains 2025-compatible. */
export const saveServerEurClassificationFact = async (db: PostgresQueryable, scope: TenantScope, input: SaveServerEurClassificationInput): Promise<Record<string, unknown>> => {
  const { reason, actor } = assertMutation(input.mutation);
  const source = await assertServerEurCashSource(db, scope, input.sourceType, input.sourceId, input.product ?? 'pro', input.taxYear);
  if (input.eurLineId) {
    const line = getCatalogForYear(input.taxYear).find((candidate) => candidate.id === input.eurLineId);
    if (!line) throw new Error('EUR_LINE_NOT_FOUND');
    if (line.kind === 'computed') throw new Error('EUR_COMPUTED_LINE_NOT_CLASSIFIABLE');
    if (!input.excluded && line.kind !== source.flowType) throw new Error('EUR_LINE_FLOW_MISMATCH');
  }
  const existing = (await q(db, 'SELECT * FROM eur_classifications WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3 AND tax_year=$4 LIMIT 1', [scope.tenantId, input.sourceType, input.sourceId, input.taxYear]))[0];
  const now = new Date().toISOString();
  const id = String(existing?.id ?? randomUUID());
  const record = { id, tenant_id: scope.tenantId, source_type: input.sourceType, source_id: input.sourceId, tax_year: input.taxYear, eur_line_id: input.excluded ? null : input.eurLineId ?? null, excluded: input.excluded === true, vat_mode: input.vatMode ?? 'none', vat_rate: input.vatRate ?? null, note: input.note ?? null, updated_at: now };
  await db.query(`INSERT INTO eur_classifications (id,tenant_id,source_type,source_id,tax_year,eur_line_id,excluded,vat_mode,vat_rate,note,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (tenant_id,source_type,source_id,tax_year) DO UPDATE SET eur_line_id=EXCLUDED.eur_line_id,excluded=EXCLUDED.excluded,vat_mode=EXCLUDED.vat_mode,vat_rate=EXCLUDED.vat_rate,note=EXCLUDED.note,updated_at=EXCLUDED.updated_at`, [id, scope.tenantId, input.sourceType, input.sourceId, input.taxYear, record.eur_line_id, record.excluded, record.vat_mode, record.vat_rate, record.note, now]);
  const saved = (await q(db, 'SELECT * FROM eur_classifications WHERE tenant_id=$1 AND id=$2', [scope.tenantId, id]))[0] ?? record;
  await createPostgresAuditLogPort(db as any).append(scope, { occurredAt: now, action: existing ? 'update' : 'create', reason, actor: { type: 'user', id: actor.id, displayName: actor.displayName }, subject: { entityType: 'eur_classification', entityId: `${input.sourceType}:${input.sourceId}:${input.taxYear}`, tenantId: scope.tenantId }, change: { before: existing ?? null, after: saved } });
  return saved;
};

export const saveServerEurCashFact = async (db: PostgresQueryable, scope: TenantScope, input: SaveServerEurCashFactInput): Promise<ServerEurCashFact> => {
  const { reason, actor } = assertMutation(input.mutation);
  const { sourceSnapshotHash } = await assertCashFact(db, scope, input);
  const tenantId = scope.tenantId;
  if (input.idempotencyKey) {
    const duplicate = (await q(db, 'SELECT * FROM eur_cash_facts WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1', [tenantId, input.idempotencyKey]))[0];
    if (duplicate) {
      const saved = rowCash(duplicate);
      if (saved.amountNet === amount(input.amountNet) && saved.kind === input.kind && JSON.stringify(saved.splits ?? []) === JSON.stringify(input.splits ?? [])) return saved;
      throw new Error('EUR_FACT_IDEMPOTENCY_CONFLICT');
    }
  }
  const existing = (await q(db, 'SELECT * FROM eur_cash_facts WHERE tenant_id=$1 AND source_type=$2 AND source_id=$3 AND tax_year=$4 LIMIT 1', [tenantId, input.sourceType, input.sourceId, input.taxYear]))[0];
  const now = new Date().toISOString();
  const id = String(existing?.id ?? randomUUID());
  const provenance = manifestProvenance(input.taxYear, sourceSnapshotHash);
  await db.query(`INSERT INTO eur_cash_facts
    (id,tenant_id,source_type,source_id,tax_year,kind,amount_net,flow_type,eur_line_id,splits_json,reason,actor_id,actor_name,idempotency_key,provenance_json,created_at,updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
    ON CONFLICT (tenant_id,source_type,source_id,tax_year) DO UPDATE SET
      kind=EXCLUDED.kind,amount_net=EXCLUDED.amount_net,flow_type=EXCLUDED.flow_type,eur_line_id=EXCLUDED.eur_line_id,splits_json=EXCLUDED.splits_json,reason=EXCLUDED.reason,actor_id=EXCLUDED.actor_id,actor_name=EXCLUDED.actor_name,idempotency_key=EXCLUDED.idempotency_key,provenance_json=EXCLUDED.provenance_json,updated_at=EXCLUDED.updated_at`,
  [id, tenantId, input.sourceType, input.sourceId, input.taxYear, input.kind, amount(input.amountNet), input.flowType ?? null, input.eurLineId ?? null, input.splits?.length ? JSON.stringify(input.splits) : null, reason, actor.id, actor.displayName ?? null, input.idempotencyKey ?? null, JSON.stringify(provenance), String(existing?.created_at ?? now), now]);
  const saved = rowCash((await q(db, 'SELECT * FROM eur_cash_facts WHERE id=$1 AND tenant_id=$2', [id, tenantId]))[0]!);
  await createPostgresAuditLogPort(db as any).append(scope, { occurredAt: now, action: existing ? 'update' : 'create', reason, actor: { type: 'user', id: actor.id, displayName: actor.displayName }, subject: { entityType: 'eur_cash_fact', entityId: `${input.sourceType}:${input.sourceId}:${input.taxYear}`, tenantId }, change: { before: existing ?? null, after: saved } });
  return saved;
};

export const listServerEurCashFacts = async (db: PostgresQueryable, scope: TenantScope, taxYear: number): Promise<ServerEurCashFact[]> => (await q(db, 'SELECT * FROM eur_cash_facts WHERE tenant_id=$1 AND tax_year=$2 ORDER BY source_type,source_id', [scope.tenantId, taxYear])).map(rowCash);

export interface SaveServerEurAnnexFactInput {
  taxYear: number;
  annex: string;
  lineId: string;
  amount: number;
  sourceId?: string;
  date?: string;
  idempotencyKey?: string;
  mutation?: AccountingMutationContext;
}

export const saveServerEurAnnexFact = async (db: PostgresQueryable, scope: TenantScope, input: SaveServerEurAnnexFactInput): Promise<ServerEurAnnexFact> => {
  const { reason, actor } = assertMutation(input.mutation);
  getCatalogForYear(input.taxYear);
  const annex = input.annex.trim();
  if (!annex || !input.lineId.trim()) throw new Error('EUR_ANNEX_FACT_LINE_REQUIRED');
  if (annex === 'AVEÜR' || annex === 'SZ') {
    const line = getEurAnnexCatalog(input.taxYear, annex).lines.find((candidate) => candidate.id === input.lineId);
    if (!line) throw new Error('EUR_ANNEX_LINE_NOT_FOUND');
    if (line.kind === 'computed' && (line.computedFromIds?.length || line.computedTerms?.length)) throw new Error('EUR_COMPUTED_LINE_NOT_CLASSIFIABLE');
  }
  if (!Number.isFinite(input.amount)) throw new Error('EUR_ANNEX_AMOUNT_INVALID');
  if (input.date && (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !input.date.startsWith(`${input.taxYear}-`))) throw new Error('EUR_ANNEX_DATE_INVALID');
  const tenantId = scope.tenantId;
  if (input.idempotencyKey) {
    const duplicate = (await q(db, 'SELECT * FROM eur_annex_facts WHERE tenant_id=$1 AND idempotency_key=$2 LIMIT 1', [tenantId, input.idempotencyKey]))[0];
    if (duplicate) {
      const saved = rowAnnex(duplicate);
      if (saved.taxYear === input.taxYear && saved.annex === annex && saved.lineId === input.lineId && saved.amount === amount(input.amount)) return saved;
      throw new Error('EUR_FACT_IDEMPOTENCY_CONFLICT');
    }
  }
  const now = new Date().toISOString();
  const id = randomUUID();
  const provenance = manifestProvenance(input.taxYear);
  await db.query(`INSERT INTO eur_annex_facts (id,tenant_id,tax_year,annex,line_id,amount,source_id,fact_date,reason,actor_id,actor_name,idempotency_key,provenance_json,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, tenantId, input.taxYear, annex, input.lineId, amount(input.amount), input.sourceId ?? null, input.date ?? null, reason, actor.id, actor.displayName ?? null, input.idempotencyKey ?? null, JSON.stringify(provenance), now]);
  const saved = rowAnnex((await q(db, 'SELECT * FROM eur_annex_facts WHERE id=$1 AND tenant_id=$2', [id, tenantId]))[0]!);
  await createPostgresAuditLogPort(db as any).append(scope, { occurredAt: now, action: 'create', reason, actor: { type: 'user', id: actor.id, displayName: actor.displayName }, subject: { entityType: 'eur_annex_fact', entityId: id, tenantId }, change: { before: null, after: saved } });
  return saved;
};

export const listServerEurAnnexFacts = async (db: PostgresQueryable, scope: TenantScope, taxYear: number, annex?: string): Promise<ServerEurAnnexFact[]> => {
  const rows = annex
    ? await q(db, 'SELECT * FROM eur_annex_facts WHERE tenant_id=$1 AND tax_year=$2 AND annex=$3 ORDER BY created_at,id', [scope.tenantId, taxYear, annex])
    : await q(db, 'SELECT * FROM eur_annex_facts WHERE tenant_id=$1 AND tax_year=$2 ORDER BY created_at,id', [scope.tenantId, taxYear]);
  return rows.map(rowAnnex);
};

export interface ServerEurSnapshot {
  id: string;
  tenantId: string;
  taxYear: number;
  from: string;
  to: string;
  payload: ServerEurReportResult;
  sourceHash: string;
  catalog: EurProvenance;
  reason: string;
  actor: EurActor;
  createdAt: string;
}

export const freezeServerEurSnapshot = async (db: PostgresQueryable, scope: TenantScope, report: ServerEurReportResult, mutation?: AccountingMutationContext): Promise<ServerEurSnapshot> => {
  const { reason, actor } = assertMutation(mutation);
  if (report.from !== `${report.taxYear}-01-01` || report.to !== `${report.taxYear}-12-31`) throw new Error(rangeError(report.taxYear));
  if (report.warnings.length || report.unclassifiedCount) throw new Error('EUR_SNAPSHOT_INCOMPLETE');
  const sourceHash = hash({ taxYear: report.taxYear, from: report.from, to: report.to, payload: report });
  const existing = (await q(db, 'SELECT * FROM eur_report_snapshots WHERE tenant_id=$1 AND tax_year=$2 AND source_hash=$3 LIMIT 1', [scope.tenantId, report.taxYear, sourceHash]))[0];
  if (existing) return rowSnapshot(existing);
  const now = new Date().toISOString();
  const id = randomUUID();
  const catalog = { catalogId: report.catalog.id, catalogVersion: report.catalog.version, catalogSourceHash: report.catalog.sourceHash };
  await db.query(`INSERT INTO eur_report_snapshots (id,tenant_id,tax_year,from_date,to_date,payload_json,source_hash,catalog_id,catalog_version,catalog_source_hash,reason,actor_id,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (tenant_id,tax_year,source_hash) DO NOTHING`, [id, scope.tenantId, report.taxYear, report.from, report.to, JSON.stringify(report), sourceHash, catalog.catalogId, catalog.catalogVersion, catalog.catalogSourceHash, reason, actor.id, now]);
  const saved = rowSnapshot((await q(db, 'SELECT * FROM eur_report_snapshots WHERE tenant_id=$1 AND tax_year=$2 AND source_hash=$3', [scope.tenantId, report.taxYear, sourceHash]))[0]!);
  await createPostgresAuditLogPort(db as any).append(scope, { occurredAt: now, action: 'freeze', reason, actor: { type: 'user', id: actor.id, displayName: actor.displayName }, subject: { entityType: 'eur_report_snapshot', entityId: saved.id, tenantId: scope.tenantId }, change: { before: null, after: saved } });
  return saved;
};

const rangeError = (year: number): string => year === 2025 ? 'EUR_RANGE_2025_REQUIRED' : `EUR_RANGE_${year}_REQUIRED`;
const rowSnapshot = (row: Record<string, unknown>): ServerEurSnapshot => ({
  id: String(row.id), tenantId: String(row.tenant_id), taxYear: Number(row.tax_year), from: String(row.from_date), to: String(row.to_date), payload: parse<ServerEurReportResult>(row.payload_json, {} as ServerEurReportResult), sourceHash: String(row.source_hash), catalog: { catalogId: String(row.catalog_id), catalogVersion: String(row.catalog_version), catalogSourceHash: String(row.catalog_source_hash) }, reason: String(row.reason), actor: { id: String(row.actor_id) }, createdAt: String(row.created_at),
});

export const listServerEurSnapshots = async (db: PostgresQueryable, scope: TenantScope, taxYear?: number): Promise<ServerEurSnapshot[]> => {
  const rows = taxYear === undefined
    ? await q(db, 'SELECT * FROM eur_report_snapshots WHERE tenant_id=$1 ORDER BY created_at DESC,id DESC', [scope.tenantId])
    : await q(db, 'SELECT * FROM eur_report_snapshots WHERE tenant_id=$1 AND tax_year=$2 ORDER BY created_at DESC,id DESC', [scope.tenantId, taxYear]);
  return rows.map(rowSnapshot);
};

export const getServerEurSnapshot = async (db: PostgresQueryable, scope: TenantScope, id: string): Promise<ServerEurSnapshot | null> => {
  const row = (await q(db, 'SELECT * FROM eur_report_snapshots WHERE tenant_id=$1 AND id=$2 LIMIT 1', [scope.tenantId, id]))[0];
  return row ? rowSnapshot(row) : null;
};
