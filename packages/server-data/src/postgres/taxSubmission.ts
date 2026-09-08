import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lte } from "drizzle-orm";
import type { TenantScope } from "@billme/server-core";
import type { PostgresQueryable } from "./connection.js";
import { createDrizzle, schema, tryCreateDrizzle } from "./drizzle.js";

const dbFor = (db: PostgresQueryable) => tryCreateDrizzle(db) ?? createDrizzle(db as never);
const now = (): string => new Date().toISOString();

export interface TaxSubmissionRecord {
  id: string;
  tenantId: string;
  submissionType: string;
  taxYear: number;
  period: string;
  status: string;
  payloadJson: string;
  sourceSnapshotId?: string;
  idempotencyKey: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  submittedAt?: string;
}

export type TaxSubmissionInput = Omit<TaxSubmissionRecord, "id" | "tenantId" | "createdAt" | "updatedAt" | "status"> & { id?: string; status?: string };

export interface TaxSubmissionApprovalRecord {
  id: string;
  tenantId: string;
  submissionId: string;
  requesterId: string;
  approverId: string;
  decision: "approved" | "rejected";
  reason: string;
  createdAt: string;
}

export interface TaxSubmissionReceiptRecord {
  id: string;
  tenantId: string;
  submissionId: string;
  receiptType: string;
  receiptNumber?: string;
  receiptJson: string;
  receivedAt: string;
}

export interface EncryptedTaxCredentialRecord {
  id: string;
  tenantId: string;
  provider: string;
  credentialKey: string;
  version: number;
  encryptionAlgorithm: string;
  keyVersion: string;
  metadataJson: string;
  encryptedBlob: Uint8Array;
  createdBy?: string;
  createdAt: string;
}

export type EncryptedTaxCredentialInput = Omit<EncryptedTaxCredentialRecord, "id" | "tenantId" | "version" | "createdAt"> & { id?: string };
export type TaxCredentialMetadata = Omit<EncryptedTaxCredentialRecord, "encryptedBlob">;

