import { useMutation } from '@tanstack/react-query';
import type { Invoice } from '@billme/desktop-core/types';
import { ipc } from '../runtime-api';

export const useCreateDocumentFromClientMutation = () => {
  return useMutation({
    mutationFn: (vars: { kind: 'invoice' | 'offer'; clientId: string }) =>
      ipc.documents.createFromClient({ kind: vars.kind, clientId: vars.clientId }),
  });
};
