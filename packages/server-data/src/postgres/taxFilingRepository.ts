import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { TaxFilingRecord, TaxFilingSnapshot } from '@billme/accounting-shared';
import type { TaxFilingRepository, TenantScope } from '@billme/server-core';
import type { PostgresQueryable } from './connection.js';
import { createDrizzle, schema } from './drizzle.js';
import { createTaxSubmission, enqueueTaxSubmissionJob, getTaxSubmission, type TaxSubmissionRecord } from './taxSubmission.js';

/**
 * Adapter over the canonical tax_submissions persistence (migration 0015).
 * The filing state machine has richer audit/provenance fields than the shared
 * table, so those fields live in the immutable payload envelope. No second
 * filing table or schema fork is introduced here.
 */
interface TaxFilingEnvelope {
  version: 1;
  snapshot: TaxFilingSnapshot;
  snapshotHash: string;
  provider: TaxFilingRecord['provider'];
  idempotencyKey: string;
  validatedByActorId?: string;
  frozenByActorId?: string;
  approvedByActorId?: string;
  queuedByActorId?: string;
  transmittingByActorId?: string;
  completedByActorId?: string;
  lastMutationIdempotencyKey?: string;
  lastMutationAction?: TaxFilingRecord['lastMutationAction'];
  providerSubmissionId?: string;
  providerReference?: string;
  failureCode?: TaxFilingRecord['failureCode'];
  failureMessage?: string;
  validatedAt?: string;
  frozenAt?: string;
  approvedAt?: string;
  queuedAt?: string;
  transmittingAt?: string;
  completedAt?: string;
}

const parseEnvelope = (value: string): TaxFilingEnvelope => {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) {
    throw new Error('Stored tax filing snapshot is invalid');
  }
  return parsed as TaxFilingEnvelope;
};

const envelopeFor = (record: TaxFilingRecord): TaxFilingEnvelope => ({
  version: 1,
  snapshot: record.snapshot,
  snapshotHash: record.snapshotHash,
  provider: record.provider,
  idempotencyKey: record.idempotencyKey,
  ...(record.validatedByActorId ? { validatedByActorId: record.validatedByActorId } : {}),
  ...(record.frozenByActorId ? { frozenByActorId: record.frozenByActorId } : {}),
  ...(record.approvedByActorId ? { approvedByActorId: record.approvedByActorId } : {}),
  ...(record.queuedByActorId ? { queuedByActorId: record.queuedByActorId } : {}),
  ...(record.transmittingByActorId ? { transmittingByActorId: record.transmittingByActorId } : {}),
  ...(record.completedByActorId ? { completedByActorId: record.completedByActorId } : {}),
  ...(record.lastMutationIdempotencyKey ? { lastMutationIdempotencyKey: record.lastMutationIdempotencyKey } : {}),
  ...(record.lastMutationAction ? { lastMutationAction: record.lastMutationAction } : {}),
  ...(record.providerSubmissionId ? { providerSubmissionId: record.providerSubmissionId } : {}),
  ...(record.providerReference ? { providerReference: record.providerReference } : {}),
  ...(record.failureCode ? { failureCode: record.failureCode } : {}),
  ...(record.failureMessage ? { failureMessage: record.failureMessage } : {}),
  ...(record.validatedAt ? { validatedAt: record.validatedAt } : {}),
  ...(record.frozenAt ? { frozenAt: record.frozenAt } : {}),
  ...(record.approvedAt ? { approvedAt: record.approvedAt } : {}),
  ...(record.queuedAt ? { queuedAt: record.queuedAt } : {}),
  ...(record.transmittingAt ? { transmittingAt: record.transmittingAt } : {}),
  ...(record.completedAt ? { completedAt: record.completedAt } : {}),
});

