import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { and, asc, eq } from 'drizzle-orm';
import { createDrizzle, schema } from '@billme/desktop-data/drizzle';
import type {
  AccountSuggestionRule,
  AccountSuggestionRuleField,
  AccountSuggestionRuleFlowType,
  AccountSuggestionRuleOperator,
  UpsertAccountSuggestionRuleInput,
} from '@billme/accounting-shared';
import type { TenantScope } from '@billme/server-core';
import { getTenantId } from '../tenantScope';

export type {
  AccountSuggestionRule,
  AccountSuggestionRuleField,
  AccountSuggestionRuleFlowType,
  AccountSuggestionRuleOperator,
  UpsertAccountSuggestionRuleInput,
} from '@billme/accounting-shared';

interface RuleRow {
  id: string;
  tenant_id: string;
  chart: 'SKR03' | 'SKR04';
  priority: number;
  field: AccountSuggestionRuleField;
  operator: AccountSuggestionRuleOperator;
  value: string;
  target_account_number: string;
  flow_type: AccountSuggestionRuleFlowType;
  active: number;
  created_at: string;
  updated_at: string;
}

const mapRow = (row: RuleRow): AccountSuggestionRule => ({
  id: row.id,
  tenantId: row.tenant_id,
  chart: row.chart,
  priority: row.priority,
  field: row.field,
  operator: row.operator,
  value: row.value,
  targetAccountNumber: row.target_account_number,
  flowType: row.flow_type,
  active: row.active === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const listAccountSuggestionRules = (
  db: Database.Database,
  args: { chart?: 'SKR03' | 'SKR04'; activeOnly?: boolean } = {},
  scope: TenantScope,
): AccountSuggestionRule[] => {
  const tenantId = getTenantId(scope);
  const drizzle = createDrizzle(db);
  const conditions = [eq(schema.accountSuggestionRules.tenantId, tenantId)];
  if (args.chart) conditions.push(eq(schema.accountSuggestionRules.chart, args.chart));
  if (args.activeOnly) conditions.push(eq(schema.accountSuggestionRules.active, 1));
  const rows = drizzle.select({
    id: schema.accountSuggestionRules.id,
    tenant_id: schema.accountSuggestionRules.tenantId,
    chart: schema.accountSuggestionRules.chart,
    priority: schema.accountSuggestionRules.priority,
    field: schema.accountSuggestionRules.field,
    operator: schema.accountSuggestionRules.operator,
    value: schema.accountSuggestionRules.value,
    target_account_number: schema.accountSuggestionRules.targetAccountNumber,
    flow_type: schema.accountSuggestionRules.flowType,
    active: schema.accountSuggestionRules.active,
    created_at: schema.accountSuggestionRules.createdAt,
    updated_at: schema.accountSuggestionRules.updatedAt,
  }).from(schema.accountSuggestionRules).where(and(...conditions))
    .orderBy(asc(schema.accountSuggestionRules.chart), asc(schema.accountSuggestionRules.priority), asc(schema.accountSuggestionRules.createdAt)).all() as RuleRow[];

  return rows.map(mapRow);
};

export const upsertAccountSuggestionRule = (
  db: Database.Database,
  input: UpsertAccountSuggestionRuleInput,
  scope: TenantScope,
): AccountSuggestionRule => {
  const now = new Date().toISOString();
  const id = input.id ?? randomUUID();
  const tenantId = input.tenantId ?? getTenantId(scope);
  const active = input.active !== false;
  const flowType = input.flowType ?? 'any';

  const drizzle = createDrizzle(db);
  drizzle.insert(schema.accountSuggestionRules).values({
    id,
    tenantId,
    chart: input.chart,
    priority: input.priority,
    field: input.field,
    operator: input.operator,
    value: input.value.trim(),
    targetAccountNumber: input.targetAccountNumber.trim(),
    flowType,
    active: active ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({ target: schema.accountSuggestionRules.id, set: {
    tenantId, chart: input.chart, priority: input.priority, field: input.field,
    operator: input.operator, value: input.value.trim(), targetAccountNumber: input.targetAccountNumber.trim(),
    flowType, active: active ? 1 : 0, updatedAt: now,
  }}).run();

  const row = drizzle.select({
    id: schema.accountSuggestionRules.id,
    tenant_id: schema.accountSuggestionRules.tenantId,
    chart: schema.accountSuggestionRules.chart,
    priority: schema.accountSuggestionRules.priority,
    field: schema.accountSuggestionRules.field,
    operator: schema.accountSuggestionRules.operator,
    value: schema.accountSuggestionRules.value,
    target_account_number: schema.accountSuggestionRules.targetAccountNumber,
    flow_type: schema.accountSuggestionRules.flowType,
    active: schema.accountSuggestionRules.active,
    created_at: schema.accountSuggestionRules.createdAt,
    updated_at: schema.accountSuggestionRules.updatedAt,
  }).from(schema.accountSuggestionRules).where(eq(schema.accountSuggestionRules.id, id)).get() as RuleRow | undefined;

  if (!row) {
    throw new Error('Failed to upsert account suggestion rule');
  }
  return mapRow(row);
};

export const deleteAccountSuggestionRule = (db: Database.Database, id: string, scope: TenantScope): void => {
  createDrizzle(db).delete(schema.accountSuggestionRules).where(and(
    eq(schema.accountSuggestionRules.tenantId, getTenantId(scope)),
    eq(schema.accountSuggestionRules.id, id),
  )).run();
};
