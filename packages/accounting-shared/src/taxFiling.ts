/**
 * Product-neutral contract for a legally relevant tax filing.
 *
 * A filing deliberately stores the payload used for transmission as a
 * snapshot.  Consumers must never rebuild a frozen/approved filing from
 * mutable ledger rows: the hash is the source identity for retries and
 * provider acknowledgements.
 */
export type TaxFilingKind = 'euer' | 'e_bilanz' | 'unternehmensregister';

export type TaxFilingProvider = 'eric_euer' | 'eric_e_bilanz' | 'unternehmensregister';

export type TaxFilingStatus =
  | 'draft'
  | 'validated'
  | 'frozen'
  | 'pending_second_approval'
  | 'approved'
  | 'queued'
  | 'transmitting'
  | 'accepted'
  | 'rejected'
  | 'retryable_failed';

export type TaxFilingFailureCode =
  | 'PROVIDER_UNAVAILABLE'
  | 'CREDENTIAL_UNAVAILABLE'
  | 'VALIDATION_FAILED'
  | 'TRANSMISSION_FAILED'
  | 'PROVIDER_REJECTED'
  | 'EUR_ELSTER_CATALOG_UNAVAILABLE'
  | 'E_BILANZ_TAXONOMY_CATALOG_UNAVAILABLE'
  | 'UNTERNEHMENSREGISTER_PROVIDER_CONTRACT_UNAVAILABLE';

export interface TaxFilingSnapshot {
  kind: TaxFilingKind;
  periodStart: string;
  periodEnd: string;
  /** Canonical provider document (ERiC XML or Unternehmensregister payload). */
  payload: Record<string, unknown>;
}

export interface TaxFilingRecord {
  id: string;
  tenantId: string;
  kind: TaxFilingKind;
  provider: TaxFilingProvider;
  periodStart: string;
  periodEnd: string;
  status: TaxFilingStatus;
  snapshot: TaxFilingSnapshot;
  snapshotHash: string;
  idempotencyKey: string;
  lastMutationIdempotencyKey?: string;
  lastMutationAction?: TaxFilingAction;
  createdByActorId: string;
  approvalRequestedByActorId?: string;
  approvalRequestedAt?: string;
  validatedByActorId?: string;
  frozenByActorId?: string;
  approvedByActorId?: string;
  queuedByActorId?: string;
  transmittingByActorId?: string;
  completedByActorId?: string;
  providerSubmissionId?: string;
  providerReference?: string;
  failureCode?: TaxFilingFailureCode;
  failureMessage?: string;
  createdAt: string;
  updatedAt: string;
  validatedAt?: string;
  frozenAt?: string;
  approvedAt?: string;
  queuedAt?: string;
  transmittingAt?: string;
  completedAt?: string;
}

export interface TaxFilingMutation {
  actorId: string;
  reason: string;
  /** Required for every state-changing request, including a replay. */
  idempotencyKey: string;
  now?: string;
}

export type TaxFilingAction =
  | 'validate'
  | 'freeze'
  | 'request_second_approval'
  | 'approve'
  | 'queue'
  | 'transmitting'
  | 'accept'
  | 'reject'
  | 'fail_retryable'
  | 'retry';

export interface TaxFilingProviderInput {
  tenantId: string;
  filingId: string;
  kind: TaxFilingKind;
  snapshot: TaxFilingSnapshot;
  snapshotHash: string;
  /** Provider implementation resolves credentials without exposing them to callers. */
  credential?: unknown;
}

export interface TaxFilingProviderResult {
  status: 'accepted' | 'rejected' | 'retryable_failed';
  providerSubmissionId?: string;
  providerReference?: string;
  failureCode?: TaxFilingFailureCode;
  message?: string;
}

export interface TaxFilingProviderPort {
  provider: TaxFilingProvider;
  submit(input: TaxFilingProviderInput): Promise<TaxFilingProviderResult>;
}
