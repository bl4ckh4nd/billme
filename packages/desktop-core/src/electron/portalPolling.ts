type PortalDecision = {
  decision: 'accepted' | 'rejected';
  acceptedName?: string;
};

export const startPortalDecisionPolling = <TDatabase, TStatus, TOffer>(options: {
  requireDb: () => TDatabase;
  resolveBaseUrl: (db: TDatabase) => string | undefined;
  getOfferStatus: (baseUrl: string, shareToken: string) => Promise<TStatus>;
  syncDecisions: (
    db: TDatabase,
    options: {
      portalGateway: { getOfferStatus: (shareToken: string) => Promise<TStatus> };
      logger: Pick<Console, 'warn' | 'error'>;
      onDecisionApplied: (offer: TOffer, decision: PortalDecision) => void;
    },
  ) => Promise<unknown>;
  notify: (notification: { type: 'portal'; title: string; message: string }) => void;
  intervalMs?: number;
  logger?: Pick<Console, 'warn' | 'error'>;
}) => {
  const logger = options.logger ?? console;
  let inFlight = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (inFlight) return;
    inFlight = true;
    try {
      const db = options.requireDb();
      const baseUrl = options.resolveBaseUrl(db)?.trim();
      if (!baseUrl) return;
      await options.syncDecisions(db, {
        portalGateway: {
          getOfferStatus: (shareToken) => options.getOfferStatus(baseUrl, shareToken),
        },
        logger,
        onDecisionApplied: (_offer, decision) => {
          const accepted = decision.decision === 'accepted';
          options.notify({
            type: 'portal',
            title: accepted ? 'Angebot angenommen' : 'Angebot abgelehnt',
            message: `Ein Angebot wurde ${accepted ? 'vom Kunden angenommen' : 'abgelehnt'}${decision.acceptedName ? ` (${decision.acceptedName})` : ''}`,
          });
        },
      });
    } catch (error) {
      logger.error('[portal-sync] tick failed', error);
    } finally {
      inFlight = false;
    }
  };

  void tick();
  timer = setInterval(() => void tick(), options.intervalMs ?? 60_000);
  return {
    tick,
    stop: () => {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
};
