import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Invoice } from '@billme/desktop-core/types';
import { withEffectiveInvoiceStatus } from '@billme/server-core/domain';
import { ipc } from '../runtime-api';

const invoicesKey = ['invoices'] as const;

const selectEffectiveStatus = (invoices: Invoice[]): Invoice[] =>
  invoices.map((invoice) => withEffectiveInvoiceStatus(invoice));

export const useInvoicesQuery = () => {
  return useQuery({
    queryKey: invoicesKey,
    queryFn: () => ipc.invoices.list(),
    select: selectEffectiveStatus,
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
