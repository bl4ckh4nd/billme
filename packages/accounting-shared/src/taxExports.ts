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
  /** Journal identity for the drilldown from a Kennzahl to its entries. */
  entryId?: string;
  entryNumber?: number;
  reference?: string;
  sourceType?: string;
};

export type TaxExportPeriod = {
  /** YYYY-MM, YYYY-Q1..Q4, or YYYY for an annual preparation. */
  period: string;
  year?: number;
  from?: string;
  to?: string;
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

/** One Kennzahl of the UStVA; Kz 83 (direction `total`) is the Zahllast, output tax minus input tax. */
export type UstvaRow = {
  kennziffer: string;
  /** The Kennzahl of the tax next to a basis Kennzahl (46 → 47, 84 → 85). */
  taxKennziffer?: string;
  label: string;
  direction: 'output' | 'input' | 'information' | 'total';
  netAmount: number;
  taxAmount: number;
  lineCount: number;
  taxCaseKeys: TaxCaseKey[];
};

/** A journal line behind a Kennzahl. */
export type UstvaSource = {
  kennziffer: string;
  direction: 'output' | 'input' | 'information';
  entryId?: string;
  entryNumber?: number;
  postingDate: string;
  reference?: string;
  sourceType?: string;
  taxCaseKey: TaxCaseKey;
  netAmount: number;
  taxAmount: number;
};

/** The Kennzahlen of the official form of a year; a later year runs on the latest form, marked provisional. */
export type UstvaKennzahlCatalog = TaxCatalogProvenance & { formYear: number; provisional: boolean; label: string };

export type UstvaComputation = {
  rows: UstvaRow[];
  sources: UstvaSource[];
  issues: Array<{ code: string; message: string; taxCaseKey?: string; entryId?: string }>;
  outputTaxAmount: number;
  inputTaxAmount: number;
  payableAmount: number;
};

export type UstvaArtifact = TaxExportArtifactBase & UstvaComputation & {
  kind: 'ustva';
  catalog: UstvaKennzahlCatalog;
};

export type ZmRow = {
  taxCaseKey: Extract<TaxCaseKey, 'EU_IGL_GOODS_0' | 'EU_B2B_SERVICE_RC'>;
  /** ZM column: innergemeinschaftliche Lieferung or sonstige Leistung (§ 18a UStG). */
  kind: 'lieferung' | 'sonstige_leistung';
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
  | 'USTVA_KENNZAHL_MISSING'
  | 'CATALOG_PROVENANCE_INVALID'
  | 'MISSING_EVIDENCE'
  | 'INVALID_COUNTRY'
  | 'INVALID_VAT_ID'
  | 'INVALID_RATE'
  | 'REPORT_SNAPSHOT_REQUIRED'
  | 'REPORT_SNAPSHOT_MISMATCH'
  | 'PROVIDER_CATALOG_UNAVAILABLE';
