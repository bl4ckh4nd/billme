import React from 'react';
import { Plus, Euro, Edit3, Trash2 } from 'lucide-react';
import { Invoice, InvoiceTaxSnapshot, Payment } from '../../types';
import { formatCurrency, formatDate } from './helpers';

interface PaymentsSidebarCardProps {
  selectedDocument: Invoice;
  selectedDocumentTax: InvoiceTaxSnapshot | null;
  sumPayments: (doc: Invoice) => number;
  onAddPayment: () => void;
  onEditPayment: (payment: Payment) => void;
  onDeletePayment: (id: string) => void;
}

export const PaymentsSidebarCard: React.FC<PaymentsSidebarCardProps> = ({
  selectedDocument,
  selectedDocumentTax,
  sumPayments,
  onAddPayment,
  onEditPayment,
  onDeletePayment,
}) => {
  const paid = sumPayments(selectedDocument);
  const grossAmount = Number(selectedDocumentTax?.grossAmount ?? selectedDocument.amount) || 0;
  const remaining = Math.max(0, grossAmount - paid);
  const pct = grossAmount > 0 ? Math.min(1, paid / grossAmount) : 0;

  return (
    <div className="bg-surface border border-border-subtle rounded-xl p-6 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h4 className="font-bold text-sm text-foreground flex items-center gap-2">
          <Euro size={16} className="text-muted" /> Zahlungen
        </h4>
        <button
          onClick={onAddPayment}
          className="px-3 py-2 rounded-lg bg-canvas hover:bg-surface-muted text-foreground font-bold text-sm inline-flex items-center gap-2 transition-colors ease-out duration-150"
        >
          <Plus size={16} /> Zahlung
        </button>
      </div>

      <div className="mb-4">
        <div className="flex items-center justify-between text-xs text-muted mb-2">
          <span>Bezahlt</span>
          <span className="font-bold text-foreground tabular-nums">{formatCurrency(paid)}</span>
        </div>
        <div className="w-full h-2 rounded-full bg-canvas overflow-hidden">
          <div
            className="h-full bg-foreground"
            style={{ width: `${Math.round(pct * 100)}%` }}
          />
        </div>
        <div className="flex items-center justify-between text-xs text-muted mt-2">
          <span>Noch offen</span>
          <span className="font-bold text-foreground tabular-nums">{formatCurrency(remaining)}</span>
        </div>
      </div>

      {(selectedDocument.payments ?? []).length === 0 ? (
        <p className="text-xs text-muted">Noch keine Zahlungen erfasst.</p>
      ) : (
        <div className="space-y-2">
          {(selectedDocument.payments ?? [])
            .slice()
            .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
            .map((p) => (
              <div
                key={p.id}
                className="flex items-center justify-between p-3 bg-surface-muted rounded-lg border border-border-subtle"
              >
                <div>
                  <p className="text-xs font-bold text-foreground">{formatDate(p.date)}</p>
                  <p className="text-[10px] text-muted font-bold uppercase tracking-wide">
                    {p.method}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <div className="font-bold text-foreground tabular-nums min-w-[120px] text-right">
                    {formatCurrency(p.amount)}
                  </div>
                  <button
                    onClick={() => onEditPayment(p)}
                    className="w-9 h-9 rounded-lg bg-surface border border-border hover:bg-surface-muted transition-colors ease-out duration-150 flex items-center justify-center"
                    title="Bearbeiten"
                  >
                    <Edit3 size={16} className="text-foreground" />
                  </button>
                  <button
                    onClick={() => onDeletePayment(p.id)}
                    className="w-9 h-9 rounded-lg bg-surface border border-border hover:bg-surface-muted transition-colors ease-out duration-150 flex items-center justify-center"
                    title="Löschen"
                  >
                    <Trash2 size={16} className="text-foreground" />
                  </button>
                </div>
              </div>
            ))}
        </div>
      )}
    </div>
  );
};
