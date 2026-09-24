import { useState, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { formatEmptyValue } from '@billme/ui';
import { AccountsView as SharedAccountsView } from '@billme/desktop-renderer/components/AccountsView';
import { BankAccountModal } from './BankAccountModal';
import { useAccountsQuery, useDeleteAccountMutation, useUpsertAccountMutation } from '../hooks/useAccounts';
import { useProActiveChart, useProLedgerAccountsQuery } from '../hooks/useProLedger';
import type { Account } from '../types';

export function AccountsView(): ReactElement {
  const queryClient = useQueryClient();
  const upsertAccount = useUpsertAccountMutation();
  const [mappingSaveAccountId, setMappingSaveAccountId] = useState<string | null>(null);
  const activeChart = useProActiveChart();
  const { data: ledgerAccounts = [], isError: ledgerAccountsError } = useProLedgerAccountsQuery({
    chart: activeChart,
    limit: 3000,
  });

  const saveMapping = async (account: Account, nextNumber: string, reportError: (message: string) => void) => {
    setMappingSaveAccountId(account.id);
    try {
      await upsertAccount.mutateAsync({ ...account, defaultSkrAccountNumber: nextNumber });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    } catch (error) {
      reportError(`SKR-Zuordnung konnte nicht gespeichert werden: ${String(error)}`);
    } finally {
      setMappingSaveAccountId(null);
    }
  };

  return (
    <SharedAccountsView<Account>
      useAccountsQuery={useAccountsQuery}
      useDeleteAccountMutation={useDeleteAccountMutation}
      BankAccountModal={BankAccountModal}
      renderImportAccountMeta={(account) => (
        <span className="text-sm text-muted">
          Standard-SKR <span className="font-mono text-foreground">{formatEmptyValue(account.defaultSkrAccountNumber)}</span>
        </span>
      )}
      extraColumn={{
        header: `Standard-SKR (${activeChart})`,
        render: (account, reportError) => (
          <select
            aria-label={`Standard-SKR-Konto für ${account.name}`}
            value={account.defaultSkrAccountNumber}
            disabled={ledgerAccounts.length === 0 || mappingSaveAccountId === account.id}
            onChange={(e) => void saveMapping(account, e.target.value, reportError)}
            className="px-2.5 h-8 hover:border-ink-500 rounded-control border border-control-border bg-surface text-xs font-mono tabular-nums disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            {ledgerAccounts.length === 0 ? (
              <option value={account.defaultSkrAccountNumber}>
                {ledgerAccountsError ? 'SKR-Konten nicht ladbar' : 'SKR fehlt'}
              </option>
            ) : null}
            {ledgerAccounts.map((row) => (
              <option key={`${row.chart}:${row.accountNumber}`} value={row.accountNumber}>
                {row.accountNumber}
              </option>
            ))}
          </select>
        ),
      }}
    />
  );
}
