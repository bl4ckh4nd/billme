import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Invoice } from '../types';
import { ipc } from '../ipc/client';

const offersKey = ['offers'] as const;

export const useOffersQuery = () => {
  return useQuery({
    queryKey: offersKey,
    queryFn: () => ipc.offers.list(),
  });
};

export const useUpsertOfferMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { offer: Invoice; reason: string }) =>
      ipc.offers.upsert({ offer: vars.offer, reason: vars.reason }),
    onSuccess: (updated) => {
      queryClient.setQueryData(offersKey, (prev) => {
        const prevList = Array.isArray(prev) ? prev : [];
        const without = prevList.filter((i) => i.id !== updated.id);
        return [updated, ...without];
      });
    },
  });
};

export const useDeleteOfferMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; reason: string }) => ipc.offers.delete(vars),
    onSuccess: (_res, vars) => {
      queryClient.setQueryData(offersKey, (prev) => {
        const prevList = Array.isArray(prev) ? prev : [];
        return prevList.filter((i) => i.id !== vars.id);
      });
    },
  });
};
