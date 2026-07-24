import { startPortalDecisionPolling as startSharedPolling } from '@billme/desktop-core/electron/portalPolling';
import { getSettings } from '../db/settingsRepo';
import { syncPublishedOfferDecisionsFromPortal } from '../db/offersRepo';
import { portalClient } from '../services/portalClient';
import { pushNotification } from './notifications';

export const startPortalDecisionPolling = (
  options: Pick<Parameters<typeof startSharedPolling>[0], 'requireDb' | 'intervalMs' | 'logger'>,
) => startSharedPolling({
  ...options,
  resolveBaseUrl: (db) => getSettings(db)?.portal?.baseUrl,
  getOfferStatus: (baseUrl, shareToken) => portalClient.getOfferStatus(baseUrl, shareToken),
  syncDecisions: syncPublishedOfferDecisionsFromPortal,
  notify: pushNotification,
});
