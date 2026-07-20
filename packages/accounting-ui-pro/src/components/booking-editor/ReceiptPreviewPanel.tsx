import { FileText } from 'lucide-react';
import { Transaction } from '../../types';

interface ReceiptPreviewPanelProps {
  transaction: Transaction;
}

export default function ReceiptPreviewPanel({ transaction }: ReceiptPreviewPanelProps) {
  return (
    <div className="border border-border rounded-xl overflow-hidden flex-1 min-h-[14rem]">
      <div className="p-4 border-b border-border-subtle bg-surface-muted/50 flex items-center justify-between">
        <h3 className="text-sm font-bold text-foreground">Beleg (Mockup)</h3>
        <span className="text-xs font-bold text-muted">
          {transaction.hasReceipt ? 'PDF • 1 Seite' : 'Kein Beleg'}
        </span>
      </div>
      <div className="p-4 h-full">
        <div className="h-full min-h-[12rem] rounded-xl border border-border bg-surface-muted flex items-center justify-center">
          {transaction.hasReceipt ? (
            <img
              src={`https://picsum.photos/seed/${transaction.id}/360/420?blur=2`}
              alt="Beleg Vorschau"
              className="w-full h-full object-cover opacity-60 rounded-xl"
              referrerPolicy="no-referrer"
            />
          ) : (
            <div className="text-center">
              <FileText className="mx-auto text-muted mb-2" />
              <p className="text-sm text-muted">Beleg fehlt</p>
              <button className="mt-2 text-sm font-bold text-foreground hover:underline">
                Beleg anfordern
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
