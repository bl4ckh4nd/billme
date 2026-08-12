import assert from 'node:assert/strict';
import test from 'node:test';
import { createTaxFilingService } from './taxFiling.js';
import type { TaxFilingAction, TaxFilingRecord } from '@billme/accounting-shared';
import type { TaxFilingRepository } from '../ports/index.js';

const scope = { tenantId: 'tenant-a', product: 'pro' as const, deploymentMode: 'single-tenant' as const };
const snapshot = {
  kind: 'euer' as const,
  periodStart: '2025-01-01',
  periodEnd: '2025-12-31',
  payload: {
    taxYear: 2025,
    eurVersion: '2025',
    reportSnapshotId: 'report-1',
    sourceSnapshotHash: 'a'.repeat(64),
    total: 42,
    lines: [],
  },
};

const stateMachine = {
  create(input: { id: string; tenantId: string; provider: TaxFilingRecord['provider']; snapshot: TaxFilingRecord['snapshot']; idempotencyKey: string; actorId: string; now: string }): TaxFilingRecord {
    return {
      ...input,
      kind: input.snapshot.kind,
      periodStart: input.snapshot.periodStart,
      periodEnd: input.snapshot.periodEnd,
      status: 'draft',
      snapshotHash: 'hash',
      createdByActorId: input.actorId,
      createdAt: input.now,
      updatedAt: input.now,
    };
  },
  transition(record: TaxFilingRecord, action: TaxFilingAction, mutation: { actorId: string; idempotencyKey: string; now?: string }) {
    const status = action === 'validate' ? 'validated' : action === 'freeze' ? 'frozen' : action === 'request_second_approval' ? 'pending_second_approval' : action === 'approve' ? 'approved' : action === 'queue' ? 'queued' : action === 'transmitting' ? 'transmitting' : action === 'fail_retryable' ? 'retryable_failed' : action === 'accept' ? 'accepted' : record.status;
    return { replayed: false, record: { ...record, status, updatedAt: mutation.now ?? record.updatedAt } };
  },
};

const memoryRepository = () => {
  const records = new Map<string, TaxFilingRecord>();
  const repository: TaxFilingRepository = {
    async list(currentScope) {
      return [...records.values()].filter((record) => record.tenantId === currentScope.tenantId);
    },
    async getById(currentScope, id) {
      const record = records.get(id);
      return record?.tenantId === currentScope.tenantId ? record : null;
    },
    async getByIdempotencyKey(currentScope, key) {
      return [...records.values()].find((record) => record.tenantId === currentScope.tenantId && record.idempotencyKey === key) ?? null;
    },
    async create(currentScope, record) {
      records.set(record.id, { ...record, tenantId: currentScope.tenantId });
      return records.get(record.id)!;
    },
    async update(currentScope, record) {
      if (record.tenantId !== currentScope.tenantId || !records.has(record.id)) throw new Error('tenant mismatch');
      records.set(record.id, record);
      return record;
    },
  };
  return { repository, records };
};

test('tax filing service scopes idempotency and reads to the tenant', async () => {
  const memory = memoryRepository();
  const service = createTaxFilingService({ repository: memory.repository, stateMachine });
  const created = await service.create(scope, {
    id: 'filing-a',
    kind: 'euer',
    periodStart: snapshot.periodStart,
    periodEnd: snapshot.periodEnd,
    payload: snapshot.payload,
    idempotencyKey: 'create-a',
    actorId: 'user-a',
    reason: 'prepare',
  });
  assert.equal((await service.get({ ...scope, tenantId: 'tenant-b' }, created.id)), null);
  const replay = await service.create(scope, {
    ...created.snapshot,
    idempotencyKey: 'create-a',
    actorId: 'different-user',
    reason: 'replay',
  });
  assert.equal(replay.id, created.id);
  assert.equal(memory.records.size, 1);
});

test('provider-unavailable submission never reports success and can be retried', async () => {
  const memory = memoryRepository();
  const service = createTaxFilingService({ repository: memory.repository, stateMachine });
  let filing = await service.create(scope, {
    id: 'filing-retry',
    kind: 'euer',
    periodStart: snapshot.periodStart,
    periodEnd: snapshot.periodEnd,
    payload: snapshot.payload,
    idempotencyKey: 'create-retry',
    actorId: 'user-a',
    reason: 'prepare',
  });
  for (const [action, actorId] of [
    ['validate', 'user-a'],
    ['freeze', 'user-a'],
    ['request_second_approval', 'user-a'],
    ['approve', 'user-b'],
    ['queue', 'user-b'],
  ] as const) {
    filing = await service.transition(scope, filing.id, action, {
      actorId,
      reason: action,
      idempotencyKey: `${action}-retry`,
    });
  }
  const failed = await service.submit(scope, filing.id);
  assert.equal(failed.status, 'retryable_failed');
  assert.equal(failed.failureCode, 'PROVIDER_UNAVAILABLE');
  assert.notEqual(failed.status, 'accepted');
});

