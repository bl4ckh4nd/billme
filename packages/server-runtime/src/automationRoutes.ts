import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendEmail, testEmailConfig } from '@billme/desktop-core/services/emailService';
import { isRetryableEmailError } from '@billme/desktop-core/utils/retry';
import { portalClient } from '@billme/desktop-services/portalClient';
import {
  appSettingsSchema,
} from '@billme/desktop-contracts-pro/schemas';
import {
  processDunningRun,
  queueEmailDelivery,
  summarizeInvoiceDunningStatus,
  type AuditActor,
  type DunningSettings,
  type EmailOutboxEntry,
  type Invoice,
  type Offer,
  type TenantScope,
} from '@billme/server-core';
import {
  createPostgresAuditLogPort,
  applyServerOfferPortalDecision,
  createPostgresBillingDependencies,
  createPostgresBillingUnitOfWork,
  createPostgresDunningHistoryRepository,
  createPostgresEmailOutboxRepository,
  createPostgresInvoiceRepository,
  createPostgresOfferRepository,
  getPortalPublication,
  getServerSettings,
  saveServerSettings,
  hashPortalToken,
  insertEmailLogRow,
  createServerRecurringDependencies,
  reservePortalPublication,
  markPortalPublicationPublished,
  type ServerDatabase,
  type ServerDatabaseSession,
} from '@billme/server-data';
import { runRecurringInvoiceRun } from '@billme/server-core';
import type { AuthSession } from './auth.js';
import { ApiError, typedRoute } from './http.js';
import { requireAutomationMutationSession, toMutationActor } from './runtimeContext.js';

type RuntimeDatabase = ServerDatabase;
type RuntimeQueryTarget = RuntimeDatabase | ServerDatabaseSession;
type RuntimeSettings = z.output<typeof appSettingsSchema>;

const okSchema = z.object({ ok: z.literal(true) });
const portalHealthQuerySchema = z.object({ baseUrl: z.string().min(1) });
const portalPublishOfferBodySchema = z.object({
  offerId: z.string().min(1),
  expiresAt: z.string().optional(),
});
const portalPublishInvoiceBodySchema = z.object({
  invoiceId: z.string().min(1),
  expiresAt: z.string().optional(),
});
const portalPublicationResponseSchema = z.object({
  ok: z.literal(true),
  token: z.string().min(16),
  publicUrl: z.string().min(1),
});
const portalSyncBodySchema = z.object({ offerId: z.string().min(1) });
const portalDecisionSchema = z.object({
  decidedAt: z.string(),
  decision: z.enum(['accepted', 'declined']),
  acceptedName: z.string(),
  acceptedEmail: z.string(),
  decisionTextVersion: z.string(),
});
const portalSyncResponseSchema = z.object({
  ok: z.literal(true),
  decision: portalDecisionSchema.nullable(),
  updated: z.boolean(),
});
const customerAccessLinkBodySchema = z.object({
  customerRef: z.string().min(1),
  customerLabel: z.string().optional(),
  expiresInDays: z.number().int().positive().max(365).optional(),
});
const customerAccessLinkResponseSchema = z.object({
  ok: z.literal(true),
  token: z.string().min(16),
  publicUrl: z.string().min(1),
  expiresAt: z.string().min(1),
});
const sendEmailBodySchema = z.object({
  documentType: z.enum(['invoice', 'offer']),
  documentId: z.string().min(1),
  recipientEmail: z.string().email(),
  recipientName: z.string().min(1),
  subject: z.string().min(1),
  bodyText: z.string().min(1),
});
const sendEmailResponseSchema = z.object({
  success: z.boolean(),
  messageId: z.string().optional(),
  error: z.string().optional(),
});
const testEmailBodySchema = z.object({
  provider: z.enum(['smtp', 'resend']),
  smtpHost: z.string().optional(),
  smtpPort: z.number().optional(),
  smtpSecure: z.boolean().optional(),
  smtpUser: z.string().optional(),
});
const dunningRunResponseSchema = z.object({
  success: z.boolean(),
  result: z.object({
    processedInvoices: z.number(),
    emailsSent: z.number(),
    feesApplied: z.number(),
    errors: z.array(z.object({ invoiceNumber: z.string(), error: z.string() })),
  }).optional(),
  error: z.string().optional(),
});
const invoiceStatusParamsSchema = z.object({ invoiceId: z.string().min(1) });
const invoiceStatusResponseSchema = z.object({
  currentLevel: z.number(),
  daysOverdue: z.number(),
  lastReminderSent: z.string().optional(),
  totalFeesApplied: z.number(),
  history: z.array(z.object({
    id: z.string(),
    invoiceId: z.string(),
    invoiceNumber: z.string(),
    dunningLevel: z.number(),
    daysOverdue: z.number(),
    feeApplied: z.number(),
    emailSent: z.boolean(),
    emailLogId: z.string().optional(),
    processedAt: z.string(),
    createdAt: z.string(),
  })),
});
const recurringRunResponseSchema = z.object({
  success: z.boolean(),
  result: z.object({
    generated: z.number(),
    deactivated: z.number(),
    errors: z.array(z.object({ profileName: z.string(), error: z.string() })),
  }).optional(),
  error: z.string().optional(),
});

