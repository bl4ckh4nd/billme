import { createHash } from 'node:crypto';
import type {
  TaxFilingAction,
  TaxFilingKind,
  TaxFilingMutation,
  TaxFilingProvider,
  TaxFilingRecord,
  TaxFilingSnapshot,
  TaxFilingStatus,
} from '@billme/accounting-shared';

export type TaxFilingErrorCode =
  | 'INVALID_TRANSITION'
  | 'VALIDATION_FAILED'
  | 'SELF_APPROVAL_FORBIDDEN'
  | 'SNAPSHOT_IMMUTABLE'
  | 'IDEMPOTENCY_KEY_REQUIRED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CONCURRENT_UPDATE'
  | 'REASON_REQUIRED'
  | 'EUR_ELSTER_CATALOG_UNAVAILABLE'
  | 'E_BILANZ_TAXONOMY_CATALOG_UNAVAILABLE'
  | 'UNTERNEHMENSREGISTER_PROVIDER_CONTRACT_UNAVAILABLE';

export class TaxFilingError extends Error {
  readonly code: TaxFilingErrorCode;

  constructor(code: TaxFilingErrorCode, message: string) {
    super(message);
    this.name = 'TaxFilingError';
    this.code = code;
  }
}

/** Deterministic JSON encoding used as the legally relevant snapshot identity. */
export const stableTaxFilingStringify = (value: unknown): string => {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableTaxFilingStringify).join(',')}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableTaxFilingStringify(object[key])}`)
    .join(',')}}`;
};

export const computeTaxFilingSnapshotHash = (snapshot: TaxFilingSnapshot): string =>
  createHash('sha256').update(stableTaxFilingStringify(snapshot)).digest('hex');

const snapshotSourceHash = (snapshot: TaxFilingSnapshot): string | undefined => {
  const value = snapshot.payload.sourceSnapshotHash;
  return typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value) ? value : undefined;
};

/**
 * The supported 2025 filing contract is intentionally narrow. It binds every
 * filing to a report/source snapshot and avoids silently transmitting a
 * payload from another tax year or taxonomy. Provider binaries still remain
 * a separate fail-closed seam.
 */
export const validateTaxFilingSnapshot = (snapshot: TaxFilingSnapshot): void => {
  const payload = snapshot.payload;
  if (payload.taxYear !== 2025) {
    throw new TaxFilingError('VALIDATION_FAILED', 'Only the 2025 tax filing contract is supported');
  }
  if (!snapshotSourceHash(snapshot)) {
    throw new TaxFilingError('VALIDATION_FAILED', 'Tax filing must reference an immutable report snapshot hash');
  }
  if (typeof payload.reportSnapshotId !== 'string' || !payload.reportSnapshotId.trim()) {
    throw new TaxFilingError('VALIDATION_FAILED', 'Tax filing must reference a report snapshot id');
  }
  if (snapshot.kind === 'euer') {
    // The bundled EÜR catalog is print-form-only. It is not an ELSTER/ERiC
    // provider contract, so accepting this state would falsely imply that a
    // filing can be transmitted. Keep the provider seam fail-closed until a
    // verified catalog and signed ERiC adapter are installed.
    throw new TaxFilingError('EUR_ELSTER_CATALOG_UNAVAILABLE', 'EÜR ELSTER catalog/provider is unavailable');
  } else if (snapshot.kind === 'e_bilanz') {
    if (payload.taxonomy !== '6.9' || !Array.isArray(payload.facts)) {
      throw new TaxFilingError('VALIDATION_FAILED', 'E-Bilanz requires taxonomy 6.9 facts');
    }
    throw new TaxFilingError('E_BILANZ_TAXONOMY_CATALOG_UNAVAILABLE', 'E-Bilanz taxonomy 6.9 catalog/provider contract is unavailable');
  } else {
    if (
      typeof payload.companyName !== 'string' ||
      !payload.companyName.trim() ||
      typeof payload.registerNumber !== 'string' ||
      !payload.registerNumber.trim()
    ) {
      throw new TaxFilingError('VALIDATION_FAILED', 'Unternehmensregister requires company and register identity');
    }
    throw new TaxFilingError('UNTERNEHMENSREGISTER_PROVIDER_CONTRACT_UNAVAILABLE', 'Unternehmensregister provider contract is unavailable');
  }
};

