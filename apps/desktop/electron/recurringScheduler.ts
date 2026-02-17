import { getDb } from '../db/connection';
import { getSettings, setSettings } from '../db/settingsRepo';
import { processRecurringRun, RecurringResult } from '../services/recurringService';
import { logger } from '../utils/logger';

let schedulerInterval: NodeJS.Timeout | null = null;
let isRunning = false;

/**
 * Check if it's time to run recurring invoice generation
 */
const shouldRunRecurring = (): boolean => {
  try {
    const db = getDb();
    const settings = getSettings(db);

    if (!settings || !settings.automation.recurringEnabled) {
      return false;
    }

    const now = new Date();
    const [targetHour, targetMinute] = settings.automation.recurringRunTime
      .split(':')
      .map(Number);

    // Check if we're at the target time (within 15-minute window)
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();

    const isTargetTime =
      currentHour === targetHour &&
      currentMinute >= targetMinute &&
      currentMinute < targetMinute + 15;

    if (!isTargetTime) {
      return false;
    }

    // Check if we already ran today
    const lastRun = settings.automation.lastRecurringRun;
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
    logger.error('RecurringScheduler', 'Error checking if should run', error as Error);
    return false;
  }
};

/**
 * Execute recurring invoice generation
 */
const executeRecurringRun = async (): Promise<void> => {
  if (isRunning) {
    logger.info('RecurringScheduler', 'Already running, skipping');
    return;
  }

  isRunning = true;

  try {
    logger.info('RecurringScheduler', 'Starting recurring invoice generation');
    const db = getDb();
    const settings = getSettings(db);

    if (!settings) {
      throw new Error('Settings not found');
    }

    const result = await processRecurringRun(db, settings);

    logger.info('RecurringScheduler', 'Recurring generation completed', {
      generated: result.generated,
      deactivated: result.deactivated,
      errors: result.errors.length,
    });

    if (result.errors.length > 0) {
      logger.error('RecurringScheduler', 'Errors during generation', undefined, {
        errors: result.errors,
      });
    }

    // Update last run timestamp
    const updatedSettings = {
      ...settings,
      automation: {
        ...settings.automation,
        lastRecurringRun: new Date().toISOString(),
      },
    };
    setSettings(db, updatedSettings);
  } catch (error) {
    logger.error('RecurringScheduler', 'Fatal error during recurring generation', error as Error);
  } finally {
    isRunning = false;
  }
};

/**
 * Check and run if needed
 */
const checkAndRun = async (): Promise<void> => {
  if (shouldRunRecurring()) {
    await executeRecurringRun();
  }
};

/**
 * Start the recurring invoice scheduler
 * Checks every 15 minutes if it's time to run
 */
export const startRecurringScheduler = (): void => {
  if (schedulerInterval) {
    logger.info('RecurringScheduler', 'Already running');
    return;
  }

  logger.info('RecurringScheduler', 'Starting scheduler (checks every 15 minutes)');

  // Check immediately on start
  void checkAndRun();

  // Then check every 15 minutes
  schedulerInterval = setInterval(() => {
    void checkAndRun();
  }, 15 * 60 * 1000);
};

/**
 * Stop the recurring scheduler
 */
export const stopRecurringScheduler = (): void => {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    logger.info('RecurringScheduler', 'Stopped');
  }
};

/**
 * Manually trigger recurring generation (for testing or manual execution)
 */
export const manualRecurringRun = async (): Promise<{
  success: boolean;
  result?: RecurringResult;
  error?: string;
}> => {
  try {
    logger.info('RecurringScheduler', 'Manual run triggered');
    const db = getDb();
    const settings = getSettings(db);

    if (!settings) {
      throw new Error('Settings not found');
    }

    const result = await processRecurringRun(db, settings);
    return { success: true, result };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('RecurringScheduler', 'Manual run failed', error as Error);
    return { success: false, error: errorMessage };
  }
};