const actorFor = (session: AuthSession): AuditActor => toMutationActor(session);

const nowIso = (): string => new Date().toISOString();

const queryTarget = (database: RuntimeQueryTarget): ServerDatabaseSession => database;

const withRuntimeTransaction = async <T>(
  database: RuntimeDatabase,
  work: (session: ServerDatabaseSession) => Promise<T>,
): Promise<T> => {
  return database.transaction({}, async (session) => work(session));
};

const readSettings = async (database: RuntimeQueryTarget, tenantId: string): Promise<{
  settings: RuntimeSettings;
  createdAt: string;
} | null> => {
  const record = await getServerSettings(queryTarget(database), tenantId);
  if (!record) return null;
  return {
    settings: appSettingsSchema.parse(JSON.parse(record.settingsJson) as unknown),
    createdAt: record.createdAt,
  };
};

const requireSettings = async (database: RuntimeQueryTarget, scope: TenantScope) => {
  const snapshot = await readSettings(database, scope.tenantId);
  if (!snapshot) throw new ApiError(503, 'Server settings are not initialized');
  return snapshot;
};

const requirePortalBaseUrl = (settings: RuntimeSettings): string => {
  const baseUrl = settings.portal.baseUrl.trim();
  if (!baseUrl) throw new ApiError(503, 'Portal is not configured');
  return baseUrl;
};

const scopedCustomerRef = (scope: TenantScope, customerRef: string): string =>
  `tenant:${scope.tenantId}:customer:${customerRef}`;

const createPortalToken = (): string => randomBytes(24).toString('base64url');