test('provider rejection persists the matching terminal action and evidence seam', async () => {
  const memory = memoryRepository();
  const calls: Array<{ action: TaxFilingAction; result: { status: string } }> = [];
  const repository: TaxFilingRepository = {
    ...memory.repository,
    async recordProviderResult(_scope, input) {
      calls.push({ action: input.action, result: input.result });
      const saved = {
        ...input.record,
        providerReference: input.result.providerReference,
        failureCode: input.result.failureCode,
        failureMessage: input.result.message,
      };
      memory.records.set(saved.id, saved);
      return saved;
    },
  };
  const resultStateMachine = {
    ...stateMachine,
    transition(record: TaxFilingRecord, action: TaxFilingAction, mutation: { actorId: string; idempotencyKey: string; now?: string }) {
      const result = stateMachine.transition(record, action, mutation);
      if (action === 'reject') result.record.status = 'rejected';
      if (action === 'fail_retryable') result.record.status = 'retryable_failed';
      result.record.lastMutationAction = action;
      result.record.lastMutationIdempotencyKey = mutation.idempotencyKey;
      return result;
    },
  };
  const service = createTaxFilingService({
    repository,
    stateMachine: resultStateMachine,
    providers: {
      get: () => ({
        provider: 'eric_euer',
        async submit() {
          return { status: 'rejected', providerReference: 'provider-rejection', failureCode: 'PROVIDER_REJECTED', message: 'invalid filing' };
        },
      }),
    },
  });
  let filing = await service.create(scope, {
    id: 'filing-provider-reject',
    kind: 'euer',
    periodStart: snapshot.periodStart,
    periodEnd: snapshot.periodEnd,
    payload: snapshot.payload,
    idempotencyKey: 'create-provider-reject',
    actorId: 'user-a',
    reason: 'prepare',
  });
  for (const [action, actorId] of [
    ['validate', 'user-a'],
    ['freeze', 'user-a'],
    ['request_second_approval', 'user-a'],
    ['approve', 'user-b'],
    ['queue', 'user-b'],
  ] as const) {
    filing = await service.transition(scope, filing.id, action, {
      actorId,
      reason: action,
      idempotencyKey: `${action}-provider-reject`,
    });
  }
  const rejected = await service.submit(scope, filing.id);
  assert.equal(rejected.status, 'rejected');
  assert.equal(rejected.failureCode, 'PROVIDER_REJECTED');
  assert.equal(calls[0]?.action, 'reject');
  assert.equal(calls[0]?.result.status, 'rejected');
});

test('validation requires a tenant-owned immutable report snapshot match', async () => {
  const memory = memoryRepository();
  const service = createTaxFilingService({
    repository: memory.repository,
    stateMachine,
    reportSnapshot: {
      async get(currentScope, id) {
        return currentScope.tenantId === 'tenant-a' && id === 'report-1'
          ? { id, tenantId: currentScope.tenantId, sourceHash: 'a'.repeat(64) }
          : null;
      },
    },
  });
  const created = await service.create(scope, {
    id: 'filing-source',
    kind: 'euer',
    periodStart: snapshot.periodStart,
    periodEnd: snapshot.periodEnd,
    payload: snapshot.payload,
    idempotencyKey: 'create-source',
    actorId: 'user-a',
    reason: 'prepare',
  });
  const validated = await service.transition(scope, created.id, 'validate', {
    actorId: 'user-a', reason: 'validate', idempotencyKey: 'validate-source',
  });
  assert.equal(validated.status, 'validated');
  const otherTenant = { ...scope, tenantId: 'tenant-b' };
  assert.equal(await service.get(otherTenant, created.id), null);
  const invalidMemory = memoryRepository();
  const invalidService = createTaxFilingService({
    repository: invalidMemory.repository,
    stateMachine,
    reportSnapshot: { async get() { return { id: 'report-1', tenantId: 'tenant-a', sourceHash: 'b'.repeat(64) }; } },
  });
  const invalid = await invalidService.create(scope, {
    id: 'filing-source-invalid', kind: 'euer', periodStart: snapshot.periodStart, periodEnd: snapshot.periodEnd,
    payload: snapshot.payload, idempotencyKey: 'create-source-invalid', actorId: 'user-a', reason: 'prepare',
  });
  await assert.rejects(() => invalidService.transition(scope, invalid.id, 'validate', {
    actorId: 'user-a', reason: 'validate', idempotencyKey: 'validate-source-invalid',
  }), /report snapshot is missing or has changed/);
});
