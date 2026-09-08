import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { asc, eq, and } from 'drizzle-orm';
import { createDrizzle, schema } from './drizzle';

export type EurRuleField = 'counterparty' | 'purpose' | 'any';
export type EurRuleOperator = 'contains' | 'equals' | 'startsWith';

export interface EurRule {
  id: string;
  taxYear: number;
  priority: number;
  field: EurRuleField;
  operator: EurRuleOperator;
  value: string;
  targetEurLineId: string;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertEurRuleInput {
  id?: string;
  taxYear: number;
  priority: number;
  field: EurRuleField;
  operator: EurRuleOperator;
  value: string;
  targetEurLineId: string;
  active?: boolean;
}

interface RuleRow {
  id: string;
  tax_year: number;
  priority: number;
  field: EurRuleField;
  operator: EurRuleOperator;
  value: string;
  target_eur_line_id: string;
  active: number;
  created_at: string;
  updated_at: string;
}

const mapRow = (row: RuleRow): EurRule => ({
  id: row.id,
  taxYear: row.tax_year,
  priority: row.priority,
  field: row.field,
  operator: row.operator,
  value: row.value,
  targetEurLineId: row.target_eur_line_id,
  active: row.active === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const listEurRules = (db: Database.Database, taxYear: number): EurRule[] => {
  return createDrizzle(db).select().from(schema.eurRules)
    .where(and(eq(schema.eurRules.taxYear, taxYear), eq(schema.eurRules.active, 1)))
    .orderBy(asc(schema.eurRules.priority), asc(schema.eurRules.createdAt))
    .all().map(mapRowFromSchema);
};

export const listAllEurRules = (db: Database.Database, taxYear: number): EurRule[] => {
  return createDrizzle(db).select().from(schema.eurRules)
    .where(eq(schema.eurRules.taxYear, taxYear))
    .orderBy(asc(schema.eurRules.priority), asc(schema.eurRules.createdAt))
    .all().map(mapRowFromSchema);
};

export const upsertEurRule = (db: Database.Database, input: UpsertEurRuleInput): EurRule => {
  const now = new Date().toISOString();
  const id = input.id ?? randomUUID();
  const active = input.active !== false;

  createDrizzle(db).insert(schema.eurRules).values({
    id,
    taxYear: input.taxYear,
    priority: input.priority,
    field: input.field,
    operator: input.operator,
    value: input.value,
    targetEurLineId: input.targetEurLineId,
    active: active ? 1 : 0,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({ target: schema.eurRules.id, set: {
    priority: input.priority,
    field: input.field,
    operator: input.operator,
    value: input.value,
    targetEurLineId: input.targetEurLineId,
    active: active ? 1 : 0,
    updatedAt: now,
  }}).run();

  const row = createDrizzle(db).select().from(schema.eurRules).where(eq(schema.eurRules.id, id)).get();
  if (!row) throw new Error(`EÜR rule ${id} was not persisted`);
  return mapRowFromSchema(row);
};

export const deleteEurRule = (db: Database.Database, id: string): void => {
  createDrizzle(db).delete(schema.eurRules).where(eq(schema.eurRules.id, id)).run();
};

const mapRowFromSchema = (row: typeof schema.eurRules.$inferSelect): EurRule => mapRow({
  id: row.id!,
  tax_year: row.taxYear!,
  priority: row.priority!,
  field: row.field as EurRuleField,
  operator: row.operator as EurRuleOperator,
  value: row.value!,
  target_eur_line_id: row.targetEurLineId!,
  active: row.active!,
  created_at: row.createdAt!,
  updated_at: row.updatedAt!,
});
