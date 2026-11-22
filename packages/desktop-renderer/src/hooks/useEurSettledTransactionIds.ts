import { useQueries } from '@tanstack/react-query';
import { eurTaxYearOptions } from '@billme/accounting-shared';
import { ipc } from '../runtime-api';
import { isNeutralEurKind } from '../components/eur/categories';

/**
 * Bank lines that "Buchen" has settled as no business income: Privateinlage/-entnahme, Geldtransit
 * or excluded. No invoice will ever pay them, so the Bankabgleich does not count them as waiting.
 * A line with an income Kennziffer stays: it may still be an invoice payment that is not linked yet.
 * Shares the workbench's query keys, so it follows its invalidations after booking.
 * Pass `enabled` only for EÜR businesses; the route rejects every other profile.
 */
export const useEurSettledTransactionIds = (enabled: boolean): ReadonlySet<string> => {
  const results = useQueries({
    queries: eurTaxYearOptions().map((taxYear) => ({
      queryKey: ['eur', 'items', taxYear],
      queryFn: () => ipc.eur.listItems({ taxYear }),
      enabled,
    })),
  });
  const ids = new Set<string>();
  if (!enabled) return ids;
  for (const result of results) {
    for (const item of result.data ?? []) {
      // Pro lists the bank_transactions mirror as sourceId; transactionId is the line the Bankabgleich shows.
      if (item.sourceType === 'transaction' && (isNeutralEurKind(item.kind) || item.classification?.excluded)) ids.add(item.transactionId ?? item.sourceId);
    }
  }
  return ids;
};
