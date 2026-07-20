import React from 'react';
import { X } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { Invoice } from '../../types';

interface PaymentForm {
  date: string;
  amount: string;
  method: string;
}

interface PaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  editingPaymentId: string | null;
  setEditingPaymentId: React.Dispatch<React.SetStateAction<string | null>>;
  paymentForm: PaymentForm;
  setPaymentForm: React.Dispatch<React.SetStateAction<PaymentForm>>;
  paymentReason: string;
  setPaymentReason: React.Dispatch<React.SetStateAction<string>>;
  paymentError: string | null;
  setPaymentError: React.Dispatch<React.SetStateAction<string | null>>;
  selectedDocument: Invoice;
  onSave: (updatedInvoice: Invoice, reason: string) => void;
}

export const PaymentModal: React.FC<PaymentModalProps> = ({
  isOpen,
  onClose,
  editingPaymentId,
  setEditingPaymentId,
  paymentForm,
  setPaymentForm,
  paymentReason,
  setPaymentReason,
  paymentError,
  setPaymentError,
  selectedDocument,
  onSave,
}) => {
  if (!isOpen) return null;

  const handleClose = () => {
    onClose();
    setEditingPaymentId(null);
    setPaymentError(null);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-lg rounded-3xl bg-white shadow-xl overflow-hidden">
        <div className="flex items-center justify-between px-6 py-5 border-b border-border-subtle">
          <div>
            <h3 className="text-lg font-black text-foreground">
              {editingPaymentId ? 'Zahlung bearbeiten' : 'Zahlung erfassen'}
            </h3>
            <p className="text-sm text-muted mt-1">Wird im Audit-Log gespeichert (GoBD).</p>
          </div>
          <button
            onClick={handleClose}
            className="w-10 h-10 rounded-full bg-canvas hover:bg-surface-muted transition-colors ease-out duration-150 flex items-center justify-center"
            title="Schließen"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-bold text-muted mb-1">Datum</label>
              <input
                type="date"
                value={paymentForm.date}
                onChange={(e) => setPaymentForm((p) => ({ ...p, date: e.target.value }))}
                className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-muted mb-1">Betrag (EUR)</label>
              <input
                inputMode="decimal"
                value={paymentForm.amount}
                onChange={(e) => setPaymentForm((p) => ({ ...p, amount: e.target.value }))}
                placeholder="z.B. 250,00"
                className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium tabular-nums focus:ring-2 focus:ring-accent outline-none"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-muted mb-1">Methode</label>
            <select
              value={paymentForm.method}
              onChange={(e) => setPaymentForm((p) => ({ ...p, method: e.target.value }))}
              className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none"
            >
              <option value="Überweisung">Überweisung</option>
              <option value="PayPal">PayPal</option>
              <option value="Karte">Karte</option>
              <option value="Bar">Bar</option>
              <option value="Sonstiges">Sonstiges</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-bold text-muted mb-1">Grund (Pflicht)</label>
            <textarea
              value={paymentReason}
              onChange={(e) => {
                setPaymentReason(e.target.value);
                if (paymentError) setPaymentError(null);
              }}
              rows={3}
              placeholder="z.B. Zahlungseingang Kontoauszug, Teilzahlung, ..."
              className="w-full bg-surface-muted border border-border rounded-lg p-3 text-sm font-medium focus:ring-2 focus:ring-accent outline-none resize-none"
            />
          </div>

          {paymentError && <div className="text-sm font-bold text-error">{paymentError}</div>}
        </div>

        <div className="px-6 py-5 border-t border-border-subtle flex items-center justify-end gap-3">
          <button
            onClick={handleClose}
            className="px-5 py-2.5 rounded-xl font-bold bg-canvas text-foreground hover:bg-surface-muted transition-colors ease-out duration-150"
          >
            Abbrechen
          </button>
          <button
            onClick={() => {
              const trimmedReason = paymentReason.trim();
              if (!trimmedReason) {
                setPaymentError('Grund ist Pflicht.');
                return;
              }

              const date = paymentForm.date;
              if (!date) {
                setPaymentError('Datum ist Pflicht.');
                return;
              }

              const normalized = paymentForm.amount.replace(/\s/g, '').replace(',', '.');
              const amount = Number(normalized);
              if (!Number.isFinite(amount) || amount <= 0) {
                setPaymentError('Bitte einen gültigen Betrag > 0 eingeben.');
                return;
              }

              if (editingPaymentId && !(selectedDocument.payments ?? []).some((p) => p.id === editingPaymentId)) {
                setPaymentError('Zahlung nicht gefunden. Bitte neu öffnen.');
                return;
              }

              const next: Invoice = {
                ...selectedDocument,
                payments: editingPaymentId
                  ? (selectedDocument.payments ?? []).map((p) =>
                      p.id === editingPaymentId
                        ? { ...p, date, amount, method: paymentForm.method || 'Überweisung' }
                        : p,
                    )
                  : [
                      ...(selectedDocument.payments ?? []),
                      { id: uuidv4(), date, amount, method: paymentForm.method || 'Überweisung' },
                    ],
              };

              onSave(next, trimmedReason);
            }}
            className="px-5 py-2.5 rounded-xl font-bold bg-foreground text-white hover:bg-dark-1 transition-colors ease-out duration-150"
          >
            Speichern
          </button>
        </div>
      </div>
    </div>
  );
};
