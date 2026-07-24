import { createDunningScheduler } from '@billme/desktop-core/electron/schedulers';
import { getDb } from '../db/connection';
import { getSettings } from '../db/settingsRepo';
import { processDunningRun, shouldRunScheduledDunning } from '../services/dunningService';
import { logger } from '../utils/logger';
import { pushNotification } from './notifications';
import { secrets } from './secrets';

const scheduler = createDunningScheduler({
  shouldRun: () => {
    try {
      return shouldRunScheduledDunning(getSettings(getDb()));
    } catch (error) {
      logger.error('DunningScheduler', 'Error checking if should run', error as Error);
      return false;
    }
  },
  run: () => processDunningRun(getDb(), secrets),
  notify: pushNotification,
  logger,
});

export const startDunningScheduler = scheduler.start;
export const stopDunningScheduler = scheduler.stop;
export const manualDunningRun = scheduler.manual;
