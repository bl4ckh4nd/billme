import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { SettingsSchema } from '@billme/desktop-data/validation-schemas';
import { sendEmail } from '@billme/desktop-core/services/emailService';
import { isRetryableEmailError } from '@billme/desktop-core/utils/retry';
import { portalClient } from '@billme/desktop-services/portalClient';
import {
  createPostgresAuditLogPort,
  createPostgresClientRepository,
  createPostgresDunningHistoryRepository,
  createPostgresEmailOutboxRepository,
  createPostgresInvoiceRepository,
  createPostgresMaintenanceRepository,
  createPostgresOfferRepository,
  createPostgresPool,
  createPostgresRecurringProfileRepository,
  createPostgresTenantRepository,
  createDefaultTenantScope,
  getServerSettings,
  insertEmailLogRow,
  listServerNumberReservations,
  assertDrizzleSchemaCurrent,
  saveServerNumberReservation,
  saveServerSettings,
  withPostgresTransaction,
  type PostgresTransactionClient,
} from '@billme/server-data';
import {
  ensureDefaultProjectForClient,
  finalizeDocumentNumber,
  listOffersPendingPortalSync,
  processDunningRun,
  runMaintenanceSweep,
  processRecurringRun,
  releaseDocumentNumber,
  reserveDocumentNumber,
  shouldRunScheduledDunning,
  shouldRunScheduledRecurring,
  syncPublishedOfferDecisionFromPortal,
  type AuditActor,
  type AuditEntry,
  type AuditEntryDraft,
  type ClientProject,
  type DefaultProjectPorts,
  type DocumentNumberingPorts,
  type EmailOutboxEntry,
  type Offer,
  type OfferDomainDependencies,
  type RecurringDomainDependencies,
  type Tenant,
  type TenantScope,
} from '@billme/server-core';
import type { WorkerLogger } from './logger.js';
import { dispatchQueuedEmailBatch } from './emailQueue.js';

type WorkerSettings = z.infer<typeof SettingsSchema>;

export interface WorkerEnvironment {
  databaseUrl: string;
  smtpPassword?: string;
  resendApiKey?: string;
  tenantId?: string;
}

export interface WorkerTaskResult {
  status: 'completed' | 'skipped' | 'blocked';
  message: string;
  details?: Record<string, unknown>;
}

type ScopeResolution = {
  scope: TenantScope;
  tenant: Tenant;
};

const workerActor: AuditActor = {
  type: 'service',
  id: 'billme-server-worker',
  displayName: 'billme-server-worker',
};

const isActiveDefaultProject = (project: ClientProject) => {
  return project.name === 'Allgemein' && !project.archivedAt && project.status === 'active';
};

const stripOfferHistory = (offer: Offer): Offer => {
  const { history: _history, ...rest } = offer;
  return {
    ...rest,
    history: [],
  };
};

const createBufferedAuditLog = () => {
  const entries: AuditEntryDraft[] = [];

  const toAuditEntry = (entry: AuditEntryDraft, index: number): AuditEntry => ({
    sequence: index + 1,
    ...entry,
    prevHash: null,
    hash: `buffered-${index + 1}`,
  });

  return {
    entries,
    port: {
      append(_scope: TenantScope, entry: AuditEntryDraft) {
        entries.push(entry);
        return toAuditEntry(entry, entries.length - 1);
      },
      listBySubject(_scope: TenantScope, subject: { entityType: string; entityId: string }) {
        return entries
          .filter((entry) => entry.subject.entityType === subject.entityType && entry.subject.entityId === subject.entityId)
          .map((entry, index) => toAuditEntry(entry, index));
      },
    },
  };
};

const createBufferedOfferRepository = (offer: Offer) => {
  let current = offer;

  return {
    port: {
      list() {
        return [current];
      },
      getById(_scope: TenantScope, id: string) {
        return id === current.id ? current : null;
      },
      save(_scope: TenantScope, nextOffer: Offer) {
        current = nextOffer;
        return nextOffer;
      },
      remove() {
        return;
      },
    },
    current: () => current,
  };
};

