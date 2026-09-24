import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../ipc/client';
import type { IpcArgs } from '../ipc/contract';

const proLedgerStatsKey = ['pro', 'ledger', 'stats'] as const;
const proLedgerAccountsKey = (args: IpcArgs<'pro:listLedgerAccounts'>) =>
  ['pro', 'ledger', 'accounts', args] as const;

export const useProLedgerStatsQuery = () => {
  return useQuery({
    queryKey: proLedgerStatsKey,
    queryFn: () => ipc.pro.getLedgerStats(),
  });
};

/** The accounting policy owns the active chart; never infer it from catalog sizes. */
export const useProActiveChart = (): 'SKR03' | 'SKR04' => {
  const { data } = useQuery({
    queryKey: ['pro-accounting', 'policy'],
    queryFn: () => ipc.pro.getAccountingPolicy(),
  });
  return data?.activeChart ?? 'SKR03';
};

export const useProLedgerAccountsQuery = (
  args: IpcArgs<'pro:listLedgerAccounts'> = {},
) => {
  return useQuery({
    queryKey: proLedgerAccountsKey(args),
    queryFn: () => ipc.pro.listLedgerAccounts(args),
  });
};

export const useImportSkrMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (args: IpcArgs<'pro:importSkr'> = {}) => ipc.pro.importSkr(args),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: proLedgerStatsKey });
      void queryClient.invalidateQueries({ queryKey: ['pro', 'ledger', 'accounts'] });
    },
  });
};
