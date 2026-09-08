import type Database from 'better-sqlite3';
import { asc, desc, eq } from 'drizzle-orm';
import { createDrizzle, schema } from '@billme/desktop-data/drizzle';
import type { ProWorkflowEntry } from '@billme/accounting-shared';
import type { TenantScope } from '@billme/server-core';
import { getTenantId } from '../tenantScope';

export const listProWorkflowEntries = (db: Database.Database, scope: TenantScope): ProWorkflowEntry[] => {
  const tenantId = getTenantId(scope);
  const rows = createDrizzle(db).select({
    transaction_id: schema.proWorkflowEntries.transactionId,
    transaction_json: schema.proWorkflowEntries.transactionJson,
    draft_json: schema.proWorkflowEntries.draftJson,
    updated_at: schema.proWorkflowEntries.updatedAt,
  }).from(schema.proWorkflowEntries).where(eq(schema.proWorkflowEntries.tenantId, tenantId))
    .orderBy(desc(schema.proWorkflowEntries.updatedAt), asc(schema.proWorkflowEntries.transactionId)).all();

  return rows.map((row) => ({
    transactionId: row.transaction_id,
    transactionJson: row.transaction_json,
    draftJson: row.draft_json,
    updatedAt: row.updated_at,
  }));
};

export const upsertProWorkflowEntry = (
  db: Database.Database,
  args: {
    transactionId: string;
    transactionJson: string;
    draftJson: string;
  },
  scope: TenantScope,
): { ok: true } => {
  const tenantId = getTenantId(scope);
  const now = new Date().toISOString();
  createDrizzle(db).insert(schema.proWorkflowEntries).values({
    tenantId,
    transactionId: args.transactionId,
    transactionJson: args.transactionJson,
    draftJson: args.draftJson,
    updatedAt: now,
  }).onConflictDoUpdate({ target: [schema.proWorkflowEntries.tenantId, schema.proWorkflowEntries.transactionId], set: {
    transactionJson: args.transactionJson,
    draftJson: args.draftJson,
    updatedAt: now,
  }}).run();

  return { ok: true };
};