export class ServerWorkerRuntime {
  private readonly logger: WorkerLogger;
  private readonly queryContext = new AsyncLocalStorage<PostgresTransactionClient>();
  private readonly pool: ReturnType<typeof createPostgresPool>;
  private readonly workerId = `billme-server-worker:${process.pid}`;

  constructor(
    private readonly env: WorkerEnvironment,
    logger: WorkerLogger,
  ) {
    this.logger = logger.child({ component: 'runtime' });
    this.pool = createPostgresPool(this.env.databaseUrl);
  }

  async init(): Promise<void> {
    await assertDrizzleSchemaCurrent(this.pool);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async runRecurringJob(): Promise<WorkerTaskResult> {
    const resolved = await this.resolveScope();
    if (!resolved) {
      return {
        status: 'skipped',
        message: 'No primary tenant is bootstrapped yet',
      };
    }

    const settingsSnapshot = await this.readSettings(resolved.scope);
    if (!settingsSnapshot) {
      return {
        status: 'skipped',
        message: 'Server settings are not initialized yet',
      };
    }

    if (!shouldRunScheduledRecurring(settingsSnapshot.settings)) {
      return {
        status: 'skipped',
        message: 'Recurring schedule window is not due',
      };
    }

    const result = await processRecurringRun(resolved.scope, this.createRecurringDependencies(resolved.scope));
    await this.saveSettings(resolved.scope, {
      ...settingsSnapshot.settings,
      automation: {
        ...settingsSnapshot.settings.automation,
        lastRecurringRun: new Date().toISOString(),
      },
    }, settingsSnapshot.createdAt);

    return {
      status: 'completed',
      message: 'Recurring run finished',
      details: {
        generated: result.generated,
        deactivated: result.deactivated,
        errors: result.errors.length,
      },
    };
  }

  async runDunningJob(): Promise<WorkerTaskResult> {
    const resolved = await this.resolveScope();
    if (!resolved) {
      return {
        status: 'skipped',
        message: 'No primary tenant is bootstrapped yet',
      };
    }

    const settingsSnapshot = await this.readSettings(resolved.scope);
    if (!settingsSnapshot) {
      return {
        status: 'skipped',
        message: 'Server settings are not initialized yet',
      };
    }

    if (!shouldRunScheduledDunning(settingsSnapshot.settings)) {
      return {
        status: 'skipped',
        message: 'Dunning schedule window is not due',
      };
    }

    const result = await processDunningRun(resolved.scope, {
      invoiceRepo: {
        list: (scope) => createPostgresInvoiceRepository(this.currentQueryable()).list(scope),
        getById: (scope, id) => createPostgresInvoiceRepository(this.currentQueryable()).getById(scope, id),
        save: (scope, invoice) => createPostgresInvoiceRepository(this.currentQueryable()).save(scope, invoice),
      },
      settingsRepo: {
        get: async (scope) => (await this.readSettings(scope))?.settings ?? null,
        save: async (scope, settings) => {
          const current = await this.readSettings(scope);
          await this.saveSettings(scope, settings, current?.createdAt);
        },
      },
      dunningHistoryRepo: createPostgresDunningHistoryRepository(this.currentQueryable()),
      emailPort: {
        send,
        log: async (scope, entry) => {
          const id = randomUUID();
          const createdAt = new Date().toISOString();
          await insertEmailLogRow(this.currentQueryable(), scope.tenantId, {
            id,
            documentType: entry.documentType,
            documentId: entry.documentId,
            documentNumber: entry.documentNumber,
            recipientEmail: entry.recipientEmail,
            recipientName: entry.recipientName,
            subject: entry.subject,
            bodyText: entry.bodyText,
            provider: entry.provider,
            status: entry.status,
            errorMessage: entry.errorMessage ?? null,
            sentAt: entry.sentAt,
            createdAt,
          });
          return {
            ...entry,
            id,
            createdAt,
          };
        },
      },
      secretStore: {
        get: async (key) => {
          if (key === 'smtp.password') {
            return this.env.smtpPassword ?? null;
          }
          return this.env.resendApiKey ?? null;
        },
      },
      auditLog: createPostgresAuditLogPort(this.currentQueryable()),
      actor: workerActor,
      logger: this.logger.child({ job: 'dunning' }),
      isRetryableError: isRetryableEmailError,
    });

    return {
      status: 'completed',
      message: 'Dunning run finished',
      details: {
        processedInvoices: result.processedInvoices,
        emailsSent: result.emailsSent,
        feesApplied: result.feesApplied,
        errors: result.errors.length,
      },
    };
  }

  async runQueuedEmailJob(): Promise<WorkerTaskResult> {
    const resolved = await this.resolveScope();
    if (!resolved) {
      return {
        status: 'skipped',
        message: 'No primary tenant is bootstrapped yet',
      };
    }

    const settingsSnapshot = await this.readSettings(resolved.scope);
    if (!settingsSnapshot) {
      return {
        status: 'skipped',
        message: 'Server settings are not initialized yet',
      };
    }

    let deliveryConfig: {
      provider: 'smtp' | 'resend';
      config: Parameters<typeof sendEmail>[1];
      from: {
        name: string;
        email: string;
      };
    };

    try {
      deliveryConfig = await this.resolveEmailDeliveryConfig(settingsSnapshot.settings);
    } catch (error) {
      return this.blockedJob(error instanceof Error ? error.message : String(error));
    }

    const logger = this.logger.child({ job: 'queued-email-dispatch' });
    const batch = await dispatchQueuedEmailBatch({
      claimDue: async () => {
        const now = new Date();
        return createPostgresEmailOutboxRepository(this.currentQueryable()).claimDue(resolved.scope, {
          limit: 25,
          workerId: this.workerId,
          now: now.toISOString(),
          leaseExpiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
        });
      },
      send: async (entry) => {
        return sendEmail(deliveryConfig.provider, deliveryConfig.config, {
          from: deliveryConfig.from,
          to: {
            name: entry.recipientName,
            email: entry.recipientEmail,
          },
          subject: entry.subject,
          text: entry.bodyText,
        });
      },
      recordSuccess: async (entry, args) => {
        await this.inTransaction(async () => {
          await this.logQueuedEmailAttempt(resolved.scope, entry, {
            provider: deliveryConfig.provider,
            status: 'sent',
            errorMessage: undefined,
            attemptedAt: args.sentAt,
          });

          const updated = await createPostgresEmailOutboxRepository(this.currentQueryable()).markSent(resolved.scope, {
            id: entry.id,
            workerId: this.workerId,
            sentAt: args.sentAt,
            provider: deliveryConfig.provider,
            providerMessageId: args.messageId,
          });

          if (!updated) {
            throw new Error(`Queued email ${entry.id} was not locked by this worker`);
          }
        });
      },
      recordFailure: async (entry, args) => {
        return this.inTransaction(async () => {
          await this.logQueuedEmailAttempt(resolved.scope, entry, {
            provider: deliveryConfig.provider,
            status: 'failed',
            errorMessage: args.error,
            attemptedAt: args.failedAt,
          });

          const updated = await createPostgresEmailOutboxRepository(this.currentQueryable()).markFailed(resolved.scope, {
            id: entry.id,
            workerId: this.workerId,
            failedAt: args.failedAt,
            provider: deliveryConfig.provider,
            error: args.error,
            retryAt: args.retryAt,
          });

          return updated?.status === 'pending' ? 'pending' : 'failed';
        });
      },
      logger,
      isRetryableError: isRetryableEmailError,
    });

    return {
      status: 'completed',
      message: 'Queued email dispatch finished',
      details: { ...batch },
    };
  }

  async runPortalSyncJob(): Promise<WorkerTaskResult> {
    const resolved = await this.resolveScope();
    if (!resolved) {
      return {
        status: 'skipped',
        message: 'No primary tenant is bootstrapped yet',
      };
    }

    const settingsSnapshot = await this.readSettings(resolved.scope);
    if (!settingsSnapshot) {
      return {
        status: 'skipped',
        message: 'Server settings are not initialized yet',
      };
    }

    const baseUrl = settingsSnapshot.settings.portal?.baseUrl?.trim();
    if (!baseUrl) {
      return {
        status: 'skipped',
        message: 'Portal base URL is not configured',
      };
    }

    const offerRepository = createPostgresOfferRepository(this.currentQueryable());
    const auditLog = createPostgresAuditLogPort(this.currentQueryable());
    const offers = await offerRepository.list(resolved.scope);
    const pendingOffers = listOffersPendingPortalSync(resolved.scope, {
      offerRepo: {
        list: () => offers,
        getById: (_scope, id) => offers.find((offer) => offer.id === id) ?? null,
        save: (_scope, offer) => offer,
        remove: () => undefined,
      },
    });

    let updated = 0;

    for (const pendingOffer of pendingOffers) {
      const currentOffer = offers.find((offer) => offer.id === pendingOffer.id);
      if (!currentOffer) {
        continue;
      }

      const bufferedOffers = createBufferedOfferRepository(currentOffer);
      const bufferedAuditLog = createBufferedAuditLog();

      try {
        const result = await syncPublishedOfferDecisionFromPortal(
          resolved.scope,
          {
            offerRepo: bufferedOffers.port,
            auditLog: bufferedAuditLog.port,
            portalGateway: {
              getOfferStatus: (shareToken) => portalClient.getOfferStatus(baseUrl, shareToken),
            },
          } satisfies OfferDomainDependencies & {
            portalGateway: {
              getOfferStatus: (shareToken: string) => Promise<{ decision?: unknown }>;
            };
          },
          {
            offerId: pendingOffer.id,
            actor: workerActor,
          },
        );

        if (!result.updated) {
          continue;
        }

        await offerRepository.save(resolved.scope, stripOfferHistory(bufferedOffers.current()));
        for (const entry of bufferedAuditLog.entries) {
          await auditLog.append(resolved.scope, entry);
        }

        updated += 1;
      } catch (error) {
        this.logger.warn('Portal sync offer failed', {
          offerId: pendingOffer.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      status: 'completed',
      message: 'Portal sync run finished',
      details: {
        pending: pendingOffers.length,
        updated,
      },
    };
  }

  async runMaintenanceJob(): Promise<WorkerTaskResult> {
    const resolved = await this.resolveScope();
    if (!resolved) {
      return {
        status: 'skipped',
        message: 'No primary tenant is bootstrapped yet',
      };
    }

    const result = await runMaintenanceSweep(resolved.scope, {
      retentionRepo: createPostgresMaintenanceRepository(this.currentQueryable()),
      auditLog: createPostgresAuditLogPort(this.currentQueryable()),
      actor: workerActor,
    });

    return {
      status: 'completed',
      message: 'Maintenance sweep finished',
      details: {
        totalDeleted: result.totalDeleted,
        steps: result.steps.map((step) => ({
          key: step.key,
          deletedCount: step.deletedCount,
          deleteBefore: step.deleteBefore,
        })),
      },
    };
  }

  blockedJob(message: string): WorkerTaskResult {
    return {
      status: 'blocked',
      message,
    };
  }

  private currentQueryable(): ReturnType<typeof createPostgresPool> | PostgresTransactionClient {
    return this.queryContext.getStore() ?? this.pool;
  }

  private async inTransaction<TResult>(work: () => TResult | Promise<TResult>): Promise<TResult> {
    const activeClient = this.queryContext.getStore();
    if (activeClient) {
      return work();
    }

    return withPostgresTransaction(this.pool, async (client) => {
      return this.queryContext.run(client, async () => work());
    });
  }

  private async resolveScope(): Promise<ScopeResolution | null> {
    const tenantRepository = createPostgresTenantRepository(this.currentQueryable());
    const tenant = this.env.tenantId
      ? await tenantRepository.getById(this.env.tenantId)
      : await tenantRepository.getPrimary();
    if (!tenant) {
      return null;
    }

    return {
      tenant,
      scope: createDefaultTenantScope(tenant.id, tenant.product),
    };
  }

  private async resolveEmailDeliveryConfig(settings: WorkerSettings): Promise<{
    provider: 'smtp' | 'resend';
    config: Parameters<typeof sendEmail>[1];
    from: {
      name: string;
      email: string;
    };
  }> {
    const from = {
      name: settings.email.fromName || settings.company.name,
      email: settings.email.fromEmail || settings.company.email,
    };

    if (settings.email.provider === 'none') {
      throw new Error('Email provider not configured');
    }

    if (settings.email.provider === 'smtp') {
      if (!this.env.smtpPassword) {
        throw new Error('SMTP password not configured');
      }

      return {
        provider: 'smtp',
        config: {
          host: settings.email.smtpHost,
          port: settings.email.smtpPort,
          secure: settings.email.smtpSecure,
          auth: {
            user: settings.email.smtpUser,
            pass: this.env.smtpPassword,
          },
        },
        from,
      };
    }

    if (!this.env.resendApiKey) {
      throw new Error('Resend API key not configured');
    }

    return {
      provider: 'resend',
      config: {
        apiKey: this.env.resendApiKey,
      },
      from,
    };
  }

  private async logQueuedEmailAttempt(
    scope: TenantScope,
    entry: EmailOutboxEntry,
    args: {
      provider: 'smtp' | 'resend';
      status: 'sent' | 'failed';
      errorMessage?: string;
      attemptedAt: string;
    },
  ): Promise<void> {
    await insertEmailLogRow(this.currentQueryable(), scope.tenantId, {
      id: randomUUID(),
      documentType: entry.documentType,
      documentId: entry.documentId,
      documentNumber: entry.documentNumber,
      recipientEmail: entry.recipientEmail,
      recipientName: entry.recipientName,
      subject: entry.subject,
      bodyText: entry.bodyText,
      provider: args.provider,
      status: args.status,
      errorMessage: args.errorMessage ?? null,
      sentAt: args.attemptedAt,
      createdAt: args.attemptedAt,
    });
  }

  private async readSettings(scope: TenantScope): Promise<{ settings: WorkerSettings; createdAt: string } | null> {
    const record = await getServerSettings(this.currentQueryable(), scope.tenantId);
    if (!record) {
      return null;
    }

    const parsed = SettingsSchema.parse(JSON.parse(record.settingsJson) as unknown);
    return {
      settings: parsed,
      createdAt: record.createdAt,
    };
  }

  private async saveSettings(scope: TenantScope, settings: WorkerSettings, createdAt?: string): Promise<void> {
    const now = new Date().toISOString();
    await saveServerSettings(this.currentQueryable(), {
      tenantId: scope.tenantId,
      settingsJson: JSON.stringify(settings),
      createdAt: createdAt ?? now,
      updatedAt: now,
    });
  }

  private createRecurringDependencies(scope: TenantScope): RecurringDomainDependencies {
    const createNumberingPorts = (): DocumentNumberingPorts<WorkerSettings> => ({
      tx: {
        inTransaction: (work) => this.inTransaction(work),
      },
      getSettings: async () => (await this.readSettings(scope))?.settings ?? null,
      saveSettings: async (settings) => {
        const current = await this.readSettings(scope);
        await this.saveSettings(scope, settings, current?.createdAt);
      },
      createReservation: async (reservation) => {
        const now = new Date().toISOString();
        await saveServerNumberReservation(this.currentQueryable(), {
          tenantId: scope.tenantId,
          ...reservation,
          createdAt: now,
          updatedAt: now,
        });
      },
      getReservationById: async (reservationId) => {
        const reservation = (await listServerNumberReservations(this.currentQueryable(), scope.tenantId))
          .find((entry) => entry.id === reservationId);

        if (!reservation) {
          return null;
        }

        return {
          id: reservation.id,
          kind: reservation.kind,
          number: reservation.number,
          counterValue: reservation.counterValue,
          status: reservation.status,
          documentId: reservation.documentId,
        };
      },
      updateReservation: async (reservation) => {
        const existing = (await listServerNumberReservations(this.currentQueryable(), scope.tenantId))
          .find((entry) => entry.id === reservation.id);
        const now = new Date().toISOString();

        await saveServerNumberReservation(this.currentQueryable(), {
          tenantId: scope.tenantId,
          ...reservation,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        });
      },
      isNumberTaken: async (kind, number) => {
        if (kind === 'customer') {
          const clients = await createPostgresClientRepository(this.currentQueryable()).list(scope);
          return clients.some((client) => client.customerNumber === number);
        }
        const documents = kind === 'invoice'
          ? await createPostgresInvoiceRepository(this.currentQueryable()).list(scope)
          : await createPostgresOfferRepository(this.currentQueryable()).list(scope);
        if (documents.some((document) => document.number === number)) {
          return true;
        }
        const reservations = await listServerNumberReservations(this.currentQueryable(), scope.tenantId);
        return reservations.some((reservation) =>
          reservation.kind === kind &&
          reservation.number === number &&
          reservation.status !== 'released'
        );
      },
      generateReservationId: async () => randomUUID(),
    });

    const createProjectPorts = (): DefaultProjectPorts<ClientProject> => ({
      tx: {
        inTransaction: (work) => this.inTransaction(work),
      },
      getActiveDefaultProjectForClient: async (clientId) => {
        const client = await createPostgresClientRepository(this.currentQueryable()).getById(scope, clientId);
        return client?.projects.find(isActiveDefaultProject) ?? null;
      },
      listProjectCodesByPrefix: async (prefix) => {
        const clients = await createPostgresClientRepository(this.currentQueryable()).list(scope);
        return clients.flatMap((client) =>
          client.projects
            .filter((project) => typeof project.code !== 'string' || project.code.startsWith(prefix))
            .map((project) => project.code),
        );
      },
      saveProject: async (project) => {
        const clientRepository = createPostgresClientRepository(this.currentQueryable());
        const client = await clientRepository.getById(scope, project.clientId);
        if (!client) {
          throw new Error(`Client ${project.clientId} not found`);
        }

        const nextProject = {
          ...project,
          createdAt: project.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };

        await clientRepository.save(scope, {
          ...client,
          projects: [
            ...client.projects.filter((entry) => entry.id !== nextProject.id),
            nextProject,
          ],
          updatedAt: nextProject.updatedAt,
        });

        return nextProject;
      },
    });

    return {
      tx: {
        inTransaction: (work) => this.inTransaction(work),
      },
      recurringProfileStore: {
        list: (innerScope) => createPostgresRecurringProfileRepository(this.currentQueryable()).list(innerScope),
        getById: (innerScope, id) => createPostgresRecurringProfileRepository(this.currentQueryable()).getById(innerScope, id),
        save: (innerScope, profile) => createPostgresRecurringProfileRepository(this.currentQueryable()).save(innerScope, profile),
        remove: (innerScope, id) => createPostgresRecurringProfileRepository(this.currentQueryable()).remove(innerScope, id),
      },
      clientPort: {
        getById: (innerScope, id) => createPostgresClientRepository(this.currentQueryable()).getById(innerScope, id),
      },
      invoicePort: {
        save: (innerScope, params) => createPostgresInvoiceRepository(this.currentQueryable()).save(innerScope, params.invoice),
      },
      numberingPort: {
        getSettings: async () => (await this.readSettings(scope))?.settings ?? null,
        reserve: async (kind, now) => reserveDocumentNumber(createNumberingPorts(), kind, now),
        release: async (reservationId) => releaseDocumentNumber(createNumberingPorts(), reservationId),
        finalize: async (reservationId, documentId) => finalizeDocumentNumber(createNumberingPorts(), reservationId, documentId),
      },
      projectPort: {
        ensureDefaultProject: async (clientId) => {
          const result = await ensureDefaultProjectForClient(createProjectPorts(), {
            clientId,
            createProjectId: () => randomUUID(),
          });

          if (result.created) {
            await createPostgresAuditLogPort(this.currentQueryable()).append(scope, {
              occurredAt: new Date().toISOString(),
              action: 'project.create',
              reason: 'auto:default',
              actor: workerActor,
              subject: {
                entityType: 'project',
                entityId: result.project.id,
                tenantId: scope.tenantId,
              },
              change: {
                before: null,
                after: result.project,
              },
            });
          }

          return result.project;
        },
      },
      createInvoiceId: () => randomUUID(),
    };
  }
}

const send = (
  provider: 'smtp' | 'resend',
  providerConfig: Parameters<typeof sendEmail>[1],
  message: Parameters<typeof sendEmail>[2],
) => {
  return sendEmail(provider, providerConfig, message);
};

export const defaultDatabaseUrl = 'postgresql://billme:billme@127.0.0.1:5432/billme';
