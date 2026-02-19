import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

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

  const existing = db
    .prepare(
      `
      SELECT id
      FROM eur_classifications
      WHERE source_type = ? AND source_id = ? AND tax_year = ?
    `,
    )
    .get(input.sourceType, input.sourceId, input.taxYear) as { id: string } | undefined;

  const id = existing?.id ?? randomUUID();
  const excluded = input.excluded === true;
  const eurLineId = excluded ? null : (input.eurLineId ?? null);

  db.prepare(
    `
      INSERT INTO eur_classifications (
        id, source_type, source_id, tax_year, eur_line_id, excluded, vat_mode, note, updated_at
      ) VALUES (
        @id, @sourceType, @sourceId, @taxYear, @eurLineId, @excluded, @vatMode, @note, @updatedAt
      )
      ON CONFLICT(source_type, source_id, tax_year) DO UPDATE SET
        eur_line_id = excluded.eur_line_id,
        excluded = excluded.excluded,
        vat_mode = excluded.vat_mode,
        note = excluded.note,
        updated_at = excluded.updated_at
    `,
  ).run({
    id,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    taxYear: input.taxYear,
    eurLineId,
    excluded: excluded ? 1 : 0,
    vatMode: input.vatMode ?? 'none',
    note: input.note ?? null,
    updatedAt: now,
  });

  return getEurClassification(db, input.sourceType, input.sourceId, input.taxYear)!;
};

export const getEurClassification = (
  db: Database.Database,
  sourceType: EurSourceType,
  sourceId: string,
  taxYear: number,
): EurClassification | null => {
  const row = db
    .prepare(
      `
      SELECT id, source_type, source_id, tax_year, eur_line_id, excluded, vat_mode, note, updated_at
      FROM eur_classifications
      WHERE source_type = ? AND source_id = ? AND tax_year = ?
    `,
    )
    .get(sourceType, sourceId, taxYear) as
    | {
      id: string;
      source_type: EurSourceType;
      source_id: string;
      tax_year: number;
      eur_line_id: string | null;
      excluded: number;
      vat_mode: EurVatMode;
      note: string | null;
      updated_at: string;
    }
    | undefined;

  if (!row) return null;
  return mapRow(row);
};

export const listEurClassifications = (db: Database.Database, taxYear: number): EurClassification[] => {
  const rows = db
    .prepare(
      `
      SELECT id, source_type, source_id, tax_year, eur_line_id, excluded, vat_mode, note, updated_at
      FROM eur_classifications
      WHERE tax_year = ?
    `,
    )
    .all(taxYear) as Array<{
    id: string;
    source_type: EurSourceType;
    source_id: string;
    tax_year: number;
    eur_line_id: string | null;
    excluded: number;
    vat_mode: EurVatMode;
    note: string | null;
    updated_at: string;
  }>;

  return rows.map(mapRow);
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
