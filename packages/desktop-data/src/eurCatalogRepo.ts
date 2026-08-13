import type Database from 'better-sqlite3';
import { asc, eq } from 'drizzle-orm';
import {
  getCatalogManifestForYear,
  getCatalogForYear,
  type EurComputedTerm,
  type EurLineDef,
  type EurLineKind,
} from '@billme/desktop-services/eurCatalog';
import { createDrizzle, schema } from './drizzle';

export interface EurLine {
  id: string;
  taxYear: number;
  providerPath?: string;
  kennziffer?: string;
  label: string;
  kind: EurLineKind;
  exportable: boolean;
  sortOrder: number;
  computedFromIds: string[];
  computedTerms?: EurComputedTerm[];
  sourceVersion: string;
}

const sourceVersionForYear = (year: number): string => {
  return getCatalogManifestForYear(year).version;
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
      providerPath: line.providerPath ?? 'main',
      kennziffer: line.kennziffer ?? null,
      label: line.label,
      kind: line.kind,
      exportable: line.exportable ? 1 : 0,
      sortOrder: idx,
      computedFromJson: JSON.stringify(line.computedFromIds ?? []),
      computedTermsJson: JSON.stringify(line.computedTerms ?? []),
      sourceVersion: sourceVersionForYear(year),
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: schema.eurLines.id,
      set: {
        taxYear: year,
        providerPath: line.providerPath ?? 'main',
        kennziffer: line.kennziffer ?? null,
        label: line.label,
        kind: line.kind,
        exportable: line.exportable ? 1 : 0,
        sortOrder: idx,
        computedFromJson: JSON.stringify(line.computedFromIds ?? []),
        computedTermsJson: JSON.stringify(line.computedTerms ?? []),
        sourceVersion: sourceVersionForYear(year),
        updatedAt: now,
      },
    }).run();
    count += 1;
  }

  return count;
};

export const listEurLines = (db: Database.Database, taxYear: number): EurLine[] => {
  // Do not turn an unsupported year into a misleading successful empty report.
  getCatalogForYear(taxYear);
  const rows = createDrizzle(db)
    .select({
      id: schema.eurLines.id,
      taxYear: schema.eurLines.taxYear,
      providerPath: schema.eurLines.providerPath,
      kennziffer: schema.eurLines.kennziffer,
      label: schema.eurLines.label,
      kind: schema.eurLines.kind,
      exportable: schema.eurLines.exportable,
      sortOrder: schema.eurLines.sortOrder,
      computedFromJson: schema.eurLines.computedFromJson,
      computedTermsJson: schema.eurLines.computedTermsJson,
      sourceVersion: schema.eurLines.sourceVersion,
    })
    .from(schema.eurLines)
    .where(eq(schema.eurLines.taxYear, taxYear))
    .orderBy(asc(schema.eurLines.sortOrder), asc(schema.eurLines.id))
    .all();

  if (rows.length === 0) {
    // Existing desktop databases are upgraded lazily.  Keep a newly shipped
    // catalog selectable before the next bootstrap/migration has seeded it.
    return getCatalogForYear(taxYear).map((line, sortOrder) => ({
      id: line.id,
      taxYear,
      providerPath: line.providerPath ?? 'main',
      kennziffer: line.kennziffer,
      label: line.label,
      kind: line.kind,
      exportable: line.exportable,
      sortOrder,
      computedFromIds: line.computedFromIds ?? [],
      computedTerms: line.computedTerms,
      sourceVersion: sourceVersionForYear(taxYear),
    }));
  }

  return rows.map((row) => ({
    id: row.id,
    taxYear: row.taxYear!,
    providerPath: row.providerPath ?? 'main',
    kennziffer: row.kennziffer ?? undefined,
    label: row.label,
    kind: row.kind as EurLineKind,
    exportable: row.exportable === 1,
    sortOrder: row.sortOrder!,
    computedFromIds: parseComputedFrom(row.computedFromJson),
    computedTerms: parseComputedTerms(row.computedTermsJson),
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

const parseComputedTerms = (value: string | null): EurComputedTerm[] => {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((term): term is EurComputedTerm =>
      typeof term === 'object'
      && term !== null
      && typeof term.id === 'string'
      && (term.sign === 1 || term.sign === -1),
    );
  } catch {
    return [];
  }
};

export const validateAndLoadCatalog = (year: number): EurLineDef[] => {
  return getCatalogForYear(year);
};
