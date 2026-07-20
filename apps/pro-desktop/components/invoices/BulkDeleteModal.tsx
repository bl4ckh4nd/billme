import React from 'react';
import { X, Trash2 } from 'lucide-react';

interface BulkDeleteModalProps {
  isOpen: boolean;
  onClose: () => void;
  count: number;
  bulkDeleteReason: string;
  setBulkDeleteReason: React.Dispatch<React.SetStateAction<string>>;
  isBulkDeleting: boolean;
  onConfirm: () => void;
}

export const BulkDeleteModal: React.FC<BulkDeleteModalProps> = ({
  isOpen,
  onClose,
  count,
  bulkDeleteReason,
  setBulkDeleteReason,
  isBulkDeleting,
  onConfirm,
}) => {
  if (!isOpen) return null;

  const handleClose = () => {
    onClose();
    setBulkDeleteReason('');
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="bg-surface rounded-3xl w-full max-w-xl shadow-2xl overflow-hidden flex flex-col animate-scale-in">
        <div className="p-6 border-b border-border-subtle flex justify-between items-center bg-surface-muted">
          <div>
            <h3 className="text-lg font-black">Löschen bestätigen</h3>
            <p className="text-sm text-muted">{count} Einträge ausgewählt</p>
          </div>
          <button
            onClick={handleClose}
            className="p-2 hover:bg-canvas rounded-full transition-colors ease-out duration-150"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="bg-error-bg border border-error/30 rounded-xl p-4 text-sm text-error">
            Diese Aktion kann nicht rückgängig gemacht werden. Es wird ein Audit-Eintrag geschrieben.
          </div>
          <div>
            <label className="block text-xs font-bold text-muted mb-1">Grund (Pflicht)</label>
            <textarea
              value={bulkDeleteReason}
              onChange={(e) => setBulkDeleteReason(e.target.value)}
              rows={4}
              placeholder="z.B. Duplikat, Testdaten, Kunde hat storniert ..."
              className="w-full bg-surface-muted border border-border rounded-xl p-4 text-sm outline-none focus:ring-2 focus:ring-accent resize-none"
            />
          </div>
        </div>

        <div className="p-6 border-t border-border-subtle bg-surface-muted flex justify-end gap-3">
          <button
            onClick={handleClose}
            className="px-4 py-2 bg-surface border border-border text-foreground rounded-full text-xs font-bold hover:bg-surface-muted transition-colors ease-out duration-150"
            disabled={isBulkDeleting}
          >
            Abbrechen
          </button>
          <button
            onClick={onConfirm}
            disabled={isBulkDeleting || bulkDeleteReason.trim().length === 0}
            className="px-4 py-2 bg-foreground text-white rounded-full text-xs font-bold hover:bg-dark-1 disabled:opacity-50 disabled:cursor-not-allowed transition-colors ease-out duration-150 flex items-center gap-2"
          >
            <Trash2 size={16} /> Löschen
          </button>
        </div>
      </div>
    </div>
  );
};
