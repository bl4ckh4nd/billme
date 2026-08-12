import { getManagementReportCatalogs, getPublicReportCatalogsIncludingUnverified } from './catalogs/publicReportCatalogs';

export type ReportMappingCatalogStatement = 'bwa01' | 'management-guv' | 'hgb-guv' | 'hgb-bilanz';
export type ReportMappingCatalogSide = 'asset' | 'liability';

export interface ReportMappingCatalogPosition {
  key: string;
  label: string;
  kind: 'heading' | 'line' | 'subtotal' | 'result';
  side?: ReportMappingCatalogSide;
}

const yearForCatalogDate = (asOfDate: string): number => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOfDate);
  if (!match) throw new Error(`REPORT_MAPPING_DATE_INVALID:${asOfDate}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!daysInMonth || day < 1 || day > daysInMonth) throw new Error(`REPORT_MAPPING_DATE_INVALID:${asOfDate}`);
  return year;
};

const sideForBilanzKey = (key: string): ReportMappingCatalogSide | undefined => {
  if (key.startsWith('assets.')) return 'asset';
  if (key.startsWith('equity') || key.startsWith('provisions') || key === 'liabilities' || key.startsWith('liabilities.')) return 'liability';
  return undefined;
};

export const listReportMappingPositions = (
  statement: ReportMappingCatalogStatement,
  size: 'micro' | 'small' = 'small',
  asOfDate: string,
): ReportMappingCatalogPosition[] => {
  const year = yearForCatalogDate(asOfDate);
  if (statement === 'management-guv') {
    const catalog = getManagementReportCatalogs(year).find((entry) => entry.scope === size);
    if (!catalog) throw new Error(`REPORT_MAPPING_CATALOG_UNAVAILABLE:${statement}:${size}:${year}`);
    return catalog.positions.map((position) => ({ key: position.key, label: position.label, kind: position.kind }));
  }
  const kind = statement === 'hgb-bilanz' ? 'bilanz' : statement === 'hgb-guv' ? 'gkv' : 'bwa01';
  const catalog = getPublicReportCatalogsIncludingUnverified(year).find((entry) => entry.kind === kind && entry.scope === size);
  if (!catalog) throw new Error(`REPORT_MAPPING_CATALOG_UNAVAILABLE:${statement}:${size}:${year}`);
  return catalog.positions.map((position) => ({
    key: position.key,
    label: position.label,
    kind: position.kind,
    ...(statement === 'hgb-bilanz' && sideForBilanzKey(position.key) ? { side: sideForBilanzKey(position.key) } : {}),
  }));
};
