import type { PostgresTransactionClient } from './connection.js';

export const importRawTenantRows = async (
  client: PostgresTransactionClient,
  table: string,
  sourceRows: Array<Record<string, unknown>>,
  tenantId: string,
  columns: string[],
  insertedIds?: string[],
): Promise<number> => {
  const parentKeys: Record<string, Array<[string, string]>> = {
    invoices: [['client_id', 'clients']],
    incoming_invoices: [['vendor_id', 'vendors']],
    incoming_invoice_lines: [['incoming_invoice_id', 'incoming_invoices']],
    open_item_allocations: [['payment_id', 'open_item_payments'], ['open_item_id', 'open_items']],
    journal_lines: [['entry_id', 'journal_entries']],
    journal_posting_pairs: [['entry_id', 'journal_entries'], ['debit_line_id', 'journal_lines'], ['credit_line_id', 'journal_lines']],
    vat_evidence: [['entry_id', 'journal_entries'], ['draft_id', 'booking_drafts']],
    open_items: [['journal_entry_id', 'journal_entries']],
    open_item_payments: [['journal_entry_id', 'journal_entries']],
  };
  const identityColumns = table === 'accounting_policies' ? ['tenant_id'] : ['id'];
  let inserted = 0;
  for (const row of sourceRows) {
    const values = columns.map((column) => column === 'tenant_id' ? tenantId : row[column] ?? null);
    for (const [column, parent] of parentKeys[table] ?? []) {
      const parentId = row[column];
      if (parentId == null) continue;
      const parentRows = await client.query(`SELECT tenant_id FROM ${parent} WHERE id=$1`, [parentId]);
      if (!parentRows.rows[0] || parentRows.rows[0].tenant_id !== tenantId) throw new Error(`IMPORT_FOREIGN_PARENT:${table}.${column}`);
    }
    if (table === 'open_items' && row.source_id != null && (row.source_type === 'outgoing_invoice' || row.source_type === 'incoming_invoice')) {
      const parent = row.source_type === 'outgoing_invoice' ? 'invoices' : 'incoming_invoices';
      const parentRows = await client.query(`SELECT tenant_id FROM ${parent} WHERE id=$1`, [row.source_id]);
      if (!parentRows.rows[0] || parentRows.rows[0].tenant_id !== tenantId) throw new Error('IMPORT_FOREIGN_PARENT:open_items.source_id');
    }
    if (table === 'open_items' && row.party_id != null) {
      const parent = row.party_type === 'creditor' ? 'vendors' : row.party_type === 'debtor' ? 'clients' : null;
      if (parent) {
        const parentRows = await client.query(`SELECT tenant_id FROM ${parent} WHERE id=$1`, [row.party_id]);
        if (!parentRows.rows[0] || parentRows.rows[0].tenant_id !== tenantId) throw new Error('IMPORT_FOREIGN_PARENT:open_items.party_id');
      }
    }
    if (table === 'open_item_payments' && row.source_type === 'bank_transaction' && row.source_id != null) {
      const parentRows = await client.query('SELECT tenant_id FROM bank_transactions WHERE id=$1', [row.source_id]);
      if (!parentRows.rows[0] || parentRows.rows[0].tenant_id !== tenantId) throw new Error('IMPORT_FOREIGN_PARENT:open_item_payments.source_id');
    }
    if (table === 'open_item_payments' && row.source_type === 'invoice_payment' && row.source_id != null) {
      const invoiceRows = await client.query('SELECT tenant_id,payments_json FROM invoices WHERE tenant_id=$1', [tenantId]);
      const found = invoiceRows.rows.some((invoice) => {
        try { return (JSON.parse(invoice.payments_json ?? '[]') as Array<{ id?: string }>).some((payment) => payment.id === row.source_id); } catch { return false; }
      });
      if (!found) throw new Error('IMPORT_FOREIGN_PARENT:open_item_payments.source_id');
    }
    const identityValues = identityColumns.map((column) => column === 'tenant_id' ? tenantId : row[column]);
    const identityWhere = identityColumns.map((column, index) => `${column}=$${index + 1}`).join(' AND ');
    const existing = await client.query(`SELECT * FROM ${table} WHERE ${identityWhere}`, identityValues);
    if (existing.rows[0]) {
      if (existing.rows[0].tenant_id !== tenantId) throw new Error(`IMPORT_ID_TENANT_COLLISION:${table}:${String(row.id)}`);
      const same = columns.every((column, index) => {
        const left = existing.rows[0][column];
        const right = values[index];
        return (left == null && right == null) || String(left) === String(right);
      });
      if (!same) throw new Error(`IMPORT_ID_CONFLICT:${table}:${String(row.id)}`);
      continue;
    }
    const placeholders = values.map((_, index) => `$${index + 1}`).join(',');
    await client.query(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`, values);
    inserted += 1;
    insertedIds?.push(String(row.id));
  }
  return inserted;
};

export const restoreIncomingInvoiceAccountingRows = async (
  client: PostgresTransactionClient,
  sourceRows: Array<Record<string, unknown>>,
  tenantId: string,
): Promise<void> => {
  for (const row of sourceRows) {
    await client.query(
      'UPDATE incoming_invoices SET accounting_status=$1,accounting_snapshot_json=$2,accounting_journal_entry_id=$3,accounting_posted_at=$4 WHERE tenant_id=$5 AND id=$6',
      [row.accounting_status ?? 'unposted', row.accounting_snapshot_json ?? null, row.accounting_journal_entry_id ?? null, row.accounting_posted_at ?? null, tenantId, row.id],
    );
  }
};
