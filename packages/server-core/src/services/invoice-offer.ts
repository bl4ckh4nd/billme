import type {
  DocumentHistoryEntry,
  Invoice,
  Offer,
  OfferDecision,
  TenantScope,
} from '../domain/foundations.js';
import type {
  AuditActor,
  AuditEntry,
  AuditLogPort,
  OfferPortalDecisionStatus,
  OfferPortalGateway,
  OfferPortalStatus,
} from '../ports/index.js';

type SyncInvoiceRepository = {
  list(scope: TenantScope): Invoice[];
  getById(scope: TenantScope, id: string): Invoice | null;
  save(scope: TenantScope, invoice: Invoice): Invoice;
  remove(scope: TenantScope, id: string): void;
};

type SyncOfferRepository = {
  list(scope: TenantScope): Offer[];
  getById(scope: TenantScope, id: string): Offer | null;
  save(scope: TenantScope, offer: Offer): Offer;
  remove(scope: TenantScope, id: string): void;
};

type SyncAuditLogPort = {
  append(scope: TenantScope, entry: Parameters<AuditLogPort['append']>[1]): AuditEntry;
  listBySubject(scope: TenantScope, subject: Parameters<AuditLogPort['listBySubject']>[1]): AuditEntry[];
};

export interface InvoiceDomainDependencies {
  invoiceRepo: SyncInvoiceRepository;
  auditLog: SyncAuditLogPort;
}

export interface OfferDomainDependencies {
  offerRepo: SyncOfferRepository;
  auditLog: SyncAuditLogPort;
}

export interface InvoiceOfferDomainDependencies extends InvoiceDomainDependencies, OfferDomainDependencies {}

export interface CreateInvoiceFromOfferParams {
  offerId: string;
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string;
  servicePeriod?: string;
  actor?: AuditActor;
  reason?: string;
}

export interface ApplyOfferDecisionParams {
  offerId: string;
  decidedAt: string;
  decision: OfferDecision;
  acceptedName: string;
  acceptedEmail: string;
  decisionTextVersion: string;
  acceptedUserAgent?: string;
  actor?: AuditActor;
}

export interface PublishOfferParams {
  offerId: string;
  token: string;
  publishedAt?: string;
  actor?: AuditActor;
}

export interface PendingPortalOffer {
  id: string;
  shareToken: string;
}

export type OfferPortalDecisionSnapshot = OfferPortalDecisionStatus;
export type OfferPortalStatusSnapshot = OfferPortalStatus;

export interface PublishOfferToPortalParams {
  offerId: string;
  expiresAt?: string;
  actor?: AuditActor;
}

export interface PublishOfferToPortalResult {
  offer: Offer;
  token: string;
  publicUrl: string;
  publishedAt: string;
}

export interface SyncPublishedOfferDecisionFromPortalParams {
  offerId: string;
  actor?: AuditActor;
}

export interface SyncPublishedOfferDecisionFromPortalResult {
  offer: Offer;
  decision: OfferPortalDecisionSnapshot | null;
  updated: boolean;
}

export interface SyncPublishedOfferDecisionsParams {
  getOfferStatus(shareToken: string): Promise<OfferPortalStatusSnapshot>;
  logger?: Pick<Console, 'warn'>;
  onDecisionApplied?(params: { offer: Offer; decision: OfferPortalDecisionSnapshot }): void;
}

const defaultActor: AuditActor = {
  type: 'system',
  displayName: 'local',
};

const toHistoryEntry = (entry: AuditEntry): DocumentHistoryEntry => ({
  date: entry.occurredAt.split('T')[0] ?? entry.occurredAt,
  action: entry.reason ? `${entry.action} (${entry.reason})` : entry.action,
});

const withInvoiceHistory = (
  scope: TenantScope,
  dependencies: InvoiceDomainDependencies,
  invoice: Invoice,
): Invoice => {
  const history = dependencies.auditLog
    .listBySubject(scope, {
      entityType: 'invoice',
      entityId: invoice.id,
      tenantId: scope.tenantId,
    })
    .map(toHistoryEntry);

  return {
    ...invoice,
    history,
  };
};

const withOfferHistory = (
  scope: TenantScope,
  dependencies: OfferDomainDependencies,
  offer: Offer,
): Offer => {
  const history = dependencies.auditLog
    .listBySubject(scope, {
      entityType: 'offer',
      entityId: offer.id,
      tenantId: scope.tenantId,
    })
    .map(toHistoryEntry);

  return {
    ...offer,
    history,
  };
};

const requireReason = (reason: string, errorMessage: string): string => {
  const normalized = reason.trim();
  if (!normalized) {
    throw new Error(errorMessage);
  }
  return normalized;
};

