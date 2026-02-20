import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

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
  const rows = db
    .prepare(
      `SELECT id, tax_year, priority, field, operator, value, target_eur_line_id, active, created_at, updated_at
       FROM eur_rules
       WHERE tax_year = ? AND active = 1
       ORDER BY priority ASC, created_at ASC`,
    )
    .all(taxYear) as RuleRow[];

  return rows.map(mapRow);
};

export const listAllEurRules = (db: Database.Database, taxYear: number): EurRule[] => {
  const rows = db
    .prepare(
      `SELECT id, tax_year, priority, field, operator, value, target_eur_line_id, active, created_at, updated_at
       FROM eur_rules
       WHERE tax_year = ?
       ORDER BY priority ASC, created_at ASC`,
    )
    .all(taxYear) as RuleRow[];

  return rows.map(mapRow);
};

export const upsertEurRule = (db: Database.Database, input: UpsertEurRuleInput): EurRule => {
  const now = new Date().toISOString();
  const id = input.id ?? randomUUID();
  const active = input.active !== false;

  db.prepare(
    `INSERT INTO eur_rules (
       id, tax_year, priority, field, operator, value, target_eur_line_id, active, created_at, updated_at
     ) VALUES (
       @id, @taxYear, @priority, @field, @operator, @value, @targetEurLineId, @active, @createdAt, @updatedAt
     )
     ON CONFLICT(id) DO UPDATE SET
       priority = excluded.priority,
       field = excluded.field,
       operator = excluded.operator,
       value = excluded.value,
       target_eur_line_id = excluded.target_eur_line_id,
       active = excluded.active,
       updated_at = excluded.updated_at`,
  ).run({
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
  });

  const row = db
    .prepare(
      `SELECT id, tax_year, priority, field, operator, value, target_eur_line_id, active, created_at, updated_at
       FROM eur_rules WHERE id = ?`,
    )
    .get(id) as RuleRow;

  return mapRow(row);
};

export const deleteEurRule = (db: Database.Database, id: string): void => {
  db.prepare('DELETE FROM eur_rules WHERE id = ?').run(id);
};
