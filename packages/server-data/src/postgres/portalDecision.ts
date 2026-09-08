import type { AuditActor, OfferPortalDecisionStatus, TenantScope } from '@billme/server-core';
import type { ServerDatabase } from '../database.js';
import { createPostgresBillingDependencies } from './billing.js';

/** Apply only a decision for the publication that was actually fetched. */
export const applyServerOfferPortalDecision = async (
  database: ServerDatabase,
  scope: TenantScope,
  input: { offerId: string; shareToken: string; decision: OfferPortalDecisionStatus; actor: AuditActor },
): Promise<{ updated: boolean }> => database.transaction({}, async (session) => {
  await session.query('SELECT id FROM offers WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [scope.tenantId, input.offerId]);
  const { offerRepo, auditLog } = createPostgresBillingDependencies(session);
  const before = await offerRepo.getById(scope, input.offerId);
  if (!before || before.share?.token !== input.shareToken || before.share.acceptedAt || before.share.decision) {
    return { updated: false };
  }
  const decision = input.decision;
  const after = await offerRepo.save(scope, {
    ...before,
    status: decision.decision,
    share: {
      ...before.share,
      decision: decision.decision,
      decisionTextVersion: decision.decisionTextVersion,
      acceptedAt: decision.decidedAt,
      acceptedBy: decision.acceptedName,
      acceptedEmail: decision.acceptedEmail,
      acceptedUserAgent: decision.acceptedUserAgent,
    },
  });
  await auditLog.append(scope, {
    occurredAt: new Date().toISOString(),
    action: 'offer.portal_decision',
    actor: input.actor,
    subject: { entityType: 'offer', entityId: after.id, tenantId: scope.tenantId },
    change: { before, after },
  });
  return { updated: true };
});
