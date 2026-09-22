import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { ArrowLeft, Plus, Download, Link2, AlertCircle, History } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { DEFAULT_EUR_TAX_YEAR, TransactionMatchingView } from './TransactionMatchingView';
import { ImportHistoryModal } from './ImportHistoryModal';
import { BankAccountModal } from './BankAccountModal';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../ipc/client';
import { useAccountsQuery, useDeleteAccountMutation } from '../hooks/useAccounts';
import { useDeferredDelete } from '@billme/desktop-renderer/hooks/useDeferredDelete';
import {
  Button,
  ConfirmDialog,
  EMPTY_VALUE,
  EmptyState,
  ErrorState,
  formatEmptyValue,
  useActionFeedback,
} from '@billme/ui';

type ViewMode = 'accounts' | 'matching';
type MatchingEntryTab = 'matching' | 'eur';

export function AccountsView(): ReactElement {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [viewMode, setViewMode] = useState<ViewMode>('accounts');
  const [matchingEntryTab, setMatchingEntryTab] = useState<MatchingEntryTab>('matching');
  const [showImportHistory, setShowImportHistory] = useState(false);
  const [isBankAccountModalOpen, setIsBankAccountModalOpen] = useState(false);
  const [csvImportError, setCsvImportError] = useState<string | null>(null);
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
  const { pendingIds: pendingDeleteAccountIds, requestDelete } = useDeferredDelete({
    scope: 'accounts',
    commit: (id: string) => deleteAccount.mutateAsync(id),
    label: (count: number) => count === 1 ? 'Konto gelöscht' : `${count} Konten gelöscht`,
  });
  const visibleAccounts = useMemo(
    () => accounts.filter((account) => !pendingDeleteAccountIds.has(account.id)),
    [accounts, pendingDeleteAccountIds],
  );

  // Fetch unmatched transaction count
  const { data: unmatchedTransactions = [], isError: unmatchedError } = useQuery({
    queryKey: ['transactions', { unlinkedOnly: true }],
    queryFn: async () => {
      return await ipc.transactions.list({
        type: 'income',
        unlinkedOnly: true,
      });
    },
  });

  const { data: unclassifiedEurTransactions = [], isError: unclassifiedEurError } = useQuery({
    queryKey: ['eur', 'accounts-unclassified-transactions', DEFAULT_EUR_TAX_YEAR],
    queryFn: async () => {
      return await ipc.eur.listItems({
        taxYear: DEFAULT_EUR_TAX_YEAR,
        sourceType: 'transaction',
        status: 'unclassified',
      });
    },
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
      ? `${unclassifiedEurCount} Transaktionen für EÜR offen`
      : 'Alle Transaktionen sind EÜR-klassifiziert';
  const unmatchedWarningText = `Sie haben ${unmatchedCount} unzugeordnete Transaktion${unmatchedPluralSuffix}`;
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
      setCsvImportError(null);
      if (!selectedImportAccountId) {
        setCsvImportError('Bitte wählen Sie zuerst ein Konto für den Import aus.');
        return;
      }

      // Step 1: Pick CSV file
      const result = await ipc.dialog.pickCsv({
        title: 'CSV-Datei auswählen'
      });

      if (!result.path) return; // User cancelled

      // Step 2: Preview import with bank/PayPal/Stripe format detection
      const preview = await ipc.finance.importPreview({
        path: result.path,
        profile: 'auto',
        accountIdForDedupHash: selectedImportAccountId,
      });

      if (preview.rows.length === 0) {
        setCsvImportError('Die CSV-Datei enthält keine Daten');
        return;
      }

      // Step 3: the user confirms the preview before anything is written
      setCsvPreview(preview);
    } catch (error) {
      console.error('CSV import failed:', error);
      setCsvImportError('CSV-Import fehlgeschlagen. Prüfe Datei und Spaltenzuordnung.');
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
      setCsvImportError('CSV-Import fehlgeschlagen. Prüfe Datei und Spaltenzuordnung.');
    } finally {
      setCsvCommitting(false);
    }
  };

  const csvProfileLabel: Record<string, string> = { fints: 'Bank (FinTS-Export)', paypal: 'PayPal', stripe: 'Stripe', generic: 'Allgemeines CSV' };

  if (viewMode === 'matching') {
    return (
      <TransactionMatchingView
        onBack={() => setViewMode('accounts')}
        initialTab={matchingEntryTab}
      />
    );
  }

  return (
    <div className="bg-surface rounded-2xl p-8 min-h-full shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate({ to: '/finance' })}
            aria-label="Zurück zu Finanzen"
            className="rounded-lg p-2 text-muted transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            <ArrowLeft size={20} aria-hidden="true" />
          </button>
          <div>
            <h2 className="text-2xl font-black text-foreground">Konten & Transaktionen</h2>
            <p className="text-sm text-muted mt-1">
              Verwalten Sie Ihre Konten und ordnen Sie Transaktionen zu.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setIsBankAccountModalOpen(true)}
          className="flex items-center gap-2 rounded-full bg-dark-base px-4 py-2 text-sm font-bold text-background transition-colors hover:bg-dark-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring-dark"
        >
          <Plus size={18} aria-hidden="true" />
          Neues Konto
        </button>
      </div>

      {/* Action Cards */}
      <div className="mb-6 rounded-xl border border-border bg-surface-muted p-4">
        <label htmlFor="import-account" className="text-xs font-bold uppercase tracking-wide text-muted">Import-Konto</label>
        <div className="mt-2 flex items-center gap-3">
          <select
            id="import-account"
            value={selectedImportAccountId}
            onChange={(e) => setSelectedImportAccountId(e.target.value)}
            className="flex-1 rounded-xl border border-control-border bg-surface px-3 py-2 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            <option value="">Konto auswählen</option>
            {visibleAccounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
          {selectedImportAccount && (
            <div className="rounded-xl border border-border bg-surface px-3 py-2 text-xs text-muted tabular-nums">
              Saldo: {new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(selectedImportAccount.balance)}
            </div>
          )}
        </div>
      </div>

      {/* Action Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6 mb-8">
        {/* Transaction Matching Card */}
        <button
          type="button"
          onClick={() => {
            setMatchingEntryTab('matching');
            setViewMode('matching');
          }}
          className="relative overflow-hidden rounded-xl border border-info-border bg-info-bg p-6 text-left transition-colors hover:bg-info-bg/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          {!unmatchedError && unmatchedCount > 0 && (
            <div className="absolute right-4 top-4">
              <div className="flex h-8 min-w-8 items-center justify-center rounded-full border border-error-border bg-error-bg px-2 text-xs font-bold text-error-text tabular-nums">
                {unmatchedCount}
              </div>
            </div>
          )}
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-info text-background">
            <Link2 size={22} aria-hidden="true" />
          </div>
          <div className="mb-2 text-lg font-black text-foreground">Transaktionen zuordnen</div>
          <div className="text-sm text-muted">
            {unmatchedDescription}
          </div>
        </button>

        {/* Inline EÜR Classification Card */}
        <button
          type="button"
          onClick={() => {
            setMatchingEntryTab('eur');
            setViewMode('matching');
          }}
          className="relative overflow-hidden rounded-xl border border-border bg-surface p-6 text-left transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          {!unclassifiedEurError && unclassifiedEurCount > 0 && (
            <div className="absolute right-4 top-4">
              <div className="flex h-8 min-w-8 items-center justify-center rounded-full border border-warning-border bg-warning-bg px-2 text-xs font-bold text-warning-text tabular-nums">
                {unclassifiedEurCount}
              </div>
            </div>
          )}
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-dark-base text-background">
            <Link2 size={22} aria-hidden="true" />
          </div>
          <div className="mb-2 text-lg font-black text-foreground">EÜR direkt klassifizieren</div>
          <div className="text-sm text-muted">
            {unclassifiedEurDescription}
          </div>
        </button>

        {/* CSV Import Card */}
        <button
          type="button"
          onClick={handleCsvImport}
          className="rounded-xl border border-border bg-surface p-6 text-left transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-dark-1 text-background">
            <Download size={22} aria-hidden="true" />
          </div>
          <div className="mb-2 text-lg font-black text-foreground">CSV importieren</div>
          <div className="text-sm text-muted">
            Importieren Sie Transaktionen aus Ihrer Bank
          </div>
        </button>

        {/* Import History Card */}
        <button
          type="button"
          onClick={() => setShowImportHistory(true)}
          className="rounded-xl border border-border bg-surface p-6 text-left transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-dark-1 text-background">
            <History size={22} aria-hidden="true" />
          </div>
          <div className="mb-2 text-lg font-black text-foreground">Import-Historie</div>
          <div className="text-sm text-muted">
            Vergangene Importe einsehen und rückgängig machen
          </div>
        </button>

        {/* Accounts Overview Card */}
        <button
          type="button"
          onClick={() => setIsBankAccountModalOpen(true)}
          className="rounded-xl border border-border bg-surface p-6 text-left transition-colors hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-dark-1 text-background">
            <Plus size={22} aria-hidden="true" />
          </div>
          <div className="mb-2 text-lg font-black text-foreground">Konten verwalten</div>
          <div className="text-sm text-muted">Erstellen und bearbeiten Sie Ihre Konten</div>
        </button>
      </div>

      {/* CSV Import Error Banner */}
      <ConfirmDialog
        open={csvPreview !== null}
        title="CSV-Import prüfen"
        description={csvPreview ? `${csvPreview.fileName} · erkannt als ${csvProfileLabel[csvPreview.profile] ?? csvPreview.profile} · ${csvPreview.stats.validRows} von ${csvPreview.stats.totalRows} Zeilen gültig${csvPreview.stats.errorRows > 0 ? `, ${csvPreview.stats.errorRows} fehlerhaft (werden übersprungen)` : ''}` : undefined}
        confirmLabel={csvPreview ? `${csvPreview.stats.validRows} Buchungen importieren` : 'Importieren'}
        busy={csvCommitting}
        onConfirm={() => void handleCsvCommit()}
        onCancel={() => setCsvPreview(null)}
        details={csvPreview ? (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-muted"><th className="py-1 pr-2">Datum</th><th className="py-1 pr-2">Gegenpartei</th><th className="py-1 text-right">Betrag</th></tr>
            </thead>
            <tbody>
              {csvPreview.rows.slice(0, 5).map((row) => (
                <tr key={row.rowIndex} className={row.errors.length > 0 ? 'text-error-text' : ''}>
                  <td className="py-1 pr-2 tabular-nums">{formatEmptyValue(row.parsed.date)}</td>
                  <td className="py-1 pr-2 truncate max-w-48" title={row.parsed.counterparty}>{formatEmptyValue(row.errors[0] ?? row.parsed.counterparty)}</td>
                  <td className="py-1 text-right tabular-nums">{row.parsed.amount === undefined ? EMPTY_VALUE : new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(row.parsed.type === 'expense' ? -Math.abs(row.parsed.amount) : row.parsed.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : undefined}
      />
      {csvImportError && (
        <div role="alert" className="mb-8 flex items-start gap-3 rounded-xl border border-error-border bg-error-bg p-4">
          <AlertCircle size={20} className="text-error-text flex-shrink-0 mt-0.5" aria-hidden="true" />
          <p className="text-sm font-medium text-error-text">{csvImportError}</p>
        </div>
      )}

      {/* Info Banner */}
      {!unmatchedError && unmatchedCount > 0 && (
        <div className="flex items-start gap-3 rounded-xl border border-warning-border bg-warning-bg p-4">
          <AlertCircle size={20} className="text-warning-text flex-shrink-0 mt-0.5" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold text-warning-text">
              {unmatchedWarningText}
            </p>
            <p className="text-sm text-warning-text mt-1">
              Ordnen Sie Transaktionen Ihren Rechnungen zu, um den Zahlungsstatus automatisch zu aktualisieren.
            </p>
          </div>
        </div>
      )}

      {/* Accounts List Placeholder */}
      <div className="mt-8">
        <h3 className="text-lg font-bold text-foreground mb-4">Ihre Konten</h3>
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
          <div className="space-y-3">
            {visibleAccounts.map((account) => (
              <div key={account.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-muted p-4">
                <div>
                  <p className="text-sm font-bold text-foreground">{account.name}</p>
                  <p className="text-xs font-mono text-muted">{account.iban || EMPTY_VALUE}</p>
                </div>
                <div className="flex items-center gap-3">
                  <p className="text-sm font-bold text-foreground tabular-nums">
                    {new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(account.balance)}
                  </p>
                  <button
                    type="button"
                    className="rounded-lg border border-control-border bg-surface px-3 py-1.5 text-xs font-bold text-foreground hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    onClick={() => {
                      setSelectedImportAccountId(account.id);
                    }}
                  >
                    Für Import
                  </button>
                  <button
                    type="button"
                    className="rounded-lg border border-error-border bg-error-bg px-3 py-1.5 text-xs font-bold text-error-text hover:bg-error hover:text-background focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
                    onClick={() => {
                      requestDelete([account.id]);
                      if (selectedImportAccountId === account.id) {
                        setSelectedImportAccountId('');
                      }
                    }}
                  >
                    Löschen
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Import History Modal */}
      <ImportHistoryModal
        isOpen={showImportHistory}
        onClose={() => setShowImportHistory(false)}
      />

      {/* Bank Account Modal */}
      <BankAccountModal
        isOpen={isBankAccountModalOpen}
        onClose={() => setIsBankAccountModalOpen(false)}
      />
    </div>
  );
}
