import type {
  TaxFilingAction,
  TaxFilingKind,
  TaxFilingProvider,
  TaxFilingProviderPort,
  TaxFilingProviderResult,
  TaxFilingRecord,
  TaxFilingSnapshot,
} from '@billme/accounting-shared';
import type {
  AuditLogPort,
  TaxFilingRepository,
  TaxFilingStateMachinePort,
} from '../ports/index.js';
import type { TenantScope } from '../domain/foundations.js';

export interface TaxFilingProviderRegistry {
  get(provider: TaxFilingProvider): TaxFilingProviderPort;
}

export interface TaxFilingServiceDependencies {
  repository: TaxFilingRepository;
  stateMachine: TaxFilingStateMachinePort;
  auditLog?: AuditLogPort;
  providers?: TaxFilingProviderRegistry;
  resolveCredential?: (scope: TenantScope, filing: TaxFilingRecord) => Promise<unknown | undefined>;
  reportSnapshot?: {
    get(scope: TenantScope, id: string): Promise<{ id: string; tenantId: string; sourceHash: string } | null>;
  };
}

export type TaxFilingServiceErrorCode = 'INVALID_TRANSITION' | 'IDEMPOTENCY_CONFLICT' | 'CONCURRENT_UPDATE' | 'VALIDATION_FAILED';
export class TaxFilingServiceError extends Error {
  readonly code: TaxFilingServiceErrorCode;
  constructor(code: TaxFilingServiceErrorCode, message: string) {
    super(message);
    this.name = 'TaxFilingServiceError';
    this.code = code;
  }
}

const providerForKind: Record<TaxFilingKind, TaxFilingProvider> = {
  euer: 'eric_euer',
  e_bilanz: 'eric_e_bilanz',
  unternehmensregister: 'unternehmensregister',
};

class UnavailableProvider implements TaxFilingProviderPort {
  constructor(readonly provider: TaxFilingProvider) {}

  async submit(): Promise<TaxFilingProviderResult> {
    return {
      status: 'retryable_failed',
      failureCode: 'PROVIDER_UNAVAILABLE',
      message: `${this.provider} provider is not installed or configured`,
    };
  }
}

/** Explicit provider seams. Official ERiC/Unternehmensregister adapters can
 * replace these classes without changing the state machine or persistence.
 * Until their signed binaries and credentials are configured they fail closed. */
export class EricEuerProvider extends UnavailableProvider {
  constructor() { super('eric_euer'); }
}

export class EricEBilanzProvider extends UnavailableProvider {
  constructor() { super('eric_e_bilanz'); }
}

export class UnternehmensregisterProvider extends UnavailableProvider {
  constructor() { super('unternehmensregister'); }
}

const defaultProviders: TaxFilingProviderRegistry = {
  get: (provider) => provider === 'eric_euer'
    ? new EricEuerProvider()
    : provider === 'eric_e_bilanz'
      ? new EricEBilanzProvider()
      : new UnternehmensregisterProvider(),
};

const defaultNow = () => new Date().toISOString();

const appendAudit = async (
  auditLog: AuditLogPort | undefined,
  scope: TenantScope,
  actorId: string,
  action: string,
  reason: string,
  before: TaxFilingRecord | null,
  after: TaxFilingRecord,
): Promise<void> => {
  if (!auditLog) return;
  await auditLog.append(scope, {
    occurredAt: after.updatedAt,
    action,
    reason,
    actor: { type: actorId === 'billme-server-worker' ? 'service' : 'user', id: actorId },
    subject: { entityType: 'tax-filing', entityId: after.id, tenantId: scope.tenantId },
    change: { before, after },
  });
};

const assertTenant = (scope: TenantScope, record: TaxFilingRecord | null): TaxFilingRecord => {
  if (!record || record.tenantId !== scope.tenantId) {
    throw new TaxFilingServiceError('INVALID_TRANSITION', 'Tax filing was not found in this tenant');
  }
  return record;
};

export interface CreateTaxFilingInput {
  id?: string;
  kind: TaxFilingKind;
  provider?: TaxFilingProvider;
  periodStart: string;
  periodEnd: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  actorId: string;
  reason: string;
  now?: string;
}

