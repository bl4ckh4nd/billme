import type { ReactElement } from 'react';
import { AccountsView as SharedAccountsView } from '@billme/desktop-renderer/components/AccountsView';
import { BankAccountModal } from './BankAccountModal';
import { useAccountsQuery, useDeleteAccountMutation } from '../hooks/useAccounts';

export function AccountsView(): ReactElement {
  return (
    <SharedAccountsView
      useAccountsQuery={useAccountsQuery}
      useDeleteAccountMutation={useDeleteAccountMutation}
      BankAccountModal={BankAccountModal}
    />
  );
}
