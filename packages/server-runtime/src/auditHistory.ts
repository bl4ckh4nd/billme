import { z } from 'zod';
import { invoiceSchema, offerSchema, type AuditEntryDraft, type TenantScope } from '@billme/server-core';
import { createPostgresBillingDependencies, type ServerDatabase } from '@billme/server-data';
import type { AuthSession } from './auth.js';
import { createMutationContext } from './runtimeContext.js';

const redactShareToken = (value: unknown): unknown => {
  if (!value || typeof value !== 'object' || !('share' in value) || !value.share || typeof value.share !== 'object') return value;
  const { token: _token, ...share } = value.share as Record<string, unknown>;
  return { ...value, share };
};

export const buildAuditEntry = (
  scope: TenantScope,
  session: AuthSession,
  subject: 'client' | 'invoice' | 'offer' | 'recurring-profile' | 'settings',
  entityId: string,
  action: string,
  reason: string,
  before: unknown,
  after: unknown,
): AuditEntryDraft => {
  const mutation = createMutationContext(session, reason);
  return {
    occurredAt: new Date().toISOString(),
    action,
    reason: mutation.reason,
    actor: mutation.actor,
    subject: {
      entityType: subject,
      entityId,
      tenantId: scope.tenantId,
    },
    change: {
      before: redactShareToken(before),
      after: redactShareToken(after),
    },
  };
};

export const historyFromAudit = async (
  db: Parameters<typeof createPostgresBillingDependencies>[0],
  scope: TenantScope,
  entityType: 'invoice' | 'offer',
  entityId: string,
): Promise<Array<{ date: string; action: string }>> => {
  const auditLog = createPostgresBillingDependencies(db).auditLog;
  const entries = await auditLog.listBySubject(scope, {
    entityType,
    entityId,
    tenantId: scope.tenantId,
  });
  return entries.map((entry) => toHistoryEntry(entry.occurredAt, entry.action, entry.reason));
};

const toHistoryEntry = (occurredAt: string, action: string, reason?: string | null) => ({
  date: occurredAt.split('T')[0] ?? occurredAt,
  action: reason ? `${action} (${reason})` : action,
});

// One query for a whole list instead of one audit read per document.
const historiesFromAudit = async (db: ServerDatabase, scope: TenantScope, entityType: 'invoice' | 'offer') => {
  const { rows } = await db.query<{ entity_id: string; ts: string; action: string; reason: string | null }>(
    'SELECT entity_id, ts, action, reason FROM audit_log WHERE tenant_id = $1 AND entity_type = $2 ORDER BY sequence DESC',
    [scope.tenantId, entityType],
  );
  const histories = new Map<string, Array<{ date: string; action: string }>>();
  for (const row of rows) {
    const history = histories.get(row.entity_id) ?? [];
    history.push(toHistoryEntry(row.ts, row.action, row.reason));
    histories.set(row.entity_id, history);
  }
  return histories;
};

export const withInvoiceHistories = async (db: ServerDatabase, scope: TenantScope, invoices: Array<z.infer<typeof invoiceSchema>>) => {
  const histories = await historiesFromAudit(db, scope, 'invoice');
  return invoices.map((invoice) => ({ ...invoice, history: histories.get(invoice.id) ?? [] }));
};

export const withOfferHistories = async (db: ServerDatabase, scope: TenantScope, offers: Array<z.infer<typeof offerSchema>>) => {
  const histories = await historiesFromAudit(db, scope, 'offer');
  return offers.map((offer) => ({ ...offer, history: histories.get(offer.id) ?? [] }));
};

export const withInvoiceHistory = async (db: ServerDatabase, scope: TenantScope, invoice: z.infer<typeof invoiceSchema>) => {
  return {
    ...invoice,
    history: await historyFromAudit(db, scope, 'invoice', invoice.id),
  };
};

export const withOfferHistory = async (db: ServerDatabase, scope: TenantScope, offer: z.infer<typeof offerSchema>) => {
  return {
    ...offer,
    history: await historyFromAudit(db, scope, 'offer', offer.id),
  };
};
