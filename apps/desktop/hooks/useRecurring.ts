import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RecurringProfile } from '../types';
import { ipc } from '../ipc/client';

const recurringKey = ['recurringProfiles'] as const;

export const useRecurringProfilesQuery = () => {
  return useQuery({
    queryKey: recurringKey,
    queryFn: () => ipc.recurring.list(),
  });
};

export const useUpsertRecurringProfileMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (profile: RecurringProfile) => ipc.recurring.upsert({ profile }),
    onSuccess: (saved) => {
      queryClient.setQueryData(recurringKey, (prev) => {
        const prevList = Array.isArray(prev) ? prev : [];
        return [saved, ...prevList.filter((p) => p.id !== saved.id)];
      });
    },
  });
};

export const useDeleteRecurringProfileMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => ipc.recurring.delete({ id }),
    onSuccess: (_res, id) => {
      queryClient.setQueryData(recurringKey, (prev) => {
        const prevList = Array.isArray(prev) ? prev : [];
        return prevList.filter((p) => p.id !== id);
      });
    },
  });
};
