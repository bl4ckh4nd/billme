import { useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button, IconButton, Input, Modal } from '@billme/ui';
import { ipc } from '../ipc/client';
import { useQueryClient } from '@tanstack/react-query';
import { v4 as uuidv4 } from 'uuid';

interface BankAccountModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const BankAccountModal = ({ isOpen, onClose }: BankAccountModalProps) => {
  const queryClient = useQueryClient();
  const titleId = useId();
  const descriptionId = useId();
  const [formData, setFormData] = useState({
    name: '',
    iban: '',
    balance: '0',
  });
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNameError, setShowNameError] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const handleSave = async () => {
    if (!formData.name.trim()) {
      // The submit stays enabled so this is reachable: a muted button that
      // explains nothing is the worse failure (see the projects/recurring forms,
      // which validate on submit).
      setError('Kontoname ist erforderlich.');
      setShowNameError(true);
      nameInputRef.current?.focus();
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
          type: 'bank',
          color: '#4B5563',
          transactions: [],
        }
      });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
      onClose();
      setFormData({ name: '', iban: '', balance: '0' });
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
      className="flex max-h-[84vh] flex-col"
    >
      <div className="flex items-start gap-3 px-4.5 pt-4 pb-2.5">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-title text-foreground">Neues Bankkonto</h2>
          <p id={descriptionId} className="text-caption text-muted">
            Fügen Sie ein neues Konto hinzu
          </p>
        </div>
        <IconButton aria-label="Dialog schließen" tooltip={false} size="sm" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </IconButton>
      </div>

      <div className="flex flex-col gap-3 overflow-y-auto px-4.5 pt-1 pb-4">
        {error && (
          <div role="alert" className="rounded-control border border-error-border bg-error-bg px-3 py-2.5 text-control text-error-text">
            {error}
          </div>
        )}

        <Input
          id="bank-account-name"
          ref={nameInputRef}
          label="Kontoname"
          required
          type="text"
          value={formData.name}
          error={showNameError && !formData.name.trim() ? 'Kontoname ist erforderlich.' : undefined}
          onChange={(e) => {
            setFormData({ ...formData, name: e.target.value });
            setError(null);
            setShowNameError(false);
          }}
          placeholder="z.B. Geschäftskonto"
          fullWidth
        />

        <Input
          id="bank-account-iban"
          label="IBAN (optional)"
          type="text"
          value={formData.iban}
          onChange={(e) => setFormData({ ...formData, iban: e.target.value })}
          placeholder="DE89 3704 0044 0532 0130 00"
          className="font-mono"
          fullWidth
        />

        <Input
          id="bank-account-balance"
          label="Anfangssaldo"
          type="number"
          step="0.01"
          value={formData.balance}
          onChange={(e) => setFormData({ ...formData, balance: e.target.value })}
          className="tabular-nums"
          fullWidth
        />
      </div>

      <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4.5 py-3">
        <Button variant="ghost" onClick={onClose}>
          Abbrechen
        </Button>
        <Button onClick={handleSave} disabled={isSaving}>
          {isSaving ? 'Speichern...' : 'Speichern'}
        </Button>
      </div>
    </Modal>
  );
};
