import { useMutation, useQuery } from '@tanstack/react-query';
import type { Invoice } from '@billme/desktop-core/types';
import { ipc } from '../runtime-api';

export const useCreateDocumentFromClientMutation = () => {
  return useMutation({
    mutationFn: (vars: { kind: 'invoice' | 'offer'; clientId: string }) =>
      ipc.documents.createFromClient({ kind: vars.kind, clientId: vars.clientId }),
  });
};

/** Everything the printed document needs: document, resolved template, company data. */
export const useDocumentRenderContextQuery = (kind: 'invoice' | 'offer' | 'dunning', id: string, level?: number) => {
  return useQuery({
    queryKey: ['documents', 'renderContext', kind, id, level],
    queryFn: () => ipc.documents.renderContext({ kind, id, level }),
    retry: false,
  });
};
