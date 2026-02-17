import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentTemplate, DocumentTemplateKind } from '../types';
import { ipc } from '../ipc/client';

const templatesKey = (kind?: DocumentTemplateKind) => ['templates', kind ?? 'all'] as const;
const activeTemplateKey = (kind: DocumentTemplateKind) => ['templates', 'active', kind] as const;

export const useTemplatesQuery = (kind?: DocumentTemplateKind) => {
  return useQuery({
    queryKey: templatesKey(kind),
    queryFn: () => ipc.templates.list({ kind }),
  });
};

export const useActiveTemplateQuery = (kind: DocumentTemplateKind) => {
  return useQuery({
    queryKey: activeTemplateKey(kind),
    queryFn: () => ipc.templates.active({ kind }),
  });
};

export const useUpsertTemplateMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (template: DocumentTemplate) => ipc.templates.upsert({ template }),
    onSuccess: (saved) => {
      queryClient.setQueryData(templatesKey(saved.kind), (prev) => {
        const prevList = Array.isArray(prev) ? (prev as DocumentTemplate[]) : [];
        return [saved, ...prevList.filter((t) => t.id !== saved.id)];
      });
      queryClient.invalidateQueries({ queryKey: templatesKey('all' as any) });
      queryClient.setQueryData(activeTemplateKey(saved.kind), (prev) => {
        if (!prev) return prev;
        // If current active points to same id, refresh it.
        const prevTemplate = prev as DocumentTemplate;
        return prevTemplate.id === saved.id ? saved : prev;
      });
    },
  });
};

export const useDeleteTemplateMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => ipc.templates.delete({ id }),
    onSuccess: (_res, id) => {
      // Best-effort: drop from any cached list.
      queryClient.invalidateQueries({ queryKey: ['templates'] });
      // Active template might have been cleared.
      queryClient.invalidateQueries({ queryKey: ['templates', 'active'] });
    },
  });
};

export const useSetActiveTemplateMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { kind: DocumentTemplateKind; templateId: string | null }) =>
      ipc.templates.setActive({ kind: vars.kind, templateId: vars.templateId }),
    onSuccess: (_res, vars) => {
      queryClient.invalidateQueries({ queryKey: activeTemplateKey(vars.kind) });
    },
  });
};
