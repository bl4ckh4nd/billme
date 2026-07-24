import type { Account } from '@billme/desktop-core/types';
import { ipc } from '../ipc/client';
import { createAccountHooks } from '@billme/desktop-renderer/hooks/createAccountHooks';

export const {
  useAccountsQuery,
  useUpsertAccountMutation,
  useDeleteAccountMutation,
} = createAccountHooks<Account>(ipc);
