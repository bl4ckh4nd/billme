import { getPublicReportCatalogsIncludingUnverified } from './catalogs/publicReportCatalogs';

export type ReportMappingCatalogStatement = 'bwa01' | 'management-guv' | 'hgb-guv' | 'hgb-bilanz';
export type ReportMappingCatalogSide = 'asset' | 'liability';

export interface ReportMappingCatalogPosition {
  key: string;
  label: string;
  kind: 'heading' | 'line' | 'subtotal' | 'result';
  side?: ReportMappingCatalogSide;
}

const managementPositions: ReportMappingCatalogPosition[] = [
  { key: 'revenue', label: 'Betriebliche Erlöse', kind: 'line' },
  { key: 'variable-costs', label: 'Variable Kosten', kind: 'line' },
  { key: 'contribution-margin', label: 'Deckungsbeitrag', kind: 'subtotal' },
  { key: 'personnel-costs', label: 'Personalkosten', kind: 'line' },
  { key: 'fixed-costs', label: 'Fixkosten', kind: 'line' },
  { key: 'ebitda', label: 'EBITDA', kind: 'subtotal' },
  { key: 'depreciation', label: 'Abschreibungen', kind: 'line' },
  { key: 'ebit', label: 'EBIT', kind: 'subtotal' },
  { key: 'financial-result', label: 'Finanzergebnis', kind: 'line' },
  { key: 'taxes', label: 'Steuern', kind: 'line' },
  { key: 'net-result', label: 'Managementergebnis', kind: 'result' },
];

const sideForBilanzKey = (key: string): ReportMappingCatalogSide | undefined => {
  if (key.startsWith('assets.')) return 'asset';
  if (key.startsWith('equity') || key.startsWith('provisions') || key === 'liabilities' || key.startsWith('liabilities.')) return 'liability';
  return undefined;
};

export const listReportMappingPositions = (
  statement: ReportMappingCatalogStatement,
  size: 'micro' | 'small' = 'small',
): ReportMappingCatalogPosition[] => {
  if (statement === 'management-guv') return managementPositions.map((position) => ({ ...position }));
  const kind = statement === 'hgb-bilanz' ? 'bilanz' : statement === 'hgb-guv' ? 'gkv' : 'bwa01';
  const catalog = getPublicReportCatalogsIncludingUnverified(2025).find((entry) => entry.kind === kind && entry.scope === size);
  if (!catalog) throw new Error(`REPORT_MAPPING_CATALOG_UNAVAILABLE:${statement}:${size}`);
  return catalog.positions.map((position) => ({
    key: position.key,
    label: position.label,
    kind: position.kind,
    ...(statement === 'hgb-bilanz' && sideForBilanzKey(position.key) ? { side: sideForBilanzKey(position.key) } : {}),
  }));
};