const mergeOfferShare = (offer: Offer, existing: Offer | null): Offer => {
  if (offer.share || !existing?.share) {
    return offer;
  }
  return {
    ...offer,
    share: existing.share,
  };
};

export const listInvoices = (scope: TenantScope, dependencies: InvoiceDomainDependencies): Invoice[] => {
  return dependencies.invoiceRepo.list(scope).map((invoice) => withInvoiceHistory(scope, dependencies, invoice));
};

export const getInvoice = (
  scope: TenantScope,
  dependencies: InvoiceDomainDependencies,
  id: string,
): Invoice | null => {
  const invoice = dependencies.invoiceRepo.getById(scope, id);
  return invoice ? withInvoiceHistory(scope, dependencies, invoice) : null;
};

export const upsertInvoice = (
  scope: TenantScope,
  dependencies: InvoiceDomainDependencies,
  params: { invoice: Invoice; reason: string; actor?: AuditActor },
): Invoice => {
  const reason = requireReason(params.reason, 'Edit reason is required');
  const before = dependencies.invoiceRepo.getById(scope, params.invoice.id);
  const after = dependencies.invoiceRepo.save(scope, params.invoice);

  dependencies.auditLog.append(scope, {
    occurredAt: new Date().toISOString(),
    action: before ? 'invoice.update' : 'invoice.create',
    reason,
    actor: params.actor ?? defaultActor,
    subject: {
      entityType: 'invoice',
      entityId: after.id,
      tenantId: scope.tenantId,
    },
    change: {
      before,
      after,
    },
  });

  return withInvoiceHistory(scope, dependencies, after);
};

export const deleteInvoice = (
  scope: TenantScope,
  dependencies: InvoiceDomainDependencies,
  params: { id: string; reason: string; actor?: AuditActor },
): { ok: true } => {
  const reason = requireReason(params.reason, 'Delete reason is required');
  const before = dependencies.invoiceRepo.getById(scope, params.id);
  if (!before) {
    throw new Error('Invoice not found');
  }

  dependencies.invoiceRepo.remove(scope, params.id);
  dependencies.auditLog.append(scope, {
    occurredAt: new Date().toISOString(),
    action: 'invoice.delete',
    reason,
    actor: params.actor ?? defaultActor,
    subject: {
      entityType: 'invoice',
      entityId: params.id,
      tenantId: scope.tenantId,
    },
    change: {
      before,
      after: null,
    },
  });

  return { ok: true };
};

/** Shared document snapshot for SQLite and server-side offer conversion. */
export const buildInvoiceFromOffer = (
  scope: TenantScope,
  offer: Offer,
  params: CreateInvoiceFromOfferParams,
): Invoice => {
  return {
    kind: 'invoice',
    documentKind: 'invoice',
    revisionNumber: 0,
    sourceDocumentId: offer.id,
    rootDocumentId: params.invoiceId,
    tenantId: scope.tenantId,
    id: params.invoiceId,
    clientId: offer.clientId,
    clientNumber: offer.clientNumber,
    projectId: offer.projectId,
    number: params.invoiceNumber,
    client: offer.client,
    clientEmail: offer.clientEmail,
    clientAddress: offer.clientAddress,
    billingAddress: offer.billingAddress,
    shippingAddress: offer.shippingAddress,
    taxMode: offer.taxMode,
    taxMeta: offer.taxMeta,
    taxSnapshot: offer.taxSnapshot,
    date: params.invoiceDate,
    dueDate: params.dueDate,
    servicePeriod: params.servicePeriod,
    amount: offer.amount,
    status: 'draft',
    dunningLevel: 0,
    items: offer.items,
    payments: [],
    history: [],
  };
};

export const createInvoiceFromOffer = (
  scope: TenantScope,
  dependencies: InvoiceOfferDomainDependencies,
  params: CreateInvoiceFromOfferParams,
): Invoice => {
  const offer = dependencies.offerRepo.getById(scope, params.offerId);
  if (!offer) {
    throw new Error('Offer not found');
  }

  const invoice = buildInvoiceFromOffer(scope, offer, params);

  const after = dependencies.invoiceRepo.save(scope, invoice);
  dependencies.auditLog.append(scope, {
    occurredAt: new Date().toISOString(),
    action: 'invoice.create',
    reason: params.reason ?? `Converted from offer ${offer.number}`,
    actor: params.actor ?? defaultActor,
    subject: {
      entityType: 'invoice',
      entityId: after.id,
      tenantId: scope.tenantId,
    },
    change: {
      before: null,
      after,
    },
  });

  return withInvoiceHistory(scope, dependencies, after);
};

