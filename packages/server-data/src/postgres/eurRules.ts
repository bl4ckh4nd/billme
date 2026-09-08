import { randomUUID } from 'node:crypto';
import type { TenantScope } from '@billme/server-core';
import type { PostgresQueryable } from './connection.js';
import type { ServerEurRuleRecord } from './proAccounting.js';

type EurRuleRow = {
  id: string;
  tenant_id: string;
  tax_year: number;
  priority: number;
  field: string;
  operator: string;
  value: string;
  target_eur_line_id: string;
  active: boolean;
  created_at: string;
  updated_at: string;
};

const query = async <T>(db: PostgresQueryable, text: string, values: unknown[] = []): Promise<T[]> =>
  (await db.query(text, values)).rows as T[];

const mapRule = (row: EurRuleRow): ServerEurRuleRecord => ({
  id: row.id,
  tenantId: row.tenant_id,
  taxYear: Number(row.tax_year),
  priority: Number(row.priority),
  field: row.field,
  operator: row.operator,
  value: row.value,
  targetEurLineId: row.target_eur_line_id,
  active: Boolean(row.active),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export type ServerEurRuleInput = Omit<ServerEurRuleRecord, 'tenantId' | 'id' | 'active' | 'createdAt' | 'updatedAt'> & {
  id?: string;
  active?: boolean;
};

export const listServerEurRules = async (
  db: PostgresQueryable,
  scope: TenantScope,
  taxYear: number,
): Promise<ServerEurRuleRecord[]> => {
  const rows = await query<EurRuleRow>(db, `
    SELECT id,tenant_id,tax_year,priority,field,operator,value,target_eur_line_id,active,created_at,updated_at
    FROM eur_rules
    WHERE tenant_id=$1 AND tax_year=$2
    ORDER BY priority ASC, created_at ASC, id ASC`, [scope.tenantId, taxYear]);
  return rows.map(mapRule);
};

export const upsertServerEurRule = async (
  db: PostgresQueryable,
  scope: TenantScope,
  input: ServerEurRuleInput,
): Promise<ServerEurRuleRecord> => {
  const id = input.id ?? randomUUID();
  const existing = (await query<EurRuleRow>(db, `
    SELECT id,tenant_id,tax_year,priority,field,operator,value,target_eur_line_id,active,created_at,updated_at
    FROM eur_rules WHERE id=$1`, [id]))[0];
  if (existing && existing.tenant_id !== scope.tenantId) {
    throw new Error('EUR_RULE_NOT_FOUND');
  }
  const now = new Date().toISOString();
  const createdAt = existing?.created_at ?? now;
  const record: ServerEurRuleRecord = {
    id,
    tenantId: scope.tenantId,
    taxYear: input.taxYear,
    priority: input.priority,
    field: input.field,
    operator: input.operator,
    value: input.value,
    targetEurLineId: input.targetEurLineId,
    active: input.active ?? true,
    createdAt,
    updatedAt: now,
  };
  if (existing) {
    await db.query(`
      UPDATE eur_rules
      SET tax_year=$1,priority=$2,field=$3,operator=$4,value=$5,target_eur_line_id=$6,active=$7,updated_at=$8
      WHERE tenant_id=$9 AND id=$10`, [
      record.taxYear, record.priority, record.field, record.operator, record.value,
      record.targetEurLineId, record.active, record.updatedAt, scope.tenantId, record.id,
    ]);
  } else {
    await db.query(`
      INSERT INTO eur_rules
        (id,tenant_id,tax_year,priority,field,operator,value,target_eur_line_id,active,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`, [
      record.id, record.tenantId, record.taxYear, record.priority, record.field, record.operator,
      record.value, record.targetEurLineId, record.active, record.createdAt,
    ]);
  }
  return record;
};

export const deleteServerEurRule = async (
  db: PostgresQueryable,
  scope: TenantScope,
  id: string,
): Promise<ServerEurRuleRecord | null> => {
  const existing = (await query<EurRuleRow>(db, `
    SELECT id,tenant_id,tax_year,priority,field,operator,value,target_eur_line_id,active,created_at,updated_at
    FROM eur_rules WHERE tenant_id=$1 AND id=$2`, [scope.tenantId, id]))[0];
  if (!existing) return null;
  await db.query('DELETE FROM eur_rules WHERE tenant_id=$1 AND id=$2', [scope.tenantId, id]);
  return mapRule(existing);
};