const recordFromSubmission = (submission: TaxSubmissionRecord): TaxFilingRecord => {
  const envelope = parseEnvelope(submission.payloadJson);
  const {
    version: _version,
    snapshot: _snapshot,
    snapshotHash: _snapshotHash,
    provider: _provider,
    idempotencyKey: _idempotencyKey,
    ...envelopeMetadata
  } = envelope;
  return {
    id: submission.id,
    tenantId: submission.tenantId,
    kind: envelope.snapshot.kind,
    provider: envelope.provider,
    periodStart: envelope.snapshot.periodStart,
    periodEnd: envelope.snapshot.periodEnd,
    status: submission.status as TaxFilingRecord['status'],
    snapshot: envelope.snapshot,
    snapshotHash: envelope.snapshotHash,
    idempotencyKey: submission.idempotencyKey,
    createdByActorId: submission.createdBy,
    ...envelopeMetadata,
    createdAt: submission.createdAt,
    updatedAt: submission.updatedAt,
  };
};

const dbFor = (db: PostgresQueryable) => createDrizzle(db as never);

const findByIdempotencyKey = async (db: PostgresQueryable, scope: TenantScope, idempotencyKey: string) => {
  const row = (await dbFor(db).select().from(schema.taxSubmissions)
    .where(and(eq(schema.taxSubmissions.tenantId, scope.tenantId), eq(schema.taxSubmissions.idempotencyKey, idempotencyKey)))
    .limit(1))[0];
  return row ? recordFromSubmission({
    id: row.id!, tenantId: row.tenantId!, submissionType: row.submissionType!, taxYear: row.taxYear!, period: row.period!,
    status: row.status!, payloadJson: row.payloadJson!, sourceSnapshotId: row.sourceSnapshotId ?? undefined,
    idempotencyKey: row.idempotencyKey!, createdBy: row.createdBy!, createdAt: row.createdAt!, updatedAt: row.updatedAt!,
    submittedAt: row.submittedAt ?? undefined,
  }) : null;
};

const findAll = async (db: PostgresQueryable, scope: TenantScope) => {
  const rows = await dbFor(db).select().from(schema.taxSubmissions)
    .where(eq(schema.taxSubmissions.tenantId, scope.tenantId))
    .orderBy(desc(schema.taxSubmissions.createdAt));
  return rows.map((row) => recordFromSubmission({
    id: row.id!, tenantId: row.tenantId!, submissionType: row.submissionType!, taxYear: row.taxYear!, period: row.period!,
    status: row.status!, payloadJson: row.payloadJson!, sourceSnapshotId: row.sourceSnapshotId ?? undefined,
    idempotencyKey: row.idempotencyKey!, createdBy: row.createdBy!, createdAt: row.createdAt!, updatedAt: row.updatedAt!,
    submittedAt: row.submittedAt ?? undefined,
  }));
};