export interface TaxSubmissionJobRecord {
  id: string;
  tenantId: string;
  submissionId: string;
  jobType: string;
  idempotencyKey: string;
  status: string;
  attempts: number;
  availableAt: string;
  lockedAt?: string;
  completedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export type TaxSubmissionJobInput = Omit<TaxSubmissionJobRecord, "id" | "tenantId" | "status" | "attempts" | "createdAt" | "updatedAt" | "availableAt"> & { id?: string; availableAt?: string };

const submissionFromRow = (row: typeof schema.taxSubmissions.$inferSelect): TaxSubmissionRecord => ({
  id: row.id!, tenantId: row.tenantId!, submissionType: row.submissionType!, taxYear: row.taxYear!, period: row.period!, status: row.status!, payloadJson: row.payloadJson!, sourceSnapshotId: row.sourceSnapshotId ?? undefined, idempotencyKey: row.idempotencyKey!, createdBy: row.createdBy!, createdAt: row.createdAt!, updatedAt: row.updatedAt!, submittedAt: row.submittedAt ?? undefined,
});

const getSubmission = async (db: PostgresQueryable, scope: TenantScope, id: string): Promise<TaxSubmissionRecord | null> => {
  const row = (await dbFor(db).select().from(schema.taxSubmissions).where(and(eq(schema.taxSubmissions.tenantId, scope.tenantId), eq(schema.taxSubmissions.id, id))).limit(1))[0];
  return row ? submissionFromRow(row) : null;
};

export const createTaxSubmission = async (db: PostgresQueryable, scope: TenantScope, input: TaxSubmissionInput): Promise<TaxSubmissionRecord> => {
  const database = dbFor(db);
  const existing = (await database.select().from(schema.taxSubmissions).where(and(eq(schema.taxSubmissions.tenantId, scope.tenantId), eq(schema.taxSubmissions.idempotencyKey, input.idempotencyKey))).limit(1))[0];
  if (existing) return submissionFromRow(existing);
  const stamp = now();
  const values = { id: input.id ?? randomUUID(), tenantId: scope.tenantId, submissionType: input.submissionType, taxYear: input.taxYear, period: input.period, status: input.status ?? "draft", payloadJson: input.payloadJson, sourceSnapshotId: input.sourceSnapshotId ?? null, idempotencyKey: input.idempotencyKey, createdBy: input.createdBy, createdAt: stamp, updatedAt: stamp, submittedAt: null };
  await database.insert(schema.taxSubmissions).values(values).onConflictDoNothing();
  const row = (await database.select().from(schema.taxSubmissions).where(and(eq(schema.taxSubmissions.tenantId, scope.tenantId), eq(schema.taxSubmissions.id, values.id))).limit(1))[0];
  if (!row) throw new Error("TAX_SUBMISSION_NOT_PERSISTED");
  return submissionFromRow(row);
};

export const getTaxSubmission = getSubmission;

export const updateTaxSubmissionStatus = async (db: PostgresQueryable, scope: TenantScope, id: string, status: string, submittedAt?: string): Promise<TaxSubmissionRecord> => {
  const stamp = now();
  await dbFor(db).update(schema.taxSubmissions).set({ status, updatedAt: stamp, submittedAt: submittedAt ?? null }).where(and(eq(schema.taxSubmissions.tenantId, scope.tenantId), eq(schema.taxSubmissions.id, id)));
  const row = await getSubmission(db, scope, id);
  if (!row) throw new Error("TAX_SUBMISSION_NOT_FOUND");
  return row;
};

export const approveTaxSubmission = async (db: PostgresQueryable, scope: TenantScope, input: Omit<TaxSubmissionApprovalRecord, "id" | "tenantId" | "createdAt">): Promise<TaxSubmissionApprovalRecord> => {
  if (input.requesterId === input.approverId) throw new Error("TAX_SUBMISSION_CREATOR_CANNOT_APPROVE");
  const submission = await getSubmission(db, scope, input.submissionId);
  if (!submission) throw new Error("TAX_SUBMISSION_NOT_FOUND");
  if (submission.createdBy === input.approverId) throw new Error("TAX_SUBMISSION_CREATOR_CANNOT_APPROVE");
  const record: TaxSubmissionApprovalRecord = { ...input, id: randomUUID(), tenantId: scope.tenantId, createdAt: now() };
  const database = dbFor(db);
  await database.insert(schema.taxSubmissionApprovals).values(record).onConflictDoNothing();
  await database.update(schema.taxSubmissions).set({ status: input.decision, updatedAt: record.createdAt }).where(and(eq(schema.taxSubmissions.tenantId, scope.tenantId), eq(schema.taxSubmissions.id, input.submissionId)));
  const row = (await database.select().from(schema.taxSubmissionApprovals).where(and(eq(schema.taxSubmissionApprovals.tenantId, scope.tenantId), eq(schema.taxSubmissionApprovals.submissionId, input.submissionId), eq(schema.taxSubmissionApprovals.approverId, input.approverId), eq(schema.taxSubmissionApprovals.decision, input.decision))).limit(1))[0];
  if (!row) throw new Error("TAX_SUBMISSION_APPROVAL_NOT_PERSISTED");
  return { id: row.id!, tenantId: row.tenantId!, submissionId: row.submissionId!, requesterId: row.requesterId!, approverId: row.approverId!, decision: row.decision as TaxSubmissionApprovalRecord["decision"], reason: row.reason!, createdAt: row.createdAt! };
};

export const recordTaxSubmissionReceipt = async (db: PostgresQueryable, scope: TenantScope, input: Omit<TaxSubmissionReceiptRecord, "id" | "tenantId"> & { id?: string }): Promise<TaxSubmissionReceiptRecord> => {
  const record = { id: input.id ?? randomUUID(), tenantId: scope.tenantId, submissionId: input.submissionId, receiptType: input.receiptType, receiptNumber: input.receiptNumber ?? null, receiptJson: input.receiptJson, receivedAt: input.receivedAt };
  const database = dbFor(db);
  await database.insert(schema.taxSubmissionReceipts).values(record).onConflictDoNothing();
  const row = (await database.select().from(schema.taxSubmissionReceipts).where(and(eq(schema.taxSubmissionReceipts.tenantId, scope.tenantId), eq(schema.taxSubmissionReceipts.id, record.id))).limit(1))[0];
  if (!row) throw new Error("TAX_SUBMISSION_RECEIPT_NOT_PERSISTED");
  return { id: row.id!, tenantId: row.tenantId!, submissionId: row.submissionId!, receiptType: row.receiptType!, receiptNumber: row.receiptNumber ?? undefined, receiptJson: row.receiptJson!, receivedAt: row.receivedAt! };
};

export const putEncryptedTaxCredential = async (db: PostgresQueryable, scope: TenantScope, input: EncryptedTaxCredentialInput): Promise<EncryptedTaxCredentialRecord> => {
  const database = dbFor(db);
  const current = (await database.select({ version: schema.taxCredentials.version }).from(schema.taxCredentials).where(and(eq(schema.taxCredentials.tenantId, scope.tenantId), eq(schema.taxCredentials.provider, input.provider), eq(schema.taxCredentials.credentialKey, input.credentialKey))).orderBy(desc(schema.taxCredentials.version)).limit(1))[0];
  const record: EncryptedTaxCredentialRecord = { id: input.id ?? randomUUID(), tenantId: scope.tenantId, provider: input.provider, credentialKey: input.credentialKey, version: (current?.version ?? 0) + 1, encryptionAlgorithm: input.encryptionAlgorithm, keyVersion: input.keyVersion, metadataJson: input.metadataJson, encryptedBlob: input.encryptedBlob, createdBy: input.createdBy ?? undefined, createdAt: now() };
  await database.insert(schema.taxCredentials).values(record);
  return record;
};

export const listTaxCredentialMetadata = async (db: PostgresQueryable, scope: TenantScope, provider?: string): Promise<TaxCredentialMetadata[]> => {
  const where = provider ? and(eq(schema.taxCredentials.tenantId, scope.tenantId), eq(schema.taxCredentials.provider, provider)) : eq(schema.taxCredentials.tenantId, scope.tenantId);
  const rows = await dbFor(db).select().from(schema.taxCredentials).where(where).orderBy(asc(schema.taxCredentials.provider), asc(schema.taxCredentials.credentialKey), desc(schema.taxCredentials.version));
  return rows.map((row) => ({ id: row.id!, tenantId: row.tenantId!, provider: row.provider!, credentialKey: row.credentialKey!, version: row.version!, encryptionAlgorithm: row.encryptionAlgorithm!, keyVersion: row.keyVersion!, metadataJson: row.metadataJson!, createdBy: row.createdBy ?? undefined, createdAt: row.createdAt! }));
};

export const getEncryptedTaxCredential = async (db: PostgresQueryable, scope: TenantScope, id: string): Promise<EncryptedTaxCredentialRecord | null> => {
  const row = (await dbFor(db).select().from(schema.taxCredentials).where(and(eq(schema.taxCredentials.tenantId, scope.tenantId), eq(schema.taxCredentials.id, id))).limit(1))[0];
  return row ? { id: row.id!, tenantId: row.tenantId!, provider: row.provider!, credentialKey: row.credentialKey!, version: row.version!, encryptionAlgorithm: row.encryptionAlgorithm!, keyVersion: row.keyVersion!, metadataJson: row.metadataJson!, encryptedBlob: row.encryptedBlob!, createdBy: row.createdBy ?? undefined, createdAt: row.createdAt! } : null;
};

const jobFromRow = (row: typeof schema.taxSubmissionJobs.$inferSelect): TaxSubmissionJobRecord => ({ id: row.id!, tenantId: row.tenantId!, submissionId: row.submissionId!, jobType: row.jobType!, idempotencyKey: row.idempotencyKey!, status: row.status!, attempts: row.attempts!, availableAt: row.availableAt!, lockedAt: row.lockedAt ?? undefined, completedAt: row.completedAt ?? undefined, lastError: row.lastError ?? undefined, createdAt: row.createdAt!, updatedAt: row.updatedAt! });

export const enqueueTaxSubmissionJob = async (db: PostgresQueryable, scope: TenantScope, input: TaxSubmissionJobInput): Promise<TaxSubmissionJobRecord> => {
  const database = dbFor(db);
  const existing = (await database.select().from(schema.taxSubmissionJobs).where(and(eq(schema.taxSubmissionJobs.tenantId, scope.tenantId), eq(schema.taxSubmissionJobs.jobType, input.jobType), eq(schema.taxSubmissionJobs.idempotencyKey, input.idempotencyKey))).limit(1))[0];
  if (existing) return jobFromRow(existing);
  const stamp = now();
  const values = { id: input.id ?? randomUUID(), tenantId: scope.tenantId, submissionId: input.submissionId, jobType: input.jobType, idempotencyKey: input.idempotencyKey, status: "pending", attempts: 0, availableAt: input.availableAt ?? stamp, lockedAt: null, completedAt: null, lastError: null, createdAt: stamp, updatedAt: stamp };
  await database.insert(schema.taxSubmissionJobs).values(values).onConflictDoNothing();
  const row = (await database.select().from(schema.taxSubmissionJobs).where(and(eq(schema.taxSubmissionJobs.tenantId, scope.tenantId), eq(schema.taxSubmissionJobs.id, values.id))).limit(1))[0];
  if (!row) throw new Error("TAX_SUBMISSION_JOB_NOT_PERSISTED");
  return jobFromRow(row);
};

export const claimTaxSubmissionJob = async (db: PostgresQueryable, scope: TenantScope, jobType?: string): Promise<TaxSubmissionJobRecord | null> => {
  const stamp = now();
  const values: unknown[] = [scope.tenantId, stamp];
  const jobFilter = jobType ? "AND job_type = $3" : "";
  if (jobType) values.push(jobType);
  const result = await db.query<{
    id: string;
    tenant_id: string;
    submission_id: string;
    job_type: string;
    idempotency_key: string;
    status: string;
    attempts: number;
    available_at: string;
    locked_at: string | null;
    completed_at: string | null;
    last_error: string | null;
    created_at: string;
    updated_at: string;
  }>(
    `UPDATE tax_submission_jobs
     SET status = 'running', attempts = attempts + 1, locked_at = $2, updated_at = $2
     WHERE id = (
       SELECT id FROM tax_submission_jobs
       WHERE tenant_id = $1 AND status = 'pending' AND available_at <= $2 ${jobFilter}
       ORDER BY available_at, created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING id, tenant_id, submission_id, job_type, idempotency_key, status, attempts,
       available_at, locked_at, completed_at, last_error, created_at, updated_at`,
    values,
  );
  const row = result.rows[0];
  return row ? {
    id: row.id,
    tenantId: row.tenant_id,
    submissionId: row.submission_id,
    jobType: row.job_type,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    lockedAt: row.locked_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
};

export const completeTaxSubmissionJob = async (db: PostgresQueryable, scope: TenantScope, id: string): Promise<TaxSubmissionJobRecord> => updateTaxSubmissionJob(db, scope, id, { status: "completed", completedAt: now(), lockedAt: null, lastError: null });
export const failTaxSubmissionJob = async (db: PostgresQueryable, scope: TenantScope, id: string, error: string, availableAt?: string): Promise<TaxSubmissionJobRecord> => updateTaxSubmissionJob(db, scope, id, { status: "pending", availableAt: availableAt ?? now(), lockedAt: null, lastError: error });

const updateTaxSubmissionJob = async (db: PostgresQueryable, scope: TenantScope, id: string, values: Partial<typeof schema.taxSubmissionJobs.$inferInsert>): Promise<TaxSubmissionJobRecord> => {
  await dbFor(db).update(schema.taxSubmissionJobs).set({ ...values, updatedAt: now() }).where(and(eq(schema.taxSubmissionJobs.tenantId, scope.tenantId), eq(schema.taxSubmissionJobs.id, id)));
  const row = (await dbFor(db).select().from(schema.taxSubmissionJobs).where(and(eq(schema.taxSubmissionJobs.tenantId, scope.tenantId), eq(schema.taxSubmissionJobs.id, id))).limit(1))[0];
  if (!row) throw new Error("TAX_SUBMISSION_JOB_NOT_FOUND");
  return jobFromRow(row);
};

export const listTaxSubmissionJobs = async (db: PostgresQueryable, scope: TenantScope, status?: string): Promise<TaxSubmissionJobRecord[]> => {
  const where = status ? and(eq(schema.taxSubmissionJobs.tenantId, scope.tenantId), eq(schema.taxSubmissionJobs.status, status)) : eq(schema.taxSubmissionJobs.tenantId, scope.tenantId);
  return (await dbFor(db).select().from(schema.taxSubmissionJobs).where(where).orderBy(desc(schema.taxSubmissionJobs.createdAt))).map(jobFromRow);
};
