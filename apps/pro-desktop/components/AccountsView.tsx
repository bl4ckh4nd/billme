import { useState, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Card, CardHeader, Select, formatEmptyValue } from '@billme/ui';
import { useSettingsQuery } from '@billme/desktop-renderer/hooks/useSettings';
import { AccountsView as SharedAccountsView } from '@billme/desktop-renderer/components/AccountsView';
import { BankAccountModal } from './BankAccountModal';
import { useAccountsQuery, useDeleteAccountMutation, useUpsertAccountMutation } from '../hooks/useAccounts';
import { useImportSkrMutation, useProActiveChart, useProLedgerAccountsQuery, useProLedgerStatsQuery } from '../hooks/useProLedger';
import type { Account } from '../types';

export function AccountsView(): ReactElement {
  const queryClient = useQueryClient();
  // The nav entry that opens /accounts: "Bankabgleich" for EÜR, "Konten" otherwise (DashboardLayout).
  const { data: settings } = useSettingsQuery();
  const title = settings?.businessReportingProfile?.profitDetermination === 'eur' ? 'Bankabgleich' : 'Konten';
  const upsertAccount = useUpsertAccountMutation();
  const [mappingSaveAccountId, setMappingSaveAccountId] = useState<string | null>(null);
  const activeChart = useProActiveChart();
  const { data: ledgerAccounts = [], isError: ledgerAccountsError } = useProLedgerAccountsQuery({
    chart: activeChart,
    limit: 3000,
  });
  const { data: ledgerStats, isPending: ledgerStatsLoading, isError: ledgerStatsError } = useProLedgerStatsQuery();
  const importSkr = useImportSkrMutation();
  const [importNotice, setImportNotice] = useState<string | null>(null);

  const handleImportSkr = async () => {
    try {
      const result = await importSkr.mutateAsync({ preferredSource: 'auto' });
      const warningSuffix = result.warnings.length > 0 ? ` Hinweise: ${result.warnings[0]}` : '';
      setImportNotice(`SKR-Import abgeschlossen: ${result.inserted} neu, ${result.updated} aktualisiert.${warningSuffix}`);
    } catch (error) {
      setImportNotice(`SKR-Import konnte nicht verarbeitet werden: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // A failed or still running stats query must not read as "0 Konten geladen".
  const ledgerChartText = ledgerStatsError
    ? 'SKR03 und SKR04 konnten nicht geladen werden'
    : ledgerStatsLoading
      ? 'Kontenrahmen wird geladen…'
      : `SKR03: ${ledgerStats?.byChart.SKR03 ?? 0} | SKR04: ${ledgerStats?.byChart.SKR04 ?? 0}`;

  const saveMapping = async (account: Account, nextNumber: string, reportError: (message: string) => void) => {
    setMappingSaveAccountId(account.id);
    try {
      await upsertAccount.mutateAsync({ ...account, defaultSkrAccountNumber: nextNumber });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    } catch (error) {
      reportError(`SKR-Zuordnung konnte nicht gespeichert werden: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setMappingSaveAccountId(null);
    }
  };

  return (
    <SharedAccountsView<Account>
      title={title}
      useAccountsQuery={useAccountsQuery}
      useDeleteAccountMutation={useDeleteAccountMutation}
      BankAccountModal={BankAccountModal}
      renderImportAccountMeta={(account) => (
        <span className="text-control text-muted">
          Standard-SKR <span className="font-mono text-foreground">{formatEmptyValue(account.defaultSkrAccountNumber)}</span>
        </span>
      )}
      extraColumn={{
        header: `Standard-SKR (${activeChart})`,
        render: (account, reportError) => (
          <Select
            aria-label={`Standard-SKR-Konto für ${account.name}`}
            value={account.defaultSkrAccountNumber}
            disabled={ledgerAccounts.length === 0 || mappingSaveAccountId === account.id}
            onChange={(e) => void saveMapping(account, e.target.value, reportError)}
            className="font-mono tabular-nums"
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
          </Select>
        ),
      }}
      footer={(
        <section aria-labelledby="skr-import-heading">
          <Card>
            <CardHeader
              as="h2"
              title={<span id="skr-import-heading">SKR03/04 Kontenrahmen</span>}
              subtitle="Lädt den vollständigen Kontenrahmen in die Pro-Datenbank."
              actions={
                <Button variant="secondary" size="sm" onClick={() => void handleImportSkr()} disabled={importSkr.isPending} aria-busy={importSkr.isPending}>
                  {importSkr.isPending ? 'Import läuft…' : (ledgerStats?.total ?? 0) > 0 ? 'Kontenrahmen aktualisieren' : 'SKR jetzt importieren'}
                </Button>
              }
            />
            <p className="mt-2 text-caption text-muted tabular-nums">{ledgerChartText}</p>
            {importNotice ? (
              <p role="status" className={`mt-2 text-control ${importSkr.isError ? 'text-error-text' : 'text-foreground'}`}>
                {importNotice}
              </p>
            ) : null}
          </Card>
        </section>
      )}
    />
  );
}
