import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { ArrowLeft, Plus, Download, Link2, AlertCircle, History, Wallet } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { TransactionMatchingView } from './TransactionMatchingView';
import { ImportHistoryModal } from './ImportHistoryModal';
import { BankAccountModal } from './BankAccountModal';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../ipc/client';
import { useAccountsQuery, useDeleteAccountMutation, useUpsertAccountMutation } from '../hooks/useAccounts';
import { useProLedgerAccountsQuery, useProLedgerStatsQuery } from '../hooks/useProLedger';

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
  const [selectedImportAccountId, setSelectedImportAccountId] = useState<string>('');
  const { data: accounts = [] } = useAccountsQuery();
  const deleteAccount = useDeleteAccountMutation();
  const upsertAccount = useUpsertAccountMutation();
  const [mappingSaveAccountId, setMappingSaveAccountId] = useState<string | null>(null);
  const { data: ledgerStats } = useProLedgerStatsQuery();
  const activeChart =
    (ledgerStats?.byChart.SKR03 ?? 0) >= (ledgerStats?.byChart.SKR04 ?? 0) ? 'SKR03' : 'SKR04';
  const { data: ledgerAccounts = [] } = useProLedgerAccountsQuery({
    chart: activeChart,
    limit: 3000,
  });

  // Fetch unmatched transaction count
  const { data: unmatchedTransactions = [] } = useQuery({
    queryKey: ['transactions', { unlinkedOnly: true }],
    queryFn: async () => {
      return await ipc.transactions.list({
        type: 'income',
        unlinkedOnly: true,
      });
    },
  });

  const { data: unclassifiedEurTransactions = [] } = useQuery({
    queryKey: ['eur', 'accounts-unclassified-transactions', 2025],
    queryFn: async () => {
      return await ipc.eur.listItems({
        taxYear: 2025,
        sourceType: 'transaction',
        status: 'unclassified',
      });
    },
  });

  const unmatchedCount = unmatchedTransactions.length;
  const unclassifiedEurCount = unclassifiedEurTransactions.length;
  const unmatchedPluralSuffix = unmatchedCount !== 1 ? 'en' : '';
  const unmatchedDescription = unmatchedCount > 0
    ? `${unmatchedCount} offene Transaktion${unmatchedPluralSuffix} warten auf Zuordnung`
    : 'Alle Transaktionen zugeordnet';
  const unmatchedWarningText = `Sie haben ${unmatchedCount} unzugeordnete Transaktion${unmatchedPluralSuffix}`;
  const selectedImportAccount = useMemo(
    () => accounts.find((account) => account.id === selectedImportAccountId),
    [accounts, selectedImportAccountId],
  );

  useEffect(() => {
    if (accounts.length === 0) {
      setSelectedImportAccountId('');
      return;
    }
    if (!selectedImportAccountId || !accounts.some((account) => account.id === selectedImportAccountId)) {
      setSelectedImportAccountId(accounts[0]!.id);
    }
  }, [accounts, selectedImportAccountId]);

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

      // Step 2: Preview import
      const preview = await ipc.finance.importPreview({
        path: result.path,
        profile: 'generic',
        accountIdForDedupHash: selectedImportAccountId,
      });

      if (preview.rows.length === 0) {
        setCsvImportError('Die CSV-Datei enthält keine Daten');
        return;
      }

      // Step 3: Commit import
      const commit = await ipc.finance.importCommit({
        path: result.path,
        accountId: selectedImportAccountId,
        profile: 'generic',
        mapping: preview.suggestedMapping,
      });

      if (commit.imported > 0 || commit.skipped > 0) {
        alert(`Erfolgreich ${commit.imported} Transaktionen importiert${commit.skipped > 0 ? `, ${commit.skipped} übersprungen` : ''}`);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ['transactions'] }),
          queryClient.invalidateQueries({ queryKey: ['accounts'] }),
        ]);
      }
    } catch (error) {
      console.error('CSV import failed:', error);
      setCsvImportError('Import fehlgeschlagen. Bitte versuchen Sie es später erneut.');
    }
  };

  if (viewMode === 'matching') {
    return (
      <TransactionMatchingView
        onBack={() => setViewMode('accounts')}
        initialTab={matchingEntryTab}
      />
    );
  }

  return (
    <div className="bg-surface rounded-xl p-8 min-h-full shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate({ to: '/finance' })}
            className="p-2 hover:bg-canvas rounded-lg transition-colors duration-150 ease-out"
          >
            <ArrowLeft size={20} />
          </button>
          <div>
            <h2 className="text-2xl font-black text-foreground">Konten & Transaktionen</h2>
            <p className="text-sm text-muted mt-1">
              Verwalten Sie Ihre Konten und ordnen Sie Transaktionen zu.
            </p>
          </div>
        </div>

        <button
          onClick={() => setIsBankAccountModalOpen(true)}
          className="flex items-center gap-2 px-4 py-2 bg-foreground text-accent hover:bg-dark-1 rounded-full font-bold text-sm transition-colors duration-200 ease-out"
        >
          <Plus size={18} />
          Neues Konto
        </button>
      </div>

      {/* Action Cards */}
      <div className="mb-6 rounded-xl border border-border bg-surface-muted p-4">
        <label className="text-[11px] font-bold uppercase tracking-wide text-muted">Import-Konto</label>
        <div className="mt-2 flex items-center gap-3">
          <select
            value={selectedImportAccountId}
            onChange={(e) => setSelectedImportAccountId(e.target.value)}
            className="flex-1 rounded-lg border border-border bg-surface px-3 py-2 text-sm font-medium"
          >
            <option value="">Konto auswählen</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
          {selectedImportAccount && (
            <>
              <div className="rounded-lg bg-surface px-3 py-2 text-xs tabular-nums text-muted border border-border">
                Saldo: {new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(selectedImportAccount.balance)}
              </div>
              <div className="rounded-lg bg-surface px-3 py-2 text-xs font-mono text-muted border border-border">
                Standard SKR: {selectedImportAccount.defaultSkrAccountNumber || '-'}
              </div>
            </>
          )}
        </div>
      </div>

      {/* Action Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6 mb-8">
        {/* Transaction Matching Card */}
        <button
          onClick={() => {
            setMatchingEntryTab('matching');
            setViewMode('matching');
          }}
          className="text-left p-6 rounded-xl border-2 border-info bg-info-bg hover:bg-info-bg/80 transition-colors duration-200 ease-out relative overflow-hidden"
        >
          {unmatchedCount > 0 && (
            <div className="absolute top-4 right-4">
              <div className="flex items-center justify-center w-8 h-8 rounded-full bg-error text-white text-xs font-bold">
                {unmatchedCount}
              </div>
            </div>
          )}
          <div className="w-12 h-12 rounded-lg bg-info text-white flex items-center justify-center mb-4">
            <Link2 size={22} />
          </div>
          <div className="text-lg font-black text-foreground mb-2">Transaktionen zuordnen</div>
          <div className="text-sm text-muted">
            {unmatchedDescription}
          </div>
        </button>

        {/* Inline EÜR Classification Card */}
        <button
          onClick={() => {
            setMatchingEntryTab('eur');
            setViewMode('matching');
          }}
          className="text-left p-6 rounded-xl border border-border bg-surface-muted hover:bg-canvas transition-colors duration-200 ease-out relative overflow-hidden"
        >
          {unclassifiedEurCount > 0 && (
            <div className="absolute top-4 right-4">
              <div className="flex items-center justify-center w-8 h-8 rounded-full bg-warning text-white text-xs font-bold">
                {unclassifiedEurCount}
              </div>
            </div>
          )}
          <div className="w-12 h-12 rounded-lg bg-foreground text-accent flex items-center justify-center mb-4">
            <Link2 size={22} />
          </div>
          <div className="text-lg font-black text-foreground mb-2">EÜR direkt klassifizieren</div>
          <div className="text-sm text-muted">
            {unclassifiedEurCount > 0
              ? `${unclassifiedEurCount} Transaktionen für EÜR offen`
              : 'Alle Transaktionen sind EÜR-klassifiziert'}
          </div>
        </button>

        {/* CSV Import Card */}
        <button
          onClick={handleCsvImport}
          className="text-left p-6 rounded-xl border border-border bg-surface-muted hover:bg-canvas transition-colors duration-200 ease-out"
        >
          <div className="w-12 h-12 rounded-lg bg-dark-3 text-white flex items-center justify-center mb-4">
            <Download size={22} />
          </div>
          <div className="text-lg font-black text-foreground mb-2">CSV importieren</div>
          <div className="text-sm text-muted">
            Importieren Sie Transaktionen aus Ihrer Bank
          </div>
        </button>

        {/* Import History Card */}
        <button
          onClick={() => setShowImportHistory(true)}
          className="text-left p-6 rounded-xl border border-border bg-surface-muted hover:bg-canvas transition-colors duration-200 ease-out"
        >
          <div className="w-12 h-12 rounded-lg bg-dark-1 text-white flex items-center justify-center mb-4">
            <History size={22} />
          </div>
          <div className="text-lg font-black text-foreground mb-2">Import-Historie</div>
          <div className="text-sm text-muted">
            Vergangene Importe einsehen und rückgängig machen
          </div>
        </button>

        {/* Accounts Overview Card */}
        <button
          onClick={() => navigate({ to: '/finance' })}
          className="text-left p-6 rounded-xl border border-border bg-surface-muted hover:bg-canvas transition-colors duration-200 ease-out"
        >
          <div className="w-12 h-12 rounded-lg bg-dark-3 text-white flex items-center justify-center mb-4">
            <Plus size={22} />
          </div>
          <div className="text-lg font-black text-foreground mb-2">Konten verwalten</div>
          <div className="text-sm text-muted">Erstellen und bearbeiten Sie Ihre Konten</div>
        </button>
      </div>

      {/* CSV Import Error Banner */}
      {csvImportError && (
        <div className="bg-error-bg border border-error/30 rounded-xl p-4 flex items-start gap-3 mb-8">
          <AlertCircle size={20} className="text-error flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-error">{csvImportError}</p>
          </div>
        </div>
      )}

      {/* Info Banner */}
      {unmatchedCount > 0 && (
        <div className="bg-warning-bg border border-warning-border rounded-xl p-4 flex items-start gap-3">
          <AlertCircle size={20} className="text-warning flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-foreground">
              {unmatchedWarningText}
            </p>
            <p className="text-sm text-muted mt-1">
              Ordnen Sie Transaktionen Ihren Rechnungen zu, um den Zahlungsstatus automatisch zu aktualisieren.
            </p>
          </div>
        </div>
      )}

      {/* Accounts List Placeholder */}
      <div className="mt-8">
        <h3 className="text-lg font-bold text-foreground mb-4">Ihre Konten</h3>
        {accounts.length === 0 ? (
          <div className="text-center py-12 px-4 rounded-xl border border-dashed border-border bg-surface-muted text-muted">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-lg bg-surface text-foreground border border-border">
              <Wallet size={20} />
            </div>
            <p className="text-sm font-bold text-foreground">Noch keine Konten vorhanden.</p>
            <p className="mt-1 text-sm">Legen Sie ein neues Konto an, um CSV-Importe und Zahlungsabgleich zu nutzen.</p>
            <button
              type="button"
              onClick={() => setIsBankAccountModalOpen(true)}
              className="mt-4 inline-flex items-center gap-2 rounded-full bg-foreground px-4 py-2 text-sm font-bold text-accent transition-colors duration-200 ease-out hover:bg-dark-1"
            >
              <Plus size={16} />
              Neues Konto
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {accounts.map((account) => (
              <div key={account.id} className="rounded-xl border border-border bg-surface-muted p-4 flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-foreground">{account.name}</p>
                  <p className="text-xs font-mono text-muted">{account.iban || 'Keine IBAN'}</p>
                  <p className="text-xs text-muted mt-1">
                    Standard SKR ({activeChart}): {account.defaultSkrAccountNumber}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <select
                    value={account.defaultSkrAccountNumber}
                    disabled={ledgerAccounts.length === 0 || mappingSaveAccountId === account.id}
                    onChange={async (e) => {
                      const nextNumber = e.target.value;
                      setCsvImportError(null);
                      setMappingSaveAccountId(account.id);
                      try {
                        await upsertAccount.mutateAsync({
                          ...account,
                          defaultSkrAccountNumber: nextNumber,
                        });
                        await queryClient.invalidateQueries({ queryKey: ['accounts'] });
                      } catch (error) {
                        setCsvImportError(`SKR-Zuordnung konnte nicht gespeichert werden: ${String(error)}`);
                      } finally {
                        setMappingSaveAccountId(null);
                      }
                    }}
                    className="px-3 py-1.5 rounded-lg text-xs font-mono bg-surface border border-border disabled:opacity-50"
                  >
                    {ledgerAccounts.length === 0 ? (
                      <option value={account.defaultSkrAccountNumber}>
                        SKR fehlt
                      </option>
                    ) : null}
                    {ledgerAccounts.map((row) => (
                      <option key={`${row.chart}:${row.accountNumber}`} value={row.accountNumber}>
                        {row.accountNumber}
                      </option>
                    ))}
                  </select>
                  <p className="text-sm tabular-nums font-bold text-foreground">
                    {new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(account.balance)}
                  </p>
                  <button
                    className="px-3 py-1.5 rounded-lg text-xs font-bold bg-surface border border-border hover:bg-canvas transition-colors duration-150 ease-out"
                    onClick={() => {
                      setSelectedImportAccountId(account.id);
                    }}
                  >
                    Für Import
                  </button>
                  <button
                    className="px-3 py-1.5 rounded-lg text-xs font-bold bg-error-bg text-error border border-error/30 hover:bg-error hover:text-white transition-colors duration-150 ease-out"
                    onClick={async () => {
                      if (!confirm(`Konto "${account.name}" wirklich löschen?`)) return;
                      try {
                        await deleteAccount.mutateAsync(account.id);
                        if (selectedImportAccountId === account.id) {
                          setSelectedImportAccountId('');
                        }
                      } catch (error) {
                        setCsvImportError(`Konto konnte nicht gelöscht werden: ${String(error)}`);
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
