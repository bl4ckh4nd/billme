import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Client } from '../types';
import { ipc } from '../ipc/client';

const clientsKey = ['clients'] as const;

export const useClientsQuery = () => {
  return useQuery({
    queryKey: clientsKey,
    queryFn: () => ipc.clients.list(),
  });
};

export const useUpsertClientMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (client: Client) => ipc.clients.upsert({ client }),
    onSuccess: (saved) => {
      queryClient.setQueryData(clientsKey, (prev) => {
        const prevList = Array.isArray(prev) ? prev : [];
        return [saved, ...prevList.filter((c) => c.id !== saved.id)];
      });
    },
  });
};

export const useDeleteClientMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => ipc.clients.delete({ id }),
    onSuccess: (_res, id) => {
      queryClient.setQueryData(clientsKey, (prev) => {
        const prevList = Array.isArray(prev) ? prev : [];
        return prevList.filter((c) => c.id !== id);
      });
    },
  });
};
