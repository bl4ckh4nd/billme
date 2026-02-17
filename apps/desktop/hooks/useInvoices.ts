import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Invoice } from '../types';
import { ipc } from '../ipc/client';

const invoicesKey = ['invoices'] as const;

export const useInvoicesQuery = () => {
  return useQuery({
    queryKey: invoicesKey,
    queryFn: () => ipc.invoices.list(),
  });
};

export const useCreateInvoiceMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { invoice: Invoice; reason: string }) =>
      ipc.invoices.upsert({ invoice: vars.invoice, reason: vars.reason }),
    onSuccess: (created) => {
      queryClient.setQueryData(invoicesKey, (prev) => {
        const prevList = Array.isArray(prev) ? prev : [];
        return [created, ...prevList.filter((i) => i.id !== created.id)];
      });
    },
  });
};

export const useUpsertInvoiceMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { invoice: Invoice; reason: string }) =>
      ipc.invoices.upsert({ invoice: vars.invoice, reason: vars.reason }),
    onSuccess: (updated) => {
      queryClient.setQueryData(invoicesKey, (prev) => {
        const prevList = Array.isArray(prev) ? prev : [];
        const without = prevList.filter((i) => i.id !== updated.id);
        return [updated, ...without];
      });
    },
  });
};

export const useDeleteInvoiceMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; reason: string }) => ipc.invoices.delete(vars),
    onSuccess: (_res, vars) => {
      queryClient.setQueryData(invoicesKey, (prev) => {
        const prevList = Array.isArray(prev) ? prev : [];
        return prevList.filter((i) => i.id !== vars.id);
      });
    },
  });
};
