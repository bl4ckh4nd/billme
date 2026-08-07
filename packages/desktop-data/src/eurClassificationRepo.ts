import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { and, eq } from 'drizzle-orm';
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
  note?: string;
}

export const upsertEurClassification = (
  db: Database.Database,
  input: UpsertEurClassificationInput,
): EurClassification => {
  const now = new Date().toISOString();

  const drizzle = createDrizzle(db);
  const existing = drizzle.select({ id: schema.eurClassifications.id })
    .from(schema.eurClassifications)
    .where(and(
      eq(schema.eurClassifications.sourceType, input.sourceType),
      eq(schema.eurClassifications.sourceId, input.sourceId),
      eq(schema.eurClassifications.taxYear, input.taxYear),
    )).get();

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
    note: input.note ?? null,
    updatedAt: now,
  }}).run();

  return getEurClassification(db, input.sourceType, input.sourceId, input.taxYear)!;
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
  note: row.note ?? null,
  updated_at: row.updatedAt!,
});
