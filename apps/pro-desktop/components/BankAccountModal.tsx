import { useEffect, useState } from 'react';
import { X, Building2 } from 'lucide-react';
import { ipc } from '../ipc/client';
import { useQueryClient } from '@tanstack/react-query';
import { v4 as uuidv4 } from 'uuid';
import { useProLedgerAccountsQuery, useProLedgerStatsQuery } from '../hooks/useProLedger';

interface BankAccountModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const BankAccountModal = ({ isOpen, onClose }: BankAccountModalProps) => {
  const queryClient = useQueryClient();
  const { data: ledgerStats } = useProLedgerStatsQuery();
  const activeChart =
    (ledgerStats?.byChart.SKR03 ?? 0) >= (ledgerStats?.byChart.SKR04 ?? 0) ? 'SKR03' : 'SKR04';
  const { data: ledgerAccounts = [] } = useProLedgerAccountsQuery({
    chart: activeChart,
    limit: 3000,
  });
  const [formData, setFormData] = useState({
    name: '',
    iban: '',
    balance: '0',
    defaultSkrAccountNumber: '',
  });
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!formData.defaultSkrAccountNumber && ledgerAccounts.length > 0) {
      setFormData((prev) => ({
        ...prev,
        defaultSkrAccountNumber: prev.defaultSkrAccountNumber || ledgerAccounts[0]!.accountNumber,
      }));
    }
  }, [formData.defaultSkrAccountNumber, ledgerAccounts]);

  const handleSave = async () => {
    if (!formData.name.trim()) {
      setError('Kontoname ist erforderlich');
      return;
    }
    if (!formData.defaultSkrAccountNumber) {
      setError('Bitte wählen Sie ein Standard-SKR-Konto.');
      return;
    }

    setError(null);
    setIsSaving(true);
    try {
      await ipc.accounts.upsert({
        account: {
          id: uuidv4(),
          name: formData.name,
          iban: formData.iban || '',
          balance: parseFloat(formData.balance) || 0,
          defaultSkrAccountNumber: formData.defaultSkrAccountNumber,
          type: 'bank',
          color: '#4B5563',
          transactions: [],
        }
      });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      onClose();
      setFormData({ name: '', iban: '', balance: '0', defaultSkrAccountNumber: '' });
    } catch (error) {
      console.error('Failed to create account:', error);
      setError('Fehler beim Erstellen des Kontos');
    } finally {
      setIsSaving(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/50">
      <div className="bg-surface rounded-xl shadow-2xl w-[500px] max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-foreground text-accent flex items-center justify-center">
              <Building2 size={20} />
            </div>
            <div>
              <h2 className="text-xl font-black text-foreground">Neues Bankkonto</h2>
              <p className="text-sm text-muted mt-0.5">
                Fügen Sie ein neues Konto hinzu
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 hover:bg-canvas rounded-lg transition-colors duration-150 ease-out"
          >
            <X size={20} className="text-muted" />
          </button>
        </div>

        {/* Form */}
        <div className="p-6 space-y-4 overflow-y-auto">
          {error && (
            <div className="bg-error-bg border border-error/30 rounded-lg p-3 text-sm text-error">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-muted mb-2">
              Kontoname *
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => {
                setFormData({ ...formData, name: e.target.value });
                setError(null);
              }}
              placeholder="z.B. Geschäftskonto"
              className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-muted mb-2">
              IBAN (optional)
            </label>
            <input
              type="text"
              value={formData.iban}
              onChange={(e) => setFormData({ ...formData, iban: e.target.value })}
              placeholder="DE89 3704 0044 0532 0130 00"
              className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-mono focus:ring-2 focus:ring-accent outline-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-muted mb-2">
              Anfangssaldo
            </label>
            <input
              type="number"
              step="0.01"
              value={formData.balance}
              onChange={(e) => setFormData({ ...formData, balance: e.target.value })}
              className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-muted mb-2">
              Standard-SKR-Konto ({activeChart})
            </label>
            <select
              value={formData.defaultSkrAccountNumber}
              onChange={(e) =>
                setFormData({ ...formData, defaultSkrAccountNumber: e.target.value })
              }
              className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none"
              disabled={ledgerAccounts.length === 0}
            >
              {ledgerAccounts.length === 0 ? (
                <option value="">Bitte zuerst SKR importieren</option>
              ) : null}
              {ledgerAccounts.map((row) => (
                <option key={`${row.chart}:${row.accountNumber}`} value={row.accountNumber}>
                  {row.accountNumber} - {row.name}
                </option>
              ))}
            </select>
            {ledgerAccounts.length === 0 ? (
              <p className="mt-2 text-xs text-muted">
                Es sind noch keine SKR-Konten geladen. Bitte im Finanz-Hub zuerst den SKR-Import ausführen.
              </p>
            ) : null}
          </div>
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-border flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-5 py-2.5 rounded-xl font-bold text-muted hover:bg-canvas transition-colors duration-150 ease-out"
          >
            Abbrechen
          </button>
          <button
            onClick={handleSave}
            disabled={!formData.name.trim() || !formData.defaultSkrAccountNumber || isSaving}
            className="px-5 py-2.5 rounded-xl font-bold bg-accent text-accent-foreground hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-150 ease-out"
          >
            {isSaving ? 'Speichern...' : 'Speichern'}
          </button>
        </div>
      </div>
    </div>
  );
};
