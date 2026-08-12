import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import type { TaxFilingRecord, TaxFilingSnapshot } from '@billme/accounting-shared';
import type { TaxFilingRepository, TenantScope } from '@billme/server-core';
import type { Pool } from 'pg';
import { withPostgresTransaction, type PostgresQueryable } from './connection.js';
import { createDrizzle, schema } from './drizzle.js';
import {
  createTaxSubmission,
  enqueueTaxSubmissionJob,
  getTaxSubmission,
  recordTaxSubmissionReceipt,
  type TaxSubmissionRecord,
} from './taxSubmission.js';

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
  approvalRequestedByActorId?: string;
  approvalRequestedAt?: string;
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
  ...(record.approvalRequestedByActorId ? { approvalRequestedByActorId: record.approvalRequestedByActorId } : {}),
  ...(record.approvalRequestedAt ? { approvalRequestedAt: record.approvalRequestedAt } : {}),
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

/** Repository calls made with a Pool must make multi-table evidence writes
 * transactional; API callers pass a transaction client and stay in that
 * outer transaction. */
const atomically = async <T>(
  db: PostgresQueryable,
  work: (connection: PostgresQueryable) => Promise<T>,
): Promise<T> => {
  const candidate = db as PostgresQueryable & { connect?: () => Promise<unknown> };
  if (typeof candidate.connect === 'function') {
    return withPostgresTransaction(db as unknown as Pool, (client) => work(client));
  }
  return work(db);
};

const rowRecord = (row: typeof schema.taxSubmissions.$inferSelect): TaxFilingRecord => recordFromSubmission({
  id: row.id!,
  tenantId: row.tenantId!,
  submissionType: row.submissionType!,
  taxYear: row.taxYear!,
  period: row.period!,
  status: row.status!,
  payloadJson: row.payloadJson!,
  sourceSnapshotId: row.sourceSnapshotId ?? undefined,
  idempotencyKey: row.idempotencyKey!,
  createdBy: row.createdBy!,
  createdAt: row.createdAt!,
  updatedAt: row.updatedAt!,
  submittedAt: row.submittedAt ?? undefined,
});

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
  async recordApproval(scope, input) {
    return atomically(db, async (connection) => {
      const current = await getTaxSubmission(connection, scope, input.id);
      if (!current) throw new Error('TAX_SUBMISSION_NOT_FOUND');
      const currentRecord = recordFromSubmission(current);
      if (
        currentRecord.lastMutationIdempotencyKey === input.record.lastMutationIdempotencyKey &&
        currentRecord.lastMutationAction === 'approve'
      ) {
        return currentRecord;
      }
      if (currentRecord.status !== 'pending_second_approval') {
        throw new Error('TAX_FILING_CONCURRENT_UPDATE');
      }
      if (
        currentRecord.snapshotHash !== input.record.snapshotHash ||
        JSON.stringify(currentRecord.snapshot) !== JSON.stringify(input.record.snapshot)
      ) {
        throw new Error('TAX_FILING_SNAPSHOT_IMMUTABLE');
      }
      if (currentRecord.approvalRequestedByActorId !== input.requesterId) {
        throw new Error('TAX_FILING_APPROVAL_REQUESTER_MISMATCH');
      }
      if (input.approverId === currentRecord.createdByActorId || input.approverId === input.requesterId) {
        throw new Error('TAX_SUBMISSION_CREATOR_CANNOT_APPROVE');
      }

      const createdAt = input.now ?? new Date().toISOString();
      const approvalId = `tax-filing-approval-${createHash('sha256')
        .update(`${scope.tenantId}:${input.id}:${input.idempotencyKey}`)
        .digest('hex')}`;
      const database = dbFor(connection);
      await database.insert(schema.taxSubmissionApprovals).values({
        id: approvalId,
        tenantId: scope.tenantId,
        submissionId: input.id,
        requesterId: input.requesterId,
        approverId: input.approverId,
        decision: 'approved',
        reason: input.reason,
        createdAt,
      }).onConflictDoNothing();
      const updated = await database.update(schema.taxSubmissions).set({
        status: input.record.status,
        payloadJson: JSON.stringify(envelopeFor(input.record)),
        updatedAt: input.record.updatedAt || createdAt,
      }).where(and(
        eq(schema.taxSubmissions.tenantId, scope.tenantId),
        eq(schema.taxSubmissions.id, input.id),
        eq(schema.taxSubmissions.status, 'pending_second_approval'),
      )).returning();
      if (!updated[0]) throw new Error('TAX_FILING_CONCURRENT_UPDATE');
      return rowRecord(updated[0]);
    });
  },
  async recordProviderResult(scope, input) {
    return atomically(db, async (connection) => {
      const current = await getTaxSubmission(connection, scope, input.id);
      if (!current) throw new Error('TAX_SUBMISSION_NOT_FOUND');
      const currentRecord = recordFromSubmission(current);
      if (
        currentRecord.lastMutationIdempotencyKey === input.record.lastMutationIdempotencyKey &&
        currentRecord.lastMutationAction === input.action &&
        currentRecord.status === input.record.status
      ) {
        return currentRecord;
      }
      if (currentRecord.status !== 'transmitting') {
        throw new Error('TAX_FILING_CONCURRENT_UPDATE');
      }
      if (
        currentRecord.snapshotHash !== input.record.snapshotHash ||
        JSON.stringify(currentRecord.snapshot) !== JSON.stringify(input.record.snapshot)
      ) {
        throw new Error('TAX_FILING_SNAPSHOT_IMMUTABLE');
      }
      const updatedAt = input.now ?? input.record.updatedAt ?? new Date().toISOString();
      const persisted: TaxFilingRecord = {
        ...input.record,
        providerSubmissionId: input.result.providerSubmissionId ?? input.record.providerSubmissionId,
        providerReference: input.result.providerReference ?? input.record.providerReference,
        failureCode: input.result.status === 'accepted' ? undefined : input.result.failureCode,
        failureMessage: input.result.status === 'accepted' ? undefined : input.result.message,
        updatedAt,
      };
      const database = dbFor(connection);
      const updated = await database.update(schema.taxSubmissions).set({
        status: persisted.status,
        payloadJson: JSON.stringify(envelopeFor(persisted)),
        updatedAt,
        submittedAt: persisted.transmittingAt ?? updatedAt,
      }).where(and(
        eq(schema.taxSubmissions.tenantId, scope.tenantId),
        eq(schema.taxSubmissions.id, input.id),
        eq(schema.taxSubmissions.status, 'transmitting'),
      )).returning();
      if (!updated[0]) throw new Error('TAX_FILING_CONCURRENT_UPDATE');

      // Use a deterministic id so an exactly repeated result is a no-op and
      // the immutable receipt can always be recovered by this call.
      const receiptId = `tax-filing-receipt-${createHash('sha256')
        .update(`${scope.tenantId}:${input.id}:${input.idempotencyKey}`)
        .digest('hex')}`;
      await recordTaxSubmissionReceipt(connection, scope, {
        id: receiptId,
        submissionId: input.id,
        receiptType: 'tax_filing_provider_result',
        receiptNumber: input.result.providerReference ?? input.result.providerSubmissionId ?? input.idempotencyKey,
        receiptJson: JSON.stringify({
          action: input.action,
          status: input.result.status,
          providerSubmissionId: input.result.providerSubmissionId,
          providerReference: input.result.providerReference,
          failureCode: input.result.failureCode,
          message: input.result.message,
        }),
        receivedAt: updatedAt,
      });
      return rowRecord(updated[0]);
    });
  },
});
