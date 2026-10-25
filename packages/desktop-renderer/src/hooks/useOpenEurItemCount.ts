import { useQuery } from '@tanstack/react-query';
import { defaultEurTaxYear } from '@billme/accounting-shared';
import { ipc } from '../runtime-api';
import { isDecidedEurItem } from '../components/eur/categories';

/**
 * Items in the EÜR workbench's "Offen" queue for its default year. Shares the
 * workbench's query key, so the count follows its invalidations after booking.
 * Pass `enabled` only for EÜR businesses; the route rejects every other profile.
 */
export const useOpenEurItemCount = (enabled: boolean): number | undefined => {
  const taxYear = defaultEurTaxYear();
  const { data } = useQuery({
    queryKey: ['eur', 'items', taxYear],
    queryFn: () => ipc.eur.listItems({ taxYear }),
    enabled,
  });
  return enabled && data ? data.filter((item) => !isDecidedEurItem(item)).length : undefined;
};
