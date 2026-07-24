import { createRecurringScheduler } from '@billme/desktop-core/electron/schedulers';
import { getDb } from '../db/connection';
import { getSettings, setLastRecurringRun } from '../db/settingsRepo';
import { processRecurringRun, shouldRunScheduledRecurring } from '../services/recurringService';
import { logger } from '../utils/logger';
import { pushNotification } from './notifications';

const scheduler = createRecurringScheduler({
  shouldRun: () => {
    try {
      return shouldRunScheduledRecurring(getSettings(getDb()));
    } catch (error) {
      logger.error('RecurringScheduler', 'Error checking if should run', error as Error);
      return false;
    }
  },
  run: async () => {
    const db = getDb();
    const settings = getSettings(db);
    if (!settings) throw new Error('Settings not found');
    return processRecurringRun(db, settings);
  },
  markCompleted: () => setLastRecurringRun(getDb(), new Date().toISOString()),
  notify: pushNotification,
  logger,
});

export const startRecurringScheduler = scheduler.start;
export const stopRecurringScheduler = scheduler.stop;
export const manualRecurringRun = scheduler.manual;
