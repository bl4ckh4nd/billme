import type { PostgresTransactionClient } from './connection.js';

export const importRawTenantRows = async (
  client: PostgresTransactionClient,
  table: string,
  sourceRows: Array<Record<string, unknown>>,
  tenantId: string,
  columns: string[],
): Promise<number> => {
  for (const row of sourceRows) {
    const values = columns.map((column) => column === 'tenant_id' ? tenantId : row[column] ?? null);
    const placeholders = values.map((_, index) => `$${index + 1}`).join(',');
    await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`, values);
  }
  return sourceRows.length;
};
