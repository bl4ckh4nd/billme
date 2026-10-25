import { randomUUID } from 'node:crypto';
import { dunningDeliverySchema, isInvoiceOverdue, localIsoDate, type AccountingMutationContext, type DunningDeliveryPort, type TenantScope } from '@billme/server-core';
import { createPostgresDunningHistoryRepository, createPostgresInvoiceRepository } from './billing.js';
import { createPostgresAuditLogPort } from './audit.js';
import { postDunningFeeInTransaction, postDunningInterestInTransaction } from './proAccountingRepository.js';
import { runInTransaction, type PostgresQueryable, type PostgresTransactionClient } from './connection.js';

const stamp = () => new Date().toISOString();
const map = (row: Record<string, unknown>) => dunningDeliverySchema.parse({ id: row.id, invoiceId: row.invoice_id, invoiceNumber: row.invoice_number, level: row.level, state: row.state, fee: Number(row.fee), updatedAt: row.updated_at, error: row.error ?? undefined });
const lockInvoice = (db: PostgresTransactionClient, scope: TenantScope, invoiceId: string) => db.query('SELECT id FROM invoices WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [scope.tenantId, invoiceId]);
const lockDelivery = async (db: PostgresTransactionClient, scope: TenantScope, id: string) => {
  const initial = (await db.query<{ invoice_id: string }>('SELECT invoice_id FROM dunning_deliveries WHERE tenant_id=$1 AND id=$2', [scope.tenantId, id])).rows[0];
  if (!initial) return undefined;
  await lockInvoice(db, scope, initial.invoice_id);
  return (await db.query('SELECT * FROM dunning_deliveries WHERE tenant_id=$1 AND id=$2 FOR UPDATE', [scope.tenantId, id])).rows[0];
};
export const listDunningDeliveries = async (db: PostgresQueryable, scope: TenantScope) => (await db.query("SELECT * FROM dunning_deliveries WHERE tenant_id=$1 AND (state='unknown' OR (state='sending' AND lease_expires_at<$2)) ORDER BY updated_at", [scope.tenantId, stamp()])).rows.map(map);

export const createPostgresDunningDelivery = (db: PostgresQueryable): DunningDeliveryPort => ({
  claim: (scope, invoiceId, level) => runInTransaction(db, async (client) => {
    await lockInvoice(client, scope, invoiceId);
    const invoice = await createPostgresInvoiceRepository(client).getById(scope, invoiceId);
    if (!invoice || !isInvoiceOverdue(invoice)) return null;
    const now = stamp();
    await client.query("UPDATE dunning_deliveries SET state=CASE WHEN state='preparing' THEN 'failed' ELSE 'unknown' END,error='Der vorige Lauf wurde unterbrochen.' WHERE tenant_id=$1 AND invoice_id=$2 AND state IN ('preparing','sending') AND lease_expires_at<$3", [scope.tenantId, invoiceId, now]);
    const active = (await client.query<{ state: string }>("SELECT state FROM dunning_deliveries WHERE tenant_id=$1 AND invoice_id=$2 AND state IN ('preparing','sending','unknown')", [scope.tenantId, invoiceId])).rows[0];
    if (active?.state === 'unknown') throw new Error('Versand unklar. Bitte unter Einstellungen → Mahnwesen beim E-Mail-Anbieter abgleichen.');
    if (active) return null;
    const history = await createPostgresDunningHistoryRepository(client).listByInvoice(scope, invoiceId);
    if (history.some((entry) => entry.dunningLevel === level.id && entry.emailSent)) return null;
    const fee = history.some((entry) => entry.dunningLevel === level.id && entry.feeApplied > 0) ? 0 : level.fee;
    const id = randomUUID(); const lease = new Date(Date.now() + 300_000).toISOString();
    const saved = await client.query("INSERT INTO dunning_deliveries (id,tenant_id,invoice_id,invoice_number,level,state,fee,updated_at,lease_expires_at) VALUES ($1,$2,$3,$4,$5,'preparing',$6,$7,$8) ON CONFLICT (tenant_id,invoice_id,level) DO UPDATE SET id=EXCLUDED.id,state='preparing',fee=EXCLUDED.fee,updated_at=EXCLUDED.updated_at,lease_expires_at=EXCLUDED.lease_expires_at,error=NULL WHERE dunning_deliveries.state='failed' RETURNING *", [id, scope.tenantId, invoiceId, invoice.number, level.id, fee, now, lease]);
    return saved.rows[0] ? { delivery: map(saved.rows[0]), invoice } : null;
  }),
  begin: (scope, id) => runInTransaction(db, async (client) => {
    const row = await lockDelivery(client, scope, id);
    if (!row || row.state !== 'preparing' || String(row.lease_expires_at) < stamp()) return false;
    const invoice = await createPostgresInvoiceRepository(client).getById(scope, String(row.invoice_id));
    if (!invoice || !isInvoiceOverdue(invoice)) { await client.query("UPDATE dunning_deliveries SET state='failed',updated_at=$1 WHERE id=$2", [stamp(), id]); return false; }
    await client.query("UPDATE dunning_deliveries SET state='sending',updated_at=$1,lease_expires_at=$2 WHERE id=$3", [stamp(), new Date(Date.now() + 300_000).toISOString(), id]);
    return true;
  }),
  finish: (scope, id, history, mutation) => runInTransaction(db, async (client) => {
    const row = await lockDelivery(client, scope, id);
    if (!row || row.state === 'sent') return 0;
    if (!['sending', 'unknown'].includes(String(row.state))) throw new Error('DUNNING_DELIVERY_OWNER_CHANGED');
    const repository = createPostgresInvoiceRepository(client);
    const before = await repository.getById(scope, String(row.invoice_id));
    if (!before) throw new Error('DUNNING_INVOICE_MISSING');
    const after = await repository.patchDunning!(scope, before.id, { dunningLevel: Number(row.level), historyEntry: { date: history.processedAt.slice(0, 10), action: `Mahnstufe ${row.level} vom E-Mail-Anbieter angenommen` } });
    // A fee is owed only while the invoice is: one paid or cancelled before the mail was accepted carries none.
    const fee = ['paid', 'cancelled', 'draft'].includes(before.status) ? 0 : Math.round(Number(row.fee) * 100) / 100;
    const interest = ['paid', 'cancelled', 'draft'].includes(before.status) ? 0 : Math.round((history.interestApplied ?? 0) * 100) / 100;
    await createPostgresDunningHistoryRepository(client).record(scope, { ...history, invoiceId: before.id, invoiceNumber: before.number, dunningLevel: Number(row.level), emailSent: true, feeApplied: fee, ...(interest > 0 ? { interestApplied: interest } : { interestApplied: undefined }) });
    // Pro books fee and interest as the customer's receivable, in the same transaction as the history row.
    await postDunningFeeInTransaction(client, scope, { invoiceId: before.id, level: Number(row.level), fee, date: localIsoDate(new Date(history.processedAt)), mutation });
    await postDunningInterestInTransaction(client, scope, { invoiceId: before.id, level: Number(row.level), interest, date: localIsoDate(new Date(history.processedAt)), mutation });
    await client.query("UPDATE dunning_deliveries SET state='sent',updated_at=$1,error=NULL WHERE id=$2", [stamp(), id]);
    await createPostgresAuditLogPort(client).append(scope, { occurredAt: stamp(), action: 'invoice.dunning_reminder_sent', reason: mutation.reason, actor: mutation.actor!, subject: { entityType: 'invoice', entityId: before.id, tenantId: scope.tenantId }, change: { before, after } });
    return fee;
  }),
  fail: (scope, id, error) => runInTransaction(db, async (client) => {
    const row = await lockDelivery(client, scope, id);
    if (row && ['preparing', 'sending'].includes(String(row.state))) await client.query("UPDATE dunning_deliveries SET state=CASE WHEN state='sending' THEN 'unknown' ELSE 'failed' END,error=$1,updated_at=$2 WHERE id=$3", [error.slice(0, 2000), stamp(), id]);
  }),
});

export const resolveDunningDelivery = (db: PostgresQueryable, scope: TenantScope, id: string, accepted: boolean, mutation: AccountingMutationContext) => runInTransaction(db, async (client) => {
  const row = await lockDelivery(client, scope, id);
  if (!row || !(row.state === 'unknown' || (row.state === 'sending' && String(row.lease_expires_at) < stamp()))) throw new Error('Dieser Versand kann derzeit nicht abgeglichen werden. Bitte neu laden.');
  if (accepted) await createPostgresDunningDelivery(client).finish(scope, id, { invoiceId: String(row.invoice_id), invoiceNumber: String(row.invoice_number), dunningLevel: Number(row.level), daysOverdue: 0, feeApplied: 0, emailSent: true, processedAt: stamp() }, mutation);
  else { await client.query("UPDATE dunning_deliveries SET state='failed',updated_at=$1,error=NULL WHERE id=$2", [stamp(), id]); await createPostgresAuditLogPort(client).append(scope, { occurredAt: stamp(), action: 'invoice.dunning_delivery_reviewed', reason: mutation.reason, actor: mutation.actor!, subject: { entityType: 'invoice', entityId: String(row.invoice_id), tenantId: scope.tenantId }, change: { before: map(row), after: { accepted: false } } }); }
  return { ok: true as const };
});
