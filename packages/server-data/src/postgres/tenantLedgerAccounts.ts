import type { PostgresQueryable } from './connection.js';

/**
 * The accounts a tenant can book on: the global DATEV catalogue plus the tenant's own accounts
 * (tenant_ledger_accounts, migration 0048), minus the ones the tenant deactivated. A tenant row
 * wins over the catalogue, so a deactivated standard account is refused like an unknown one.
 * Reversals copy the lines of the original and never pass through this check.
 */
export const usableAccountNumbers = async (db: PostgresQueryable, tenantId: string, chart: string, accounts: readonly string[]): Promise<Set<string>> => {
  const requested = [...new Set(accounts.filter(Boolean))];
  if (!requested.length) return new Set();
  const rows = (await db.query(
    `SELECT n.account_number FROM unnest($3::text[]) AS n(account_number)
      LEFT JOIN tenant_ledger_accounts t ON t.tenant_id=$1 AND t.chart=$2 AND t.account_number=n.account_number
      WHERE COALESCE(t.active, EXISTS (SELECT 1 FROM ledger_accounts g WHERE g.chart=$2 AND g.account_number=n.account_number))`,
    [tenantId, chart, requested],
  )).rows as Array<{ account_number: string }>;
  return new Set(rows.map((row) => String(row.account_number)));
};
