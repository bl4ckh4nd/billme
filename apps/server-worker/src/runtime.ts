import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createTaxFilingRecord, transitionTaxFiling } from '@billme/accounting-engine';
import { SettingsSchema } from '@billme/desktop-data/validation-schemas';
import { sendEmail } from '@billme/desktop-core/services/emailService';
import { isRetryableEmailError } from '@billme/desktop-core/utils/retry';
import { portalClient } from '@billme/desktop-services/portalClient';
import {
  createPostgresAuditLogPort,
  applyServerOfferPortalDecision,
  createPostgresClientRepository,
  createPostgresDunningHistoryRepository,
  createPostgresEmailOutboxRepository,
  createPostgresInvoiceRepository,
  createPostgresMaintenanceRepository,
  createPostgresOfferRepository,
  createPostgresPool,
  createPostgresServerDatabase,
  createServerRecurringDependencies,
  createPostgresTaxFilingRepository,
  claimTaxSubmissionJob,
  completeTaxSubmissionJob,
  failTaxSubmissionJob,
  getReportSnapshot,
  createPostgresTenantRepository,
  createDefaultTenantScope,
  getServerSettings,
  insertEmailLogRow,
  assertDrizzleSchemaCurrent,
  saveServerSettings,
  withPostgresTransaction,
  type PostgresTransactionClient,
} from '@billme/server-data';
import {
  processDunningRun,
  runMaintenanceSweep,
  runRecurringInvoiceRun,
  shouldRunScheduledDunning,
  shouldRunScheduledRecurring,
  createTaxFilingService,
  type RecurringResult,
  type AuditActor,
  type EmailOutboxEntry,
  type Tenant,
  type TenantScope,
} from '@billme/server-core';
import type { WorkerLogger } from './logger.js';
import { dispatchQueuedEmailBatch } from './emailQueue.js';
import { submitQueuedTaxFilings } from './taxFilingSubmission.js';

const taxFilingStateMachine = { create: createTaxFilingRecord, transition: transitionTaxFiling };

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

export const toRecurringWorkerTaskResult = (result: RecurringResult): WorkerTaskResult => ({
  status: 'completed',
  message: 'Recurring run finished',
  details: {
    generated: result.generated,
    deactivated: result.deactivated,
    errors: result.errors.length,
  },
});

type ScopeResolution = {
  scope: TenantScope;
  tenant: Tenant;
};

const workerActor: AuditActor = {
  type: 'service',
  id: 'billme-server-worker',
  displayName: 'billme-server-worker',
};

export class ServerWorkerRuntime {
  private readonly logger: WorkerLogger;
  private readonly queryContext = new AsyncLocalStorage<PostgresTransactionClient>();
  private readonly pool: ReturnType<typeof createPostgresPool>;
  private readonly database: ReturnType<typeof createPostgresServerDatabase>;
  private readonly workerId = `billme-server-worker:${process.pid}`;

  constructor(
    private readonly env: WorkerEnvironment,
    logger: WorkerLogger,
  ) {
    this.logger = logger.child({ component: 'runtime' });
    this.pool = createPostgresPool(this.env.databaseUrl);
    this.database = createPostgresServerDatabase(this.pool);
  }

  async init(): Promise<void> {
    await assertDrizzleSchemaCurrent(this.pool);
  }

  async close(): Promise<void> {
    await this.database.close();
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

    const runAt = new Date().toISOString();
    let result: Awaited<ReturnType<typeof runRecurringInvoiceRun>>;
    try {
      result = await runRecurringInvoiceRun(
        resolved.scope,
        createServerRecurringDependencies(this.database, resolved.scope, { actor: workerActor }),
        {
          auditLog: createPostgresAuditLogPort(this.database),
          actor: workerActor,
          reason: 'scheduled',
          action: 'recurring.scheduled_run',
          afterProcess: async () => {
            await saveServerSettings(this.database, {
              tenantId: resolved.scope.tenantId,
              settingsJson: JSON.stringify({
                ...settingsSnapshot.settings,
                automation: {
                  ...settingsSnapshot.settings.automation,
                  lastRecurringRun: runAt,
                },
              }),
              createdAt: settingsSnapshot.createdAt,
              updatedAt: runAt,
            });
          },
        },
      );
    } catch (error) {
      return this.blockedJob(error instanceof Error ? error.message : String(error));
    }

    return toRecurringWorkerTaskResult(result);
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

  async runTaxFilingSubmissionJob(): Promise<WorkerTaskResult> {
    const resolved = await this.resolveScope();
    if (!resolved) {
      return { status: 'skipped', message: 'No primary tenant is bootstrapped yet' };
    }

    const result = await submitQueuedTaxFilings({
      scope: resolved.scope,
      service: createTaxFilingService({
        repository: createPostgresTaxFilingRepository(this.currentQueryable()),
        stateMachine: taxFilingStateMachine,
        auditLog: createPostgresAuditLogPort(this.currentQueryable()),
        reportSnapshot: { get: async (scope, id) => {
          const snapshot = await getReportSnapshot(this.currentQueryable(), scope, id);
          return snapshot ? { id: snapshot.id, tenantId: snapshot.tenantId, sourceHash: snapshot.sourceHash } : null;
        } },
      }),
      jobs: {
        claim: async (scope) => {
          const job = await claimTaxSubmissionJob(this.currentQueryable(), scope, 'tax-filing');
          return job ? { id: job.id, submissionId: job.submissionId } : null;
        },
        complete: (scope, id) => completeTaxSubmissionJob(this.currentQueryable(), scope, id),
        fail: (scope, id, error) => failTaxSubmissionJob(this.currentQueryable(), scope, id, error),
      },
    });
    return {
      status: result.retryableFailed > 0 && result.accepted === 0 && result.rejected === 0 ? 'blocked' : 'completed',
      message: 'Tax filing submission run finished',
      details: { ...result },
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

    const offers = await createPostgresOfferRepository(this.database).list(resolved.scope);
    const pendingOffers = offers.filter((offer) => offer.share?.token && !offer.share.decision && !offer.share.acceptedAt);
    let updated = 0;
    for (const offer of pendingOffers) {
      try {
        const shareToken = offer.share!.token!;
        const { decision } = await portalClient.getOfferStatus(baseUrl, shareToken);
        if (!decision) continue;
        const result = await applyServerOfferPortalDecision(this.database, resolved.scope, {
          offerId: offer.id, shareToken, decision, actor: workerActor,
        });
        if (result.updated) updated += 1;
      } catch (error) {
        this.logger.warn('Portal sync offer failed', {
          offerId: offer.id,
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

}

const send = (
  provider: 'smtp' | 'resend',
  providerConfig: Parameters<typeof sendEmail>[1],
  message: Parameters<typeof sendEmail>[2],
) => {
  return sendEmail(provider, providerConfig, message);
};

export const defaultDatabaseUrl = 'postgresql://billme:billme@127.0.0.1:5432/billme';
