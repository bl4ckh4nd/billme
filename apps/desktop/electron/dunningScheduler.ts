import { getDb } from '../db/connection';
import { getSettings } from '../db/settingsRepo';
import { processDunningRun } from '../services/dunningService';
import { secrets } from './secrets';
import { logger } from '../utils/logger';

let schedulerInterval: NodeJS.Timeout | null = null;
let isRunning = false;

/**
 * Check if it's time to run dunning based on settings
 */
const shouldRunDunning = (): boolean => {
  try {
    const db = getDb();
    const settings = getSettings(db);

    if (!settings || !settings.automation.dunningEnabled) {
      return false;
    }

    const now = new Date();
    const [targetHour, targetMinute] = settings.automation.dunningRunTime.split(':').map(Number);

    // Check if we're at the target time (within 15-minute window)
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    const isTargetTime =
      currentHour === targetHour && currentMinute >= targetMinute && currentMinute < targetMinute + 15;

    if (!isTargetTime) {
      return false;
    }

    // Check if we already ran today
    const lastRun = settings.automation.lastDunningRun;
    if (lastRun) {
      const lastRunDate = new Date(lastRun);
      const isSameDay =
        lastRunDate.getFullYear() === now.getFullYear() &&
        lastRunDate.getMonth() === now.getMonth() &&
        lastRunDate.getDate() === now.getDate();

      if (isSameDay) {
        return false; // Already ran today
      }
    }

    return true;
  } catch (error) {
    logger.error('DunningScheduler', 'Error checking if should run', error as Error);
    return false;
  }
};

/**
 * Execute dunning run
 */
const executeDunningRun = async (): Promise<void> => {
  if (isRunning) {
    logger.info('DunningScheduler', 'Already running, skipping');
    return;
  }

  isRunning = true;

  try {
    logger.info('DunningScheduler', 'Starting dunning run');
    const db = getDb();
    const result = await processDunningRun(db, secrets);

    logger.info('DunningScheduler', 'Dunning run completed', {
      processedInvoices: result.processedInvoices,
      emailsSent: result.emailsSent,
      feesApplied: result.feesApplied,
      errors: result.errors.length,
    });

    if (result.errors.length > 0) {
      logger.error('DunningScheduler', 'Errors during dunning run', undefined, { errors: result.errors });
    }
  } catch (error) {
    logger.error('DunningScheduler', 'Fatal error during dunning run', error as Error);
  } finally {
    isRunning = false;
  }
};

/**
 * Check and run dunning if needed
 */
const checkAndRun = async (): Promise<void> => {
  if (shouldRunDunning()) {
    await executeDunningRun();
  }
};

/**
 * Start the dunning scheduler
 * Checks every 15 minutes if it's time to run
 */
export const startDunningScheduler = (): void => {
  if (schedulerInterval) {
    logger.info('DunningScheduler', 'Already running');
    return;
  }

  logger.info('DunningScheduler', 'Starting scheduler (checks every 15 minutes)');

  // Check immediately on start
  void checkAndRun();

  // Then check every 15 minutes
  schedulerInterval = setInterval(() => {
    void checkAndRun();
  }, 15 * 60 * 1000); // 15 minutes
};

/**
 * Stop the dunning scheduler
 */
export const stopDunningScheduler = (): void => {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    logger.info('DunningScheduler', 'Stopped');
  }
};

/**
 * Manually trigger a dunning run (for testing or manual execution)
 */
export const manualDunningRun = async (): Promise<{
  success: boolean;
  result?: {
    processedInvoices: number;
    emailsSent: number;
    feesApplied: number;
    errors: Array<{ invoiceNumber: string; error: string }>;
  };
  error?: string;
}> => {
  try {
    logger.info('DunningScheduler', 'Manual run triggered');
    const db = getDb();
    const result = await processDunningRun(db, secrets);
    return { success: true, result };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('DunningScheduler', 'Manual run failed', error as Error);
    return { success: false, error: errorMessage };
  }
};
