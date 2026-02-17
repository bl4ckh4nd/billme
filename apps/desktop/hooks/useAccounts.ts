import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Account } from '../types';
import { ipc } from '../ipc/client';

const accountsKey = ['accounts'] as const;

export const useAccountsQuery = () => {
  return useQuery({
    queryKey: accountsKey,
    queryFn: () => ipc.accounts.list(),
  });
};

export const useUpsertAccountMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (account: Account) => ipc.accounts.upsert({ account }),
    onSuccess: (saved) => {
      queryClient.setQueryData(accountsKey, (prev) => {
        const prevList = Array.isArray(prev) ? prev : [];
        return [saved, ...prevList.filter((a) => a.id !== saved.id)];
      });
    },
  });
};

export const useDeleteAccountMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => ipc.accounts.delete({ id }),
    onSuccess: (_res, id) => {
      queryClient.setQueryData(accountsKey, (prev) => {
        const prevList = Array.isArray(prev) ? prev : [];
        return prevList.filter((a) => a.id !== id);
      });
    },
  });
};
