import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
import { appendAuditLog } from './audit';
import { createDrizzle, schema } from './drizzle';

export type EurSourceType = 'transaction' | 'invoice';
export type EurVatMode = 'none' | 'default';

export interface EurClassification {
  id: string;
  sourceType: EurSourceType;
  sourceId: string;
  taxYear: number;
  eurLineId?: string;
  excluded: boolean;
  vatMode: EurVatMode;
  vatRate?: number;
  note?: string;
  updatedAt: string;
}

export interface UpsertEurClassificationInput {
  sourceType: EurSourceType;
  sourceId: string;
  taxYear: number;
  eurLineId?: string;
  excluded?: boolean;
  vatMode?: EurVatMode;
  vatRate?: number;
  note?: string;
  reason: string;
  actor: string;
  product: 'lite' | 'pro';
}

export const upsertEurClassification = (
  db: Database.Database,
  input: UpsertEurClassificationInput,
): EurClassification => {
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) throw new Error('EUR_CLASSIFICATION_REASON_REQUIRED');
  const actor = typeof input.actor === 'string' ? input.actor.trim() : '';
  if (!actor) throw new Error('EUR_CLASSIFICATION_ACTOR_REQUIRED');
  if (input.product !== 'lite' && input.product !== 'pro') throw new Error('EUR_CLASSIFICATION_PRODUCT_REQUIRED');

  return db.transaction(() => {
    const now = new Date().toISOString();

    const drizzle = createDrizzle(db);
    const existing = getEurClassification(db, input.sourceType, input.sourceId, input.taxYear);

    const id = existing?.id ?? randomUUID();
    const excluded = input.excluded === true;
    const eurLineId = excluded ? null : (input.eurLineId ?? null);

    drizzle.insert(schema.eurClassifications).values({
      id,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      taxYear: input.taxYear,
      eurLineId,
      excluded: excluded ? 1 : 0,
      vatMode: input.vatMode ?? 'none',
      vatRate: input.vatRate ?? null,
      note: input.note ?? null,
      updatedAt: now,
    }).onConflictDoUpdate({ target: [
      schema.eurClassifications.sourceType,
      schema.eurClassifications.sourceId,
      schema.eurClassifications.taxYear,
    ], set: {
      eurLineId,
      excluded: excluded ? 1 : 0,
      vatMode: input.vatMode ?? 'none',
      vatRate: input.vatRate ?? null,
      note: input.note ?? null,
      updatedAt: now,
    }}).run();

    const classification = getEurClassification(db, input.sourceType, input.sourceId, input.taxYear);
    if (!classification) throw new Error('EUR_CLASSIFICATION_PERSISTENCE_FAILED');

    appendAuditLog(db, {
      entityType: 'eur_classification',
      entityId: `${input.sourceType}:${input.sourceId}:${input.taxYear}`,
      action: 'upsert',
      reason,
      before: existing ? auditSnapshot(existing, input.product) : null,
      after: auditSnapshot(classification, input.product),
      actor,
    });

    return classification;
  })();
};

export const getEurClassification = (
  db: Database.Database,
  sourceType: EurSourceType,
  sourceId: string,
  taxYear: number,
): EurClassification | null => {
  const row = createDrizzle(db).select().from(schema.eurClassifications)
    .where(and(
      eq(schema.eurClassifications.sourceType, sourceType),
      eq(schema.eurClassifications.sourceId, sourceId),
      eq(schema.eurClassifications.taxYear, taxYear),
    )).get();

  if (!row) return null;
  return mapSchemaRow(row);
};

export const listEurClassifications = (db: Database.Database, taxYear: number): EurClassification[] => {
  return createDrizzle(db).select().from(schema.eurClassifications)
    .where(eq(schema.eurClassifications.taxYear, taxYear)).all().map(mapSchemaRow);
};

export const listEurClassificationsMap = (
  db: Database.Database,
  taxYear: number,
): Map<string, EurClassification> => {
  return new Map(
    listEurClassifications(db, taxYear).map((item) => [
      `${item.sourceType}:${item.sourceId}`,
      item,
    ]),
  );
};

const mapRow = (row: {
  id: string;
  source_type: EurSourceType;
  source_id: string;
  tax_year: number;
  eur_line_id: string | null;
  excluded: number;
  vat_mode: EurVatMode;
  vat_rate: number | null;
  note: string | null;
  updated_at: string;
}): EurClassification => ({
  id: row.id,
  sourceType: row.source_type,
  sourceId: row.source_id,
  taxYear: row.tax_year,
  eurLineId: row.eur_line_id ?? undefined,
  excluded: row.excluded === 1,
  vatMode: row.vat_mode,
  vatRate: row.vat_rate ?? undefined,
  note: row.note ?? undefined,
  updatedAt: row.updated_at,
});

const mapSchemaRow = (row: typeof schema.eurClassifications.$inferSelect): EurClassification => mapRow({
  id: row.id!,
  source_type: row.sourceType as EurSourceType,
  source_id: row.sourceId!,
  tax_year: row.taxYear!,
  eur_line_id: row.eurLineId ?? null,
  excluded: row.excluded!,
  vat_mode: row.vatMode as EurVatMode,
  vat_rate: row.vatRate ?? null,
  note: row.note ?? null,
  updated_at: row.updatedAt!,
});

const auditSnapshot = (classification: EurClassification, product: 'lite' | 'pro') => ({
  id: classification.id,
  sourceType: classification.sourceType,
  sourceId: classification.sourceId,
  taxYear: classification.taxYear,
  eurLineId: classification.eurLineId ?? null,
  excluded: classification.excluded,
  vatMode: classification.vatMode,
  vatRate: classification.vatRate ?? null,
  note: classification.note ?? null,
  updatedAt: classification.updatedAt,
  product,
});
