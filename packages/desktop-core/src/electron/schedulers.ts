export type SchedulerLogger = {
  info: (scope: string, message: string, meta?: Record<string, unknown>) => void;
  error: (scope: string, message: string, error?: Error, meta?: Record<string, unknown>) => void;
};

type SchedulerResult = {
  errors: unknown[];
};

const createIntervalRunner = <TResult extends SchedulerResult>(options: {
  scope: string;
  intervalMs?: number;
  shouldRun: () => boolean;
  run: () => Promise<TResult>;
  onScheduledResult: (result: TResult) => void | Promise<void>;
  logger: SchedulerLogger;
}) => {
  let timer: NodeJS.Timeout | null = null;
  let running = false;

  const executeScheduled = async (): Promise<void> => {
    if (running) {
      options.logger.info(options.scope, 'Already running, skipping');
      return;
    }
    running = true;
    try {
      const result = await options.run();
      await options.onScheduledResult(result);
    } catch (error) {
      options.logger.error(options.scope, 'Fatal error during scheduled run', error as Error);
    } finally {
      running = false;
    }
  };

  const checkAndRun = async (): Promise<void> => {
    if (options.shouldRun()) {
      await executeScheduled();
    }
  };

  return {
    start: () => {
      if (timer) {
        options.logger.info(options.scope, 'Already running');
        return;
      }
      const intervalMs = options.intervalMs ?? 15 * 60 * 1000;
      options.logger.info(options.scope, `Starting scheduler (checks every ${intervalMs / 60_000} minutes)`);
      void checkAndRun();
      timer = setInterval(() => void checkAndRun(), intervalMs);
    },
    stop: () => {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
      options.logger.info(options.scope, 'Stopped');
    },
    manual: async (): Promise<{ success: true; result: TResult } | { success: false; error: string }> => {
      try {
        options.logger.info(options.scope, 'Manual run triggered');
        return { success: true, result: await options.run() };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        options.logger.error(options.scope, 'Manual run failed', error as Error);
        return { success: false, error: message };
      }
    },
  };
};

export const createRecurringScheduler = <TResult extends SchedulerResult & {
  generated: number;
  deactivated: number;
}>(options: {
  shouldRun: () => boolean;
  run: () => Promise<TResult>;
  markCompleted: () => void;
  notify: (notification: { type: 'recurring'; title: string; message: string }) => void;
  logger: SchedulerLogger;
}) =>
  createIntervalRunner({
    scope: 'RecurringScheduler',
    shouldRun: options.shouldRun,
    run: options.run,
    logger: options.logger,
    onScheduledResult: (result) => {
      options.logger.info('RecurringScheduler', 'Recurring generation completed', {
        generated: result.generated,
        deactivated: result.deactivated,
        errors: result.errors.length,
      });
      if (result.generated > 0) {
        options.notify({
          type: 'recurring',
          title: 'Abo-Rechnungen erstellt',
          message: `${result.generated} Rechnung${result.generated !== 1 ? 'en' : ''} automatisch generiert`,
        });
      }
      if (result.errors.length > 0) {
        options.logger.error('RecurringScheduler', 'Errors during generation', undefined, {
          errors: result.errors,
        });
      }
      options.markCompleted();
    },
  });

export const createDunningScheduler = <TResult extends SchedulerResult & {
  processedInvoices: number;
  emailsSent: number;
  feesApplied: number;
}>(options: {
  shouldRun: () => boolean;
  run: () => Promise<TResult>;
  notify: (notification: {
    type: 'dunning' | 'email';
    title: string;
    message: string;
  }) => void;
  logger: SchedulerLogger;
}) =>
  createIntervalRunner({
    scope: 'DunningScheduler',
    shouldRun: options.shouldRun,
    run: options.run,
    logger: options.logger,
    onScheduledResult: (result) => {
      options.logger.info('DunningScheduler', 'Dunning run completed', {
        processedInvoices: result.processedInvoices,
        emailsSent: result.emailsSent,
        feesApplied: result.feesApplied,
        errors: result.errors.length,
      });
      if (result.emailsSent > 0 || result.processedInvoices > 0) {
        options.notify({
          type: 'dunning',
          title: 'Mahnlauf abgeschlossen',
          message: `${result.emailsSent} Mahnung${result.emailsSent !== 1 ? 'en' : ''} versendet, ${result.processedInvoices} Rechnung${result.processedInvoices !== 1 ? 'en' : ''} verarbeitet`,
        });
      }
      if (result.errors.length > 0) {
        options.logger.error('DunningScheduler', 'Errors during dunning run', undefined, {
          errors: result.errors,
        });
        options.notify({
          type: 'email',
          title: 'Mahnlauf: Fehler aufgetreten',
          message: `${result.errors.length} Fehler beim Mahnversand`,
        });
      }
    },
  });
