import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { ArrowLeft, Plus, Download, Link2, AlertCircle, History } from 'lucide-react';
import { useNavigate } from '@tanstack/react-router';
import { TransactionMatchingView } from './TransactionMatchingView';
import { ImportHistoryModal } from './ImportHistoryModal';
import { BankAccountModal } from './BankAccountModal';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../ipc/client';
import { useAccountsQuery, useDeleteAccountMutation } from '../hooks/useAccounts';

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
    <div className="bg-white rounded-[2.5rem] p-8 min-h-full shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate({ to: '/finance' })}
            className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
          >
            <ArrowLeft size={20} />
          </button>
          <div>
            <h2 className="text-2xl font-black text-gray-900">Konten & Transaktionen</h2>
            <p className="text-sm text-gray-500 mt-1">
              Verwalten Sie Ihre Konten und ordnen Sie Transaktionen zu.
            </p>
          </div>
        </div>

        <button
          onClick={() => setIsBankAccountModalOpen(true)}
          className="flex items-center gap-2 px-4 py-2 bg-black text-accent hover:bg-gray-900 rounded-full font-bold text-sm transition-colors"
        >
          <Plus size={18} />
          Neues Konto
        </button>
      </div>

      {/* Action Cards */}
      <div className="mb-6 rounded-2xl border border-gray-200 bg-gray-50 p-4">
        <label className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Import-Konto</label>
        <div className="mt-2 flex items-center gap-3">
          <select
            value={selectedImportAccountId}
            onChange={(e) => setSelectedImportAccountId(e.target.value)}
            className="flex-1 rounded-xl border border-gray-200 bg-white px-3 py-2 text-sm font-medium"
          >
            <option value="">Konto auswählen</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </select>
          {selectedImportAccount && (
            <div className="rounded-xl bg-white px-3 py-2 text-xs font-mono text-gray-600 border border-gray-200">
              Saldo: {new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(selectedImportAccount.balance)}
            </div>
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
          className="text-left p-6 rounded-3xl border-2 border-info bg-info-bg hover:bg-info-bg/80 transition-all border-info relative overflow-hidden"
        >
          {unmatchedCount > 0 && (
            <div className="absolute top-4 right-4">
              <div className="flex items-center justify-center w-8 h-8 rounded-full bg-error text-white text-xs font-bold">
                {unmatchedCount}
              </div>
            </div>
          )}
          <div className="w-12 h-12 rounded-2xl bg-info text-white flex items-center justify-center mb-4">
            <Link2 size={22} />
          </div>
          <div className="text-lg font-black text-gray-900 mb-2">Transaktionen zuordnen</div>
          <div className="text-sm text-gray-600">
            {unmatchedDescription}
          </div>
        </button>

        {/* Inline EÜR Classification Card */}
        <button
          onClick={() => {
            setMatchingEntryTab('eur');
            setViewMode('matching');
          }}
          className="text-left p-6 rounded-3xl border border-gray-200 bg-gray-50 hover:bg-gray-100 transition-all relative overflow-hidden"
        >
          {unclassifiedEurCount > 0 && (
            <div className="absolute top-4 right-4">
              <div className="flex items-center justify-center w-8 h-8 rounded-full bg-amber-500 text-white text-xs font-bold">
                {unclassifiedEurCount}
              </div>
            </div>
          )}
          <div className="w-12 h-12 rounded-2xl bg-black text-accent flex items-center justify-center mb-4">
            <Link2 size={22} />
          </div>
          <div className="text-lg font-black text-gray-900 mb-2">EÜR direkt klassifizieren</div>
          <div className="text-sm text-gray-600">
            {unclassifiedEurCount > 0
              ? `${unclassifiedEurCount} Transaktionen für EÜR offen`
              : 'Alle Transaktionen sind EÜR-klassifiziert'}
          </div>
        </button>

        {/* CSV Import Card */}
        <button
          onClick={handleCsvImport}
          className="text-left p-6 rounded-3xl border border-gray-200 bg-gray-50 hover:bg-gray-100 transition-all"
        >
          <div className="w-12 h-12 rounded-2xl bg-gray-700 text-white flex items-center justify-center mb-4">
            <Download size={22} />
          </div>
          <div className="text-lg font-black text-gray-900 mb-2">CSV importieren</div>
          <div className="text-sm text-gray-600">
            Importieren Sie Transaktionen aus Ihrer Bank
          </div>
        </button>

        {/* Import History Card */}
        <button
          onClick={() => setShowImportHistory(true)}
          className="text-left p-6 rounded-3xl border border-gray-200 bg-gray-50 hover:bg-gray-100 transition-all"
        >
          <div className="w-12 h-12 rounded-2xl bg-dark-1 text-white flex items-center justify-center mb-4">
            <History size={22} />
          </div>
          <div className="text-lg font-black text-gray-900 mb-2">Import-Historie</div>
          <div className="text-sm text-gray-600">
            Vergangene Importe einsehen und rückgängig machen
          </div>
        </button>

        {/* Accounts Overview Card */}
        <button
          onClick={() => navigate({ to: '/finance' })}
          className="text-left p-6 rounded-3xl border border-gray-200 bg-gray-50 hover:bg-gray-100 transition-all"
        >
          <div className="w-12 h-12 rounded-2xl bg-gray-700 text-white flex items-center justify-center mb-4">
            <Plus size={22} />
          </div>
          <div className="text-lg font-black text-gray-900 mb-2">Konten verwalten</div>
          <div className="text-sm text-gray-600">Erstellen und bearbeiten Sie Ihre Konten</div>
        </button>
      </div>

      {/* CSV Import Error Banner */}
      {csvImportError && (
        <div className="bg-error-bg border border-error/30 rounded-2xl p-4 flex items-start gap-3 mb-8">
          <AlertCircle size={20} className="text-error flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-error">{csvImportError}</p>
          </div>
        </div>
      )}

      {/* Info Banner */}
      {unmatchedCount > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4 flex items-start gap-3">
          <AlertCircle size={20} className="text-amber-600 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-medium text-amber-900">
              {unmatchedWarningText}
            </p>
            <p className="text-sm text-amber-700 mt-1">
              Ordnen Sie Transaktionen Ihren Rechnungen zu, um den Zahlungsstatus automatisch zu aktualisieren.
            </p>
          </div>
        </div>
      )}

      {/* Accounts List Placeholder */}
      <div className="mt-8">
        <h3 className="text-lg font-bold text-gray-900 mb-4">Ihre Konten</h3>
        {accounts.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <p className="text-sm">Noch keine Konten vorhanden. Legen Sie ein neues Konto an.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {accounts.map((account) => (
              <div key={account.id} className="rounded-2xl border border-gray-200 bg-gray-50 p-4 flex items-center justify-between">
                <div>
                  <p className="text-sm font-bold text-gray-900">{account.name}</p>
                  <p className="text-xs font-mono text-gray-500">{account.iban || 'Keine IBAN'}</p>
                </div>
                <div className="flex items-center gap-3">
                  <p className="text-sm font-mono font-bold text-gray-800">
                    {new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(account.balance)}
                  </p>
                  <button
                    className="px-3 py-1.5 rounded-lg text-xs font-bold bg-white border border-gray-200 hover:bg-gray-100"
                    onClick={() => {
                      setSelectedImportAccountId(account.id);
                    }}
                  >
                    Für Import
                  </button>
                  <button
                    className="px-3 py-1.5 rounded-lg text-xs font-bold bg-error-bg text-error border border-error/30 hover:bg-error hover:text-white"
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
