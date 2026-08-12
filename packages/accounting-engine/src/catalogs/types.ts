export type PublicReportKind = 'bilanz' | 'gkv' | 'bwa01';
export type PublicReportScope = 'micro' | 'small';
export type PublicReportPositionKind = 'heading' | 'line' | 'subtotal' | 'result';

export type CatalogProvenance = {
  version: string;
  validFrom: string;
  validTo?: string;
  sourceName: string;
  sourceUrl: string;
  sourceSha256?: string;
  sourceHashStatus: 'verified' | 'unavailable';
};

export type PublicReportPosition = {
  id: string;
  key: string;
  label: string;
  order: number;
  kind: PublicReportPositionKind;
  parentKey?: string;
  scopes: PublicReportScope[];
};

export type PublicReportCatalog = {
  id: string;
  title: string;
  kind: PublicReportKind;
  scope: PublicReportScope;
  provenance: CatalogProvenance;
  positions: PublicReportPosition[];
  mappingStatus: 'public-structure-only';
};

export const validateCatalogProvenance = (provenance: CatalogProvenance): void => {
  const date = /^\d{4}-\d{2}-\d{2}$/;
  if (!provenance.version.trim() || !date.test(provenance.validFrom) || (provenance.validTo !== undefined && (!date.test(provenance.validTo) || provenance.validFrom > provenance.validTo))) {
    throw new Error('Invalid report catalog provenance');
  }
  if (!provenance.sourceName.trim() || !/^https?:\/\//.test(provenance.sourceUrl)) {
    throw new Error('Report catalog source is incomplete');
  }
  if (!['verified', 'unavailable'].includes(provenance.sourceHashStatus)) {
    throw new Error('Report catalog source hash status is invalid');
  }
  if (provenance.sourceHashStatus === 'verified' && !/^[a-f0-9]{64}$/i.test(provenance.sourceSha256 ?? '')) {
    throw new Error('Report catalog source hash is missing or invalid');
  }
  if (provenance.sourceHashStatus === 'unavailable' && provenance.sourceSha256 !== undefined) {
    throw new Error('Unavailable report catalog source must not claim a hash');
  }
};

export const validatePublicReportCatalog = (catalog: PublicReportCatalog): void => {
  if (!catalog.id.trim() || !catalog.title.trim()) throw new Error('Report catalog requires id and title');
  if (!['bilanz', 'gkv', 'bwa01'].includes(catalog.kind)) throw new Error(`Invalid report catalog kind: ${catalog.id}`);
  if (!['micro', 'small'].includes(catalog.scope)) throw new Error(`Invalid report catalog scope: ${catalog.id}`);
  if (catalog.mappingStatus !== 'public-structure-only') throw new Error(`Private account mappings are not allowed in ${catalog.id}`);
  validateCatalogProvenance(catalog.provenance);
  if (catalog.provenance.sourceHashStatus !== 'verified') throw new Error(`Report catalog source is not verified: ${catalog.id}`);

  const ids = new Set<string>();
  const keys = new Set<string>();
  const byKey = new Map<string, PublicReportPosition>();
  for (const position of catalog.positions) {
    if (ids.has(position.id)) throw new Error(`Duplicate report position id: ${position.id}`);
    if (keys.has(position.key)) throw new Error(`Duplicate report position key: ${position.key}`);
    if (!position.label.trim() || !Number.isInteger(position.order) || position.order < 0) {
      throw new Error(`Invalid report position: ${position.id}`);
    }
    if (!['heading', 'line', 'subtotal', 'result'].includes(position.kind)) {
      throw new Error(`Invalid report position kind: ${position.id}`);
    }
    if (position.scopes.length === 0 || position.scopes.some((scope) => !['micro', 'small'].includes(scope))) {
      throw new Error(`Invalid report position scope: ${position.id}`);
    }
    ids.add(position.id);
    keys.add(position.key);
    byKey.set(position.key, position);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visited.has(key)) return;
    if (visiting.has(key)) throw new Error(`Cycle detected in report positions at: ${key}`);
    visiting.add(key);
    const position = byKey.get(key);
    if (position?.parentKey) {
      if (!byKey.has(position.parentKey)) throw new Error(`Missing report parent ${position.parentKey} for ${position.id}`);
      visit(position.parentKey);
    }
    visiting.delete(key);
    visited.add(key);
  };
  for (const position of catalog.positions) visit(position.key);
};
