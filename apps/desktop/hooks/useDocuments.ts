import { useMutation } from '@tanstack/react-query';
import type { Invoice } from '../types';
import { ipc } from '../ipc/client';

export const useCreateDocumentFromClientMutation = () => {
  return useMutation({
    mutationFn: (vars: { kind: 'invoice' | 'offer'; clientId: string }) =>
      ipc.documents.createFromClient({ kind: vars.kind, clientId: vars.clientId }),
  });
};
