import { z } from 'zod';
import { invoiceSchema, offerSchema, type AuditEntryDraft, type TenantScope } from '@billme/server-core';
import { createPostgresBillingDependencies, type ServerDatabase } from '@billme/server-data';
import type { AuthSession } from './auth.js';
import { createMutationContext } from './runtimeContext.js';

export const buildAuditEntry = (
  scope: TenantScope,
  session: AuthSession,
  subject: 'client' | 'invoice' | 'offer' | 'recurring-profile',
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
      before,
      after,
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
  return entries.map((entry) => ({
    date: entry.occurredAt.split('T')[0] ?? entry.occurredAt,
    action: entry.reason ? `${entry.action} (${entry.reason})` : entry.action,
  }));
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
