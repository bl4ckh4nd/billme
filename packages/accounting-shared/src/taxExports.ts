import type { TaxCaseKey } from './accounting';
import type { ReportSnapshot } from './reporting';

export type TaxExportDirection = 'output' | 'input';
export type TaxExportStatus = 'prepared' | 'blocked';

/** The small, immutable tax evidence projection consumed by export calculators. */
export type TaxExportLine = {
  taxCaseKey?: TaxCaseKey;
  direction?: TaxExportDirection;
  netAmount?: number;
  taxAmount?: number;
  grossAmount?: number;
  taxRate?: number;
  countryCode?: string;
  counterpartyVatId?: string;
  evidenceType?: string;
  evidenceReference?: string;
  datevSachverhaltLl?: string;
};

export type TaxExportEntry = {
  postingDate: string;
  status: 'posted' | 'reversed';
  lines: TaxExportLine[];
};

export type TaxExportPeriod = {
  /** YYYY-MM, YYYY-Q1..Q4, or YYYY for an annual preparation. */
  period: string;
  year?: number;
};

export type TaxCatalogProvenance = {
  id: string;
  taxYear: number;
  version: string;
  source: string;
  sourceHash: string;
  official?: boolean;
};

export type TaxCatalogEntry = {
  taxCaseKey: TaxCaseKey;
  kennziffer: string;
  direction?: TaxExportDirection;
};

export type UstvaCatalog = TaxCatalogProvenance & {
  entries: TaxCatalogEntry[];
};

export type TaxExportArtifactBase = {
  kind: 'ustva' | 'zm' | 'oss' | 'e_bilanz' | 'unternehmensregister';
  period: TaxExportPeriod;
  status: TaxExportStatus;
  /** Deliberately false until a verified official provider is installed. */
  submissionReady: false;
  /** Preparation/export is not a submission. */
  operation: 'preparation' | 'export';
  exportable: true;
  providerValidation: 'unavailable';
  sourceHash: string;
  warnings: string[];
};

export type TaxReportSnapshotBinding = {
  reportSnapshotId: string;
  sourceSnapshotHash: string;
  snapshot?: ReportSnapshot;
};

export type UstvaRow = {
  taxCaseKey: TaxCaseKey;
  kennziffer: string;
  direction: TaxExportDirection;
  netAmount: number;
  taxAmount: number;
  lineCount: number;
};

export type UstvaArtifact = TaxExportArtifactBase & {
  kind: 'ustva';
  catalog: TaxCatalogProvenance;
  rows: UstvaRow[];
};

export type ZmRow = {
  taxCaseKey: Extract<TaxCaseKey, 'EU_IGL_GOODS_0' | 'EU_B2B_SERVICE_RC'>;
  countryCode: string;
  counterpartyVatId: string;
  netAmount: number;
  lineCount: number;
};

export type ZmArtifact = TaxExportArtifactBase & {
  kind: 'zm';
  rows: ZmRow[];
};

export type OssRow = {
  countryCode: string;
  taxRate: number;
  netAmount: number;
  taxAmount: number;
  lineCount: number;
};

export type OssArtifact = TaxExportArtifactBase & {
  kind: 'oss';
  rows: OssRow[];
};

export type EBilanzArtifact = TaxExportArtifactBase & {
  kind: 'e_bilanz';
  taxonomy: '6.9';
  facts: readonly Record<string, unknown>[];
  reportSnapshot: TaxReportSnapshotBinding;
  catalog: TaxCatalogProvenance;
};

export type UnternehmensregisterArtifact = TaxExportArtifactBase & {
  kind: 'unternehmensregister';
  companyName: string;
  registerNumber: string;
  reportSnapshot: TaxReportSnapshotBinding;
};

export type TaxExportPreparation =
  | UstvaArtifact
  | ZmArtifact
  | OssArtifact
  | EBilanzArtifact
  | UnternehmensregisterArtifact;

export type TaxExportErrorCode =
  | 'INVALID_PERIOD'
  | 'UNSUPPORTED_YEAR'
  | 'UNSUPPORTED_PERIOD'
  | 'MISSING_TAX_CASE'
  | 'TAXONOMY_MISMATCH'
  | 'CATALOG_MISMATCH'
  | 'CATALOG_PROVENANCE_INVALID'
  | 'MISSING_EVIDENCE'
  | 'INVALID_COUNTRY'
  | 'INVALID_VAT_ID'
  | 'INVALID_RATE'
  | 'REPORT_SNAPSHOT_REQUIRED'
  | 'REPORT_SNAPSHOT_MISMATCH'
  | 'PROVIDER_CATALOG_UNAVAILABLE';
