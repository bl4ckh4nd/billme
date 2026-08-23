import { asc, eq } from 'drizzle-orm';
import type { PostgresQueryable } from './connection.js';
import { createDrizzle, schema, tryCreateDrizzle } from './drizzle.js';

const csvCell = (value: string | number | null): string => {
  const text = value === null ? '' : String(value);
  return `"${text.replaceAll('"', '""')}"`;
};

/** Export only the current tenant's audit stream in the desktop-compatible CSV shape. */
export const exportPostgresAuditCsv = async (
  target: PostgresQueryable,
  tenantId: string,
): Promise<string> => {
  const db = tryCreateDrizzle(target) ?? createDrizzle(target as Parameters<typeof createDrizzle>[0]);
  const rows = await db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.tenantId, tenantId))
    .orderBy(asc(schema.auditLog.sequence));
  const header = 'sequence,ts,entity_type,entity_id,action,reason,prev_hash,hash,actor,before_json,after_json';
  const body = rows.map((row) => [
    row.sequence!,
    row.ts!,
    row.entityType!,
    row.entityId!,
    row.action!,
    row.reason ?? null,
    row.prevHash ?? null,
    row.hash!,
    row.actor!,
    row.beforeJson ?? null,
    row.afterJson ?? null,
  ].map(csvCell).join(','));
  return `\uFEFF${[header, ...body].join('\n')}`;
};
