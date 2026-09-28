import { useQuery } from '@tanstack/react-query';
import { LATEST_SUPPORTED_EUR_TAX_YEAR } from '@billme/accounting-shared';
import { ipc } from '../runtime-api';

/**
 * Items in the EÜR workbench's "Offen" queue for its default year. Shares the
 * workbench's query key, so the count follows its invalidations after booking.
 * Pass `enabled` only for EÜR businesses; the route rejects every other profile.
 */
export const useOpenEurItemCount = (enabled: boolean): number | undefined => {
  const { data } = useQuery({
    queryKey: ['eur', 'items', LATEST_SUPPORTED_EUR_TAX_YEAR],
    queryFn: () => ipc.eur.listItems({ taxYear: LATEST_SUPPORTED_EUR_TAX_YEAR }),
    enabled,
  });
  return enabled && data ? data.filter((item) => !item.classification?.eurLineId && !item.classification?.excluded).length : undefined;
};
