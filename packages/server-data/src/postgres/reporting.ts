import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { TenantScope } from "@billme/server-core";
import type { PostgresQueryable } from "./connection.js";
import { createDrizzle, schema } from "./drizzle.js";

const dbFor = (db: PostgresQueryable) => createDrizzle(db as never);
const now = (): string => new Date().toISOString();
const numberValue = (value: string | number | null | undefined): number => Number(value ?? 0);

export const hashReportSource = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export interface ReportAccountMappingRecord {
  id: string;
  tenantId: string;
  reportType: string;
  chart: string;
  accountNumber: string;
  positionKey: string;
  positionLabel: string;
  validFrom?: string;
  validTo?: string;
  version: number;
  source: string;
  sourceHash: string;
  createdBy?: string;
  createdAt: string;
}

export type ReportAccountMappingInput = Omit<ReportAccountMappingRecord, "id" | "createdAt" | "tenantId"> & {
  id?: string;
  createdBy?: string;
};

export interface ReportCatalogRefRecord {
  id: string;
  tenantId: string;
  reportType: string;
  catalogKey: string;
  catalogVersion: string;
  sourceHash: string;
  payloadJson: string;
  createdBy?: string;
  createdAt: string;
}

export type ReportCatalogRefInput = Omit<ReportCatalogRefRecord, "id" | "createdAt" | "tenantId"> & { id?: string };

export interface ReportSnapshotPosition {
  id: string;
  tenantId: string;
  snapshotId: string;
  positionKey: string;
  positionLabel: string;
  amount: number;
  debitAmount: number;
  creditAmount: number;
  metadataJson: string;
  createdAt: string;
}

export type ReportSnapshotPositionInput = Omit<ReportSnapshotPosition, "id" | "tenantId" | "snapshotId" | "createdAt"> & { id?: string };

export interface ReportSnapshotRecord {
  id: string;
  tenantId: string;
  reportType: string;
  argsJson: string;
  payloadJson: string;
  sourceHash: string;
  fromDate?: string;
  toDate?: string;
  asOfDate?: string;
  createdAt: string;
  positions: ReportSnapshotPosition[];
}

export type ReportSnapshotInput = Omit<ReportSnapshotRecord, "id" | "tenantId" | "createdAt" | "positions"> & {
  id?: string;
  positions?: ReportSnapshotPositionInput[];
};

export interface TaxAdjustmentRecord {
  id: string;
  tenantId: string;
  submissionId?: string;
  taxYear: number;
  period: string;
  adjustmentType: string;
  amount: number;
  taxCode?: string;
  reason: string;
  sourceJson: string;
  idempotencyKey: string;
  createdBy?: string;
  createdAt: string;
}

export type TaxAdjustmentInput = Omit<TaxAdjustmentRecord, "id" | "tenantId" | "createdAt"> & { id?: string };

const mappingFromRow = (row: typeof schema.reportAccountMappings.$inferSelect): ReportAccountMappingRecord => ({
  id: row.id!, tenantId: row.tenantId!, reportType: row.reportType!, chart: row.chart!, accountNumber: row.accountNumber!,
  positionKey: row.positionKey!, positionLabel: row.positionLabel!, validFrom: row.validFrom ?? undefined,
  validTo: row.validTo ?? undefined, version: row.version!, source: row.source!, sourceHash: row.sourceHash!,
  createdBy: row.createdBy ?? undefined, createdAt: row.createdAt!,
});

export const saveReportAccountMapping = async (
  db: PostgresQueryable,
  scope: TenantScope,
  input: ReportAccountMappingInput,
): Promise<ReportAccountMappingRecord> => {
  const record: ReportAccountMappingRecord = { ...input, id: input.id ?? randomUUID(), tenantId: scope.tenantId, createdAt: now() };
  await dbFor(db).insert(schema.reportAccountMappings).values(record).onConflictDoNothing();
  const row = (await dbFor(db).select().from(schema.reportAccountMappings).where(and(eq(schema.reportAccountMappings.tenantId, scope.tenantId), eq(schema.reportAccountMappings.id, record.id))).limit(1))[0];
  if (!row) throw new Error("REPORT_ACCOUNT_MAPPING_NOT_PERSISTED");
  return mappingFromRow(row);
};

export const listReportAccountMappings = async (
  db: PostgresQueryable,
  scope: TenantScope,
  args: { reportType?: string; chart?: string; asOfDate?: string } = {},
): Promise<ReportAccountMappingRecord[]> => {
  const conditions = [eq(schema.reportAccountMappings.tenantId, scope.tenantId)];
  if (args.reportType) conditions.push(eq(schema.reportAccountMappings.reportType, args.reportType));
  if (args.chart) conditions.push(eq(schema.reportAccountMappings.chart, args.chart));
  const rows = await dbFor(db).select().from(schema.reportAccountMappings).where(and(...conditions))
    .orderBy(asc(schema.reportAccountMappings.reportType), asc(schema.reportAccountMappings.chart), asc(schema.reportAccountMappings.accountNumber), desc(schema.reportAccountMappings.version));
  return rows.filter((row) => !args.asOfDate || ((!row.validFrom || row.validFrom <= args.asOfDate) && (!row.validTo || row.validTo >= args.asOfDate))).map(mappingFromRow);
};

