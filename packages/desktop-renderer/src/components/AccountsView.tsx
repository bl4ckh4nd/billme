import { useEffect, useMemo, useState, type ComponentType, type ReactElement, type ReactNode } from 'react';
import { AlertCircle, Download, History, Link2, MoreHorizontal, Plus, Trash2, Upload } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient, type UseMutationResult, type UseQueryResult } from '@tanstack/react-query';
import {
  Button, ConfirmDialog, EMPTY_VALUE, EmptyState, ErrorState, IconButton, Menu, PageHeader,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, formatEmptyValue, useActionFeedback,
} from '@billme/ui';
import { DEFAULT_EUR_TAX_YEAR, TransactionMatchingView } from './TransactionMatchingView';
import { ImportHistoryModal } from './ImportHistoryModal';
import { useDeferredDelete } from '../hooks/useDeferredDelete';
import { ipc } from '../runtime-api';

type ViewMode = 'accounts' | 'matching';
type MatchingEntryTab = 'matching' | 'eur';

export type AccountsViewAccount = { id: string; name: string; iban?: string; balance: number };

export interface AccountsViewProps<TAccount extends AccountsViewAccount> {
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
}

const euro = (value: number) => new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(value);

const actionCard =
  'relative overflow-hidden rounded-card bg-surface p-5 text-left shadow-xs transition-shadow hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

