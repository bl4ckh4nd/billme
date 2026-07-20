import { z } from 'zod';
import { parsePortalAllowedOrigins } from '@billme/server-core';
import { createWorkerLogger, type WorkerLogLevel } from './logger.js';
import { ServerWorkerRuntime, defaultDatabaseUrl, type WorkerTaskResult } from './runtime.js';
import { WorkerTaskQueue } from './taskQueue.js';

type SupportedJob = {
  name: string;
  intervalMs: number;
  runOnStart?: boolean;
  execute(): Promise<WorkerTaskResult>;
};

type DisabledJob = {
  name: string;
  disabledReason: string;
};

const booleanFromEnv = (value: string | undefined): boolean => {
  if (!value) {
    return false;
  }

  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
};

const envSchema = z.object({
  DATABASE_URL: z.string().trim().min(1).optional(),
  SMTP_PASSWORD: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  WORKER_TENANT_ID: z.string().trim().min(1).optional(),
  BILLME_PORTAL_ALLOWED_ORIGINS: z.string().optional(),
  WORKER_RUN_ONCE: z.string().optional(),
  WORKER_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  WORKER_RECURRING_INTERVAL_MS: z.coerce.number().int().positive().default(15 * 60_000),
  WORKER_DUNNING_INTERVAL_MS: z.coerce.number().int().positive().default(15 * 60_000),
  WORKER_EMAIL_QUEUE_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  WORKER_PORTAL_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  WORKER_MAINTENANCE_INTERVAL_MS: z.coerce.number().int().positive().default(24 * 60 * 60_000),
  WORKER_RECEIPT_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  BILLME_DOCUMENT_STORAGE_PATH: z.string().trim().min(1).default('/data/billme-documents'),
  BILLME_INTERNAL_API_URL: z.string().url().default('http://server-api:3100'),
  BILLME_INTERNAL_WEB_URL: z.string().url().default('http://web:8080'),
  BILLME_INTERNAL_WEB_PRO_URL: z.string().url().default('http://web-pro:8080'),
  BILLME_RENDER_SECRET: z.string().trim().min(24),
  CHROMIUM_PATH: z.string().trim().min(1).optional(),
  WORKER_DOCUMENT_RENDER_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  WORKER_MOBILE_PUSH_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  WORKER_ENABLED_JOBS: z.string().optional(),
});

const env = envSchema.parse(process.env);
const logger = createWorkerLogger(env.WORKER_LOG_LEVEL as WorkerLogLevel);
const runtime = new ServerWorkerRuntime(
  {
    databaseUrl: env.DATABASE_URL ?? defaultDatabaseUrl,
    smtpPassword: env.SMTP_PASSWORD,
    resendApiKey: env.RESEND_API_KEY,
    tenantId: env.WORKER_TENANT_ID,
    portalAllowedOrigins: parsePortalAllowedOrigins(env.BILLME_PORTAL_ALLOWED_ORIGINS),
    documentStoragePath: env.BILLME_DOCUMENT_STORAGE_PATH,
    apiUrl: env.BILLME_INTERNAL_API_URL,
    webUrl: env.BILLME_INTERNAL_WEB_URL,
    webProUrl: env.BILLME_INTERNAL_WEB_PRO_URL,
    renderSecret: env.BILLME_RENDER_SECRET,
    chromiumPath: env.CHROMIUM_PATH,
  },
  logger,
);

const queue = new WorkerTaskQueue(logger.child({ component: 'queue' }));
const timers: NodeJS.Timeout[] = [];

const allSupportedJobs: SupportedJob[] = [
  {
    name: 'mobile-push',
    intervalMs: env.WORKER_MOBILE_PUSH_INTERVAL_MS,
    runOnStart: true,
    execute: () => runtime.runMobilePushJob(),
  },
  {
    name: 'document-rendering',
    intervalMs: env.WORKER_DOCUMENT_RENDER_INTERVAL_MS,
    runOnStart: true,
    execute: () => runtime.runDocumentRenderingJob(),
  },
  {
    name: 'receipt-extraction',
    intervalMs: env.WORKER_RECEIPT_INTERVAL_MS,
    runOnStart: true,
    execute: () => runtime.runReceiptExtractionJob(),
  },
  {
    name: 'recurring-invoices',
    intervalMs: env.WORKER_RECURRING_INTERVAL_MS,
    runOnStart: true,
    execute: () => runtime.runRecurringJob(),
  },
  {
    name: 'dunning',
    intervalMs: env.WORKER_DUNNING_INTERVAL_MS,
    runOnStart: true,
    execute: () => runtime.runDunningJob(),
  },
  {
    name: 'queued-email-dispatch',
    intervalMs: env.WORKER_EMAIL_QUEUE_INTERVAL_MS,
    runOnStart: true,
    execute: () => runtime.runQueuedEmailJob(),
  },
  {
    name: 'offer-portal-sync',
    intervalMs: env.WORKER_PORTAL_SYNC_INTERVAL_MS,
    runOnStart: true,
    execute: () => runtime.runPortalSyncJob(),
  },
  {
    name: 'scheduled-maintenance',
    intervalMs: env.WORKER_MAINTENANCE_INTERVAL_MS,
    execute: () => runtime.runMaintenanceJob(),
  },
];
const enabledJobNames = env.WORKER_ENABLED_JOBS
  ? new Set(env.WORKER_ENABLED_JOBS.split(',').map((name) => name.trim()).filter(Boolean))
  : null;
const supportedJobs = enabledJobNames
  ? allSupportedJobs.filter((job) => enabledJobNames.has(job.name))
  : allSupportedJobs;

const disabledJobs: DisabledJob[] = [];

const scheduleJob = (job: SupportedJob) => {
  const log = logger.child({ job: job.name });

  const run = async () => {
    const result = await job.execute();
    log.info(result.message, {
      status: result.status,
      ...(result.details ?? {}),
    });
  };

  if (job.runOnStart) {
    queue.enqueue({
      name: job.name,
      run,
    });
  }

  timers.push(setInterval(() => {
    const accepted = queue.enqueue({
      name: job.name,
      run,
    });

    if (!accepted) {
      log.debug('Skipped duplicate enqueue');
    }
  }, job.intervalMs));
};

const stopTimers = () => {
  while (timers.length > 0) {
    const timer = timers.pop();
    if (timer) {
      clearInterval(timer);
    }
  }
};

const shutdown = async (signal: string) => {
  stopTimers();
  logger.info('Shutting down worker', { signal });
  await queue.whenIdle();
  await runtime.close();
  process.exit(0);
};

await runtime.init();

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});

process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

logger.info('Worker runtime initialized', {
  supportedJobs: supportedJobs.map((job) => job.name),
  disabledJobs: disabledJobs.map((job) => ({
    name: job.name,
    reason: job.disabledReason,
  })),
  runOnce: booleanFromEnv(env.WORKER_RUN_ONCE),
});

for (const job of disabledJobs) {
  logger.warn('Worker job disabled', {
    job: job.name,
    reason: job.disabledReason,
  });
}

if (booleanFromEnv(env.WORKER_RUN_ONCE)) {
  for (const job of supportedJobs) {
    queue.enqueue({
      name: job.name,
      run: async () => {
        const result = await job.execute();
        logger.info(result.message, {
          job: job.name,
          status: result.status,
          ...(result.details ?? {}),
        });
      },
    });
  }

  await queue.whenIdle();
  await runtime.close();
  process.exit(0);
}

for (const job of supportedJobs) {
  scheduleJob(job);
}
