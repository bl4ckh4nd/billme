import React from 'react';
import { Invoice } from '../../types';

interface PaymentDeleteModalProps {
  isOpen: boolean;
  onClose: () => void;
  deletingPaymentId: string | null;
  setDeletingPaymentId: React.Dispatch<React.SetStateAction<string | null>>;
  paymentDeleteReason: string;
  setPaymentDeleteReason: React.Dispatch<React.SetStateAction<string>>;
  paymentDeleteError: string | null;
  setPaymentDeleteError: React.Dispatch<React.SetStateAction<string | null>>;
  selectedDocument: Invoice;
  onSave: (updatedInvoice: Invoice, reason: string) => void;
}

export const PaymentDeleteModal: React.FC<PaymentDeleteModalProps> = ({
  isOpen,
  onClose,
  deletingPaymentId,
  setDeletingPaymentId,
  paymentDeleteReason,
  setPaymentDeleteReason,
  paymentDeleteError,
  setPaymentDeleteError,
  selectedDocument,
  onSave,
}) => {
  if (!isOpen) return null;

  const handleClose = () => {
    onClose();
    setDeletingPaymentId(null);
    setPaymentDeleteReason('');
    setPaymentDeleteError(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-3xl bg-white shadow-xl p-6">
        <h3 className="text-lg font-black text-foreground mb-1">Zahlung löschen</h3>
        <p className="text-sm text-muted mb-4">
          Die Zahlung wird entfernt. Bitte Begründung angeben (GoBD).
        </p>

        <label className="text-xs font-bold text-foreground">Grund (Pflicht)</label>
        <textarea
          value={paymentDeleteReason}
          onChange={(e) => {
            setPaymentDeleteReason(e.target.value);
            if (paymentDeleteError) setPaymentDeleteError(null);
          }}
          rows={3}
          className="mt-2 w-full rounded-lg border border-border bg-surface-muted px-4 py-3 text-sm outline-none focus:border-foreground focus:ring-2 focus:ring-accent"
          placeholder="z.B. falsch erfasst, Doppelbuchung, ..."
        />
        {paymentDeleteError && <div className="mt-2 text-sm font-bold text-error">{paymentDeleteError}</div>}

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            className="px-5 py-2.5 rounded-xl font-bold bg-canvas text-foreground hover:bg-surface-muted transition-colors ease-out duration-150"
            onClick={handleClose}
          >
            Abbrechen
          </button>
          <button
            className="px-5 py-2.5 rounded-xl font-bold bg-foreground text-white hover:bg-dark-1 transition-colors ease-out duration-150"
            onClick={() => {
              if (!deletingPaymentId) return;

              const trimmed = paymentDeleteReason.trim();
              if (!trimmed) {
                setPaymentDeleteError('Grund ist Pflicht.');
                return;
              }

              const exists = (selectedDocument.payments ?? []).some((p) => p.id === deletingPaymentId);
              if (!exists) {
                setPaymentDeleteError('Zahlung nicht gefunden. Bitte neu öffnen.');
                return;
              }

              const next: Invoice = {
                ...selectedDocument,
                payments: (selectedDocument.payments ?? []).filter((p) => p.id !== deletingPaymentId),
              };

              onSave(next, trimmed);
            }}
          >
            Löschen
          </button>
        </div>
      </div>
    </div>
  );
};
