import lines2025 from './eur/lines-2025.json';
import lines2026 from './eur/lines-2026.json';

export type EurLineKind = 'income' | 'expense' | 'computed';

export type EurComputedTerm = {
  id: string;
  sign: 1 | -1;
};

export type CatalogManifest = {
  id: string;
  title: string;
  version: string;
  validFrom: string;
  validTo: string;
  sourceName: string;
  sourceUrl: string;
  sha256: string;
  scope: 'de-sole-proprietor';
  delivery: 'print-form-only' | 'elster-ready';
  elsterReady: boolean;
  /** A year without its own published form, calculated with the newest one. */
  provisional?: boolean;
};

export type EurLineDef = {
  year: number;
  id: string;
  kennziffer: string;
  label: string;
  kind: EurLineKind;
  exportable: boolean;
  computedFromIds?: string[];
  computedTerms?: EurComputedTerm[];
  role?: 'tax_adjustment' | 'tax_result' | 'form_metadata';
  lineNumber?: number;
  providerPath?: string;
  scope?: 'de-sole-proprietor' | 'luf' | 'corporation';
  unsupportedReason?: string;
};

export const EUR_SOURCE_VERSION_2025 = 'BMF-2025-2025-08-29';
export const EUR_SOURCE_URL_2025 = 'https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2025-08-29-anlage-EUER-2025.pdf?__blob=publicationFile&v=3';
export const EUR_SOURCE_VERSION_2026 = 'BMF-2026-2026-09-01';
export const EUR_SOURCE_URL_2026 = 'https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2026-09-01-anlage-EUER-2026.pdf?__blob=publicationFile&v=4';
export const EUR_CATALOG_MANIFEST_2025: CatalogManifest = {
  id: 'anlage-euer-2025',
  title: 'Anlage EÜR 2025',
  version: EUR_SOURCE_VERSION_2025,
  validFrom: '2025-01-01',
  validTo: '2025-12-31',
  sourceName: 'Bundesministerium der Finanzen',
  sourceUrl: EUR_SOURCE_URL_2025,
  // SHA-256 of the BMF source PDF. Recompute when the source changes.
  sha256: 'b69b5cf0a982d28cbce20644e67677a36be0bc494bed4fae2310dc08230a1599',
  scope: 'de-sole-proprietor',
  delivery: 'print-form-only',
  elsterReady: false,
};

export const EUR_CATALOG_MANIFEST_2026: CatalogManifest = {
  id: 'anlage-euer-2026',
  title: 'Anlage EÜR 2026',
  version: EUR_SOURCE_VERSION_2026,
  validFrom: '2026-01-01',
  validTo: '2026-12-31',
  sourceName: 'Bundesministerium der Finanzen',
  sourceUrl: EUR_SOURCE_URL_2026,
  // SHA-256 of the BMF source PDF (BMF-Schreiben vom 01.09.2026). Same Kennziffern as 2025; from form line 27
  // on the line numbers are one higher (new LuF line 27).
  sha256: '03d3033acc5c5a126729e58743128596ae39193759c55b207872da9432b83a8f',
  scope: 'de-sole-proprietor',
  delivery: 'print-form-only',
  elsterReady: false,
};

/** The newest bundled form; a later year without its own form is calculated with it, marked provisional. */
export const LATEST_EUR_CATALOG_YEAR = 2026;
const catalogYear = (year: number): number => (Number.isInteger(year) && year > LATEST_EUR_CATALOG_YEAR ? LATEST_EUR_CATALOG_YEAR : year);

export const getCatalogForYear = (requested: number): EurLineDef[] => {
  const year = catalogYear(requested);
  if (year === 2025) {
    const lines = lines2025 as EurLineDef[];
    validateEurLineCatalog(lines);
    return lines;
  }
  if (year === 2026) {
    const lines = lines2026 as EurLineDef[];
    validateEurLineCatalog(lines);
    return lines;
  }
  throw new Error(`EUR_CATALOG_UNAVAILABLE:${year}`);
};

export const getCatalogManifestForYear = (year: number): CatalogManifest => {
  if (year === 2025) return EUR_CATALOG_MANIFEST_2025;
  if (year === 2026) return EUR_CATALOG_MANIFEST_2026;
  if (catalogYear(year) !== year) {
    const latest = EUR_CATALOG_MANIFEST_2026;
    return { ...latest, title: `${latest.title} (vorläufig für ${year})`, validFrom: `${year}-01-01`, validTo: `${year}-12-31`, provisional: true };
  }
  throw new Error(`EUR_CATALOG_UNAVAILABLE:${year}`);
};

