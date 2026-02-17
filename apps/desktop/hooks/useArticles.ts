import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Article } from '../types';
import { ipc } from '../ipc/client';

const articlesKey = ['articles'] as const;

export const useArticlesQuery = () => {
  return useQuery({
    queryKey: articlesKey,
    queryFn: () => ipc.articles.list(),
  });
};

export const useUpsertArticleMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (article: Article) => ipc.articles.upsert({ article }),
    onSuccess: (saved) => {
      queryClient.setQueryData(articlesKey, (prev) => {
        const prevList = Array.isArray(prev) ? prev : [];
        return [saved, ...prevList.filter((a) => a.id !== saved.id)];
      });
    },
  });
};

export const useDeleteArticleMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => ipc.articles.delete({ id }),
    onSuccess: (_res, id) => {
      queryClient.setQueryData(articlesKey, (prev) => {
        const prevList = Array.isArray(prev) ? prev : [];
        return prevList.filter((a) => a.id !== id);
      });
    },
  });
};
