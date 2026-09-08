import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TaxFilingError,
  computeTaxFilingSnapshotHash,
  createTaxFilingRecord,
  transitionTaxFiling,
} from './taxFiling.js';

const snapshot = {
  kind: 'e_bilanz' as const,
  periodStart: '2025-01-01',
  periodEnd: '2025-12-31',
  payload: {
    taxYear: 2025,
    taxonomy: '6.9',
    reportSnapshotId: 'report-1',
    sourceSnapshotHash: 'a'.repeat(64),
    totals: { income: 100, expenses: 20 },
    facts: [{ account: '8400', amount: 100 }],
  },
};

const filing = () => createTaxFilingRecord({
  id: 'filing-1',
  tenantId: 'tenant-1',
  provider: 'eric_e_bilanz',
  snapshot,
  idempotencyKey: 'create-1',
  actorId: 'user-1',
  now: '2026-01-01T00:00:00.000Z',
});

const validatedFiling = () => ({
  ...filing(),
  status: 'validated' as const,
  validatedByActorId: 'user-1',
  validatedAt: '2026-01-01T00:00:00.000Z',
});

test('tax filing state machine reaches approved only after a second actor', () => {
  let current = validatedFiling();
  const actions = [
    ['freeze', 'user-1'],
    ['request_second_approval', 'user-1'],
    ['approve', 'user-2'],
    ['queue', 'user-2'],
    ['transmitting', 'worker-1'],
    ['accept', 'worker-1'],
  ] as const;

  for (const [action, actorId] of actions) {
    current = transitionTaxFiling(current, action, {
      actorId,
      reason: action,
      idempotencyKey: `${action}-1`,
      now: '2026-01-01T00:00:00.000Z',
    }).record;
  }
  assert.equal(current.status, 'accepted');
  assert.equal(current.createdByActorId, 'user-1');
  assert.equal(current.approvedByActorId, 'user-2');
  assert.equal(current.transmittingByActorId, 'worker-1');
});

test('creator cannot self approve and invalid transitions fail closed', () => {
  let current = validatedFiling();
  current = transitionTaxFiling(current, 'freeze', { actorId: 'user-1', reason: 'freeze', idempotencyKey: 'f' }).record;
  current = transitionTaxFiling(current, 'request_second_approval', { actorId: 'user-1', reason: 'submit', idempotencyKey: 's' }).record;
  assert.throws(
    () => transitionTaxFiling(current, 'approve', { actorId: 'user-1', reason: 'approve', idempotencyKey: 'a' }),
    (error: unknown) => error instanceof TaxFilingError && error.code === 'SELF_APPROVAL_FORBIDDEN',
  );
  assert.throws(
    () => transitionTaxFiling(current, 'queue', { actorId: 'user-2', reason: 'queue', idempotencyKey: 'q' }),
    (error: unknown) => error instanceof TaxFilingError && error.code === 'INVALID_TRANSITION',
  );
});

test('the approval requester cannot approve, while an independent approver can', () => {
  const frozen = () => {
    let current = validatedFiling();
    current = transitionTaxFiling(current, 'freeze', { actorId: 'user-1', reason: 'freeze', idempotencyKey: 'approval-freeze' }).record;
    return current;
  };

  const requester = transitionTaxFiling(frozen(), 'request_second_approval', {
    actorId: 'user-2',
    reason: 'request approval',
    idempotencyKey: 'request-by-user-2',
  }).record;
  assert.equal(requester.approvalRequestedByActorId, 'user-2');
  assert.throws(
    () => transitionTaxFiling(requester, 'approve', { actorId: 'user-2', reason: 'approve', idempotencyKey: 'approve-by-user-2' }),
    (error: unknown) => error instanceof TaxFilingError && error.code === 'SELF_APPROVAL_FORBIDDEN',
  );

  const independentRequest = transitionTaxFiling(frozen(), 'request_second_approval', {
    actorId: 'user-1',
    reason: 'request approval',
    idempotencyKey: 'request-by-user-1',
  }).record;
  const approved = transitionTaxFiling(independentRequest, 'approve', {
    actorId: 'user-2',
    reason: 'approve',
    idempotencyKey: 'approve-by-user-2',
  }).record;
  assert.equal(approved.status, 'approved');
  assert.equal(approved.approvalRequestedByActorId, 'user-1');
  assert.equal(approved.approvedByActorId, 'user-2');
});

