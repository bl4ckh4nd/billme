export type ReportMappingStatement = 'bwa01' | 'management-guv' | 'hgb-guv' | 'hgb-bilanz';
export type ReportMappingSide = 'asset' | 'liability';

export interface ReportMappingMissingAccount {
  accountNumber: string;
  statement: ReportMappingStatement;
}

export interface ReportMappingHealth {
  chart: 'SKR03' | 'SKR04';
  unmapped: ReportMappingMissingAccount[];
}

/** A position is supplied by the canonical server/desktop catalog. */
export interface ReportMappingPosition {
  key: string;
  label: string;
  side?: ReportMappingSide;
  kind?: 'heading' | 'line' | 'subtotal' | 'result';
}

export interface ReportMappingOverrideInput {
  chart: 'SKR03' | 'SKR04';
  accountNumber: string;
  statement: ReportMappingStatement;
  position: string;
  label: string;
  side?: ReportMappingSide;
  reason: string;
}

export const REPORT_MAPPING_STATEMENTS: ReadonlyArray<{ value: ReportMappingStatement; label: string }> = [
  { value: 'bwa01', label: 'BWA01' },
  { value: 'management-guv', label: 'Management-GuV' },
  { value: 'hgb-guv', label: 'HGB-GuV' },
  { value: 'hgb-bilanz', label: 'HGB-Bilanz' },
];

export const reportMappingStatementLabel = (statement: ReportMappingStatement): string =>
  REPORT_MAPPING_STATEMENTS.find((entry) => entry.value === statement)?.label ?? statement;