export const createPostgresTaxFilingRepository = (db: PostgresQueryable): TaxFilingRepository => ({
  list: (scope) => findAll(db, scope),
  async getById(scope, id) {
    const submission = await getTaxSubmission(db, scope, id);
    return submission ? recordFromSubmission(submission) : null;
  },
  getByIdempotencyKey: (scope, idempotencyKey) => findByIdempotencyKey(db, scope, idempotencyKey),
  async create(scope, record) {
    try {
      const submission = await createTaxSubmission(db, scope, {
        id: record.id || randomUUID(),
        submissionType: record.kind,
        taxYear: Number(record.periodStart.slice(0, 4)),
        period: `${record.periodStart}/${record.periodEnd}`,
        status: record.status,
        payloadJson: JSON.stringify(envelopeFor(record)),
        idempotencyKey: record.idempotencyKey,
        createdBy: record.createdByActorId,
      });
      return recordFromSubmission(submission);
    } catch (error) {
      const replay = await findByIdempotencyKey(db, scope, record.idempotencyKey);
      if (replay) return replay;
      throw error;
    }
  },
  async update(scope, record, expectedStatus) {
    const current = await getTaxSubmission(db, scope, record.id);
    if (!current) throw new Error('TAX_SUBMISSION_NOT_FOUND');
    const currentEnvelope = parseEnvelope(current.payloadJson);
    if (currentEnvelope.snapshotHash !== record.snapshotHash || JSON.stringify(currentEnvelope.snapshot) !== JSON.stringify(record.snapshot)) {
      throw new Error('TAX_FILING_SNAPSHOT_IMMUTABLE');
    }
    const stamp = record.updatedAt || new Date().toISOString();
    const conditions = [eq(schema.taxSubmissions.tenantId, scope.tenantId), eq(schema.taxSubmissions.id, record.id)];
    if (expectedStatus) conditions.push(eq(schema.taxSubmissions.status, expectedStatus));
    const result = await dbFor(db).update(schema.taxSubmissions).set({
      status: record.status,
      payloadJson: JSON.stringify(envelopeFor(record)),
      updatedAt: stamp,
      submittedAt: record.status === 'transmitting' || record.status === 'accepted' ? (record.transmittingAt ?? stamp) : null,
    }).where(and(...conditions))
      .returning();
    if (!result[0]) throw new Error(expectedStatus ? 'TAX_FILING_CONCURRENT_UPDATE' : 'TAX_SUBMISSION_NOT_FOUND');
    return recordFromSubmission({
      id: result[0].id!, tenantId: result[0].tenantId!, submissionType: result[0].submissionType!, taxYear: result[0].taxYear!, period: result[0].period!,
      status: result[0].status!, payloadJson: result[0].payloadJson!, sourceSnapshotId: result[0].sourceSnapshotId ?? undefined,
      idempotencyKey: result[0].idempotencyKey!, createdBy: result[0].createdBy!, createdAt: result[0].createdAt!, updatedAt: result[0].updatedAt!,
      submittedAt: result[0].submittedAt ?? undefined,
    });
  },
  async enqueueSubmissionJob(scope, filingId, idempotencyKey) {
    await enqueueTaxSubmissionJob(db, scope, {
      submissionId: filingId,
      jobType: 'tax-filing',
      idempotencyKey,
    });
  },
  async recordProviderResult(scope, input) {
    const current = await getTaxSubmission(db, scope, input.id);
    if (!current) throw new Error('TAX_SUBMISSION_NOT_FOUND');
    const record = recordFromSubmission(current);
    const envelope = envelopeFor({
      ...record,
      providerSubmissionId: input.result.providerSubmissionId ?? record.providerSubmissionId,
      providerReference: input.result.providerReference ?? record.providerReference,
      failureCode: input.result.status === 'accepted' ? undefined : input.result.failureCode,
      failureMessage: input.result.status === 'accepted' ? undefined : input.result.message,
      lastMutationIdempotencyKey: input.idempotencyKey,
      lastMutationAction: 'accept',
      updatedAt: input.now ?? new Date().toISOString(),
    });
    const updated = await dbFor(db).update(schema.taxSubmissions).set({
      payloadJson: JSON.stringify(envelope),
      updatedAt: input.now ?? new Date().toISOString(),
    }).where(and(eq(schema.taxSubmissions.tenantId, scope.tenantId), eq(schema.taxSubmissions.id, input.id), eq(schema.taxSubmissions.status, record.status))).returning();
    if (!updated[0]) throw new Error('TAX_FILING_CONCURRENT_UPDATE');
    return recordFromSubmission({
      id: updated[0].id!, tenantId: updated[0].tenantId!, submissionType: updated[0].submissionType!, taxYear: updated[0].taxYear!, period: updated[0].period!,
      status: updated[0].status!, payloadJson: updated[0].payloadJson!, sourceSnapshotId: updated[0].sourceSnapshotId ?? undefined,
      idempotencyKey: updated[0].idempotencyKey!, createdBy: updated[0].createdBy!, createdAt: updated[0].createdAt!, updatedAt: updated[0].updatedAt!,
      submittedAt: updated[0].submittedAt ?? undefined,
    });
  },
});