export const validateEurLineCatalog = (lines: EurLineDef[]): void => {
  const ids = new Set<string>();
  const kzs = new Set<string>();

  for (const line of lines) {
    if (!Number.isInteger(line.year) || line.year < 2000) {
      throw new Error(`Invalid EÜR line year: ${line.id}`);
    }
    if (!line.id.trim() || !line.label.trim()) {
      throw new Error(`Invalid EÜR line metadata: ${line.id}`);
    }
    if (line.lineNumber !== undefined && (!Number.isInteger(line.lineNumber) || line.lineNumber < 1 || line.lineNumber > 107)) {
      throw new Error(`Invalid EÜR form line number: ${line.id}`);
    }
    if (line.providerPath !== undefined && !line.providerPath.trim()) {
      throw new Error(`Invalid EÜR provider path: ${line.id}`);
    }
    if (line.scope === 'luf' && !line.unsupportedReason?.trim()) {
      throw new Error(`Unsupported LuF EÜR line requires a reason: ${line.id}`);
    }
    if (!['income', 'expense', 'computed'].includes(line.kind)) {
      throw new Error(`Invalid EÜR line kind: ${line.id}`);
    }
    if (ids.has(line.id)) {
      throw new Error(`Duplicate EÜR line id: ${line.id}`);
    }
    ids.add(line.id);

    const kz = line.kennziffer?.trim();
    if (kz) {
      const key = `${line.year}:${line.providerPath ?? 'main'}:${kz}`;
      if (kzs.has(key)) {
        throw new Error(`Duplicate EÜR Kennziffer in provider path ${line.providerPath ?? 'main'}: ${kz}`);
      }
      kzs.add(key);
    }
  }

  for (const line of lines) {
    if (line.kind !== 'computed') {
      if ((line.computedFromIds?.length ?? 0) > 0 || (line.computedTerms?.length ?? 0) > 0) {
        throw new Error(`Direct EÜR line cannot have computed terms: ${line.id}`);
      }
      continue;
    }
    const termIds = [
      ...(line.computedFromIds ?? []),
      ...(line.computedTerms ?? []).map((term) => term.id),
    ];
    for (const term of line.computedTerms ?? []) {
      if (term.sign !== 1 && term.sign !== -1) {
        throw new Error(`Invalid computed term sign in EÜR line ${line.id}`);
      }
    }
    for (const childId of termIds) {
      if (!ids.has(childId)) {
        throw new Error(`Computed line ${line.id} references missing id: ${childId}`);
      }
    }
  }

  const byId = new Map(lines.map((line) => [line.id, line]));
  const visited = new Set<string>();
  const stack = new Set<string>();

  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (stack.has(id)) {
      throw new Error(`Cycle detected in computed EÜR lines at: ${id}`);
    }
    stack.add(id);
    const line = byId.get(id);
    if (line?.kind === 'computed') {
      for (const child of [
        ...(line.computedFromIds ?? []),
        ...(line.computedTerms ?? []).map((term) => term.id),
      ]) {
        visit(child);
      }
    }
    stack.delete(id);
    visited.add(id);
  };

  for (const line of lines) {
    visit(line.id);
  }
};

export const validateCatalogManifest = (manifest: CatalogManifest): void => {
  if (!manifest.id.trim() || !manifest.title.trim() || !manifest.version.trim()) {
    throw new Error('Catalog manifest requires id, title, and version');
  }
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (!date.test(manifest.validFrom) || !date.test(manifest.validTo) || manifest.validFrom > manifest.validTo) {
    throw new Error(`Invalid catalog validity: ${manifest.id}`);
  }
  if (!manifest.sourceName.trim() || !/^https?:\/\//.test(manifest.sourceUrl) || manifest.scope !== 'de-sole-proprietor') {
    throw new Error(`Catalog manifest source is incomplete: ${manifest.id}`);
  }
  if (!/^[a-f0-9]{64}$/i.test(manifest.sha256)) {
    throw new Error(`Invalid catalog SHA-256: ${manifest.id}`);
  }
  if (!['print-form-only', 'elster-ready'].includes(manifest.delivery) || manifest.elsterReady !== (manifest.delivery === 'elster-ready')) {
    throw new Error(`Invalid catalog delivery status: ${manifest.id}`);
  }
};

validateCatalogManifest(EUR_CATALOG_MANIFEST_2025);
validateCatalogManifest(EUR_CATALOG_MANIFEST_2026);

export const assertEurElsterReady = (manifest: CatalogManifest = EUR_CATALOG_MANIFEST_2025): void => {
  validateCatalogManifest(manifest);
  if (!manifest.elsterReady) throw new Error(`EUR_ELSTER_CATALOG_UNAVAILABLE:${manifest.id}`);
};
