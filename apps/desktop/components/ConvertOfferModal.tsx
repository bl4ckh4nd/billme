import React, { useState } from 'react';
import { ArrowRight, Loader2, X } from 'lucide-react';
import { Button, DatePicker } from '@billme/ui';
import type { QueryClient } from '@tanstack/react-query';
import type { Invoice, AppSettings } from '../types';
import type { BillmeApi } from '../ipc/api';

interface ConvertOfferModalProps {
  offer: Invoice;
  settings: AppSettings;
  ipc: BillmeApi;
  queryClient: QueryClient;
  onClose: () => void;
  onConverted: (newInvoiceId: string) => void;
}

const toIsoDate = (d: Date) => d.toISOString().split('T')[0] ?? '';

const formatCurrency = (amount: number) =>
  new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(amount);

export const ConvertOfferModal: React.FC<ConvertOfferModalProps> = ({
  offer,
  settings,
  ipc,
  queryClient,
  onClose,
  onConverted,
}) => {
  const today = toIsoDate(new Date());
  const defaultDueDate = (() => {
    const d = new Date();
    d.setDate(d.getDate() + (settings.legal?.paymentTermsDays ?? 14));
    return toIsoDate(d);
  })();

  const [invoiceDate, setInvoiceDate] = useState(today);
  const [dueDate, setDueDate] = useState(defaultDueDate);
  const [isConverting, setIsConverting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleConvert = async () => {
    setIsConverting(true);
    setError(null);
    try {
      const newInvoice = await ipc.documents.convertOfferToInvoice({
        offerId: offer.id,
        invoiceDate,
        dueDate,
      });
      await queryClient.invalidateQueries({ queryKey: ['invoices'] });
      onConverted(newInvoice.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setIsConverting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
      <div className="bg-surface rounded-3xl max-w-lg w-full shadow-2xl flex flex-col">
        {/* Header */}
        <div className="p-6 border-b border-border-subtle bg-surface-muted rounded-t-3xl flex items-start justify-between gap-4">
          <div>
            <h3 className="text-xl font-black">Angebot in Rechnung umwandeln</h3>
            <p className="text-sm text-muted mt-0.5">{offer.number} · {offer.client}</p>
          </div>
          <button
            onClick={onClose}
            disabled={isConverting}
            className="text-muted hover:text-foreground transition-colors ease-out mt-0.5 flex-shrink-0"
            aria-label="Schließen"
          >
            <X size={20} />
          </button>
        </div>

        {/* Body */}
        <div className="p-6 space-y-5">
          {/* Summary card */}
          <div className="bg-surface-muted rounded-xl p-4 grid grid-cols-2 gap-2 text-sm">
            <span className="text-muted">Betrag</span>
            <span className="font-bold tabular-nums text-right">{formatCurrency(offer.amount)}</span>
            <span className="text-muted">Positionen</span>
            <span className="font-bold text-right">{offer.items?.length ?? 0} Artikel</span>
          </div>

          {/* Invoice date */}
          <div className="space-y-1.5">
            <label className="block text-sm font-semibold text-foreground">Rechnungsdatum</label>
            <DatePicker value={invoiceDate} onChange={(v) => setInvoiceDate(v || today)} />
          </div>

          {/* Due date */}
          <div className="space-y-1.5">
            <label className="block text-sm font-semibold text-foreground">Fälligkeitsdatum</label>
            <DatePicker value={dueDate} onChange={(v) => setDueDate(v || defaultDueDate)} />
          </div>

          {error && (
            <p className="text-sm text-error bg-error-bg rounded-lg p-3">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 border-t border-border-subtle bg-surface-muted rounded-b-3xl flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={isConverting}
            className="px-4 py-2 text-sm font-semibold text-muted hover:text-foreground transition-colors ease-out disabled:opacity-50"
          >
            Abbrechen
          </button>
          <Button onClick={() => void handleConvert()} disabled={isConverting} size="md">
            {isConverting ? (
              <Loader2 size={16} className="animate-spin" />
            ) : (
              <ArrowRight size={16} />
            )}
            Rechnung erstellen
          </Button>
        </div>
      </div>
    </div>
  );
};