export const saveReportCatalogRef = async (
  db: PostgresQueryable,
  scope: TenantScope,
  input: ReportCatalogRefInput,
): Promise<ReportCatalogRefRecord> => {
  const record: ReportCatalogRefRecord = { ...input, id: input.id ?? randomUUID(), tenantId: scope.tenantId, createdAt: now() };
  await dbFor(db).insert(schema.reportCatalogRefs).values(record).onConflictDoNothing();
  const row = (await dbFor(db).select().from(schema.reportCatalogRefs).where(and(eq(schema.reportCatalogRefs.tenantId, scope.tenantId), eq(schema.reportCatalogRefs.id, record.id))).limit(1))[0];
  if (!row) throw new Error("REPORT_CATALOG_REF_NOT_PERSISTED");
  return { id: row.id!, tenantId: row.tenantId!, reportType: row.reportType!, catalogKey: row.catalogKey!, catalogVersion: row.catalogVersion!, sourceHash: row.sourceHash!, payloadJson: row.payloadJson!, createdBy: row.createdBy ?? undefined, createdAt: row.createdAt! };
};

export const listReportCatalogRefs = async (db: PostgresQueryable, scope: TenantScope, reportType?: string): Promise<ReportCatalogRefRecord[]> => {
  const where = reportType ? and(eq(schema.reportCatalogRefs.tenantId, scope.tenantId), eq(schema.reportCatalogRefs.reportType, reportType)) : eq(schema.reportCatalogRefs.tenantId, scope.tenantId);
  const rows = await dbFor(db).select().from(schema.reportCatalogRefs).where(where).orderBy(asc(schema.reportCatalogRefs.reportType), asc(schema.reportCatalogRefs.catalogKey), desc(schema.reportCatalogRefs.catalogVersion));
  return rows.map((row) => ({ id: row.id!, tenantId: row.tenantId!, reportType: row.reportType!, catalogKey: row.catalogKey!, catalogVersion: row.catalogVersion!, sourceHash: row.sourceHash!, payloadJson: row.payloadJson!, createdBy: row.createdBy ?? undefined, createdAt: row.createdAt! }));
};

const positionFromRow = (row: typeof schema.reportSnapshotPositions.$inferSelect): ReportSnapshotPosition => ({
  id: row.id!, tenantId: row.tenantId!, snapshotId: row.snapshotId!, positionKey: row.positionKey!, positionLabel: row.positionLabel!, amount: numberValue(row.amount), debitAmount: numberValue(row.debitAmount), creditAmount: numberValue(row.creditAmount), metadataJson: row.metadataJson!, createdAt: row.createdAt!,
});

export const getReportSnapshot = async (db: PostgresQueryable, scope: TenantScope, id: string): Promise<ReportSnapshotRecord | null> => {
  const database = dbFor(db);
  const row = (await database.select().from(schema.reportSnapshots).where(and(eq(schema.reportSnapshots.tenantId, scope.tenantId), eq(schema.reportSnapshots.id, id))).limit(1))[0];
  if (!row) return null;
  const positions = await database.select().from(schema.reportSnapshotPositions).where(and(eq(schema.reportSnapshotPositions.tenantId, scope.tenantId), eq(schema.reportSnapshotPositions.snapshotId, id))).orderBy(asc(schema.reportSnapshotPositions.positionKey), asc(schema.reportSnapshotPositions.id));
  return { id: row.id!, tenantId: row.tenantId!, reportType: row.reportType!, argsJson: row.argsJson!, payloadJson: row.payloadJson!, sourceHash: row.sourceHash!, fromDate: row.fromDate ?? undefined, toDate: row.toDate ?? undefined, asOfDate: row.asOfDate ?? undefined, createdAt: row.createdAt!, positions: positions.map(positionFromRow) };
};

