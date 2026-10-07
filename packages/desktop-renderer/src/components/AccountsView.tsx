import { useEffect, useMemo, useState, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { AlertCircle, Download, History, MoreHorizontal, Plus, Trash2, Upload } from 'lucide-react';
import { useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import {
  Badge, Button, Card, ConfirmDialog, EMPTY_VALUE, EmptyState, ErrorState, HatchedProgress, IconButton, Menu, PageHeader,
  Select, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, formatEmptyValue, useActionFeedback,
} from '@billme/ui';
import { DEFAULT_EUR_TAX_YEAR, TransactionMatchingView } from './TransactionMatchingView';
import { ImportHistoryModal } from './ImportHistoryModal';
import { useDeferredDelete } from '../hooks/useDeferredDelete';
import { ipc } from '../runtime-api';

export type AccountsViewAccount = { id: string; name: string; iban?: string; balance: number };

export interface AccountsViewProps<TAccount extends AccountsViewAccount> {
  /** The label of the nav entry that opens the page. */
  title: string;
  /** The product's account hooks (`createAccountHooks`), typed to its own account model. */
  useAccountsQuery: () => UseQueryResult<TAccount[]>;
  useDeleteAccountMutation: () => UseMutationResult<unknown, Error, string>;
  BankAccountModal: ComponentType<{ isOpen: boolean; onClose: () => void }>;
  /** Extra facts beside the import account's balance (Pro: the default SKR account). */
  renderImportAccountMeta?: (account: TAccount) => ReactNode;
  /** An extra column in the account list. */
  extraColumn?: {
    header: string;
    render: (account: TAccount, reportError: (message: string) => void) => ReactNode;
  };
  /** Product-specific sections below the account list (Pro: the SKR chart import). */
  footer?: ReactNode;
}

const euro = (value: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);

const banner = 'flex items-start gap-2.5 rounded-control border px-3 py-2.5 text-control';

/** Bank matching, CSV import and the bank accounts; shared by Lite and Pro. */
export function AccountsView<TAccount extends AccountsViewAccount>({
  title,
  useAccountsQuery,
  useDeleteAccountMutation,
  BankAccountModal,
  renderImportAccountMeta,
  extraColumn,
  footer,
}: AccountsViewProps<TAccount>): ReactElement {
  const queryClient = useQueryClient();
  const [showImportHistory, setShowImportHistory] = useState(false);
  const [isBankAccountModalOpen, setIsBankAccountModalOpen] = useState(false);
  const [pageError, setPageError] = useState<string | null>(null);
  const [csvPreview, setCsvPreview] = useState<Awaited<ReturnType<typeof ipc.finance.importPreview>> | null>(null);
  const [csvCommitting, setCsvCommitting] = useState(false);
  const [selectedImportAccountId, setSelectedImportAccountId] = useState<string>('');
  const {
    data: accounts = [],
    isPending: accountsLoading,
    isError: accountsError,
    refetch: refetchAccounts,
  } = useAccountsQuery();
  const deleteAccount = useDeleteAccountMutation();
  const { notify } = useActionFeedback('accounts');
  const { pendingIds: pendingDeleteAccountIds, leavingIds: leavingAccountIds, requestDelete } = useDeferredDelete({
    scope: 'accounts',
    commit: (id: string) => deleteAccount.mutateAsync(id),
    label: (count: number) => count === 1 ? 'Konto gelöscht' : `${count} Konten gelöscht`,
  });
  const visibleAccounts = useMemo(
    () => accounts.filter((account) => !pendingDeleteAccountIds.has(account.id) || leavingAccountIds.has(account.id)),
    [accounts, pendingDeleteAccountIds, leavingAccountIds],
  );

  const { data: unmatchedTransactions = [], isError: unmatchedError } = useQuery({
    queryKey: ['transactions', { unlinkedOnly: true }],
    queryFn: () => ipc.transactions.list({ type: 'income', unlinkedOnly: true }),
  });

  // Same key and call as the matching list with "Alle anzeigen", so both follow the same invalidations.
  const { data: incomeTransactions } = useQuery({
    queryKey: ['transactions', { unlinkedOnly: false }],
    queryFn: () => ipc.transactions.list({ type: 'income', unlinkedOnly: false }),
  });

  const { data: unclassifiedEurTransactions = [], isError: unclassifiedEurError } = useQuery({
    queryKey: ['eur', 'accounts-unclassified-transactions', DEFAULT_EUR_TAX_YEAR],
    queryFn: () => ipc.eur.listItems({ taxYear: DEFAULT_EUR_TAX_YEAR, sourceType: 'transaction', status: 'unclassified' }),
  });

  const unmatchedCount = unmatchedTransactions.length;
  const unclassifiedEurCount = unclassifiedEurTransactions.length;
  const incomeCount = unmatchedError ? 0 : incomeTransactions?.length ?? 0;
  const matchedCount = Math.max(0, incomeCount - unmatchedCount);
  const unmatchedPluralSuffix = unmatchedCount !== 1 ? 'en' : '';
  const unmatchedDescription = unmatchedError
    ? 'Offene Transaktionen konnten nicht geladen werden'
    : unmatchedCount > 0
      ? `${unmatchedCount} offene Transaktion${unmatchedPluralSuffix} warten auf Zuordnung`
      : 'Alle Transaktionen zugeordnet';
  const unclassifiedEurDescription = unclassifiedEurError
    ? 'EÜR-Klassifizierung konnte nicht geladen werden'
    : unclassifiedEurCount > 0
      ? `${unclassifiedEurCount} ${unclassifiedEurCount === 1 ? 'Transaktion' : 'Transaktionen'} für EÜR offen`
      : 'Alle Transaktionen sind EÜR-klassifiziert';
  const selectedImportAccount = useMemo(
    () => visibleAccounts.find((account) => account.id === selectedImportAccountId),
    [visibleAccounts, selectedImportAccountId],
  );

  useEffect(() => {
    if (visibleAccounts.length === 0) {
      setSelectedImportAccountId('');
      return;
    }
    if (pendingDeleteAccountIds.size > 0 && !selectedImportAccountId) return;
    if (!selectedImportAccountId || !visibleAccounts.some((account) => account.id === selectedImportAccountId)) {
      setSelectedImportAccountId(visibleAccounts[0]!.id);
    }
  }, [pendingDeleteAccountIds, selectedImportAccountId, visibleAccounts]);

  const handleCsvImport = async () => {
    try {
      setPageError(null);
      if (!selectedImportAccountId) {
        setPageError('Bitte wählen Sie zuerst ein Konto für den Import aus.');
        return;
      }
      const result = await ipc.dialog.pickCsv({ title: 'CSV-Datei auswählen' });
      if (!result.path && !result.contentBase64) return;

      // Preview with bank/PayPal/Stripe format detection; nothing is written until confirmed.
      const preview = await ipc.finance.importPreview({
        path: result.path ?? undefined,
        fileName: result.fileName,
        contentBase64: result.contentBase64,
        profile: 'auto',
        accountIdForDedupHash: selectedImportAccountId,
      });
      if (preview.rows.length === 0) {
        setPageError('Die CSV-Datei enthält keine Daten');
        return;
      }
      setCsvPreview(preview);
    } catch (error) {
      console.error('CSV import failed:', error);
      setPageError(error instanceof Error ? error.message : 'CSV-Import fehlgeschlagen. Prüfe Datei und Spaltenzuordnung.');
    }
  };

  const handleCsvCommit = async () => {
    if (!csvPreview || !selectedImportAccountId || csvCommitting) return;
    setCsvCommitting(true);
    try {
      const commit = await ipc.finance.importCommit({
        path: csvPreview.path,
        accountId: selectedImportAccountId,
        profile: csvPreview.profile,
        mapping: csvPreview.suggestedMapping,
      });
      setCsvPreview(null);

      if (commit.imported > 0 || commit.skipped > 0) {
        notify('success', `Erfolgreich ${commit.imported} Transaktionen importiert${commit.skipped > 0 ? `, ${commit.skipped} übersprungen` : ''}`);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['transactions'] }),
          queryClient.invalidateQueries({ queryKey: ['accounts'] }),
          queryClient.invalidateQueries({ queryKey: ['pro-accounting', 'transactions'] }),
          queryClient.invalidateQueries({ queryKey: ['pro-accounting', 'drafts'] }),
        ]);
      }
    } catch (error) {
      console.error('CSV import failed:', error);
      setCsvPreview(null);
      setPageError('CSV-Import fehlgeschlagen. Prüfe Datei und Spaltenzuordnung.');
    } finally {
      setCsvCommitting(false);
    }
  };

  const csvProfileLabel: Record<string, string> = { fints: 'Bank (FinTS-Export)', paypal: 'PayPal', stripe: 'Stripe', generic: 'Allgemeines CSV' };

  return (
    <div className="flex flex-col gap-3.5">
      <PageHeader
        title={title}
        description="Verwalten Sie Ihre Konten und ordnen Sie Transaktionen zu."
        actions={
          <Button onClick={() => setIsBankAccountModalOpen(true)}>
            <Plus size={16} aria-hidden="true" />
            Neues Konto
          </Button>
        }
      />

      {pageError && (
        <div role="alert" className={`${banner} border-error-border bg-error-bg text-error-text`}>
          <AlertCircle size={16} className="mt-px shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">{pageError}</span>
        </div>
      )}

      {!unmatchedError && unmatchedCount > 0 && (
        <div className={`${banner} border-warning-border bg-warning-bg text-warning-text`}>
          <AlertCircle size={16} className="mt-px shrink-0" aria-hidden="true" />
          <span className="min-w-0 flex-1">
            <strong className="font-semibold">Sie haben {unmatchedCount} unzugeordnete Transaktion{unmatchedPluralSuffix}.</strong>{' '}
            Ordnen Sie Transaktionen Ihren Rechnungen zu, um den Zahlungsstatus automatisch zu aktualisieren.
          </span>
        </div>
      )}

      <Card>
        <div className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
            <div className="min-w-0">
              <h2 className="text-section text-foreground">
                {incomeCount > 0 ? `${matchedCount} von ${incomeCount} Transaktionen zugeordnet` : unmatchedDescription}
              </h2>
              <p className="text-caption text-muted">
                {incomeCount > 0 ? `${unmatchedDescription} · ${unclassifiedEurDescription}` : unclassifiedEurDescription}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={() => setShowImportHistory(true)}>
                <History size={14} aria-hidden="true" />
                Import-Historie
              </Button>
              <Button variant="secondary" size="sm" onClick={handleCsvImport}>
                <Download size={14} aria-hidden="true" />
                CSV importieren
              </Button>
            </div>
          </div>
          {incomeCount > 0 && (
            <HatchedProgress
              size="sm"
              flat
              value={matchedCount / incomeCount}
              label="Zugeordnete Transaktionen"
              valueText={`${matchedCount} von ${incomeCount} Transaktionen zugeordnet`}
            />
          )}
        </div>
      </Card>

      <TransactionMatchingView />

      <section aria-labelledby="accounts-heading">
        <Card padding="none" className="overflow-hidden">
          <div className="border-b border-border px-3.5 py-3">
            <h2 id="accounts-heading" className="text-section text-foreground">Ihre Konten</h2>
          </div>
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2 border-b border-border px-3.5 py-3">
            <Select
              id="import-account"
              label="Import-Konto"
              value={selectedImportAccountId}
              onChange={(e) => setSelectedImportAccountId(e.target.value)}
              className="min-w-56"
            >
              <option value="">Konto auswählen</option>
              {visibleAccounts.map((account) => (
                <option key={account.id} value={account.id}>{account.name}</option>
              ))}
            </Select>
            {selectedImportAccount && (
              <div className="flex min-h-8.5 flex-wrap items-center gap-x-4 gap-y-1">
                <span className="text-control text-muted">
                  Saldo <span className="font-medium text-foreground tabular-nums">{euro(selectedImportAccount.balance)}</span>
                </span>
                {renderImportAccountMeta?.(selectedImportAccount)}
              </div>
            )}
          </div>
          {accountsLoading ? (
            <p className="py-10 text-center text-control text-muted">Konten werden geladen…</p>
          ) : accountsError ? (
            <ErrorState
              title="Konten konnten nicht geladen werden"
              description="Die Liste ist deshalb leer, nicht weil keine Konten vorhanden sind."
              onRetry={() => void refetchAccounts()}
              className="m-3.5"
            />
          ) : visibleAccounts.length === 0 ? (
            <EmptyState
              title="Noch keine Konten vorhanden"
              description="Legen Sie ein Konto an, um Transaktionen zu importieren und zuzuordnen."
              action={
                <Button variant="secondary" size="sm" onClick={() => setIsBankAccountModalOpen(true)}>
                  Neues Konto anlegen
                </Button>
              }
            />
          ) : (
            <Table aria-label="Ihre Konten" bare>
              <TableHeader>
                <TableRow>
                  <TableHead>Konto</TableHead>
                  <TableHead className="hidden md:table-cell">IBAN</TableHead>
                  {extraColumn ? <TableHead>{extraColumn.header}</TableHead> : null}
                  <TableHead numeric>Saldo</TableHead>
                  <TableHead className="w-12"><span className="sr-only">Aktionen</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleAccounts.map((account) => {
                  const isImportAccount = account.id === selectedImportAccountId;
                  return (
                    <TableRow key={account.id} selected={isImportAccount} data-leaving={leavingAccountIds.has(account.id) || undefined}>
                      <TableCell>
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{account.name}</span>
                          {isImportAccount ? <Badge tone="neutral">Import-Konto</Badge> : null}
                        </span>
                      </TableCell>
                      <TableCell muted className="hidden font-mono text-caption md:table-cell">{account.iban || EMPTY_VALUE}</TableCell>
                      {extraColumn ? <TableCell>{extraColumn.render(account, setPageError)}</TableCell> : null}
                      <TableCell numeric className="font-medium">{euro(account.balance)}</TableCell>
                      <TableCell className="py-0 text-right">
                        <Menu
                          aria-label={`Aktionen für ${account.name}`}
                          align="end"
                          trigger={(props) => (
                            <IconButton {...props} size="sm" tooltip="Aktionen" aria-label={`Aktionen für ${account.name}`}>
                              <MoreHorizontal size={16} aria-hidden="true" />
                            </IconButton>
                          )}
                          items={[
                            {
                              id: 'import',
                              label: 'Als Import-Konto verwenden',
                              icon: <Upload size={14} />,
                              disabled: isImportAccount,
                              onSelect: () => setSelectedImportAccountId(account.id),
                            },
                            {
                              id: 'delete',
                              label: 'Löschen',
                              icon: <Trash2 size={14} />,
                              tone: 'danger',
                              separated: true,
                              onSelect: () => {
                                requestDelete([account.id]);
                                if (isImportAccount) setSelectedImportAccountId('');
                              },
                            },
                          ]}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </Card>
      </section>
      {footer}

      <ConfirmDialog
        open={csvPreview !== null}
        title="CSV-Import prüfen"
        description={csvPreview ? `${csvPreview.fileName} · erkannt als ${csvProfileLabel[csvPreview.profile] ?? csvPreview.profile} · ${csvPreview.stats.validRows} von ${csvPreview.stats.totalRows} Zeilen gültig${csvPreview.stats.errorRows > 0 ? `, ${csvPreview.stats.errorRows} fehlerhaft (werden übersprungen)` : ''}` : undefined}
        confirmLabel={csvPreview ? `${csvPreview.stats.validRows} Buchungen importieren` : 'Importieren'}
        busy={csvCommitting}
        onConfirm={() => void handleCsvCommit()}
        onCancel={() => setCsvPreview(null)}
        details={csvPreview ? (
          <Table aria-label="Vorschau der ersten Zeilen" density="compact" bare>
            <TableHeader>
              <TableRow><TableHead>Datum</TableHead><TableHead>Gegenpartei</TableHead><TableHead numeric>Betrag</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {csvPreview.rows.slice(0, 5).map((row) => (
                <TableRow key={row.rowIndex}>
                  <TableCell className={`tabular-nums ${row.errors.length > 0 ? 'text-error-text' : ''}`}>{formatEmptyValue(row.parsed.date)}</TableCell>
                  <TableCell className={`max-w-48 truncate ${row.errors.length > 0 ? 'text-error-text' : ''}`} title={row.parsed.counterparty}>{formatEmptyValue(row.errors[0] ?? row.parsed.counterparty)}</TableCell>
                  <TableCell numeric className={row.errors.length > 0 ? 'text-error-text' : undefined}>{row.parsed.amount === undefined ? EMPTY_VALUE : euro(row.parsed.type === 'expense' ? -Math.abs(row.parsed.amount) : row.parsed.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : undefined}
      />
      <ImportHistoryModal isOpen={showImportHistory} onClose={() => setShowImportHistory(false)} />
      <BankAccountModal isOpen={isBankAccountModalOpen} onClose={() => setIsBankAccountModalOpen(false)} />
    </div>
  );
}
