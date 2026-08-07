import type Database from 'better-sqlite3';
import { and, asc, count, eq, like, or } from 'drizzle-orm';
import { createDrizzle, schema } from '@billme/desktop-data/drizzle';
import type { LedgerAccount, LedgerAccountStats, LedgerChart, ListLedgerAccountsArgs } from '@billme/accounting-shared';
import type { TenantScope } from '@billme/server-core';
import { getTenantId } from '../tenantScope';

export type { LedgerAccount, LedgerAccountStats, ListLedgerAccountsArgs, LedgerChart } from '@billme/accounting-shared';

export interface UpsertLedgerAccount {
  chart: LedgerChart;
  accountNumber: string;
  name: string;
  source?: string;
}

const toLedgerAccount = (row: {
  id: string;
  chart: string;
  account_number: string;
  name: string;
  keywords_csv: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}): LedgerAccount => ({
  id: row.id,
  chart: row.chart as LedgerChart,
  accountNumber: row.account_number,
  name: row.name,
  keywords: row.keywords_csv
    ? row.keywords_csv
      .split('|')
      .map((v) => v.trim())
      .filter(Boolean)
    : undefined,
  source: row.source,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const listLedgerAccounts = (
  db: Database.Database,
  args: ListLedgerAccountsArgs = {},
  scope: TenantScope,
): LedgerAccount[] => {
  const tenantId = getTenantId(scope);
  const limit = Math.max(1, Math.min(10_000, Math.floor(args.limit ?? 500)));
  const offset = Math.max(0, Math.floor(args.offset ?? 0));
  const drizzle = createDrizzle(db);
  const conditions = [];
  if (args.chart) conditions.push(eq(schema.ledgerAccounts.chart, args.chart));
  if (args.search && args.search.trim().length > 0) {
    const search = `%${args.search.trim()}%`;
    conditions.push(or(like(schema.ledgerAccounts.accountNumber, search), like(schema.ledgerAccounts.name, search)));
  }
  const rows = drizzle.select({
    id: schema.ledgerAccounts.id,
    chart: schema.ledgerAccounts.chart,
    account_number: schema.ledgerAccounts.accountNumber,
    name: schema.ledgerAccounts.name,
    source: schema.ledgerAccounts.source,
    created_at: schema.ledgerAccounts.createdAt,
    updated_at: schema.ledgerAccounts.updatedAt,
  }).from(schema.ledgerAccounts).where(conditions.length ? and(...conditions) : undefined)
    .orderBy(asc(schema.ledgerAccounts.chart), asc(schema.ledgerAccounts.accountNumber)).limit(limit).offset(offset).all() as Array<{
    id: string;
    chart: string;
    account_number: string;
    name: string;
    keywords_csv: string | null;
    source: string;
    created_at: string;
    updated_at: string;
  }>;

  const keywordRows = drizzle.select({ chart: schema.accountKeywords.chart, account_number: schema.accountKeywords.accountNumber, keyword: schema.accountKeywords.keyword })
    .from(schema.accountKeywords).where(and(eq(schema.accountKeywords.tenantId, tenantId), eq(schema.accountKeywords.active, 1))).all();
  return rows.map((row) => toLedgerAccount({ ...row, keywords_csv: keywordRows.filter((k) => k.chart === row.chart && k.account_number === row.account_number).map((k) => k.keyword).join('|') || null }));
};

export const countLedgerAccounts = (db: Database.Database, chart?: LedgerChart): number => {
  const row = createDrizzle(db).select({ count: count() }).from(schema.ledgerAccounts)
    .where(chart ? eq(schema.ledgerAccounts.chart, chart) : undefined).get();
  return Number(row?.count ?? 0);
};

export const getLedgerAccountStats = (db: Database.Database): LedgerAccountStats => {
  const rows = createDrizzle(db).select({ chart: schema.ledgerAccounts.chart, c: count() })
    .from(schema.ledgerAccounts).groupBy(schema.ledgerAccounts.chart).all() as Array<{ chart: string; c: number }>;

  const byChart: Record<LedgerChart, number> = {
    SKR03: 0,
    SKR04: 0,
  };

  for (const row of rows) {
    if (row.chart === 'SKR03' || row.chart === 'SKR04') {
      byChart[row.chart] = row.c;
    }
  }

  return {
    total: byChart.SKR03 + byChart.SKR04,
    byChart,
  };
};

export const upsertLedgerAccounts = (
  db: Database.Database,
  rows: UpsertLedgerAccount[],
): { inserted: number; updated: number; total: number } => {
  if (rows.length === 0) {
    return { inserted: 0, updated: 0, total: 0 };
  }

  const drizzle = createDrizzle(db);
  const existingRows = drizzle.select({ chart: schema.ledgerAccounts.chart, account_number: schema.ledgerAccounts.accountNumber })
    .from(schema.ledgerAccounts).all() as Array<{ chart: string; account_number: string }>;
  const existingKeys = new Set(existingRows.map((row) => `${row.chart}:${row.account_number}`));

  let inserted = 0;
  let updated = 0;

  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const row of rows) {
      const key = `${row.chart}:${row.accountNumber}`;
      if (existingKeys.has(key)) {
        updated += 1;
      } else {
        inserted += 1;
        existingKeys.add(key);
      }

      drizzle.insert(schema.ledgerAccounts).values({
        id: `ledger:${row.chart}:${row.accountNumber}`,
        chart: row.chart,
        accountNumber: row.accountNumber,
        name: row.name,
        source: row.source ?? 'manual',
        createdAt: now,
        updatedAt: now,
      }).onConflictDoUpdate({ target: [schema.ledgerAccounts.chart, schema.ledgerAccounts.accountNumber], set: {
        name: row.name,
        source: row.source ?? 'manual',
        updatedAt: now,
      }}).run();
    }
  });

  tx();
  return {
    inserted,
    updated,
    total: inserted + updated,
  };
};
