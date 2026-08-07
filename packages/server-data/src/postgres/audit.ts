import crypto from "node:crypto";
import type { Pool } from "pg";
import { asc, desc, eq } from "drizzle-orm";
import { createDrizzle, schema } from "./drizzle.js";
import type {
  AuditEntry,
  AuditEntryDraft,
  AuditSubject,
  TenantScope,
} from "@billme/server-core";
import type { AuditActor } from "@billme/server-core/ports";
import type { PostgresTransactionClient } from "./connection.js";
import { withSerializablePostgresTransaction } from "./connection.js";

type AuditRow = {
  sequence: string | number;
  ts: string;
  entity_type: string;
  entity_id: string;
  action: string;
  reason: string | null;
  before_json: string | null;
  after_json: string | null;
  prev_hash: string | null;
  hash: string;
  actor: string;
};

export interface AuditChainVerificationResult {
  ok: boolean;
  errors: Array<{ sequence: number; message: string }>;
  count: number;
  headHash: string | null;
}

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",");
  return `{${body}}`;
};

export const sha256Hex = (input: string): string => {
  return crypto.createHash("sha256").update(input).digest("hex");
};

export const encodeAuditActor = (actor: AuditActor): string => {
  if (actor.type === "system" && actor.displayName === "local" && !actor.id) {
    return "local";
  }

  return JSON.stringify(actor);
};

export const decodeAuditActor = (value: string): AuditActor => {
  if (!value || value === "local") {
    return { type: "system", displayName: "local" };
  }

  try {
    const parsed = JSON.parse(value) as AuditActor;
    if (parsed && typeof parsed === "object" && parsed.type) {
      return parsed;
    }
  } catch {
    // ignored
  }

  return {
    type: "system",
    displayName: value,
  };
};

export const verifyAuditChainRows = (
  rows: AuditRow[],
): AuditChainVerificationResult => {
  const normalizedRows = rows
    .map((row) => ({
      ...row,
      sequence: Number(row.sequence),
    }))
    .sort((left, right) => left.sequence - right.sequence);

  const errors: Array<{ sequence: number; message: string }> = [];
  let expectedPrevHash: string | null = null;

  for (const row of normalizedRows) {
    if ((row.prev_hash ?? null) !== expectedPrevHash) {
      errors.push({
        sequence: row.sequence,
        message: `prev_hash mismatch (expected ${expectedPrevHash ?? "null"})`,
      });
    }

    const payload = {
      sequence: row.sequence,
      ts: row.ts,
      entityType: row.entity_type,
      entityId: row.entity_id,
      action: row.action,
      reason: row.reason ?? null,
      before: parseJson(row.before_json, null),
      after: parseJson(row.after_json, null),
      prevHash: row.prev_hash ?? null,
      actor: row.actor,
    };

    const computedHash = sha256Hex(
      `${row.prev_hash ?? ""}:${stableStringify(payload)}`,
    );
    if (computedHash !== row.hash) {
      errors.push({ sequence: row.sequence, message: "hash mismatch" });
    }

    expectedPrevHash = row.hash;
  }

  return {
    ok: errors.length === 0,
    errors,
    count: normalizedRows.length,
    headHash: expectedPrevHash,
  };
};

const rowToAuditEntry = (
  scope: TenantScope,
  row: AuditRow,
  subject: AuditSubject,
): AuditEntry => ({
  sequence: Number(row.sequence),
  occurredAt: row.ts,
  action: row.action,
  reason: row.reason ?? undefined,
  actor: decodeAuditActor(row.actor),
  subject: {
    entityType: row.entity_type,
    entityId: row.entity_id,
    tenantId: subject.tenantId ?? scope.tenantId,
  },
  change: {
    before: parseJson(row.before_json, null),
    after: parseJson(row.after_json, null),
  },
  prevHash: row.prev_hash,
  hash: row.hash,
});