export interface TaxFilingService {
  list(scope: TenantScope): Promise<TaxFilingRecord[]>;
  get(scope: TenantScope, id: string): Promise<TaxFilingRecord | null>;
  create(scope: TenantScope, input: CreateTaxFilingInput): Promise<TaxFilingRecord>;
  transition(scope: TenantScope, id: string, action: TaxFilingAction, input: { actorId: string; reason: string; idempotencyKey: string; now?: string }): Promise<TaxFilingRecord>;
  submit(scope: TenantScope, id: string, input?: { actorId?: string; reason?: string; idempotencyKey?: string; now?: string }): Promise<TaxFilingRecord>;
}

export const createTaxFilingService = (dependencies: TaxFilingServiceDependencies): TaxFilingService => {
  const providers = dependencies.providers ?? defaultProviders;

  const list = async (scope: TenantScope) => dependencies.repository.list(scope);
  const get = async (scope: TenantScope, id: string) => dependencies.repository.getById(scope, id);

  const create = async (scope: TenantScope, input: CreateTaxFilingInput): Promise<TaxFilingRecord> => {
    const existing = await dependencies.repository.getByIdempotencyKey(scope, input.idempotencyKey);
    const snapshot: TaxFilingSnapshot = {
      kind: input.kind,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      payload: input.payload,
    };
    if (existing) {
      if (existing.snapshotHash !== dependencies.stateMachine.create({
        id: existing.id,
        tenantId: scope.tenantId,
        provider: existing.provider,
        snapshot,
        idempotencyKey: input.idempotencyKey,
        actorId: input.actorId,
        now: existing.createdAt,
      }).snapshotHash) {
        throw new TaxFilingServiceError('IDEMPOTENCY_CONFLICT', 'Idempotency key belongs to another filing snapshot');
      }
      return existing;
    }

    const record = dependencies.stateMachine.create({
      id: input.id ?? `tax-filing-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      tenantId: scope.tenantId,
      provider: input.provider ?? providerForKind[input.kind],
      snapshot,
      idempotencyKey: input.idempotencyKey,
      actorId: input.actorId,
      now: input.now ?? defaultNow(),
    });
    const saved = await dependencies.repository.create(scope, record);
    if (saved.snapshotHash !== record.snapshotHash) {
      throw new TaxFilingServiceError('IDEMPOTENCY_CONFLICT', 'Idempotency key belongs to another filing snapshot');
    }
    await appendAudit(dependencies.auditLog, scope, input.actorId, 'tax_filing.create', input.reason, null, saved);
    return saved;
  };

  const transition = async (
    scope: TenantScope,
    id: string,
    action: TaxFilingAction,
    input: { actorId: string; reason: string; idempotencyKey: string; now?: string },
  ): Promise<TaxFilingRecord> => {
    const current = assertTenant(scope, await dependencies.repository.getById(scope, id));
    if (action === 'validate' && dependencies.reportSnapshot) {
      const reportSnapshotId = current.snapshot.payload.reportSnapshotId;
      const sourceSnapshotHash = current.snapshot.payload.sourceSnapshotHash;
      if (typeof reportSnapshotId !== 'string' || typeof sourceSnapshotHash !== 'string') {
        throw new TaxFilingServiceError('VALIDATION_FAILED', 'Tax filing report snapshot provenance is required');
      }
      const source = await dependencies.reportSnapshot.get(scope, reportSnapshotId);
      if (!source || source.tenantId !== scope.tenantId || source.id !== reportSnapshotId || source.sourceHash !== sourceSnapshotHash) {
        throw new TaxFilingServiceError('VALIDATION_FAILED', 'Tax filing report snapshot is missing or has changed');
      }
    }
    const result = dependencies.stateMachine.transition(current, action, input);
    if (result.replayed) return result.record;
    let saved: TaxFilingRecord;
    try {
      if (action === 'approve' && dependencies.repository.recordApproval) {
        if (!current.approvalRequestedByActorId) {
          throw new TaxFilingServiceError('INVALID_TRANSITION', 'Tax filing approval requester is missing');
        }
        saved = await dependencies.repository.recordApproval(scope, {
          id: result.record.id,
          record: result.record,
          requesterId: current.approvalRequestedByActorId,
          approverId: input.actorId,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          now: input.now,
        });
      } else {
        saved = await dependencies.repository.update(scope, result.record, current.status);
      }
    } catch (error) {
      if (error instanceof Error && error.message === 'TAX_FILING_CONCURRENT_UPDATE') {
        throw new TaxFilingServiceError('CONCURRENT_UPDATE', 'Tax filing changed in another request');
      }
      throw error;
    }
    if ((action === 'queue' || action === 'retry') && dependencies.repository.enqueueSubmissionJob) {
      await dependencies.repository.enqueueSubmissionJob(scope, saved.id, `submit:${saved.id}:${saved.snapshotHash}`);
    }
    await appendAudit(dependencies.auditLog, scope, input.actorId, `tax_filing.${action}`, input.reason, current, saved);
    return saved;
  };

  const submit = async (
    scope: TenantScope,
    id: string,
    input: { actorId?: string; reason?: string; idempotencyKey?: string; now?: string } = {},
  ): Promise<TaxFilingRecord> => {
    const current = assertTenant(scope, await dependencies.repository.getById(scope, id));
    if (current.status !== 'queued') return current;
    const actorId = input.actorId ?? 'billme-server-worker';
    const reason = input.reason ?? 'Tax filing provider submission';
    const key = input.idempotencyKey ?? `submit:${current.id}:${current.snapshotHash}`;
    const transmitting = await transition(scope, id, 'transmitting', {
      actorId,
      reason,
      idempotencyKey: `${key}:transmitting`,
      now: input.now,
    });
    let providerResult: TaxFilingProviderResult;
    try {
      providerResult = await providers.get(transmitting.provider).submit({
        tenantId: scope.tenantId,
        filingId: transmitting.id,
        kind: transmitting.kind,
        snapshot: transmitting.snapshot,
        snapshotHash: transmitting.snapshotHash,
        credential: dependencies.resolveCredential ? await dependencies.resolveCredential(scope, transmitting) : undefined,
      });
    } catch (error) {
      providerResult = {
        status: 'retryable_failed',
        failureCode: 'TRANSMISSION_FAILED',
        message: error instanceof Error ? error.message : String(error),
      };
    }

    const action: TaxFilingAction = providerResult.status === 'accepted'
      ? 'accept'
      : providerResult.status === 'rejected'
        ? 'reject'
        : 'fail_retryable';
    const completionMutation = {
      actorId,
      reason,
      idempotencyKey: `${key}:${action}`,
      now: input.now,
    };
    let completed: TaxFilingRecord;
    if (dependencies.repository.recordProviderResult) {
      // Compute the terminal transition first, but let the repository persist
      // that transition and its immutable provider receipt in one transaction.
      // This avoids an accepted/rejected status without the corresponding
      // provider evidence if receipt persistence fails.
      const completion = dependencies.stateMachine.transition(transmitting, action, completionMutation);
      if (completion.replayed) return completion.record;
      completed = await dependencies.repository.recordProviderResult(scope, {
        id: transmitting.id,
        record: completion.record,
        result: providerResult,
        action,
        actorId,
        reason,
        idempotencyKey: `${key}:receipt`,
        now: input.now,
      });
      await appendAudit(dependencies.auditLog, scope, actorId, `tax_filing.${action}`, reason, transmitting, completed);
      await appendAudit(dependencies.auditLog, scope, actorId, 'tax_filing.provider_receipt', reason, transmitting, completed);
    } else {
      // A repository without the atomic receipt capability remains supported
      // for lightweight adapters, but cannot claim durable provider evidence.
      const transitioned = await transition(scope, id, action, completionMutation);
      completed = {
        ...transitioned,
        providerSubmissionId: providerResult.providerSubmissionId,
        providerReference: providerResult.providerReference,
        failureCode: providerResult.status === 'accepted' ? undefined : providerResult.failureCode,
        failureMessage: providerResult.status === 'accepted' ? undefined : providerResult.message,
      };
    }
    return completed;
  };

  return { list, get, create, transition, submit };
};

export const createUnavailableTaxFilingProviderRegistry = (): TaxFilingProviderRegistry => defaultProviders;
