import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Project } from '../types';
import { ipc } from '../ipc/client';

export const projectsKey = (args?: { clientId?: string; includeArchived?: boolean }) =>
  ['projects', args?.clientId ?? null, Boolean(args?.includeArchived)] as const;

export const useProjectsQuery = (args?: { clientId?: string; includeArchived?: boolean }) => {
  return useQuery({
    queryKey: projectsKey(args),
    queryFn: () => ipc.projects.list({ clientId: args?.clientId, includeArchived: args?.includeArchived }),
  });
};

export const useUpsertProjectMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { project: Project; reason: string }) => ipc.projects.upsert(vars),
    onSuccess: (saved) => {
      // Update any cached list that might contain this project.
      queryClient.setQueriesData({ queryKey: ['projects'] }, (prev) => {
        const prevList = Array.isArray(prev) ? (prev as Project[]) : [];
        const without = prevList.filter((p) => p.id !== saved.id);
        return [saved, ...without];
      });
      // Also update clients cache, because client detail pages derive projects from clients:list.
      queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });
};

export const useArchiveProjectMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; reason: string }) => ipc.projects.archive(vars),
    onSuccess: (_archived) => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });
};