const appendWithClient = async (
  client: PostgresTransactionClient,
  scope: TenantScope,
  entry: AuditEntryDraft,
): Promise<AuditEntry> => {
  const db = createDrizzle(client);
  const tenantId = entry.subject.tenantId ?? scope.tenantId;
  await db
    .insert(schema.auditHeads)
    .values({ tenantId, sequence: 0, hash: null })
    .onConflictDoNothing();
  const head = await db
    .select()
    .from(schema.auditHeads)
    .where(eq(schema.auditHeads.tenantId, tenantId))
    .for("update")
    .limit(1);
  const previousSequence = head[0]?.sequence ?? 0;
  const prevHash = head[0]?.hash ?? null;
  const sequence = previousSequence + 1;
  const actor = encodeAuditActor(entry.actor);
  const beforeJson =
    entry.change?.before === undefined
      ? null
      : stableStringify(entry.change.before);
  const afterJson =
    entry.change?.after === undefined
      ? null
      : stableStringify(entry.change.after);
  const payload = {
    sequence,
    ts: entry.occurredAt,
    entityType: entry.subject.entityType,
    entityId: entry.subject.entityId,
    action: entry.action,
    reason: entry.reason ?? null,
    before: entry.change?.before ?? null,
    after: entry.change?.after ?? null,
    prevHash,
    actor,
  };
  const hash = sha256Hex(`${prevHash ?? ""}:${stableStringify(payload)}`);
  await db.insert(schema.auditLog).values({
    tenantId,
    sequence,
    ts: entry.occurredAt,
    entityType: entry.subject.entityType,
    entityId: entry.subject.entityId,
    action: entry.action,
    reason: entry.reason ?? null,
    beforeJson,
    afterJson,
    prevHash,
    hash,
    actor,
  });
  await db
    .update(schema.auditHeads)
    .set({ sequence, hash })
    .where(eq(schema.auditHeads.tenantId, tenantId));
  return {
    sequence,
    occurredAt: entry.occurredAt,
    action: entry.action,
    reason: entry.reason,
    actor: entry.actor,
    subject: { ...entry.subject, tenantId },
    change: entry.change,
    prevHash,
    hash,
  };
};

const isPool = (target: Pool | PostgresTransactionClient): target is Pool => {
  return !("release" in target);
};

export const createPostgresAuditLogPort = (
  target: Pool | PostgresTransactionClient,
) => ({
  async append(
    scope: TenantScope,
    entry: AuditEntryDraft,
  ): Promise<AuditEntry> {
    if (isPool(target)) {
      return withSerializablePostgresTransaction(target, (client) =>
        appendWithClient(client, scope, entry),
      );
    }

    return appendWithClient(target, scope, entry);
  },
  async listBySubject(
    scope: TenantScope,
    subject: AuditSubject,
  ): Promise<AuditEntry[]> {
    const db = createDrizzle(target as Pool);
    const rows = await db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.tenantId, subject.tenantId ?? scope.tenantId))
      .orderBy(desc(schema.auditLog.sequence));
    return rows
      .filter(
        (row) =>
          row.entityType === subject.entityType &&
          row.entityId === subject.entityId,
      )
      .map((row) =>
        rowToAuditEntry(
          scope,
          {
            sequence: row.sequence!,
            ts: row.ts!,
            entity_type: row.entityType!,
            entity_id: row.entityId!,
            action: row.action!,
            reason: row.reason ?? null,
            before_json: row.beforeJson ?? null,
            after_json: row.afterJson ?? null,
            prev_hash: row.prevHash ?? null,
            hash: row.hash!,
            actor: row.actor!,
          },
          subject,
        ),
      );
  },
});

export const verifyPostgresAuditChain = async (
  target: Pool | PostgresTransactionClient,
  tenantId?: string,
): Promise<AuditChainVerificationResult> => {
  const db = createDrizzle(target as Pool);
  const rows = await db
    .select()
    .from(schema.auditLog)
    .where(tenantId ? eq(schema.auditLog.tenantId, tenantId) : undefined)
    .orderBy(asc(schema.auditLog.sequence));
  return verifyAuditChainRows(
    rows.map((row) => ({
      sequence: row.sequence!,
      ts: row.ts!,
      entity_type: row.entityType!,
      entity_id: row.entityId!,
      action: row.action!,
      reason: row.reason ?? null,
      before_json: row.beforeJson ?? null,
      after_json: row.afterJson ?? null,
      prev_hash: row.prevHash ?? null,
      hash: row.hash!,
      actor: row.actor!,
    })),
  );
};
