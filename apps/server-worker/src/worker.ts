import { z } from 'zod';
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
  WORKER_RUN_ONCE: z.string().optional(),
  WORKER_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  WORKER_RECURRING_INTERVAL_MS: z.coerce.number().int().positive().default(15 * 60_000),
  WORKER_DUNNING_INTERVAL_MS: z.coerce.number().int().positive().default(15 * 60_000),
  WORKER_EMAIL_QUEUE_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  WORKER_TAX_FILING_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  WORKER_PORTAL_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  WORKER_MAINTENANCE_INTERVAL_MS: z.coerce.number().int().positive().default(24 * 60 * 60_000),
});

const env = envSchema.parse(process.env);
const logger = createWorkerLogger(env.WORKER_LOG_LEVEL as WorkerLogLevel);
const runtime = new ServerWorkerRuntime(
  {
    databaseUrl: env.DATABASE_URL ?? defaultDatabaseUrl,
    smtpPassword: env.SMTP_PASSWORD,
    resendApiKey: env.RESEND_API_KEY,
    tenantId: env.WORKER_TENANT_ID,
  },
  logger,
);

const queue = new WorkerTaskQueue(logger.child({ component: 'queue' }));
const timers: NodeJS.Timeout[] = [];

const supportedJobs: SupportedJob[] = [
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
    name: 'tax-filing-submission',
    intervalMs: env.WORKER_TAX_FILING_INTERVAL_MS,
    runOnStart: true,
    execute: () => runtime.runTaxFilingSubmissionJob(),
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
