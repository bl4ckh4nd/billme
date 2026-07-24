import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

type AccountApi<TAccount extends { id: string }> = {
  accounts: {
    list: () => Promise<TAccount[]>;
    upsert: (args: { account: TAccount }) => Promise<TAccount>;
    delete: (args: { id: string }) => Promise<unknown>;
  };
};

const accountsKey = ['accounts'] as const;

export const createAccountHooks = <TAccount extends { id: string }>(ipc: AccountApi<TAccount>) => {
  const useAccountsQuery = () =>
    useQuery({
      queryKey: accountsKey,
      queryFn: () => ipc.accounts.list(),
    });

  const useUpsertAccountMutation = () => {
    const queryClient = useQueryClient();
    return useMutation({
      mutationFn: (account: TAccount) => ipc.accounts.upsert({ account }),
      onSuccess: (saved) => {
        queryClient.setQueryData<TAccount[]>(accountsKey, (prev = []) => [
          saved,
          ...prev.filter((account) => account.id !== saved.id),
        ]);
      },
    });
  };

  const useDeleteAccountMutation = () => {
    const queryClient = useQueryClient();
    return useMutation({
      mutationFn: (id: string) => ipc.accounts.delete({ id }),
      onSuccess: (_result, id) => {
        queryClient.setQueryData<TAccount[]>(accountsKey, (prev = []) =>
          prev.filter((account) => account.id !== id),
        );
      },
    });
  };

  return {
    useAccountsQuery,
    useUpsertAccountMutation,
    useDeleteAccountMutation,
  };
};