export const createReportSnapshot = async (db: PostgresQueryable, scope: TenantScope, input: ReportSnapshotInput): Promise<ReportSnapshotRecord> => {
  const database = dbFor(db);
  const existing = (await database.select().from(schema.reportSnapshots).where(and(eq(schema.reportSnapshots.tenantId, scope.tenantId), eq(schema.reportSnapshots.reportType, input.reportType), eq(schema.reportSnapshots.sourceHash, input.sourceHash))).limit(1))[0];
  if (existing) return (await getReportSnapshot(db, scope, existing.id!))!;
  const record = { id: input.id ?? randomUUID(), tenantId: scope.tenantId, reportType: input.reportType, argsJson: input.argsJson, payloadJson: input.payloadJson, sourceHash: input.sourceHash, fromDate: input.fromDate ?? null, toDate: input.toDate ?? null, asOfDate: input.asOfDate ?? null, createdAt: now() };
  await database.insert(schema.reportSnapshots).values(record).onConflictDoNothing();
  const snapshot = (await database.select().from(schema.reportSnapshots).where(and(eq(schema.reportSnapshots.tenantId, scope.tenantId), eq(schema.reportSnapshots.id, record.id))).limit(1))[0];
  if (!snapshot) throw new Error("REPORT_SNAPSHOT_NOT_PERSISTED");
  for (const position of input.positions ?? []) await database.insert(schema.reportSnapshotPositions).values({ id: position.id ?? randomUUID(), tenantId: scope.tenantId, snapshotId: snapshot.id!, positionKey: position.positionKey, positionLabel: position.positionLabel, amount: String(position.amount), debitAmount: String(position.debitAmount), creditAmount: String(position.creditAmount), metadataJson: position.metadataJson, createdAt: record.createdAt }).onConflictDoNothing();
  return (await getReportSnapshot(db, scope, snapshot.id!))!;
};

export const listReportSnapshots = async (db: PostgresQueryable, scope: TenantScope, reportType?: string): Promise<ReportSnapshotRecord[]> => {
  const where = reportType ? and(eq(schema.reportSnapshots.tenantId, scope.tenantId), eq(schema.reportSnapshots.reportType, reportType)) : eq(schema.reportSnapshots.tenantId, scope.tenantId);
  const rows = await dbFor(db).select({ id: schema.reportSnapshots.id }).from(schema.reportSnapshots).where(where).orderBy(desc(schema.reportSnapshots.createdAt));
  const snapshots: ReportSnapshotRecord[] = [];
  for (const row of rows) { const snapshot = await getReportSnapshot(db, scope, row.id!); if (snapshot) snapshots.push(snapshot); }
  return snapshots;
};

export const saveTaxAdjustment = async (db: PostgresQueryable, scope: TenantScope, input: TaxAdjustmentInput): Promise<TaxAdjustmentRecord> => {
  const record: TaxAdjustmentRecord = { ...input, id: input.id ?? randomUUID(), tenantId: scope.tenantId, createdAt: now() };
  await dbFor(db).insert(schema.taxAdjustments).values({ id: record.id, tenantId: record.tenantId, submissionId: record.submissionId ?? null, taxYear: record.taxYear, period: record.period, adjustmentType: record.adjustmentType, amount: String(record.amount), taxCode: record.taxCode ?? null, reason: record.reason, sourceJson: record.sourceJson, idempotencyKey: record.idempotencyKey, createdBy: record.createdBy ?? null, createdAt: record.createdAt }).onConflictDoNothing();
  const row = (await dbFor(db).select().from(schema.taxAdjustments).where(and(eq(schema.taxAdjustments.tenantId, scope.tenantId), eq(schema.taxAdjustments.id, record.id))).limit(1))[0];
  if (!row) throw new Error("TAX_ADJUSTMENT_NOT_PERSISTED");
  return { id: row.id!, tenantId: row.tenantId!, submissionId: row.submissionId ?? undefined, taxYear: row.taxYear!, period: row.period!, adjustmentType: row.adjustmentType!, amount: numberValue(row.amount), taxCode: row.taxCode ?? undefined, reason: row.reason!, sourceJson: row.sourceJson!, idempotencyKey: row.idempotencyKey!, createdBy: row.createdBy ?? undefined, createdAt: row.createdAt! };
};

export const listTaxAdjustments = async (db: PostgresQueryable, scope: TenantScope, submissionId?: string): Promise<TaxAdjustmentRecord[]> => {
  const where = submissionId ? and(eq(schema.taxAdjustments.tenantId, scope.tenantId), eq(schema.taxAdjustments.submissionId, submissionId)) : eq(schema.taxAdjustments.tenantId, scope.tenantId);
  const rows = await dbFor(db).select().from(schema.taxAdjustments).where(where).orderBy(asc(schema.taxAdjustments.period), asc(schema.taxAdjustments.createdAt));
  return rows.map((row) => ({ id: row.id!, tenantId: row.tenantId!, submissionId: row.submissionId ?? undefined, taxYear: row.taxYear!, period: row.period!, adjustmentType: row.adjustmentType!, amount: numberValue(row.amount), taxCode: row.taxCode ?? undefined, reason: row.reason!, sourceJson: row.sourceJson!, idempotencyKey: row.idempotencyKey!, createdBy: row.createdBy ?? undefined, createdAt: row.createdAt! }));
};

export const insertReportAccountMapping = saveReportAccountMapping;
export const insertReportCatalogRef = saveReportCatalogRef;
export const insertTaxAdjustment = saveTaxAdjustment;