export const listOffers = (scope: TenantScope, dependencies: OfferDomainDependencies): Offer[] => {
  return dependencies.offerRepo.list(scope).map((offer) => withOfferHistory(scope, dependencies, offer));
};

export const getOffer = (scope: TenantScope, dependencies: OfferDomainDependencies, id: string): Offer | null => {
  const offer = dependencies.offerRepo.getById(scope, id);
  return offer ? withOfferHistory(scope, dependencies, offer) : null;
};

export const upsertOffer = (
  scope: TenantScope,
  dependencies: OfferDomainDependencies,
  params: { offer: Offer; reason: string; actor?: AuditActor },
): Offer => {
  const reason = requireReason(params.reason, 'Edit reason is required');
  const before = dependencies.offerRepo.getById(scope, params.offer.id);
  const offerToSave = mergeOfferShare(params.offer, before);
  const after = dependencies.offerRepo.save(scope, offerToSave);

  dependencies.auditLog.append(scope, {
    occurredAt: new Date().toISOString(),
    action: before ? 'offer.update' : 'offer.create',
    reason,
    actor: params.actor ?? defaultActor,
    subject: {
      entityType: 'offer',
      entityId: after.id,
      tenantId: scope.tenantId,
    },
    change: {
      before,
      after,
    },
  });

  return withOfferHistory(scope, dependencies, after);
};

export const deleteOffer = (
  scope: TenantScope,
  dependencies: OfferDomainDependencies,
  params: { id: string; reason: string; actor?: AuditActor },
): { ok: true } => {
  const reason = requireReason(params.reason, 'Delete reason is required');
  const before = dependencies.offerRepo.getById(scope, params.id);
  if (!before) {
    throw new Error('Offer not found');
  }

  dependencies.offerRepo.remove(scope, params.id);
  dependencies.auditLog.append(scope, {
    occurredAt: new Date().toISOString(),
    action: 'offer.delete',
    reason,
    actor: params.actor ?? defaultActor,
    subject: {
      entityType: 'offer',
      entityId: params.id,
      tenantId: scope.tenantId,
    },
    change: {
      before,
      after: null,
    },
  });

  return { ok: true };
};

export const publishOffer = (
  scope: TenantScope,
  dependencies: OfferDomainDependencies,
  params: PublishOfferParams,
): Offer => {
  const before = dependencies.offerRepo.getById(scope, params.offerId);
  if (!before) {
    throw new Error('Offer not found');
  }

  const after = dependencies.offerRepo.save(scope, {
    ...before,
    share: {
      ...(before.share ?? {}),
      token: params.token,
      publishedAt: params.publishedAt ?? new Date().toISOString(),
    },
  });

  dependencies.auditLog.append(scope, {
    occurredAt: new Date().toISOString(),
    action: 'offer.publish',
    actor: params.actor ?? defaultActor,
    subject: {
      entityType: 'offer',
      entityId: params.offerId,
      tenantId: scope.tenantId,
    },
    change: {
      before,
      after,
    },
  });

  return withOfferHistory(scope, dependencies, after);
};

export const publishOfferToPortal = async (
  scope: TenantScope,
  dependencies: OfferDomainDependencies & { portalGateway: Pick<OfferPortalGateway, 'publishOffer'> },
  params: PublishOfferToPortalParams,
): Promise<PublishOfferToPortalResult> => {
  const offer = dependencies.offerRepo.getById(scope, params.offerId);
  if (!offer) {
    throw new Error('Offer not found');
  }

  const publication = await dependencies.portalGateway.publishOffer({
    offer,
    expiresAt: params.expiresAt ?? offer.validUntil,
  });
  const publishedAt = publication.publishedAt ?? new Date().toISOString();
  const publishedOffer = publishOffer(scope, dependencies, {
    offerId: params.offerId,
    token: publication.token,
    publishedAt,
    actor: params.actor,
  });

  return {
    offer: publishedOffer,
    token: publication.token,
    publicUrl: publication.publicUrl,
    publishedAt,
  };
};

export const applyOfferDecision = (
  scope: TenantScope,
  dependencies: OfferDomainDependencies,
  params: ApplyOfferDecisionParams,
): Offer => {
  const before = dependencies.offerRepo.getById(scope, params.offerId);
  if (!before) {
    throw new Error('Offer not found');
  }

  if (before.share?.acceptedAt || before.share?.decision) {
    return withOfferHistory(scope, dependencies, before);
  }

  const after = dependencies.offerRepo.save(scope, {
    ...before,
    status: params.decision,
    share: {
      ...(before.share ?? {}),
      decision: params.decision,
      decisionTextVersion: params.decisionTextVersion,
      acceptedAt: params.decidedAt,
      acceptedBy: params.acceptedName,
      acceptedEmail: params.acceptedEmail,
      acceptedUserAgent: params.acceptedUserAgent,
    },
  });

  dependencies.auditLog.append(scope, {
    occurredAt: new Date().toISOString(),
    action: 'offer.portal_decision',
    actor: params.actor ?? defaultActor,
    subject: {
      entityType: 'offer',
      entityId: params.offerId,
      tenantId: scope.tenantId,
    },
    change: {
      before,
      after,
    },
  });

  return withOfferHistory(scope, dependencies, after);
};

