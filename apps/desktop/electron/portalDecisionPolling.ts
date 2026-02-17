import type Database from 'better-sqlite3';
import { portalClient } from '../services/portalClient';
import { applyOfferDecision, listOffersPendingPortalSync } from '../db/offersRepo';
import { getSettings } from '../db/settingsRepo';

type DbProvider = () => Database.Database;

export const startPortalDecisionPolling = (params: {
  requireDb: DbProvider;
  intervalMs?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}) => {
  const intervalMs = params.intervalMs ?? 60_000;
  const logger = params.logger ?? console;

  let inFlight = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const db = params.requireDb();
      const settings = getSettings(db);
      const baseUrl = settings?.portal?.baseUrl?.trim();
      if (!baseUrl) return;

      const pending = listOffersPendingPortalSync(db);
      if (pending.length === 0) return;

      for (const o of pending) {
        try {
          const status = await portalClient.getOfferStatus(baseUrl, o.shareToken);
          const decision = status.decision;
          if (!decision) continue;

          applyOfferDecision(db, o.id, {
            decidedAt: decision.decidedAt,
            decision: decision.decision,
            acceptedName: decision.acceptedName,
            acceptedEmail: decision.acceptedEmail,
            decisionTextVersion: decision.decisionTextVersion,
          });
        } catch (e) {
          logger.warn('[portal-sync] offer status failed', { offerId: o.id, err: String(e) });
        }
      }
    } catch (e) {
      logger.error('[portal-sync] tick failed', e);
    } finally {
      inFlight = false;
    }
  };

  // fire once shortly after start to sync quickly
  void tick();
  timer = setInterval(() => void tick(), intervalMs);

  return {
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
  };
};