export const createTaxFilingRecord = (input: {
  id: string;
  tenantId: string;
  provider: TaxFilingProvider;
  snapshot: TaxFilingSnapshot;
  snapshotHash?: string;
  idempotencyKey: string;
  actorId: string;
  now: string;
}): TaxFilingRecord => {
  if (!input.idempotencyKey.trim()) {
    throw new TaxFilingError('IDEMPOTENCY_KEY_REQUIRED', 'Tax filing creation requires an idempotency key');
  }
  if (!input.actorId.trim()) {
    throw new TaxFilingError('REASON_REQUIRED', 'Tax filing creation requires an actor');
  }
  const snapshotHash = computeTaxFilingSnapshotHash(input.snapshot);
  if (input.snapshotHash && input.snapshotHash !== snapshotHash) {
    throw new TaxFilingError('SNAPSHOT_IMMUTABLE', 'Tax filing snapshot hash does not match payload');
  }
  return {
    id: input.id,
    tenantId: input.tenantId,
    kind: input.snapshot.kind,
    provider: input.provider,
    periodStart: input.snapshot.periodStart,
    periodEnd: input.snapshot.periodEnd,
    status: 'draft',
    snapshot: input.snapshot,
    snapshotHash,
    idempotencyKey: input.idempotencyKey,
    createdByActorId: input.actorId,
    createdAt: input.now,
    updatedAt: input.now,
  };
};

const NEXT_STATUS: Readonly<Record<TaxFilingAction, { from: TaxFilingStatus; to: TaxFilingStatus }>> = {
  validate: { from: 'draft', to: 'validated' },
  freeze: { from: 'validated', to: 'frozen' },
  request_second_approval: { from: 'frozen', to: 'pending_second_approval' },
  approve: { from: 'pending_second_approval', to: 'approved' },
  queue: { from: 'approved', to: 'queued' },
  transmitting: { from: 'queued', to: 'transmitting' },
  accept: { from: 'transmitting', to: 'accepted' },
  reject: { from: 'transmitting', to: 'rejected' },
  fail_retryable: { from: 'transmitting', to: 'retryable_failed' },
  retry: { from: 'retryable_failed', to: 'queued' },
};

export interface TaxFilingTransitionResult {
  record: TaxFilingRecord;
  replayed: boolean;
}

export const transitionTaxFiling = (
  record: TaxFilingRecord,
  action: TaxFilingAction,
  mutation: TaxFilingMutation,
): TaxFilingTransitionResult => {
  if (!mutation.idempotencyKey?.trim()) {
    throw new TaxFilingError('IDEMPOTENCY_KEY_REQUIRED', 'Tax filing mutation requires an idempotency key');
  }
  if (!mutation.reason?.trim()) {
    throw new TaxFilingError('REASON_REQUIRED', 'Tax filing mutation requires a reason');
  }
  if (!mutation.actorId?.trim()) {
    throw new TaxFilingError('REASON_REQUIRED', 'Tax filing mutation requires an actor');
  }

  if (record.lastMutationIdempotencyKey === mutation.idempotencyKey) {
    if (record.lastMutationAction !== action) {
      throw new TaxFilingError('IDEMPOTENCY_CONFLICT', 'Idempotency key was already used for another filing action');
    }
    return { record, replayed: true };
  }

  const transition = NEXT_STATUS[action];
  if (record.status !== transition.from) {
    throw new TaxFilingError(
      'INVALID_TRANSITION',
      `Cannot ${action} tax filing ${record.id} while it is ${record.status}`,
    );
  }

  if (computeTaxFilingSnapshotHash(record.snapshot) !== record.snapshotHash) {
    throw new TaxFilingError('SNAPSHOT_IMMUTABLE', 'Tax filing snapshot changed after creation');
  }

  if (action === 'validate') {
    validateTaxFilingSnapshot(record.snapshot);
  }

  if (
    action === 'approve' &&
    (mutation.actorId === record.createdByActorId || mutation.actorId === record.approvalRequestedByActorId)
  ) {
    throw new TaxFilingError('SELF_APPROVAL_FORBIDDEN', 'The filing creator cannot approve the same filing');
  }

  const now = mutation.now ?? new Date().toISOString();
  const next: TaxFilingRecord = {
    ...record,
    status: transition.to,
    updatedAt: now,
    lastMutationIdempotencyKey: mutation.idempotencyKey,
    lastMutationAction: action,
  };
  switch (action) {
    case 'validate':
      next.validatedAt = now;
      next.validatedByActorId = mutation.actorId;
      break;
    case 'freeze':
      next.frozenAt = now;
      next.frozenByActorId = mutation.actorId;
      break;
    case 'approve':
      next.approvedAt = now;
      next.approvedByActorId = mutation.actorId;
      break;
    case 'queue':
    case 'retry':
      next.queuedAt = now;
      next.queuedByActorId = mutation.actorId;
      next.failureCode = undefined;
      next.failureMessage = undefined;
      break;
    case 'transmitting':
      next.transmittingAt = now;
      next.transmittingByActorId = mutation.actorId;
      break;
    case 'accept':
    case 'reject':
    case 'fail_retryable':
      next.completedAt = now;
      next.completedByActorId = mutation.actorId;
      break;
    case 'request_second_approval':
      next.approvalRequestedByActorId = mutation.actorId;
      next.approvalRequestedAt = now;
      break;
  }
  return { record: next, replayed: false };
};
