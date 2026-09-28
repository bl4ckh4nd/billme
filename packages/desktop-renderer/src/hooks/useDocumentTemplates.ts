import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DocumentTemplateBody, DocumentTemplateRecord, TemplateKind } from '@billme/server-core/domain';
import { ipc } from '../runtime-api';

const templatesKey = ['documentTemplates'] as const;
const defaultsKey = ['documentTemplates', 'defaults'] as const;

export type DocumentTemplateDraft = { id?: string; kind: TemplateKind; name: string; body: DocumentTemplateBody };

export const useDocumentTemplatesQuery = () =>
  useQuery({
    queryKey: templatesKey,
    queryFn: async () => (await ipc.documentTemplates.list({})) as DocumentTemplateRecord[],
  });

export const useDocumentTemplateDefaultsQuery = () =>
  useQuery({
    queryKey: defaultsKey,
    queryFn: async () => (await ipc.documentTemplates.getDefaults()) as Partial<Record<TemplateKind, string | null>>,
  });

export const useUpsertDocumentTemplateMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (template: DocumentTemplateDraft) =>
      (await ipc.documentTemplates.upsert({ template })) as DocumentTemplateRecord,
    onSuccess: (saved) => {
      queryClient.setQueryData<DocumentTemplateRecord[]>(templatesKey, (previous = []) => [
        ...previous.filter((entry) => entry.id !== saved.id),
        saved,
      ]);
      // Documents render through the resolved template.
      void queryClient.invalidateQueries({ queryKey: ['documents', 'renderContext'] });
    },
  });
};

export const useDeleteDocumentTemplateMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => ipc.documentTemplates.delete({ id }),
    onSuccess: (_result, id) => {
      queryClient.setQueryData<DocumentTemplateRecord[]>(templatesKey, (previous = []) => previous.filter((entry) => entry.id !== id));
      void queryClient.invalidateQueries({ queryKey: defaultsKey });
      void queryClient.invalidateQueries({ queryKey: ['documents', 'renderContext'] });
    },
  });
};

export const useSetDefaultDocumentTemplateMutation = () => {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { kind: TemplateKind; templateId: string | null }) => ipc.documentTemplates.setDefault(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: defaultsKey });
      void queryClient.invalidateQueries({ queryKey: ['documents', 'renderContext'] });
    },
  });
};
