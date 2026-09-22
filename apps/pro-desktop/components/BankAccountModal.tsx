import { useEffect, useId, useRef, useState } from 'react';
import { X, Building2 } from 'lucide-react';
import { Modal } from '@billme/ui';
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
  const titleId = useId();
  const descriptionId = useId();
  const { data: ledgerStats } = useProLedgerStatsQuery();
  const activeChart =
    (ledgerStats?.byChart.SKR03 ?? 0) >= (ledgerStats?.byChart.SKR04 ?? 0) ? 'SKR03' : 'SKR04';
  const { data: ledgerAccounts = [], isError: ledgerAccountsError } = useProLedgerAccountsQuery({
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
  const [showNameError, setShowNameError] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!formData.defaultSkrAccountNumber && ledgerAccounts.length > 0) {
      setFormData((prev) => ({
        ...prev,
        defaultSkrAccountNumber: prev.defaultSkrAccountNumber || ledgerAccounts[0]!.accountNumber,
      }));
    }
  }, [formData.defaultSkrAccountNumber, ledgerAccounts]);

  const handleSave = async () => {
    if (!formData.defaultSkrAccountNumber) {
      setError('Standard-SKR-Konto ist erforderlich.');
      return;
    }
    if (!formData.name.trim()) {
      // The submit stays enabled so this is reachable: a muted button that
      // explains nothing is the worse failure (see the projects/recurring forms,
      // which validate on submit).
      setError('Kontoname ist erforderlich.');
      setShowNameError(true);
      nameInputRef.current?.focus();
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
      setError('Konto konnte nicht erstellt werden. Prüfe die Eingaben und versuche es erneut.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      titleId={titleId}
      descriptionId={descriptionId}
      className="max-h-[90vh] flex flex-col"
    >
      {/* Header */}
      <div className="flex items-center justify-between p-6 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-md bg-dark-base text-accent flex items-center justify-center">
            <Building2 size={20} aria-hidden="true" />
          </div>
          <div>
            <h2 id={titleId} className="text-xl font-black text-foreground">Neues Bankkonto</h2>
            <p id={descriptionId} className="text-sm text-muted mt-0.5">
              Fügen Sie ein neues Konto hinzu
            </p>
          </div>
        </div>
        <button
          type="button"
          aria-label="Dialog schließen"
          onClick={onClose}
          className="p-2 rounded-lg text-muted hover:bg-surface-muted transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          <X size={20} aria-hidden="true" />
        </button>
      </div>

      {/* Form */}
      <div className="p-6 space-y-4 overflow-y-auto">
        {error && (
          <div role="alert" className="bg-error-bg border border-error-border rounded-xl p-3 text-sm text-error-text">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="bank-account-name" className="block text-sm font-medium text-foreground mb-2">
            Kontoname *
          </label>
          <input
            id="bank-account-name"
            ref={nameInputRef}
            type="text"
            value={formData.name}
            aria-invalid={showNameError && !formData.name.trim() ? true : undefined}
            aria-describedby={showNameError && !formData.name.trim() ? 'bank-account-name-error' : undefined}
            onChange={(e) => {
              setFormData({ ...formData, name: e.target.value });
              setError(null);
              setShowNameError(false);
            }}
            placeholder="z.B. Geschäftskonto"
            className={`w-full bg-surface-muted border rounded-xl p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${showNameError && !formData.name.trim() ? 'border-error' : 'border-control-border'}`}
          />
          {showNameError && !formData.name.trim() && (
            <p id="bank-account-name-error" className="mt-1 text-xs text-error-text">Kontoname ist erforderlich.</p>
          )}
        </div>

        <div>
          <label htmlFor="bank-account-iban" className="block text-sm font-medium text-foreground mb-2">
            IBAN (optional)
          </label>
          <input
            id="bank-account-iban"
            type="text"
            value={formData.iban}
            onChange={(e) => setFormData({ ...formData, iban: e.target.value })}
            placeholder="DE89 3704 0044 0532 0130 00"
            className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-mono focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          />
        </div>

        <div>
          <label htmlFor="bank-account-balance" className="block text-sm font-medium text-foreground mb-2">
            Anfangssaldo
          </label>
          <input
            id="bank-account-balance"
            type="number"
            step="0.01"
            value={formData.balance}
            onChange={(e) => setFormData({ ...formData, balance: e.target.value })}
            className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-medium tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          />
        </div>

        <div>
          <label htmlFor="bank-account-skr" className="block text-sm font-medium text-foreground mb-2">
            Standard-SKR-Konto ({activeChart})
          </label>
          <select
            id="bank-account-skr"
            value={formData.defaultSkrAccountNumber}
            onChange={(e) =>
              setFormData({ ...formData, defaultSkrAccountNumber: e.target.value })
            }
            className="w-full bg-surface-muted border border-control-border rounded-xl p-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            disabled={ledgerAccounts.length === 0}
          >
            {ledgerAccounts.length === 0 ? (
              <option value="">{ledgerAccountsError ? 'SKR-Konten konnten nicht geladen werden' : 'Bitte zuerst SKR importieren'}</option>
            ) : null}
            {ledgerAccounts.map((row) => (
              <option key={`${row.chart}:${row.accountNumber}`} value={row.accountNumber}>
                {row.accountNumber} - {row.name}
              </option>
            ))}
          </select>
          {ledgerAccounts.length === 0 ? (
            <p className="mt-2 text-xs text-muted">
              {ledgerAccountsError
                ? 'Die Kontenrahmen-Konten sind nicht ladbar. Prüfen Sie die Verbindung und versuchen Sie es erneut.'
                : 'Es sind noch keine SKR-Konten geladen. Bitte im Finanz-Hub zuerst den SKR-Import ausführen.'}
            </p>
          ) : null}
        </div>
      </div>

      {/* Footer */}
      <div className="p-6 border-t border-border flex justify-end gap-3">
        <button
          type="button"
          onClick={onClose}
          className="px-5 py-2.5 rounded-xl font-bold text-muted hover:bg-surface-muted transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          Abbrechen
        </button>
        <button
          type="button"
          onClick={handleSave}
          disabled={isSaving}
          className="px-5 py-2.5 rounded-xl font-bold bg-accent text-accent-foreground hover:bg-accent-hover disabled:bg-disabled-surface disabled:text-disabled-foreground disabled:cursor-not-allowed transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
        >
          {isSaving ? 'Speichern...' : 'Speichern'}
        </button>
      </div>
    </Modal>
  );
};