test('same action/key is an idempotent replay while key reuse for another action is rejected', () => {
  const current = transitionTaxFiling(validatedFiling(), 'freeze', {
    actorId: 'user-1',
    reason: 'freeze',
    idempotencyKey: 'same-key',
  }).record;
  const replay = transitionTaxFiling(current, 'freeze', {
    actorId: 'other-actor',
    reason: 'retry request',
    idempotencyKey: 'same-key',
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.record, current);
  assert.throws(
    () => transitionTaxFiling(current, 'queue', { actorId: 'user-1', reason: 'wrong reuse', idempotencyKey: 'same-key' }),
    (error: unknown) => error instanceof TaxFilingError && error.code === 'IDEMPOTENCY_CONFLICT',
  );
});

test('an unvalidated arbitrary draft cannot be queued', () => {
  assert.throws(
    () => transitionTaxFiling(filing(), 'queue', { actorId: 'user-1', reason: 'queue draft', idempotencyKey: 'queue-draft' }),
    (error: unknown) => error instanceof TaxFilingError && error.code === 'INVALID_TRANSITION',
  );
});

test('snapshot hash is stable independent of object key order', () => {
  assert.equal(
    computeTaxFilingSnapshotHash(snapshot),
    computeTaxFilingSnapshotHash({
      ...snapshot,
      payload: {
        facts: snapshot.payload.facts,
        totals: snapshot.payload.totals,
        sourceSnapshotHash: snapshot.payload.sourceSnapshotHash,
        reportSnapshotId: snapshot.payload.reportSnapshotId,
        taxonomy: snapshot.payload.taxonomy,
        taxYear: snapshot.payload.taxYear,
      },
    }),
  );
});

test('validation rejects unsupported years, missing provenance, and E-Bilanz taxonomy drift', () => {
  const current = filing();
  assert.throws(
    () => transitionTaxFiling({
      ...current,
      snapshot: { ...current.snapshot, payload: { ...current.snapshot.payload, taxYear: 2024 } },
      snapshotHash: computeTaxFilingSnapshotHash({ ...current.snapshot, payload: { ...current.snapshot.payload, taxYear: 2024 } }),
    }, 'validate', { actorId: 'user-1', reason: 'validate', idempotencyKey: 'invalid-year' }),
    (error: unknown) => error instanceof TaxFilingError && error.code === 'VALIDATION_FAILED',
  );
  assert.throws(
    () => transitionTaxFiling({
      ...current,
      snapshot: { ...current.snapshot, payload: { ...current.snapshot.payload, sourceSnapshotHash: undefined } },
      snapshotHash: computeTaxFilingSnapshotHash({ ...current.snapshot, payload: { ...current.snapshot.payload, sourceSnapshotHash: undefined } }),
    }, 'validate', { actorId: 'user-1', reason: 'validate', idempotencyKey: 'missing-source' }),
    (error: unknown) => error instanceof TaxFilingError && error.code === 'VALIDATION_FAILED',
  );
  assert.throws(
    () => transitionTaxFiling({
      ...current,
      snapshot: {
        kind: 'e_bilanz',
        periodStart: current.snapshot.periodStart,
        periodEnd: current.snapshot.periodEnd,
        payload: {
          taxYear: 2025,
          taxonomy: '6.8',
          facts: [],
          reportSnapshotId: 'report-1',
          sourceSnapshotHash: 'a'.repeat(64),
        },
      },
      snapshotHash: computeTaxFilingSnapshotHash({
        kind: 'e_bilanz',
        periodStart: current.snapshot.periodStart,
        periodEnd: current.snapshot.periodEnd,
        payload: {
          taxYear: 2025,
          taxonomy: '6.8',
          facts: [],
          reportSnapshotId: 'report-1',
          sourceSnapshotHash: 'a'.repeat(64),
        },
      }),
    }, 'validate', { actorId: 'user-1', reason: 'validate', idempotencyKey: 'wrong-taxonomy' }),
    (error: unknown) => error instanceof TaxFilingError && error.code === 'VALIDATION_FAILED',
  );
});

test('EÜR validation remains unavailable while only print-form catalog is bundled', () => {
  const euerSnapshot = {
    kind: 'euer' as const,
    periodStart: snapshot.periodStart,
    periodEnd: snapshot.periodEnd,
    payload: {
      taxYear: 2025,
      eurVersion: '2025',
      lines: [],
      reportSnapshotId: 'report-1',
      sourceSnapshotHash: 'a'.repeat(64),
    },
  };
  const record = createTaxFilingRecord({
    id: 'euer-filing',
    tenantId: 'tenant-1',
    provider: 'eric_euer',
    snapshot: euerSnapshot,
    idempotencyKey: 'euer-create',
    actorId: 'user-1',
    now: '2026-01-01T00:00:00.000Z',
  });
  assert.throws(
    () => transitionTaxFiling(record, 'validate', { actorId: 'user-1', reason: 'validate', idempotencyKey: 'euer-validate' }),
    (error: unknown) => error instanceof TaxFilingError && error.code === 'EUR_ELSTER_CATALOG_UNAVAILABLE',
  );
});

test('E-Bilanz validation remains unavailable without a verified taxonomy catalog/provider', () => {
  assert.throws(
    () => transitionTaxFiling(filing(), 'validate', { actorId: 'user-1', reason: 'validate', idempotencyKey: 'eb-validate' }),
    (error: unknown) => error instanceof TaxFilingError && error.code === 'E_BILANZ_TAXONOMY_CATALOG_UNAVAILABLE',
  );
});

test('Unternehmensregister validation remains unavailable without an official provider contract', () => {
  const record = createTaxFilingRecord({
    id: 'register-filing',
    tenantId: 'tenant-1',
    provider: 'unternehmensregister',
    snapshot: {
      kind: 'unternehmensregister',
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
      payload: {
        taxYear: 2025,
        reportSnapshotId: 'report-1',
        sourceSnapshotHash: 'a'.repeat(64),
        companyName: 'Example GmbH',
        registerNumber: 'HRB 12345',
      },
    },
    idempotencyKey: 'register-create',
    actorId: 'user-1',
    now: '2026-01-01T00:00:00.000Z',
  });
  assert.throws(
    () => transitionTaxFiling(record, 'validate', { actorId: 'user-1', reason: 'validate', idempotencyKey: 'register-validate' }),
    (error: unknown) => error instanceof TaxFilingError && error.code === 'UNTERNEHMENSREGISTER_PROVIDER_CONTRACT_UNAVAILABLE',
  );
});