/** Bank accounts, CSV import and the entry into matching; shared by Lite and Pro. */
export function AccountsView<TAccount extends AccountsViewAccount>({
  useAccountsQuery,
  useDeleteAccountMutation,
  BankAccountModal,
  renderImportAccountMeta,
  extraColumn,
}: AccountsViewProps<TAccount>): ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [viewMode, setViewMode] = useState<ViewMode>('accounts');
  const [matchingEntryTab, setMatchingEntryTab] = useState<MatchingEntryTab>('matching');
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

  const { data: unclassifiedEurTransactions = [], isError: unclassifiedEurError } = useQuery({
    queryKey: ['eur', 'accounts-unclassified-transactions', DEFAULT_EUR_TAX_YEAR],
    queryFn: () => ipc.eur.listItems({ taxYear: DEFAULT_EUR_TAX_YEAR, sourceType: 'transaction', status: 'unclassified' }),
  });

  const unmatchedCount = unmatchedTransactions.length;
  const unclassifiedEurCount = unclassifiedEurTransactions.length;
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
      if (!result.path) return; // User cancelled

      // Preview with bank/PayPal/Stripe format detection; nothing is written until confirmed.
      const preview = await ipc.finance.importPreview({
        path: result.path,
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
      setPageError('CSV-Import fehlgeschlagen. Prüfe Datei und Spaltenzuordnung.');
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

  if (viewMode === 'matching') {
    return <TransactionMatchingView onBack={() => setViewMode('accounts')} initialTab={matchingEntryTab} />;
  }

  return (
    <div className="bg-surface rounded-panel p-6 lg:p-8 min-h-full shadow-xs">
      <PageHeader
        title="Konten & Transaktionen"
        description="Verwalten Sie Ihre Konten und ordnen Sie Transaktionen zu."
        back={{ label: 'Zurück zu Finanzen', onClick: () => navigate({ to: '/finance' }) }}
        actions={
          <Button onClick={() => setIsBankAccountModalOpen(true)}>
            <Plus size={16} aria-hidden="true" />
            Neues Konto
          </Button>
        }
      />

      <div className="mb-6 rounded-card bg-surface-muted p-4">
        <label htmlFor="import-account" className="text-label text-foreground">Import-Konto</label>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          <select
            id="import-account"
            value={selectedImportAccountId}
            onChange={(e) => setSelectedImportAccountId(e.target.value)}
            className="px-2.5 h-8 hover:border-ink-500 min-w-56 flex-1 rounded-control border border-control-border bg-surface text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            <option value="">Konto auswählen</option>
            {visibleAccounts.map((account) => (
              <option key={account.id} value={account.id}>{account.name}</option>
            ))}
          </select>
          {selectedImportAccount && (
            <>
              <span className="text-sm text-muted">
                Saldo <span className="font-medium text-foreground tabular-nums">{euro(selectedImportAccount.balance)}</span>
              </span>
              {renderImportAccountMeta?.(selectedImportAccount)}
            </>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-3 mb-8">
        <button
          type="button"
          onClick={() => {
            setMatchingEntryTab('matching');
            setViewMode('matching');
          }}
          className={actionCard}
        >
          {!unmatchedError && unmatchedCount > 0 && (
            <div className="absolute right-4 top-4">
              <div className="flex h-8 min-w-8 items-center justify-center rounded-full border border-error-border bg-error-bg px-2 text-xs font-semibold text-error-text tabular-nums">
                {unmatchedCount}
              </div>
            </div>
          )}
          <div className="mb-4 flex size-9 items-center justify-center rounded-control bg-surface-sunken text-foreground">
            <Link2 size={16} aria-hidden="true" />
          </div>
          <div className="mb-1 text-section text-foreground">Transaktionen zuordnen</div>
          <div className="text-sm text-muted">{unmatchedDescription}</div>
        </button>

        <button
          type="button"
          onClick={() => {
            setMatchingEntryTab('eur');
            setViewMode('matching');
          }}
          className={actionCard}
        >
          {!unclassifiedEurError && unclassifiedEurCount > 0 && (
            <div className="absolute right-4 top-4">
              <div className="flex h-8 min-w-8 items-center justify-center rounded-full border border-warning-border bg-warning-bg px-2 text-xs font-semibold text-warning-text tabular-nums">
                {unclassifiedEurCount}
              </div>
            </div>
          )}
          <div className="mb-4 flex size-9 items-center justify-center rounded-control bg-surface-sunken text-foreground">
            <Link2 size={16} aria-hidden="true" />
          </div>
          <div className="mb-1 text-section text-foreground">EÜR direkt klassifizieren</div>
          <div className="text-sm text-muted">{unclassifiedEurDescription}</div>
        </button>

        <button type="button" onClick={handleCsvImport} className={actionCard}>
          <div className="mb-4 flex size-9 items-center justify-center rounded-control bg-surface-sunken text-foreground">
            <Download size={16} aria-hidden="true" />
          </div>
          <div className="mb-1 text-section text-foreground">CSV importieren</div>
          <div className="text-sm text-muted">Importieren Sie Transaktionen aus Ihrer Bank</div>
        </button>

        <button type="button" onClick={() => setShowImportHistory(true)} className={actionCard}>
          <div className="mb-4 flex size-9 items-center justify-center rounded-control bg-surface-sunken text-foreground">
            <History size={16} aria-hidden="true" />
          </div>
          <div className="mb-1 text-section text-foreground">Import-Historie</div>
          <div className="text-sm text-muted">Vergangene Importe einsehen und rückgängig machen</div>
        </button>

        <button type="button" onClick={() => setIsBankAccountModalOpen(true)} className={actionCard}>
          <div className="mb-4 flex size-9 items-center justify-center rounded-control bg-surface-sunken text-foreground">
            <Plus size={16} aria-hidden="true" />
          </div>
          <div className="mb-1 text-section text-foreground">Konten verwalten</div>
          <div className="text-sm text-muted">Erstellen und bearbeiten Sie Ihre Konten</div>
        </button>
      </div>

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
      {pageError && (
        <div role="alert" className="mb-8 flex items-start gap-3 rounded-card border border-error-border bg-error-bg p-4">
          <AlertCircle size={20} className="text-error-text flex-shrink-0 mt-0.5" aria-hidden="true" />
          <p className="text-sm font-medium text-error-text">{pageError}</p>
        </div>
      )}

      {!unmatchedError && unmatchedCount > 0 && (
        <div className="flex items-start gap-3 rounded-card border border-warning-border bg-warning-bg p-4">
          <AlertCircle size={20} className="text-warning-text flex-shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-warning-text">
              Sie haben {unmatchedCount} unzugeordnete Transaktion{unmatchedPluralSuffix}
            </p>
            <p className="text-sm text-warning-text mt-1">
              Ordnen Sie Transaktionen Ihren Rechnungen zu, um den Zahlungsstatus automatisch zu aktualisieren.
            </p>
          </div>
        </div>
      )}

      <section className="mt-8" aria-labelledby="accounts-heading">
        <h3 id="accounts-heading" className="text-section text-foreground mb-4">Ihre Konten</h3>
        {accountsLoading ? (
          <p className="py-12 text-center text-sm text-muted">Konten werden geladen…</p>
        ) : accountsError ? (
          <ErrorState
            title="Konten konnten nicht geladen werden"
            description="Die Liste ist deshalb leer, nicht weil keine Konten vorhanden sind."
            onRetry={() => void refetchAccounts()}
          />
        ) : visibleAccounts.length === 0 ? (
          <EmptyState
            title="Noch keine Konten vorhanden"
            description="Legen Sie ein Konto an, um Transaktionen zu importieren und zuzuordnen."
            action={
              <Button variant="dark" size="sm" onClick={() => setIsBankAccountModalOpen(true)}>
                Neues Konto anlegen
              </Button>
            }
          />
        ) : (
          <Table aria-label="Ihre Konten">
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
                      <div className="font-medium">{account.name}</div>
                      {isImportAccount ? <div className="text-caption text-muted">Import-Konto</div> : null}
                    </TableCell>
                    <TableCell muted className="hidden font-mono text-xs md:table-cell">{account.iban || EMPTY_VALUE}</TableCell>
                    {extraColumn ? <TableCell>{extraColumn.render(account, setPageError)}</TableCell> : null}
                    <TableCell numeric className="font-medium">{euro(account.balance)}</TableCell>
                    <TableCell className="text-right">
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
      </section>

      <ImportHistoryModal isOpen={showImportHistory} onClose={() => setShowImportHistory(false)} />
      <BankAccountModal isOpen={isBankAccountModalOpen} onClose={() => setIsBankAccountModalOpen(false)} />
    </div>
  );
}
