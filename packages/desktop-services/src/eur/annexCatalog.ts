import annexCatalog2025 from './annexes-2025.json';
import annexCatalog2026 from './annexes-2026.json';
import {
  calculateEurAnnexValues,
  type EurAnnexValueFact,
  type EurAnnexValueOptions,
  type EurAnnexValueResult,
} from '@billme/accounting-shared';
import {
  validateCatalogManifest,
  type CatalogManifest,
} from '../eurCatalog';

export type EurAnnexId = 'AVEÜR' | 'SZ';
export type EurAnnexLineKind = 'input' | 'computed' | 'choice';

export type EurAnnexLineDef = {
  id: string;
  lineNumber: number;
  kennziffer?: string;
  label: string;
  kind: EurAnnexLineKind;
  operation?: 'sum' | 'min' | 'max';
  computedFromIds?: string[];
  computedTerms?: Array<{ id: string; sign: 1 | -1 }>;
};

export type EurAnnexCatalog = {
  year: number;
  id: EurAnnexId;
  title: string;
  scope: 'de-sole-proprietor';
  lines: EurAnnexLineDef[];
  manifest: CatalogManifest;
};

type AnnexSource = {
  year: number;
  sourceVersion: string;
  sourceName: string;
  sourceUrl: string;
  sourceSha256: string;
  validFrom: string;
  validTo: string;
  scope: 'de-sole-proprietor';
  annexes: Array<{ id: EurAnnexId; title: string; lines: EurAnnexLineDef[] }>;
};
const annexSources: Record<number, AnnexSource> = {
  2025: annexCatalog2025 as AnnexSource,
  2026: annexCatalog2026 as AnnexSource,
};

const manifestFor = (year: number, annex: EurAnnexId, source: AnnexSource): CatalogManifest => ({
  id: `anlage-${annex.toLowerCase()}-${year}`,
  title: source.annexes.find((entry) => entry.id === annex)?.title ?? annex,
  version: source.sourceVersion,
  validFrom: source.validFrom,
  validTo: source.validTo,
  sourceName: source.sourceName,
  sourceUrl: source.sourceUrl,
  sha256: source.sourceSha256,
  scope: 'de-sole-proprietor',
  delivery: 'print-form-only',
  elsterReady: false,
});

const validateLines = (annex: EurAnnexId, lines: EurAnnexLineDef[]): void => {
  const ids = new Set<string>();
  const kzs = new Set<string>();
  const byId = new Map<string, EurAnnexLineDef>();

  for (const line of lines) {
    if (ids.has(line.id)) throw new Error(`Duplicate ${annex} line id: ${line.id}`);
    if (!Number.isInteger(line.lineNumber) || line.lineNumber <= 0) throw new Error(`Invalid ${annex} line number: ${line.id}`);
    if (!line.label.trim()) throw new Error(`Invalid ${annex} line label: ${line.id}`);
    if (!['input', 'computed', 'choice'].includes(line.kind)) throw new Error(`Invalid ${annex} line kind: ${line.id}`);
    ids.add(line.id);
    byId.set(line.id, line);
    if (line.kennziffer) {
      if (kzs.has(line.kennziffer)) throw new Error(`Duplicate ${annex} Kennziffer: ${line.kennziffer}`);
      kzs.add(line.kennziffer);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Cycle detected in ${annex} lines at: ${id}`);
    visiting.add(id);
    const line = byId.get(id);
    for (const term of line?.computedTerms ?? []) {
      if (term.sign !== 1 && term.sign !== -1) throw new Error(`Invalid ${annex} term sign: ${line.id}`);
    }
    for (const childId of [
      ...(line?.computedFromIds ?? []),
      ...(line?.computedTerms ?? []).map((term) => term.id),
    ]) {
      if (!byId.has(childId)) throw new Error(`${annex} line ${id} references missing id: ${childId}`);
      visit(childId);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const line of lines) visit(line.id);
};

export const validateEurAnnexCatalog = (catalog: EurAnnexCatalog): void => {
  if (![2025, 2026].includes(catalog.year) || !['AVEÜR', 'SZ'].includes(catalog.id)) {
    throw new Error(`Unsupported EÜR annex catalog: ${catalog.id}:${catalog.year}`);
  }
  if (catalog.scope !== 'de-sole-proprietor') throw new Error(`Unsupported EÜR annex scope: ${catalog.id}`);
  validateCatalogManifest(catalog.manifest);
  validateLines(catalog.id, catalog.lines);
};

export const getEurAnnexCatalog = (year: number, annex: EurAnnexId): EurAnnexCatalog => {
  const annexSource = annexSources[year];
  if (!annexSource) throw new Error(`EUR_ANNEX_CATALOG_UNAVAILABLE:${year}`);
  const source = annexSource.annexes.find((entry) => entry.id === annex);
  if (!source) throw new Error(`EUR_ANNEX_CATALOG_UNAVAILABLE:${annex}:${year}`);
  const catalog: EurAnnexCatalog = {
    year,
    id: source.id,
    title: source.title,
    scope: annexSource.scope,
    lines: source.lines,
    manifest: manifestFor(year, source.id, annexSource),
  };
  validateEurAnnexCatalog(catalog);
  return catalog;
};

export const getEurAnnexCatalogsForYear = (year: number): EurAnnexCatalog[] => {
  if (!annexSources[year]) throw new Error(`EUR_ANNEX_CATALOG_UNAVAILABLE:${year}`);
  return (['AVEÜR', 'SZ'] as const).map((annex) => getEurAnnexCatalog(year, annex));
};

export const calculateEurAnnexFacts = (
  year: number,
  annex: EurAnnexId,
  facts: readonly EurAnnexValueFact[],
  options: Omit<EurAnnexValueOptions, 'taxYear'> = {},
): EurAnnexValueResult => {
  const catalog = getEurAnnexCatalog(year, annex);
  const requiredLineIds = options.requiredLineIds ?? catalog.lines.filter((line) => line.kind !== 'computed').map((line) => line.id);
  return calculateEurAnnexValues(catalog.lines, facts, { ...options, requiredLineIds, taxYear: year });
};

export const calculateEurAnnexTotals = calculateEurAnnexFacts;

export const getAnnexCatalogForYear = getEurAnnexCatalog;
export const listEurAnnexCatalogs = getEurAnnexCatalogsForYear;
