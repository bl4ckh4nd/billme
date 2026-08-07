import type Database from 'better-sqlite3';
import { asc, eq } from 'drizzle-orm';
import {
  EUR_SOURCE_VERSION_2025,
  getCatalogForYear,
  type EurLineDef,
  type EurLineKind,
} from '@billme/desktop-services/eurCatalog';
import { createDrizzle, schema } from './drizzle';

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
  const drizzle = createDrizzle(db);

  let count = 0;
  for (const [idx, line] of catalog.entries()) {
    drizzle.insert(schema.eurLines).values({
      id: line.id,
      taxYear: year,
      kennziffer: line.kennziffer ?? null,
      label: line.label,
      kind: line.kind,
      exportable: line.exportable ? 1 : 0,
      sortOrder: idx,
      computedFromJson: JSON.stringify(line.computedFromIds ?? []),
      sourceVersion: sourceVersionForYear(year),
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: schema.eurLines.id,
      set: {
        taxYear: year,
        kennziffer: line.kennziffer ?? null,
        label: line.label,
        kind: line.kind,
        exportable: line.exportable ? 1 : 0,
        sortOrder: idx,
        computedFromJson: JSON.stringify(line.computedFromIds ?? []),
        sourceVersion: sourceVersionForYear(year),
        updatedAt: now,
      },
    }).run();
    count += 1;
  }

  return count;
};

export const listEurLines = (db: Database.Database, taxYear: number): EurLine[] => {
  const rows = createDrizzle(db)
    .select({
      id: schema.eurLines.id,
      taxYear: schema.eurLines.taxYear,
      kennziffer: schema.eurLines.kennziffer,
      label: schema.eurLines.label,
      kind: schema.eurLines.kind,
      exportable: schema.eurLines.exportable,
      sortOrder: schema.eurLines.sortOrder,
      computedFromJson: schema.eurLines.computedFromJson,
      sourceVersion: schema.eurLines.sourceVersion,
    })
    .from(schema.eurLines)
    .where(eq(schema.eurLines.taxYear, taxYear))
    .orderBy(asc(schema.eurLines.sortOrder), asc(schema.eurLines.id))
    .all();

  return rows.map((row) => ({
    id: row.id,
    taxYear: row.taxYear!,
    kennziffer: row.kennziffer ?? undefined,
    label: row.label,
    kind: row.kind as EurLineKind,
    exportable: row.exportable === 1,
    sortOrder: row.sortOrder!,
    computedFromIds: parseComputedFrom(row.computedFromJson),
    sourceVersion: row.sourceVersion!,
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