const reserveOfferPortalToken = async (
  database: RuntimeDatabase,
  scope: TenantScope,
  session: AuthSession,
  offerId: string,
): Promise<{ offer: Offer; token: string }> => {
  return withRuntimeTransaction(database, async (queryable) => {
    // Serialize reservations for one document so concurrent retries cannot mint
    // different bearer tokens before either transaction commits.
    await queryable.query('SELECT id FROM offers WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [scope.tenantId, offerId]);
    const repository = createPostgresOfferRepository(queryable);
    const current = await repository.getById(scope, offerId);
    if (!current) throw new ApiError(404, 'Offer not found');
    if (current.share?.token) return { offer: current, token: current.share.token };

    const token = createPortalToken();
    const after = await repository.save(scope, {
      ...current,
      share: { ...(current.share ?? {}), token },
    });
    await createPostgresAuditLogPort(queryable).append(scope, {
      occurredAt: nowIso(),
      action: 'offer.portal_token_reserved',
      reason: 'Reserve bearer token before portal publication',
      actor: actorFor(session),
      subject: { entityType: 'offer', entityId: offerId, tenantId: scope.tenantId },
      change: { after: { tokenHash: hashPortalToken(token), status: 'reserved' } },
    });
    return { offer: after, token };
  });
};

const reserveInvoicePortalToken = async (
  database: RuntimeDatabase,
  scope: TenantScope,
  session: AuthSession,
  invoiceId: string,
): Promise<{ invoice: Invoice; token: string }> => {
  return withRuntimeTransaction(database, async (queryable) => {
    await queryable.query('SELECT id FROM invoices WHERE tenant_id = $1 AND id = $2 FOR UPDATE', [scope.tenantId, invoiceId]);
    const invoice = await createPostgresInvoiceRepository(queryable).getById(scope, invoiceId);
    if (!invoice) throw new ApiError(404, 'Invoice not found');
    const publication = await getPortalPublication(queryable, scope, 'invoice', invoiceId);
    if (publication) return { invoice, token: publication.token };

    const token = createPortalToken();
    const reserved = await reservePortalPublication(queryable, scope, {
      documentType: 'invoice',
      documentId: invoiceId,
      token,
      customerRef: scopedCustomerRef(scope, invoice.clientId ?? invoice.id),
      now: nowIso(),
    });
    const auditLog = createPostgresAuditLogPort(queryable);
    const subject = { entityType: 'invoice', entityId: invoiceId, tenantId: scope.tenantId };
    await auditLog.append(scope, {
      occurredAt: nowIso(),
      action: 'invoice.portal_token_reserved',
      reason: 'Reserve bearer token before portal publication',
      actor: actorFor(session),
      subject,
      change: { after: { tokenHash: reserved.tokenHash, status: 'reserved' } },
    });
    return { invoice, token: reserved.token };
  });
};

const appendAudit = async (
  database: RuntimeQueryTarget,
  scope: TenantScope,
  session: AuthSession,
  action: string,
  entityType: string,
  entityId: string,
  reason?: string,
  change?: { before?: unknown; after?: unknown },
): Promise<void> => {
  await createPostgresAuditLogPort(queryTarget(database)).append(scope, {
    occurredAt: nowIso(),
    action,
    reason,
    actor: actorFor(session),
    subject: { entityType, entityId, tenantId: scope.tenantId },
    change,
  });
};

export type EmbeddedSecretKey = 'smtp.password' | 'resend.apiKey' | 'portal.apiKey';

/**
 * Desktop-only capabilities of the embedded runtime. The hosted server has a
 * separate worker and env secrets; the desktop has neither, so it delivers
 * mail immediately with a rendered PDF and reads secrets from the OS keychain.
 */
export interface EmbeddedDesktopIntegration {
  readonly getSecret: (key: EmbeddedSecretKey) => Promise<string | null>;
  readonly renderDocumentPdf: (args: {
    kind: 'invoice' | 'offer';
    id: string;
    suggestedName: string;
  }) => Promise<{ path: string }>;
}

const ENV_SECRET_NAMES: Record<EmbeddedSecretKey, string> = {
  'smtp.password': 'SMTP_PASSWORD',
  'resend.apiKey': 'RESEND_API_KEY',
  'portal.apiKey': 'PORTAL_API_KEY',
};

/**
 * Catch-up variant of the worker's 15-minute schedule window: a desktop app is
 * often closed at the configured time, so a daily job is due from that time on
 * until it has run once that day.
 */
const isDailyRunDue = (enabled: boolean | undefined, runTime: string | undefined, lastRun: string | undefined, now = new Date()): boolean => {
  if (!enabled) return false;
  const [hour, minute] = (runTime ?? '').split(':').map(Number);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return false;
  if (now.getHours() * 60 + now.getMinutes() < hour! * 60 + minute!) return false;
  if (!lastRun) return true;
  const last = new Date(lastRun);
  return last.getFullYear() !== now.getFullYear() || last.getMonth() !== now.getMonth() || last.getDate() !== now.getDate();
};

export interface RegisterAutomationRoutesOptions {
  readonly requireSession: (
    app: FastifyInstance,
    product: 'lite' | 'pro',
    authorization: string | undefined,
  ) => Promise<AuthSession>;
  readonly requireDatabase: (app: FastifyInstance) => ServerDatabase;
  readonly desktopIntegration?: EmbeddedDesktopIntegration;
}

export const registerAutomationRoutes = (
  app: FastifyInstance,
  product: 'lite' | 'pro',
  prefix: string,
  options: RegisterAutomationRoutesOptions,
): void => {
  const sessionFor = (authorization: string | undefined) =>
    options.requireSession(app, product, authorization);
  const database = () => options.requireDatabase(app);
  const integration = options.desktopIntegration;
  const secretFor = async (key: EmbeddedSecretKey): Promise<string | undefined> =>
    (integration ? await integration.getSecret(key) : process.env[ENV_SECRET_NAMES[key]]) || undefined;
  const missingSecretSuffix = integration ? 'Bitte in den Einstellungen hinterlegen.' : 'Bitte auf dem Server konfigurieren.';

  const resolveEmailDelivery = async (settings: RuntimeSettings) => {
    const from = {
      name: settings.email.fromName || settings.company.name,
      email: settings.email.fromEmail || settings.company.email,
    };
    if (settings.email.provider === 'none') {
      throw new Error('Kein E-Mail-Anbieter eingerichtet. Konfiguriere SMTP oder Resend unter Einstellungen → E-Mail.');
    }
    if (settings.email.provider === 'smtp') {
      const pass = await secretFor('smtp.password');
      if (!pass) throw new Error(`SMTP-Passwort fehlt. ${missingSecretSuffix}`);
      return {
        provider: 'smtp' as const,
        config: {
          host: settings.email.smtpHost,
          port: settings.email.smtpPort,
          secure: settings.email.smtpSecure,
          auth: { user: settings.email.smtpUser, pass },
        },
        from,
      };
    }
    const apiKey = await secretFor('resend.apiKey');
    if (!apiKey) throw new Error(`Resend-API-Key fehlt. ${missingSecretSuffix}`);
    return { provider: 'resend' as const, config: { apiKey }, from };
  };

  /**
   * Desktop delivery: claims due outbox entries under a lease, attaches the
   * rendered document PDF and records the outcome. The hosted server leaves
   * this to apps/server-worker.
   */
  const dispatchQueuedEmails = async (
    scope: TenantScope,
  ): Promise<Map<string, { success: boolean; messageId?: string; error?: string }>> => {
    const outcomes = new Map<string, { success: boolean; messageId?: string; error?: string }>();
    if (!integration) return outcomes;
    const db = database();
    const settings = await requireSettings(db, scope);
    const delivery = await resolveEmailDelivery(settings.settings);
    const outbox = createPostgresEmailOutboxRepository(queryTarget(db));
    const workerId = 'embedded-desktop';
    const claimedAt = new Date();
    const claimed: EmailOutboxEntry[] = await outbox.claimDue(scope, {
      limit: 25,
      workerId,
      now: claimedAt.toISOString(),
      leaseExpiresAt: new Date(claimedAt.getTime() + 5 * 60_000).toISOString(),
    });
    for (const entry of claimed) {
      const attemptedAt = new Date().toISOString();
      let outcome: { success: boolean; messageId?: string; error?: string };
      try {
        const pdf = await integration.renderDocumentPdf({
          kind: entry.documentType,
          id: entry.documentId,
          suggestedName: `${entry.documentNumber || entry.documentType}-${entry.recipientName}`,
        });
        outcome = await sendEmail(delivery.provider, delivery.config, {
          from: delivery.from,
          to: { name: entry.recipientName, email: entry.recipientEmail },
          subject: entry.subject,
          text: entry.bodyText,
          attachments: [{ filename: `${entry.documentNumber || entry.documentType}.pdf`, path: pdf.path }],
        });
      } catch (error) {
        outcome = { success: false, error: error instanceof Error ? error.message : String(error) };
      }
      await insertEmailLogRow(queryTarget(db), scope.tenantId, {
        id: randomUUID(),
        documentType: entry.documentType,
        documentId: entry.documentId,
        documentNumber: entry.documentNumber,
        recipientEmail: entry.recipientEmail,
        recipientName: entry.recipientName,
        subject: entry.subject,
        bodyText: entry.bodyText,
        provider: delivery.provider,
        status: outcome.success ? 'sent' : 'failed',
        errorMessage: outcome.error ?? null,
        sentAt: attemptedAt,
        createdAt: attemptedAt,
      });
      if (outcome.success) {
        await outbox.markSent(scope, { id: entry.id, workerId, sentAt: attemptedAt, provider: delivery.provider, providerMessageId: outcome.messageId });
      } else {
        const retryAt = isRetryableEmailError(new Error(outcome.error ?? ''))
          ? new Date(Date.now() + 15 * 60_000).toISOString()
          : undefined;
        await outbox.markFailed(scope, { id: entry.id, workerId, failedAt: attemptedAt, provider: delivery.provider, error: outcome.error ?? 'Unbekannter Versandfehler', retryAt });
      }
      outcomes.set(entry.id, outcome);
    }
    return outcomes;
  };

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/portal/health`,
    query: portalHealthQuerySchema,
    response: z.object({ ok: z.boolean(), ts: z.string() }),
    async handler({ request, query }) {
      await sessionFor(request.headers.authorization);
      return portalClient.health(query.baseUrl);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/portal/publish-offer`,
    body: portalPublishOfferBodySchema,
    response: portalPublicationResponseSchema,
    async handler({ request, body }) {
      const session = await requireAutomationMutationSession(sessionFor, request.headers.authorization);
      const db = database();
      const settings = await requireSettings(db, session.scope);
      const baseUrl = requirePortalBaseUrl(settings.settings);
      // Reserve the bearer token in the server database before the external
      // call. A retry after a portal success or local commit failure reuses it.
      const reservation = await reserveOfferPortalToken(db, session.scope, session, body.offerId);
      const publication = await portalClient.publishOffer({
        baseUrl,
        apiKey: await secretFor('portal.apiKey'),
        token: reservation.token,
        snapshot: {
          ...reservation.offer,
          share: reservation.offer.share
            ? { ...reservation.offer.share, token: undefined }
            : undefined,
        },
        customerRef: scopedCustomerRef(session.scope, reservation.offer.clientId ?? reservation.offer.id),
        customerLabel: reservation.offer.client,
        expiresAt: body.expiresAt ?? reservation.offer.validUntil,
      });
      await withRuntimeTransaction(db, async (queryable) => {
        const repositories = createPostgresBillingDependencies(queryable);
        const current = await repositories.offerRepo.getById(session.scope, body.offerId);
        if (!current) throw new ApiError(404, 'Offer not found');
        const after = await repositories.offerRepo.save(session.scope, {
          ...current,
          share: { ...(current.share ?? {}), token: reservation.token, publishedAt: nowIso() },
        });
        await repositories.auditLog.append(session.scope, {
          occurredAt: nowIso(),
          action: 'offer.publish',
          actor: actorFor(session),
          subject: { entityType: 'offer', entityId: after.id, tenantId: session.scope.tenantId },
          change: {
            before: { publishedAt: current.share?.publishedAt },
            after: { publishedAt: after.share?.publishedAt, tokenHash: hashPortalToken(reservation.token) },
          },
        });
      });
      return publication;
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/portal/publish-invoice`,
    body: portalPublishInvoiceBodySchema,
    response: portalPublicationResponseSchema,
    async handler({ request, body }) {
      const session = await requireAutomationMutationSession(sessionFor, request.headers.authorization);
      const db = database();
      const settings = await requireSettings(db, session.scope);
      const baseUrl = requirePortalBaseUrl(settings.settings);
      const reservation = await reserveInvoicePortalToken(db, session.scope, session, body.invoiceId);
      const publication = await portalClient.publishInvoice({
        baseUrl,
        apiKey: await secretFor('portal.apiKey'),
        token: reservation.token,
        snapshot: reservation.invoice,
        customerRef: scopedCustomerRef(session.scope, reservation.invoice.clientId ?? reservation.invoice.id),
        customerLabel: reservation.invoice.client,
        expiresAt: body.expiresAt,
      });
      const publishedAt = nowIso();
      const published = await withRuntimeTransaction(db, async (queryable) =>
        markPortalPublicationPublished(
          queryable,
          session.scope,
          'invoice',
          reservation.invoice.id,
          publishedAt,
          body.expiresAt,
        ));
      await appendAudit(db, session.scope, session, 'invoice.publish', 'invoice', reservation.invoice.id, undefined, {
        after: { tokenHash: published.tokenHash, publishedAt },
      });
      return publication;
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/portal/sync-offer-status`,
    body: portalSyncBodySchema,
    response: portalSyncResponseSchema,
    async handler({ request, body }) {
      const session = await requireAutomationMutationSession(sessionFor, request.headers.authorization);
      const db = database();
      const settings = await requireSettings(db, session.scope);
      const baseUrl = requirePortalBaseUrl(settings.settings);
      const repository = createPostgresOfferRepository(queryTarget(db));
      const offer = await repository.getById(session.scope, body.offerId);
      if (!offer) throw new ApiError(404, 'Offer not found');
      const token = offer.share?.token;
      if (!token) throw new ApiError(409, 'Offer has not been published to the portal');
      const status = await portalClient.getOfferStatus(baseUrl, token);
      const decision = status.decision ?? null;
      if (!decision) return { ok: true as const, decision, updated: false };
      const { updated } = await applyServerOfferPortalDecision(db, session.scope, {
        offerId: body.offerId, shareToken: token, decision, actor: actorFor(session),
      });
      return { ok: true as const, decision, updated };
    },
  });

  for (const [suffix, clientMethod, action] of [
    ['/portal/customer-access-link', 'createCustomerAccessLink', 'portal.customer_access_link.create'],
    ['/portal/customer-access-link/rotate', 'rotateCustomerAccessLink', 'portal.customer_access_link.rotate'],
  ] as const) {
    typedRoute(app, {
      method: 'POST',
      url: `${prefix}${suffix}`,
      body: customerAccessLinkBodySchema,
      response: customerAccessLinkResponseSchema,
      async handler({ request, body }) {
        const session = await requireAutomationMutationSession(sessionFor, request.headers.authorization);
        const db = database();
        const settings = await requireSettings(db, session.scope);
        const baseUrl = requirePortalBaseUrl(settings.settings);
        const publication = await portalClient[clientMethod]({
          baseUrl,
          apiKey: await secretFor('portal.apiKey'),
          customerRef: scopedCustomerRef(session.scope, body.customerRef),
          customerLabel: body.customerLabel,
          expiresInDays: body.expiresInDays,
        });
        await appendAudit(db, session.scope, session, action, 'customer-access-link', body.customerRef);
        return publication;
      },
    });
  }

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/email/send`,
    body: sendEmailBodySchema,
    response: sendEmailResponseSchema,
    async handler({ request, body }) {
      const session = await requireAutomationMutationSession(sessionFor, request.headers.authorization);
      const db = database();
      const settings = await requireSettings(db, session.scope);
      try {
        await resolveEmailDelivery(settings.settings);
      } catch (error) {
        // Never report a queued mail as sent when nothing can deliver it.
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
      const repositories = createPostgresBillingDependencies(queryTarget(db));
      const document = body.documentType === 'invoice'
        ? await repositories.invoiceRepo.getById(session.scope, body.documentId)
        : await repositories.offerRepo.getById(session.scope, body.documentId);
      if (!document) throw new ApiError(404, `${body.documentType} not found`);
      const unitOfWork = createPostgresBillingUnitOfWork(db);
      const queued = await unitOfWork.withTransaction(session.scope, async ({ repositories: txRepositories }) => {
        const entry = await queueEmailDelivery(session.scope, { outboxRepo: txRepositories.emailOutboxRepo }, {
          documentType: body.documentType,
          documentId: body.documentId,
          documentNumber: document.number,
          recipientEmail: body.recipientEmail,
          recipientName: body.recipientName,
          subject: body.subject,
          bodyText: body.bodyText,
        });
        await txRepositories.auditLog.append(session.scope, {
          occurredAt: nowIso(),
          action: 'email.queued',
          actor: actorFor(session),
          subject: { entityType: body.documentType, entityId: body.documentId, tenantId: session.scope.tenantId },
          change: { after: entry },
        });
        return entry;
      });
      if (!integration) return { success: true, messageId: queued.id };
      const outcome = (await dispatchQueuedEmails(session.scope)).get(queued.id);
      if (!outcome) {
        return { success: false, error: 'Die E-Mail wurde bereits versendet oder wird gerade versendet.' };
      }
      return outcome.success
        ? { success: true, messageId: outcome.messageId ?? queued.id }
        : { success: false, error: outcome.error ?? 'E-Mail konnte nicht versendet werden.' };
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/email/test-config`,
    body: testEmailBodySchema,
    response: sendEmailResponseSchema,
    async handler({ request, body }) {
      const session = await requireAutomationMutationSession(sessionFor, request.headers.authorization);
      const settings = await requireSettings(database(), session.scope);
      if (body.provider === 'smtp') {
        const pass = await secretFor('smtp.password');
        if (!pass) return { success: false, error: `SMTP-Passwort fehlt. ${missingSecretSuffix}` };
        return testEmailConfig('smtp', {
          host: body.smtpHost ?? settings.settings.email.smtpHost,
          port: body.smtpPort ?? settings.settings.email.smtpPort,
          secure: body.smtpSecure ?? settings.settings.email.smtpSecure,
          auth: { user: body.smtpUser ?? settings.settings.email.smtpUser, pass },
        });
      }
      const apiKey = await secretFor('resend.apiKey');
      if (!apiKey) return { success: false, error: `Resend-API-Key fehlt. ${missingSecretSuffix}` };
      return testEmailConfig('resend', { apiKey });
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/dunning/manual-run`,
    body: z.undefined(),
    response: dunningRunResponseSchema,
    async handler({ request }) {
      const session = await requireAutomationMutationSession(sessionFor, request.headers.authorization);
      const db = database();
      try {
        const settings = await requireSettings(db, session.scope);
        const queryable = queryTarget(db);
        const parsedSettings = settings.settings as unknown as DunningSettings;
        const result = await processDunningRun(session.scope, {
          invoiceRepo: createPostgresInvoiceRepository(queryable),
          settingsRepo: {
            get: async () => parsedSettings,
            save: async (_scope, nextSettings) => {
              await saveServerSettings(queryable, {
                tenantId: session.scope.tenantId,
                settingsJson: JSON.stringify(appSettingsSchema.parse(nextSettings)),
                createdAt: settings.createdAt,
                updatedAt: nowIso(),
              });
            },
          },
          dunningHistoryRepo: createPostgresDunningHistoryRepository(queryable),
          emailPort: {
            send: async (provider, providerConfig, message) => sendEmail(provider, providerConfig, {
              from: message.from,
              to: message.to,
              subject: message.subject,
              text: message.text,
            }),
            log: async (_scope, entry) => {
              const id = randomUUID();
              const createdAt = nowIso();
              await insertEmailLogRow(queryable, session.scope.tenantId, { id, ...entry, errorMessage: entry.errorMessage ?? null, createdAt });
              return { id, createdAt, ...entry };
            },
          },
          secretStore: {
            get: async (key) => (await secretFor(key === 'smtp.password' ? 'smtp.password' : 'resend.apiKey')) ?? null,
          },
          auditLog: createPostgresAuditLogPort(queryable),
          actor: actorFor(session),
          isRetryableError: isRetryableEmailError,
          logger: console,
        });
        return { success: true, result };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  typedRoute(app, {
    method: 'GET',
    url: `${prefix}/dunning/invoices/:invoiceId/status`,
    params: invoiceStatusParamsSchema,
    response: invoiceStatusResponseSchema,
    async handler({ request, params }) {
      const session = await sessionFor(request.headers.authorization);
      const db = database();
      const queryable = queryTarget(db);
      const invoice = await createPostgresInvoiceRepository(queryable).getById(session.scope, params.invoiceId);
      if (!invoice) throw new ApiError(404, 'Invoice not found');
      const history = await createPostgresDunningHistoryRepository(queryable).listByInvoice(session.scope, params.invoiceId);
      return summarizeInvoiceDunningStatus(invoice, history);
    },
  });

  typedRoute(app, {
    method: 'POST',
    url: `${prefix}/recurring/manual-run`,
    body: z.undefined(),
    response: recurringRunResponseSchema,
    async handler({ request }) {
      const session = await requireAutomationMutationSession(sessionFor, request.headers.authorization);
      const db = database();
      try {
        const result = await runRecurringInvoiceRun(
          session.scope,
          createServerRecurringDependencies(db, session.scope, { actor: actorFor(session) }),
          {
            auditLog: createPostgresAuditLogPort(db),
            actor: actorFor(session),
            reason: 'manual',
            action: 'recurring.manual_run',
          },
        );
        return { success: true, result };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  });

  if (integration) {
    // Desktop replacement for apps/server-worker's schedules: the Electron main
    // process calls this periodically; each job decides itself whether it is due.
    typedRoute(app, {
      method: 'POST',
      url: `${prefix}/automation/tick`,
      body: z.undefined(),
      response: z.object({
        recurring: z.enum(['skipped', 'ran', 'failed']),
        dunning: z.enum(['skipped', 'ran', 'failed']),
        emailsDispatched: z.number(),
        portalDecisionsApplied: z.number(),
        errors: z.array(z.string()),
      }),
      async handler({ request }) {
        const session = await requireAutomationMutationSession(sessionFor, request.headers.authorization);
        const db = database();
        const errors: string[] = [];
        const snapshot = await requireSettings(db, session.scope);

        let recurring: 'skipped' | 'ran' | 'failed' = 'skipped';
        const automation = snapshot.settings.automation;
        if (isDailyRunDue(automation.recurringEnabled, automation.recurringRunTime, automation.lastRecurringRun)) {
          const runAt = nowIso();
          try {
            await runRecurringInvoiceRun(
              session.scope,
              createServerRecurringDependencies(db, session.scope, { actor: actorFor(session) }),
              {
                auditLog: createPostgresAuditLogPort(db),
                actor: actorFor(session),
                reason: 'scheduled',
                action: 'recurring.scheduled_run',
                afterProcess: async () => {
                  const current = await requireSettings(db, session.scope);
                  await saveServerSettings(queryTarget(db), {
                    tenantId: session.scope.tenantId,
                    settingsJson: JSON.stringify({
                      ...current.settings,
                      automation: { ...current.settings.automation, lastRecurringRun: runAt },
                    }),
                    createdAt: current.createdAt,
                    updatedAt: runAt,
                  });
                },
              },
            );
            recurring = 'ran';
          } catch (error) {
            recurring = 'failed';
            errors.push(`Abo-Lauf: ${error instanceof Error ? error.message : String(error)}`);
          }
        }

        let dunning: 'skipped' | 'ran' | 'failed' = 'skipped';
        if (isDailyRunDue(automation.dunningEnabled, automation.dunningRunTime, automation.lastDunningRun)) {
          const response = await app.inject({
            method: 'POST',
            url: `${prefix}/dunning/manual-run`,
            headers: {
              ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
              ...(request.headers['x-billme-local-token'] ? { 'x-billme-local-token': String(request.headers['x-billme-local-token']) } : {}),
            },
          });
          const payload = response.json() as { success?: boolean; error?: string };
          dunning = response.statusCode < 300 && payload.success ? 'ran' : 'failed';
          if (dunning === 'failed') errors.push(`Mahnlauf: ${payload.error ?? `HTTP ${response.statusCode}`}`);
        }

        let emailsDispatched = 0;
        try {
          const outcomes = await dispatchQueuedEmails(session.scope);
          emailsDispatched = [...outcomes.values()].filter((outcome) => outcome.success).length;
        } catch (error) {
          // No provider configured yet: queued mails stay pending until one is.
          errors.push(`E-Mail-Versand: ${error instanceof Error ? error.message : String(error)}`);
        }

        let portalDecisionsApplied = 0;
        const portalBaseUrl = snapshot.settings.portal?.baseUrl?.trim();
        if (portalBaseUrl) {
          const offers = await createPostgresOfferRepository(queryTarget(db)).list(session.scope);
          for (const offer of offers.filter((entry) => entry.share?.token && !entry.share.decision && !entry.share.acceptedAt)) {
            try {
              const shareToken = offer.share!.token!;
              const { decision } = await portalClient.getOfferStatus(portalBaseUrl, shareToken);
              if (!decision) continue;
              const result = await applyServerOfferPortalDecision(db, session.scope, {
                offerId: offer.id, shareToken, decision, actor: actorFor(session),
              });
              if (result.updated) portalDecisionsApplied += 1;
            } catch (error) {
              errors.push(`Portal ${offer.number}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }

        return { recurring, dunning, emailsDispatched, portalDecisionsApplied, errors };
      },
    });
  }
};
