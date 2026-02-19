import type Database from 'better-sqlite3';
import { EUR_SOURCE_VERSION_2025, getCatalogForYear, type EurLineDef, type EurLineKind } from '../services/eurCatalog';

export interface EurLine {
  id: string;
  taxYear: number;
  kennziffer?: string;
  label: string;
  kind: EurLineKind;
  exportable: boolean;
  sortOrder: number;
  computedFromIds: string[];
  sourceVersion: string;
}

const sourceVersionForYear = (year: number): string => {
  if (year === 2025) return EUR_SOURCE_VERSION_2025;
  return `unknown-${year}`;
};

export const seedEurCatalog = (db: Database.Database, year: number): number => {
  const catalog = getCatalogForYear(year);
  if (catalog.length === 0) return 0;

  const now = new Date().toISOString();
  const upsert = db.prepare(`
    INSERT INTO eur_lines (
      id, tax_year, kennziffer, label, kind, exportable, sort_order, computed_from_json,
      source_version, created_at, updated_at
    ) VALUES (
      @id, @taxYear, @kennziffer, @label, @kind, @exportable, @sortOrder, @computedFromJson,
      @sourceVersion, @createdAt, @updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      tax_year = excluded.tax_year,
      kennziffer = excluded.kennziffer,
      label = excluded.label,
      kind = excluded.kind,
      exportable = excluded.exportable,
      sort_order = excluded.sort_order,
      computed_from_json = excluded.computed_from_json,
      source_version = excluded.source_version,
      updated_at = excluded.updated_at
  `);

  let count = 0;
  for (const [idx, line] of catalog.entries()) {
    upsert.run({
      id: line.id,
      taxYear: year,
      kennziffer: line.kennziffer,
      label: line.label,
      kind: line.kind,
      exportable: line.exportable ? 1 : 0,
      sortOrder: idx,
      computedFromJson: JSON.stringify(line.computedFromIds ?? []),
      sourceVersion: sourceVersionForYear(year),
      createdAt: now,
      updatedAt: now,
    });
    count += 1;
  }

  return count;
};

export const listEurLines = (db: Database.Database, taxYear: number): EurLine[] => {
  const rows = db
    .prepare(
      `
      SELECT id, tax_year, kennziffer, label, kind, exportable, sort_order, computed_from_json, source_version
      FROM eur_lines
      WHERE tax_year = ?
      ORDER BY sort_order ASC, id ASC
    `,
    )
    .all(taxYear) as Array<{
    id: string;
    tax_year: number;
    kennziffer: string | null;
    label: string;
    kind: string;
    exportable: number;
    sort_order: number;
    computed_from_json: string | null;
    source_version: string;
  }>;

  return rows.map((row) => ({
    id: row.id,
    taxYear: row.tax_year,
    kennziffer: row.kennziffer ?? undefined,
    label: row.label,
    kind: row.kind as EurLineKind,
    exportable: row.exportable === 1,
    sortOrder: row.sort_order,
    computedFromIds: parseComputedFrom(row.computed_from_json),
    sourceVersion: row.source_version,
  }));
};

export const getEurLineMap = (db: Database.Database, taxYear: number): Map<string, EurLine> => {
  return new Map(listEurLines(db, taxYear).map((line) => [line.id, line]));
};

const parseComputedFrom = (value: string | null): string[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch {
    return [];
  }
};

export const validateAndLoadCatalog = (year: number): EurLineDef[] => {
  return getCatalogForYear(year);
};