export const syncPublishedOfferDecisionFromPortal = async (
  scope: TenantScope,
  dependencies: OfferDomainDependencies & { portalGateway: Pick<OfferPortalGateway, 'getOfferStatus'> },
  params: SyncPublishedOfferDecisionFromPortalParams,
): Promise<SyncPublishedOfferDecisionFromPortalResult> => {
  const offer = dependencies.offerRepo.getById(scope, params.offerId);
  if (!offer) {
    throw new Error('Offer not found');
  }

  const shareToken = offer.share?.token;
  if (!shareToken) {
    throw new Error('Offer is not published');
  }

  const status = await dependencies.portalGateway.getOfferStatus(shareToken);
  const decision = status.decision ?? null;
  if (!decision || offer.share?.acceptedAt || offer.share?.decision) {
    return {
      offer: withOfferHistory(scope, dependencies, offer),
      decision,
      updated: false,
    };
  }

  const syncedOffer = applyOfferDecision(scope, dependencies, {
    offerId: params.offerId,
    decidedAt: decision.decidedAt,
    decision: decision.decision,
    acceptedName: decision.acceptedName,
    acceptedEmail: decision.acceptedEmail,
    decisionTextVersion: decision.decisionTextVersion,
    acceptedUserAgent: decision.acceptedUserAgent,
    actor: params.actor,
  });

  return {
    offer: syncedOffer,
    decision,
    updated: true,
  };
};

export const listOffersPendingPortalSync = (
  scope: TenantScope,
  dependencies: Pick<OfferDomainDependencies, 'offerRepo'>,
): PendingPortalOffer[] => {
  return dependencies.offerRepo
    .list(scope)
    .filter((offer) => Boolean(offer.share?.token) && !offer.share?.decision && !offer.share?.acceptedAt)
    .map((offer) => ({
      id: offer.id,
      shareToken: offer.share!.token!,
    }));
};

export const syncPublishedOfferDecisions = async (
  scope: TenantScope,
  dependencies: OfferDomainDependencies,
  params: SyncPublishedOfferDecisionsParams,
): Promise<number> => {
  const pendingOffers = listOffersPendingPortalSync(scope, dependencies);
  let updatedCount = 0;

  for (const pendingOffer of pendingOffers) {
    try {
      const status = await params.getOfferStatus(pendingOffer.shareToken);
      const decision = status.decision ?? null;
      if (!decision) {
        continue;
      }

      const offer = applyOfferDecision(scope, dependencies, {
        offerId: pendingOffer.id,
        decidedAt: decision.decidedAt,
        decision: decision.decision,
        acceptedName: decision.acceptedName,
        acceptedEmail: decision.acceptedEmail,
        decisionTextVersion: decision.decisionTextVersion,
        acceptedUserAgent: decision.acceptedUserAgent,
      });
      updatedCount += 1;
      params.onDecisionApplied?.({ offer, decision });
    } catch (error) {
      params.logger?.warn?.('[portal-sync] offer status failed', {
        offerId: pendingOffer.id,
        err: String(error),
      });
    }
  }

  return updatedCount;
};

export const syncPublishedOfferDecisionsFromPortal = async (
  scope: TenantScope,
  dependencies: OfferDomainDependencies & { portalGateway: Pick<OfferPortalGateway, 'getOfferStatus'> },
  params: Omit<SyncPublishedOfferDecisionsParams, 'getOfferStatus'> = {},
): Promise<number> => {
  const pendingOffers = listOffersPendingPortalSync(scope, dependencies);
  let updatedCount = 0;

  for (const pendingOffer of pendingOffers) {
    try {
      const result = await syncPublishedOfferDecisionFromPortal(scope, dependencies, {
        offerId: pendingOffer.id,
      });
      if (!result.updated || !result.decision) {
        continue;
      }

      updatedCount += 1;
      params.onDecisionApplied?.({
        offer: result.offer,
        decision: result.decision,
      });
    } catch (error) {
      params.logger?.warn?.('[portal-sync] offer status failed', {
        offerId: pendingOffer.id,
        err: String(error),
      });
    }
  }

  return updatedCount;
};
