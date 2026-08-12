export type TaxFilingKind = 'euer' | 'e_bilanz' | 'unternehmensregister';
export type TaxFilingOperation = 'validate' | 'export' | 'submit';

export type TaxFilingProviderStatus = {
  available: boolean;
  provider: 'eric' | null;
  version?: string;
  binaryPath?: string;
  errorCode?: 'PROVIDER_UNAVAILABLE' | 'PROVIDER_INVALID';
};

export type TaxCertificateMetadata = {
  id: string;
  fingerprint: string;
  expiresAt: string;
  subject?: string;
};

/** Immutable snapshot metadata fetched from a server/local filing record. */
export type TaxFilingSnapshot = {
  id: string;
  kind: TaxFilingKind;
  periodStart: string;
  periodEnd: string;
  payload: Record<string, unknown>;
  sourceHash: string;
  status: 'frozen' | 'approved' | 'queued';
};

export type TaxFilingIssue = {
  code: string;
  message: string;
  field?: string;
};

export type TaxFilingResult = {
  operation: TaxFilingOperation;
  status: 'validated' | 'exported' | 'submitted' | 'failed';
  sourceHash: string;
  outputPath?: string;
  issues: TaxFilingIssue[];
};

/** Opaque server-issued grant; the desktop never creates or verifies one locally. */
export type TaxFilingApprovalGrant = {
  token: string;
  grantId: string;
  sourceHash: string;
  expiresAt: string;
  singleUse: true;
};

export type TaxFilingRecordMetadata = Pick<TaxFilingSnapshot, 'id' | 'kind' | 'periodStart' | 'periodEnd' | 'sourceHash' | 'status'>;
